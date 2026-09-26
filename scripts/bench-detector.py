"""
Benchmark the coach detector over the frames we already have.

The claim to test: coaches are being missed because we are running the smallest
YOLO at the smallest useful input size. yolov8n is 3M parameters and predict()
resizes a 720x576 frame down to 640x640, so a coach 60px tall in the stored
frame arrives at the model as roughly 53px. Two independent levers should help:

  - a bigger model (yolov8s 11M, yolov8m 25M)
  - a bigger input (imgsz 960 / 1280), which mostly buys small-object recall

What is measured, per configuration:
  - frames with at least one bus detection  (the thing that actually matters)
  - total bus detections
  - mean confidence of those detections
  - mean objects per frame (unchanged sanity check on frame quality)

A rise in bus detections is not on its own proof: a bigger model also detects
more junk, and we already know one false positive (a box lorry read as a coach
at confidence 0.399). So the winner is eyeballed afterwards before it ships.
"""
import glob
import json
import os
import statistics
import sys
import time

from ultralytics import YOLO

SNAP = "/opt/uk-bus-tracker/data/camera-snapshots"
BUS = 5
# One configuration per process. The box has 3.8GB of RAM and no swap, and
# yolov8m at 960 in batches of 16 was killed outright the first time this ran.
# A fresh process per config means each model is loaded, used and freed with
# nothing else resident, and a single bad config cannot take the run down.
CONFIGS = {
    "n640": ("yolov8n", 640),
    "n960": ("yolov8n", 960),
    "s640": ("yolov8s", 640),
    "s960": ("yolov8s", 960),
    "m960": ("yolov8m", 960),
}
BATCH = int(os.environ.get("BENCH_BATCH", "4"))
LIMIT = int(os.environ.get("BENCH_LIMIT", "200"))


def sample_frames():
    """A spread of the store, not just the easy daylight ones.

    Sorted by brightness and stepped through, so the dark night frames - the
    ones that actually cause the misses - are properly represented.
    """
    from PIL import Image, ImageStat

    rows = []
    for p in glob.glob(f"{SNAP}/*.jpg"):
        if p.endswith("-detected.jpg") or p.endswith("-n.jpg"):
            continue
        try:
            with Image.open(p) as im:
                mean = ImageStat.Stat(im.convert("L")).mean[0]
        except Exception:
            continue
        rows.append((mean, p))
    rows.sort()
    if len(rows) <= LIMIT:
        return [p for _, p in rows]
    step = len(rows) / LIMIT
    return [rows[int(i * step)][1] for i in range(LIMIT)]


def bench(model, imgsz, frames, conf=0.30):
    hits = 0
    total_bus = 0
    confs = []
    objects = 0
    hit_names = []
    t0 = time.time()
    for i in range(0, len(frames), BATCH):
        batch = frames[i : i + BATCH]
        results = model.predict(
            source=batch, imgsz=imgsz, conf=conf, verbose=False, device="cpu"
        )
        for name, r in zip(batch, results):
            boxes = getattr(r, "boxes", None)
            if boxes is None:
                continue
            classes = boxes.cls.tolist()
            objects += len(classes)
            bus_here = 0
            for cls, c in zip(classes, boxes.conf.tolist()):
                if int(cls) == BUS:
                    bus_here += 1
                    total_bus += 1
                    confs.append(c)
            if bus_here:
                hits += 1
                hit_names.append(os.path.basename(name))
    return {
        "frames_with_bus": hits,
        "bus_detections": total_bus,
        "mean_conf": statistics.fmean(confs) if confs else 0.0,
        "objects_per_frame": objects / len(frames) if frames else 0.0,
        "seconds": round(time.time() - t0, 1),
        "hit_names": hit_names,
    }


def main():
    key = sys.argv[1] if len(sys.argv) > 1 else "n640"
    if key not in CONFIGS:
        print(f"unknown config {key}; have {', '.join(CONFIGS)}")
        return 2
    name, imgsz = CONFIGS[key]
    path = f"/root/{name}.pt"
    if not os.path.exists(path):
        print(f"no weights at {path}")
        return 2
    frames = sample_frames()
    r = bench(YOLO(path), imgsz, frames)
    r["config"] = f"{name}@{imgsz}"
    r["frames_tested"] = len(frames)
    with open(f"/tmp/bench-{key}.json", "w") as fh:
        json.dump(r, fh, indent=2)
    print(
        f"{r['config']:<14} {r['frames_with_bus']:>4}/{len(frames)} frames with a bus   "
        f"{r['bus_detections']:>3} detections   mean conf {r['mean_conf']:.3f}   "
        f"objs/frame {r['objects_per_frame']:.2f}   {r['seconds']}s"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())


if __name__ == "__main__":
    sys.exit(main())
