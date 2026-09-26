/**
 * Build the 3D scene for the Longton virtual camera.
 *
 * Fetches real geometry from OpenStreetMap via Overpass and writes a compact
 * scene file the browser can render directly: a ground plane, road ribbons with
 * widths, and extruded building footprints.
 *
 * WHY THIS IS A SEPARATE, COMMITTED STEP
 * Overpass is a shared free service and is frequently overloaded - it answered
 * 504 on two of three mirrors while this was being built. If the browser asked
 * for geometry on every page load, the camera would be down whenever Overpass
 * was. So the geometry is fetched once, here, and committed. The scene file
 * records where it came from and when, so a stale scene is obvious.
 *
 * WHY THE COORDINATES ARE WHAT THEY ARE
 * The first attempt used 53.0443,-2.1068 for "Longton town centre" and found
 * almost nothing: that point is 6.6km from Longton, out in open country. The
 * position is taken from our own stops table instead - Longton Exchange, the
 * busiest stop in town with 16 services through it, at 52.988038,-2.137064.
 * Deriving it from data we already hold rather than a guess is the whole lesson.
 *
 * Run: node scripts/fetch-longton-scene.mjs [--out path]
 */
import { writeFileSync } from "node:fs";

/** Longton Exchange. Sourced from data/stops, not typed from memory. */
export const SCENE_ORIGIN = { lat: 52.988038, lon: -2.137064 };

/** Roughly 1.1km x 1.1km, enough to fill a fixed camera view down The Strand. */
const BBOX = { south: 52.9830, west: -2.1430, north: 52.9930, east: -2.1310 };

/** Metres of road width per OSM highway type. Visual only, not a survey. */
const ROAD_WIDTH = {
  primary: 13,
  primary_link: 8,
  secondary: 11,
  secondary_link: 7,
  tertiary: 9,
  tertiary_link: 6,
  residential: 7.5,
  unclassified: 7,
  living_street: 6,
  service: 4.5,
  pedestrian: 6,
  footway: 2.5,
  path: 2,
  cycleway: 2.5,
  trunk: 13,
  trunk_link: 8,
};

/**
 * Fallback building heights in metres when OSM has no levels or height.
 * Terraced housing through a Victorian market town is mostly two or three
 * storeys; the shops on the Strand are taller at the front.
 */
const BUILDING_HEIGHT = {
  retail: 9,
  commercial: 11,
  office: 14,
  industrial: 8,
  warehouse: 9,
  church: 12,
  school: 8,
  garage: 5,
  house: 7.5,
  residential: 7.5,
  default: 8,
};
const LEVEL_HEIGHT = 3.2;

const OVERPASS_HOSTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

function metresPerDegreeLat() {
  return 111_320;
}

function metresPerDegreeLon(lat) {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

/**
 * Local metres from the scene origin. Equirectangular is accurate to well under a
 * metre over a 1km scene, which is far finer than anything rendered here.
 */
function project(lat, lon, origin) {
  return {
    x: (lon - origin.lon) * metresPerDegreeLon(origin.lat),
    // North is -Z in Three.js, so southwards is positive.
    z: -(lat - origin.lat) * metresPerDegreeLat(),
  };
}

function buildingHeight(tags) {
  const h = Number(tags.height);
  if (Number.isFinite(h) && h > 1 && h < 120) return h;
  const levels = Number(tags["building:levels"] || tags["levels"]);
  if (Number.isFinite(levels) && levels > 0 && levels < 40) return levels * LEVEL_HEIGHT;
  const kind = String(tags.building || "").toLowerCase();
  return BUILDING_HEIGHT[kind] ?? BUILDING_HEIGHT.default;
}

async function fetchOverpass() {
  const query = `[out:json][timeout:180];(way["building"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});way["highway"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}););out geom tags;`;
  let lastError = "";
  for (const host of OVERPASS_HOSTS) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await fetch(host, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "uk-bus-tracker/1.0 (Longton virtual camera scene)",
          },
          body: new URLSearchParams({ data: query }).toString(),
        });
        if (!res.ok) {
          lastError = `${host} -> HTTP ${res.status}`;
          console.log(`  ${lastError}, trying the next mirror`);
          continue;
        }
        const body = await res.json();
        const n = body?.elements?.length || 0;
        // A 200 with a handful of elements is Overpass having given up
        // quietly, not a useful scene. Treat it as a failure and keep trying.
        if (n < 100) {
          lastError = `${host} -> only ${n} elements`;
          console.log(`  ${lastError}, treating as a failed fetch`);
          continue;
        }
        console.log(`  ${host} -> ${n} elements`);
        return body;
      } catch (err) {
        lastError = `${host} -> ${err.message}`;
        console.log(`  ${lastError}, trying the next mirror`);
      }
    }
  }
  throw new Error(`no Overpass mirror returned a usable scene: ${lastError}`);
}

