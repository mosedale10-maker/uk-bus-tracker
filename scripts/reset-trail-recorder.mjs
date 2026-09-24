/**
 * Destructive maintenance helper: clear the filesystem GPS trail store and
 * start the recorder again from an empty history. Stop the app/recorder first.
 *
 * Usage: node scripts/reset-trail-recorder.mjs --confirm
 */

import { clearAllTrailPoints, initTrailStore, TRAIL_KEEP_DAYS } from "../trail-store.mjs";

if (!process.argv.includes("--confirm")) {
  console.error("Refusing destructive reset. Re-run with --confirm after stopping ukbustracker.");
  process.exit(2);
}

const ready = await initTrailStore();
if (!ready) {
  console.error("[trails] store unavailable");
  process.exit(1);
}
const result = await clearAllTrailPoints();
console.log(JSON.stringify({ ...result, keepDays: TRAIL_KEEP_DAYS }));
