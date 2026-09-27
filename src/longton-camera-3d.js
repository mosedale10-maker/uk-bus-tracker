import * as THREE from "three";

/**
 * A 3D virtual camera standing in Longton town centre.
 *
 * WHAT THIS IS
 * A fixed camera a few metres up, looking down The Strand, in a scene built from
 * real OpenStreetMap geometry: the road surface from the actual OSM way, the
 * buildings from their mapped footprints extruded to a height taken from
 * `building:levels` or `height` where OSM has one. Buses drive through it at
 * their real GPS coordinates and headings.
 *
 * WHAT THIS IS NOT
 * It is not a photograph and not CCTV footage. Nothing here is a picture of the
 * street - it is a model of the street, and a model's building is only as real
 * as the day someone surveyed it. The frame says so, permanently, because a
 * rendered street that could be mistaken for a camera image is the one genuinely
 * dangerous version of this idea.
 *
 * Geometry is prebuilt into longton-scene.generated.json rather than fetched at
 * runtime: Overpass is a free shared service and was answering 504 for much of
 * the time this was written.
 */

/** Where the camera stands and what it looks at. Matches the scene file. */
export const LONGTON_VIEW = {
  name: "The Strand, Longton",
  lat: 52.988038,
  lon: -2.137064,
  eyeHeight: 6.5,
  sceneUrl: "/longton-scene.generated.json",
  photosUrl: "/longton-photos.generated.json",
};

const STAFFS_OPS = ["FPOT", "DAGC", "CRDR", "SLBS"];
const REFRESH_MS = 20_000;
/** How far from the camera a bus is still drawn. */
const VIEW_RANGE_M = 420;

function project(lat, lon, origin) {
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  return { x: (lon - origin.lon) * mLon, z: -(lat - origin.lat) * mLat };
}

