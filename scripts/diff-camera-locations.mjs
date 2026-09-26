/**
 * Compare the committed camera list against a fresh fetch of the source, without
 * overwriting anything.
 *
 * sync-camera-locations.mjs writes straight over the live file. That is fine when
 * you already trust the source, but the live app reads this file on every coach
 * poll, so a bad fetch would take the camera feature down with no way to tell what
 * changed. This asks the same question without the risk, and the answer decides
 * whether the sync is worth running.
 */
import { readFileSync } from "node:fs";

const SOURCE = "https://trafficengland.uk/data/cameras.geojson";
const LIVE = new URL("../camera-locations.generated.json", import.meta.url);

const current = JSON.parse(readFileSync(LIVE, "utf8"));
const have = new Map((current.cameras || []).map((c) => [String(c.id), c]));
console.log(`committed list : ${have.size} cameras, generated ${current.generated || "unknown"}`);
console.log(`source         : ${SOURCE}`);

let res;
try {
  res = await fetch(SOURCE, { headers: { accept: "application/geo+json, application/json" } });
} catch (err) {
  console.log(`\nFETCH FAILED: ${err.message}`);
  console.log("The committed list is still in place and the app is unaffected.");
  process.exit(2);
}
if (!res.ok) {
  console.log(`\nFETCH FAILED: HTTP ${res.status}`);
  console.log("The committed list is still in place and the app is unaffected.");
  process.exit(2);
}
// Read the body once. A Response can only be consumed a single time, so calling
// both .json() and .text() throws.
const body = await res.text();
console.log(`fetched        : HTTP ${res.status}, ${body.length} bytes`);
let geo;
try {
  geo = JSON.parse(body);
} catch (err) {
  console.log(`\nSOURCE RETURNED SOMETHING THAT IS NOT GEOJSON: ${err.message}`);
  console.log("The committed list is still in place and the app is unaffected.");
  process.exit(2);
}

// Exactly the same filtering as the sync script, so the comparison is fair.
const fresh = new Map();
for (const feature of geo?.features || []) {
  const p = feature?.properties || {};
  const coords = feature?.geometry?.coordinates || [];
  const id = String(p.id || "").trim();
  const lat = Number(coords[1]);
  const lon = Number(coords[0]);
  if (!id || fresh.has(id)) continue;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  if (lat < 49 || lat > 61 || lon < -8.5 || lon > 2) continue;
  fresh.set(id, {
    id,
    road: String(p.road || "").trim(),
    desc: String(p.desc || "").trim(),
    lat: Math.round(lat * 1e4) / 1e4,
    lon: Math.round(lon * 1e4) / 1e4,
  });
}
console.log(`source has     : ${fresh.size} cameras after filtering\n`);

const added = [...fresh.keys()].filter((id) => !have.has(id));
const removed = [...have.keys()].filter((id) => !fresh.has(id));
const moved = [];
const relabelled = [];
for (const [id, c] of fresh) {
  const old = have.get(id);
  if (!old) continue;
  if (Math.abs(old.lat - c.lat) > 0.0002 || Math.abs(old.lon - c.lon) > 0.0002) moved.push(id);
  if ((old.road || "") !== c.road || (old.desc || "") !== c.desc) relabelled.push(id);
}

// Must not be a loose /M6/ test: that also matches M60, M61, M62, M66 and M69,
// which inflates the number and makes the M6 look better covered than it is.
const isM6 = (c) => /\bM6\b/.test(c.road || "") || /\bM6\b/.test(c.desc || "");
const m6 = (list) =>
  [...list].filter((id) => {
    const c = fresh.get(id) || have.get(id);
    return isM6(c);
  }).length;

console.log(`added by a resync : ${added.length}`);
console.log(`removed (gone upstream): ${removed.length}`);
console.log(`moved position   : ${moved.length}`);
console.log(`relabelled       : ${relabelled.length}`);
console.log(`\nM6 cameras now: committed ${m6(have.keys())} -> source ${m6(fresh.keys())}`);

if (added.length) {
  const byRoad = {};
  for (const id of added) {
    const r = fresh.get(id).road || "(none)";
    byRoad[r] = (byRoad[r] || 0) + 1;
  }
  const top = Object.entries(byRoad).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`\nadded by road: ${top.map(([r, n]) => `${r} ${n}`).join(", ")}`);
  const m6added = added.filter((id) => isM6(fresh.get(id)));
  console.log(`of which name the M6: ${m6added.length}`);
  for (const id of m6added.slice(0, 20)) {
    const c = fresh.get(id);
    console.log(`  + ${id}  ${c.lat},${c.lon}  ${c.road} ${c.desc}`);
  }
}
if (removed.length) {
  console.log(`\nremoved (these would disappear): ${removed.slice(0, 20).join(", ")}`);
}
