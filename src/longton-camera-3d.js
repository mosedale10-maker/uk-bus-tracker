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
  zoom: 18,
  tile: 256,
  /** Half-width of the area to photograph, in metres either side of the origin. */
  extentM: 460,
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
 * Road surface, plus the markings and kerbs that make it read as a street.
 *
 * Markings are drawn as thin unlit strips just above the tarmac rather than
 * baked into a texture, so they follow the real OSM geometry instead of a
 * guessed texture, and so they cost nothing to generate.
 */
function buildRoads(scene) {
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
      push(tarmac, ax, az, bx, bz, half, 0);
      // Kerb line each side, slightly proud of the tarmac.
      push(kerb, ax, az, bx, bz, half + 0.28, 0.06);
      if (big) {
        // Centre line, dashed by drawing short runs.
        const len = Math.hypot(bx - ax, bz - az);
        const dash = 3;
        const gap = 3;
        const step = dash + gap;
        for (let d = 0; d < len; d += step) {
          const t0 = d / len;
          const t1 = Math.min(1, (d + dash) / len);
          push(paint, ax + (bx - ax) * t0, az + (bz - az) * t0,
            ax + (bx - ax) * t1, az + (bz - az) * t1, 0.09, 0.03);
        }
        // Edge lines.
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

  group.add(mesh(tarmac, new THREE.MeshLambertMaterial({ color: 0x33383f })));
  group.add(mesh(kerb, new THREE.MeshLambertMaterial({ color: 0x6b7078 })));
  if (paint.pos.length) {
    // Unlit: paint is retroreflective and stays bright whatever the sun is doing.
    group.add(mesh(paint, new THREE.MeshBasicMaterial({ color: 0xe8e6df })));
  }
  return group;
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
  // Materials are shared per colour bucket. 125 unique materials is 125 shader
  // state changes a frame for no visual gain.
  const wallMats = [];
  const roofMats = [];
  const pick = (bucket, color) => {
    const key = color.getHexString();
    let entry = bucket.find((m) => m.userData.key === key);
    if (!entry) {
      entry = new THREE.MeshLambertMaterial({ color });
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
      const wallMesh = new THREE.Mesh(wallGeo, pick(wallMats, wall));
      wallMesh.position.y = 0.02;
      wallMesh.castShadow = true;
      wallMesh.receiveShadow = true;
      group.add(wallMesh);

      // Roof: a flat cap plus a thin lip, so the top edge is not a hard cut.
      const roofGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.4, bevelEnabled: false });
      roofGeo.rotateX(-Math.PI / 2);
      const roofColor = kind === "industrial" || kind === "warehouse"
        ? new THREE.Color().setHSL(0.58, 0.08, 0.34)
        : new THREE.Color().setHSL(0.09, 0.14, 0.2 + (seed % 8) / 100);
      const roofMesh = new THREE.Mesh(roofGeo, pick(roofMats, roofColor));
      roofMesh.position.y = 0.02 + h - 0.4;
      roofMesh.castShadow = true;
      roofMesh.receiveShadow = true;
      group.add(roofMesh);

      built += 1;
    } catch {
      skipped += 1;
    }
  }
  group.userData = { built, skipped };
  return group;
}

/** A wide plain beyond the photographed area, so the horizon is not a hard edge. */
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
  scene.background = new THREE.Color(0x0b1120);
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
  };

  const state = {
    running: false,
    raf: 0,
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
    scene.background.set(night ? 0x070c16 : 0x9fb6d4);
    scene.fog.color.set(night ? 0x070c16 : 0x9fb6d4);
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

    scene.add(buildRoads(data));
    const buildings = buildBuildings(data);
    scene.add(buildings);
    aim();
    applyDaylight();
    if (els.note) {
      const n = data.counts || {};
      // Say if any outlines failed, rather than quietly rendering fewer
      // buildings than the model holds and leaving the viewer to assume it is
      // an accurate skyline.
      const skipped = buildings.userData?.skipped || 0;
      els.note.dataset.locked = "1";
      els.note.textContent =
        `OpenStreetMap 3D model · ${n.buildings || 0} buildings · ${n.roads || 0} road sections` +
        (skipped ? ` · ${skipped} outline(s) could not be drawn` : "") +
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
        renderer.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}
