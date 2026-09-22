/** Simulate AT Map · trail key fetch + filters. */
const base = "http://127.0.0.1:4173";
const trailKey = "staff-174_-_WT58_SOT";
const line = "AT1";
const direction = "in";
const day = "2026-09-21";
const keys = [
  trailKey,
  `at:${line}:${direction}:${trailKey}:${day}`,
  `at:${line}:${trailKey}:${day}`,
  `run:${trailKey}:${line}:${direction}:${day}`,
].join(",");

const res = await fetch(`${base}/api/trails?keys=${encodeURIComponent(keys)}&days=7`);
const data = await res.json();
for (const [k, pts] of Object.entries(data.trails || {})) {
  const list = Array.isArray(pts) ? pts : [];
  const dirs = {};
  const lines = {};
  for (const p of list) {
    const d = String(p.direction || "").toLowerCase() || "(none)";
    const l = String(p.line || "") || "(none)";
    dirs[d] = (dirs[d] || 0) + 1;
    lines[l] = (lines[l] || 0) + 1;
  }
  console.log(k, "n=" + list.length, "dirs", dirs, "lines", lines);
  if (list.length) {
    console.log("  first", list[0]);
    console.log("  last", list[list.length - 1]);
  }
}
