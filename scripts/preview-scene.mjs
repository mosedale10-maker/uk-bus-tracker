/*
 * Render the Longton 3D camera's view to a PNG, offline.
 *
 * There is still no browser attached to this session, so the in-page view cannot
 * be looked at. This draws the same scene from the same camera the page uses,
 * reading the same scene file, and - importantly - puts the real Esri aerial
 * photograph on the ground by inverse-projecting every pixel onto the ground
 * plane and sampling the tile mosaic there. So the road, the roofs and the
 * verges are the actual photography of Longton; the walls and the buses are the
 * model.
 *
 * What it cannot show: tone mapping, real shadows, the wall textures, and the
 * fact that the page's ground mosaic is centred on the view.
 *
 * Run: node scripts/preview-scene.mjs [outfile.png]
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";

const scene = JSON.parse(readFileSync("longton-scene.generated.json", "utf8"));
const origin = scene.origin;
const cam = scene.camera;
const EYE_H = 6.5;
const FOV = 52;
const W = 1400;
const H = 800;
const M_LAT = 111_320;
const mLonFor = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);

const ZOOM = 18;
const TILE = 256;
const TILES = [
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
];

/* ---- scene metres <-> lat/lon <-> mercator pixels ------------------------- */

const fromOrigin = (x, z) => ({ lat: origin.lat - z / M_LAT, lon: origin.lon + x / mLonFor(origin.lat) });
const toOrigin = (lat, lon) => ({
  x: (lon - origin.lon) * mLonFor(origin.lat),
  z: -(lat - origin.lat) * M_LAT,
});
const merc = (lat, lon) => {
  const n = 2 ** ZOOM;
  const r = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n * TILE,
    y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * TILE,
  };
};

/* ---- camera --------------------------------------------------------------- */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v) => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const eye = [cam.at[0], EYE_H, cam.at[1]];
const fwd = norm([cam.towards[0] - eye[0], 1.5 - eye[1], cam.towards[1] - eye[2]]);
const right = norm(cross(fwd, [0, 1, 0]));
const up = cross(right, fwd);
const focal = 1 / Math.tan((FOV * Math.PI) / 360);

function project(p) {
  const d = sub(p, eye);
  const z = dot(d, fwd);
  if (z <= 0.15) return null;
  return {
    x: W / 2 + (dot(d, right) * focal * W) / (2 * z),
    y: H / 2 - (dot(d, up) * focal * H) / (2 * z),
    z,
  };
}

/* ---- the bus, from the module itself -------------------------------------- */

const mod = readFileSync("src/longton-camera-3d.js", "utf8");
function extract(name) {
  const start = mod.search(new RegExp(`^(export )?(async )?function ${name}\\b`, "m"));
  if (start < 0) throw new Error(`${name} not found`);
  const close = /\r?\n\}\r?\n/g;
  close.lastIndex = start;
  const m = close.exec(mod);
  return mod.slice(start, m.index + m[0].length);
}
const THREE = {
  // These must be constructible: the module does `new THREE.Group()`.
  Group: function () {
    this.children = [];
    this.userData = {};
    this.add = (x) => { this.children.push(x); return this; };
  },
  Mesh: function (geometry, material) {
    this.geometry = geometry;
    this.material = material;
    this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
    this.rotation = { x: 0, y: 0, z: 0 };
  },
  BoxGeometry: function (w, h, d) { this.kind = "box"; this.w = w; this.h = h; this.d = d; },
  CylinderGeometry: function (rt, rb, h, seg) { this.kind = "cyl"; this.rt = rt; this.rb = rb; this.h = h; this.seg = seg; },
  Color: function (hex) {
    if (hex instanceof THREE.Color) this.rgb = hex.rgb.slice();
    else if (typeof hex === "number") this.rgb = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
    else if (typeof hex === "string" && hex.startsWith("#")) {
      this.rgb = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    } else this.rgb = [200, 16, 46];
  },
};
// Materials must be constructible too, and must convert a raw hex number into a
// Color the way the real classes do.
const mat = () =>
  function Material(opts) {
    this.color = new THREE.Color(opts.color);
  };
THREE.MeshLambertMaterial = mat();
THREE.MeshBasicMaterial = mat();
const buildBusMesh = new Function("THREE", `${extract("buildBusMesh")}\nreturn buildBusMesh;`)(THREE);

