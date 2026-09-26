/**
 * Check the coach detector against frames whose contents we already know.
 * Run: node scripts/test-coach-detector.mjs
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { primeDetector, detectCoach } from "../coach-detector.mjs";

const DATA = join(process.cwd(), "data");

// (label, frame path) - expectations come from having looked at these pictures.
const CASES = [
  ["expect coach  BV21CZL M23 59m", join(process.env.TEMP || DATA, "camtest", "BF21CZL-b.jpg")],
  ["expect coach  BV73ZTS M11 30m", join(process.env.TEMP || DATA, "camtest", "BV73ZTS-b.jpg")],
  ["expect cars   BV22VSL M1 47m", join(process.env.TEMP || DATA, "camtest", "BV22VSL-b.jpg")],
  ["expect cars   BF21CZT M4 35m", join(process.env.TEMP || DATA, "camtest", "BF21CZT-a.jpg")],
];

await primeDetector(DATA);
for (const [label, file] of CASES) {
  if (!existsSync(file)) {
    console.log(`  skip  ${label} (no file at ${file})`);
    continue;
  }
  const t0 = Date.now();
  const r = await detectCoach(readFileSync(file), { dataDir: DATA });
  const ms = Date.now() - t0;
  const verdict = r.skipped ? `SKIPPED (${r.skipped})` : r.found ? `BUS conf=${r.score}` : "no bus";
  console.log(`  ${verdict.padEnd(34)} ${String(ms).padStart(5)}ms  ${label}`);
  if (r.box) console.log(`        box=${JSON.stringify(r.box)} extra=${r.boxes.length - 1}`);
}

