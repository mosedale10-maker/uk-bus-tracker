import L from "leaflet";

/**
 * A virtual camera over Longton, Staffordshire.
 *
 * WHY THIS IS NOT CCTV, AND WHY IT IS CALLED A CAMERA ANYWAY
 * ----------------------------------------------------------
 * The National Highways photos are real CCTV frames from a public feed that
 * publishes both a camera list and a live image per camera. Nothing equivalent
 * exists for Longton: Stoke-on-Trent City Council publishes no open live camera
 * feed, and the nearest National Highways cameras are on the M6 and the A50,
 * several miles away. So there is no real picture of Longton high street to show,
 * and inventing one is not an option.
 *
 * What this is instead: a fixed viewpoint over Longton, drawn from the live bus
 * positions the tracker already receives, refreshing on a timer. It answers
 * "what is happening on the roads in Longton right now" honestly, and the frame
 * says so on its face. A rendered map that looked like CCTV footage would be
 * worse than useless - people would make claims about what they saw.
 *
 * The one thing it must never do is imply it is a photograph. Every label on the
 * frame, and the accessible name, say virtual view.
 */

/** The Strand / Market Street, Longton. */
export const LONGTON_CAMERA = {
  id: "longton",
  name: "Longton town centre",
  where: "The Strand / Market Street",
  lat: 53.0443,
  lon: -2.1068,
  /** How much road around the point counts as "in view". */
  radiusM: 1200,
  zoom: 15,
};

/**
 * Staffordshire operators. The bbox feed alone leaves big holes here - measured
 * over a live poll, a 2.5km box around Longton returned nothing while these
 * operator feeds returned live positions - so the camera asks for both, exactly
 * as the main map does.
 */
const STAFFS_OPS = ["FPOT", "DAGC", "CRDR", "SLBS"];

const REFRESH_MS = 20_000;