const busGroup = buildBusMesh({ colour: "#c8102e" });
const busParts = [];
(function walk(n) {
  for (const c of n.children) {
    if (c.geometry) busParts.push({ geo: c.geometry, pos: c.position, colour: c.material.color });
    if (c.children) walk(c);
  }
})(busGroup);

/* ---- bus where the real feed says a bus is ------------------------------- */
/*
 * Two representative buses, placed on The Strand at plausible positions and
 * bearings, so the picture shows scale against the street rather than a bus in
 * isolation. Positions are along the camera's own line of sight.
 */
const fwdFlat = norm([fwd[0], 0, fwd[2]]);
const rightFlat = [fwdFlat[2], 0, -fwdFlat[0]];
const place = (ahead, across) => [
  eye[0] + fwdFlat[0] * ahead + rightFlat[0] * across,
  0,
  eye[2] + fwdFlat[2] * ahead + rightFlat[2] * across,
];
const BUSES = [
  { at: place(46, -3.2), bearing: 178, colour: "#c8102e" },
  { at: place(96, 3.4), bearing: 182, colour: "#1b3a6b" },
];

/* ---- rasteriser ----------------------------------------------------------- */

const buf = Buffer.alloc(W * H * 3);
const LIGHT = norm([0.45, 0.82, 0.35]);
/*
 * Flat shading with a generous ambient term. The site uses a hemisphere light as
 * well as the sun, so faces pointing away from the sun are not black there; a
 * lower floor here made every wall read as a silhouette and hid the roof colours
 * the scene generator had gone to the trouble of sampling from the aerial photo.
 */
const shade = (n, c) => {
  const l = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  // Sky above, bounce from the ground below, plus the sun.
  const sky = Math.max(0, n[1]) * 0.34;
  const bounce = Math.max(0, -n[1]) * 0.12;
  const k = 0.5 + 0.42 * l + sky + bounce;
  return [
    Math.min(255, c[0] * k),
    Math.min(255, c[1] * k),
    Math.min(255, c[2] * k),
  ];
};
const put = (x, y, c) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
};

function fillPoly(pts, colour) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const x0 = Math.max(0, Math.floor(minX));
  const x1 = Math.min(W - 1, Math.ceil(maxX));
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(H - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i];
        const b = pts[j];
        if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      if (inside) put(x, y, colour);
    }
  }
}

/* ---- the real aerial photograph, fetched the same way the page does ------- */

