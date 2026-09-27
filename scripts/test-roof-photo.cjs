/*
 * The roofs now carry the real aerial photograph, and the UVs are computed
 * rather than eyeballed - so they are checked.
 *
 * The risk being guarded: the roof UVs are derived from local metres through a
 * mercator projection, and if that chain is wrong the roofs wear a photograph of
 * somewhere else. Nothing about the code would look wrong.
 */
const fs = require("fs");

const mod = fs.readFileSync("src/longton-camera-3d.js", "utf8");
const scene = JSON.parse(fs.readFileSync("longton-scene.generated.json", "utf8"));

function extract(name) {
  const start = mod.search(new RegExp(`^(export )?(async )?function ${name}\\b`, "m"));
  if (start < 0) throw new Error(`${name} not found`);
  const close = /\r?\n\}\r?\n/g;
  close.lastIndex = start;
  const m = close.exec(mod);
  return mod.slice(start, m.index + m[0].length);
}

// The module's own helpers, with a tile size and zoom we choose here.
const IMAGERY = { tile: 256, zoomStart: 19, zoomFloor: 17, extentM: 300, maxTiles: 64 };
const api = new Function(
  "IMAGERY",
  `const mercatorPx = ${extract("mercatorPx")};
   const latLonFrom = ${extract("latLonFrom")};
   const tileCountFor = ${extract("tileCountFor")};
   const aerialPlanFor = ${extract("aerialPlanFor")};
   const aerialUv = ${extract("aerialUv")};
   return { mercatorPx, latLonFrom, tileCountFor, aerialPlanFor, aerialUv };`,
)(IMAGERY);

let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
};

const origin = scene.origin;
const cam = scene.camera;
const mLon = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
const midX = (cam.at[0] + cam.towards[0]) / 2;
const midZ = (cam.at[1] + cam.towards[1]) / 2;
const viewOrigin = { lat: origin.lat - midZ / 111_320, lon: origin.lon + midX / mLon };

const plan = api.aerialPlanFor(viewOrigin);
ok("a plan is produced", Boolean(plan));
console.log(`        plan: z${plan.zoom}, ${plan.cols}x${plan.rows} tiles, mosaic ${plan.uv.w}x${plan.uv.h} px`);

// The whole point: a roof's UVs must land on the same part of the mosaic as the
// ground pixel directly below it.
{
  const ground = api.aerialUv(plan, midX, midZ);
  ok("the view centre is inside the mosaic",
    ground[0] > 0 && ground[0] < 1 && ground[1] > 0 && ground[1] < 1,
    ground.map((n) => n.toFixed(3)).join(","));
}

const near = scene.buildings.filter((b) =>
  b.ring.some(([x, z]) => Math.hypot(x - cam.at[0], z - cam.at[1]) < 200),
);
const centroid = (b) => [
  b.ring.reduce((s, p) => s + p[0], 0) / b.ring.length,
  b.ring.reduce((s, p) => s + p[1], 0) / b.ring.length,
];

// Every roof in the view must map inside the mosaic, and nearby buildings must
// get different UVs - otherwise the whole street is wearing one roof.
{
  let outside = 0;
  const distinct = new Set();
  for (const b of near) {
    for (const [x, z] of b.ring) {
      const [u, v] = api.aerialUv(plan, x, z);
      if (u < -0.01 || u > 1.01 || v < -0.01 || v > 1.01) outside += 1;
    }
    // By centroid, not by ring[0]: terraced houses genuinely share OSM nodes,
    // so two of them can start on the same point without anything being wrong.
    const [cx, cz] = centroid(b);
    distinct.add(api.aerialUv(plan, cx, cz).map((n) => n.toFixed(4)).join(","));
  }
  ok("roofs near the camera are inside the mosaic", outside === 0,
    `${outside} vertices outside, of ${near.length} buildings`);
  ok("neighbouring buildings get different parts of the photograph",
    distinct.size === near.length,
    `${distinct.size} distinct UVs for ${near.length} buildings`);
}

// A known building, checked by round trip: roof UV -> mosaic pixel -> lat/lon
// should come back to the same spot.
//
// The inverse has to match the module's mercator, which is LOCAL - measured from
// the view origin, not from lon 0. Inverting it as a global Web Mercator put
// the answer 12,552 km away, which is a good illustration of how a projection
// test can be wrong in a way that looks like a real failure.
{
  const [x, z] = centroid(near[0]);
  const [u, v] = api.aerialUv(plan, x, z);
  const px = u * plan.uv.w + plan.uv.minX;
  const py = (1 - v) * plan.uv.h + plan.uv.minY;
  const n = 2 ** plan.zoom;
  const T = IMAGERY.tile;
  // Inverse of worldX = ((lon - o.lon) / 360) * n * T
  const lon = plan.origin.lon + (px / (n * T)) * 360;
  // Inverse of worldY = (-ln(tan+sec) / 2pi) * n * T
  const lat = (Math.atan(Math.sinh(-(py / (n * T)) * 2 * Math.PI)) * 180) / Math.PI;
  const back = api.latLonFrom(plan.origin, x, z);
  const errM = Math.hypot((lon - back.lon) * mLon, (lat - back.lat) * 111_320);
  ok("a roof UV round-trips back to its own coordinates", errM < 1,
    `off by ${errM.toFixed(2)} m`);
}

ok("the roof material is a single shared one", /trimMats\.roofPhoto/.test(mod));
ok("the one texture is shared by ground and roofs", /roofPhoto\.map = res\.texture/.test(mod));
ok("the plan is worked out before any tile is fetched", /aerialPlanFor\(viewOrigin\)/.test(mod));
ok("roofs still fall back to a flat colour", /roofMaterial \|\| pick\(roofMats, roofColor\)/.test(mod));

console.log(failed ? `\n${failed} failure(s)` : "\nroof photographs land on the right pixels");
process.exit(failed ? 1 : 0);
