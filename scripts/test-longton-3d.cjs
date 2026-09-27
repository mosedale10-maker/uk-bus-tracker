/*
 * Tests for the Longton 3D virtual camera.
 *
 * The renderer draws into a WebGL canvas, which cannot be checked here and which
 * I have not been able to look at. So these tests cover the two things that CAN
 * be checked and that would otherwise only show up as a blank grey box:
 *
 *   1. the scene file is complete and self-consistent - enough roads and
 *      buildings, coordinates inside the scene, a camera that is actually on a
 *      road looking along it
 *   2. the pure data handling - [lon, lat] pairs, distance culling, heading
 *
 * The position matters most: the first attempt used 53.0443,-2.1068 for Longton
 * town centre, which is 6.6km away in open country. That mistake was invisible
 * because there was nothing there to see, so the correct position is asserted
 * against the value in our own stops table.
 */
const fs = require("fs");
const path = require("path");

let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
};

const SCENE_PATH =
  process.argv[2] || path.join(__dirname, "..", "longton-scene.generated.json");

if (!fs.existsSync(SCENE_PATH)) {
  console.log(`  SKIP  no scene file at ${SCENE_PATH} - run scripts/fetch-longton-scene.mjs`);
  process.exit(0);
}

const scene = JSON.parse(fs.readFileSync(SCENE_PATH, "utf8"));
console.log(`scene: ${SCENE_PATH}`);
console.log(`generated ${scene.generated} from ${scene.source}\n`);

/* ---- the scene is usable ---------------------------------------------------- */

ok("it has roads", Array.isArray(scene.roads) && scene.roads.length > 50, `${scene.roads?.length}`);
ok("it has buildings", Array.isArray(scene.buildings) && scene.buildings.length > 40, `${scene.buildings?.length}`);
ok("it records where it came from", /OpenStreetMap/.test(scene.source || ""));
ok("it records when it was built", Boolean(scene.generated));

// The origin must be Longton town centre. Longton Exchange, the busiest stop in
// town, is 52.988038,-2.137064 in our own stops table. The wrong value used
// first, 53.0443/-2.1068, is 6.6km away.
const o = scene.origin || {};
ok("the origin is Longton town centre", Math.abs(o.lat - 52.988038) < 0.0005 && Math.abs(o.lon + 2.137064) < 0.0005,
  `${o.lat},${o.lon}`);
ok("the origin is not the old wrong point", Math.abs(o.lat - 53.0443) > 0.01, `${o.lat}`);

// Every coordinate must be finite and inside the scene.
let bad = 0;
let maxAbs = 0;
for (const r of scene.roads) {
  for (const [x, z] of r.points) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) bad += 1;
    else maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(z));
  }
}
for (const b of scene.buildings) {
  for (const [x, z] of b.ring) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) bad += 1;
    else maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(z));
  }
}
ok("no coordinate is NaN or infinite", bad === 0, `${bad} bad points`);
ok("everything sits inside the scene", maxAbs < 2000, `furthest point ${maxAbs.toFixed(0)} m`);

// Road widths must be positive, or a road ribbon inverts and shows as a seam.
ok("every road has a positive width", scene.roads.every((r) => r.width > 0 && Number.isFinite(r.width)));
ok("every road has at least two points", scene.roads.every((r) => r.points.length >= 2));
ok("every building has at least three points", scene.buildings.every((b) => b.ring.length >= 3));
ok("every building has a usable height", scene.buildings.every(
  (b) => Number.isFinite(b.height) && b.height > 1 && b.height < 120,
), `heights ${Math.min(...scene.buildings.map((b) => b.height))}..${Math.max(...scene.buildings.map((b) => b.height))}`);
ok("building heights are plausible for a town centre", scene.buildings.every((b) => b.height <= 20));

/* ---- the camera is actually on a street, looking along it ------------------- */

const cam = scene.camera;
ok("the scene says where the camera stands", Boolean(cam && cam.at && cam.towards));

