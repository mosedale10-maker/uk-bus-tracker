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
# Only genuinely dark frames are worth brightening. Measured across 2,411 stored
# frames the brightness distribution runs: 6% under 40, 12% under 60, 22% under
# 80. Daylight and dusk frames are already readable and rewriting them makes
# them worse, so the cut-off sits well down in the dark tail.
DARK_FRAME_MEAN = 60
# Black point to lift shadows to, and the midtone gamma. Gamma below 1 opens the
# shadows; 1 would be a no-op.
BLACK_LIFT = 30
NIGHT_GAMMA = 0.62
# A live motorway with a coach metres from the camera should show plenty of
# vehicles. Frames scoring below this are glare, rain, dirt or darkness, and are
# not worth presenting as evidence of anything.
READABLE_MIN_OBJECTS = 6


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


def enhance_night(src, dst):
    """Make a genuinely dark night frame readable. Returns dst, or None to skip.

    Two things this must not do, both of which a first attempt did:

    1. It must not touch frames that are already fine. Measured across 2,411
       stored frames, only about 6% have a mean brightness under 40 - the rest
       are daylight or dusk and need nothing. An early threshold of 110 was
       rewriting perfectly good frames, and the result was worse than the
       original: flatter, and with the road surface bleached out.

    2. It must not throw away the colour. Converting to greyscale first made the
       detector's job marginally easier (it scores a few more objects on a flat
       grey image) but made the photo much worse to look at, and looking at the
       photo is the entire point. The lift is the same curve on all three
       channels, so it raises exposure without shifting hue.

    What it does, in order: a 3x3 median to knock back the sensor noise that
    brightening would otherwise amplify, then a black-point lift so the sky and
    verges stop being solid black, then a midtone gamma, then a gentle unsharp
    for the soft lens. The original file is never modified or replaced.
    """
    from PIL import Image, ImageEnhance, ImageFilter, ImageStat

    with Image.open(src) as im:
        rgb = im.convert("RGB")
        if ImageStat.Stat(rgb.convert("L")).mean[0] > DARK_FRAME_MEAN:
            return None
        # Noise first. Lifting a very dark frame amplifies every hot pixel, and
        # the unsharp pass below would then ring on all of them.
        clean = rgb.filter(ImageFilter.MedianFilter(3))
        # Same neutral lift on each channel: shadows open up, hue is preserved.
        black_lift = [BLACK_LIFT + int(v * (255 - BLACK_LIFT) / 255) for v in range(256)]
        lifted = clean.point(black_lift * len(clean.getbands()))
        shaped = lifted.point([int(255 * ((v / 255) ** NIGHT_GAMMA)) for v in range(256)] * len(lifted.getbands()))
        sharp = shaped.filter(ImageFilter.UnsharpMask(radius=2, percent=120, threshold=3))
        ImageEnhance.Contrast(sharp).enhance(1.08).save(dst, quality=90)
    return dst


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
    enhanced_used = 0
    attempted = 0
    improved = 0
    worsened = 0
    compared = 0
    orig_total = 0
    chosen_total = 0

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
            orig_count = 0
            path = shot_path(shot)
            if not path or not path.exists():
                shot["busDetected"] = False
                continue
            try:
                orig_count, best = verify_shot(model, path, args.conf)
            except Exception as exc:  # one bad frame must not stop the sweep
                print(f"  {reg}: predict failed: {exc}", file=sys.stderr)
                continue
            count = orig_count
            # Two separate questions, deliberately answered separately:
            #
            #   For the DETECTOR, keep whichever of the two copies scores more
            #   objects. That is measurable, so measure it.
            #
            #   For the PERSON looking at it, show the brightened copy whenever
            #   the frame was dark enough to need it. Deciding that by the
            #   detector's score was a category error - the detector is quite
            #   happy on a 5/255 frame once the road markings are lifted, while
            #   a human sees nothing at all. On the darkest frame in the store
            #   (mean brightness 4.8) the brightened copy takes it to 70.7 and
            #   the lane markings, barrier and verge all become visible.
            enhanced = path.with_name(path.stem + "-n.jpg")
            enh_count, enh_best = 0, None
            tried = False
            try:
                if enhance_night(path, enhanced):
                    tried = True
                    shot["enhanced"] = True
                    shot["enhancedImage"] = f"/api/camera-snapshot/{enhanced.name}"
                    enhanced_used += 1
                    enh_count, enh_best = verify_shot(model, enhanced, args.conf)
            except Exception:
                enh_count, enh_best = 0, None
            if enh_count > count or (enh_best and not best):
                count, best = enh_count, enh_best or best
            shot["detectionsOriginal"] = orig_count
            shot["detectionsEnhanced"] = enh_count
            # The honest usefulness of the frame. Most of ours are not, and a
            # photo that cannot be read into is not evidence of a coach.
            shot["readable"] = count >= READABLE_MIN_OBJECTS
            compared += 1
            orig_total += orig_count
            # `count` is whichever read better, so this is the real effect of
            # running both - not a ratio of two differently sized totals.
            chosen_total += count
            # Only frames we actually attempted say anything about the
            # processing; the rest were skipped because they were not dark.
            if tried:
                attempted += 1
            if tried and enh_count > orig_count:
                improved += 1
            elif tried and enh_count < orig_count:
                worsened += 1
            shots_checked += 1
            total_objects += count
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
            # overwritten as the coach moves on to the next camera. If the
            # coach only became visible after brightening, keep the readable
            # copy - the raw one is still on disk under its own name.
            try:
                kept = shot_path(shot)
                if shot.get("enhanced") and shot.get("enhancedImage"):
                    cand = SNAP_DIR / Path(str(shot["enhancedImage"])).name
                    if cand.exists():
                        kept = cand
                shutil.copy2(kept, SNAP_DIR / f"{reg}-detected.jpg")
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
    if compared:
        avg_o = orig_total / compared
        avg_c = chosen_total / compared
        print(
            f"night enhancement: {attempted} frames were dark enough to try; "
            f"{improved} read better, {worsened} read worse. "
            f"objects per frame {avg_o:.2f} -> {avg_c:.2f} "
            f"({'+' if avg_c >= avg_o else ''}{avg_c - avg_o:.2f})"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
