/*
 * Regression tests for the camera block on the bus card.
 *
 * The card's camera photo was silently missing for a long time because
 * `shot` and `shown` were referenced in the strings at the top of
 * cameraSnapBlock but declared with `const` further down. That is a temporal
 * dead zone error, so the function threw on EVERY bus card, and nothing in
 * development showed it because the failure only happens in the browser.
 *
 * So this checks two things:
 *   1. the real source has no use-before-declaration in the function
 *   2. the check in (1) actually fires when the bug is put back, because a
 *      guard that cannot fail is worse than no guard
 *   3. the function still renders the three cases the card has to handle
 */
const fs = require("fs");

/** Pull cameraSnapBlock out of the source. Braces cannot be counted: the body is
 *  full of ${...} inside template literals, so use the column-0 closing brace. */
function extract(src) {
  const start = src.indexOf("function cameraSnapBlock");
  if (start < 0) throw new Error("cameraSnapBlock not found");
  const close = /\r?\n\}\r?\n/g;
  close.lastIndex = start;
  const m = close.exec(src);
  if (!m) throw new Error("could not find the end of cameraSnapBlock");
  return src.slice(start, m.index + m[0].length);
}

/** Comments and string contents are prose, not code. `alt="view near ..."` is
 *  not a reference to a variable called `near`. */
function codeOnly(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, '""')
    .replace(/'(?:\\[\s\S]|[^'\\])*'/g, "''");
}

function useBeforeDecl(body) {
  const code = codeOnly(body);
  const decls = new Map();
  for (const m of code.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    if (!decls.has(m[1])) decls.set(m[1], m.index);
  }
  const bad = new Set();
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    if (decls.has(m[1]) && m.index < decls.get(m[1])) bad.add(m[1]);
  }
  return [...bad];
}

const source = fs.readFileSync("src/main.js", "utf8");
let failed = 0;

// 1. the real source
const offenders = useBeforeDecl(extract(source));
if (offenders.length) {
  console.log(`  FAIL  used before declared: ${offenders.join(", ")}`);
  failed += 1;
} else {
  console.log("  PASS  no use-before-declaration in cameraSnapBlock");
}

// 2. the guard must fire on the old broken ordering
{
  let body = extract(source);
  const declStart = body.indexOf("  const shot = snap.currentShot || null;");
  const tail = "  const shown = coachSeen ? shot : null;";
  const declEnd = body.indexOf(tail);
  if (declStart < 0 || declEnd < 0) {
    console.log("  FAIL  could not rebuild the old declaration order to test the guard");
    failed += 1;
  } else {
    const decls = body.slice(declStart, declEnd + tail.length);
    const moved = body.slice(0, declStart) + body.slice(declStart + decls.length);
    // put the declarations back at the very bottom, as they used to be
    const lastBrace = moved.lastIndexOf("}");
    const broken = moved.slice(0, lastBrace) + decls + "\r\n" + moved.slice(lastBrace);
    if (broken.indexOf("const shot = snap.currentShot") > broken.indexOf("shot?.road")) {
      const caught = useBeforeDecl(broken);
      if (caught.includes("shot") && caught.includes("shown")) {
        console.log("  PASS  the guard catches the old bug (shot, shown)");
      } else {
        console.log(`  FAIL  guard missed the old bug, only caught: ${caught.join(", ") || "nothing"}`);
        failed += 1;
      }
    } else {
      console.log("  FAIL  could not rebuild the old broken ordering");
      failed += 1;
    }
  }
}

// 3. the three cases the card has to render
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const body = extract(source);
const cameraSnapBlock = new Function("esc", `${body}; return cameraSnapBlock;`)(esc);

const cases = [
  {
    name: "coach detected on a brightened night frame",
    snap: {
      frames: ["/api/camera-snapshot/BV72XEX-c1234-n.jpg"],
      image: "/api/camera-snapshot/BV72XEX-c1234-n.jpg",
      road: "M11",
      desc: "J7A-J8",
      distanceM: 12,
      takenAt: 1758800000000,
      shotCount: 6,
      plate: "BV72XEX",
      operatorLabel: "National Express",
      label: "National Express 118",
      currentShot: {
        road: "M11",
        desc: "J7A-J8",
        distanceM: 12,
        busDetected: true,
        busConfidence: 0.898,
        busBox: [10, 20, 300, 180],
        file: "/api/camera-snapshot/BV72XEX-c1234-n.jpg",
        enhanced: true,
      },
    },
    expect: [/coach detected/, /brightened for night/, /J7A-J8/, /popup-camera-crop/],
  },
  {
    name: "no coach in view",
    snap: {
      frames: ["/api/camera-snapshot/BV71GYP-c9999.jpg"],
      image: "/api/camera-snapshot/BV71GYP-c9999.jpg",
      road: "M4",
      desc: "J3-J2",
      distanceM: 40,
      takenAt: 1758800000000,
      shotCount: 1,
      plate: "BV71GYP",
      operatorLabel: "National Express",
      currentShot: {
        road: "M4",
        desc: "J3-J2",
        distanceM: 40,
        busDetected: false,
        file: "/api/camera-snapshot/BV71GYP-c9999.jpg",
      },
    },
    expect: [/No coach detected/, /J3-J2/],
    reject: [/coach detected</],
  },
  {
    name: "no frames at all",
    snap: { frames: [], plate: "X" },
    expect: [/^$/],
  },
];

for (const c of cases) {
  try {
    const html = cameraSnapBlock(c.snap);
    const missing = (c.expect || []).filter((re) => !re.test(html));
    const present = (c.reject || []).filter((re) => re.test(html));
    if (missing.length || present.length) {
      console.log(`  FAIL  ${c.name}`);
      if (missing.length) console.log(`        missing: ${missing.map(String).join(", ")}`);
      if (present.length) console.log(`        should not say: ${present.map(String).join(", ")}`);
      failed += 1;
    } else {
      console.log(`  PASS  ${c.name} -> ${html.length} chars`);
    }
  } catch (err) {
    console.log(`  FAIL  ${c.name} threw: ${err.message}`);
    failed += 1;
  }
}

console.log(failed ? `\n${failed} failure(s)` : "\ncamera card renders every case");
process.exit(failed ? 1 : 0);
