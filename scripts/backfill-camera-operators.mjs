/**
 * Work out which operator each captured coach belongs to, using the operator
 * feeds we already poll, and write it into the snapshot sidecars.
 *
 * The camera frames are operator-agnostic - the detector just finds "a bus" -
 * so without this the card cannot say whether the coach it photographed was a
 * FlixBus or a National Express one.
 *
 * Run: node scripts/backfill-camera-operators.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SNAP_DIR = process.argv[2] || join(process.cwd(), "data", "camera-snapshots");
const FEED = "https://ukbustracker.co.uk/api/bods-vehicles";
// The BODS proxy needs a bbox as well as the operator.
const UK_BBOX = "xmin=-8.2&ymin=49.8&xmax=1.85&ymax=60.9";
const OPERATORS = ["NATX", "FLIX", "LLOY", "SEL", "STN"];

async function regToOperator() {
  const map = new Map();
  for (const op of OPERATORS) {
    const res = await fetch(`${FEED}?${UK_BBOX}&operator=${op}`).catch(() => null);
    if (!res || !res.ok) continue;
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data) ? data : data?.vehicles;
    for (const v of Array.isArray(list) ? list : []) {
      const reg = String(v?.vehicle?.reg || v?.vehicle?.name || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      if (reg) map.set(reg, op);
    }
  }
  return map;
}

const map = await regToOperator();
console.log(`operator feed gave ${map.size} registrations`);

let updated = 0;
let unknown = 0;
const seen = new Set();
for (const name of readdirSync(SNAP_DIR)) {
  if (!name.endsWith(".json")) continue;
  const file = join(SNAP_DIR, name);
  let meta;
  try {
    meta = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  const op = map.get(String(meta.reg || "").toUpperCase());
  if (!op) {
    unknown += 1;
    continue;
  }
  if (meta.operator === op) continue;
  meta.operator = op;
  meta.operatorLabel = op === "FLIX" ? "FlixBus" : op === "NATX" ? "National Express" : op;
  writeFileSync(file, JSON.stringify(meta));
  seen.add(`${op}`);
  updated += 1;
}
console.log(`updated ${updated} sidecars, ${unknown} could not be matched`);
console.log(`operators seen: ${[...seen].join(", ") || "none"}`);
