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

  // The camera looks along The Strand, the main street through the town centre,
  // from beside Longton Exchange - the bus station where 16 services converge,
  // so it is the one spot in town where buses are certain to pass. Found from
  // the fetched data rather than hard-coded, so it follows the road if OSM
  // renames or resegments it.
  const strand = roads.filter((r) => r.name === "The Strand");
  const fallback = roads.filter((r) => r.type === "primary");
  const chain = chainOf(strand.length ? strand : fallback);
  const view = chain.length >= 2 ? viewTowardExchange(chain, origin) : null;

  /*
   * Drop buildings that stand in the carriageway.
   *
   * Rendering the scene showed two buildings 1m and 2m from the camera's sight
   * line, filling half the frame. Their mapped footprints reach across the road:
   * the camera stands on the centreline of a 13m carriageway, so anything whose
   * footprint gets within the road's own half-width is either mis-mapped or a
   * building recorded before the road was laid out. Extruded as given, it becomes
   * a wall in the middle of the street.
   *
   * A wall correctly positioned ON the kerb is at the half-width and is kept -
   * that is a building that should be there. Only footprints that genuinely
   * reach inside the carriageway go.
   */
  const corridors = roads.filter(
    (r) => r.type !== "service" && r.type !== "footway" && r.type !== "path" && r.type !== "pedestrian",
  );
  let overlapping = 0;
  const kept = [];
  for (const b of buildings) {
    let inside = false;
    for (const road of corridors) {
      const half = road.width / 2 - 0.5;
      for (let i = 0; i < road.points.length - 1 && !inside; i += 1) {
        for (const p of b.ring) {
          if (pointSegDist(p, road.points[i], road.points[i + 1]) < half) {
            inside = true;
            break;
          }
        }
      }
      if (inside) break;
    }
    if (inside) {
      overlapping += 1;
      continue;
    }
    kept.push(b);
  }
  if (overlapping) {
    console.log(`  dropped ${overlapping} building(s) whose footprints stand in the carriageway`);
  }

  return {
    generated: new Date().toISOString(),
    source: "OpenStreetMap via Overpass API (ODbL)",
    imagery: "Esri World Imagery (aerial roof colours)",
    origin,
    bbox: BBOX,
    counts: { roads: roads.length, buildings: kept.length, droppedOverlapping: overlapping },
    camera: view,
    roads,
    buildings: kept,
  };
}