const tileCache = new Map();
async function getTile(col, row) {
  const key = `${col}/${row}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const p = (async () => {
    try {
      const url = TILES[0].replace("{z}", String(ZOOM)).replace("{x}", String(col)).replace("{y}", String(row));
      const res = await fetch(url, { headers: { "User-Agent": "uk-bus-tracker/1.0 (preview)" } });
      if (!res.ok) return null;
      const b = Buffer.from(await res.arrayBuffer());
      if (b.length < 4000) return null;
      const { data, info } = await sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data, w: info.width, h: info.height };
    } catch {
      return null;
    }
  })();
  tileCache.set(key, p);
  return p;
}

async function groundColour(x, z) {
  const ll = fromOrigin(x, z);
  const m = merc(ll.lat, ll.lon);
  const col = Math.floor(m.x / TILE);
  const row = Math.floor(m.y / TILE);
  const t = await getTile(col, row);
  if (!t) return [70, 74, 80];
  const px = Math.round(m.x - col * TILE);
  const py = Math.round(m.y - row * TILE);
  const i = (py * t.w + px) * 3;
  return [t.data[i], t.data[i + 1], t.data[i + 2]];
}

console.log(`camera at ${cam.at}, looking at ${cam.towards}, eye ${EYE_H} m`);
console.log(`fetching aerial tiles at z${ZOOM}...`);

// Sky, then the ground by inverse projection: for every pixel, cast a ray,
// find where it meets y = 0, and sample the photograph there.
{
  for (let y = 0; y < H; y += 1) {
    const t = y / H;
    const sky = [Math.round(126 + 70 * t), Math.round(158 + 48 * t), Math.round(196 + 8 * t)];
    for (let x = 0; x < W; x += 1) put(x, y, sky);
  }
}

const tilesNeeded = new Set();
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    // Ray through this pixel.
    const ndcX = (x + 0.5 - W / 2) / (focal * W / 2);
    const ndcY = -(y + 0.5 - H / 2) / (focal * H / 2);
    const dir = norm([
      fwd[0] + right[0] * ndcX + up[0] * ndcY,
      fwd[1] + right[1] * ndcX + up[1] * ndcY,
      fwd[2] + right[2] * ndcX + up[2] * ndcY,
    ]);
    if (dir[1] >= -0.001) continue; // above the horizon: sky
    const t = -eye[1] / dir[1];
    if (t <= 0 || t > 4000) continue;
    const gx = eye[0] + dir[0] * t;
    const gz = eye[2] + dir[2] * t;
    const ll = fromOrigin(gx, gz);
    const m = merc(ll.lat, ll.lon);
    tilesNeeded.add(`${Math.floor(m.x / TILE)}/${Math.floor(m.y / TILE)}`);
  }
}
console.log(`  ${tilesNeeded.size} tiles cover the view`);
await Promise.all([...tilesNeeded].map((k) => getTile(k.split("/")[0], k.split("/")[1])));

for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const ndcX = (x + 0.5 - W / 2) / (focal * W / 2);
    const ndcY = -(y + 0.5 - H / 2) / (focal * H / 2);
    const dir = norm([
      fwd[0] + right[0] * ndcX + up[0] * ndcY,
      fwd[1] + right[1] * ndcX + up[1] * ndcY,
      fwd[2] + right[2] * ndcX + up[2] * ndcY,
    ]);
    if (dir[1] >= -0.001) continue;
    const t = -eye[1] / dir[1];
    if (t <= 0 || t > 4000) continue;
    const gx = eye[0] + dir[0] * t;
    const gz = eye[2] + dir[2] * t;
    // Aerial photography is a fixed capture: it is daylight, always, whatever
    // the hour. Darken it towards dusk so it does not read as midday at night.
    const hour = 15;
    const dim = hour < 7 || hour >= 19 ? 0.35 : 1;
    const c = await groundColour(gx, gz);
    put(x, y, [c[0] * dim, c[1] * dim, c[2] * dim]);
  }
}
console.log("ground done");

/* ---- objects, painter's algorithm ---------------------------------------- */

const faces = [];
const addFace = (world, normal, colour) => {
  const pts = world.map(project);
  if (pts.some((p) => !p)) return;
  faces.push({ pts, depth: pts.reduce((s, p) => s + p.z, 0) / pts.length, colour: shade(normal, colour) });
};

// Buildings: walls then roof, roof using the colour sampled from the real photo.
for (const b of scene.buildings) {
  const ring = b.ring;
  const h = b.height;
  const inView = ring.some(([x, z]) => {
    const d = Math.hypot(x - eye[0], z - eye[2]);
    return d < 400;
  });
  if (!inView) continue;
  // Walls keep their by-use palette, roofs wear the colour sampled from the real
  // aerial photograph. The site applies a generated brick-and-window texture to
  // the walls; this preview cannot, so it shows the flat base tone.
  const wc = hexRgb(b.wallColour || "#9a7a63");
  const rc = hexRgb(b.roofColour || "#5b5a55");
  for (let i = 0; i < ring.length; i += 1) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    const ex = bx - ax;
    const ez = bz - az;
    const len = Math.hypot(ex, ez);
    if (len < 0.2) continue;
    const n = [-ez / len, 0, ex / len];
    addFace([[ax, 0, az], [bx, 0, bz], [bx, h, bz], [ax, h, az]], n, wc);
  }
  // The silhouette trim the site adds: a wider plinth and a projecting cornice.
  // Drawn from the same ring, scaled out slightly, so what is visible here is
  // what the page draws.
  if (h > 3.2) {
    const scaled = ring.map(([x, z]) => [x * 1.012, z * 1.012]);
    const plinthH = Math.min(1.1, h * 0.28);
    for (let i = 0; i < scaled.length; i += 1) {
      const [ax, az] = scaled[i];
      const [bx, bz] = scaled[(i + 1) % scaled.length];
      const ex = bx - ax;
      const ez = bz - az;
      const len = Math.hypot(ex, ez);
      if (len < 0.2) continue;
      addFace([[ax, 0, az], [bx, 0, bz], [bx, plinthH, bz], [ax, plinthH, az]],
        [-ez / len, 0, ex / len], [106, 97, 87]);
    }
    const cs = ring.map(([x, z]) => [x * 1.022, z * 1.022]);
    for (let i = 0; i < cs.length; i += 1) {
      const [ax, az] = cs[i];
      const [bx, bz] = cs[(i + 1) % cs.length];
      const ex = bx - ax;
      const ez = bz - az;
      const len = Math.hypot(ex, ez);
      if (len < 0.2) continue;
      addFace([[ax, h - 0.4, az], [bx, h - 0.4, bz], [bx, h - 0.06, bz], [ax, h - 0.06, az]],
        [-ez / len, 0, ex / len], [185, 172, 154]);
    }
  }

  // Roof, fanned from the centroid.
  let cx = 0;
  let cz = 0;
  for (const [x, z] of ring) {
    cx += x;
    cz += z;
  }
  cx /= ring.length;
  cz /= ring.length;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b2 = ring[(i + 1) % ring.length];
    addFace([[cx, h, cz], [a[0], h, a[1]], [b2[0], h, b2[1]]], [0, 1, 0], rc);
  }
}

function hexRgb(hex) {
  if (typeof hex === "number") return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  const s = String(hex);
  if (!s.startsWith("#")) return [140, 120, 105];
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
}

// Lamp posts, as the page places them.
const mainRoads = scene.roads.filter((r) => ["primary", "secondary", "tertiary"].includes(r.type));
for (const road of mainRoads) {
  const half = road.width / 2;
  for (let i = 0; i < road.points.length - 1; i += 1) {
    const [ax, az] = road.points[i];
    const [bx, bz] = road.points[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 30) continue;
    const ux = (bx - ax) / len;
    const uz = (bz - az) / len;
    for (let d = 15; d < len; d += 30) {
      const px = ax + ux * d;
      const pz = az + uz * d;
      if (Math.hypot(px - eye[0], pz - eye[2]) > 260) continue;
      const ox = px - uz * (half + 1.4);
      const oz = pz + ux * (half + 1.4);
      addFace([[ox - 0.12, 0, oz - 0.12], [ox + 0.12, 0, oz - 0.12], [ox + 0.12, 8, oz - 0.12], [ox - 0.12, 8, oz - 0.12]], [0, 0, 1], [47, 52, 58]);
      addFace([[ox - 0.12, 0, oz + 0.12], [ox + 0.12, 0, oz + 0.12], [ox + 0.12, 8, oz + 0.12], [ox - 0.12, 8, oz + 0.12]], [0, 0, -1], [47, 52, 58]);
    }
  }
}

// The buses.
function busFaces(origin3, yaw, override) {
  for (const p of busParts) {
    const g = p.geo;
    const isWheel = g.kind === "cyl";
    const base = override || p.colour.rgb;
    const list = g.kind === "box" ? boxF(g.w, g.h, g.d) : cylF(g.rt, g.h, g.seg);
    for (const f of list) {
      const world = f.v.map((v) => {
        let [x, y, z] = v;
        if (isWheel) {
          const t = y;
          y = -x;
          x = t;
        }
        x += p.pos.x;
        y += p.pos.y;
        z += p.pos.z;
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        return [origin3[0] + x * c + z * s, origin3[1] + y, origin3[2] - x * s + z * c];
      });
      addFace(world, f.n, base);
    }
  }
}
function boxF(w, h, d) {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  return [
    { n: [0, 0, 1], v: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
    { n: [0, 0, -1], v: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
    { n: [1, 0, 0], v: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
    { n: [-1, 0, 0], v: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
    { n: [0, 1, 0], v: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
    { n: [0, -1, 0], v: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
  ];
}
function cylF(r, h, seg) {
  const out = [];
  const y = h / 2;
  for (let i = 0; i < seg; i += 1) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0 = [Math.cos(a0) * r, Math.sin(a0) * r];
    const p1 = [Math.cos(a1) * r, Math.sin(a1) * r];
    const mid = (a0 + a1) / 2;
    out.push({ n: [Math.cos(mid), 0, Math.sin(mid)], v: [[p0[0], -y, p0[1]], [p1[0], -y, p1[1]], [p1[0], y, p1[1]], [p0[0], y, p0[1]]] });
  }
  for (const s of [1, -1]) {
    const v = [[-r, y * s, -r], [r, y * s, -r], [r, y * s, r], [-r, y * s, r]];
    if (s < 0) v.reverse();
    out.push({ n: [0, s, 0], v });
  }
  return out;
}

for (const b of BUSES) {
  busFaces(b.at, ((90 - b.bearing) * Math.PI) / 180, hexRgb(b.colour));
}

faces.sort((a, b) => b.depth - a.depth);
for (const f of faces) fillPoly(f.pts, f.colour);
console.log(`drew ${faces.length} object faces`);

const out = process.argv[2] || "scene-preview.png";
await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toFile(out);
console.log(`wrote ${out} (${W}x${H})`);
