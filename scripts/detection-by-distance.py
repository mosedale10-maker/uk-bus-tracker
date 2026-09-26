#!/usr/bin/env python3
"""
Does the detection rate actually improve as the coach gets closer?

The trigger radius was cut from 250m to 120m on the reasoning that a coach has to
be big enough in a 720x576 frame to be recognised. That is a claim about the
data, so check it against the data rather than taking the reasoning on trust:
bucket every capture we hold by distance and report how often a coach was found.

Run: /opt/ukb-venv/bin/python scripts/detection-by-distance.py
"""
import glob
import json
from pathlib import Path

SNAPS = Path("/opt/uk-bus-tracker/data/camera-snapshots")
BANDS = [(0, 50), (50, 100), (100, 150), (150, 200), (200, 250), (250, 400), (400, 99999)]


def main() -> int:
    rows = []
    for f in glob.glob(str(SNAPS / "*.json")):
        try:
            m = json.load(open(f))
        except Exception:
            continue
        d = m.get("distanceM")
        if not isinstance(d, (int, float)):
            continue
        # Only frames we actually looked at: older captures predate the
        # placeholder check and some were a "camera unavailable" card.
        if not isinstance(m.get("detections"), int):
            continue
        rows.append((d, bool(m.get("busDetected"))))

    print(f"captures with a real frame: {len(rows)}")
    print(f"{'band':>12} {'captures':>9} {'coach found':>12} {'rate':>7}")
    for lo, hi in BANDS:
        n = sum(1 for d, _ in rows if lo <= d < hi)
        if not n:
            continue
        hit = sum(1 for d, det in rows if lo <= d < hi and det)
        label = f"{lo}-{hi if hi < 9999 else '+'}m"
        bar = "#" * round(hit / n * 20)
        print(f"{label:>12} {n:>9} {hit:>12} {hit / n * 100:>6.0f}% {bar}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
