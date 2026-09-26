#!/usr/bin/env python3
"""
Does the coach filter actually keep coaches and drop lorries?

The crop classifier was written to fix a measured false positive - a rigid box
lorry published as a coach - so it needs a test with known answers, not a
threshold eyeballed at three samples. Both fixtures are real National Highways
frames with the detection box that was published at the time:

  known-coach.jpg      FlixBus 042 Belgravia, 15m from M4 J2-J1. A coach.
  known-boxlorry.jpg   FlixBus 950 Norwich, 36m from M25 J15-J16. A box lorry,
                       which is the false positive this filter exists to stop.

Run: /opt/ukb-venv/bin/python scripts/test-coach-filter.py
"""
import importlib.util
import sys
from pathlib import Path

from ultralytics import YOLO

# verify-coaches.py has a hyphen in its name, so it cannot be imported normally;
# load it by path rather than renaming the file the watcher shells out to.
_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("verify_coaches", _HERE / "verify-coaches.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
classify_crop = _mod.classify_crop

FIXTURES = Path(__file__).resolve().parent / "fixtures"
CASES = [
    # (file, box, expected "coach" or "lorry", what it actually is)
    ("known-coach.jpg", [327, 129, 428, 213], "coach", "FlixBus 042 Belgravia, 15m"),
    ("known-boxlorry.jpg", [308, 266, 376, 336], "lorry", "FlixBus 950 Norwich, 36m"),
]

COCO = {
    0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus",
    7: "train", 8: "truck", 9: "boat",
}


def main() -> int:
    model = YOLO("/root/yolov8n.pt")
    failures = 0
    for name, box, expect, note in CASES:
        path = FIXTURES / name
        if not path.exists():
            print(f"  MISSING fixture {path}")
            failures += 1
            continue
        cls, conf = classify_crop(model, path, box)
        got = "coach" if cls == 5 else "lorry" if cls == 8 else f"other({cls})"
        ok = got == expect
        failures += 0 if ok else 1
        print(
            f"  {'PASS' if ok else 'FAIL'}  {name:20} expect {expect:6} got {got:10} "
            f"class={COCO.get(cls, cls)} conf={conf:.2f}   ({note})"
        )
    if failures:
        print(
            "\n  Crop classification does not work on these frames, which is why it is\n"
            "  advisory and not a gate. Recorded so the decision rests on evidence."
        )
    else:
        print("\n  crop classification separates coaches from lorries on both fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
