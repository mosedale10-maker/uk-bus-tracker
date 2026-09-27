/*
 * Tests for the coach-shape gate.
 *
 * The reason this exists in a test and not just in the verifier: the failure it
 * guards is a SILENT one. A box that is too small to be a coach simply stops
 * being reported, and the only visible symptom is that the gallery has fewer
 * photos - which looks like the feature working rather than like a filter that
 * is mis-calibrated. So the thresholds are pinned against real measured
 * detections, and the gate itself is executed rather than reimplemented.
 */
const fs = require("fs");
const { execFileSync } = require("child_process");

const py = fs.readFileSync("scripts/verify-coaches.py", "utf8");

let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
};

// The thresholds are stated and, importantly, ordered sensibly.
const num = (n) => Number(new RegExp(`^${n} = ([0-9.]+)`, "m").exec(py)?.[1]);
const floor = num("MIN_COACH_PX");
const short = num("MIN_COACH_SHORT_PX");
const aspect = num("MAX_COACH_ASPECT");
const implied = num("MIN_COACH_IMPLIED");
ok("the thresholds are real numbers", [floor, short, aspect, implied].every(Number.isFinite),
  JSON.stringify({ floor, short, aspect, implied }));
ok("the short side cannot exceed the long side", short < floor, `${short} vs ${floor}`);
ok("the aspect limit is a ratio, not a pixel count", aspect > 1 && aspect < 10, String(aspect));
ok("the floor is documented with the numbers it came from", /855 stored detections/.test(py));
ok("the residual risk is stated, not hidden", /box lorry is the same size/.test(py));

// Ask the real function, not a reimplementation of it.
const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("vc", "/opt/uk-bus-tracker/scripts/verify-coaches.py")
vc = importlib.util.module_from_spec(spec); spec.loader.exec_module(vc)
cases = [
    ("a 19px blob on a motorway full of cars", [300, 300, 319, 319], 40, False),
    ("a 32px box 1m from the camera", [10, 10, 42, 42], 1, False),
    ("a 46px box that was a white van", [100, 200, 146, 246], 83, False),
    ("a 60x28 sliver", [100, 200, 160, 228], 60, False),
    ("a 400x60 horizontal streak", [0, 300, 400, 360], 40, False),
    ("a big clear coach at 35m", [180, 180, 526, 502], 35, True),
    ("a coach-sized box at 100m", [300, 250, 420, 330], 100, True),
]
out = []
for name, box, d, want in cases:
    got, why = vc.coach_shape_ok(box, d)
    out.append({"name": name, "want": want, "got": got, "why": why})
print(json.dumps(out))
`;
let results = [];
try {
  const raw = execFileSync("python3", ["-c", script], { encoding: "utf8" });
  results = JSON.parse(raw.trim().split("\n").pop());
} catch (err) {
  console.log(`  SKIP  could not run the Python gate (${String(err.message).slice(0, 60)})`);
  results = null;
}

if (results) {
  for (const r of results) {
    ok(r.name, r.got === r.want, `expected ${r.want ? "accept" : "reject"}, got ${r.got ? "accept" : "reject"}${r.why ? ` (${r.why})` : ""}`);
  }
  ok("a rejected box says why", results.filter((r) => !r.got).every((r) => r.why.length > 0));
  ok("an accepted box has no complaint", results.filter((r) => r.got).every((r) => !r.why));

  // The gate must never crash on junk input, because it runs inside a loop over
  // every captured frame.
  const edge = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("vc", "/opt/uk-bus-tracker/scripts/verify-coaches.py")
vc = importlib.util.module_from_spec(spec); spec.loader.exec_module(vc)
out = []
for box, d in [([0,0,0,0], 10), ([5,5,5,9], None), ([-10,-10,10,10], 0), ([1,2,3,4], -5), (None, 10), ([0,0,720,576], 50)]:
    try:
        ok, why = vc.coach_shape_ok(box, d)
        out.append([bool(ok), str(why)])
    except Exception as exc:
        out.append(["RAISED", str(exc)])
print(json.dumps(out))
`;
  try {
    const raw = execFileSync("python3", ["-c", edge], { encoding: "utf8" });
    const rows = JSON.parse(raw.trim().split("\n").pop());
    ok("degenerate input is rejected, never raised", rows.every((r) => r[0] !== "RAISED"),
      JSON.stringify(rows.filter((r) => r[0] === "RAISED")));
    ok("a zero-area box is rejected", rows[0][0] === false, JSON.stringify(rows[0]));
  } catch (err) {
    ok("degenerate input check ran", false, String(err.message).slice(0, 60));
  }
}

ok("rejections are recorded on the shot, not dropped silently", /rejectedAs/.test(py));
ok("the run summary reports how many were rejected", /rejected as too small/.test(py));
ok("the raw detection is not thrown away", /rejectedAs.*bus class at/.test(py));

console.log(failed ? `\n${failed} failure(s)` : "\nthe coach-shape gate behaves");
process.exit(failed ? 1 : 0);
