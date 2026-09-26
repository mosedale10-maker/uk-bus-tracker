/**
 * Backfill `reg:<PLATE>` aliases for Alton Towers journeys.
 *
 * AT1–AT3 were recorded only under the opaque NextStop key (`staff-6005_-_BU74_YSF`)
 * and `at:…` keys, so the map — which looks buses up by plate — could not find
 * those journeys. The recorder now writes the plate key as it goes, but the
 * history recorded before that fix still needs copying.
 *
 * Run on the host:  node scripts/backfill-trail-reg-aliases.mjs
 */
import { initTrailStore, appendTrailPointsBatch, getTrailsForKeys, listTrailKeysForLines } from "../trail-store.mjs";

const AT_LINES = ["AT1", "AT2", "AT3"];

function plateFromKey(key) {
  const text = String(key || "").toUpperCase();
  const compact = text.replace(/[^A-Z0-9]/g, "");
  // "6005_-_BU74_YSF" -> "6005BU74YSF" -> trailing plate
  const tail = compact.match(/([A-Z]{1,2}\d{1,2}[A-Z]{3})$/);
  return tail ? tail[1] : "";
}

await initTrailStore();
const seen = new Set();
const entries = [];
let scanned = 0;

for (const line of AT_LINES) {
  const keys = await listTrailKeysForLines([line], { days: 30, limit: 400 });
  for (const key of keys
    .map((row) => (typeof row === "string" ? row : row.key || row.trailKey || row.trail_key || ""))
    .filter(Boolean)) {
    if (!/^(staff-|at:)/.test(key)) continue;
    const plate = plateFromKey(key);
    if (!plate) continue;
    const regKey = `reg:${plate}`;
    scanned += 1;
    if (seen.has(`${regKey}|${key}`)) continue;
    seen.add(`${regKey}|${key}`);
    const { trails } = await getTrailsForKeys([key], { days: 30 });
    const points = trails?.[key];
    if (!Array.isArray(points) || points.length < 2) continue;
    entries.push([regKey, points]);
  }
}

if (!entries.length) {
  console.log("nothing to backfill");
  process.exit(0);
}

// Group by reg key so one batch covers every source segment.
const merged = new Map();
for (const [key, points] of entries) {
  if (!merged.has(key)) merged.set(key, []);
  merged.get(key).push(...points);
}
const batches = [...merged.entries()].map(([key, points]) => [key, points]);
let inserted = 0;
for (let i = 0; i < batches.length; i += 50) {
  const result = await appendTrailPointsBatch(batches.slice(i, i + 50));
  inserted += result?.inserted || 0;
}
console.log(`scanned ${scanned} AT keys, wrote ${inserted} points into ${batches.length} reg keys`);
