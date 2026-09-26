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

/** The road surface, as one merged mesh so the draw-call count stays sane. */
function buildRoads(scene) {
  const positions = [];
  const normals = [];
  const uvs = [];
  for (const road of scene.roads) {
    const half = road.width / 2;
    for (let i = 0; i < road.points.length - 1; i += 1) {
      const [ax, az] = road.points[i];
      const [bx, bz] = road.points[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      // Left normal of the direction of travel.
      const nx = -dz / len;
      const nz = dx / len;
      const ax1 = ax + nx * half;
      const az1 = az + nz * half;
      const ax2 = ax - nx * half;
      const az2 = az - nz * half;
      const bx1 = bx + nx * half;
      const bz1 = bz + nz * half;
      const bx2 = bx - nx * half;
      const bz2 = bz - nz * half;
      // Two triangles, flat and facing up.
      positions.push(ax1, 0, az1, bx1, 0, bz1, bx2, 0, bz2);
      positions.push(ax1, 0, az1, bx2, 0, bz2, ax2, 0, az2);
      for (let k = 0; k < 6; k += 1) normals.push(0, 1, 0);
      uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  const mat = new THREE.MeshLambertMaterial({ color: 0x3f4650 });
  return new THREE.Mesh(geo, mat);
}

/**
 * Buildings, extruded from their mapped footprints.
 *
 * ExtrudeGeometry wants a Shape. A mapped footprint is a ring, not a polygon with
 * holes, so the first and last point are closed explicitly. Anything that fails
 * to build is skipped rather than taking the whole scene down - one bad outline
 * in 239 buildings must not cost the other 238.
 */
function buildBuildings(scene) {
  const group = new THREE.Group();
  let built = 0;
  let skipped = 0;
  for (const b of scene.buildings) {
    try {
      const shape = new THREE.Shape();
      const ring = b.ring;
      shape.moveTo(ring[0][0], ring[0][1]);
      for (let i = 1; i < ring.length; i += 1) shape.lineTo(ring[i][0], ring[i][1]);
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: b.height,
        bevelEnabled: false,
      });
      // ExtrudeGeometry builds in XY; stand it up and drop it onto the ground.
      geo.rotateX(-Math.PI / 2);
      const shade = 0.55 + ((b.height % 7) / 7) * 0.2;
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color().setHSL(0.08, 0.06, Math.min(0.78, 0.42 + shade * 0.3)),
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = 0.02;
      group.add(mesh);
      built += 1;
    } catch {
      skipped += 1;
    }
  }
  group.userData = { built, skipped };
  return group;
}

function buildGround() {
  const geo = new THREE.PlaneGeometry(4200, 4200);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({ color: 0x2b3038 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.05;
  return mesh;
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
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1120);
  scene.fog = new THREE.Fog(0x0b1120, 260, 900);

  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.5, 3000);

  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a2f38, 1.05);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(-160, 260, 120);
  scene.add(sun);

  scene.add(buildGround());

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
    if (els.note) {
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
      els.note.textContent =
        `OpenStreetMap model · ${n.buildings || 0} buildings · ${n.roads || 0} road sections` +
        (skipped ? ` · ${skipped} outline(s) could not be drawn` : "");
    }
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
