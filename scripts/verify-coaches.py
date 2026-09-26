#!/usr/bin/env python3
"""
Decide, with ultralytics' own preprocessing, whether a coach is in the frames
we captured.

Why Python and not the ONNX path: every attempt to reproduce the exported
model's expected input by hand in JavaScript produced either no detections at
all or a flood of false positives, because the letterbox and normalisation
details are easy to get subtly wrong. `YOLO.predict()` knows its own
preprocessing, so there is nothing left to guess. Verdicts are written back into
the sidecar JSON and Node just reads them.

A coach is photographed at every camera it passes, so each sidecar carries a
`shots` list. All of them are checked here: a single frame is a lottery, because
most frames do not contain the coach at all, and the point of following a coach
along its route is that the chance of at least one usable shot climbs with every
camera passed.

Run: /opt/ukb-venv/bin/python scripts/verify-coaches.py [--limit N] [--keys a,b]
"""
import argparse
import importlib.util
import json
import shutil
import sys
from pathlib import Path

SNAP_DIR = Path("/opt/uk-bus-tracker/data/camera-snapshots")
# COCO class 5 is "bus"; coaches are annotated as buses.
BUS_CLASS = 5
MIN_CONF = 0.30


def classify_crop(model, frame_path, box):
    """Crop to a detection and ask what that vehicle is.

    ADVISORY ONLY - never gates a detection. Tried as a filter it was useless: a
    100x84 crop of a blurry night frame gives the model nothing to work with. On
    the two fixtures with known answers it returned no class at all for a real
    coach and "train" at 0.10 for a box lorry. Recorded so a future decision can
    rest on data rather than guesswork.
    """
    from PIL import Image

    try:
        with Image.open(frame_path) as im:
            w, h = im.size
            x1, y1, x2, y2 = box
            # A little context: the front of a coach is what gives it away, and
            # a tight crop of just the windscreen looks like any car.
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
            results = model.predict(
                source=crop, imgsz=640, conf=0.10, verbose=False, device="cpu"
            )
    except Exception:
        return -1, 0.0

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


def verify_shot(model, frame, conf=MIN_CONF):
    """Run the detector over one frame -> (object_count, best_bus or None)."""
    results = model.predict(
        source=str(frame), imgsz=640, conf=conf, verbose=False, device="cpu"
    )
    count = 0
    best = None
    for r in results:
        boxes = getattr(r, "boxes", None)
        if boxes is None:
            continue
        for i in range(len(boxes)):
            count += 1
            cls = int(boxes.cls[i].item())
            score = float(boxes.conf[i].item())
            if cls == BUS_CLASS and (best is None or score > best["conf"]):
                best = {
                    "conf": round(score, 3),
                    "box": [round(float(v)) for v in boxes.xyxy[i].tolist()],
                }
    return count, best


def shot_path(shot):
    name = str(shot.get("file") or "").rsplit("/", 1)[-1]
    return (SNAP_DIR / name) if name else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--conf", type=float, default=MIN_CONF)
    ap.add_argument("--only", default="", help="check one registration")
    ap.add_argument(
        "--keys",
        default="",
        help="comma separated registrations; one model load for the lot",
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
    shots_checked = 0
    coaches = 0
    hits = 0

    for sidecar in sidecars:
        try:
            meta = json.loads(sidecar.read_text())
        except Exception:
            continue
        reg = meta.get("reg")
        if not reg:
            continue

        shots = meta.get("shots")
        if not isinstance(shots, list) or not shots:
            # A sidecar from before multi-camera runs: one plain frame.
            shots = [
                {
                    "file": f"/api/camera-snapshot/{reg}.jpg",
                    "cameraId": meta.get("cameraId"),
                    "road": meta.get("road"),
                    "desc": meta.get("desc"),
                    "distanceM": meta.get("distanceM"),
                    "takenAt": meta.get("takenAt"),
                }
            ]

        total_objects = 0
        best_shot = None
        for shot in shots:
            path = shot_path(shot)
            if not path or not path.exists():
                shot["busDetected"] = False
                continue
            try:
                count, best = verify_shot(model, path, args.conf)
            except Exception as exc:  # one bad frame must not stop the sweep
                print(f"  {reg}: predict failed: {exc}", file=sys.stderr)
                continue
            shots_checked += 1
            total_objects += count
            shot["detections"] = count
            if best:
                shot["busDetected"] = True
                shot["busConfidence"] = best["conf"]
                shot["busBox"] = best["box"]
                hits += 1
                if best_shot is None or best["conf"] > best_shot[1]["conf"]:
                    best_shot = (shot, best)
            else:
                shot["busDetected"] = False
                shot.pop("busConfidence", None)
                shot.pop("busBox", None)

        meta["shots"] = shots
        meta["shotCount"] = len(shots)
        meta["detections"] = total_objects
        found = best_shot is not None
        meta["busDetected"] = found

        headline = best_shot[0] if found else shots[-1]
        for key in ("cameraId", "road", "desc", "distanceM", "takenAt"):
            if headline.get(key) is not None:
                meta[key] = headline[key]

        if found:
            shot, best = best_shot
            meta["busConfidence"] = best["conf"]
            meta["busBox"] = best["box"]
            meta["detectedImage"] = shot["file"]
            # Keep the frame that produced the detection: the live frame is
            # overwritten as the coach moves on to the next camera.
            try:
                shutil.copy2(shot_path(shot), SNAP_DIR / f"{reg}-detected.jpg")
            except Exception as exc:
                print(f"  {reg}: could not keep the frame: {exc}", file=sys.stderr)
            try:
                crop_cls, crop_conf = classify_crop(model, shot_path(shot), best["box"])
                meta["cropClass"] = crop_cls
                meta["cropConfidence"] = round(crop_conf, 3)
            except Exception:
                pass
            coaches += 1
        else:
            meta.pop("busConfidence", None)
            meta.pop("busBox", None)
            meta.pop("detectedImage", None)

        sidecar.write_text(json.dumps(meta))
        checked += 1
        if args.only:
            if found:
                where = f"{meta.get('road','')} {meta.get('desc','')}".strip()
                print(
                    f"  coach detected: {reg} {where} {meta.get('distanceM')}m "
                    f"conf={meta['busConfidence']} of {len(shots)} shot(s)"
                )
            else:
                print(f"  no coach in view: {reg} ({total_objects} objects, {len(shots)} shot(s))")
            print("VERDICT coach" if found else "VERDICT none")

    print(
        f"\nchecked {checked} coaches, {shots_checked} frames; "
        f"coach found in {coaches} of them ({hits} shots)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