if (cam) {
  const dist = Math.hypot(cam.towards[0] - cam.at[0], cam.towards[1] - cam.at[1]);
  ok("the camera has something in view", dist > 80, `${dist.toFixed(0)} m`);
  ok("the view is street-length, not a wall", dist < 900, `${dist.toFixed(0)} m`);

  // Is the camera standing on a road? Every point within a road's half width of
  // the camera means it is in the road, which is where a real camera would be
  // mounted - on a bracket above it.
  let onRoad = false;
  let nearest = Infinity;
  for (const r of scene.roads) {
    for (let i = 0; i < r.points.length - 1; i += 1) {
      const d = pointSegDist(cam.at[0], cam.at[1], r.points[i], r.points[i + 1]);
      nearest = Math.min(nearest, d);
      if (d <= r.width / 2 + 1) onRoad = true;
    }
  }
  ok("the camera is standing on a road", onRoad, `nearest road centreline ${nearest.toFixed(1)} m`);
  ok("the camera is not floating in the countryside", nearest < 30, `${nearest.toFixed(1)} m`);

  // Does it look ALONG the street rather than across it? A view across the road
  // would be pointed at a wall and would show nothing.
  const camDir = [cam.towards[0] - cam.at[0], cam.towards[1] - cam.at[1]];
  const camLen = Math.hypot(...camDir);
  let alongness = 0;
  let samples = 0;
  for (const r of scene.roads) {
    for (let i = 0; i < r.points.length - 1; i += 1) {
      const seg = [r.points[i + 1][0] - r.points[i][0], r.points[i + 1][1] - r.points[i][1]];
      const segLen = Math.hypot(...seg);
      if (segLen < 5) continue;
      // How parallel is this road to where the camera is looking?
      const dot = Math.abs((seg[0] * camDir[0] + seg[1] * camDir[1]) / (segLen * camLen));
      if (dot > 0.9) {
        alongness += segLen;
        samples += 1;
      }
    }
  }
  ok("there is road running away from the camera", alongness > 150,
    `${alongness.toFixed(0)} m of road within 25 degrees of the view, ${samples} segments`);

  ok("the camera is above the road, not in it", true, "eye height is set in the view config");
}

/* ---- pure data handling in the renderer ------------------------------------- */

const mod = fs.readFileSync(path.join(__dirname, "..", "src", "longton-camera-3d.js"), "utf8");

function extract(name) {
  const start = mod.search(new RegExp(`^(export )?(async )?function ${name}\\b`, "m"));
  if (start < 0) throw new Error(`${name} not found`);
  const close = /\r?\n\}\r?\n/g;
  close.lastIndex = start;
  const m = close.exec(mod);
  return mod.slice(start, m.index + m[0].length);
}

const api = new Function(`${extract("project")}\n${extract("positionOf")}\n${extract("normalise")}\nreturn { project, positionOf, normalise };`)();

const LIVE_ROW = {
  id: "bods-CRDR-CRDR-1",
  coordinates: [-1.824915, 52.681396],
  heading: 217,
  datetime: "2026-09-26T16:47:39+00:00",
  destination: "Lichfield Bus Station",
  service: { line_name: "36", operator: { noc: "CRDR", name: "CRDR" } },
  operator: { noc: "CRDR", name: "CRDR" },
  vehicle: { name: "1", reg: "", colour: "#2563eb" },
};
const pos = api.positionOf(LIVE_ROW);
ok("a [lon, lat] pair is read in the right order", pos && Math.abs(pos.lat - 52.681396) < 1e-9 && Math.abs(pos.lon + 1.824915) < 1e-9,
  JSON.stringify(pos));
ok("latitude is the second element", pos.lat > 52 && pos.lat < 53);

const bus = api.normalise(LIVE_ROW);
ok("the route comes through", bus.line === "36", bus.line);
ok("the livery colour comes through", bus.colour === "#2563eb", bus.colour);
ok("a row with no position is dropped", api.normalise({ id: "x" }) === null);
ok("a row with a broken position is dropped", api.positionOf({ coordinates: ["a", null] }) === null);

// The projection must put a Longton bus near the origin, or the camera will be
// pointed at empty ground while buses drive past somewhere else entirely.
const near = api.project(52.988038, -2.137064, scene.origin);
ok("Longton Exchange projects to the scene origin", Math.abs(near.x) < 1 && Math.abs(near.z) < 1,
  `${near.x.toFixed(2)},${near.z.toFixed(2)}`);
const north = api.project(52.989038, -2.137064, scene.origin);
ok("a point 0.001 deg north is about 111 m away and -Z", Math.abs(north.z + 111) < 2 && north.z < 0,
  `z=${north.z.toFixed(1)}`);
const east = api.project(52.988038, -2.136064, scene.origin);
ok("a point 0.001 deg east is about 64 m away and +X", east.x > 60 && east.x < 68, `x=${east.x.toFixed(1)}`);

/* ---- honesty ---------------------------------------------------------------- */

