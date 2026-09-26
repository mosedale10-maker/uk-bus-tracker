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
import sys
from pathlib import Path

SNAP_DIR = Path("/opt/uk-bus-tracker/data/camera-snapshots")
# COCO class 5 is "bus"; coaches are annotated as buses.
BUS_CLASS = 5
MIN_CONF = 0.30


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--conf", type=float, default=MIN_CONF)
    ap.add_argument(
        "--only",
        default="",
        help="check just this registration, and print 'coach detected' when it is found",
    )
    args = ap.parse_args()

    from ultralytics import YOLO

    model = YOLO("/root/yolov8n.pt")
    sidecars = sorted(SNAP_DIR.glob("*.json"))
    if args.only:
        want = args.only.strip().upper()
        sidecars = [p for p in sidecars if p.stem.upper() == want]
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

        meta["detections"] = detections
        meta["busDetected"] = bool(best)
        if best:
            meta["busConfidence"] = best["conf"]
            meta["busBox"] = best["box"]
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
        elif args.only:
            print(f"  no coach in view: {reg} ({detections} objects in frame)")

    if args.only:
        print("coach detected" if coaches else "no coach detected")
        return 0
    print(f"\nchecked {checked} frames, coach detected in {coaches}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
