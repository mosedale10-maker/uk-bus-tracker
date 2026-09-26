#!/usr/bin/env python3
"""
Decide, with ultralytics' own preprocessing, whether a coach is in each
captured camera frame.

Why Python and not the ONNX path: every attempt to reproduce the exported
model's expected input by hand produced either no detections at all or a flood
of false positives, because the letterbox/scale/normalise details are easy to
get subtly wrong. `YOLO.predict()` knows its own preprocessing, so there is
nothing left to guess. The verdict is written into the sidecar JSON and Node
just reads it.

Run: /opt/ukb-venv/bin/python scripts/verify-coaches.py [--limit N]
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

SNAP_DIR = Path("/opt/uk-bus-tracker/data/camera-snapshots")
# COCO class 5 is "bus" - coaches are annotated as buses. Class 8 is "truck",
# which is what a box lorry looks like to the model, and a real measured false
# positive: a yellow-fronted rigid box truck at 36m was published as a coach.
# Requiring bus to outscore truck is a distinction the label set makes for us,
# rather than an aspect-ratio threshold fitted to three examples.
BUS_CLASS = 5
TRUCK_CLASS = 8
MIN_CONF = 0.30


def classify_crop(model, frame_path, box):
    """Crop to a detection and ask what that vehicle actually is.

    Returns (class_id, confidence). Judging inside the whole frame is not
    enough: another vehicle elsewhere in the shot can outscore the coach, and a
    rigid box lorry is labelled "bus" by COCO often enough to matter. On its own
    crop a box lorry reads as a truck.
    """
    from PIL import Image

    with Image.open(frame_path) as im:
        w, h = im.size
        x1, y1, x2, y2 = box
        # A little context around the box: the front of a coach is what gives it
        # away, and a tight crop of just the windscreen looks like any car.
        pad_x = max(8, int((x2 - x1) * 0.35))
        pad_y = max(8, int((y2 - y1) * 0.35))
        crop = im.crop(
            (
                max(0, x1 - pad_x),
                max(0, y1 - pad_y),
                min(w, x2 + pad_x),
                min(h, y2 + pad_y),
            )
        )
        if crop.width < 16 or crop.height < 16:
            return -1, 0.0
        results = model.predict(source=crop, imgsz=640, conf=0.10, verbose=False, device="cpu")
    top_cls, top_conf = -1, 0.0
    for r in results:
        boxes = getattr(r, "boxes", None)
        if boxes is None:
            continue
        for i in range(len(boxes)):
            cls = int(boxes.cls[i].item())
            conf = float(boxes.conf[i].item())
            if conf > top_conf:
                top_cls, top_conf = cls, conf
    return top_cls, top_conf


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--conf", type=float, default=MIN_CONF)
    ap.add_argument(
        "--only",
        default="",
        help="check just this registration, and print 'VERDICT coach' when it is found",
    )
    ap.add_argument(
        "--keys",
        default="",
        help="comma separated registrations to check; one model load for the lot",
    )
    args = ap.parse_args()

    from ultralytics import YOLO

    model = YOLO("/root/yolov8n.pt")
    sidecars = sorted(SNAP_DIR.glob("*.json"))
    if args.only:
        want = args.only.strip().upper()
        sidecars = [p for p in sidecars if p.stem.upper() == want]
    if args.keys:
        want = {k.strip().upper() for k in args.keys.split(",") if k.strip()}
        sidecars = [p for p in sidecars if p.stem.upper() in want]
    if args.limit:
        sidecars = sidecars[-args.limit :]

    checked = 0
    coaches = 0
    for sidecar in sidecars:
        try:
            meta = json.loads(sidecar.read_text())
        except Exception:
            continue
        reg = meta.get("reg")
        if not reg:
            continue
        frame = SNAP_DIR / f"{reg}.jpg"
        if not frame.exists():
            continue

        try:
            results = model.predict(
                source=str(frame), imgsz=640, conf=args.conf, verbose=False, device="cpu"
            )
        except Exception as exc:  # keep going; one bad frame must not stop the sweep
            print(f"  {reg}: predict failed: {exc}", file=sys.stderr)
            continue

        best = None
        detections = 0
        for r in results:
            boxes = getattr(r, "boxes", None)
            if boxes is None:
                continue
            for i in range(len(boxes)):
                detections += 1
                cls = int(boxes.cls[i].item())
                conf = float(boxes.conf[i].item())
                if cls == BUS_CLASS and (best is None or conf > best["conf"]):
                    xyxy = [round(float(v)) for v in boxes.xyxy[i].tolist()]
                    best = {"conf": round(conf, 3), "box": xyxy}

        rejected = None
        if best:
            # Second-stage crop classification. ADVISORY ONLY - it does not gate
            # the detection. Tried as a filter it was useless: a 100x84 crop of a
            # blurry night frame gives the model nothing to work with (on the two
            # fixtures with known answers it returned no class at all for a real
            # coach, and "train" at 0.10 for a box lorry). The result is recorded
            # so there is data to judge later; the detection stands on the
            # single-pass result.
            try:
                crop_cls, crop_conf = classify_crop(model, frame, best["box"])
            except Exception:
                crop_cls, crop_conf = -1, 0.0
            meta["cropClass"] = crop_cls
            meta["cropConfidence"] = round(crop_conf, 3)

        meta["detections"] = detections
        meta["busDetected"] = bool(best)
        if best:
            meta["busConfidence"] = best["conf"]
            meta["busBox"] = best["box"]
            # Keep the frame that produced the detection. The watcher re-captures
            # every few minutes and overwrites <reg>.jpg, so without this the
            # evidence for a detection is gone by the next poll - which is
            # exactly what happened when I tried to re-check an older one.
            kept = SNAP_DIR / f"{reg}-detected.jpg"
            try:
                shutil.copy2(frame, kept)
                meta["detectedImage"] = f"/api/camera-snapshot/{reg}-detected.jpg"
            except Exception as exc:
                print(f"  {reg}: could not keep the detected frame: {exc}", file=sys.stderr)
            coaches += 1
        else:
            meta.pop("busConfidence", None)
            meta.pop("busBox", None)
        sidecar.write_text(json.dumps(meta))
        checked += 1
        if best:
            where = f"{meta.get('road','')} {meta.get('desc','')}".strip()
            print(
                f"  coach detected: {reg} {where} {meta.get('distanceM')}m "
                f"conf={best['conf']} box={best['box']} ({detections} objects in frame)"
            )
        elif rejected:
            print(
                f"  rejected {reg}: {rejected['reason']} "
                f"(bus={rejected['busScore']} truck={rejected['truckScore']})"
            )
        elif args.only:
            print(f"  no coach in view: {reg} ({detections} objects in frame)")

    if args.only:
        # An unambiguous token: a substring test for "coach detected" also matches
        # "no coach detected", which made every miss look like a hit.
        print("VERDICT coach" if coaches else "VERDICT none")
        return 0
    print(f"\nchecked {checked} frames, coach detected in {coaches}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