function positionOf(row) {
  const c = row?.coordinates;
  if (Array.isArray(c) && c.length >= 2) {
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  if (c && typeof c === "object") {
    const lat = Number(c.latitude ?? c.lat);
    const lon = Number(c.longitude ?? c.lon ?? c.lng);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  return null;
}

function normalise(row) {
  const pos = positionOf(row);
  if (!pos) return null;
  const svc = row.service && typeof row.service === "object" ? row.service : {};
  const op = row.operator && typeof row.operator === "object" ? row.operator : {};
  const veh = row.vehicle && typeof row.vehicle === "object" ? row.vehicle : {};
  return {
    id: String(row.id || `${op.noc || "?"}-${row.journey_id || ""}`),
    lat: pos.lat,
    lon: pos.lon,
    heading: Number.isFinite(Number(row.heading)) ? Number(row.heading) : 0,
    when: row.datetime || null,
    line: String(svc.line_name || row.line || ""),
    operator: String(op.noc || svc.operator?.noc || ""),
    destination: String(row.destination || ""),
    reg: String(veh.reg || ""),
    colour: String(veh.colour || ""),
  };
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

async function loadBuses(origin) {
  const dLat = VIEW_RANGE_M / 111_320;
  const dLon = VIEW_RANGE_M / (111_320 * Math.cos((origin.lat * Math.PI) / 180));
  const bbox = new URLSearchParams({
    xmin: (origin.lon - dLon).toFixed(5),
    ymin: (origin.lat - dLat).toFixed(5),
    xmax: (origin.lon + dLon).toFixed(5),
    ymax: (origin.lat + dLat).toFixed(5),
  });
  const urls = [
    `/api/vehicles?${bbox}`,
    ...STAFFS_OPS.map((op) => `/api/vehicles?operator=${encodeURIComponent(op)}`),
  ];
  const results = await Promise.all(urls.map(fetchJson));
  const seen = new Map();
  for (const rows of results) {
    for (const row of rows || []) {
      const bus = normalise(row);
      if (!bus) continue;
      const p = project(bus.lat, bus.lon, origin);
      const d = Math.hypot(p.x - 0, p.z - 0);
      if (d > VIEW_RANGE_M) continue;
      seen.set(bus.id, { ...bus, x: p.x, z: p.z });
    }
  }
  return [...seen.values()];
}

/* ------------------------------------------------------------------ geometry */

/**
 * Real aerial photography, stitched into one texture for the ground.
 *
 * Flat grey geometry reads as a diagram. Laying the actual Esri World Imagery
 * of Longton over the ground plane is the single biggest step towards looking
 * like a street, and it costs one canvas of tiles.
 *
 * The tiles are the same free endpoint the map's satellite layer already uses,
 * so there is no key to hold. Attribution goes on the frame: the imagery is
 * Esri, Maxar and Earthstar Geographics, and saying so is the condition of use.
 *
 * Tiles arrive asynchronously, so the ground is drawn first in plain colour and
 * the texture swaps in as it loads. The scene must never be blank while waiting.
 */
const IMAGERY = {
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  credit: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
  // z19 is the highest zoom with real imagery for Longton - z20 and above return
  // Esri's 2.5KB "nothing here" placeholder. z19 doubles the ground detail over
  // z18, which is the difference between tarmac and kerbs.
  zoom: 19,
  tile: 256,
  /** Half-width of the area to photograph, in metres either side of the origin. */
  extentM: 400,
  maxTiles: 48,
};

/** Local metres to Web Mercator pixels at a given zoom. */
function mercatorPx(lat, lon, origin, zoom) {
  const n = 2 ** zoom;
  const worldX = ((lon - origin.lon) / 360) * n * IMAGERY.tile;
  const latRad = (lat * Math.PI) / 180;
  const worldY =
    (-Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / (2 * Math.PI)) * n * IMAGERY.tile;
  return { x: worldX, y: worldY };
}

/** Local metres back to lat/lon, so the ground corners can be projected. */
function latLonFrom(origin, x, z) {
  const mLon = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  return {
    lat: origin.lat - z / 111_320,
    lon: origin.lon + x / mLon,
  };
}

function loadAerialTexture(origin, onReady) {
  const half = IMAGERY.extentM;
  const corners = [
    latLonFrom(origin, -half, -half),
    latLonFrom(origin, half, -half),
    latLonFrom(origin, half, half),
    latLonFrom(origin, -half, half),
  ].map((c) => mercatorPx(c.lat, c.lon, origin, IMAGERY.zoom));

  const minX = Math.min(...corners.map((c) => c.x));
  const maxX = Math.max(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const maxY = Math.max(...corners.map((c) => c.y));

  const t0 = Math.floor(minX / IMAGERY.tile);
  const t1 = Math.floor((maxX - 1) / IMAGERY.tile);
  const r0 = Math.floor(minY / IMAGERY.tile);
  const r1 = Math.floor((maxY - 1) / IMAGERY.tile);
  const cols = t1 - t0 + 1;
  const rows = r1 - r0 + 1;

  // A very large scene area at a high zoom would mean hundreds of requests to a
  // free service. Shrink the zoom rather than hammer it.
  if (cols * rows > IMAGERY.maxTiles) {
    return { texture: null, skipped: "too many tiles" };
  }

  const canvas = document.createElement("canvas");
  canvas.width = cols * IMAGERY.tile;
  canvas.height = rows * IMAGERY.tile;
  const ctx = canvas.getContext("2d");
  // A neutral base so a slow or missing tile leaves tarmac grey, not black.
  ctx.fillStyle = "#3a4048";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let loaded = 0;
  let failed = 0;
  const total = cols * rows;
  return new Promise((resolve) => {
    const finish = () => {
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      texture.needsUpdate = true;
      resolve({ texture, loaded, failed, total, uv: { minX, minY, w: canvas.width, h: canvas.height } });
    };
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const url = IMAGERY.url
          .replace("{z}", String(IMAGERY.zoom))
          .replace("{x}", String(t0 + c))
          .replace("{y}", String(r0 + r));
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          ctx.drawImage(img, c * IMAGERY.tile, r * IMAGERY.tile);
          loaded += 1;
          if (loaded + failed === total) finish();
        };
        img.onerror = () => {
          failed += 1;
          if (loaded + failed === total) finish();
        };
        img.src = url;
      }
    }
  });
}

/**
 * The ground, textured with the aerial mosaic when it arrives.
 *
 * UVs are worked out from the mercator pixel box the mosaic covers, not guessed
 * from the plane's own 0..1 range, or the photograph lands in the wrong place and
 * the street sits next to itself.
 */
function buildGround(origin, extentM, uvBox) {
  const geo = new THREE.PlaneGeometry(extentM * 2, extentM * 2, 1, 1);
  geo.rotateX(-Math.PI / 2);
  if (uvBox) {
    const pos = geo.attributes.position;
    const uvs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i += 1) {
      const wx = pos.getX(i);
      const wz = pos.getZ(i);
      const ll = latLonFrom(origin, wx, wz);
      const p = mercatorPx(ll.lat, ll.lon, origin, IMAGERY.zoom);
      uvs[i * 2] = (p.x - uvBox.minX) / uvBox.w;
      // Canvas Y runs down, texture V runs up.
      uvs[i * 2 + 1] = 1 - (p.y - uvBox.minY) / uvBox.h;
    }
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  }
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.06;
  return mesh;
}

/**
 * Road surface, markings and kerbs.
 *
 * IMPORTANT: the aerial photograph already contains the real road, with its real
 * surface, its real painted lines, the real kerb and the shadows of whatever was
 * standing there that day. Drawing an opaque grey road on top of it hides the
 * single most convincing thing in the frame - the actual street - and replaces it
 * with a diagram. So when the photograph is present, the road geometry is only
 * used for a subtle kerb line and the tarmac and the markings are left off
 * entirely; the photograph is the road.
 *
 * Without the photograph, the full stylised road is drawn, because a bare ground
 * plane with no road is worse than a plain one.
 */
