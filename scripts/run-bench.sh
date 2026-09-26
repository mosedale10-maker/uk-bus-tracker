#!/bin/bash
# One config per process so a memory-heavy model cannot kill the whole run.
cd /opt/uk-bus-tracker || exit 1
rm -f /tmp/bench-*.json /tmp/bench.log
for key in n640 n960 s640 s960 m960; do
  echo "=== $key ==="
  BENCH_LIMIT=200 BENCH_BATCH=4 /opt/ukb-venv/bin/python scripts/bench-detector.py "$key" 2>&1 | tail -2
done
echo
echo "=== summary ==="
python3 - <<'PY'
import glob, json
rows = []
for p in glob.glob("/tmp/bench-*.json"):
    rows.append(json.load(open(p)))
order = ["yolov8n@640", "yolov8n@960", "yolov8s@640", "yolov8s@960", "yolov8m@960"]
rows.sort(key=lambda r: order.index(r["config"]))
base = next((r for r in rows if r["config"] == "yolov8n@640"), None)
print(f"{'config':<14} {'frames w/ bus':>13} {'vs base':>9} {'detections':>11} {'mean conf':>10} {'time':>8}")
print("-" * 70)
for r in rows:
    delta = ""
    if base and r["config"] != base["config"]:
        d = r["frames_with_bus"] - base["frames_with_bus"]
        pct = (d / base["frames_with_bus"] * 100) if base["frames_with_bus"] else 0
        delta = f"{d:+d} ({pct:+.0f}%)"
    print(f"{r['config']:<14} {r['frames_with_bus']:>13} {delta:>9} {r['bus_detections']:>11} "
          f"{r['mean_conf']:>10.3f} {r['seconds']:>7}s")
PY
