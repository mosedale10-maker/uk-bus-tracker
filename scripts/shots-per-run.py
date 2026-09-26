import glob
import json
from collections import Counter

# The M6 cameras are all present and all in use, so the limit on catches is
# something else. This measures how many photos each coach actually gets.
shots = Counter()
runs = 0
m6runs = 0
for f in glob.glob("/opt/uk-bus-tracker/data/camera-snapshots/*.json"):
    try:
        m = json.load(open(f))
    except Exception:
        continue
    s = m.get("shots")
    if not isinstance(s, list) or not s:
        continue
    runs += 1
    shots[len(s)] += 1
    roads = " ".join((x.get("road") or "") for x in s)
    if "M6" in roads:
        m6runs += 1

print(f"coach runs captured: {runs}   of which touched the M6: {m6runs}")
print()
print("photos per coach run:")
cum = 0
total = runs
for n in sorted(shots):
    cum += shots[n]
    bar = "#" * max(1, shots[n] // 4)
    print(f"  {n:>2} photos: {shots[n]:>4} runs  {bar}   cumulative {cum / total * 100:5.1f}%")
print()
at12 = shots.get(12, 0)
one = shots.get(1, 0)
print(f"runs that hit the 12-photo cap: {at12} ({at12 / total * 100:.1f}%)")
print(f"runs that got only 1 photo:     {one} ({one / total * 100:.1f}%)")
print()
if at12 / total < 0.2:
    print("=> the 12-photo cap is almost never reached, so raising it would do")
    print("   very little. What limits a coach is how few cameras it comes within")
    print("   range of, which is the capture radius (NEAR_M), not the cap.")