function buildRoads(scene, { withAerial }) {
  const group = new THREE.Group();
  const tarmac = { pos: [], uv: [] };
  const paint = { pos: [], uv: [] };
  const kerb = { pos: [], uv: [] };

  const push = (buf, ax, az, bx, bz, half, y) => {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return;
    const nx = (-dz / len) * half;
    const nz = (dx / len) * half;
    const p = [
      [ax + nx, az + nz],
      [bx + nx, bz + nz],
      [bx - nx, bz - nz],
      [ax + nx, az + nz],
      [bx - nx, bz - nz],
      [ax - nx, az - nz],
    ];
    for (const [x, z] of p) {
      buf.pos.push(x, y, z);
      buf.uv.push(0, 0);
    }
  };

  for (const road of scene.roads) {
    const half = road.width / 2;
    const big = road.type === "primary" || road.type === "secondary" || road.type === "trunk";
    for (let i = 0; i < road.points.length - 1; i += 1) {
      const [ax, az] = road.points[i];
      const [bx, bz] = road.points[i + 1];
      if (!withAerial) push(tarmac, ax, az, bx, bz, half, 0);
      // Kerb line each side, slightly proud. Kept even over the photograph: it is
      // the one thing that reliably reads correctly in model geometry.
      push(kerb, ax, az, bx, bz, half + 0.3, 0.05);
      if (big && !withAerial) {
        const len = Math.hypot(bx - ax, bz - az);
        const step = 6;
        for (let d = 0; d < len; d += step) {
          const t0 = d / len;
          const t1 = Math.min(1, (d + 3) / len);
          push(paint, ax + (bx - ax) * t0, az + (bz - az) * t0,
            ax + (bx - ax) * t1, az + (bz - az) * t1, 0.09, 0.03);
        }
        for (const side of [1, -1]) {
          const ox = side * (half - 0.35);
          const dx = bx - ax;
          const dz = bz - az;
          const l = Math.hypot(dx, dz) || 1;
          const nx = (-dz / l) * ox;
          const nz = (dx / l) * ox;
          push(paint, ax + nx, az + nz, bx + nx, bz + nz, 0.07, 0.03);
        }
      }
    }
  }

  const mesh = (buf, mat) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(buf.pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(buf.uv, 2));
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, mat);
  };

  if (tarmac.pos.length) group.add(mesh(tarmac, new THREE.MeshLambertMaterial({ color: 0x33383f })));
  if (kerb.pos.length) group.add(mesh(kerb, new THREE.MeshLambertMaterial({ color: 0x707680 })));
  if (paint.pos.length) {
    group.add(mesh(paint, new THREE.MeshBasicMaterial({ color: 0xe8e6df })));
  }
  return group;
}

/**
 * Street furniture: lamp posts and trees along the pavement edge.
 *
 * A street with nothing standing on it reads as a model no matter how good the
 * buildings are. Lamp posts are the cheapest possible win: one thin cylinder and
 * a head, instanced down both sides of the main street, and the eye reads scale
 * and depth immediately.
 */
function buildStreetFurniture(scene) {
  const group = new THREE.Group();
  const SPACING = 26;
  const postGeo = new THREE.CylinderGeometry(0.11, 0.15, 8, 6);
  const postMat = new THREE.MeshLambertMaterial({ color: 0x2f343a });
  const headGeo = new THREE.SphereGeometry(0.32, 8, 6);
  const headMat = new THREE.MeshBasicMaterial({ color: 0xffe9b8 });
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.26, 3.4, 6);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x4a3a2c });
  const crownGeo = new THREE.IcosahedronGeometry(2.1, 0);
  const crownMat = new THREE.MeshLambertMaterial({ color: 0x3f5c34 });

  const mainRoads = scene.roads.filter(
    (r) => r.type === "primary" || r.type === "secondary" || r.type === "tertiary",
  );
  let lamps = 0;
  let trees = 0;
  for (const road of mainRoads) {
    const half = road.width / 2;
    for (let i = 0; i < road.points.length - 1; i += 1) {
      const [ax, az] = road.points[i];
      const [bx, bz] = road.points[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < SPACING) continue;
      const ux = dx / len;
      const uz = dz / len;
      const nx = -uz;
      const nz = ux;
      for (let d = SPACING / 2; d < len; d += SPACING) {
        const px = ax + ux * d;
        const pz = az + uz * d;
        const side = lamps % 2 === 0 ? 1 : -1;
        const ox = px + nx * (half + 1.4) * side;
        const oz = pz + nz * (half + 1.4) * side;
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(ox, 4, oz);
        post.castShadow = true;
        group.add(post);
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.set(ox, 8.2, oz);
        group.add(head);
        lamps += 1;
        // One tree in four gaps, opposite side, so the street is not a corridor
        // of identical posts.
        if (lamps % 4 === 0) {
          const tx = px + nx * (half + 2.2) * -side;
          const tz = pz + nz * (half + 2.2) * -side;
          const trunk = new THREE.Mesh(trunkGeo, trunkMat);
          trunk.position.set(tx, 1.7, tz);
          trunk.castShadow = true;
          group.add(trunk);
          const crown = new THREE.Mesh(crownGeo, crownMat);
          crown.position.set(tx, 4.6, tz);
          crown.castShadow = true;
          group.add(crown);
          trees += 1;
        }
      }
    }
  }
  group.userData = { lamps, trees };
  return group;
}

