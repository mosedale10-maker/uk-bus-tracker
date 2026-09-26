/**
 * Refresh camera-locations.generated.json: every National Highways camera with
 * its id, road, description and position.
 *
 * National Highways does not publish this list itself - the only machine-readable
 * copy is served by an unofficial rebuild of the old Traffic England map - so we
 * snapshot it here and commit the result. That keeps the tracker working without
 * depending on that site at runtime, and means a refresh is a deliberate,
 * reviewable step rather than a live third-party call on every page load.
 *
 * The images themselves are never stored or re-hosted: the viewer loads them
 * straight from the National Highways public camera service.
 *
 * Run: node scripts/sync-camera-locations.mjs
 */
import { writeFileSync } from "node:fs";

const SOURCE = "https://trafficengland.uk/data/cameras.geojson";

const res = await fetch(SOURCE, {
  headers: { accept: "application/geo+json, application/json" },
});
if (!res.ok) throw new Error(`${SOURCE} -> ${res.status}`);
const geo = await res.json();

const rows = [];
const seen = new Set();
for (const feature of geo?.features || []) {
  const p = feature?.properties || {};
  const coords = feature?.geometry?.coordinates || [];
  const id = String(p.id || "").trim();
  const lat = Number(coords[1]);
  const lon = Number(coords[0]);
  if (!id || seen.has(id)) continue;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  if (lat < 49 || lat > 61 || lon < -8.5 || lon > 2) continue;
  seen.add(id);
  rows.push({
    id,
    road: String(p.road || "").trim(),
    desc: String(p.desc || "").trim(),
    // 4dp is roughly 11m, plenty for "which camera is this coach near".
    lat: Math.round(lat * 1e4) / 1e4,
    lon: Math.round(lon * 1e4) / 1e4,
  });
}

rows.sort((a, b) => a.id.localeCompare(b.id));

const body =
  JSON.stringify(
    {
      // Records when this was last refreshed, so a stale list is obvious.
      generated: new Date().toISOString(),
      source: SOURCE,
      note:
        "Camera imagery is Crown copyright, National Highways. Images are " +
        "loaded live from their public service and are not stored here.",
      count: rows.length,
      cameras: rows,
    },
    null,
    0,
  ) + "\n";

writeFileSync(
  new URL("../camera-locations.generated.json", import.meta.url),
  body,
);
console.log(`seeded ${rows.length} cameras across ${new Set(rows.map((r) => r.road)).size} roads`);
