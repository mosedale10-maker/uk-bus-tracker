#!/usr/bin/env python3
"""
How good is the M6 coverage, honestly?

The camera list already contains every National Highways camera on the M6, and
the watcher already photographs coaches anywhere in the country - so nothing
needs adding for the M6 to work. What is worth knowing is whether those cameras
are actually live, because a camera serving a "CAMERA UNAVAILABLE" card is
worse than no camera: it looks like coverage and photographs nothing.

Reports, for the M6:
  - how many cameras we hold, and how they are spread along the road
  - how many of a sample are genuinely live right now
  - how many M6 captures and confirmed coach detections we have actually made

Run: /opt/ukb-venv/bin/python scripts/m6-coverage.py [--sample 40]
"""
import argparse
import glob
import json
import random
import urllib.request
from collections import Counter
from io import BytesIO
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    Image = None

CAMERAS = Path("/opt/uk-bus-tracker/camera-locations.generated.json")
SNAPS = Path("/opt/uk-bus-tracker/data/camera-snapshots")
IMAGE = "https://public.highwaystrafficcameras.co.uk/cctvpublicaccess/images/{}.jpg"


def is_live(cam_id: str) -> bool:
    """A real frame is 720x576; the placeholder card is much smaller."""
    url = IMAGE.format(cam_id)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "uk-bus-tracker-coverage/1"})
        with urllib.request.urlopen(req, timeout=20) as res:
            data = res.read(2_500_000)
    except Exception as exc:
        return f"error {type(exc).__name__}"
    if Image is None:
        return None
    try:
        with Image.open(BytesIO(data)) as im:
            w, h = im.size
    except Exception:
        return False
    return w >= 640 and h >= 480


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=40)
    ap.add_argument("--road", default="M6")
    args = ap.parse_args()

    cams = json.loads(CAMERAS.read_text())["cameras"]
    road = [c for c in cams if c["road"].upper() == args.road.upper()]
    print(f"{args.road}: {len(road)} cameras in the list, {len(cams)} nationwide")

    # Spread along the road: bucket by latitude, north to south.
    buckets = Counter()
    for c in road:
        buckets[round(c["lat"], 1)] += 1
    print(f"\nspread north to south (latitude -> camera count):")
    for lat in sorted(buckets, reverse=True):
        bar = "#" * buckets[lat]
        print(f"  {lat:5.1f}  {buckets[lat]:3d} {bar}")

    print(f"\nchecking a sample of {args.sample} for live images...")
    sample = random.sample(road, min(args.sample, len(road)))
    live = dead = errored = 0
    dead_ids = []
    for cam in sample:
        result = is_live(cam["id"])
        if result is True:
            live += 1
        elif result is False:
            dead += 1
            dead_ids.append(f"{cam['id']} ({cam['desc']})")
        else:
            errored += 1
    total = live + dead + errored
    print(f"  live {live}/{total}   unavailable {dead}/{total}   errors {errored}/{total}")
    if dead_ids:
        print("  unavailable: " + ", ".join(dead_ids[:10]))

    captures, detections = [], []
    for f in glob.glob(str(SNAPS / "*.json")):
        try:
            m = json.load(open(f))
        except Exception:
            continue
        if str(m.get("road", "")).upper() != args.road.upper():
            continue
        captures.append(m)
        if m.get("busDetected"):
            detections.append(m)
    print(f"\ncaptures made on the {args.road}: {len(captures)}")
    print(f"  with a coach detected: {len(detections)}")
    if detections:
        print("  closest:")
        for m in sorted(detections, key=lambda m: m.get("distanceM", 9999))[:8]:
            print(
                f"    {str(m.get('distanceM')) + 'm':>6}  "
                f"{(m.get('label') or m.get('reg'))[:40]:40} conf={m.get('busConfidence')}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