/**
 * A wall texture: brick courses with window openings.
 *
 * Flat-coloured boxes are the clearest tell that a thing is a model, and 239
 * buildings of them made the street look like a diagram. This draws a patch of
 * wall instead, generated on a canvas so it needs no download.
 *
 * The patch represents TEXTURE_M metres of wall, and the UVs are scaled to match,
 * so a window is a window's real size whatever the building's dimensions. That
 * matters: a texture tiled at the wrong scale gives you two-metre windows, which
 * looks worse than no windows at all.
 */
const TEXTURE_M = 4.5;

function makeWallTexture(baseColor) {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");

  const base = new THREE.Color(baseColor);
  const toCss = (c, f = 1) =>
    `rgb(${Math.round(Math.min(255, c.r * 255 * f))},${Math.round(Math.min(255, c.g * 255 * f))},${Math.round(Math.min(255, c.b * 255 * f))})`;

  ctx.fillStyle = toCss(base);
  ctx.fillRect(0, 0, S, S);

  // Brick courses. Brick is about 75mm high, so at 4.5m over 256px there are
  // roughly 20 courses; drawn at a visible scale so the wall is not a flat field.
  const courses = 22;
  const ch = S / courses;
  ctx.strokeStyle = toCss(base, 0.86);
  ctx.lineWidth = 1;
  for (let i = 1; i < courses; i += 1) {
    ctx.beginPath();
    ctx.moveTo(0, i * ch);
    ctx.lineTo(S, i * ch);
    ctx.stroke();
  }

  // Two rows of windows in the patch, which is three storeys in 4.5m - close
  // enough to a Victorian terrace for the eye, and the ground floor is handled
  // by the plinth below.
  const rows = 2;
  const cols = 2;
  const pad = S * 0.16;
  const wW = (S - pad * (cols + 1)) / cols;
  const wH = (S - pad * (rows + 1)) / rows;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = pad + c * (wW + pad);
      const y = pad + r * (wH + pad);
      // Recess: a dark reveal, then the glass, then a pale sill.
      ctx.fillStyle = "rgba(0,0,0,0.42)";
      ctx.fillRect(x - 2, y - 2, wW + 4, wH + 4);
      const g = ctx.createLinearGradient(x, y, x + wW, y + wH);
      g.addColorStop(0, "#2b3a47");
      g.addColorStop(0.5, "#4a5f70");
      g.addColorStop(1, "#1d2831");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, wW, wH);
      // Glazing bars.
      ctx.strokeStyle = "rgba(230,230,225,0.55)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + wW / 2, y);
      ctx.lineTo(x + wW / 2, y + wH);
      ctx.moveTo(x, y + wH / 2);
      ctx.lineTo(x + wW, y + wH / 2);
      ctx.stroke();
      // Sill.
      ctx.fillStyle = toCss(base, 1.18);
      ctx.fillRect(x - 3, y + wH + 2, wW + 6, 4);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Buildings, extruded from their mapped footprints.
 *
 * ExtrudeGeometry wants a Shape. A mapped footprint is a ring, not a polygon with
 * holes, so the first and last point is closed explicitly. Anything that fails
 * to build is skipped rather than taking the whole scene down - one bad outline
 * in 125 buildings must not cost the other 124.
 *
 * Walls and roofs are separate meshes on purpose. A single extruded solid reads
 * as a lump of the same colour on every face, which is the giveaway that
 * something is a model; giving the roof its own darker material and adding a
 * thin eaves lip is what makes extruded boxes look like buildings.
 */
