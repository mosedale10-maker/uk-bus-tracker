import json

data = json.load(open("/opt/uk-bus-tracker/camera-locations.generated.json"))
cams = data["cameras"] if isinstance(data, dict) else data
print(f"generated at: {data.get('generatedAt') if isinstance(data, dict) else 'n/a'}")
print(f"source: {data.get('source') if isinstance(data, dict) else 'n/a'}")
print()

lats = sorted(c["lat"] for c in cams if c.get("lat") is not None)
print(f"all {len(cams)} cameras span {lats[0]:.3f} to {lats[-1]:.3f} latitude")
print(f"northernmost 8: {[round(x, 3) for x in lats[-8:]]}")
print()

# The M6 runs north past Carlisle to the Scottish border near 55.05. Anything we
# hold above 54.3 at all?
north = [c for c in cams if (c.get("lat") or 0) > 54.25]
print(f"cameras north of 54.25 (M6 Carlisle -> border runs 54.5 to 55.0): {len(north)}")
for c in sorted(north, key=lambda c: -c["lat"])[:10]:
    print(f"  {c['lat']:.3f},{c['lon']:.3f}  {c.get('road')} {c.get('desc')}")
print()

# Which roads appear up there, to see whether the northern M6 is simply absent
# from the source rather than mislabelled.
roads = {}
for c in north:
    roads.setdefault((c.get("road") or "?").upper(), 0)
    roads[(c.get("road") or "?").upper()] += 1
print("roads of cameras north of 54.25:", roads)