function buildScene(geo) {
  const origin = SCENE_ORIGIN;
  const roads = [];
  const buildings = [];
  const namedRoads = {};

  for (const el of geo.elements || []) {
    const tags = el.tags || {};
    const geom = el.geometry || [];
    if (geom.length < 2) continue;

    if (tags.highway) {
      const width = ROAD_WIDTH[tags.highway] ?? 6;
      // Drop the tiny alleyways and paths: they are invisible from a camera on
      // the Strand and they triple the geometry count.
      if (width < 2.6) continue;
      const points = geom
        .map((p) => project(p.lat, p.lon, origin))
        .map((p) => [round(p.x), round(p.z)]);
      if (points.length < 2) continue;
      roads.push({
        type: tags.highway,
        width,
        name: tags.name || "",
        oneway: tags.oneway === "yes" ? 1 : 0,
        points,
      });
      if (tags.name) namedRoads[tags.name] = (namedRoads[tags.name] || 0) + points.length;
    } else if (tags.building && tags.building !== "no") {
      const ring = geom.map((p) => project(p.lat, p.lon, origin));
      if (ring.length < 3) continue;
      buildings.push({
        kind: String(tags.building || "yes"),
        height: round(buildingHeight(tags), 1),
        name: tags.name || tags["addr:housename"] || "",
        ring: ring.map((p) => [round(p.x), round(p.z)]),
      });
    }
  }

  // The camera looks down The Strand, the main street through the town centre.
  // Find it from the fetched data rather than hard-coding a point, so the camera
  // follows the road if OSM renames or resegments it.
  const strand = roads.filter((r) => r.name === "The Strand");
  const fallback = roads.filter((r) => r.type === "primary");
  const chain = chainOf(strand.length ? strand : fallback);
  const view = chain.length >= 2 ? viewDownStreet(chain) : null;

  return {
    generated: new Date().toISOString(),
    source: "OpenStreetMap via Overpass API (ODbL)",
    origin,
    bbox: BBOX,
    counts: { roads: roads.length, buildings: buildings.length },
    camera: view,
    roads,
    buildings,
  };
}

function dist(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/**
 * Stitch a road's separate OSM ways into one continuous run along the street.
 *
 * OSM splits a street into many short ways and does not return them in order, so
 * the obvious approach - concatenate them all - is wrong: it produces a chain
 * with 100m jumps between unrelated fragments, and "25m along the chain" then
 * lands in a side street or a garden. An earlier version did exactly that and put
 * the camera 17.8m off the tarmac, pointed at a wall.
 *
 * Instead, walk the street properly. Repeatedly take whichever unused way has an
 * end within JOIN_TOLERANCE of where the path currently finishes. Whatever run
 * comes out is genuinely contiguous road, so a point N metres along it is N
 * metres along the street.
 */
const JOIN_TOLERANCE = 18;

function chainOf(ways) {
  if (!ways.length) return [];
  const unused = ways.map((w) => w.points.slice());

  // Start from the end closest to the town centre, so the run begins in the
  // middle of town rather than out at the edge of the scene.
  let start = null;
  let bestD = Infinity;
  for (const pts of unused) {
    for (const end of [pts[0], pts[pts.length - 1]]) {
      const d = Math.hypot(end[0], end[1]);
      if (d < bestD) {
        bestD = d;
        start = { end, pts };
      }
    }
  }
  if (!start) return [];

  const take = start.pts[0][0] === start.end[0] && start.pts[0][1] === start.end[1]
    ? start.pts.slice()
    : start.pts.slice().reverse();
  unused.splice(unused.indexOf(start.pts), 1);

  // Grow the path for as long as a neighbouring way can be found.
  for (;;) {
    const tail = take[take.length - 1];
    let pick = -1;
    let pickForward = true;
    let pickD = Infinity;
    for (let i = 0; i < unused.length; i += 1) {
      const pts = unused[i];
      const dStart = dist(tail, pts[0]);
      const dEnd = dist(tail, pts[pts.length - 1]);
      const d = Math.min(dStart, dEnd);
      if (d <= JOIN_TOLERANCE && d < pickD) {
        pick = i;
        pickForward = dStart <= dEnd;
        pickD = d;
      }
    }
    if (pick < 0) break;
    const pts = unused.splice(pick, 1)[0];
    const oriented = pickForward ? pts : pts.slice().reverse();
    // The shared endpoint is the same point in both; do not duplicate it.
    take.push(...oriented.slice(1));
  }
  return take;
}

/** Stand the camera a little into the street and look along it. */
function viewDownStreet(points) {
  const total = points.reduce((sum, p, i) => (i ? sum + dist(points[i - 1], p) : 0), 0);
  if (total < 60) return { at: points[0], towards: points[points.length - 1], along: points, lengthM: round(total, 0) };
  const walk = (want) => {
    let run = 0;
    for (let i = 1; i < points.length; i += 1) {
      const step = dist(points[i - 1], points[i]);
      if (run + step >= want) {
        const t = step ? (want - run) / step : 0;
        return [
          points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t,
          points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t,
        ];
      }
      run += step;
    }
    return points[points.length - 1];
  };
  return {
    // 25m in, so the camera is past the kerb rather than in the road, looking
    // at the far end. A real camera on a street sees a few hundred metres.
    at: walk(25).map((n) => round(n, 2)),
    towards: walk(total).map((n) => round(n, 2)),
    along: points,
    lengthM: round(total, 0),
  };
}

function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

const outIndex = process.argv.indexOf("--out");
const outPath =
  outIndex > -1 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : new URL("../longton-scene.generated.json", import.meta.url);

console.log(`fetching OSM geometry for Longton (${BBOX.south},${BBOX.west} - ${BBOX.north},${BBOX.east})`);
const geo = await fetchOverpass();
const scene = buildScene(geo);

if (!scene.roads.length) throw new Error("no usable roads in the response");
if (!scene.buildings.length) throw new Error("no usable buildings in the response");
if (!scene.camera) throw new Error("could not work out where to point the camera");

const { writeFileSync: write } = await import("node:fs");
write(outPath, `${JSON.stringify(scene)}\n`);
console.log(
  `wrote ${scene.counts.roads} roads and ${scene.counts.buildings} buildings -> ${outPath.pathname || outPath}`,
);
console.log(`camera stands at ${JSON.stringify(scene.camera.at)} looking towards ${JSON.stringify(scene.camera.towards)}`);