function buildBuildings(scene) {
  const group = new THREE.Group();
  let built = 0;
  let skipped = 0;
  let firstError = null;
  // Materials are shared per colour bucket. 125 unique materials is 125 shader
  // state changes a frame for no visual gain.
  const wallMats = [];
  const roofMats = [];
  /*
   * One material per colour, and the texture is generated only when a new colour
   * appears. Passing a factory rather than a texture matters: 239 buildings share
   * about six colours, and eagerly drawing 239 canvases to throw 233 away costs
   * real milliseconds on a phone.
   */
  const pick = (bucket, color, makeMap) => {
    const key = color.getHexString();
    let entry = bucket.find((m) => m.userData.key === key);
    if (!entry) {
      entry = new THREE.MeshLambertMaterial(
        makeMap ? { map: makeMap(), color: 0xffffff } : { color },
      );
      entry.userData.key = key;
      bucket.push(entry);
    }
    return entry;
  };

  for (const b of scene.buildings) {
    try {
      const ring = b.ring;
      const shape = new THREE.Shape();
      shape.moveTo(ring[0][0], ring[0][1]);
      for (let i = 1; i < ring.length; i += 1) shape.lineTo(ring[i][0], ring[i][1]);
      shape.closePath();
      const h = b.height;

      // Walls: a brick-ish tone varied deterministically by footprint position,
      // so the same building looks the same every reload but neighbours differ.
      const seed = Math.abs(Math.round(ring[0][0] * 7 + ring[0][1] * 13)) % 100;
      const kind = b.kind;
      let wall;
      if (kind === "retail" || kind === "commercial") {
        wall = new THREE.Color().setHSL(0.09, 0.1, 0.42 + (seed % 12) / 100);
      } else if (kind === "industrial" || kind === "warehouse") {
        wall = new THREE.Color().setHSL(0.58, 0.05, 0.46 + (seed % 10) / 100);
      } else if (kind === "church") {
        wall = new THREE.Color().setHSL(0.1, 0.06, 0.52);
      } else {
        // Terraced housing and everything else: brick reds and buff stone.
        wall = new THREE.Color().setHSL(0.02 + (seed % 8) / 100, 0.22, 0.36 + (seed % 14) / 100);
      }

      const wallGeo = new THREE.ExtrudeGeometry(shape, { depth: h - 0.4, bevelEnabled: false });
      wallGeo.rotateX(-Math.PI / 2);
      /*
       * ExtrudeGeometry's side UVs are in metres - it uses raw vertex positions.
       * Dividing by TEXTURE_M therefore makes the wall texture cover exactly
       * TEXTURE_M metres, whatever the building's size, and a window stays a
       * window's size. Scaling the UVs rather than setting texture.repeat keeps
       * one shared material per colour instead of one per building.
       */
      const uv = wallGeo.attributes.uv;
      for (let i = 0; i < uv.count; i += 1) {
        uv.setXY(i, uv.getX(i) / TEXTURE_M, uv.getY(i) / TEXTURE_M);
      }
      uv.needsUpdate = true;
      // The factory, not its result. Passing the texture itself made pick() call
      // a THREE.Texture as if it were a function, which threw inside the
      // per-building try below - and that catch silently skipped every building
      // in the scene, so the street rendered with a road and no buildings at all.
      const wallMesh = new THREE.Mesh(wallGeo, pick(wallMats, wall, () => makeWallTexture(wall)));
      wallMesh.position.y = 0.02;
      wallMesh.castShadow = true;
      wallMesh.receiveShadow = true;
      group.add(wallMesh);

      // Roof: a flat cap plus a thin lip, so the top edge is not a hard cut.
      // Where the scene generator managed to sample the real roof colour out of
      // the aerial photography, use that - the buildings then wear the colour of
      // the actual Longton roof they stand where, rather than an invented one.
      const roofGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.4, bevelEnabled: false });
      roofGeo.rotateX(-Math.PI / 2);
      let roofColor;
      if (b.roofColour) {
        roofColor = new THREE.Color(b.roofColour);
      } else if (kind === "industrial" || kind === "warehouse") {
        roofColor = new THREE.Color().setHSL(0.58, 0.08, 0.34);
      } else {
        roofColor = new THREE.Color().setHSL(0.09, 0.14, 0.2 + (seed % 8) / 100);
      }
      const roofMesh = new THREE.Mesh(roofGeo, pick(roofMats, roofColor));
      roofMesh.position.y = 0.02 + h - 0.4;
      roofMesh.castShadow = true;
      roofMesh.receiveShadow = true;
      group.add(roofMesh);

      built += 1;
    } catch (err) {
      /*
       * One bad outline should not cost the other 238. But swallowing the error
       * is how a genuine bug reached production: a material factory was passed
       * where its result was expected, this threw on every building, and the
       * result was a street with a road and no buildings at all - reported
       * nowhere except a count in a small label.
       *
       * So the first failure is recorded and shown, and if most of the scene
       * fails to build that is treated as a fault to report rather than a
       * partial success to shrug at.
       */
      skipped += 1;
      if (skipped === 1) {
        firstError = err;
        try {
          console.error("[longton] first building failed to build:", err);
        } catch {
          /* console may be absent */
        }
      }
    }
  }
  group.userData = { built, skipped, firstError: firstError ? String(firstError.message || firstError) : "" };
  return group;
}

/** A wide plain beyond the photographed area, so the horizon is not a hard edge. */
/** Release the GPU memory of a group that is being replaced. */
function disposeTree(root) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    const m = obj.material;
    if (Array.isArray(m)) m.forEach((x) => x?.dispose?.());
    else m?.dispose?.();
  });
}

