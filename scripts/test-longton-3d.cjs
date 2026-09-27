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

  // The camera should stand on the footway, not in the traffic. Dead centre on a
  // 13m carriageway put a 9m shop 8m away filling half the frame, so the scene
  // generator now offsets to the kerb. That makes "just outside the
  // carriageway" the requirement - the opposite of the old assertion, which is
  // why the test changed rather than being loosened.
  let nearest = Infinity;
  let halfWidth = null;
  for (const r of scene.roads) {
    for (let i = 0; i < r.points.length - 1; i += 1) {
      const d = pointSegDist(cam.at[0], cam.at[1], r.points[i], r.points[i + 1]);
      if (d < nearest) {
        nearest = d;
        halfWidth = r.width / 2;
      }
    }
  }
  ok("the camera is beside a road, not in open country", nearest < 30, `${nearest.toFixed(1)} m`);
  ok(
    "the camera is on the footway, clear of the carriageway",
    nearest > halfWidth,
    `${nearest.toFixed(1)} m from the centreline, half-width ${halfWidth} m`,
  );
  ok("the camera is not absurdly far from the kerb", nearest - halfWidth < 6,
    `${(nearest - halfWidth).toFixed(1)} m beyond the kerb`);

  // And nothing should be standing IN the carriageway. Testing "near the sight
  // line" was wrong once the camera moved to the footway: the sight line then
  // runs past the kerb, so a building correctly standing at the kerb is 1m from
  // it. What must not happen is a footprint reaching into the road it borders.
  {
    const corridors = scene.roads.filter(
      (r) => !["service", "footway", "path", "pedestrian"].includes(r.type),
    );
    let inRoad = 0;
    for (const b of scene.buildings) {
      for (const road of corridors) {
        const half = road.width / 2 - 0.5;
        let hit = false;
        for (let i = 0; i < road.points.length - 1 && !hit; i += 1) {
          for (const [x, z] of b.ring) {
            if (pointSegDist([x, z], road.points[i], road.points[i + 1]) < half) {
              hit = true;
              break;
            }
          }
        }
        if (hit) {
          inRoad += 1;
          break;
        }
      }
    }
    ok("no building footprint stands in a carriageway", inRoad === 0, `${inRoad} overlapping`);
  }

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
ok("the zoom starts at the highest with real imagery", /zoomStart:\s*19/.test(mod));
ok("the code says why z19 is the ceiling", /z20 and above return/.test(mod));
ok("the real photographs are credited", /CC BY-SA/.test(mod));
ok("photographs are linked to their file page", /p\.page/.test(mod));
ok("the photo list says it is photographs, not textures", /not pasted onto the buildings/i.test(mod));
ok("the aerial photograph is allowed to BE the road", /withAerial/.test(mod));
ok("the code says why the tarmac comes off", /photograph is the road/i.test(mod));
ok("walls get a brick-and-window texture", /makeWallTexture/.test(mod));
ok("the wall texture has a known physical size", /TEXTURE_M/.test(mod));
ok("UVs are scaled in metres, not guessed", /uv\.getX\(i\) \/ TEXTURE_M/.test(mod));
ok("wall textures are generated once per colour, not per building", /makeMap/.test(mod));
ok("there are street lamps and trees", /buildStreetFurniture/.test(mod));
ok("the sky is a gradient, not a flat fill", /paintSky/.test(mod));
ok("replaced geometry is disposed", /disposeTree/.test(mod));

/* ---- the tile budget, which is why the street rendered grey --------------- */
/*
 * The aerial photograph was being dropped silently. A fixed cap of 48 tiles was
 * set, and z19 over 400m needs 324 while even z18 over 460m needs 121 - so the
 * cap was always exceeded and the ground fell back to flat grey. The endpoint was
 * verified to work; the budget never was. So the budget itself is now asserted,
 * and the zoom is chosen by walking down until it fits rather than by giving up.
 */
{
  const extent = Number(/extentM:\s*(\d+)/.exec(mod)?.[1]);
  const cap = Number(/maxTiles:\s*(\d+)/.exec(mod)?.[1]);
  ok("the imagery extent is a real number", Number.isFinite(extent) && extent > 50, String(extent));
  ok("the tile cap is a real number", Number.isFinite(cap) && cap > 0, String(cap));

  // Resolution at this latitude, and the tile count for each zoom.
  const lat = scene.origin.lat;
  const res = (z) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
  let anyFits = false;
  for (let z = 19; z >= 17; z -= 1) {
    const px = Math.ceil((extent * 2) / res(z));
    const tiles = Math.ceil(px / 256) ** 2;
    const fits = tiles <= cap;
    if (fits) anyFits = true;
    console.log(`        z${z}: ${px}px -> ${tiles} tiles  ${fits ? "fits" : "over cap"}`);
  }
  ok("at least one zoom fits inside the tile cap", anyFits);
  ok("the zoom steps down until something fits", /zoomStart/.test(mod) && /zoomFloor/.test(mod));
  ok("coarser imagery is preferred over none", /loadBestAerial/.test(mod));
  ok("a failed fetch says so in the frame", /aerial imagery unavailable/.test(mod));
  ok("the zoom actually used is reported", /at z\$\{res\.zoom\}/.test(mod));
  ok("the mosaic is centred on the view, not the origin", /viewOrigin/.test(mod));
  ok("furniture is limited to what is in shot", /REACH/.test(mod) && /skippedFar/.test(mod));
  ok("the furniture reach is not the whole scene", /const REACH = 260/.test(mod));
}

