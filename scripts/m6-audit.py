"""What do we actually have on the M6, and is it spread along the whole road?

The user's ask is "add all the M6 cameras so coaches get caught". Before adding
anything it is worth knowing whether they are missing, because a file that
already lists 400-odd M6 cameras and still catches nothing is telling us the
problem is not coverage.
"""
import json
import math
import re
from collections import Counter

LOC = "/opt/uk-bus-tracker/camera-locations.generated.json"
data = json.load(open(LOC))
cams = data["cameras"] if isinstance(data, dict) else data
print(f"total cameras in the location file: {len(cams)}")
print()


def is_m6(c):
    road = (c.get("road") or "").upper()
    desc = (c.get("desc") or "").upper()
    return road == "M6" or "M6" in desc


m6 = [c for c in cams if is_m6(c)]
print(f"cameras naming the M6: {len(m6)}")
roads = Counter((c.get("road") or "?").upper() for c in m6)
print("  by road label:", dict(roads.most_common(8)))
print()

# The M6 runs from Rugby (52.4N) to the Scottish border (55.0N), but the
# National Highways network in England ends around Newcastle. Show the spread.
buckets = Counter()
for c in m6:
    lat = c.get("lat")
    if lat is None:
        continue
    buckets[round(lat, 1)] += 1
print("M6 cameras by latitude (0.1 deg bands):")
for lat in sorted(buckets):
    bar = "#" * buckets[lat]
    flag = "   <-- thin" if buckets[lat] <= 3 else ""
    print(f"  {lat:.1f}  {buckets[lat]:>3}  {bar}{flag}")
print()
lats = [c["lat"] for c in m6 if c.get("lat") is not None]
if lats:
    print(f"  latitude range: {min(lats):.3f} to {max(lats):.3f}")
    print(f"  M6 in England runs roughly 52.4 (Rugby) to 55.0 (border)")
    print()

# Are there cameras sitting near the M6 that are NOT labelled as M6? Those
# would be additional chances that the road label is hiding.
near_m6 = 0
for c in cams:
    if is_m6(c) or c.get("lat") is None or c.get("lon") is None:
        continue
    for m in m6:
        if m.get("lat") is None or m.get("lon") is None:
            continue
        # 3 km is roughly a camera's useful viewing radius on a motorway
        if abs(c["lat"] - m["lat"]) < 0.03 and abs(c["lon"] - m["lon"]) < 0.05:
            near_m6 += 1
            break
print(f"unlabelled cameras within ~3 km of an M6 camera: {near_m6}")