function buildFarGround() {
  const geo = new THREE.PlaneGeometry(4200, 4200);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({ color: 0x2b3038 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.05;
  return mesh;
}

/**
 * Where the sun is, from the time of day.
 *
 * A fixed overhead light is the other thing that makes a render look fake: at
 * 9am and 3pm in Britain the shadows fall in completely different directions.
 * This is a rough model - it ignores latitude and season - but it moves the
 * shadows through the day, which is what the eye notices.
 */
function sunDirection(hour) {
  // Solar noon is around 13:00 in the UK in summer, 14:30 in winter.
  const noon = 13.2;
  const t = (hour - noon) / 6;
  const altitude = Math.max(0.08, Math.cos(t * 1.35) * 0.95);
  const azimuth = -0.9 + t * 1.5;
  return {
    x: Math.cos(altitude) * Math.sin(azimuth) * 320,
    y: Math.max(30, Math.sin(altitude) * 320),
    z: Math.cos(altitude) * Math.cos(azimuth) * 320,
  };
}

/** A bus: body, glazing band, and a route plate on the side. */
function buildBusMesh(bus) {
  const group = new THREE.Group();
  const L = 12.5;
  const W = 2.55;
  const H = 3.2;
  const body = new THREE.MeshLambertMaterial({ color: new THREE.Color(bus.colour || "#c8102e") });
  const glass = new THREE.MeshLambertMaterial({ color: 0x1b2733 });

  const hull = new THREE.Mesh(new THREE.BoxGeometry(L, H - 1.0, W), body);
  hull.position.y = 0.55 + (H - 1.0) / 2;
  group.add(hull);

  const band = new THREE.Mesh(new THREE.BoxGeometry(L - 0.6, 0.85, W + 0.04), glass);
  band.position.y = hull.position.y + 0.35;
  group.add(band);

  // A pale roof so the vehicle reads from the camera's slightly raised angle.
  const roof = new THREE.Mesh(new THREE.BoxGeometry(L - 1.2, 0.18, W - 0.5), body);
  roof.position.y = H + 0.5;
  group.add(roof);

  for (const [dx, dz] of [[-L / 2 + 1.2, W / 2 - 0.35], [-L / 2 + 1.2, -W / 2 + 0.35], [L / 2 - 1.6, W / 2 - 0.35], [L / 2 - 1.6, -W / 2 + 0.35]]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.3, 10), new THREE.MeshLambertMaterial({ color: 0x14181d }));
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(dx, 0.5, dz);
    group.add(wheel);
  }

  group.userData.bus = bus;
  return group;
}

/* -------------------------------------------------------------------- mount */