/** Shortest distance from a point to a line segment. */
function pointSegDist(p, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  if (!l2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

/**
 * Stand the camera on the street a short way back from the Exchange, looking at
 * it, so buses pulling in and turning are in shot.
 *
 * The Exchange is the scene origin, taken from our stops table, so "the point on
 * the street nearest the origin" is the kerb outside the bus station without
 * anyone typing a coordinate.
 */
/**
 * How far up the street to stand from the Exchange.
 *
 * 42m put the camera close enough that the shot was just the bus station and a
 * shelter. 170m puts a length of The Strand in frame with the Exchange at the
 * far end, which is the composition a real camera covering a bus station would
 * have: you see the approach and the stand.
 */
const STAND_BACK_M = 170;
/**
 * How far from the centreline the camera stands. The Strand is 13m wide, so its
 * kerb is 6.5m out; 9m puts the camera on the footway, inboard of the buildings.
 */
const KERB_OFFSET_M = 9;

function viewTowardExchange(points, origin) {
  // Nearest point on the chain to the scene origin.
  let bestI = 0;
  let bestD = Infinity;
  points.forEach(([x, z], i) => {
    const d = Math.hypot(x, z);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  });
  const at = points[bestI];
  if (!at) return null;

  /*
   * Stand STAND_BACK_M further along the street from the Exchange, and look back
   * at it.
   *
   * Walking *backwards* from the Exchange does not work, and did not: chainOf
   * deliberately starts the chain at whichever end is nearest the scene origin,
   * which is the Exchange, so the nearest point is index 0 and there is nothing
   * behind it to walk into. The camera ended up 14m from its target, filming a
   * bus shelter. So it goes forwards along the chain and turns to face back.
   */
  const segLen = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  let budget = STAND_BACK_M;
  let atPoint = at;
  // Which chain segment we ended up on, so the kerb offset can use that
  // segment's direction of travel.
  let standIndex = bestI;
  for (let i = bestI; i < points.length - 1 && budget > 0; i += 1) {
    const len = segLen(points[i], points[i + 1]);
    if (len <= 0) continue;
    if (len >= budget) {
      // Part of the way along this segment.
      const t = budget / len;
      atPoint = [
        points[i][0] + (points[i + 1][0] - points[i][0]) * t,
        points[i][1] + (points[i + 1][1] - points[i][1]) * t,
      ];
      standIndex = i;
      budget = 0;
      break;
    }
    budget -= len;
    standIndex = i + 1;
    atPoint = points[i + 1];
  }

  const lengthM = points.reduce((sum, p, i) => (i ? sum + dist(points[i - 1], p) : 0), 0);

  /*
   * Stand at the kerb, not in the middle of the road.
   *
   * Dead centre on a 13m carriageway puts the buildings on both sides equally in
   * the way: rendering the scene showed a 9m retail block 8m from the camera
   * filling half the frame, with two more 1-2m off the sight line. A real camera
   * covering a bus station is on a bracket at the edge of the footway, not in the
   * traffic. Offsetting to the kerb and angling back along the street is both more
   * realistic and a much better composition.
   */
  const aheadIdx = Math.min(standIndex + 1, points.length - 1);
  const dirX = points[aheadIdx][0] - atPoint[0];
  const dirZ = points[aheadIdx][1] - atPoint[1];
  const dirLen = Math.hypot(dirX, dirZ) || 1;
  // Left-hand normal of the direction of travel: the near-side pavement.
  const kerb = [atPoint[0] - (dirZ / dirLen) * KERB_OFFSET_M, atPoint[1] + (dirX / dirLen) * KERB_OFFSET_M];

  return {
    at: [round(kerb[0], 2), round(kerb[1], 2)],
    towards: [round(at[0], 2), round(at[1], 2)],
    along: points,
    lengthM: round(lengthM, 0),
    standBackM: round(Math.hypot(kerb[0] - at[0], kerb[1] - at[1]), 0),
    kerbOffsetM: KERB_OFFSET_M,
    looksAt: "Longton Exchange",
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

/**
 * Sample the real roof colour of each building from Esri aerial imagery.
 *
 * A model painted in invented colours is the giveaway that it is a model. The
 * aerial photograph already knows what colour every roof in Longton actually is,
 * so read it: fetch the z19 tile over each roof, take the pixel at the centroid,
 * and store it. The 3D buildings then wear the colour of the real roof they
 * stand where.
 *
 * This is a rooftop sample from a near-vertical photograph, so it cannot see
 * walls - walls keep their by-use palette. z20 and above return a 2.5KB blank
 * tile for this area, so z19 is the highest useful zoom and is what the ground
 * texture uses too.
 */
const IMAGERY_ZOOM = 19;
const IMAGERY_TILE = 256;
const IMAGERY_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

function mercatorPx(lat, lon, zoom) {
  const n = 2 ** zoom;
  const x = ((lon + 180) / 360) * n * IMAGERY_TILE;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * IMAGERY_TILE;
  return { x, y };
}

async function fetchTile(z, col, row) {
  const key = `${z}/${col}/${row}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const url = IMAGERY_URL.replace("{z}", String(z)).replace("{x}", String(col)).replace("{y}", String(row));
  const promise = (async () => {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "uk-bus-tracker/1.0 (Longton scene)" } });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      // 2.5KB is Esri's "no imagery here" placeholder, not a real tile.
      if (buf.length < 4000) return null;
    const { default: sharp } = await import("sharp");
    const { data, info } = await sharp(buf)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { data, w: info.width, h: info.height };
    } catch {
      return null;
    }
  })();
  tileCache.set(key, promise);
  return promise;
}

const tileCache = new Map();

/** Mean colour of a small patch, so one shadowed pixel does not decide a roof. */
function samplePatch(tile, px, py, radius = 3) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = Math.round(px) + dx;
      const y = Math.round(py) + dy;
      if (x < 0 || y < 0 || x >= tile.w || y >= tile.h) continue;
      const i = (y * tile.w + x) * 3;
      r += tile.data[i];
      g += tile.data[i + 1];
      b += tile.data[i + 2];
      n += 1;
    }
  }
  if (!n) return null;
  const hex = (v) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

async function sampleRoofColours(buildings, origin) {
  const mLon = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  let done = 0;
  let got = 0;
  for (const b of buildings) {
    b.roofColour = null;
    // Footprint centroid in local metres, then back to lat/lon.
    let sx = 0;
    let sz = 0;
    for (const [x, z] of b.ring) {
      sx += x;
      sz += z;
    }
    const lat = origin.lat - sz / b.ring.length / 111_320;
    const lon = origin.lon + sx / b.ring.length / mLon;
    const p = mercatorPx(lat, lon, IMAGERY_ZOOM);
    const col = Math.floor(p.x / IMAGERY_TILE);
    const row = Math.floor(p.y / IMAGERY_TILE);
    const tile = await fetchTile(IMAGERY_ZOOM, col, row);
    done += 1;
    if (!tile) continue;
    const colour = samplePatch(tile, p.x - col * IMAGERY_TILE, p.y - row * IMAGERY_TILE);
    if (colour) {
      b.roofColour = colour;
      got += 1;
    }
  }
  return { done, got };
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

// Read the real roof colour of every building off the aerial photography.
console.log(`sampling real roof colours from Esri imagery at z${IMAGERY_ZOOM}...`);
const roof = await sampleRoofColours(scene.buildings, scene.origin);
console.log(`  ${roof.got} of ${roof.done} buildings got a colour from the aerial photo`);
scene.counts.roofColours = roof.got;
if (!scene.camera) throw new Error("could not work out where to point the camera");

const { writeFileSync: write } = await import("node:fs");
write(outPath, `${JSON.stringify(scene)}\n`);
console.log(
  `wrote ${scene.counts.roads} roads and ${scene.counts.buildings} buildings -> ${outPath.pathname || outPath}`,
);
console.log(`camera stands at ${JSON.stringify(scene.camera.at)} looking towards ${JSON.stringify(scene.camera.towards)}`);