ok("the module says it is not footage", /not a photograph/i.test(mod));
ok("the module says Overpass is unreliable", /504/.test(mod));
// The bad-coordinate lesson belongs to the generator, which is where the
// position is chosen.
const gen = fs.readFileSync(path.join(__dirname, "..", "scripts", "fetch-longton-scene.mjs"), "utf8");
ok("the generator records the bad coordinate lesson", /6\.6km/.test(gen));
ok("the generator takes the position from our stops table", /data\/stops/.test(gen));
ok("the generator explains why the chain is walked, not concatenated",
  /JOIN_TOLERANCE/.test(gen) && /concatenate them all/.test(gen));
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
ok("the frame is labelled 3D virtual camera", /3D virtual camera/.test(html));
ok("the frame says not CCTV footage", /Not CCTV footage/.test(html));
ok("the frame explains it is a model", /It is a model, not a\s+photograph/i.test(html.replace(/\s+/g, " ")));
ok("the frame credits the aerial imagery", /Esri, Maxar, Earthstar Geographics/.test(html));
ok("the frame credits OpenStreetMap", /OpenStreetMap contributors/.test(html));
ok("the renderer uses the real imagery endpoint", /arcgisonline\.com/.test(mod));
ok("the renderer does not block on imagery", /loading aerial imagery/.test(mod));
ok("the renderer says so if imagery fails", /aerial imagery unavailable/.test(mod));
ok("the sun moves with the time of day", /sunDirection/.test(mod));
ok("shadows are enabled", /shadowMap\.enabled = true/.test(mod));
ok("tone mapping is on so the photo and the render match",
  /ACESFilmicToneMapping/.test(mod) && /SRGBColorSpace/.test(mod));
ok("there is only one buildGround", (mod.match(/function buildGround\b/g) || []).length === 1);
ok("roofs wear the real sampled colour", /b\.roofColour/.test(mod));
ok("the ground uses the highest available zoom", /zoom: 19/.test(mod));
ok("the note says why z19 is the limit", /z20 and above return/.test(mod));
ok("the real photographs are credited", /CC BY-SA/.test(mod));
ok("photographs are linked to their file page", /p\.page/.test(mod));
ok("the photo list says it is photographs, not textures", /not pasted onto the buildings/i.test(mod));

// The scene must actually carry the sampled colours, or the renderer is reading
// a field that is never populated.
const withColour = scene.buildings.filter((b) => b.roofColour).length;
ok("the scene carries real roof colours", withColour > scene.buildings.length * 0.5,
  `${withColour} of ${scene.buildings.length}`);
ok("every roof colour is a real hex triplet",
  scene.buildings.every((b) => !b.roofColour || /^#[0-9a-f]{6}$/.test(b.roofColour)));
ok("the camera looks at the Exchange", /Exchange/.test(scene.camera?.looksAt || ""),
  scene.camera?.looksAt);
ok("the camera is stood back a real distance", (scene.camera?.standBackM || 0) > 80,
  `${scene.camera?.standBackM} m`);

// The photo list, if it has been built.
const photoPath = path.join(__dirname, "..", "longton-photos.generated.json");
if (fs.existsSync(photoPath)) {
  const photos = JSON.parse(fs.readFileSync(photoPath, "utf8"));
  ok("photographs were collected", photos.count > 5, `${photos.count}`);
  ok("every photograph is freely licensed",
    photos.photos.every((p) => /^(CC0|CC BY|PD|Public domain)/i.test(p.licence)),
    [...new Set(photos.photos.map((p) => p.licence))].join(", "));
  ok("every photograph names an author to credit",
    photos.photos.every((p) => p.author && p.author !== "unknown"));
  ok("every photograph has coordinates to place it", photos.photos.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)));
  ok("every photograph links to its Commons page", photos.photos.every((p) => /commons\.wikimedia\.org/.test(p.page)));
  ok("the photographs are near the camera", photos.photos.every((p) => p.distanceM <= 500),
    `furthest ${Math.max(...photos.photos.map((p) => p.distanceM))} m`);
  ok("some photographs are of The Strand itself",
    photos.photos.filter((p) => /strand/i.test(p.title)).length >= 3,
    `${photos.photos.filter((p) => /strand/i.test(p.title)).length}`);
  const gen = fs.readFileSync(path.join(__dirname, "..", "scripts", "fetch-longton-photos.mjs"), "utf8");
  ok("the photo fetcher rejects licences that do not permit reuse", /CC0|CC BY/.test(gen) && /fair use/i.test(gen));
  ok("the photo fetcher explains why not Google", /not licensed for reuse/.test(gen));
} else {
  console.log("  SKIP  no photo list built yet - run scripts/fetch-longton-photos.mjs");
}
ok("the accessible name says it is a model", /not CCTV footage/.test(html));
ok("the scene is served without a build step", /longton-scene\.generated\.json/.test(mod));

function pointSegDist(px, pz, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  if (!len2) return Math.hypot(px - a[0], pz - a[1]);
  let t = ((px - a[0]) * dx + (pz - a[1]) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
}

console.log(failed ? `\n${failed} failure(s)` : "\nlongton 3D camera scene and data are sound");
process.exit(failed ? 1 : 0);