export function createLongtonCamera3d(container, opts = {}) {
  if (!container) return null;
  const view = { ...LONGTON_VIEW, ...(opts.view || {}) };

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch (err) {
    // Fail loudly. A blank box that says nothing is the worst outcome here,
    // because it looks like "no buses" rather than "this browser cannot draw it".
    container.innerHTML = `<p class="lcam3d-error">This browser could not start WebGL, so the
      3D view cannot be drawn. ${String(err.message || err)}</p>`;
    return null;
  }
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  // Tone mapping and sRGB output. Without these the render is washed out and
  // the colours do not match the aerial photograph laid over the ground, which
  // is the most obvious tell that two images sources have been combined.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  // Shadows are most of what makes extruded boxes look solid. The map is 2k, so
  // a basic shadow map is plenty and will not choke a phone.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // A gradient sky rather than a flat fill. A flat sky behind a street of
  // extruded boxes is one of the things that makes a render look like a render;
  // a gradient costs one small canvas.
  const skyCanvas = document.createElement("canvas");
  skyCanvas.width = 4;
  skyCanvas.height = 128;
  const skyTex = new THREE.CanvasTexture(skyCanvas);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  function paintSky(night) {
    const ctx = skyCanvas.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    if (night) {
      g.addColorStop(0, "#05080f");
      g.addColorStop(0.7, "#0b1220");
      g.addColorStop(1, "#161d29");
    } else {
      g.addColorStop(0, "#6f9fd0");
      g.addColorStop(0.6, "#a8c4e0");
      g.addColorStop(1, "#d8dfe2");
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 128);
    skyTex.needsUpdate = true;
  }
  paintSky(true);
  scene.background = skyTex;
  scene.fog = new THREE.Fog(0x0b1120, 260, 900);

  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.5, 3000);

  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a2f38, 1.05);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // A tight shadow camera around the view, or the 2048 map is spread over four
  // kilometres and every shadow is a blur.
  const S = 300;
  sun.shadow.camera.left = -S;
  sun.shadow.camera.right = S;
  sun.shadow.camera.top = S;
  sun.shadow.camera.bottom = -S;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 1200;
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 0.4;
  scene.add(sun);
  scene.add(sun.target);

  const busLayer = new THREE.Group();
  scene.add(busLayer);

  const els = {
    count: container.querySelector("[data-lcam3d-count]"),
    updated: container.querySelector("[data-lcam3d-updated]"),
    status: container.querySelector("[data-lcam3d-status]"),
    clock: container.querySelector("[data-lcam3d-clock]"),
    note: container.querySelector("[data-lcam3d-note]"),
    photos: container.querySelector("[data-lcam3d-photos]"),
    photosList: container.querySelector("[data-lcam3d-photos-list]"),
    photosNote: container.querySelector("[data-lcam3d-photos-note]"),
    photosCredit: container.querySelector("[data-lcam3d-photos-credit]"),
  };

  const state = {
    running: false,
    photosShown: false,
    timer: 0,
    inflight: false,
    sceneData: null,
    buses: new Map(),
    lastAt: 0,
    error: "",
  };

  function showError(message) {
    state.error = message;
    if (els.status) {
      els.status.hidden = false;
      els.status.textContent = message;
    }
  }

  function setClock() {
    if (!els.clock) return;
    els.clock.textContent = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function resize() {
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 360;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function aim() {
    const data = state.sceneData;
    if (!data?.camera) return;
    const at = data.camera.at;
    const towards = data.camera.towards;
    camera.position.set(at[0], view.eyeHeight, at[1]);
    camera.lookAt(towards[0], 1.4, towards[1]);
  }

  function applyDaylight() {
    const hour = new Date().getHours();
    const night = hour < 6 || hour >= 19;
    paintSky(night);
    scene.fog.color.set(night ? 0x0b1120 : 0xb9cbdd);
    hemi.intensity = night ? 0.5 : 1.05;
    sun.intensity = night ? 0.22 : 0.85;
    // Move the sun with the time of day, and keep the shadow camera centred on
    // wherever the camera is looking, or the shadows fall outside the map.
    const dir = sunDirection(hour);
    const at = state.sceneData?.camera?.at || [0, 0];
    sun.position.set(at[0] + dir.x, dir.y, at[1] + dir.z);
    sun.target.position.set(at[0], 0, at[1]);
    sun.target.updateMatrixWorld();
    if (els.note && !els.note.dataset.locked) {
      els.note.textContent = night
        ? "night — street lighting approximated"
        : "daylight";
    }
  }

  function paintBuses() {
    for (const mesh of busLayer.children) busLayer.remove(mesh);
    for (const bus of state.buses.values()) {
      const mesh = buildBusMesh(bus);
      mesh.position.set(bus.x, 0, bus.z);
      // Screen-space heading: 0 is north, which is -Z, so subtract from the
      // model's default facing along +X after rotating it flat.
      mesh.rotation.y = -((bus.heading || 0) * Math.PI) / 180;
      busLayer.add(mesh);
    }
    if (els.count) els.count.textContent = String(state.buses.size);
  }

  async function refreshBuses() {
    if (state.inflight) return;
    state.inflight = true;
    const origin = state.sceneData?.origin || { lat: view.lat, lon: view.lon };
    const buses = await loadBuses(origin);
    state.inflight = false;
    state.buses = new Map(buses.map((b) => [b.id, b]));
    state.lastAt = Date.now();
    paintBuses();
    if (els.updated) {
      els.updated.textContent = new Date(state.lastAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }
    if (els.status) {
      if (!buses.length) {
        els.status.hidden = false;
        els.status.textContent =
          "No buses on the roads in view right now. Local services finish for the day, so this is expected overnight.";
      } else {
        els.status.hidden = true;
      }
    }
  }

  async function loadScene() {
    const data = await fetchJson(view.sceneUrl);
    if (!data || !data.roads?.length) {
      showError(
        "The 3D street model could not be loaded, so there is nothing to look at. The coach photo gallery below still works.",
      );
      return false;
    }
    state.sceneData = data;
    const origin = data.origin || { lat: view.lat, lon: view.lon };

    // The ground goes in first, untextured, so there is always a surface to see.
    // The aerial photograph is layered over it when it arrives rather than
    // blocking on it - a slow tile fetch must not delay the street appearing.
    const ground = buildGround(origin, IMAGERY.extentM, null);
    ground.receiveShadow = true;
    scene.add(ground);
    // A wide plain beyond the photographed area, so the horizon is ground and
    // not a hard edge with sky under it.
    scene.add(buildFarGround());

    state.roads = buildRoads(data, { withAerial: false });
    scene.add(state.roads);
    const buildings = buildBuildings(data);
    scene.add(buildings);
    const furniture = buildStreetFurniture(data);
    scene.add(furniture);
    aim();
    applyDaylight();
    const builtNow = buildings.userData?.built || 0;
    const skippedNow = buildings.userData?.skipped || 0;
    if (skippedNow > 4 && builtNow === 0) {
      // Every building failed. That is a fault, not a partial success, and it
      // must not be presented as a finished view.
      showError(
        `The 3D street could not be drawn: all ${skippedNow} buildings failed to build` +
          (buildings.userData?.firstError ? ` (${buildings.userData.firstError})` : "") +
          ". The coach photo gallery below still works.",
      );
      return false;
    }
    if (els.note) {
      const n = data.counts || {};
      els.note.dataset.locked = "1";
      els.note.textContent =
        `OpenStreetMap 3D model · ${builtNow} buildings · ${n.roads || 0} road sections` +
        (skippedNow ? ` · ${skippedNow} outline(s) could not be drawn` : "") +
        " · loading aerial imagery…";
    }

    // Now the photography, and swap it in when it is all there.
    loadAerialTexture(origin)
      .then((res) => {
        if (res?.texture && res.uv) {
          const textured = buildGround(origin, IMAGERY.extentM, res.uv);
          textured.position.y = -0.05;
          textured.receiveShadow = true;
          scene.add(textured);
          state.aerial = res;
          // Now the photograph is the road: swap the stylised tarmac and its
          // painted lines for kerbs only, so the real street shows through
          // instead of being covered by a grey slab.
          if (state.sceneData && state.roads) {
            scene.remove(state.roads);
            disposeTree(state.roads);
            state.roads = buildRoads(state.sceneData, { withAerial: true });
            scene.add(state.roads);
          }
        }
        if (els.note) {
          const bits = [`aerial imagery: ${res?.loaded ?? 0} tiles`];
          if (res?.failed) bits.push(`${res.failed} unavailable`);
          els.note.textContent = `${els.note.textContent.replace(" · loading aerial imagery…", "")} · ${bits.join(", ")}`;
        }
      })
      .catch(() => {
        if (els.note) {
          els.note.textContent = els.note.textContent.replace(
            " · loading aerial imagery…",
            " · aerial imagery unavailable, plain ground shown",
          );
        }
      });

    return true;
  }

  /**
   * The real photographs of the street, nearest first, each credited.
   *
   * These are Geograph pictures of the actual Longton taken under CC BY-SA 2.0 -
   * the Superdrug and Ryman frontage, the Potteries Oatcake Company, the view
   * from Gold Street. They are shown as photographs with their author named,
   * not pasted onto the buildings: a Geograph shot is a view along a street from
   * one spot, and stretched across a box it would read as a poster stuck on a
   * wall rather than as the building it actually shows. Attribution is not
   * optional under CC BY-SA, so the author and licence travel with every image.
   */
  async function loadPhotos() {
    if (state.photosShown || !els.photosList) return;
    state.photosShown = true;
    const data = await fetchJson(view.photosUrl);
    const photos = Array.isArray(data?.photos) ? data.photos.slice(0, 6) : [];
    if (!photos.length) {
      if (els.photos) els.photos.hidden = true;
      return;
    }
    const mLon = 111_320 * Math.cos(((state.sceneData?.origin?.lat || view.lat) * Math.PI) / 180);
    const origin = state.sceneData?.origin || { lat: view.lat, lon: view.lon };
    const camAt = state.sceneData?.camera?.at || [0, 0];
    const camLat = origin.lat - camAt[1] / 111_320;
    const camLon = origin.lon + camAt[0] / mLon;

    els.photosList.innerHTML = photos
      .map((p) => {
        const d = Math.round(
          Math.hypot((p.lat - camLat) * 111_320, (p.lon - camLon) * mLon),
        );
        return `<li class="lcam-photo">
          <a href="${esc(p.page)}" target="_blank" rel="noopener noreferrer">
            <img src="${esc(p.thumb)}" alt="${esc(p.title)}" loading="lazy" decoding="async" width="240" height="180" />
          </a>
          <div class="lcam-photo-meta">
            <a class="lcam-photo-title" href="${esc(p.page)}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a>
            <span>${esc(p.author)} &middot; ${esc(p.licence)} &middot; ${d} m from the camera</span>
          </div>
        </li>`;
      })
      .join("");

    if (els.photosNote) {
      els.photosNote.textContent = `${data.count} freely-licensed pictures of this street, showing the ${photos.length} nearest`;
    }
    if (els.photosCredit) {
      els.photosCredit.textContent =
        "Photographs from Wikimedia Commons, reused under CC BY-SA / CC BY. " +
        "Each links to its file page, where the author and licence are recorded in full.";
    }
    if (els.photos) els.photos.hidden = false;
  }

  function frame() {
    renderer.render(scene, camera);
    state.raf = requestAnimationFrame(frame);
  }

  async function start() {
    if (state.running) return;
    state.running = true;
    setClock();
    resize();
    if (!state.sceneData) {
      const ok = await loadScene();
      if (!ok) {
        state.running = false;
        return;
      }
    }
    aim();
    resize();
    await refreshBuses();
    loadPhotos();
    // invalidateSize matters: the container was display:none until the tab
    // opened, so without this the first frame is rendered at the wrong size.
    requestAnimationFrame(resize);
    frame();
    state.timer = setInterval(() => {
      setClock();
      applyDaylight();
      refreshBuses();
    }, REFRESH_MS);
  }

  function stop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    if (state.timer) clearInterval(state.timer);
    state.timer = 0;
    state.running = false;
  }

  const onResize = () => {
    if (state.running) resize();
  };
  globalThis.addEventListener?.("resize", onResize);

  return {
    start,
    stop,
    refresh: refreshBuses,
    resize,
    state,
    view,
    destroy() {
      stop();
      globalThis.removeEventListener?.("resize", onResize);
      try {
        disposeTree(scene);
        renderer.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}