const OSM_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function haversineM(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

/** Pull a usable position out of a feed row. `coordinates` is a [lon, lat] pair. */
function positionOf(row) {
  const c = row?.coordinates;
  if (Array.isArray(c) && c.length >= 2) {
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  // Some feeds use an object instead of a pair.
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
  const line = svc.line_name || row.line || "";
  const noc = op.noc || svc.operator?.noc || row.operator || "";
  return {
    id: String(row.id || row.vehicle?.ref || `${noc}-${row.journey_id || ""}`),
    lat: pos.lat,
    lon: pos.lon,
    heading: Number.isFinite(Number(row.heading)) ? Number(row.heading) : null,
    when: row.datetime || null,
    line: String(line || ""),
    operator: String(noc || ""),
    operatorName: String(op.name || svc.operator?.name || noc || ""),
    destination: String(row.destination || ""),
    origin: String(row.origin || ""),
    direction: String(row.direction || ""),
    reg: String(veh.reg || ""),
    colour: String(veh.colour || ""),
  };
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Live buses around the camera point.
 *
 * Both feeds are fetched together and merged, because either one on its own
 * leaves holes: the bbox feed missed Longton entirely on a live check while the
 * operator feed had a bus 12km away, and there are hours after midnight when
 * neither has anything because local services have stopped.
 */
async function loadBuses(cam) {
  const dLat = cam.radiusM / 111_320;
  const dLon = cam.radiusM / (111_320 * Math.cos((cam.lat * Math.PI) / 180));
  const bbox = new URLSearchParams({
    xmin: (cam.lon - dLon).toFixed(5),
    ymin: (cam.lat - dLat).toFixed(5),
    xmax: (cam.lon + dLon).toFixed(5),
    ymax: (cam.lat + dLat).toFixed(5),
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
      const d = haversineM(cam.lat, cam.lon, bus.lat, bus.lon);
      // Only what the camera can actually see, and one row per vehicle.
      if (d > cam.radiusM) continue;
      const prev = seen.get(bus.id);
      if (prev && prev.distanceM <= d) continue;
      seen.set(bus.id, { ...bus, distanceM: Math.round(d) });
    }
  }
  return [...seen.values()].sort((a, b) => a.distanceM - b.distanceM);
}

function busIcon(bus) {
  const label = bus.line || bus.reg || "bus";
  const tint = bus.colour || "#38bdf8";
  const spin = Number.isFinite(bus.heading) && bus.heading !== 0 ? ` rotate(${bus.heading}deg)` : "";
  return L.divIcon({
    className: "lcam-pin leaflet-div-icon",
    html: `<div class="lcam-pin-body" style="--lcam-tint:${esc(tint)}">
        <span class="lcam-pin-arrow" style="${spin}" aria-hidden="true"></span>
        <span class="lcam-pin-label">${esc(label)}</span>
      </div>`,
    iconSize: [46, 26],
    iconAnchor: [23, 13],
    popupAnchor: [0, -14],
  });
}

function popupHtml(bus) {
  const rows = [
    ["Route", bus.line || "—"],
    ["Operator", bus.operatorName || bus.operator || "—"],
    ["Towards", bus.destination || "—"],
    ["From", bus.origin || "—"],
  ];
  if (bus.reg) rows.push(["Vehicle", bus.reg]);
  rows.push(["Distance from camera", `${bus.distanceM} m`]);
  if (bus.when) {
    const t = new Date(bus.when);
    if (!Number.isNaN(t.getTime())) {
      rows.push(["Position reported", t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })]);
    }
  }
  return `<div class="lcam-popup">
      <strong>${esc(bus.line || "Bus")}</strong>
      <table>${rows
        .map(
          ([k, v]) =>
            `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`,
        )
        .join("")}</table>
      <p class="lcam-popup-note">Live GPS position, not a photograph.</p>
    </div>`;
}

export function createLongtonCamera(container) {
  if (!container) return null;
  const cam = LONGTON_CAMERA;

  const map = L.map(container, {
    center: [cam.lat, cam.lon],
    zoom: cam.zoom,
    zoomControl: false,
    attributionControl: true,
    // A camera does not scroll, drag or zoom. If the view could be moved it
    // would stop being a fixed viewpoint, and the count in the corner would
    // stop meaning "within the radius this camera covers".
    scrollWheelZoom: false,
    dragging: false,
    touchZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    tap: false,
  });
  L.tileLayer(OSM_TILES, { attribution: OSM_ATTR, maxZoom: 19 }).addTo(map);

  // The point the camera is mounted at.
  L.circleMarker([cam.lat, cam.lon], {
    radius: 5,
    color: "#f8fafc",
    weight: 2,
    fillColor: "#ef4444",
    fillOpacity: 0.9,
  })
    .bindTooltip(`${cam.where} — camera position`, { direction: "top" })
    .addTo(map);

  const layer = L.layerGroup().addTo(map);
  const state = { timer: null, active: false, buses: [], lastAt: 0, failed: false, inflight: false };

  const els = {
    count: container.querySelector("[data-lcam-count]"),
    updated: container.querySelector("[data-lcam-updated]"),
    status: container.querySelector("[data-lcam-status]"),
  };

  function renderClock() {
    const now = new Date();
    const clock = container.querySelector("[data-lcam-clock]");
    if (clock) clock.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function paint(buses) {
    layer.clearLayers();
    for (const bus of buses) {
      L.marker([bus.lat, bus.lon], {
        icon: busIcon(bus),
        keyboard: true,
        riseOnHover: true,
        title: `${bus.line || "Bus"} ${bus.destination || ""}`.trim(),
      })
        .bindPopup(popupHtml(bus), { maxWidth: 280, className: "lcam-popup-wrap" })
        .addTo(layer);
    }
    if (els.count) els.count.textContent = String(buses.length);
    if (els.status) {
      // An empty frame is a real answer, not an error: local services stop at
      // night. Say which it is rather than leaving a blank box.
      els.status.textContent = buses.length
        ? ""
        : "No buses on the roads in view right now. Local services finish for the day, so this is expected overnight.";
      els.status.hidden = buses.length > 0;
    }
  }

  async function refresh() {
    if (state.inflight) return;
    state.inflight = true;
    const buses = await loadBuses(cam);
    state.inflight = false;
    state.buses = buses;
    state.lastAt = Date.now();
    paint(buses);
    if (els.updated) {
      els.updated.textContent = new Date(state.lastAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }
  }

  async function start() {
    if (state.active) return;
    state.active = true;
    // The container is display:none until the tab is opened, so Leaflet cannot
    // have measured it. Without this the tiles come back as one grey block.
    requestAnimationFrame(() => {
      try {
        map.invalidateSize();
      } catch {
        /* ignore */
      }
    });
    renderClock();
    await refresh();
    state.timer = setInterval(() => {
      renderClock();
      refresh();
    }, REFRESH_MS);
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.active = false;
  }

  renderClock();
  const clockTimer = setInterval(renderClock, 1000);

  return {
    start,
    stop,
    refresh,
    destroy() {
      stop();
      clearInterval(clockTimer);
      map.remove();
    },
    state,
    camera: cam,
  };
}
