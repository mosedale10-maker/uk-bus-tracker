/**
 * One-off (and re-runnable) bulk import of the bustimes.org stop catalogue into SQLite.
 *
 *   node scripts/import-stops.mjs
 *
 * bustimes.org paginates 100/page with no spatial filter, so this walks `next` until
 * exhausted. Safe to re-run: rows are upserted by atco and anything missing upstream is
 * pruned at the end.
 */
import { initStopStore, upsertStops, pruneStopsNotIn, stopCount } from "../stop-store.mjs";

const BASE = "https://bustimes.org/api/stops/";
const PAGE = 100;

function toRow(s) {
  const loc = s?.location;
  if (!Array.isArray(loc) || loc.length < 2) return null;
  const lng = Number(loc[0]);
  const lat = Number(loc[1]);
  const atco = String(s.atco_code || "").trim();
  if (!atco || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  const lines = Array.isArray(s.line_names) ? s.line_names.filter(Boolean) : [];
  return {
    atco,
    name: String(s.common_name || s.name || s.long_name || "").trim(),
    indicator: String(s.indicator || "").trim(),
    lat,
    lng,
    services: lines.join("|"),
  };
}

const started = Date.now();
await initStopStore();
console.log("[import-stops] starting…");

const active = new Set();
let url = `${BASE}?limit=${PAGE}`;
let pages = 0;
let seen = 0;
let inserted = 0;

while (url) {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`stops ${res.status} at ${url}`);
  const data = await res.json();
  const batch = [];
  for (const s of data.results || []) {
    seen += 1;
    const row = toRow(s);
    if (!row) continue;
    active.add(row.atco);
    batch.push(row);
  }
  if (batch.length) inserted += upsertStops(batch);
  pages += 1;
  if (pages % 50 === 0) {
    process.stdout.write(`\r[import-stops] ${seen} fetched · ${inserted} stored · page ${pages}   `);
  }
  url = data.next || "";
}

const removed = pruneStopsNotIn(active);
process.stdout.write("\n");
console.log(`[import-stops] fetched ${seen} · stored ${inserted} · pruned ${removed}`);
console.log(`[import-stops] final count ${stopCount()} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
