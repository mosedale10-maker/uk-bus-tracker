/*
 * Render the 3D camera's bus geometry to a PNG, offline.
 *
 * There is no browser attached to this session, so the in-page render cannot be
 * looked at. But the geometry is just boxes and cylinders with known dimensions,
 * and buildBusMesh can be run against a recording stub to get the exact
 * primitives - so the picture below is the real bus the site draws, not an
 * artist's impression of it.
 *
 * What this is NOT: the browser render also has tone mapping, real shadows, the
 * aerial photograph on the ground, lamp posts and buildings. This is the bus
 * alone, flat-shaded, so the shape can be judged.
 *
 * Run: node scripts/preview-buses.mjs [outfile.png]
 */
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const mod = readFileSync("src/longton-camera-3d.js", "utf8");

/* ---- pull buildBusMesh out of the module and run it with a recording stub --- */

function extract(name) {
  const start = mod.search(new RegExp(`^(export )?(async )?function ${name}\\b`, "m"));
  if (start < 0) throw new Error(`${name} not found`);
  const close = /\r?\n\}\r?\n/g;
  close.lastIndex = start;
  const m = close.exec(mod);
  return mod.slice(start, m.index + m[0].length);
}

const primitives = [];
const recorder = {
  Group: function () {
    return { children: [], add(x) { this.children.push(x); return this; }, userData: {} };
  },
  Mesh: function (geometry, material) {
    // The real Mesh carries a Vector3 position and an Euler rotation; the code
    // assigns to .position.y and .position.set(), so the stub must too.
    return {
      geometry,
      material,
      position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      rotation: { x: 0, y: 0, z: 0 },
    };
  },
  BoxGeometry: function (w, h, d) { return { kind: "box", w, h, d }; },
  CylinderGeometry: function (rt, rb, h, seg) { return { kind: "cyl", rt, rb, h, seg }; },
  Color: function (hex) {
    this.hex = hex;
    if (hex instanceof recorder.Color) this.rgb = hex.rgb.slice();
    else if (typeof hex === "number") this.rgb = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
    else if (typeof hex === "string" && hex.startsWith("#")) {
      this.rgb = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    } else this.rgb = [200, 16, 46];
  },
};

// The real material classes convert a raw hex number into a Color; the stubs have
// to as well or every material ends up with an unreadable colour.
const makeMat = () => function (opts) { return { color: new recorder.Color(opts.color) }; };
recorder.MeshLambertMaterial = makeMat();
recorder.MeshBasicMaterial = makeMat();

const buildBusMesh = new Function(
  "THREE",
  `${extract("buildBusMesh")}
   return buildBusMesh;`,
)(recorder);

const live = { colour: "#c8102e" };
const group = buildBusMesh({ colour: live.colour });
function walk(node, out) {
  for (const child of node.children) {
    if (child.geometry) {
      out.push({
        geo: child.geometry,
        pos: child.position || { x: 0, y: 0, z: 0 },
        rot: child.rotation || null,
        colour: child.material.color,
      });
    }
    if (child.children) walk(child, out);
  }
}
const parts = [];
walk(group, parts);
console.log(`buildBusMesh produced ${parts.length} parts:`);
for (const p of parts) {
  const g = p.geo;
  const c = p.colour.rgb;
  console.log(
    `  ${g.kind.padEnd(5)} ${(g.w ?? g.h).toString().padStart(6)}  y=${p.pos.y?.toFixed?.(2) ?? 0}  rgb(${c.join(",")})`,
  );
}

/* ---- a small software renderer ------------------------------------------- */

const W = 1200;
const H = 700;

function makeImage() {
  return { buf: Buffer.alloc(W * H * 3), depth: new Float64Array(W * H).fill(Infinity) };
}

function clearPixel(img, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  img.buf[i] = r;
  img.buf[i + 1] = g;
  img.buf[i + 2] = b;
}

// Flat sky-to-ground background.
{
  const img = makeImage();
  for (let y = 0; y < H; y += 1) {
    const t = y / H;
    const r = Math.round(150 + (200 - 150) * t);
    const g = Math.round(180 + (205 - 180) * t);
    const b = Math.round(210 + (200 - 210) * t);
    for (let x = 0; x < W; x += 1) clearPixel(img, x, y, r, g, b);
  }
  globalThis.__sky = img;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v) => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Camera looking from behind and above, like the site camera. */
function makeCam(eye, target, fovDeg) {
  const fwd = norm(sub(target, eye));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  return {
    project(p) {
      const d = sub(p, eye);
      const z = dot(d, fwd);
      if (z <= 0.1) return null;
      const x = dot(d, right);
      const y = dot(d, up);
      return {
        x: (W / 2) + (x * f * W) / (2 * z),
        y: (H / 2) - (y * f * H) / (2 * z),
        z,
      };
    },
  };
}

const LIGHT = norm([0.45, 0.82, 0.35]);