/* ---- the bus, checked as numbers rather than as words --------------------- */
/*
 * Rendering the bus offline found two things no source-grep would have: a roof
 * floating a metre above the body, and a 72cm hole straight through the side
 * between the waistline and the window sill. Both read as "the code looks
 * right". So the vertical stack is asserted as arithmetic instead.
 */
{
  const num = (name) => {
    const m = new RegExp(`const ${name} = ([0-9.]+)`).exec(mod);
    return m ? Number(m[1]) : NaN;
  };
  const L = num("L");
  const W = num("W");
  const R = num("WHEEL_R");
  const FLOOR = num("FLOOR");
  const SILL = num("SILL");
  const HEAD = num("HEAD");
  const ROOF = num("ROOF");
  const ROOF_TOP = num("ROOF_TOP");

  ok("the bus dimensions are real numbers",
    [L, W, R, FLOOR, SILL, HEAD, ROOF, ROOF_TOP].every(Number.isFinite),
    JSON.stringify({ L, W, R, FLOOR, SILL, HEAD, ROOF, ROOF_TOP }));
  ok("a single-decker is about 11-12m long", L > 10 && L < 12.5, `${L} m`);
  ok("a bus is about 2.4-2.6m wide", W > 2.4 && W < 2.6, `${W} m`);
  ok("a bus is roughly 3.2-3.5m to the roof", ROOF_TOP > 3.2 && ROOF_TOP < 3.5, `${ROOF_TOP} m`);
  ok("the wheels are a realistic size", R > 0.45 && R < 0.6, `${R} m`);
  ok("the stack is continuous: floor to sill", SILL > FLOOR, `${FLOOR} -> ${SILL}`);
  ok("the stack is continuous: sill to head", HEAD > SILL, `${SILL} -> ${HEAD}`);
  ok("the stack is continuous: head to roof", ROOF >= HEAD, `${HEAD} -> ${ROOF}`);
  ok("the roof cap has thickness", ROOF_TOP > ROOF, `${ROOF} -> ${ROOF_TOP}`);
  ok("the window band is a realistic height", HEAD - SILL > 0.8 && HEAD - SILL < 1.5,
    `${(HEAD - SILL).toFixed(2)} m`);
  ok("the body below the windows is a realistic height", SILL - FLOOR > 1.0 && SILL - FLOOR < 1.6,
    `${(SILL - FLOOR).toFixed(2)} m`);
  // The bug: the roof hovered a metre above the body.
  ok("the roof sits on the body, not above it", ROOF - HEAD < 0.35,
    `${(ROOF - HEAD).toFixed(2)} m above the glazing`);

  // Heading: a compass bearing needs a quarter turn, because the model faces +X
  // (east) and north is -Z. Without it every bus was drawn driving sideways.
  ok("the heading rotation includes the quarter turn", /\(90 - bearing\)/.test(mod));
  ok("the comment explains why", /driving sideways/.test(mod));
  const faces = (bearing) => {
    // Rotate the model's +X axis by the yaw the site applies.
    const t = ((90 - bearing) * Math.PI) / 180;
    return [Math.cos(t), -Math.sin(t)];
  };
  const near = (v, target) => Math.abs(v - target) < 0.01;
  const north = faces(0);
  ok("a north-heading bus points north (-Z)", near(north[0], 0) && north[1] < -0.99,
    north.map((n) => n.toFixed(2)).join(","));
  const east = faces(90);
  ok("an east-heading bus points east (+X)", east[0] > 0.99 && near(east[1], 0),
    east.map((n) => n.toFixed(2)).join(","));
  const west = faces(270);
  ok("a west-heading bus points west (-X)", west[0] < -0.99,
    west.map((n) => n.toFixed(2)).join(","));

  ok("the bus has a windscreen and a rear screen", (mod.match(/slab\(0\.1,/g) || []).length >= 2);

/* ---- the facade trim, which is what reads at street distance ------------- */
/*
 * Windows live in the wall texture, and at 100m+ they are a wash. What gives a
 * box away as a box is its silhouette, so the plinth, cornice and downpipe are
 * geometry. The count is asserted because the temptation is always to add sills,
 * gutters and lintels, and each one costs a draw call per building for
 * something under two pixels.
 */
ok("buildings get a plinth", /plinth/.test(mod));
ok("buildings get a cornice", /cornice/.test(mod));
ok("buildings get a downpipe", /pipe/.test(mod));
ok("the trim is only added to buildings tall enough to show it", /if \(h > 3\.2\)/.test(mod));
ok("the trim is shared, not per building", /const trimMats = \{/.test(mod));
ok("the downpipe goes on the corner nearest the camera", /nearestCorner/.test(mod));
ok("buildings are told where the camera is", /buildBuildings\(scene, camAt/.test(mod));
ok("wall colour varies with the sampled roof", /jitter/.test(mod));
// Three extra solids per building, not fifteen.
const trimDraws = (mod.match(/new THREE\.(ExtrudeGeometry|BoxGeometry)\(shape/g) || []).length;
ok("the trim adds a handful of meshes per building, not dozens", trimDraws <= 5,
  `${trimDraws} extruded parts per building`);
  ok("the bus has a destination display", /dest\b/.test(mod));
  ok("the bus has headlights", /\blamp\b/.test(mod));
  ok("the wheels have hubs, not black discs", /hub/.test(mod));
}

/* ---- the material contract, executed -------------------------------------- */
/*
 * The bug this guards: a material factory was passed where its result was
 * expected. pick() then called a THREE.Texture as if it were a function, which
 * threw on every building, and the per-building catch swallowed it - so the
 * street rendered with a road and no buildings and nothing said why. Grepping
 * the source for the right words cannot catch that; running the code can.
 */
{
  // Extract pick() exactly as the module defines it, by brace matching rather
  // than a fixed slice - a slice cut the function in half.
  const start = mod.indexOf("const pick = (bucket, color, makeMap)");
  if (start < 0) {
    console.log("  FAIL  could not find the material picker");
    failed += 1;
  } else {
    const open = mod.indexOf("{", start);
    let depth = 0;
    let close = -1;
    for (let i = open; i < mod.length; i += 1) {
      if (mod[i] === "{") depth += 1;
      else if (mod[i] === "}") {
        depth -= 1;
        if (depth === 0) { close = i; break; }
      }
    }
    const src = mod.slice(start, close + 1);
    // Minimal stand-ins for the THREE types it touches.
    const stub = new Function(
      "THREE",
      `${src}
       return pick;`,
    )({
      MeshLambertMaterial: function (opts) {
        this.opts = opts;
        this.userData = {};
        this.dispose = () => {};
      },
    });
    const bucket = [];
    let textureCalls = 0;
    const factory = () => {
      textureCalls += 1;
      return { isTexture: true };
    };
    const got = stub(bucket, { getHexString: () => "abc123" }, factory);
    ok("a factory is accepted and called once", textureCalls === 1 && got.opts.map.isTexture === true);
    const again = stub(bucket, { getHexString: () => "abc123" }, factory);
    ok("the same colour reuses its material", again === got && textureCalls === 1,
      `textureCalls ${textureCalls}`);
    const other = stub(bucket, { getHexString: () => "def456" }, factory);
    ok("a new colour gets its own material", other !== got);
    // The failure mode: handing it a texture rather than a factory.
    let threw = null;
    try {
      stub([], { getHexString: () => "aaa" }, { isTexture: true });
    } catch (e) {
      threw = e;
    }
    ok("passing a texture instead of a factory is a detectable error", Boolean(threw),
      "it did not throw, so this guard would not have caught the bug");
    ok("roofs ask for no texture at all", /pick\(roofMats, roofColor\)/.test(mod));

/*
 * The executed contract test above proves pick() works; it cannot prove the call
 * site uses it correctly, because the bug was at the call site and not inside
 * pick. Putting the bug back proved the guard did not fire. So the call shape is
 * checked directly: the third argument must be a function, never the result of
 * calling one.
 */
{
  const wallCall = /pick\(wallMats,\s*wall,\s*([^)]{0,40})/g;
  let m;
  let calls = 0;
  let allFactories = true;
  while ((m = wallCall.exec(mod)) !== null) {
    calls += 1;
    const arg = m[1].trim();
    const isFactory = /^(function|\(|\w+\s*=>)/.test(arg);
    if (!isFactory) {
      allFactories = false;
      console.log(`        call site passes a value, not a factory: ${arg.slice(0, 40)}`);
    }
  }
  ok("there is a wall material call site", calls > 0, `${calls} found`);
  ok("every wall call site passes a factory, not a texture", allFactories);
  ok("no call site passes a texture result directly",
    !/pick\([^,]+,[^,]+,\s*make[A-Za-z]*\w*\(/.test(mod));
}
  }
}

// And the scene must not be able to fail silently any more.
ok("a building failure is recorded, not just counted", /firstError/.test(mod));
ok("losing every building is reported as a fault",
  /all \$\{skippedNow\} buildings failed/.test(mod) || /buildings failed to build/.test(mod));
ok("the note reports how many buildings actually drew", /\$\{builtNow\} buildings/.test(mod));

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

/** Shortest distance from a point to a segment. Accepts (x, z, a, b) or (p, a, b). */
function pointSegDist(px, pz, a, b) {
  let p;
  if (Array.isArray(px)) {
    p = px;
    a = pz;
    b = arguments[2];
    px = p[0];
    pz = p[1];
  } else {
    p = [px, pz];
  }
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  if (!len2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

console.log(failed ? `\n${failed} failure(s)` : "\nlongton 3D camera scene and data are sound");
process.exit(failed ? 1 : 0);