function shade(faceNormal, base) {
  const l = Math.max(0, faceNormal[0] * LIGHT[0] + faceNormal[1] * LIGHT[1] + faceNormal[2] * LIGHT[2]);
  const k = 0.32 + 0.68 * l;
  return [Math.min(255, base[0] * k), Math.min(255, base[1] * k), Math.min(255, base[2] * k)];
}

function fillPoly(img, pts, colour) {
  if (pts.length < 3) return;
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
        if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
          inside = !inside;
        }
      }
      if (!inside) continue;
      const i = (y * W + x) * 3;
      img.buf[i] = colour[0];
      img.buf[i + 1] = colour[1];
      img.buf[i + 2] = colour[2];
    }
  }
}

/** Rotate a local point into the bus's frame (yaw about Y, then the part's own). */
function busSpace(p, origin, yaw, partPos, partRot) {
  let [x, y, z] = p;
  if (partRot === "wheel") {
    // Cylinder built along Y, then rotated 90 degrees about Z so its axis is X.
    const t = y;
    y = -x;
    x = t;
  }
  x += partPos[0] || 0;
  y += partPos[1] || 0;
  z += partPos[2] || 0;
  // Yaw about the world Y axis.
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [origin[0] + x * c + z * s, origin[1] + y, origin[2] - x * s + z * c];
}

function boxFaces(w, h, d) {
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

function cylinderFaces(r, h, seg) {
  const faces = [];
  const y = h / 2;
  for (let i = 0; i < seg; i += 1) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0 = [Math.cos(a0) * r, Math.sin(a0) * r];
    const p1 = [Math.cos(a1) * r, Math.sin(a1) * r];
    const mid = (a0 + a1) / 2;
    faces.push({
      n: [Math.cos(mid), 0, Math.sin(mid)],
      v: [[p0[0], -y, p0[1]], [p1[0], -y, p1[1]], [p1[0], y, p1[1]], [p0[0], y, p0[1]]],
    });
  }
  for (const s of [1, -1]) {
    const v = [[-r, y * s, -r], [r, y * s, -r], [r, y * s, r], [-r, y * s, r]];
    if (s < 0) v.reverse();
    faces.push({ n: [0, s, 0], v });
  }
  return faces;
}

function drawBus(img, cam, origin, yaw, colourOverride) {
  const faces = [];
  for (const p of parts) {
    const g = p.geo;
    const partPos = [p.pos.x || 0, p.pos.y || 0, p.pos.z || 0];
    const isWheel = g.kind === "cyl";
    const base = colourOverride || p.colour.rgb;
    const list = g.kind === "box" ? boxFaces(g.w, g.h, g.d) : cylinderFaces(g.rt, g.h, g.seg);
    for (const f of list) {
      // Transform the face normal too.
      const nWorld = busSpace(f.n.map((v, i) => (i === 1 ? v : v)), origin, yaw, [0, 0, 0], null);
      const world = f.v.map((v) => busSpace(v, origin, yaw, partPos, isWheel ? "wheel" : null));
      const pts = world.map((v) => cam.project(v));
      if (pts.some((q) => !q)) continue;
      const depth = pts.reduce((s, q) => s + q.z, 0) / pts.length;
      faces.push({ pts, depth, colour: shade(f.n, base) });
    }
  }
  faces.sort((a, b) => b.depth - a.depth);
  for (const f of faces) fillPoly(img, f.pts, f.colour);
  return faces.length;
}

const img = globalThis.__sky;

// A three-quarter view from behind and above, and the road it stands on.
const EYE = [16, 5.0, 17];
const LOOK = [0, 1.7, 0];
{
  const cam = makeCam(EYE, LOOK, 40);
  const ground = [[-60, 0, 60], [60, 0, 60], [60, 0, -60], [-60, 0, -60]].map((p) => cam.project(p));
  if (ground.every(Boolean)) fillPoly(img, ground, [70, 74, 80]);
  for (let z = -50; z < 50; z += 6) {
    const pts = [[-0.12, 0.02, z], [0.12, 0.02, z], [0.12, 0.02, z + 3], [-0.12, 0.02, z + 3]]
      .map((p) => cam.project(p));
    if (pts.every(Boolean)) fillPoly(img, pts, [222, 218, 200]);
  }
}

const cam = makeCam(EYE, LOOK, 40);
/*
 * The yaw the site now applies: a compass bearing needs a quarter turn because
 * the model faces +X (east) while north is -Z. This is the same formula, so the
 * picture shows the bus the way the page will draw it.
 */
const yaw = ((90 - 0) * Math.PI) / 180;
const n = drawBus(img, cam, [0, 0, 0], yaw, null);
console.log(`drew ${n} faces for the bus, yaw ${((yaw * 180) / Math.PI).toFixed(0)} deg for a north heading`);

const out = process.argv[2] || "bus-preview.png";
await sharp(img.buf, { raw: { width: W, height: H, channels: 3 } })
  .png()
  .toFile(out);
console.log(`wrote ${out} (${W}x${H})`);
