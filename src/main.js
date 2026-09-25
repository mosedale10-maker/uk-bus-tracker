import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { createFleetBrowser, isSchoolBusLive, isStokeFcShuttleLive, isStokeFcLine, sameServiceLine, normalizeStokeFcLine, extractRouteFromVehicle, enrichJourneyRow, liveVehicleAsHistoryRow, mergeLiveHistoryRow, fetchAtHistoryFromTrails, mergeAtHistoryRows, fetchCoachHistoryFromTrails, isDivertedText, STAFFS_SCHOOL_ROUTES, STOKE_FC_SHUTTLE_ROUTES } from "./fleet.js";
import { setupPlus, isPlus, requirePlus, syncPlusFromAccount } from "./plus.js";
import { getUser } from "./auth.js";
import {
  atStopsInBounds,
  atStopByAtco,
  atFeatureFromStop,
  atLiveDeparturesForStop,
} from "./at-stops.js";
import {
  scfcStopsInBounds,
  scfcStopByAtco,
  scfcFeatureFromStop,
  scfcLiveDeparturesForStop,
  scfcScheduledDeparturesForStop,
} from "./scfc-stops.js";
import { setupAuth } from "./auth.js";
import { brandLiveryForBus, brandColourForBus, brandLiveryForLine } from "./operator-liveries.js";
import { fleetLiveryForBus } from "./fleet-liveries.js";
import "./style.css";

window.L = L;

const MIN_ZOOM = 8;
const FLIX_MIN_ZOOM = 6;
const UK_TZ = "Europe/London";

/** Rough Staffordshire + Potteries box — when the map overlaps this, always load local operators. */
const STAFFS_VIEW_BBOX = { south: 52.55, north: 53.28, west: -2.6, east: -1.65 };
/** Operators treated as Staffordshire for stale-ping / trail helpers. */
const STAFFS_LIVE_OPS = ["FPOT", "DAGC", "CRDR", "SLBS", "BANG", "HIPK", "TBTN", "DIAM", "MDCL", "SOST"];
/**
 * Force-load these when the view covers Staffs (bbox polls can miss overnight / sparse AVL).
 * Keep this short — full TBTN/DIAM/HIPK fleets previously flooded nginx and killed /api/bt-paint
 * (liveries vanished while pins still showed).
 */
const STAFFS_FORCE_OPS = ["FPOT", "DAGC", "CRDR", "SLBS", "BANG", "SOST"];

const MAP_VIEW_STORAGE_KEY = "uk-bus-map-view-v1";
const DEFAULT_MAP_VIEW = { lat: 54.2, lng: -2.5, zoom: 7 };
let appTab = "home";

function savedMapView() {
  try {
    const raw = localStorage.getItem(MAP_VIEW_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MAP_VIEW };
    const value = JSON.parse(raw);
    const lat = Number(value?.lat);
    const lng = Number(value?.lng);
    const zoom = Number(value?.zoom);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      !Number.isFinite(zoom) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180 ||
      zoom < 2 ||
      zoom > 19
    ) {
      return { ...DEFAULT_MAP_VIEW };
    }
    return { lat, lng, zoom };
  } catch {
    return { ...DEFAULT_MAP_VIEW };
  }
}

const initialMapView = savedMapView();

function mapOverlapsStaffordshire(bounds = map.getBounds()) {
  try {
    const b = bounds || map.getBounds();
    return (
      b.getSouth() < STAFFS_VIEW_BBOX.north &&
      b.getNorth() > STAFFS_VIEW_BBOX.south &&
      b.getWest() < STAFFS_VIEW_BBOX.east &&
      b.getEast() > STAFFS_VIEW_BBOX.west
    );
  } catch {
    return false;
  }
}

/** Leave History · Map / Map · tails mode so live Staffs buses can load again. */
function exitHistoryMapMode({ reload = false } = {}) {
  const had =
    Boolean(playback) || Boolean(multiTailActiveGroup) || pinnedTrailKeys.size > 0;
  if (playback) stopRoutePlayback("", { clearTail: true });
  else clearPinnedTrails();
  if (had && reload) loadBuses({ replace: true }).catch(() => {});
  return had;
}

const map = L.map("map", { zoomControl: true }).setView(
  [initialMapView.lat, initialMapView.lng],
  initialMapView.zoom,
);

function saveMapView() {
  try {
    const center = map.getCenter();
    const zoom = map.getZoom();
    if (
      !center ||
      !Number.isFinite(center.lat) ||
      !Number.isFinite(center.lng) ||
      !Number.isFinite(zoom)
    ) {
      return;
    }
    localStorage.setItem(
      MAP_VIEW_STORAGE_KEY,
      JSON.stringify({ lat: center.lat, lng: center.lng, zoom }),
    );
  } catch {
    // Storage can be disabled in private browsing; the map still works normally.
  }
}

/** Day / night street basemap — OSM tiles (no API key). Night look via CSS filter on the tile pane.
 *  Carto free URLs now watermark “API KEY REQUIRED” and blank the map. */
const dayStreetsLayer = L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  },
);

/** Streets group so the layer control keeps one "Streets" entry while we swap day/night tiles. */
const streetsLayer = L.layerGroup([dayStreetsLayer]);

const satelliteLayer = L.layerGroup([
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution:
        "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
      maxZoom: 19,
    },
  ),
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, pane: "overlayPane" },
  ),
]);

streetsLayer.addTo(map);

/** 'streets' = auto day/night; 'satellite' = leave alone. */
let mapBaseKind = "streets";
let mapIsNight = null;

/**
 * Approximate solar elevation (degrees) at lat/lng (NOAA-style).
 * Positive = above horizon; civil twilight ≈ −6°.
 */
function solarElevationDeg(date, lat, lng) {
  const rad = Math.PI / 180;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor(
    (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
      start) /
      86400000,
  );
  const minutes =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60;
  const gamma =
    ((2 * Math.PI) / 365) * (dayOfYear - 1 + (minutes / 1440 - 0.5));
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const trueSolarTime = minutes + eqTime + 4 * lng;
  let ha = trueSolarTime / 4 - 180;
  while (ha < -180) ha += 360;
  while (ha > 180) ha -= 360;
  const latR = lat * rad;
  const cosZen =
    Math.sin(latR) * Math.sin(decl) +
    Math.cos(latR) * Math.cos(decl) * Math.cos(ha * rad);
  return Math.asin(Math.min(1, Math.max(-1, cosZen))) / rad;
}

/** Night once the sun is below civil twilight (−6°); day once it rises above. */
function shouldUseNightMap(lat, lng, when = new Date()) {
  const elev = solarElevationDeg(when, lat, lng);
  // Hysteresis so dawn/dusk does not flicker the tiles.
  if (mapIsNight === true) return elev < -4;
  if (mapIsNight === false) return elev < -6;
  return elev < -6;
}

function applyMapDayNight({ force = false } = {}) {
  if (mapBaseKind !== "streets") return;
  const c = map.getCenter();
  const wantNight = shouldUseNightMap(c.lat, c.lng);
  if (!force && wantNight === mapIsNight) return;
  mapIsNight = wantNight;
  // One OSM tile layer; night is a CSS invert on the tile pane (no Carto API key).
  if (!streetsLayer.hasLayer(dayStreetsLayer)) streetsLayer.addLayer(dayStreetsLayer);
  document.documentElement.classList.toggle("map-night", wantNight);
  document.documentElement.classList.toggle("map-day", !wantNight);
}

L.control
  .layers(
    { Streets: streetsLayer, Satellite: satelliteLayer },
    {},
    { position: "bottomright", collapsed: false },
  )
  .addTo(map);

map.on("baselayerchange", (e) => {
  if (e?.layer === satelliteLayer) {
    mapBaseKind = "satellite";
    document.documentElement.classList.remove("map-night", "map-day");
    return;
  }
  if (e?.layer === streetsLayer) {
    mapBaseKind = "streets";
    applyMapDayNight({ force: true });
  }
});

applyMapDayNight({ force: true });
setInterval(() => applyMapDayNight(), 60_000);

// Always show every bus — no numbered cluster bubbles when zoomed out.
const cluster = L.layerGroup().addTo(map);
const staffLayer = L.layerGroup().addTo(map);
const stopsLayer = L.layerGroup();
const noticesLayer = L.layerGroup().addTo(map);
const depotsLayer = L.layerGroup().addTo(map);

/** Stoke-on-Trent bus depots — small pins when zoomed into the area. */
const BUS_DEPOTS = [
  {
    id: "first-potteries-adderley-green",
    lat: 53.00185,
    lng: -2.12082,
    name: "First Potteries",
    place: "Adderley Green depot",
    address: "Dividy Road, ST3 5YY",
    color: "#c8102e",
  },
  {
    id: "dg-mossfield",
    // OSM industrial yard “D & G Bus” on Mossfield Road (not ST3 5BW centroid)
    lat: 53.00377,
    lng: -2.13389,
    name: "D&G Bus",
    place: "Mossfield Road depot",
    address: "Mossfield Road, ST3 5BW",
    color: "#e85d04",
  },
  {
    id: "stantons-endon",
    // Park Farm yard (OSM barn/farmyard cluster off Park Lane, ST9 9JB)
    lat: 53.07459,
    lng: -2.08982,
    name: "Stanton's of Stoke",
    place: "Park Farm depot",
    address: "Park Lane, Endon, ST9 9JB",
    color: "#b91c1c",
  },
  {
    id: "scraggs-parkhall",
    // New Parkhall Industrial Estate / Coach Depot, Parkhall Road
    lat: 52.99937,
    lng: -2.11857,
    name: "Scraggs Coaches",
    place: "Parkhall Road depot",
    address: "Parkhall Road, Adderley Green, ST3 5AT",
    color: "#1d4ed8",
  },
];

/** Temporary map notices (road closures / diversions). Active only between `from` and `until`. */
const ROAD_NOTICES = [
  {
    id: "longton-market-st-sep-2026",
    lat: 52.9889,
    lng: -2.1344,
    title: "Road closed · Longton",
    body: "From 7pm Thursday 24th September until 3pm Sunday 27th September road closed. Buses heading to Bentilee and Meir will use Longton Bus Station.",
    // Times Square → Market Street → start of Anchor Road
    path: [
      [52.98957, -2.13593],
      [52.98925, -2.1352],
      [52.98895, -2.13445],
      [52.98865, -2.1337],
      [52.98845, -2.1332],
    ],
    // Sign goes live 6:40pm, though the wording above still says 7pm.
    from: "2026-09-24T18:40:00+01:00",
    until: "2026-09-27T15:00:00+01:00",
  },
];

function roadNoticeIsActive(notice, now = Date.now()) {
  if (!notice) return false;
  if (notice.from) {
    const start = new Date(notice.from).getTime();
    if (Number.isFinite(start) && now < start) return false;
  }
  if (notice.until) {
    const end = new Date(notice.until).getTime();
    if (Number.isFinite(end) && now > end) return false;
  }
  return true;
}

function roadNoticeIcon(notice, { compact = false } = {}) {
  return L.divIcon({
    className: "road-notice-marker leaflet-div-icon",
    html: `<div class="road-notice-pin${compact ? " is-compact" : ""}" role="img" aria-label="${esc(notice.title)}">
      <div class="road-notice-box">
        <strong>${esc(notice.title)}</strong>
        <p>${esc(notice.body)}</p>
      </div>
      <div class="road-notice-stem" aria-hidden="true">
        <span class="road-notice-dot">!</span>
        <span class="road-notice-point"></span>
      </div>
    </div>`,
    iconSize: compact ? [30, 34] : [196, 112],
    iconAnchor: compact ? [15, 34] : [98, 112],
    popupAnchor: compact ? [0, -30] : [0, -104],
  });
}

function installRoadNotices() {
  noticesLayer.clearLayers();
  const now = Date.now();
  const zoom = map.getZoom();
  // Hide until fairly zoomed in so a Longton notice does not float over the whole UK.
  if (zoom < 11) return;
  const compact = zoom < 14;
  for (const notice of ROAD_NOTICES) {
    if (!roadNoticeIsActive(notice, now)) continue;
    if (Array.isArray(notice.path) && notice.path.length >= 2) {
      L.polyline(notice.path, {
        color: "#c2410c",
        weight: compact ? 4 : 6,
        opacity: 0.9,
        dashArray: "8 6",
        lineCap: "round",
        lineJoin: "round",
        className: "road-notice-line",
      }).addTo(noticesLayer);
    }
    const marker = L.marker([notice.lat, notice.lng], {
      icon: roadNoticeIcon(notice, { compact }),
      interactive: true,
      keyboard: true,
      zIndexOffset: 1200,
      riseOnHover: true,
    });
    marker.bindPopup(
      `<div class="road-notice-popup"><strong>${esc(notice.title)}</strong><p>${esc(notice.body)}</p></div>`,
      { maxWidth: 300, className: "road-notice-popup-wrap", autoClose: false, closeOnClick: false },
    );
    marker._roadNotice = notice;
    marker.addTo(noticesLayer);
    // Do NOT auto-open the popup — it rendered as a large dark box over the map.
    // The pin itself carries the title, and tapping it still opens the full message.
  }
}

function depotIcon(depot) {
  const color = depot.color || "#334155";
  return L.divIcon({
    className: "depot-marker leaflet-div-icon",
    html: `<div class="depot-pin" style="--depot-color:${esc(color)}" role="img" aria-label="${esc(depot.name)} depot">
      <span class="depot-pin-dot" aria-hidden="true"></span>
      <span class="depot-pin-point" aria-hidden="true"></span>
    </div>`,
    iconSize: [18, 24],
    iconAnchor: [9, 24],
    popupAnchor: [0, -22],
  });
}

function installBusDepots() {
  depotsLayer.clearLayers();
  const zoom = map.getZoom();
  if (zoom < 13) return;
  const bounds = map.getBounds();
  for (const depot of BUS_DEPOTS) {
    if (!bounds.contains([depot.lat, depot.lng])) continue;
    const marker = L.marker([depot.lat, depot.lng], {
      icon: depotIcon(depot),
      interactive: true,
      keyboard: true,
      zIndexOffset: 400,
      riseOnHover: true,
      title: `${depot.name} · ${depot.place}`,
    });
    marker.bindPopup(
      `<div class="depot-popup"><strong>${esc(depot.name)}</strong><p>${esc(depot.place)}</p><p class="depot-popup-addr">${esc(depot.address)}</p></div>`,
      { maxWidth: 220, className: "depot-popup-wrap" },
    );
    marker.addTo(depotsLayer);
  }
}

function refreshRoadNoticeIcons() {
  // Rebuild so show/hide by zoom and map position stays correct.
  installRoadNotices();
  installBusDepots();
}

map.on("zoomend moveend", refreshRoadNoticeIcons);
const STOPS_KEY = "uk-bus-stops-on";
const STOP_BOARD_KEY = "uk-bus-stop-board-on";
const STOPS_MIN_ZOOM = 14;
const STOPS_MAX = 700;
let stopsOn = localStorage.getItem(STOPS_KEY) === "1";
let stopBoardOn = localStorage.getItem(STOP_BOARD_KEY) === "1" && isPlus();
let stopsAbort = null;
let stopsLoadTimer = null;
let stopBoardAtco = "";
let stopBoardFeature = null;
let stopBoardRefreshTimer = null;
let stopBoardClockTimer = null;

const markers = new Map();
const staffMarkers = new Map();
const ALTON_LINES = new Set(["AT1", "AT2", "AT3"]);
/** Operators where Map always means one vehicle + one route (never the whole fleet). */
const SINGLE_VEHICLE_ROUTE_NOCS = new Set(["FLIX", "NATX", "DAGC", "FPOT", "SOST"]);
let multiTailActiveGroup = null;
/** Optional journey/line filter applied when drawing a pinned trail key. */
const pinnedTrailFilters = new Map();
const tripCache = new Map();
const tripCacheAt = new Map();
const vehicleCache = new Map();
const stopCache = new Map();
const dgVehicleCache = new Map();
const firstStopCache = new Map();
const bodsCache = { key: "", at: 0, items: [] };
let staffRoutesPromise = null;
let pendingFocus = null;
let liveIndex = null;
let liveIndexAt = 0;

const messageEl = document.getElementById("message");

/**
 * Auto-update: poll the server's build id and reload when it changes, so a deploy
 * reaches open tabs without a manual refresh. Assets are content-hashed, so a plain
 * reload always pulls the new bundle. Pauses while the tab is hidden and skips the
 * first check so a just-loaded page never bounces.
 */
function watchForNewBuild() {
  const POLL_MS = 60_000;
  let current = "";
  let timer = null;
  const start = () => {
    if (timer) return;
    timer = setInterval(check, POLL_MS);
  };
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  async function check() {
    if (document.hidden) return;
    try {
      const res = await fetch("/api/build", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const build = String(data?.build || "");
      if (!build) return;
      if (!current) {
        current = build;
        return;
      }
      if (build !== current) {
        stop();
        location.reload();
      }
    } catch {
      /* offline or transient — try again next tick */
    }
  }
  // Establish the baseline immediately, then poll.
  check();
  start();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else {
      check();
      start();
    }
  });
}

watchForNewBuild();

const clockEl = document.getElementById("uk-clock");
const clockDateEl = document.getElementById("uk-clock-date");
const clockTimeEl = document.getElementById("uk-clock-time");
const liveBusCountEl = document.getElementById("live-bus-count");
const homeLiveCountEl = document.getElementById("home-live-count");
const mapWrapEl = document.querySelector(".map-wrap");
const hint = document.createElement("div");
hint.className = "zoom-hint";
hint.hidden = true;
mapWrapEl.append(hint);

const WELCOME_KEY = "uk-bus-welcome-v1";
const welcomeEl = document.getElementById("map-welcome");

function dismissWelcome() {
  try {
    localStorage.setItem(WELCOME_KEY, "1");
  } catch {
    /* ignore */
  }
  if (welcomeEl) welcomeEl.hidden = true;
  maybeShowControlRoomAlert();
}

function setupWelcome() {
  if (!welcomeEl) return;
  let seen = false;
  try {
    seen = localStorage.getItem(WELCOME_KEY) === "1";
  } catch {
    seen = false;
  }
  if (seen) {
    welcomeEl.hidden = true;
    return;
  }
  welcomeEl.hidden = false;
  document.getElementById("map-welcome-close")?.addEventListener("click", dismissWelcome);
  document.getElementById("map-welcome-gotit")?.addEventListener("click", dismissWelcome);
  document.getElementById("search-form")?.addEventListener(
    "submit",
    () => {
      dismissWelcome();
    },
    { once: true },
  );
  map.once("zoomend", () => {
    if (map.getZoom() >= MIN_ZOOM) dismissWelcome();
  });
}

function syncMapZoomClass() {
  if (!mapWrapEl) return;
  const z = map.getZoom();
  mapWrapEl.classList.toggle("is-zoom-wide", z < MIN_ZOOM);
  mapWrapEl.classList.toggle("is-zoom-mid", z >= MIN_ZOOM && z < 15);
  mapWrapEl.classList.toggle("is-zoom-close", z >= 15);
  // Trail direction arrows: much smaller when zoomed out.
  mapWrapEl.classList.toggle("trail-arrows-sm", z < 13);
  mapWrapEl.classList.toggle("trail-arrows-md", z >= 13 && z < 15);
  mapWrapEl.classList.toggle("trail-arrows-lg", z >= 15);
}

function refreshMarkerIconsForZoom() {
  for (const marker of markers.values()) {
    const bus = marker.bus;
    if (!bus) continue;
    const heading = Number(marker.bus?.heading);
    const iconKey = busIconKey(bus, heading, bus.speedMph);
    if (marker._iconKey === iconKey) continue;
    marker._iconKey = iconKey;
    marker.setIcon(busIcon(bus, heading));
  }
  for (const marker of staffMarkers.values()) {
    const item = marker.staff;
    if (!item) continue;
    const heading = Number(item.positioning?.bearing) || 0;
    const zoomBand = map.getZoom() >= 15 ? "close" : "mid";
    const iconKey = `${zoomBand}|${marker.line}|${Math.round(heading)}|${speedBucket(item.speedMph)}|${liveryCss(marker.staffLivery) || ""}`;
    if (marker._iconKey === iconKey) continue;
    marker._iconKey = iconKey;
    marker.setIcon(staffIcon(marker.line, heading, marker.staffLivery, item.speedMph));
  }
}

setupWelcome();

/** Staffordshire control-room + operator alerts */
const CONTROL_ALERT_KEY = "uk-bus-control-alert";
const controlRoomAlertEl = document.getElementById("control-room-alert");
const roadNoticeAlertEl = document.getElementById("road-notice-alert");
const alertsPanelEl = document.getElementById("alerts-panel");
const alertsBtnEl = document.getElementById("alerts-btn");
const alertsBadgeEl = document.getElementById("alerts-badge");
const alertsListEl = document.getElementById("alerts-panel-list");
let liveNotices = [];
let controlAlertTimer = null;
const CONTROL_ALERT_MS = 75_000;

function controlAlertDismissed(id) {
  try {
    return localStorage.getItem(`${CONTROL_ALERT_KEY}:${id}`) === "1";
  } catch {
    return false;
  }
}

function rememberControlAlertDismissed(id) {
  try {
    localStorage.setItem(`${CONTROL_ALERT_KEY}:${String(id || "")}`, "1");
  } catch {
    /* ignore */
  }
}

function clearControlAlertTimer() {
  if (controlAlertTimer) {
    clearTimeout(controlAlertTimer);
    controlAlertTimer = null;
  }
}

function dismissControlRoomAlert() {
  clearControlAlertTimer();
  const notice = controlRoomAlertEl?._notice;
  if (notice?.id) rememberControlAlertDismissed(notice.id);
  if (controlRoomAlertEl) controlRoomAlertEl.hidden = true;
}

function setAlertsPanelOpen(open) {
  if (!alertsPanelEl || !alertsBtnEl) return;
  alertsPanelEl.hidden = !open;
  alertsBtnEl.setAttribute("aria-pressed", open ? "true" : "false");
}

function renderAlertsPanel() {
  if (!alertsListEl) return;
  if (!liveNotices.length) {
    alertsListEl.innerHTML = `<p class="alerts-empty">No active Stoke-on-Trent alerts</p>`;
    return;
  }
  alertsListEl.innerHTML = liveNotices
    .map((n) => {
      const kind =
        n.kind === "control_room"
          ? `<span class="alerts-item-kind is-control">Control room</span>`
          : `<span class="alerts-item-kind">Operator</span>`;
      const meta = [n.operator, n.routes, n.area].filter(Boolean).join(" · ");
      const link = n.sourceUrl
        ? `<div class="alerts-item-meta"><a href="${esc(n.sourceUrl)}" target="_blank" rel="noopener noreferrer">Source</a></div>`
        : "";
      return `<article class="alerts-item">
        ${kind}
        <p class="alerts-item-title">${esc(n.title)}</p>
        <p class="alerts-item-body">${esc(n.body || "")}</p>
        ${meta ? `<p class="alerts-item-meta">${esc(meta)}</p>` : ""}
        ${link}
      </article>`;
    })
    .join("");
}

function updateAlertsBadge() {
  if (!alertsBadgeEl) return;
  const n = liveNotices.length;
  if (!n) {
    alertsBadgeEl.hidden = true;
    alertsBadgeEl.textContent = "0";
    return;
  }
  alertsBadgeEl.hidden = false;
  alertsBadgeEl.textContent = String(n > 99 ? "99+" : n);
}

function maybeShowControlRoomAlert() {
  if (!controlRoomAlertEl) return;
  if (welcomeEl && !welcomeEl.hidden) return;
  if (roadNoticeAlertEl && !roadNoticeAlertEl.hidden) return;
  const notice = liveNotices.find(
    (n) => n.kind === "control_room" && n.id != null && !controlAlertDismissed(n.id),
  );
  if (!notice) {
    clearControlAlertTimer();
    controlRoomAlertEl.hidden = true;
    return;
  }
  const titleEl = document.getElementById("control-room-alert-title");
  const bodyEl = controlRoomAlertEl.querySelector("[data-control-alert-body]");
  if (titleEl) titleEl.textContent = notice.title || "Control room";
  if (bodyEl) bodyEl.textContent = notice.body || "";
  controlRoomAlertEl._notice = notice;
  controlRoomAlertEl.hidden = false;
  if (notice.speak && announceOn) {
    const line = [notice.title, notice.body].filter(Boolean).join(". ");
    speak(`Control room. ${line}`, { force: true });
  }
  clearControlAlertTimer();
  controlAlertTimer = setTimeout(() => {
    dismissControlRoomAlert();
  }, CONTROL_ALERT_MS);
}

async function loadServiceNotices() {
  try {
    const res = await fetch("/api/notices?limit=40");
    if (!res.ok) return;
    const data = await res.json();
    liveNotices = Array.isArray(data.notices) ? data.notices : [];
    updateAlertsBadge();
    renderAlertsPanel();
    maybeShowControlRoomAlert();
  } catch {
    /* keep last good list */
  }
}

function setupServiceAlerts() {
  alertsBtnEl?.addEventListener("click", () => {
    const open = alertsPanelEl?.hidden !== false;
    setAlertsPanelOpen(open);
    if (open) renderAlertsPanel();
  });
  document.getElementById("alerts-panel-close")?.addEventListener("click", () => {
    setAlertsPanelOpen(false);
  });
  controlRoomAlertEl?.querySelectorAll("[data-control-alert-close]").forEach((btn) => {
    btn.addEventListener("click", dismissControlRoomAlert);
  });
  controlRoomAlertEl?.querySelector("[data-control-alert-all]")?.addEventListener("click", () => {
    dismissControlRoomAlert();
    setAlertsPanelOpen(true);
    renderAlertsPanel();
  });
  loadServiceNotices();
  setInterval(loadServiceNotices, 5 * 60_000);
}

setupServiceAlerts();
syncMapZoomClass();
map.on("zoomend", () => {
  syncMapZoomClass();
  refreshMarkerIconsForZoom();
});

let inflight = null;
let timer = null;
let coastTimer = null;
let liveScheduleRunning = false;
let busesBusy = false;
let busesGen = 0;
/** Last bustimes paint rows — reused on BODS position polls so pins stay light/fast. */
let lastPaintBuses = [];
let lastCoachPaintBuses = [];
let lastPaintAt = 0;
let lastPaintRequestAt = 0;
let lastPaintViewKey = "";
const PAINT_REFRESH_MS = 60_000;
const PAINT_MOVE_REFRESH_MS = 15_000;
const PAINT_STAFF_RETRY_MS = 30_000;
const BUS_POLL_MS = 6000;
const STALE_PING_MS = 5 * 60 * 1000;
/** Staffs Ticketer buses often sit quietly at termini on overnight routes — keep them a bit longer. */
const STAFFS_STALE_PING_MS = 20 * 60 * 1000;
/** Only bridge short gaps between AVL polls — never keep driving once the feed stalls. */
const COAST_MIN_AGE_MS = 900;
const COAST_MAX_AGE_MS = 4500;
// Do not extrapolate authoritative AVL positions: replacing the bus object on
// each poll otherwise discards coast state and makes markers snap backwards.
const COAST_MAX_M = 0;

function showMessage(text) {
  messageEl.hidden = !text;
  messageEl.textContent = text || "";
}

function pingAgeMs(iso) {
  if (!iso) return 0;
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return 0;
  return Date.now() - at;
}

function stalePingLimitMs(bus) {
  return STALE_PING_MS;
}

function isStalePing(iso, limitMs = STALE_PING_MS) {
  return pingAgeMs(iso) > limitMs;
}

function pruneStaleMarkers() {
  for (const [id, marker] of markers) {
    if (!isStalePing(marker.bus?.datetime, stalePingLimitMs(marker.bus))) continue;
    dropServiceBus(id);
    motion.delete(`bus-${id}`);
  }
  for (const [id, marker] of staffMarkers) {
    if (!isStalePing(marker.staff?.recordedAtTime)) continue;
    staffLayer.removeLayer(marker);
    staffMarkers.delete(id);
    if (announceFollow === marker) announceFollow = null;
    if (isFollowingMarker(marker)) stopFollowBus("Lost live position for that bus");
    motion.delete(`staff-${id}`);
  }
}

let ukLiveBusCount = null;
let ukLiveBusCountAt = 0;
let ukLiveBusCountPromise = null;
let liveCountTimer = null;

function syncHomeLiveCountPolling() {
  if (liveCountTimer) {
    clearInterval(liveCountTimer);
    liveCountTimer = null;
  }
  if (appTab !== "home" || document.hidden) return;
  refreshUkLiveBusCount()
    .then(() => updateLiveBusCount())
    .catch(() => {});
  liveCountTimer = setInterval(() => {
    refreshUkLiveBusCount()
      .then(() => updateLiveBusCount())
      .catch(() => {});
  }, 30_000);
}

async function refreshUkLiveBusCount({ force = false } = {}) {
  if (!force && ukLiveBusCount != null && Date.now() - ukLiveBusCountAt < 25_000) {
    return ukLiveBusCount;
  }
  if (ukLiveBusCountPromise) return ukLiveBusCountPromise;
  ukLiveBusCountPromise = (async () => {
    try {
      const res = await fetch("/api/live-count");
      if (!res.ok) throw new Error("live_count_failed");
      const data = await res.json();
      const n = Number(data?.count);
      if (Number.isFinite(n) && n >= 0) {
        ukLiveBusCount = Math.round(n);
        ukLiveBusCountAt = Date.now();
      }
      return ukLiveBusCount;
    } catch {
      return ukLiveBusCount;
    } finally {
      ukLiveBusCountPromise = null;
    }
  })();
  return ukLiveBusCountPromise;
}

function updateLiveBusCount() {
  if (!liveBusCountEl && !homeLiveCountEl) return;
  const n = ukLiveBusCount;
  let text = "";
  if (n == null) {
    text = "Counting UK buses…";
  } else if (n === 0) {
    text = "No buses tracked across the UK right now";
  } else if (n === 1) {
    text = "1 bus currently tracked across the UK";
  } else {
    text = `${n.toLocaleString("en-GB")} buses currently tracked across the UK`;
  }
  if (liveBusCountEl) {
    if (n == null && liveBusCountEl.textContent) {
      /* keep existing while loading */
    } else {
      liveBusCountEl.textContent = text;
    }
  }
  if (homeLiveCountEl) homeLiveCountEl.textContent = text;
}

function updateUkClock() {
  const now = new Date();
  if (clockEl) clockEl.dateTime = now.toISOString();
  const dateText = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(now);
  const timeText = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(now);
  if (clockDateEl) clockDateEl.textContent = dateText;
  if (clockTimeEl) clockTimeEl.textContent = timeText;
  updateLiveBusCount();
}

function formatDelay(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "Timing unknown";
  const mins = Math.round(Number(seconds) / 60);
  if (mins === 0) return "On time";
  if (mins > 0) return `${mins} min late`;
  return `${Math.abs(mins)} min early`;
}

function delayClass(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "";
  const mins = Math.round(Number(seconds) / 60);
  if (mins >= 3) return "is-late";
  if (mins <= -2) return "is-early";
  return "is-ontime";
}

function parseClockSeconds(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  const iso = s.match(/T(\d{2}):(\d{2})(?::(\d{2}))?/);
  const clock = iso || s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!clock) return null;
  return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] || 0);
}

function clockLabel(value) {
  if (value == null || value === "") return "";
  const s = String(value).trim();
  const iso = s.match(/T(\d{2}):(\d{2})/);
  if (iso) return `${iso[1]}:${iso[2]}`;
  const clock = s.match(/^(\d{1,2}):(\d{2})/);
  if (!clock) return "";
  return `${String(clock[1]).padStart(2, "0")}:${clock[2]}`;
}

function rowAimed(row) {
  return row?.aimed_departure_time || row?.aimed_arrival_time || row?.aimed || "";
}

function rowLive(row) {
  return (
    row?.actual_departure_time ||
    row?.actual_arrival_time ||
    row?.expected_departure_time ||
    row?.expected_arrival_time ||
    row?.expected ||
    ""
  );
}

function stopDelaySeconds(row) {
  const aimed = parseClockSeconds(rowAimed(row));
  const live = parseClockSeconds(rowLive(row));
  if (aimed == null || live == null) return null;
  return wrapDelay(live - aimed);
}

function tripDelaySeconds(times) {
  let last = null;
  for (const row of times || []) {
    const delay = stopDelaySeconds(row);
    if (delay == null) continue;
    last = delay;
    const departed = Boolean(row.actual_departure_time || row.actual_arrival_time);
    if (!departed) return delay;
  }
  return last;
}

/** Delay from already-mapped card stops (expected/actual vs aimed). */
function tripDelaySecondsFromStops(stops) {
  let last = null;
  for (const stop of stops || []) {
    if (stop?.delaySec == null || Number.isNaN(Number(stop.delaySec))) continue;
    last = Number(stop.delaySec);
    if (!stop.done) return last;
  }
  return last;
}

/**
 * Live early/late for the bus card.
 * Prefer real feed Delay, then bustimes expected−aimed, then schedule vs clock.
 * Never treat missing delay (null) as 0 via Number(null) → "On time".
 */
function readFeedDelaySec(bus) {
  const raw = bus?.delay;
  if (raw == null || raw === "") return null;
  const feed = Number(raw);
  return Number.isFinite(feed) ? feed : null;
}

function resolveLiveDelaySec(bus, extra = {}, lat, lng, { live = false } = {}) {
  const feed = readFeedDelaySec(bus);
  if (feed != null) return feed;
  const fromStops = tripDelaySecondsFromStops(extra.stops);
  // Bustimes expected−aimed is the real lateness; wall-clock vs aimed of the
  // nearest stop often reads "On time" while the service is several minutes late.
  if (fromStops != null) return fromStops;
  const inferred = inferDelaySeconds(
    extra.stops,
    lat,
    lng,
    live ? null : bus?.datetime,
  );
  if (inferred != null) return inferred;
  const sticky = Number(extra.delaySec);
  return Number.isFinite(sticky) ? sticky : null;
}

function tripIdForMarker(marker) {
  const bus = marker?.bus;
  const extra = marker?.extra || {};
  return (
    bus?.trip_id ||
    extra.tripId ||
    extra.btTripId ||
    extra.stops?._tripId ||
    ""
  );
}

/** Re-fetch trip stop predictions so early/late is not frozen on the open / followed card. */
function scheduleTripDelayRefresh(marker) {
  const tripId = tripIdForMarker(marker);
  if (!tripId) return;
  const open =
    selectedMapMarker === marker ||
    marker.isPopupOpen?.() ||
    isFollowingMarker(marker);
  if (!open) return;
  const now = Date.now();
  const minGap = isFollowingMarker(marker) ? 8000 : 15000;
  if (marker._tripDelayAt && now - marker._tripDelayAt < minGap) return;
  marker._tripDelayAt = now;
  const gen = (marker._tripDelayGen = (marker._tripDelayGen || 0) + 1);
  tripEnds(tripId, { force: true, date: marker.bus?.date || "" })
    .then((ends) => {
      if (!ends || marker._tripDelayGen !== gen) return;
      if (String(tripIdForMarker(marker) || "") !== String(tripId)) return;
      marker.extra ||= {};
      if (ends.stops?.length) {
        marker.extra.stops = ends.stops;
        marker.extra._observedStopSig = "";
        marker.extra.from = ends.from || marker.extra.from;
        marker.extra.to = ends.to || marker.extra.to;
        marker.extra._nextStopIdx = undefined;
      }
      const [lng, lat] = marker.bus.coordinates || [];
      const live = isFollowingMarker(marker) || selectedMapMarker === marker;
      marker.extra._tripDelayFreshAt = Date.now();
      // Prefer fresh bustimes trip delay (expected−aimed) when the feed has it.
      marker.extra.delaySec =
        ends.delaySec != null && Number.isFinite(Number(ends.delaySec))
          ? Number(ends.delaySec)
          : resolveLiveDelaySec(marker.bus, marker.extra, lat, lng, { live });
      refreshPopup(marker);
      if (isFollowingMarker(marker)) updateFollowChip();
    })
    .catch(() => {});
}

let followDelayTimer = null;

function stopFollowDelayPolling() {
  if (followDelayTimer) {
    clearInterval(followDelayTimer);
    followDelayTimer = null;
  }
}

/** Keep early/late moving on the card + follow chip while tracking a bus. */
function ensureFollowDelayPolling(marker) {
  stopFollowDelayPolling();
  if (!marker?.bus) return;
  const tick = () => {
    const followed = followedMarker();
    if (!followed?.bus) {
      stopFollowDelayPolling();
      return;
    }
    const bus = followed.bus;
    const extra = followed.extra || (followed.extra = {});
    const [lng, lat] = bus.coordinates || [];
    const delaySec = resolveLiveDelaySec(bus, extra, lat, lng, { live: true });
    if (delaySec != null) extra.delaySec = delaySec;
    scheduleTripDelayRefresh(followed);
    // Patch card even if structure key thinks nothing changed.
    if (selectedMapMarker === followed || followed.isPopupOpen?.()) {
      patchPopupLive(followed);
    }
    updateFollowChip();
  };
  tick();
  followDelayTimer = setInterval(tick, 2000);
}

function clockPartsSeconds(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  if (![hour, minute, second].every(Number.isFinite)) return null;
  return hour * 3600 + minute * 60 + second;
}

function wrapDelay(delta) {
  if (delta > 12 * 3600) return delta - 24 * 3600;
  if (delta < -12 * 3600) return delta + 24 * 3600;
  return delta;
}

function inferDelaySeconds(stops, lat, lng, iso) {
  const list = stops || [];
  if (!list.length) return null;
  let idx = list.findIndex((stop) => !stop.done);
  if (idx < 0) idx = list.length - 1;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    let best = idx;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i += 1) {
      if (!Number.isFinite(list[i].lat) || !Number.isFinite(list[i].lng)) continue;
      const d = haversineMeters(lat, lng, list[i].lat, list[i].lng);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD < 2500) idx = best;
  }
  const aimed = parseClockSeconds(list[idx]?.aimed);
  if (aimed == null) return null;
  const at = iso ? new Date(iso) : new Date();
  if (!Number.isFinite(at.getTime())) return null;
  const nowSec = clockPartsSeconds(at);
  if (nowSec == null) return null;
  const delta = wrapDelay(nowSec - aimed);
  if (Math.abs(delta) > 45 * 60) return null;
  return delta;
}

function actualClockLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes("T")) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return observedClockLabel(ms);
  }
  return clockLabel(raw);
}

function mapTripStops(times) {
  return (times || []).map((row) => {
    const loc = row.stop?.location;
    const lng = Number(loc?.[0]);
    const lat = Number(loc?.[1]);
    const aimedArr = clockLabel(row.aimed_arrival_time);
    const aimedDep = clockLabel(row.aimed_departure_time);
    const aimed = clockLabel(rowAimed(row));
    const expected = clockLabel(row.expected_departure_time || row.expected_arrival_time || row.expected);
    const actualArr = actualClockLabel(row.actual_arrival_time);
    const actualDep = actualClockLabel(row.actual_departure_time);
    const actual = actualClockLabel(row.actual_departure_time || row.actual_arrival_time);
    return {
      name: row.stop?.name || row.stop?.common_name || row.name || "",
      atco: row.stop?.atco_code || row.stop?.atcocode || "",
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      aimed,
      // Raw ISO (same instant as the First board's scheduledTime) — used to tie a
      // departure-board row to THIS trip instead of another bus on the same line.
      aimedIso: rowAimed(row),
      aimedArr,
      aimedDep,
      expected,
      actual,
      actualArr,
      actualDep,
      live: actual || expected || aimed,
      delaySec: stopDelaySeconds(row),
      timingStatus: String(row.timing_status || "").toUpperCase(),
      done: Boolean(row.actual_departure_time || row.actual_arrival_time),
    };
  });
}

/**
 * GPS recorder points are the only stop-level record available for many UK feeds.
 * Keep official bustimes actual times when present; otherwise use the first recorded
 * position near each stop as the observed arrival time. The timetable is minute-based,
 * so this is deliberately an observation, not a claimed fare-machine stop event.
 */
const OBSERVED_STOP_RADIUS_M = 180;
const OBSERVED_STOP_FUTURE_GRACE_MS = 30_000;
const OBSERVED_CLOCK_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function observedPointTimestamp(point) {
  const raw = Array.isArray(point) ? point[3] : point?.t;
  let t = Number(raw);
  if (!Number.isFinite(t)) t = Date.parse(raw || "");
  if (Number.isFinite(t) && t > 0 && t < 100_000_000_000) t *= 1000;
  return Number.isFinite(t) ? t : null;
}

function observedClockLabel(ms) {
  if (!Number.isFinite(ms)) return "";
  const label = OBSERVED_CLOCK_FMT.format(new Date(ms));
  return label === "24:00" ? "00:00" : label;
}

/** Select the GPS points belonging to one trip, without mixing another bus run. */
function observedGpsPoints(
  gpsPoints,
  { tripId = "", journeyId = "", line = "", fromMs = 0, toMs = 0, nowMs = Date.now() } = {},
) {
  const base = (Array.isArray(gpsPoints) ? gpsPoints : [])
    .map((point) => {
      const t = observedPointTimestamp(point);
      const lat = Number(Array.isArray(point) ? point[0] : point?.lat);
      const lng = Number(Array.isArray(point) ? point[1] : point?.lng);
      if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { ...(Array.isArray(point) ? {} : point), t, lat, lng };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
  let points = base.filter((point) => {
    if (fromMs && point.t < fromMs) return false;
    if (toMs && point.t > toMs) return false;
    if (Number.isFinite(nowMs) && point.t > nowMs + OBSERVED_STOP_FUTURE_GRACE_MS) return false;
    return true;
  });

  const wantedTrip = String(tripId || "").trim();
  if (wantedTrip) {
    const exact = points.filter((point) => String(point.tripId || "").trim() === wantedTrip);
    // A trip id is stronger than line metadata: BODS can briefly report 11 for an 11X run.
    if (exact.length) points = exact;
  } else {
    const wantedJourney = String(journeyId || "").trim();
    if (wantedJourney) {
      const exact = points.filter(
        (point) => String(point.journeyId || "").trim() === wantedJourney,
      );
      if (exact.length) points = exact;
    }
  }
  const wantedLine = String(line || "").trim();
  if (wantedLine) {
    const matching = points.filter(
      (point) => !String(point.line || "").trim() || sameServiceLine(point.line, wantedLine),
    );
    if (matching.length) points = matching;
  }
  return points;
}

function observedSegmentDistance(stop, a, b) {
  const stopLat = Number(stop?.lat);
  const stopLng = Number(stop?.lng);
  const aLat = Number(a?.lat);
  const aLng = Number(a?.lng);
  const bLat = Number(b?.lat);
  const bLng = Number(b?.lng);
  if (![stopLat, stopLng, aLat, aLng, bLat, bLng].every(Number.isFinite)) return null;
  const xScale = 111_320 * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  const yScale = 110_540;
  const ax = (aLng - stopLng) * xScale;
  const ay = (aLat - stopLat) * yScale;
  const bx = (bLng - stopLng) * xScale;
  const by = (bLat - stopLat) * yScale;
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const fraction = denominator
    ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denominator))
    : 0;
  return {
    distance: Math.hypot(ax + fraction * dx, ay + fraction * dy),
    fraction,
  };
}

/**
 * Add GPS-observed arrival times to mapped trip stops. Stops are processed in route
 * order and each match must be within a short radius, so the current/final GPS ping
 * cannot be copied into every future stop in the timetable.
 */
function attachObservedStopTimes(stops, gpsPoints, options = {}) {
  const rows = Array.isArray(stops) ? stops : [];
  if (!rows.length) return rows;
  const points = observedGpsPoints(gpsPoints, options);
  if (!points.length) return rows;

  const radius = Number(options.radiusM) > 0 ? Number(options.radiusM) : OBSERVED_STOP_RADIUS_M;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  let cursor = 0;
  let previousT = null;

  return rows.map((stop) => {
    const lat = Number(stop?.lat);
    const lng = Number(stop?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ...stop };

    let chosen = null;
    // Prefer the point where the recorded path crossed the stop. This fills gaps
    // between AVL pings without treating a single nearby sample as the arrival.
    for (let i = cursor; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (b.t > nowMs + OBSERVED_STOP_FUTURE_GRACE_MS) break;
      if (previousT != null && b.t < previousT - 45_000) continue;
      const hit = observedSegmentDistance(stop, a, b);
      if (!hit || hit.distance > radius) continue;
      const observedAt = a.t + (b.t - a.t) * hit.fraction;
      if (observedAt > nowMs + OBSERVED_STOP_FUTURE_GRACE_MS) continue;
      if (previousT != null && observedAt < previousT - 45_000) continue;
      chosen = { point: { ...a, t: observedAt }, index: i, distance: hit.distance };
      break;
    }
    // A single recorded sample can still be the only evidence for a short stop.
    if (!chosen) {
      for (let i = cursor; i < points.length; i += 1) {
        const point = points[i];
        if (point.t > nowMs + OBSERVED_STOP_FUTURE_GRACE_MS) break;
        if (previousT != null && point.t < previousT - 45_000) continue;
        const distance = haversineMeters(lat, lng, point.lat, point.lng);
        if (distance > radius) continue;
        chosen = { point, index: i, distance };
        break;
      }
    }
    if (!chosen) return { ...stop };

    const observedAt = chosen.point.t;
    const observed = observedClockLabel(observedAt);
    const hasOfficialActual = Boolean(stop.actualArr || stop.actualDep || stop.actual);
    const actualArr = stop.actualArr || (hasOfficialActual ? "" : observed);
    const actual = stop.actual || (hasOfficialActual ? "" : observed);
    // Keep the cursor on this sample: closely-spaced stops can share one GPS ping.
    cursor = chosen.index;
    previousT = observedAt;
    return {
      ...stop,
      actualArr,
      actual,
      actualSource: hasOfficialActual ? stop.actualSource || "feed" : "gps",
      observedAt,
      observedDistanceM: Math.round(chosen.distance),
      done: true,
      live: stop.live || actual || stop.expected || stop.aimed,
    };
  });
}

function cardStops(stops, lat, lng, stickyNext = null) {
  const list = (stops || []).filter((stop) => stop?.name);
  if (!list.length) return [];
  let next = list.findIndex((stop) => !stop.done);
  if (next < 0) next = Math.max(0, list.length - 1);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    let best = next;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i += 1) {
      if (!Number.isFinite(list[i].lat) || !Number.isFinite(list[i].lng)) continue;
      const d = haversineMeters(lat, lng, list[i].lat, list[i].lng);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD < 2500) {
      const sticky =
        Number.isInteger(stickyNext) && stickyNext >= 0 && stickyNext < list.length
          ? stickyNext
          : null;
      if (sticky == null) {
        next = best;
      } else {
        const stickyD =
          Number.isFinite(list[sticky].lat) && Number.isFinite(list[sticky].lng)
            ? haversineMeters(lat, lng, list[sticky].lat, list[sticky].lng)
            : Infinity;
        // Stay on the same "next" stop unless another is clearly closer — stops flicker.
        next = best !== sticky && bestD < stickyD - 90 ? best : sticky;
      }
    }
  }
  return list.map((stop, index) => ({
    ...stop,
    next: index === next,
  }));
}

function upcomingStops(stops, lat, lng) {
  const list = cardStops(stops, lat, lng);
  if (!list.length) return [];
  const next = list.findIndex((stop) => stop.next);
  const start = next < 0 ? 0 : next;
  const from = Math.max(0, start - 1);
  return list.slice(from);
}

function stopsBlock(stops, lat, lng, stickyNext = null) {
  const rows = cardStops(stops, lat, lng, stickyNext);
  if (!rows.length) return "";
  const next = rows.find((stop) => stop.next) || rows[0];
  return `
    <details class="popup-fold popup-stops-fold">
      <summary class="popup-fold-summary">
        <span>Stops · ${rows.length}</span>
        ${next ? `<span class="popup-fold-hint">${esc(next.name)} · ${esc(next.live || "")}</span>` : ""}
      </summary>
      <div class="popup-stops">
        ${rows
          .map((stop) => {
            const live = stop.live || "—";
            const aimed = stop.aimed && stop.aimed !== live ? stop.aimed : "";
            const cls = stop.done ? " is-done" : stop.next ? " is-next" : "";
            return `<div class="popup-stop${cls}"><span class="stop-name">${esc(stop.name)}</span><span class="stop-times"><span class="stop-time">${esc(live)}</span>${aimed ? `<span class="stop-aimed">${esc(aimed)}</span>` : ""}</span></div>`;
          })
          .join("")}
      </div>
    </details>
  `;
}

const HISTORY_DAY_OPTIONS = [1, 3, 5];
const HISTORY_DAYS_KEY = "uk-bus-history-days";
const FREE_HISTORY_DAYS = 1;
let historyDays = (() => {
  const n = Number(localStorage.getItem(HISTORY_DAYS_KEY));
  const picked = HISTORY_DAY_OPTIONS.includes(n) ? n : 5;
  if (!isPlus() && picked > FREE_HISTORY_DAYS) return FREE_HISTORY_DAYS;
  return picked;
})();
const historyCache = new Map();

function ukDateKey(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: UK_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value instanceof Date ? value : new Date(value));
}

function historyCutoffDate(days = historyDays) {
  const n = Math.max(1, Number(days) || 1);
  // Work in UK calendar days (not the browser's local midnight).
  const today = ukDateKey();
  const [y, m, d] = today.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  // N days including today → go back (N - 1). For the free 1d window, also keep yesterday
  // so overnight journeys (e.g. route 25 into the early hours) don't vanish at midnight.
  const back = n <= 1 ? 1 : n - 1;
  utc.setUTCDate(utc.getUTCDate() - back);
  return utc.toISOString().slice(0, 10);
}

function formatHistoryDay(dateStr) {
  const today = ukDateKey();
  if (dateStr === today) return "Today";
  const y = new Date(`${today}T12:00:00`);
  y.setDate(y.getDate() - 1);
  if (dateStr === ukDateKey(y)) return "Yesterday";
  const dt = new Date(`${dateStr}T12:00:00`);
  return dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function formatHistoryTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: UK_TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function historyVehicleId(bus, extra = {}) {
  // Prefer real bustimes vehicle ids — never Flix journey ids used as bus.id.
  for (const id of [extra.btVehicle?.id, extra.vehicle?.id, bus?.vehicle?.id, bus?.btId]) {
    if (id == null || id === "") continue;
    const s = String(id);
    if (s.startsWith("dg-") || s.startsWith("staff-") || s.startsWith("bods-")) continue;
    if (/^\d+$/.test(s)) return s;
  }
  if (bus && isFlixBus(bus)) {
    // Anonymised Flix AVL: bus.id is the journey, not a bustimes vehicle.
    return "";
  }
  for (const id of [bus?.id]) {
    if (id == null || id === "") continue;
    const s = String(id);
    if (s.startsWith("dg-") || s.startsWith("staff-") || s.startsWith("bods-")) continue;
    if (/^\d+$/.test(s)) return s;
  }
  return "";
}

function staffTrailKey(item) {
  const id = item?.vehicle?.ref || item?.vehicle?.vehicleUniqueId || "";
  return id ? `staff-${id}` : "";
}

function isAltonLine(line) {
  return ALTON_LINES.has(String(line || "").trim().toUpperCase());
}

/** AT1–AT3 headsign when D&G omits destination.name (outbound → Towers). */
function atTrailDestination(line, direction = "") {
  const code = String(line || "").trim().toUpperCase();
  if (!ALTON_LINES.has(code)) return "";
  const dir = normalizeTrailDirection(direction);
  if (dir === "in") {
    if (code === "AT3") return "Bentilee";
    return "Fenton";
  }
  return "Alton Towers";
}

function recordStaffTrail(marker, lat, lng, heading, meta = {}) {
  const item = marker?.staff || marker;
  const key = staffTrailKey(item);
  const parsed = parseFleetReg(item?.vehicle?.ref);
  const reg =
    meta.reg ||
    marker?.extra?.btVehicle?.reg ||
    marker?.extra?.vehicle?.reg ||
    parsed?.reg ||
    "";
  const line = meta.line || staffLineName(item) || "";
  const journeyId =
    meta.journeyId ||
    item?.currentJourney?.id ||
    item?.currentJourney?.journeyId ||
    "";
  const direction =
    meta.direction ||
    normalizeTrailDirection(item?.currentJourney?.directionRef || item?.directionRef || "");
  const destination =
    meta.destination ||
    item?.currentJourney?.destination?.name ||
    item?.currentJourney?.destinationRef ||
    atTrailDestination(line, direction) ||
    "";
  const trailMeta = {
    ...meta,
    _force: marker === selectedMapMarker || isFollowingMarker(marker),
    reg,
    line,
    journeyId: journeyId ? String(journeyId) : meta.journeyId || "",
    direction,
    destination,
    operator: meta.operator || "DAGC",
  };
  if (key) recordVehicleTrail(key, lat, lng, heading, trailMeta);
  const btId = marker?.extra?.btVehicle?.id;
  if (btId != null) recordVehicleTrail(String(btId), lat, lng, heading, trailMeta);
}

async function fetchVehicleHistory(vehicleId, days = historyDays) {
  if (!vehicleId) return [];
  const key = `${vehicleId}:${days}`;
  if (historyCache.has(key)) return historyCache.get(key);
  const cutoff = historyCutoffDate(days);
  const promise = (async () => {
    const rows = [];
    let url = `/api/bt-vehiclejourneys/?vehicle=${encodeURIComponent(vehicleId)}`;
    for (let page = 0; page < 25 && url; page += 1) {
      const res = await fetch(url);
      if (!res.ok) break;
      const data = await res.json();
      const batch = Array.isArray(data.results) ? data.results : [];
      let hitOlder = false;
      for (const row of batch) {
        if (!row?.date) continue;
        if (row.date < cutoff) {
          hitOlder = true;
          break;
        }
        rows.push(row);
      }
      if (hitOlder || !data.next) break;
      url = String(data.next).replace(/^https?:\/\/bustimes\.org\/api\/vehiclejourneys/, "/api/bt-vehiclejourneys");
    }
    return rows;
  })().catch(() => []);
  historyCache.set(key, promise);
  return promise;
}

function isDgBusContext(marker, extra = {}) {
  if (marker?.staff && isAltonLine(staffLineName(marker.staff))) return true;
  const hay = [
    marker?.bus?.operator?.noc,
    marker?.bus?.operator?.id,
    marker?.bus?.operator?.name,
    marker?.bus?.service?.operator?.name,
    marker?.bus?.service?.url,
    extra?.operator,
    extra?.vehicle?.operator?.noc,
    extra?.vehicle?.operator?.name,
    extra?.btVehicle?.operator?.noc,
    extra?.btVehicle?.operator?.name,
  ]
    .filter(Boolean)
    .join(" ");
  return /DAGC|D\s*&\s*G|D and G|d-g-coach|dgbus/i.test(hay);
}

function historyLineFilterFor(marker) {
  const raw =
    marker?.extra?.historyLineFilter ||
    marker?.extra?.line ||
    marker?.bus?.service?.line_name ||
    (marker?.staff ? staffLineName(marker.staff) : "") ||
    "";
  // Canonicalise First Potteries matchday codes so B1 history matches BS1 rows.
  if (isStokeFcLine(raw)) return normalizeStokeFcLine(raw);
  return raw;
}

function isFirstPotteriesContext(marker, extra = {}) {
  if (isStokeFcShuttleLive(marker?.bus)) return true;
  const hay = [
    marker?.bus?.operator?.noc,
    marker?.bus?.operator?.id,
    marker?.bus?.operator?.name,
    marker?.bus?.service?.operator?.name,
    marker?.bus?.service?.url,
    extra?.operator,
    extra?.vehicle?.operator?.noc,
    extra?.vehicle?.operator?.name,
    extra?.btVehicle?.operator?.noc,
    extra?.btVehicle?.operator?.name,
  ]
    .filter(Boolean)
    .join(" ");
  return /FPOT|First Potteries|first-potteries/i.test(hay);
}

function filterHistoryByLine(rows, line, { keepStokeFc = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!line) {
    if (keepStokeFc) {
      return list.filter((row) => isStokeFcLine(row.route_name) || isStokeFcLine(row.extracted_route));
    }
    return list;
  }
  const matched = list.filter((row) => {
    if (sameServiceLine(row.route_name, line)) return true;
    if (sameServiceLine(row.extracted_route, line)) return true;
    // Diverted trips: keep if destination/notes still mention this route.
    if (row.diverted && sameServiceLine(extractRouteFromVehicle(row), line)) return true;
    return false;
  });
  const seen = new Set(matched.map((row) => String(row.id || `${row.datetime}|${row.route_name}`)));
  const pushUnique = (row) => {
    const key = String(row.id || `${row.datetime}|${row.route_name}`);
    if (seen.has(key)) return;
    seen.add(key);
    matched.push(row);
  };
  if (keepStokeFc) {
    // Always keep First Potteries B1–B2 / BS1–BS2 journeys in the history list.
    for (const row of list) {
      if (!isStokeFcLine(row.route_name) && !isStokeFcLine(row.extracted_route)) continue;
      pushUnique(row);
    }
  }
  if (!keepStokeFc) return matched;
  return matched.sort((a, b) => String(b.datetime || "").localeCompare(String(a.datetime || "")));
}

function applyHistoryLineFilterToMarkers({ vehicleId = "", trailKey = "", reg = "", line = "" } = {}) {
  const want = String(line || "").trim();
  if (!want) return;
  const wantReg = compactReg(reg);
  const wantId = String(vehicleId || "");
  const wantTrail = String(trailKey || "");
  const all = [...markers.values(), ...staffMarkers.values()];
  for (const marker of all) {
    marker.extra ||= {};
    const busId = String(marker.bus?.id || marker.extra?.btVehicle?.id || "");
    const mTrail = String(
      marker.extra?.trailKey || (marker.staff ? staffTrailKey(marker.staff) : "") || "",
    );
    const mReg = compactReg(
      marker.extra?.vehicle?.reg ||
        marker.extra?.btVehicle?.reg ||
        marker.bus?.vehicle?.name ||
        parseFleetReg(marker.staff?.vehicle?.ref).reg ||
        "",
    );
    const match =
      (wantId && busId && wantId === busId) ||
      (wantTrail && mTrail && wantTrail === mTrail) ||
      (wantReg && mReg && wantReg === mReg);
    if (!match) continue;
    marker.extra.historyLineFilter = want;
    marker.extra.line = want;
    if (marker.isPopupOpen?.()) loadHistoryIntoMarker(marker, { force: true });
    else refreshPopup(marker);
  }
}

function historyBlock(extra = {}) {
  const days = Number(extra.historyDays) || historyDays;
  const status = extra.historyStatus || "";
  const lineFilter = String(extra.historyLineFilter || extra.line || "").trim();
  const keepStokeFc =
    isStokeFcLine(lineFilter) ||
    isFirstPotteriesContext(null, extra) ||
    /FPOT|First Potteries|first-potteries/i.test(
      `${extra.operator || ""} ${extra.vehicle?.operator?.name || ""} ${extra.btVehicle?.operator?.name || ""}`,
    );
  const journeys = filterHistoryByLine(Array.isArray(extra.history) ? extra.history : [], lineFilter, {
    keepStokeFc,
  });
  const chips = HISTORY_DAY_OPTIONS.map((n) => {
    const locked = !isPlus() && n > FREE_HISTORY_DAYS;
    return `<button type="button" class="history-days-btn${n === days ? " is-on" : ""}${locked ? " is-locked" : ""}" data-days="${n}"${locked ? ' title="Plus feature"' : ""}>${n}d${locked ? " ★" : ""}</button>`;
  }).join("");
  let body = "";
  if (status === "loading") body = `<div class="popup-meta">Loading history…</div>`;
  else if (status === "empty") {
    body = `<div class="popup-meta">${
      lineFilter
        ? `No tracked ${esc(lineFilter)} journeys in the last ${days} day${days === 1 ? "" : "s"}`
        : `No tracked journeys in the last ${days} day${days === 1 ? "" : "s"}`
    }</div>`;
  } else if (status === "unavailable") body = `<div class="popup-meta">History unavailable for this vehicle</div>`;
  else if (journeys.length) {
    const byDay = new Map();
    for (const row of journeys) {
      const list = byDay.get(row.date) || [];
      list.push(row);
      byDay.set(row.date, list);
    }
    body = [...byDay.entries()]
      .map(([date, list]) => {
        const items = list
          .map((row) => {
            const line =
              (row.route_name && !/^div/i.test(String(row.route_name))
                ? row.route_name
                : "") ||
              row.extracted_route ||
              row.route_name ||
              "?";
            const dest = row.destination || "Unknown";
            const direction = normalizeTrailDirection(row.direction || "");
            const directionLabel = direction === "in" ? "inbound" : direction === "out" ? "outbound" : "";
            const divertTag = row.diverted
              ? ` <span class="history-divert-tag" title="Diverted">div</span>`
              : "";
            const liveTag = row.live ? ` <span class="history-live-tag">live</span>` : "";
            return `<div class="popup-history-row"><span class="history-time">${esc(formatHistoryTime(row.datetime))}</span><span class="history-line">${esc(line)}${divertTag}${liveTag}</span><span class="history-dest">${esc(dest)}${directionLabel ? ` · ${esc(directionLabel)}` : ""}</span>${
              row.trip_id || row.vehicle?.id || row.trailKey || extra.trailKey || row.live
                ? `<button type="button" class="history-play-btn" data-live="${row.live ? "1" : "0"}" data-trip-id="${esc(row.trip_id || "")}" data-journey-id="${esc(trailFilterJourneyId(row.journey_id || row.id || "", line))}" data-vehicle-id="${esc(row.vehicle?.id || extra.btVehicle?.id || "")}" data-trail-key="${esc(row.trailKey || extra.trailKey || "")}" data-reg="${esc(extra.vehicle?.reg || extra.btVehicle?.reg || "")}" data-line="${esc(line)}" data-operator="${esc(extra.operatorNoc || extra.operator || "")}" data-direction="${esc(normalizeTrailDirection(row.direction || ""))}" data-dest="${esc(dest)}" data-datetime="${esc(row.datetime || "")}" data-diverted="${row.diverted ? "1" : "0"}" title="${row.live ? "Follow this bus live" : "Show this journey on the map"}">Map</button>`
                : `<span></span>`
            }</div>`;
          })
          .join("");
        return `<div class="popup-history-day"><div class="popup-history-day-label">${esc(formatHistoryDay(date))} · ${list.length}</div>${items}</div>`;
      })
      .join("");
  } else if (status === "ready" && lineFilter) {
    body = `<div class="popup-meta">No ${esc(lineFilter)} journeys in this history window</div>`;
  }
  return `
    <details class="popup-fold popup-history">
      <summary class="popup-fold-summary">
        <span>History · ${days}d${lineFilter ? ` · ${esc(lineFilter)}` : ""}</span>
        <span class="history-days">${chips}</span>
      </summary>
      <div class="popup-history-list">${body || `<div class="popup-meta">Open to load</div>`}</div>
    </details>
  `;
}

let announceOn = localStorage.getItem("uk-bus-announce") === "1" && isPlus();
let announceFollow = null;
let announceIntroId = "";
let lastStopKey = "";
let lastStopIndex = -1;
let lastNextStopKey = "";
let lastSpokenText = "";
let lastSpokenAt = 0;
let speakQueue = [];
let speakBusy = false;

function speakStopName(name) {
  let text = String(name || "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // NaPTAN-style "Bentilee, Twigg Street" / "Hanley - Bus Station" → speak the stop only.
  if (text.includes(",")) {
    const parts = text
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) text = parts.slice(1).join(", ");
  } else if (/\s+[-–—]\s+/.test(text)) {
    const parts = text
      .split(/\s+[-–—]\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) text = parts.slice(1).join(" — ");
  }
  // Drop NaPTAN "opp" / "adj" markers (opposite / adjacent).
  text = text
    .replace(/\b(opp|adj)\b\.?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function pickUkVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  if (!voices.length) return null;
  const byName = (...patterns) =>
    voices.find((voice) => patterns.some((pattern) => pattern.test(voice.name)));
  return (
    byName(/emma\s*hignett/i) ||
    byName(/^emma\b/i) ||
    byName(/hazel/i) ||
    byName(/susan/i) ||
    byName(/sonia|libby|serena|martha/i) ||
    voices.find((voice) => /^en-GB/i.test(voice.lang) && /female|woman/i.test(voice.name)) ||
    voices.find((voice) => /^en-GB/i.test(voice.lang)) ||
    byName(/UK English|English \(United Kingdom\)/i) ||
    voices.find((voice) => /^en/i.test(voice.lang)) ||
    null
  );
}

function clearSpeech() {
  speakQueue = [];
  speakBusy = false;
  window.speechSynthesis?.cancel();
}

function pumpSpeech() {
  if (speakBusy || !announceOn || !window.speechSynthesis) return;
  const next = speakQueue.shift();
  if (!next) return;
  speakBusy = true;
  lastSpokenText = next;
  lastSpokenAt = Date.now();
  const utter = new SpeechSynthesisUtterance(next);
  utter.lang = "en-GB";
  utter.rate = 0.95;
  const voice = pickUkVoice();
  if (voice) utter.voice = voice;
  const done = () => {
    speakBusy = false;
    pumpSpeech();
  };
  utter.onend = done;
  utter.onerror = done;
  window.speechSynthesis.speak(utter);
}

function speak(text, { force = false, append = false } = {}) {
  if (!announceOn || !text || !window.speechSynthesis) return;
  if (!force && text === lastSpokenText) return;
  if (!force && !append && Date.now() - lastSpokenAt < 8000) return;
  if (append) {
    speakQueue.push(text);
  } else {
    clearSpeech();
    speakQueue = [text];
  }
  pumpSpeech();
}

/** Next stop ahead on the trip — every named stop, not only principal timing points. */
function nextStopState(marker) {
  const stops = marker.extra?.stops || [];
  if (!stops.length) return { stop: null, index: -1, dist: Infinity };
  const ll = marker.getLatLng();
  const lat = ll?.lat;
  const lng = ll?.lng;
  const sticky = Number.isInteger(marker.extra?._nextStopIdx) ? marker.extra._nextStopIdx : null;
  const rows = cardStops(stops, lat, lng, sticky);
  const index = rows.findIndex((row) => row.next);
  if (index < 0) return { stop: null, index: -1, dist: Infinity };
  if (marker.extra) marker.extra._nextStopIdx = index;

  const stop = rows[index];
  let dist = Infinity;
  if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(stop.lat) && Number.isFinite(stop.lng)) {
    dist = haversineMeters(lat, lng, stop.lat, stop.lng);
  }
  return { stop, index, dist, stops: rows };
}

function journeyId(marker) {
  return marker.bus?.id || marker.staff?.vehicle?.ref || marker.staff?.vehicle?.vehicleUniqueId || "";
}

function announceStopKey(stop, index) {
  return `${index}:${stop?.atco || speakStopName(stop?.name) || ""}`;
}

function announceJourney(marker, { intro = false } = {}) {
  if (!announceOn || !marker || marker !== announceFollow) return;
  if (marker.bus && isNotInService(marker.bus)) return;

  const id = String(journeyId(marker));
  if (announceIntroId !== id) {
    announceIntroId = id;
    lastStopKey = "";
    lastStopIndex = -1;
    lastNextStopKey = "";
  }

  const { stop: next, index, dist, stops } = nextStopState(marker);
  const stop = speakStopName(next?.name);
  if (!stop || index < 0) return;

  const key = announceStopKey(next, index);
  // New next stop (including first time stops finish loading after open).
  const isNewNext = key !== lastNextStopKey;
  if (!isNewNext) {
    lastStopIndex = Math.max(lastStopIndex, index);
    return;
  }
  if (index < lastStopIndex) return;

  const shouldSpeak =
    intro ||
    lastNextStopKey === "" ||
    index > lastStopIndex ||
    (Number.isFinite(dist) && dist <= 450);

  if (!shouldSpeak) return;

  const lines = [];
  // Catch stops jumped past between GPS polls so none are missed.
  if (lastStopIndex >= 0 && index > lastStopIndex + 1 && Array.isArray(stops)) {
    for (let i = lastStopIndex + 1; i < index; i += 1) {
      const name = speakStopName(stops[i]?.name);
      if (name) lines.push(`Stopping at ${name}.`);
    }
  }
  lines.push(`The next stop is ${stop}.`);

  lastNextStopKey = key;
  lastStopIndex = index;
  lastStopKey = stop;
  clearSpeech();
  speakQueue = lines;
  pumpSpeech();
}

function followJourney(marker, intro = false) {
  if (!marker) return;
  if (announceFollow !== marker) {
    announceFollow = marker;
    announceIntroId = "";
    lastStopKey = "";
    lastStopIndex = -1;
    lastNextStopKey = "";
    lastSpokenText = "";
    clearSpeech();
    intro = true;
  }
  announceJourney(marker, { intro });
}

let followTarget = null;
let followPanning = false;
let lastFollowPanAt = 0;
const followChipEl = document.getElementById("follow-chip");
const playbackBarEl = document.getElementById("playback-bar");
const playbackLabelEl = document.getElementById("playback-label");
const playbackStopEl = document.getElementById("playback-stop");
const playbackReplayEl = document.getElementById("playback-replay");
const playbackScrubEl = document.getElementById("playback-scrub");
const playbackClockEl = document.getElementById("playback-clock");
const playbackSpeedEl = document.getElementById("playback-speed");

/**
 * GPS replay: animates a bus marker along the recorded BODS pings (trail points),
 * with a scrub bar, play/pause and speed multiplier — a true "as it happened" replay.
 */
let gpsReplay = null; // { pts, idx, frac, speed, playing, raf, marker, arrow, t0, t1 }
let gpsReplayWatchdog = null;
const GPS_REPLAY_SPEEDS = [1, 15, 60, 240];
const REPLAY_ARROW_SPACING_ZOOMED_M = 52;
const REPLAY_ARROW_SPACING_M = 28;
const REPLAY_ARROW_LIMIT = 480;
const REPLAY_PREVIEW_FRACTION = 0.1;
const REPLAY_PREVIEW_MAX_MS = 5 * 60_000;
const REPLAY_PREVIEW_MIN_METERS = 800;

function setGpsReplayActive(active) {
  mapWrapEl?.classList.toggle("gps-replay-active", Boolean(active));
}

function gpsReplayControls(show) {
  if (!playbackReplayEl) return;
  const hasPts = Boolean(gpsReplay?.pts?.length >= 2);
  const on = show && hasPts;
  const active = Boolean(gpsReplay?.hasStarted || gpsReplay?.playing);
  playbackReplayEl.hidden = !on;
  playbackScrubEl.hidden = !on || !active;
  playbackClockEl.hidden = !on || !active;
  playbackSpeedEl.hidden = !on || !active;
}

/** Bustimes-style travelled-so-far overlay: a green stroke revealed by the replay cursor. */
const REPLAY_TRAVELLED_COLOR = "#22a447";
const REPLAY_TRAVELLED_WEIGHT = 5;
/** Indigo/white casing makes the replay tail read like the route view in the reference image. */
const REPLAY_TAIL_COLOR = "#5b51e3";
const REPLAY_TAIL_WEIGHT = 7;
const REPLAY_TAIL_CASING_COLOR = "#f8fafc";
const REPLAY_TAIL_CASING_WEIGHT = 10;

function replayPreviewPosition(replay) {
  const span = Math.max(0, Number(replay?.t1) - Number(replay?.t0));
  if (!Number.isFinite(span) || span <= 0) return 0;
  let byDistance = span - 1;
  let distance = 0;
  for (let i = 1; i < (replay.pts?.length || 0); i += 1) {
    const a = replay.pts[i - 1];
    const b = replay.pts[i];
    distance += haversineMeters(a.lat, a.lng, b.lat, b.lng);
    if (distance >= REPLAY_PREVIEW_MIN_METERS) {
      byDistance = Math.max(0, b.t - replay.t0);
      break;
    }
  }
  return Math.min(
    span * REPLAY_PREVIEW_FRACTION,
    REPLAY_PREVIEW_MAX_MS,
    byDistance,
    span - 1,
  );
}

function replayArrowSpacingM() {
  const zoom = map.getZoom();
  return zoom < 12
    ? REPLAY_ARROW_SPACING_ZOOMED_M
    : zoom < 13
      ? 40
      : zoom < 14
        ? 34
        : REPLAY_ARROW_SPACING_M;
}

function clearReplayDirectionArrows(replay = gpsReplay) {
  for (const marker of replay?.directionArrows || []) {
    try {
      playbackLayer.removeLayer(marker);
    } catch {
      /* already gone */
    }
  }
  if (replay) {
    replay.directionArrows = [];
    replay.arrowScanIndex = 0;
    replay.arrowLastPoint = replay.pts?.[0] || null;
    replay.arrowT = replay.t0 ?? Number.NEGATIVE_INFINITY;
  }
}

function addReplayDirectionArrow(replay, point, bearing, t) {
  if (!replay || !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
  if ((replay.directionArrows?.length || 0) >= REPLAY_ARROW_LIMIT) return;
  const marker = L.marker([point.lat, point.lng], {
    icon: trailArrowIcon(bearing, { replay: true }),
    interactive: false,
    keyboard: false,
    opacity: 0.95,
    zIndexOffset: 220,
  }).addTo(playbackLayer);
  trailArrowMarkers.add(marker);
  marker._replayT = Number.isFinite(t) ? t : point.t;
  replay.directionArrows.push(marker);
}

/**
 * Add route-direction arrows only to the GPS already covered by the replay.
 * The markers are incremental, so a long replay does not rebuild hundreds of
 * Leaflet icons on every animation frame.
 */
function gpsReplayUpdateDirectionArrows(t) {
  const replay = gpsReplay;
  const pts = replay?.pts;
  if (!replay || !pts?.length || !Number.isFinite(t)) return;
  if (t < (replay.arrowT ?? Number.NEGATIVE_INFINITY)) {
    clearReplayDirectionArrows(replay);
  }
  if (!replay.directionArrows) replay.directionArrows = [];
  // Keep the arrow layer authoritative even after a scrub or a late frame:
  // nothing may remain ahead of the moving replay cursor.
  for (let i = replay.directionArrows.length - 1; i >= 0; i -= 1) {
    const marker = replay.directionArrows[i];
    if (!marker || Number(marker._replayT) <= t + 1) continue;
    try {
      playbackLayer.removeLayer(marker);
    } catch {
      /* already removed */
    }
    replay.directionArrows.splice(i, 1);
    trailArrowMarkers.delete(marker);
  }
  if (!Number.isFinite(replay.arrowT)) replay.arrowT = Number.NEGATIVE_INFINITY;
  if (t < pts[0].t) return;

  let endIndex = Math.max(0, Number(replay.arrowScanIndex || 0) - 1);
  while (endIndex + 1 < pts.length && pts[endIndex + 1].t <= t) endIndex += 1;
  const spacing = Math.max(Number(replay.arrowSpacingM) || 0, replayArrowSpacingM());
  let lastPoint = replay.arrowLastPoint || pts[0];
  for (let i = Math.max(1, Number(replay.arrowScanIndex || 1)); i <= endIndex; i += 1) {
    const point = pts[i];
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
    if (haversineMeters(lastPoint.lat, lastPoint.lng, point.lat, point.lng) >= spacing) {
      const previous = pts[i - 1] || lastPoint;
      addReplayDirectionArrow(replay, point, segmentBearing([previous.lat, previous.lng], [point.lat, point.lng]), point.t);
      lastPoint = point;
    }
  }
  replay.arrowScanIndex = Math.max(Number(replay.arrowScanIndex || 0), endIndex + 1);
  replay.arrowLastPoint = lastPoint;

  // Include the interpolated cursor point when the bus is between two pings,
  // but never place an arrow beyond the current replay time.
  const current = endIndex < pts.length - 1 ? gpsReplayInterp(pts, t) : null;
  if (current && Number.isFinite(current.lat) && Number.isFinite(current.lng)) {
    const previous = pts[endIndex] || lastPoint;
    if (haversineMeters(lastPoint.lat, lastPoint.lng, current.lat, current.lng) >= spacing * 0.72) {
      addReplayDirectionArrow(
        replay,
        current,
        segmentBearing([previous.lat, previous.lng], [current.lat, current.lng]),
        t,
      );
      replay.arrowLastPoint = current;
    }
  }
  replay.arrowT = t;
}

/** Grow the replay tail only up to the replay cursor. */
function gpsReplayUpdateTravelled(t) {
  const replay = gpsReplay;
  if (!replay?.pts?.length) return;
  if (!replay.travelledLine) gpsReplayTravelledLine();
  if (!replay.travelledLine) return;
  const pts = replay.pts;
  let endIndex = -1;
  while (endIndex + 1 < pts.length && pts[endIndex + 1].t <= t) endIndex += 1;

  const current = gpsReplayInterp(pts, t);
  const goingBackwards =
    !Number.isFinite(replay.travelledT) || t < replay.travelledT || endIndex < replay.travelledEndIndex;
  let latlngs;
  if (!goingBackwards && replay.travelledPath?.length) {
    // Forward playback only appends newly covered GPS points.
    latlngs = replay.travelledPath.slice();
    const firstNew = Math.max(1, Number(replay.travelledEndIndex || 0) + 1);
    for (let i = firstNew; i <= endIndex; i += 1) {
      latlngs.push([pts[i].lat, pts[i].lng]);
    }
  } else {
    // Scrubbing backwards needs one rebuild; do not leave future points visible.
    latlngs = [[pts[0].lat, pts[0].lng]];
    for (let i = 1; i <= endIndex; i += 1) {
      latlngs.push([pts[i].lat, pts[i].lng]);
    }
  }
  if (
    current &&
    (!latlngs.length ||
      latlngs[latlngs.length - 1][0] !== current.lat ||
      latlngs[latlngs.length - 1][1] !== current.lng)
  ) {
    latlngs.push([current.lat, current.lng]);
  }

  for (const line of [replay.travelledLine, replay.tailLine, replay.tailCasing]) {
    line?.setLatLngs(latlngs);
  }
  replay.travelledPath = latlngs;
  replay.travelledEndIndex = endIndex;
  replay.travelledT = t;
  gpsReplayUpdateDirectionArrows(t);
}

function gpsReplayTravelledLine() {
  if (!gpsReplay) return null;
  if (gpsReplay.travelledLine) return gpsReplay.travelledLine;
  const first = gpsReplay.pts?.[0];
  if (!first) return null;
  const initial = [[first.lat, first.lng]];
  const shared = {
    lineJoin: "round",
    lineCap: "round",
    interactive: false,
  };
  // Casing + indigo stroke sit below the existing green replay core, giving the
  // tail the same high-contrast route appearance as the reference image.
  gpsReplay.tailCasing = L.polyline(initial, {
    ...shared,
    color: REPLAY_TAIL_CASING_COLOR,
    weight: REPLAY_TAIL_CASING_WEIGHT,
    opacity: 0.92,
    className: "gps-replay-tail-casing",
  }).addTo(playbackLayer);
  gpsReplay.tailLine = L.polyline(initial, {
    ...shared,
    color: REPLAY_TAIL_COLOR,
    weight: REPLAY_TAIL_WEIGHT,
    opacity: 0.96,
    className: "gps-replay-tail-line",
  }).addTo(playbackLayer);
  gpsReplay.travelledLine = L.polyline(initial, {
    ...shared,
    color: REPLAY_TRAVELLED_COLOR,
    weight: REPLAY_TRAVELLED_WEIGHT,
    opacity: 0.95,
    className: "gps-replay-travelled-line",
  }).addTo(playbackLayer);
  return gpsReplay.travelledLine;
}

function gpsReplayMarkerAt(lat, lng, heading) {
  if (!gpsReplay) return;
  if (!gpsReplay.marker) {
    gpsReplay.marker = L.circleMarker([lat, lng], {
      radius: 8,
      color: "#0b1018",
      weight: 3,
      fillColor: "#73d700",
      fillOpacity: 1,
      zIndexOffset: 500,
      interactive: false,
    }).addTo(playbackLayer);
  } else {
    gpsReplay.marker.setLatLng([lat, lng]);
  }
  if (Number.isFinite(heading)) {
    if (!gpsReplay.arrow) {
      gpsReplay.arrow = L.marker([lat, lng], {
        interactive: false,
        keyboard: false,
        zIndexOffset: 450,
        icon: trailArrowIcon(heading, { replay: true }),
      }).addTo(playbackLayer);
    } else {
      gpsReplay.arrow.setLatLng([lat, lng]);
      gpsReplay.arrow.setIcon(trailArrowIcon(heading, { replay: true }));
    }
  }
}

function gpsReplaySetClock(ms) {
  if (!playbackClockEl) return;
  const txt = formatTrailArrowTime(ms);
  if (txt) playbackClockEl.textContent = txt.split(" · ")[0];
}

/** Keep the replay cursor, its direction arrow, and the clipped tail on one position. */
function gpsReplaySetCursor(t) {
  const point = gpsReplayInterp(gpsReplay?.pts || [], t);
  if (!point) return null;
  gpsReplayMarkerAt(point.lat, point.lng, point.heading);
  gpsReplaySetClock(t);
  gpsReplayUpdateTravelled(t);
  updateReplayBusMarkerAt(point);
  return point;
}

function gpsReplayInterp(pts, t) {
  const list = pts;
  if (!list.length) return null;
  if (t <= list[0].t) return { ...list[0], frac: 0 };
  const last = list[list.length - 1];
  if (t >= last.t) return { ...last, frac: 1 };
  let lo = 0;
  let hi = list.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = list[lo];
  const b = list[hi];
  const span = b.t - a.t || 1;
  const f = (t - a.t) / span;
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lng: a.lng + (b.lng - a.lng) * f,
    heading: Number.isFinite(a.heading)
      ? a.heading
      : segmentBearing([a.lat, a.lng], [b.lat, b.lng]),
    t,
    frac: (lo + f) / (list.length - 1),
  };
}

function gpsReplayFrame(ts) {
  if (!gpsReplay || !gpsReplay.playing) return;
  const now = Number.isFinite(Number(ts)) ? Number(ts) : performance.now();
  // Browsers can throttle requestAnimationFrame when the tab is not foregrounded.
  // The watchdog below supplies a low-frequency fallback; avoid double-advancing
  // when animation frames are already healthy.
  if (gpsReplay.lastFrameAt && now - gpsReplay.lastFrameAt < 100) {
    requestAnimationFrame(gpsReplayFrame);
    return;
  }
  gpsReplay.lastFrameAt = now;
  if (!gpsReplay.raf) gpsReplay.raf = now;
  const wall = (now - gpsReplay.raf) / 1000;
  gpsReplay.raf = now;
  const span = gpsReplay.t1 - gpsReplay.t0;
  gpsReplay.pos += wall * gpsReplay.speed;
  if (gpsReplay.pos >= span) {
    gpsReplay.pos = span;
    gpsReplayPause();
  }
  const t = gpsReplay.t0 + gpsReplay.pos;
  const p = gpsReplaySetCursor(t);
  if (p && playbackScrubEl) playbackScrubEl.value = String(Math.round((p.frac || 0) * 1000));
  if (gpsReplay?.playing) requestAnimationFrame(gpsReplayFrame);
}

function updateReplayBusMarkerAt(p) {
  if (!playback) return;
  if (Number.isFinite(p?.lat) && Number.isFinite(p?.lng)) {
    playback.lastPing = { ...p, source: "replay" };
  }
}

function startGpsReplayWatchdog() {
  if (gpsReplayWatchdog) return;
  gpsReplayWatchdog = setInterval(() => {
    if (!gpsReplay?.playing) return;
    const now = performance.now();
    if (!gpsReplay.lastFrameAt || now - gpsReplay.lastFrameAt >= 400) {
      gpsReplayFrame(now);
    }
  }, 250);
}

function stopGpsReplayWatchdog() {
  if (!gpsReplayWatchdog) return;
  clearInterval(gpsReplayWatchdog);
  gpsReplayWatchdog = null;
}

function gpsReplayStart() {
  if (!gpsReplay?.pts?.length) return;
  if (!gpsReplay.hasStarted) {
    gpsReplay.pos = Math.max(gpsReplay.pos, replayPreviewPosition(gpsReplay));
    gpsReplay.hasStarted = true;
  }
  setGpsReplayActive(true);
  gpsReplay.playing = true;
  gpsReplay.raf = 0;
  gpsReplay.lastFrameAt = 0;
  startGpsReplayWatchdog();
  gpsReplayTravelledLine();
  gpsReplayControls(true);
  playbackReplayEl.textContent = "⏸ Pause";
  playbackReplayEl.hidden = false;
  // Reset the travelled stroke immediately when a completed replay is replayed
  // again, rather than leaving the full route visible for one frame.
  gpsReplaySetCursor(gpsReplay.t0 + gpsReplay.pos);
  requestAnimationFrame(gpsReplayFrame);
}

function gpsReplayPause() {
  if (!gpsReplay) return;
  gpsReplay.playing = false;
  stopGpsReplayWatchdog();
  gpsReplayControls(true);
  if (playbackReplayEl) playbackReplayEl.textContent = "▶ Replay";
}

function gpsReplayTeardown() {
  stopGpsReplayWatchdog();
  setGpsReplayActive(false);
  if (gpsReplay?.marker) playbackLayer.removeLayer(gpsReplay.marker);
  if (gpsReplay?.arrow) playbackLayer.removeLayer(gpsReplay.arrow);
  if (gpsReplay?.travelledLine) playbackLayer.removeLayer(gpsReplay.travelledLine);
  if (gpsReplay?.tailLine) playbackLayer.removeLayer(gpsReplay.tailLine);
  if (gpsReplay?.tailCasing) playbackLayer.removeLayer(gpsReplay.tailCasing);
  for (const marker of gpsReplay?.directionArrows || []) {
    try {
      playbackLayer.removeLayer(marker);
    } catch {
      /* already gone */
    }
    trailArrowMarkers.delete(marker);
  }
  gpsReplay = null;
  if (playbackReplayEl) {
    playbackReplayEl.textContent = "▶ Replay";
    playbackReplayEl.hidden = true;
  }
  if (playbackScrubEl) {
    playbackScrubEl.hidden = true;
    playbackScrubEl.value = "0";
  }
  if (playbackClockEl) {
    playbackClockEl.hidden = true;
    playbackClockEl.textContent = "";
  }
  if (playbackSpeedEl) {
    playbackSpeedEl.hidden = true;
    playbackSpeedEl.textContent = "×60";
  }
}

function restoreGpsReplayLayers() {
  if (!gpsReplay) return;
  const layers = [
    gpsReplay.tailCasing,
    gpsReplay.tailLine,
    gpsReplay.travelledLine,
    ...(gpsReplay.directionArrows || []),
    gpsReplay.marker,
    gpsReplay.arrow,
  ].filter(Boolean);
  for (const layer of layers) {
    try {
      playbackLayer.addLayer(layer);
    } catch {
      /* layer was already removed */
    }
  }
}

function gpsReplaySetup(pts) {
  const clean = normalizeGpsTrailPoints(pts)
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .sort((a, b) => a.t - b.t);
  if (clean.length < 2 || clean[clean.length - 1].t - clean[0].t < 60_000) {
    gpsReplayTeardown();
    return;
  }
  gpsReplayTeardown();
  gpsReplay = {
    pts: clean,
    t0: clean[0].t,
    t1: clean[clean.length - 1].t,
    pos: 0,
    speed: 60,
    playing: false,
    raf: 0,
    marker: null,
    arrow: null,
    travelledLine: null,
    tailLine: null,
    tailCasing: null,
    travelledPath: null,
    travelledEndIndex: -1,
    travelledT: Number.NaN,
    hasStarted: false,
    directionArrows: [],
    arrowScanIndex: 0,
    arrowLastPoint: clean[0],
    arrowT: clean[0].t,
    arrowSpacingM: Math.max(
      replayArrowSpacingM(),
      pathLengthMeters(pathFromGpsPoints(clean)) / REPLAY_ARROW_LIMIT,
    ),
  };
  // Do not paint replay-only arrows/tail until Replay is pressed. Map mode keeps
  // its own bus-clipped scene; otherwise the preview could sit ahead of the bus.
  gpsReplay.pos = 0;
  gpsReplayControls(true);
}
const journeyPanelEl = document.getElementById("journey-panel");
const journeyPanelCrumbEl = document.getElementById("journey-panel-crumb");
const journeyPanelDetailEl = document.getElementById("journey-panel-detail");
const journeyPanelTimetableEl = document.getElementById("journey-panel-timetable");
const journeyPanelTimetableToggleEl = document.getElementById("journey-panel-timetable-toggle");
const journeyPanelColsEl = document.getElementById("journey-panel-cols");
const journeyPanelStopsEl = document.getElementById("journey-panel-stops");
const journeyPanelMetaEl = document.getElementById("journey-panel-meta");
const journeyPanelCloseEl = document.getElementById("journey-panel-close");
const JOURNEY_TIMETABLE_MIN_KEY = "uk-bus-journey-timetable-minimized";

function isJourneyTimetableMinimized() {
  try {
    return localStorage.getItem(JOURNEY_TIMETABLE_MIN_KEY) === "1";
  } catch {
    return false;
  }
}

function setJourneyTimetableMinimized(minimized) {
  const on = Boolean(minimized);
  if (journeyPanelTimetableEl) {
    journeyPanelTimetableEl.classList.toggle("is-minimized", on);
  }
  if (journeyPanelEl) {
    journeyPanelEl.classList.toggle("is-timetable-minimized", on);
  }
  if (journeyPanelTimetableToggleEl) {
    journeyPanelTimetableToggleEl.setAttribute("aria-expanded", on ? "false" : "true");
    journeyPanelTimetableToggleEl.title = on ? "Show route timetable" : "Hide route timetable";
    const label = journeyPanelTimetableToggleEl.querySelector(".journey-panel-timetable-label");
    const hint = journeyPanelTimetableToggleEl.querySelector(".journey-panel-timetable-hint");
    if (label) label.textContent = "Route timetable";
    if (hint) hint.textContent = on ? "Show" : "Hide";
  }
  try {
    localStorage.setItem(JOURNEY_TIMETABLE_MIN_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  requestAnimationFrame(() => {
    try {
      map.invalidateSize({ animate: false });
    } catch {
      /* ignore */
    }
  });
}

function syncJourneyTimetableMinimized() {
  setJourneyTimetableMinimized(isJourneyTimetableMinimized());
}

const playbackLayer = L.layerGroup().addTo(map);
const liveTrailLayer = L.layerGroup().addTo(map);
/** Every generated direction arrow, including orphaned pairs from a replaced selection. */
const trailArrowMarkers = new Set();
/** Active static route overlay (not animated playback). */
let playback = null;
let playbackRequestSeq = 0;
let playbackDiversionSwitchBusy = false;
/** Live bus / staff marker shown in the left side panel (replaces the old popup card). */
let selectedMapMarker = null;

function journeyStopTimeStack(arr, dep, source = "") {
  const a = String(arr || "").trim();
  const d = String(dep || "").trim();
  const title = source === "gps" ? ' title="Observed from the bus GPS trail"' : "";
  if (!a && !d) return `<span class="is-empty">—</span>`;
  if (a && d && a !== d) return `<span${title}>${esc(a)}</span><span${title}>${esc(d)}</span>`;
  return `<span${title}>${esc(a || d)}</span>`;
}

function setJourneyPanelOpen(open) {
  if (!journeyPanelEl || !mapWrapEl) return;
  journeyPanelEl.hidden = !open;
  mapWrapEl.classList.toggle("is-journey", Boolean(open));
  requestAnimationFrame(() => {
    try {
      map.invalidateSize({ animate: false });
    } catch {
      /* ignore */
    }
  });
}

function renderJourneyPanelStops(stops, { lat = null, lng = null } = {}) {
  if (!journeyPanelStopsEl) return;
  const rows = cardStops(stops || [], lat, lng);
  if (journeyPanelTimetableEl) {
    journeyPanelTimetableEl.hidden = !rows.length;
  }
  if (journeyPanelColsEl) {
    journeyPanelColsEl.hidden = !rows.length;
    journeyPanelColsEl.setAttribute("aria-hidden", rows.length ? "false" : "true");
  }
  if (!rows.length) {
    journeyPanelStopsEl.innerHTML = "";
    return;
  }
  syncJourneyTimetableMinimized();
  journeyPanelStopsEl.innerHTML = rows
    .map((stop) => {
      const cls = stop.done ? " is-done" : stop.next ? " is-next" : "";
      return `<div class="journey-stop${cls}">
        <p class="journey-stop-name">${esc(stop.name || "Stop")}</p>
        <div class="journey-stop-times">${journeyStopTimeStack(stop.aimedArr, stop.aimedDep || stop.aimed)}</div>
        <div class="journey-stop-times is-actual">${journeyStopTimeStack(stop.actualArr, stop.actualDep || stop.actual, stop.actualSource)}</div>
      </div>`;
    })
    .join("");
}

function showJourneyPanel({
  operator = "",
  line = "",
  headsign = "",
  date = "",
  stops = [],
  lat = null,
  lng = null,
  detailHtml = "",
} = {}) {
  if (!journeyPanelEl || !mapWrapEl) return;
  const op = String(operator || "").trim() || "Service";
  const ln = String(line || "").trim() || "—";
  const dest = String(headsign || "").trim();
  if (journeyPanelCrumbEl) {
    journeyPanelCrumbEl.innerHTML = dest
      ? `${esc(op)} › <strong>${esc(ln)}</strong> › ${esc(dest)}`
      : `${esc(op)} › <strong>${esc(ln)}</strong>`;
  }
  if (journeyPanelDetailEl) {
    journeyPanelDetailEl.innerHTML = detailHtml || "";
    journeyPanelDetailEl.hidden = !detailHtml;
  }
  if (journeyPanelMetaEl) {
    const bits = [`Service: ${ln}`];
    if (date) bits.push(`Date: ${date}`);
    bits.push(`${(stops || []).length} stops`);
    journeyPanelMetaEl.textContent = bits.join(" · ");
  }
  renderJourneyPanelStops(stops, { lat, lng });
  setJourneyPanelOpen(true);
}

function hideJourneyPanel() {
  selectedMapMarker = null;
  if (journeyPanelDetailEl) {
    journeyPanelDetailEl.innerHTML = "";
    journeyPanelDetailEl.hidden = true;
  }
  if (journeyPanelTimetableEl) journeyPanelTimetableEl.hidden = true;
  if (journeyPanelColsEl) {
    journeyPanelColsEl.hidden = true;
    journeyPanelColsEl.setAttribute("aria-hidden", "true");
  }
  if (journeyPanelStopsEl) journeyPanelStopsEl.innerHTML = "";
  if (journeyPanelCrumbEl) journeyPanelCrumbEl.textContent = "";
  if (journeyPanelMetaEl) journeyPanelMetaEl.textContent = "";
  setJourneyPanelOpen(false);
}

function sidePanelCrumbForMarker(marker) {
  if (marker?.staff) {
    const line = staffLineName(marker.staff) || "AT";
    const dest =
      marker.extra?.to ||
      marker.staff.currentJourney?.destination?.name ||
      "Alton Towers";
    return { operator: "D&G Bus", line, dest };
  }
  const bus = marker?.bus;
  if (!bus) return { operator: "Service", line: "—", dest: "" };
  const op = operatorName(bus, marker.extra || {}) || (isNationalExpress(bus) ? "National Express" : isFlixBus(bus) ? "FlixBus" : "Service");
  const line =
    extractRouteFromVehicle(bus) ||
    bus.service?.line_name ||
    (isNotInService(bus) ? "Not in service" : "—");
  const dest = marker.extra?.to || bus.destination || "";
  return { operator: op, line, dest };
}

function refreshBusSidePanel(marker) {
  if (!marker || selectedMapMarker !== marker || !journeyPanelEl || journeyPanelEl.hidden) return;
  rememberNextStop(marker);
  marker._lastPopupStructure = "";
  const crumb = sidePanelCrumbForMarker(marker);
  const ll = marker.getLatLng?.() || {};
  const stops = marker.extra?.stops || [];
  const detailHtml = marker.bus
    ? popupHtml(marker.bus, marker.extra || {}, { omitStops: true, sidePanel: true })
    : marker.staff
      ? staffPopup(marker.staff, marker.extra || {}, { omitStops: true, sidePanel: true })
      : "";
  if (journeyPanelCrumbEl) {
    journeyPanelCrumbEl.innerHTML = crumb.dest
      ? `${esc(crumb.operator)} › <strong>${esc(crumb.line)}</strong> › ${esc(crumb.dest)}`
      : `${esc(crumb.operator)} › <strong>${esc(crumb.line)}</strong>`;
  }
  if (journeyPanelDetailEl) {
    journeyPanelDetailEl.innerHTML = detailHtml || "";
    journeyPanelDetailEl.hidden = !detailHtml;
  }
  renderJourneyPanelStops(stops, { lat: ll.lat, lng: ll.lng });
  if (journeyPanelMetaEl) {
    const bits = [`Service: ${crumb.line}`];
    if (stops.length) bits.push(`${stops.length} stops`);
    if (marker.bus?.datetime) bits.push(timeAgo(marker.bus.datetime));
    journeyPanelMetaEl.textContent = bits.join(" · ");
  }
}

function previewSelectedCoachRoute(marker) {
  const bus = marker?.bus;
  if (!bus || !isCoachTrailOperator(trailOperatorForBus(bus))) return;
  const extra = marker.extra || {};
  const line = String(bus.service?.line_name || extra.line || "").trim();
  const operator = trailOperatorForBus(bus);
  const datetime = bus.datetime || "";
  const trailKey = String(bus.id || liveTrailKeyForMarker(marker) || "");
  startRoutePlayback({
    tripId: bus.trip_id || extra.tripId || "",
    journeyId: bus.journey_id || "",
    vehicleId: historyVehicleId(bus, extra),
    trailKey,
    reg: busRegistration(bus, extra) || bus.vehicle?.reg || extra.coachReg || "",
    line,
    operator,
    direction: bus.direction || bus.directionRef || extra.direction || "",
    dest: extra.to || bus.destination || "",
    datetime,
    showTail: true,
    live: true,
  })
    .then(() => {
      if (!playback && trailKey) {
        rememberTrailVehicle(trailKey);
        setLiveTrailFocus(trailKey);
      }
    })
    .catch(() => {
      if (trailKey) {
        rememberTrailVehicle(trailKey);
        setLiveTrailFocus(trailKey);
      }
    });
}

function selectMapMarker(marker) {
  if (!marker) return;
  try {
    marker.closePopup?.();
  } catch {
    /* ignore */
  }
  selectedMapMarker = marker;
  // At overview zoom, selecting a coach opens the same full planned route view
  // as Bustimes: white route ahead, coloured travelled tail behind. At close
  // zoom keep the lightweight live GPS tail; Follow still controls the camera.
  if (marker.bus && isCoachTrailOperator(trailOperatorForBus(marker.bus))) {
    if (!playback && map.getZoom() <= 10) {
      previewSelectedCoachRoute(marker);
    } else {
      const coachTrailKey = liveTrailKeyForMarker(marker);
      if (coachTrailKey) {
        rememberTrailVehicle(coachTrailKey);
        setLiveTrailFocus(coachTrailKey);
      }
    }
  }
  marker._lastPopupStructure = "";
  if (marker._occRetry) clearTimeout(marker._occRetry);
  marker._occRetry = null;
  marker._occRetryAt = 0;
  marker._occAttempts = 0;
  marker._occAt = 0;      // bypass the 60s cooldown on selection
  marker._occBusy = false;
  const crumb = sidePanelCrumbForMarker(marker);
  const ll = marker.getLatLng?.() || {};
  showJourneyPanel({
    operator: crumb.operator,
    line: crumb.line,
    headsign: crumb.dest,
    stops: marker.extra?.stops || [],
    lat: ll.lat,
    lng: ll.lng,
    detailHtml: marker.bus
      ? popupHtml(marker.bus, marker.extra || {}, { omitStops: true, sidePanel: true })
      : marker.staff
        ? staffPopup(marker.staff, marker.extra || {}, { omitStops: true, sidePanel: true })
        : "",
  });
  if (marker.bus) enrichBustimes(marker);
  else if (marker.staff) enrichStaff(marker);
  // Load First seat counts immediately on selection (bypass the 60s cooldown on first click).
  refreshFirstOccupancyIfDue(marker);
}

function clearMapMarkerSelection({ keepPlayback = false } = {}) {
  selectedMapMarker = null;
  if (!keepPlayback && !playback) hideJourneyPanel();
  else if (!playback) hideJourneyPanel();
}

const TRAIL_STORE_KEY = "uk-bus-trails-v3";
const PLANNED_ROUTE_STORE_KEY = "uk-bus-planned-routes-v1";
const TRAIL_MAX_POINTS = 8000;
const TRAIL_MAX_VEHICLES = 60;
/** Server + local GPS tails are always kept for this many days (independent of Plus history chips). */
const TRAIL_KEEP_DAYS = 5;
// The server-side recorder is the canonical five-day store. Uploading every
// viewer's duplicate local trail stream adds POSTs and JSON work without adding
// history; keep the client queue available as an explicit fallback switch.
const CLIENT_TRAIL_UPLOADS_ENABLED = false;
const trailMem = new Map();
const trailPersistIds = new Set();
let trailPersistTimer = null;
let liveTrailLine = null;
let liveTrailKey = "";
let liveTrailAlignGen = 0;
let liveTrailRefreshTimer = null;
let liveTrailAlignBusy = false;
let liveTrailAlignWanted = null;
const pinnedTrailRefreshTimers = new Map();
/** Trails kept on the map after a route finishes (keyed by trail id / reg:…). */
const pinnedTrailKeys = new Set();
const pinnedTrailLines = new Map();
const pinnedTrailAlignGen = new Map();
const pinnedTrailAlignBusy = new Map();
const pinnedTrailAlignWanted = new Map();
const trailUploadQueue = new Map(); // key -> points[]
let trailUploadTimer = null;
const trailServerFetched = new Map(); // key -> last fetch ms

function scheduleLiveTrailRefresh(key) {
  if (!key || String(liveTrailKey) !== String(key)) return;
  if (liveTrailRefreshTimer) return;
  liveTrailRefreshTimer = setTimeout(() => {
    liveTrailRefreshTimer = null;
    if (liveTrailKey) refreshLiveTrailLine(liveTrailKey);
  }, 750);
}

function schedulePinnedTrailRefresh(key) {
  const id = String(key || "");
  if (!id || !pinnedTrailKeys.has(id)) return;
  if (pinnedTrailRefreshTimers.has(id)) return;
  pinnedTrailRefreshTimers.set(
    id,
    setTimeout(() => {
      pinnedTrailRefreshTimers.delete(id);
      if (pinnedTrailKeys.has(id)) refreshPinnedTrailLine(id);
    }, 750),
  );
}

function regTrailKey(reg) {
  const plate = compactReg(reg);
  return plate ? `reg:${plate}` : "";
}

/** Bustimes / UI row ids that must not be used to filter GPS trail points. */
function normalizeTrailJourneyId(raw) {
  const id = String(raw || "").trim();
  if (!id) return "";
  if (/^(at-live-|at-trail-|live-|at-jny-$)/i.test(id)) return "";
  const atJny = id.match(/^at-jny-(.+)$/i);
  if (atJny) return String(atJny[1] || "").trim();
  return id;
}

function trailFilterJourneyId(raw, line = "") {
  // AT employee AVL journey ids flap — filter by line + time only.
  if (isAltonLine(line)) return "";
  return normalizeTrailJourneyId(raw);
}

function loadTrailStore() {
  try {
    const raw = localStorage.getItem(TRAIL_STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return;
    for (const [key, points] of Object.entries(data)) {
      if (!Array.isArray(points) || !points.length) continue;
      trailMem.set(String(key), points);
      trailPersistIds.add(String(key));
    }
  } catch {
    // Ignore corrupt trail cache.
  }
}

function pruneTrailPoints(points, days = TRAIL_KEEP_DAYS) {
  if (!points?.length) return [];
  const cutoff = Date.now() - Math.max(1, days) * 86400000;
  const normalized = points
    .map((p) => {
      if (!p) return null;
      const t = Number.isFinite(p.t) ? Number(p.t) : Date.parse(p.t);
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { ...p, t, lat, lng };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
  let start = 0;
  while (start < normalized.length && normalized[start].t < cutoff) start += 1;
  const kept = start ? normalized.slice(start) : normalized;
  if (kept.length > TRAIL_MAX_POINTS) return kept.slice(kept.length - TRAIL_MAX_POINTS);
  return kept;
}

const plannedRouteMem = new Map();

function plannedRouteCacheKey({ tripId = "", line = "", operator = "", date = "", destination = "" } = {}) {
  const trip = String(tripId || "").trim();
  if (trip) return `trip:${trip}`;
  const raw = [operator, line, date, destination]
    .map((value) => String(value || "").trim().toUpperCase())
    .join("|");
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `route:${(hash >>> 0).toString(16)}:${raw.slice(0, 80)}`;
}

function prunePlannedRouteMem(now = Date.now()) {
  const cutoff = now - TRAIL_KEEP_DAYS * 86400000;
  for (const [key, row] of plannedRouteMem) {
    if (!row || Number(row.savedAt) < cutoff) plannedRouteMem.delete(key);
  }
  // Keep local storage bounded even when a user opens many coach trips.
  while (plannedRouteMem.size > 80) {
    const oldest = [...plannedRouteMem.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt)[0];
    if (!oldest) break;
    plannedRouteMem.delete(oldest[0]);
  }
}

function loadPlannedRouteStore() {
  try {
    const raw = localStorage.getItem(PLANNED_ROUTE_STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return;
    for (const [key, row] of Object.entries(data)) {
      if (!row || !Array.isArray(row.path) || row.path.length < 2) continue;
      plannedRouteMem.set(String(key), {
        ...row,
        path: row.path
          .map((point) => [Number(point?.[0]), Number(point?.[1])])
          .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng)),
        savedAt: Number(row.savedAt) || 0,
      });
    }
  } catch {
    /* Ignore an unavailable/corrupt planned-route cache. */
  }
  prunePlannedRouteMem();
}

function persistPlannedRouteMem() {
  try {
    const data = Object.fromEntries(plannedRouteMem.entries());
    localStorage.setItem(PLANNED_ROUTE_STORE_KEY, JSON.stringify(data));
  } catch {
    /* Storage is an optimisation; Bustimes remains the source of truth. */
  }
}

function rememberPlannedRoute(path, meta = {}) {
  const flat = flattenTrailLatLngs(path);
  if (flat.length < 2) return "";
  const key = plannedRouteCacheKey(meta);
  const prior = plannedRouteMem.get(key);
  if (prior?.roadAligned && !meta.roadAligned) return key;
  const stored = thinTrailPoints(flat, 35).slice(0, 3500);
  if (stored.length < 2) return "";
  plannedRouteMem.set(key, {
    savedAt: Date.now(),
    roadAligned: Boolean(meta.roadAligned),
    path: stored,
    tripId: String(meta.tripId || ""),
    line: String(meta.line || ""),
    operator: String(meta.operator || "").trim().toUpperCase(),
    date: String(meta.date || ""),
    destination: String(meta.destination || ""),
  });
  prunePlannedRouteMem();
  persistPlannedRouteMem();
  return key;
}

function recallPlannedRoute(meta = {}) {
  prunePlannedRouteMem();
  const row = plannedRouteMem.get(plannedRouteCacheKey(meta));
  if (!row || row.diverted || row.path?.length < 2) return [];
  return row.path.map((point) => [point[0], point[1]]);
}

function markPlannedRouteDiverted(meta = {}) {
  const key = plannedRouteCacheKey(meta);
  const row = plannedRouteMem.get(key);
  if (!row) return;
  row.diverted = true;
  plannedRouteMem.set(key, row);
  persistPlannedRouteMem();
}

function trailPointMetaScore(p) {
  if (!p) return 0;
  let score = 0;
  if (p.journeyId) score += 4;
  if (p.tripId) score += 2;
  if (normalizeTrailDirection(p.direction)) score += 2;
  if (String(p.destination || "").trim()) score += 2;
  if (p.line) score += 1;
  if (p.operator) score += 1;
  return score;
}

function mergeTrailPoints(existing, incoming) {
  const map = new Map();
  for (const raw of [...(existing || []), ...(incoming || [])]) {
    if (!raw) continue;
    const t = Number.isFinite(raw.t) ? Number(raw.t) : Date.parse(raw.t);
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const p = { ...raw, t, lat, lng };
    const k = `${Math.round(p.t / 500)}:${p.lat.toFixed(5)}:${p.lng.toFixed(5)}`;
    const prev = map.get(k);
    // Prefer server/recorder metadata over sparse local samples at the same ping.
    if (!prev || trailPointMetaScore(p) > trailPointMetaScore(prev)) map.set(k, p);
  }
  return pruneTrailPoints([...map.values()].sort((a, b) => a.t - b.t));
}

function queueTrailUpload(key, point) {
  if (!CLIENT_TRAIL_UPLOADS_ENABLED) return;
  if (!key || !point) return;
  const id = String(key);
  let list = trailUploadQueue.get(id);
  if (!list) {
    list = [];
    trailUploadQueue.set(id, list);
  }
  list.push(point);
  if (list.length > 400) trailUploadQueue.set(id, list.slice(-400));
  if (trailUploadTimer) return;
  trailUploadTimer = setTimeout(() => {
    trailUploadTimer = null;
    flushTrailUpload().catch(() => {});
  }, 5000);
}

async function flushTrailUpload() {
  if (!trailUploadQueue.size) return;
  const batches = [];
  for (const [key, points] of trailUploadQueue.entries()) {
    if (!points.length) continue;
    batches.push({ key, points: points.splice(0, 80) });
  }
  // Cap payload so nginx/express never reject with PayloadTooLargeError.
  while (batches.length > 12) batches.pop();
  for (const [key, points] of [...trailUploadQueue.entries()]) {
    if (!points.length) trailUploadQueue.delete(key);
  }
  if (!batches.length) return;
  try {
    await fetch("/api/trails/points", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batches }),
    });
  } catch {
    // Re-queue on failure.
    for (const batch of batches) {
      const cur = trailUploadQueue.get(batch.key) || [];
      trailUploadQueue.set(batch.key, [...batch.points, ...cur].slice(-400));
    }
  }
}

function preferTrailFetchKeys(keys, { limit = 12 } = {}) {
  const list = [...new Set((keys || []).map((k) => String(k || "").trim()).filter(Boolean))];
  const rank = (key) => {
    // Journey/trip first so Map · trail keeps FPOT/Staffs per-trip GPS when the key budget is tight.
    if (key.startsWith("jny:") || key.startsWith("trip:")) return 0;
    if (key.startsWith("at:")) return 1;
    if (key.startsWith("staff-")) return 2;
    if (key.startsWith("run:") && key.includes(":jny:")) return 3;
    if (key.startsWith("run:")) return 4;
    if (key.startsWith("reg:")) return 5;
    return 6;
  };
  list.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return Number.isFinite(limit) && limit > 0 ? list.slice(0, limit) : list;
}

async function fetchServerTrails(keys, { fromMs = 0, toMs = 0, force = false } = {}) {
  const list = preferTrailFetchKeys(keys, { limit: 12 });
  if (!list.length) return;
  const now = Date.now();
  const need = force
    ? list
    : list.filter((key) => {
        const at = trailServerFetched.get(key) || 0;
        return now - at > 45_000;
      });
  if (!need.length) return;
  try {
    const params = new URLSearchParams({
      keys: need.join(","),
      days: String(TRAIL_KEEP_DAYS),
    });
    if (fromMs) params.set("from", String(fromMs));
    if (toMs) params.set("to", String(toMs));
    const res = await fetch(`/api/trails?${params}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data?.disabled) return;
    const trails = data?.trails && typeof data.trails === "object" ? data.trails : {};
    for (const key of need) {
      trailServerFetched.set(key, now);
      const incoming = Array.isArray(trails[key]) ? trails[key] : [];
      if (!incoming.length) continue;
      const merged = mergeTrailPoints(trailMem.get(key) || [], incoming);
      trailMem.set(key, merged);
      trailPersistIds.add(key);
      if (pinnedTrailKeys.has(String(key))) schedulePinnedTrailRefresh(String(key));
      if (String(liveTrailKey) === String(key)) scheduleLiveTrailRefresh(String(key));
    }
    scheduleTrailPersist();
  } catch {
    /* keep local */
  }
}

function flushTrailStore() {
  trailPersistTimer = null;
  try {
    const out = {};
    const keys = [...trailPersistIds].slice(-TRAIL_MAX_VEHICLES);
    for (const key of keys) {
      const pts = pruneTrailPoints(trailMem.get(key) || []);
      if (pts.length) out[key] = pts;
      trailMem.set(key, pts);
    }
    localStorage.setItem(TRAIL_STORE_KEY, JSON.stringify(out));
  } catch {
    // Quota exceeded — drop oldest vehicles.
    try {
      const keys = [...trailPersistIds];
      while (keys.length > 10) {
        const drop = keys.shift();
        trailPersistIds.delete(drop);
        trailMem.delete(drop);
      }
      localStorage.setItem(
        TRAIL_STORE_KEY,
        JSON.stringify(Object.fromEntries(keys.map((k) => [k, trailMem.get(k) || []]))),
      );
    } catch {
      // Give up quietly.
    }
  }
}

function scheduleTrailPersist() {
  if (trailPersistTimer) return;
  trailPersistTimer = setTimeout(flushTrailStore, 4000);
}

function rememberTrailVehicle(key) {
  if (!key) return;
  trailPersistIds.add(String(key));
  scheduleTrailPersist();
}

function normalizeTrailDirection(raw) {
  const d = String(raw || "")
    .trim()
    .toLowerCase();
  if (!d) return "";
  if (/^(in|inbound|i|1)$/.test(d)) return "in";
  if (/^(out|outbound|o|0)$/.test(d)) return "out";
  return "";
}

function normalizeTrailDestination(raw) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[,–-]\s*(bus station|bus stn|arrival)\b.*$/i, "")
    .replace(/\s+(bus station|bus stn|arrival|edensor road)\b.*$/i, "")
    .trim();
}

/** Ordinary live follow remains marker-only; coach follows opt into a clipped live tail below. */
const SHOW_LIVE_TAIL_WHILE_FOLLOWING = false;

function trailKeysForVehicle({
  vehicleId = "",
  trailKey = "",
  reg = "",
  journeyId = "",
  tripId = "",
  line = "",
  datetime = "",
  direction = "",
} = {}) {
  const keys = [];
  const seen = new Set();
  const push = (key) => {
    if (!key) return;
    const id = String(key);
    if (seen.has(id)) return;
    seen.add(id);
    keys.push(id);
  };
  push(trailKey);
  push(vehicleId);
  for (const raw of [trailKey, vehicleId]) {
    const bods = String(raw || "").match(/^bods-(NATX|FLIX)-(.+)$/i);
    if (bods) push(`bods-${bods[2]}`);
  }
  push(regTrailKey(reg));
  const jid = trailFilterJourneyId(journeyId, line);
  const tid = String(tripId || "").trim();
  if (jid) push(`jny:${jid}`);
  if (tid) push(`trip:${tid}`);
  const lineCode = String(line || "").trim().toUpperCase();
  const dir = normalizeTrailDirection(direction);
  const primary = String(trailKey || vehicleId || regTrailKey(reg) || "").trim();
  if (lineCode && primary) {
    const day = datetime ? ukDateKey(datetime) : ukDateKey();
    if (day && day !== "Invalid Date") {
      if (dir) {
        push(`run:${primary}:${lineCode}:${dir}:${day}`);
        if (ALTON_LINES.has(lineCode)) push(`at:${lineCode}:${dir}:${primary}:${day}`);
        // Also try UTC day key for older writes.
        const utcDay = new Date(datetime || Date.now()).toISOString().slice(0, 10);
        if (utcDay && utcDay !== day) {
          push(`run:${primary}:${lineCode}:${dir}:${utcDay}`);
          if (ALTON_LINES.has(lineCode)) push(`at:${lineCode}:${dir}:${primary}:${utcDay}`);
        }
      } else if (jid) {
        // First Potteries / Staffs locals often omit in/out — keep one run key per journey.
        push(`run:${primary}:${lineCode}:jny:${jid}`);
        push(`run:${primary}:${lineCode}:${day}`);
        if (ALTON_LINES.has(lineCode)) push(`at:${lineCode}:${primary}:${day}`);
      } else {
        // No direction yet — undirected keys only (direction will be inferred/clipped later).
        push(`run:${primary}:${lineCode}:${day}`);
        if (ALTON_LINES.has(lineCode)) push(`at:${lineCode}:${primary}:${day}`);
      }
    }
  }
  return keys;
}

function shouldRecordClientTrail(key, meta = {}) {
  if (meta._force || meta._segmented) return true;
  const id = String(key || "");
  if (!id) return false;
  if (pinnedTrailKeys.has(id) || String(liveTrailKey) === id) return true;
  const selected = selectedMapMarker;
  if (selected?.bus) {
    if (id === String(selected.bus.id || "")) return true;
    if (id === String(selected.extra?.trailKey || "")) return true;
  }
  if (selected?.staff && id === staffTrailKey(selected.staff)) return true;
  if (followTarget?.kind === "bus" && id === String(followTarget.id || "")) return true;
  return false;
}

function recordVehicleTrail(key, lat, lng, heading, meta = {}) {
  if (!key || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const id = String(key);
  if (!shouldRecordClientTrail(id, meta)) return;
  let points = trailMem.get(id);
  if (!points) {
    points = [];
    trailMem.set(id, points);
  }
  const now = Number.isFinite(meta.t) ? meta.t : Date.now();
  const last = points[points.length - 1];
  if (last) {
    const dt = now - last.t;
    const moved = haversineMeters(last.lat, last.lng, lat, lng);
    const turn = Number.isFinite(heading) && Number.isFinite(last.heading) ? angleDiff(heading, last.heading) : 0;
    if (dt < 700 && moved < 2.5 && turn < 8) return;
    if (dt < 2500 && moved < 1.2) return;
  }
  const journeyId = meta.journeyId != null ? String(meta.journeyId) : "";
  const tripId = meta.tripId != null ? String(meta.tripId) : "";
  const line = meta.line != null ? String(meta.line) : "";
  const direction = normalizeTrailDirection(meta.direction);
  const destination = String(meta.destination || meta.dest || "").trim();
  points.push({
    t: now,
    lat,
    lng,
    heading: Number.isFinite(heading) ? heading : null,
    journeyId,
    tripId,
    line,
    direction,
    destination,
    operator: meta.operator != null ? String(meta.operator).trim().toUpperCase() : "",
  });
  queueTrailUpload(id, points[points.length - 1]);
  if (points.length > TRAIL_MAX_POINTS + 200) {
    trailMem.set(id, points.slice(points.length - TRAIL_MAX_POINTS));
  }
  rememberTrailVehicle(id);
  if (String(liveTrailKey) === id) scheduleLiveTrailRefresh(id);
  if (pinnedTrailKeys.has(id)) schedulePinnedTrailRefresh(id);

  if (meta._segmented) return;

  const plateKey = regTrailKey(meta.reg);
  if (plateKey && plateKey !== id) {
    recordVehicleTrail(plateKey, lat, lng, heading, { ...meta, reg: "", _segmented: true });
  }
  if (journeyId) {
    const seg = `jny:${journeyId}`;
    if (seg !== id) recordVehicleTrail(seg, lat, lng, heading, { ...meta, reg: "", _segmented: true });
  }
  if (tripId) {
    const seg = `trip:${tripId}`;
    if (seg !== id) recordVehicleTrail(seg, lat, lng, heading, { ...meta, reg: "", _segmented: true });
  }
  if (line) {
    const day = new Date(now).toISOString().slice(0, 10);
    const lineCode = String(line).trim().toUpperCase();
    if (direction) {
      const runSeg = `run:${id}:${lineCode}:${direction}:${day}`;
      if (runSeg !== id) recordVehicleTrail(runSeg, lat, lng, heading, { ...meta, reg: "", _segmented: true });
      if (ALTON_LINES.has(lineCode)) {
        const atSeg = `at:${lineCode}:${direction}:${id}:${day}`;
        if (atSeg !== id) recordVehicleTrail(atSeg, lat, lng, heading, { ...meta, reg: "", _segmented: true });
      }
    } else if (journeyId) {
      const runSeg = `run:${id}:${lineCode}:jny:${journeyId}`;
      if (runSeg !== id) recordVehicleTrail(runSeg, lat, lng, heading, { ...meta, reg: "", _segmented: true });
      if (ALTON_LINES.has(lineCode)) {
        const atSeg = `at:${lineCode}:${id}:${day}`;
        if (atSeg !== id) recordVehicleTrail(atSeg, lat, lng, heading, { ...meta, reg: "", _segmented: true });
      }
    } else {
      const runSeg = `run:${id}:${lineCode}:${day}`;
      if (runSeg !== id) recordVehicleTrail(runSeg, lat, lng, heading, { ...meta, reg: "", _segmented: true });
      if (ALTON_LINES.has(lineCode)) {
        const atSeg = `at:${lineCode}:${id}:${day}`;
        if (atSeg !== id) recordVehicleTrail(atSeg, lat, lng, heading, { ...meta, reg: "", _segmented: true });
      }
    }
  }
}

function trackedPointsFor(key, { journeyId = "", tripId = "", fromMs = 0, toMs = 0, line = "", direction = "" } = {}) {
  const points = trailMem.get(String(key)) || [];
  if (!points.length) return [];
  const jid = trailFilterJourneyId(journeyId, line);
  const tid = tripId ? String(tripId) : "";
  const wantLine = String(line || "").trim();
  const wantDir = normalizeTrailDirection(direction);
  return points.filter((p) => {
    if (fromMs && Number(p.t) < fromMs) return false;
    if (toMs && Number(p.t) > toMs) return false;
    if (jid && p.journeyId && String(p.journeyId) !== jid) return false;
    if (tid && p.tripId && String(p.tripId) !== tid) return false;
    if (wantLine && p.line && !sameServiceLine(p.line, wantLine)) return false;
    // When a direction is requested, drop the opposite leg — but keep undirected
    // pings so sparse AVL (common on Staffs routes) does not freeze the live tail.
    if (wantDir) {
      const pDir = normalizeTrailDirection(p.direction);
      if (pDir && pDir !== wantDir) return false;
    }
    return true;
  });
}

function trackedPathLatLngs(key, opts = {}) {
  return pathFromGpsPoints(trackedPointsFor(key, opts));
}

/** Pick inbound or outbound from points near a time — never both. */
function inferTrailDirection(points, aroundMs = 0) {
  const list = Array.isArray(points) ? points : [];
  if (!list.length) return "";
  if (Number.isFinite(aroundMs) && aroundMs > 0) {
    let best = null;
    for (const p of list) {
      const d = normalizeTrailDirection(p.direction);
      if (!d) continue;
      const dt = Math.abs(Number(p.t) - aroundMs);
      if (!Number.isFinite(dt)) continue;
      if (!best || dt < best.dt) best = { d, dt };
    }
    if (best) return best.d;
  }
  let inn = 0;
  let out = 0;
  for (const p of list) {
    const d = normalizeTrailDirection(p.direction);
    if (d === "in") inn += 1;
    else if (d === "out") out += 1;
  }
  if (!inn && !out) return "";
  return out >= inn ? "out" : "in";
}

function trailHeadingDelta(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  let d = Math.abs(Number(b) - Number(a)) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * Split GPS into one continuous run per trip.
 * Hanley→Newcastle and Newcastle→Hanley become separate segments (never one there-and-back line).
 * Intermediate stop dwells (headsign / journey-id flap) stay on the same run until terminus turnaround.
 */
function segmentTrailIntoTrips(points, { gapMs = 18 * 60_000 } = {}) {
  const list = (Array.isArray(points) ? points.slice() : [])
    .filter(
      (p) =>
        Number.isFinite(Number(p?.t)) &&
        Number.isFinite(Number(p?.lat)) &&
        Number.isFinite(Number(p?.lng)),
    )
    .sort((a, b) => Number(a.t) - Number(b.t));
  if (list.length < 2) return list.length ? [list] : [];

  // Journey/trip id noise at stops is common — only honour an id flip after a real layover.
  // Coaches (gapMs ≥ 45m): allow long intermediate stops (Hanley, airports) without splitting.
  const idFlipMs =
    gapMs >= 40 * 60_000
      ? Math.min(Math.max(45 * 60_000, gapMs), 90 * 60_000)
      : Math.min(Math.max(5 * 60_000, gapMs * 0.25), 12 * 60_000);
  const runs = [];
  let cur = [list[0]];
  for (let i = 1; i < list.length; i += 1) {
    const prev = cur[cur.length - 1];
    const next = list[i];
    const dt = Number(next.t) - Number(prev.t);
    const prevDir = normalizeTrailDirection(prev.direction);
    const nextDir = normalizeTrailDirection(next.direction);
    const prevJ = String(prev.journeyId || "").trim();
    const nextJ = String(next.journeyId || "").trim();
    const prevTrip = String(prev.tripId || "").trim();
    const nextTrip = String(next.tripId || "").trim();
    const prevLine = String(prev.line || "").trim().toUpperCase();
    const nextLine = String(next.line || "").trim().toUpperCase();
    const lineFlip = Boolean(prevLine && nextLine && prevLine !== nextLine);
    // Direction flip always starts a new trip — even when the bus turns at the terminus.
    const dirFlip = Boolean(prevDir && nextDir && prevDir !== nextDir);
    const sameDir = Boolean(prevDir && nextDir && prevDir === nextDir);
    const sameLine = Boolean(prevLine && nextLine && prevLine === nextLine);
    // Journey/trip id change:
    // - Different direction or line → always split (Hanley→Newcastle vs Newcastle→Hanley).
    // - Same directed run → ignore short id flaps at intermediate stops.
    // - Missing direction on same line → still split after a short dwell so there-and-back
    //   legs are never glued into one continuous history trail.
    const journeyFlip = Boolean(
      prevJ &&
        nextJ &&
        prevJ !== nextJ &&
        (dirFlip ||
          lineFlip ||
          !sameDir ||
          (Number.isFinite(dt) && dt > Math.min(idFlipMs, 3 * 60_000))),
    );
    const tripFlip = Boolean(
      prevTrip &&
        nextTrip &&
        prevTrip !== nextTrip &&
        (dirFlip ||
          lineFlip ||
          !sameDir ||
          (Number.isFinite(dt) && dt > Math.min(idFlipMs, 3 * 60_000))),
    );
    // Destination flip when journey/trip ids are missing — not mid-trip next-stop headsign noise.
    const prevDest = normalizeTrailDestination(prev.destination);
    const nextDest = normalizeTrailDestination(next.destination);
    const sameJourney = Boolean(prevJ && nextJ && prevJ === nextJ);
    const sameTrip = Boolean(prevTrip && nextTrip && prevTrip === nextTrip);
    const destFlip = Boolean(
      !sameJourney &&
        !sameTrip &&
        !sameDir &&
        prevDest &&
        nextDest &&
        prevDest !== nextDest &&
        Number.isFinite(dt) &&
        dt > Math.min(idFlipMs, 2 * 60_000),
    );
    const gap = Number.isFinite(dt) && dt > gapMs;

    let turnaround = false;
    if (!dirFlip && !journeyFlip && !tripFlip && !destFlip && !gap && !lineFlip && cur.length >= 10) {
      const start = cur[0];
      const runDist = haversineMeters(start.lat, start.lng, prev.lat, prev.lng);
      const step = haversineMeters(prev.lat, prev.lng, next.lat, next.lng);
      const headFlip = trailHeadingDelta(prev.heading, next.heading) >= 135;
      // U-turn after a real outbound: reverse heading while barely moving.
      if (runDist >= 700 && headFlip && step < 140) turnaround = true;
    }

    if (journeyFlip || tripFlip || dirFlip || destFlip || gap || turnaround || lineFlip) {
      if (cur.length >= 2) runs.push(cur);
      cur = [next];
    } else {
      cur.push(next);
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

/** Keep one continuous there-OR-back run around a time — drop the return leg. */
function clipPointsToSingleDirectionRun(points, { direction = "", aroundMs = 0 } = {}) {
  const runs = segmentTrailIntoTrips(points);
  if (!runs.length) return [];
  const wantDir = normalizeTrailDirection(direction);
  const pool = wantDir
    ? runs.filter((run) => {
        const d = inferTrailDirection(run) || normalizeTrailDirection(run.find((p) => p.direction)?.direction);
        return !d || d === wantDir;
      })
    : runs;
  const list = pool.length ? pool : runs;
  if (!(Number.isFinite(aroundMs) && aroundMs > 0)) {
    return list.reduce((best, run) => (run.length > best.length ? run : best), list[0]);
  }
  let best = list[0];
  let bestDt = Infinity;
  for (const run of list) {
    const mid = run[Math.floor(run.length / 2)];
    const start = Number(run[0].t);
    const end = Number(run[run.length - 1].t);
    let dt = Infinity;
    if (aroundMs >= start && aroundMs <= end) dt = 0;
    else {
      dt = Math.min(Math.abs(aroundMs - start), Math.abs(aroundMs - end));
      if (Number.isFinite(mid?.t)) dt = Math.min(dt, Math.abs(aroundMs - Number(mid.t)));
    }
    if (dt < bestDt || (dt === bestDt && run.length > best.length)) {
      best = run;
      bestDt = dt;
    }
  }
  return best;
}

/**
 * First Potteries and other local feeds can change journey/trip IDs at an
 * intermediate stop or terminus while the same physical run continues. A
 * Fleet replay row represents that run, so join those short, same-line pieces
 * instead of stopping at the first ID. Direction/line changes and real gaps
 * still start a separate replay.
 */
const RECORDED_REPLAY_JOIN_GAP_MS = 22 * 60_000;
const RECORDED_REPLAY_MAX_JUMP_M = 8_000;

function recordedReplayRunDirection(run) {
  return inferTrailDirection(run) || normalizeTrailDirection(run?.find((p) => p?.direction)?.direction);
}

function canJoinRecordedReplayRuns(previous, next, { line = "", direction = "", maxGapMs = RECORDED_REPLAY_JOIN_GAP_MS } = {}) {
  if (!previous?.length || !next?.length) return false;
  const previousEnd = previous[previous.length - 1];
  const nextStart = next[0];
  const gap = Number(nextStart.t) - Number(previousEnd.t);
  if (!Number.isFinite(gap) || gap < 0 || gap > maxGapMs) return false;

  const previousLine = String(previous.find((p) => p?.line)?.line || "").trim().toUpperCase();
  const nextLine = String(next.find((p) => p?.line)?.line || "").trim().toUpperCase();
  const wantedLine = String(line || "").trim().toUpperCase();
  if (previousLine && nextLine && !sameServiceLine(previousLine, nextLine)) return false;
  if (wantedLine && previousLine && !sameServiceLine(previousLine, wantedLine)) return false;
  if (wantedLine && nextLine && !sameServiceLine(nextLine, wantedLine)) return false;

  const wantedDirection = normalizeTrailDirection(direction);
  const previousDirection = recordedReplayRunDirection(previous);
  const nextDirection = recordedReplayRunDirection(next);
  if (wantedDirection && previousDirection && previousDirection !== wantedDirection) return false;
  if (wantedDirection && nextDirection && nextDirection !== wantedDirection) return false;
  if (previousDirection && nextDirection && previousDirection !== nextDirection) return false;

  // A journey/trip ID change at a terminus is a new directional run, not an
  // ID flap to repair. First Potteries commonly omits direction metadata, so
  // destination metadata is the reliable boundary signal here. If direction is
  // unavailable, fail closed rather than gluing two opposite journeys together.
  const previousJourney = String(previous.find((p) => p?.journeyId)?.journeyId || "").trim();
  const nextJourney = String(next.find((p) => p?.journeyId)?.journeyId || "").trim();
  const previousTrip = String(previous.find((p) => p?.tripId)?.tripId || "").trim();
  const nextTrip = String(next.find((p) => p?.tripId)?.tripId || "").trim();
  const sameTripIdentity = Boolean(previousTrip && nextTrip && previousTrip === nextTrip);
  const identityChanged =
    !sameTripIdentity &&
    (Boolean(previousJourney) !== Boolean(nextJourney) ||
      Boolean(previousTrip) !== Boolean(nextTrip) ||
      (previousJourney && nextJourney && previousJourney !== nextJourney) ||
      (previousTrip && nextTrip && previousTrip !== nextTrip));
  if (identityChanged) {
    const previousDestination = normalizeTrailDestination(
      previous[previous.length - 1]?.destination || previous.find((p) => p?.destination)?.destination,
    );
    const nextDestination = normalizeTrailDestination(
      next[0]?.destination || next.find((p) => p?.destination)?.destination,
    );
    if (previousDestination && nextDestination && previousDestination !== nextDestination) return false;
    if (!wantedDirection && !previousDirection && !nextDirection) return false;
  }

  const jump = haversineMeters(
    Number(previousEnd.lat),
    Number(previousEnd.lng),
    Number(nextStart.lat),
    Number(nextStart.lng),
  );
  return Number.isFinite(jump) && jump <= RECORDED_REPLAY_MAX_JUMP_M;
}

function mergeRecordedReplayRuns(runs, startIndex, opts = {}) {
  if (!Array.isArray(runs) || !runs.length) return [];
  let first = Math.max(0, Math.min(Number(startIndex) || 0, runs.length - 1));
  let last = first;
  while (
    first > 0 &&
    canJoinRecordedReplayRuns(runs[first - 1], runs[first], opts)
  ) {
    first -= 1;
  }
  while (
    last + 1 < runs.length &&
    canJoinRecordedReplayRuns(runs[last], runs[last + 1], opts)
  ) {
    last += 1;
  }
  const out = [];
  for (let i = first; i <= last; i += 1) {
    for (const point of runs[i]) {
      const previous = out[out.length - 1];
      if (
        previous &&
        Math.abs(Number(previous.t) - Number(point.t)) < 500 &&
        haversineMeters(previous.lat, previous.lng, point.lat, point.lng) < 2
      ) {
        continue;
      }
      out.push(point);
    }
  }
  return out;
}

function findTrailRunIndex(runs, points, aroundMs = 0) {
  if (!runs.length || !points?.length) return -1;
  const firstT = Number(points[0]?.t);
  const lastT = Number(points[points.length - 1]?.t);
  let bestIndex = 0;
  let bestScore = Infinity;
  for (let i = 0; i < runs.length; i += 1) {
    const start = Number(runs[i][0]?.t);
    const end = Number(runs[i][runs[i].length - 1]?.t);
    const overlap = Math.min(lastT, end) - Math.max(firstT, start);
    const distance = aroundMs
      ? Math.min(Math.abs(aroundMs - start), Math.abs(aroundMs - end))
      : Math.abs(aroundMs - (start + end) / 2);
    const score = overlap >= 0 ? -overlap : distance;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/** Merge points from several keys (dedupe by time) for trip segmentation. */
function collectTrailGpsForKeys(keys, filter = {}) {
  const byT = new Map();
  const baseFilter = {
    fromMs: filter.fromMs || 0,
    toMs: filter.toMs || 0,
    line: filter.line || "",
    // Intentionally no direction / journey / trip — we segment those ourselves.
  };
  for (const key of keys || []) {
    if (!key) continue;
    for (const p of trackedPointsFor(key, baseFilter)) {
      const t = Number(p.t);
      if (!Number.isFinite(t)) continue;
      const prev = byT.get(t);
      if (
        !prev ||
        (normalizeTrailDirection(p.direction) && !normalizeTrailDirection(prev.direction)) ||
        (p.journeyId && !prev.journeyId) ||
        (p.tripId && !prev.tripId) ||
        (String(p.destination || "").trim() && !String(prev.destination || "").trim())
      ) {
        byT.set(t, p);
      }
    }
  }
  return [...byT.values()].sort((a, b) => Number(a.t) - Number(b.t));
}

/**
 * Pin each trip as its own tail polyline (Hanley→Newcastle separate from Newcastle→Hanley).
 * Returns the synthetic keys that were drawn.
 */
function pinSeparateTripTails(
  segments,
  { baseKey = "bus", line = "", operator = "", actualRoute = false, plannedRoute = false } = {},
) {
  // A new selection must not inherit arrows from a previous route selection.
  clearTrailArtifacts(liveTrailLayer);
  const drawn = [];
  const base = String(baseKey || "bus")
    .replace(/[^A-Za-z0-9:_-]+/g, "_")
    .slice(0, 56);
  for (const seg of segments || []) {
    if (!Array.isArray(seg) || seg.length < 2) continue;
    const startT = Number(seg[0].t) || 0;
    const endT = Number(seg[seg.length - 1].t) || startT;
    const dir =
      inferTrailDirection(seg, startT + Math.max(0, (endT - startT) / 2)) ||
      normalizeTrailDirection(seg.find((p) => p.direction)?.direction);
    const key = `tripseg:${base}:${startT}`;
    trailMem.set(
      key,
      seg.map((p) => ({
        t: Number(p.t),
        lat: Number(p.lat),
        lng: Number(p.lng),
        heading: Number.isFinite(p.heading) ? p.heading : null,
        journeyId: p.journeyId || "",
        tripId: p.tripId || "",
        line: p.line || line || "",
        direction: normalizeTrailDirection(p.direction) || dir,
        destination: String(p.destination || "").trim(),
        operator: p.operator || operator || "",
      })),
    );
    pinnedTrailFilters.set(key, {
      line: String(line || "").trim(),
      direction: dir,
      fromMs: startT,
      toMs: endT,
      operator: String(operator || "").trim().toUpperCase(),
      actualRoute: Boolean(actualRoute),
      plannedRoute: Boolean(plannedRoute),
    });
    pinnedTrailKeys.add(key);
    refreshPinnedTrailLine(key);
    drawn.push(key);
  }
  return drawn;
}

const TRAIL_STROKE = {
  color: "#5b51e3",
  weight: 3.5,
  opacity: 0.96,
  lineJoin: "round",
  lineCap: "round",
  interactive: false,
  className: "trail-line",
};

const TRAIL_CASING = {
  ...TRAIL_STROKE,
  color: "#f8fafc",
  weight: 8,
  opacity: 0.92,
  className: "trail-line-casing",
};

/** FlixBus history/trails in brand green so they never read as (or blend into) the indigo route lines. */
function trailLineColor(operator) {
  const noc = String(operator || "").trim().toUpperCase();
  if (noc === "FLIX" || noc === "NATX") return "#73d700";
  return TRAIL_STROKE.color;
}

/** Break trails only on real GPS teleports — not normal sparse AVL pings (rural Staffs runs often skip 2–4 km). */
const TRAIL_BREAK_GAP_M = 4500;
const TRAIL_BREAK_HARD_M = 12000;
const TRAIL_BREAK_GAP_MS = 15 * 60_000;
const TRAIL_BREAK_SPEED_MPH = 100;
/** FlixBus / National Express motorway runs — sparse AVL; keep A→B continuous. */
const COACH_TRAIL_NOCS = new Set(["FLIX", "NATX"]);
const COACH_TRAIL_BREAK_GAP_M = 28000;
const COACH_TRAIL_BREAK_HARD_M = 95000;
const COACH_TRAIL_BREAK_GAP_MS = 90 * 60_000;
const COACH_TRAIL_BREAK_SPEED_MPH = 130;
const COACH_TRAIL_LIVE_MS = 14 * 60 * 60 * 1000;
/** Staffs locals + AT1–AT3 — NextStop/AVL can gap 20–40+ min; keep each A→B stint together. */
const STAFFS_TRAIL_NOCS = new Set([
  "FPOT",
  "DAGC",
  "SOST",
  "CRDR",
  "SLBS",
  "BANG",
  "HIPK",
  "TBTN",
  "DIAM",
  "MDCL",
]);
const STAFFS_TRAIL_BREAK_GAP_M = 9000;
const STAFFS_TRAIL_BREAK_HARD_M = 28000;
const STAFFS_TRAIL_BREAK_GAP_MS = 75 * 60_000;
const STAFFS_TRAIL_BREAK_SPEED_MPH = 110;

function isCoachTrailOperator(operator) {
  return COACH_TRAIL_NOCS.has(String(operator || "").trim().toUpperCase());
}

function isStaffsTrailOperator(operator) {
  return STAFFS_TRAIL_NOCS.has(String(operator || "").trim().toUpperCase());
}

/** Staffordshire services with a Bustimes trip can use its published track. */
function usesPlannedRouteOverride(line, operator) {
  // AT1–AT3 are staff/NextStop services and have no Bustimes trip track.
  if (isAltonLine(line)) return false;
  const noc = String(operator || "").trim().toUpperCase();
  return (
    isStaffsTrailOperator(noc) ||
    isCoachTrailOperator(noc) ||
    (sameServiceLine(line, "36A") && (!noc || noc === "FPOT"))
  );
}

function trailBreakLimits({ coach = false, staffs = false, operator = "", continuous = false } = {}) {
  if (continuous) {
    return {
      gapM: 1e12,
      hardM: 1e12,
      gapMs: 1e12,
      speedMph: 1e12,
    };
  }
  if (coach || isCoachTrailOperator(operator)) {
    return {
      gapM: COACH_TRAIL_BREAK_GAP_M,
      hardM: COACH_TRAIL_BREAK_HARD_M,
      gapMs: COACH_TRAIL_BREAK_GAP_MS,
      speedMph: COACH_TRAIL_BREAK_SPEED_MPH,
    };
  }
  if (staffs || isStaffsTrailOperator(operator)) {
    return {
      gapM: STAFFS_TRAIL_BREAK_GAP_M,
      hardM: STAFFS_TRAIL_BREAK_HARD_M,
      gapMs: STAFFS_TRAIL_BREAK_GAP_MS,
      speedMph: STAFFS_TRAIL_BREAK_SPEED_MPH,
    };
  }
  return {
    gapM: TRAIL_BREAK_GAP_M,
    hardM: TRAIL_BREAK_HARD_M,
    gapMs: TRAIL_BREAK_GAP_MS,
    speedMph: TRAIL_BREAK_SPEED_MPH,
  };
}

function trailPointLatLng(p) {
  if (Array.isArray(p)) {
    return {
      lat: Number(p[0]),
      lng: Number(p[1]),
      t: Number(p[3] ?? p.t),
    };
  }
  return {
    lat: Number(p?.lat),
    lng: Number(p?.lng),
    t: Number(p?.t),
  };
}

function isTrailGapJump(a, b, maxGapM = TRAIL_BREAK_GAP_M, breakOpts = {}) {
  if (!a || !b) return false;
  const left = trailPointLatLng(a);
  const right = trailPointLatLng(b);
  if (![left.lat, left.lng, right.lat, right.lng].every(Number.isFinite)) return false;
  const leftDir = normalizeTrailDirection(Array.isArray(a) ? a[4] ?? a.direction : a?.direction);
  const rightDir = normalizeTrailDirection(Array.isArray(b) ? b[4] ?? b.direction : b?.direction);
  const dist = haversineMeters(left.lat, left.lng, right.lat, right.lng);
  // Direction flip = new trip (terminus turnaround may barely move).
  if (leftDir && rightDir && leftDir !== rightDir) return true;
  const limits = trailBreakLimits(breakOpts);
  const gapM = Number.isFinite(maxGapM) ? maxGapM : limits.gapM;
  if (!(dist >= Math.min(gapM, limits.gapM))) return false;
  if (dist >= limits.hardM) return true;
  const dt =
    Number.isFinite(left.t) && Number.isFinite(right.t) ? Math.abs(right.t - left.t) : null;
  // Missing timestamps: only hard-break on long jumps (sparse AVL often has no usable times).
  if (dt == null) return dist >= limits.hardM;
  if (dt >= limits.gapMs && dist >= limits.gapM) return true;
  const mph = (dist / Math.max(dt / 1000, 0.001)) * 2.23694;
  return mph > limits.speedMph;
}

/** Keep timestamps + direction on path points so gap detection still works after mapping. */
function pathFromGpsPoints(gpsPoints) {
  if (!Array.isArray(gpsPoints)) return [];
  return gpsPoints
    .map((p) => {
      const lat = Number(p?.lat);
      const lng = Number(p?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const heading = Number.isFinite(p?.heading) ? p.heading : null;
      const t = Number(p?.t);
      const direction = normalizeTrailDirection(p?.direction);
      return [lat, lng, heading, Number.isFinite(t) ? t : null, direction || null];
    })
    .filter(Boolean);
}

/** Split a latlng path into continuous runs (Leaflet MultiPolyline-friendly). */
function splitLatLngsByGaps(latlngs, maxGapM = TRAIL_BREAK_GAP_M, breakOpts = {}) {
  if (!Array.isArray(latlngs) || latlngs.length < 2) return [];
  const segs = [];
  let cur = [latlngs[0]];
  for (let i = 1; i < latlngs.length; i += 1) {
    const prev = cur[cur.length - 1];
    const next = latlngs[i];
    if (isTrailGapJump(prev, next, maxGapM, breakOpts)) {
      if (cur.length >= 2) segs.push(cur);
      cur = [next];
    } else {
      cur.push(next);
    }
  }
  if (cur.length >= 2) segs.push(cur);
  return segs;
}

function splitGpsPointsByGaps(gps, maxGapM = TRAIL_BREAK_GAP_M, breakOpts = {}) {
  const pts = normalizeGpsTrailPoints(gps);
  if (pts.length < 2) return [];
  const segs = [];
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i += 1) {
    const prev = cur[cur.length - 1];
    const next = pts[i];
    if (isTrailGapJump(prev, next, maxGapM, breakOpts)) {
      if (cur.length >= 2) segs.push(cur);
      cur = [next];
    } else {
      cur.push(next);
    }
  }
  if (cur.length >= 2) segs.push(cur);
  return segs;
}

function asTrailLatLngs(path, breakOpts = {}) {
  if (!Array.isArray(path) || path.length < 1) return [];
  const toLatLng = (p) => {
    if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) return [p[0], p[1]];
    const lat = Number(p?.lat);
    const lng = Number(p?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  };
  const cleanSeg = (seg) => (Array.isArray(seg) ? seg.map(toLatLng).filter(Boolean) : []);
  // Already a MultiPolyline: [[ [lat,lng], ... ], ...]
  if (Array.isArray(path[0]) && Array.isArray(path[0][0])) {
    return path.map(cleanSeg).filter((seg) => seg.length >= 2);
  }
  const limits = trailBreakLimits(breakOpts);
  const segs = splitLatLngsByGaps(path, limits.gapM, breakOpts);
  const cleaned = (segs.length ? segs : path.length >= 2 ? [path] : []).map(cleanSeg).filter((seg) => seg.length >= 2);
  return cleaned;
}

function flattenTrailLatLngs(path) {
  return asTrailLatLngs(path).flat();
}

function pathLengthMeters(path, { includeGaps = true } = {}) {
  if (!Array.isArray(path) || path.length < 2) return 0;
  // MultiPolyline support
  if (Array.isArray(path[0]) && Array.isArray(path[0][0])) {
    return path.reduce((sum, seg) => sum + pathLengthMeters(seg, { includeGaps }), 0);
  }
  let n = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const lat1 = Array.isArray(a) ? a[0] : a.lat;
    const lng1 = Array.isArray(a) ? a[1] : a.lng;
    const lat2 = Array.isArray(b) ? b[0] : b.lat;
    const lng2 = Array.isArray(b) ? b[1] : b.lng;
    if (
      !includeGaps &&
      isTrailGapJump(
        { lat: lat1, lng: lng1 },
        { lat: lat2, lng: lng2 },
      )
    ) {
      continue;
    }
    n += haversineMeters(lat1, lng1, lat2, lng2);
  }
  return n;
}

function normalizeGpsTrailPoints(gps) {
  if (!Array.isArray(gps) || gps.length < 1) return [];
  const out = [];
  for (const p of gps) {
    if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
      const t = Number(p[3] ?? p.t);
      out.push({
        lat: p[0],
        lng: p[1],
        heading: Number.isFinite(p[2]) ? p[2] : null,
        t: Number.isFinite(t) ? t : null,
        speedMph: null,
        direction: normalizeTrailDirection(p[4] ?? p.direction),
      });
      continue;
    }
    const lat = Number(p?.lat);
    const lng = Number(p?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const heading = Number(p?.heading);
    const t = Number(p?.t);
    const speedMph = Number(p?.speedMph);
    out.push({
      lat,
      lng,
      heading: Number.isFinite(heading) ? heading : null,
      t: Number.isFinite(t) ? t : null,
      speedMph: Number.isFinite(speedMph) ? speedMph : null,
      direction: normalizeTrailDirection(p?.direction),
    });
  }
  return out;
}

function formatTrailArrowTime(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-GB", {
    timeZone: UK_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const day = d.toLocaleDateString("en-GB", {
    timeZone: UK_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  // Bustimes-style: clock first, then the calendar day.
  return `${time} · ${day}`;
}

/** Turn an on-road geometry into timestamped replay points without reintroducing raw GPS chords. */
function roadPathToReplayPoints(roadPath, sourceGps, breakOpts = {}) {
  // Keep the road matcher's chronological fragments. Selecting only the
  // longest fragment silently dropped legitimate replay legs (especially at
  // a terminal or a GPS gap) and made a return journey look like the outbound.
  const segments = asTrailLatLngs(roadPath, breakOpts).filter((seg) => seg.length >= 2);
  const source = normalizeGpsTrailPoints(sourceGps);
  const road = segments.flat();
  if (road.length < 2 || source.length < 2) return [];
  const totalLength = segments.reduce((sum, segment) => sum + pathLengthMeters(segment), 0);
  let consumedLength = 0;
  const out = [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const segmentLength = pathLengthMeters(segment);
    for (let i = 0; i < segment.length; i += 1) {
      const within = segment.length <= 1 ? 0 : i / (segment.length - 1);
      const travelled = consumedLength + segmentLength * within;
      const frac = totalLength > 0 ? travelled / totalLength : 0;
      const t = gpsTimeAtPathFraction(source, frac);
      if (!Number.isFinite(t)) continue;
      const prev = segment[Math.max(0, i - 1)];
      const next = segment[Math.min(segment.length - 1, i + 1)];
      const near = source[Math.min(source.length - 1, Math.round(frac * (source.length - 1)))];
      out.push({
        lat: segment[i][0],
        lng: segment[i][1],
        t,
        heading: segmentBearing(prev, next),
        direction: near?.direction || "",
        speedMph: near?.speedMph ?? null,
      });
    }
    consumedLength += segmentLength;
  }
  return out;
}

function trailSampleSpeedMph(a, b) {
  if (!a || !b) return null;
  if (!Number.isFinite(a.t) || !Number.isFinite(b.t)) return null;
  const dt = Math.abs(b.t - a.t);
  if (!(dt >= 400 && dt <= 20 * 60_000)) return null;
  const dist = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  if (!(dist >= 1)) return dt < 2500 ? 0 : null;
  const mph = (dist / (dt / 1000)) * 2.23694;
  if (!(mph >= 0) || mph > 100) return null;
  return mph;
}

/** Nearest GPS sample (and interpolated time) for an arrow on the drawn path. */
function gpsSampleForTrailArrow(gpsPts, lat, lng, frac) {
  const pts = normalizeGpsTrailPoints(gpsPts);
  if (!pts.length) return null;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const d = haversineMeters(lat, lng, pts[i].lat, pts[i].lng);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  const near = pts[bestIdx];
  let t = Number.isFinite(near?.t) ? near.t : null;
  // Along-path fraction fills gaps when the road geometry sits far from raw GPS.
  const fracT = gpsTimeAtPathFraction(pts, frac);
  if (Number.isFinite(fracT) && (!Number.isFinite(t) || bestDist > 90)) t = fracT;
  else if (Number.isFinite(fracT) && Number.isFinite(t) && bestDist > 35) {
    // Blend: prefer spatial when close, fraction when the match pulled us onto the road.
    t = fracT;
  }
  const prev = pts[bestIdx - 1];
  const next = pts[bestIdx + 1];
  const speedMph =
    trailSampleSpeedMph(near, next) ??
    trailSampleSpeedMph(prev, near) ??
    (Number.isFinite(near?.speedMph) ? near.speedMph : null);
  const heading = Number.isFinite(near?.heading)
    ? near.heading
    : next
      ? segmentBearing([near.lat, near.lng], [next.lat, next.lng])
      : prev
        ? segmentBearing([prev.lat, prev.lng], [near.lat, near.lng])
        : null;
  return { t, speedMph, heading, distM: bestDist };
}

function trailArrowPopupHtml(sample) {
  const when = formatTrailArrowTime(sample?.t);
  const bits = [];
  if (Number.isFinite(sample?.speedMph)) {
    bits.push(sample.speedMph < 1.5 ? "Stopped" : `${Math.round(sample.speedMph)} mph`);
  }
  if (Number.isFinite(sample?.heading)) {
    bits.push(`${Math.round(((sample.heading % 360) + 360) % 360)}°`);
  }
  const extra = bits.length ? `<div class="trail-arrow-popup-extra">${esc(bits.join(" · "))}</div>` : "";
  if (when) {
    return `<div class="trail-arrow-popup"><strong>Bus was here</strong><div class="trail-arrow-popup-time">${esc(when)}</div>${extra}</div>`;
  }
  return `<div class="trail-arrow-popup"><strong>Tracked position</strong><div class="trail-arrow-popup-time">Time unknown for this point</div>${extra}</div>`;
}

function trailArrowIcon(bearingDeg, { replay = false } = {}) {
  const rot = Number.isFinite(bearingDeg) ? bearingDeg : 0;
  const z = map.getZoom();
  const size = z < 13 ? 12 : z < 15 ? 15 : 18;
  const half = size / 2;
  const content = replay
    ? `<span class="trail-arrow-chevron" style="--trail-rot:${rot}deg" aria-hidden="true"></span>`
    : `<button type="button" class="trail-arrow-hit" aria-label="Show time at this point"><span class="trail-arrow-chevron" style="--trail-rot:${rot}deg" aria-hidden="true"></span></button>`;
  return L.divIcon({
    className: `trail-arrow-icon${replay ? " replay-arrow-icon" : ""}`,
    html: content,
    iconSize: [size, size],
    iconAnchor: [half, half],
  });
}

function clearTrailArrows(pair, layer) {
  if (!pair?.arrows?.length) {
    if (pair) pair.arrows = [];
    return;
  }
  const target = layer || pair.layer;
  for (const marker of pair.arrows) {
    try {
      target?.removeLayer(marker);
    } catch {
      /* already gone */
    }
    trailArrowMarkers.delete(marker);
  }
  pair.arrows = [];
}

function interpolateTrailTime(a, b, t) {
  if (Number.isFinite(a?.t) && Number.isFinite(b?.t)) {
    return a.t + (b.t - a.t) * Math.max(0, Math.min(1, t));
  }
  if (Number.isFinite(a?.t)) return a.t;
  if (Number.isFinite(b?.t)) return b.t;
  return null;
}

function trailBreakOptsFromFilter(filter = {}, key = "") {
  const op = String(filter?.operator || "").trim().toUpperCase();
  const line = String(filter?.line || "").trim().toUpperCase();
  const id = String(key || "");
  const actualRoute = Boolean(filter?.actualRoute || filter?.diverted);
  const plannedRoute = Boolean(filter?.plannedRoute);
  const staffs =
    Boolean(filter?.staffs) ||
    isStaffsTrailOperator(op) ||
    isAltonLine(line) ||
    id.startsWith("staff-") ||
    id.startsWith("at:");
  if (op) return { operator: op, coach: isCoachTrailOperator(op), staffs, actualRoute, plannedRoute };
  if (filter?.coach) return { coach: true, operator: op || "", staffs, actualRoute, plannedRoute };
  const pts = trailMem.get(id) || [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const pOp = String(pts[i]?.operator || "").trim().toUpperCase();
    if (pOp) return { operator: pOp, coach: isCoachTrailOperator(pOp), staffs: staffs || isStaffsTrailOperator(pOp), actualRoute, plannedRoute };
  }
  // Live Flix / NATX markers: bus.id is the trail key but points may lack operator yet.
  if (id) {
    for (const marker of markers.values()) {
      if (String(marker?.bus?.id) !== id) continue;
      if (isFlixBus(marker.bus) || isNationalExpress(marker.bus)) {
        const noc = trailOperatorForBus(marker.bus);
        return { operator: noc, coach: true, staffs: false, actualRoute, plannedRoute };
      }
    }
  }
  return { staffs, actualRoute, plannedRoute };
}

/**
 * Sparse Bustimes stop lists are timetable geometry, not a road track. For a
 * coach, keep them hidden until the OSRM/road matcher validates the geometry;
 * otherwise the first paint can briefly draw a straight line between stops.
 */
function plannedPathNeedsRoadMatch(path, breakOpts = {}) {
  if (!breakOpts.plannedRoute || !isCoachTrailOperator(breakOpts.operator)) return false;
  const flat = Array.isArray(path?.[0]?.[0]) ? path.flat() : path;
  if (!Array.isArray(flat) || flat.length < 2) return false;
  const gaps = [];
  for (let i = 1; i < flat.length; i += 1) {
    const a = flat[i - 1];
    const b = flat[i];
    if (Array.isArray(a) && Array.isArray(b)) gaps.push(haversineMeters(a[0], a[1], b[0], b[1]));
  }
  const averageGap = gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : 0;
  return flat.length <= 24 || averageGap > 800;
}

/** Distance from a GPS point to the nearest segment of a planned/recorded path. */
function distanceToTrailPath(point, path) {
  const lat = Number(Array.isArray(point) ? point[0] : point?.lat);
  const lng = Number(Array.isArray(point) ? point[1] : point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return Infinity;
  const flat = flattenTrailLatLngs(path);
  if (flat.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 1; i < flat.length; i += 1) {
    const distance = distPointToSegmentMeters([lat, lng], flat[i - 1], flat[i]);
    if (distance < best) best = distance;
  }
  return best;
}

/**
 * Detect a bus that has clearly left the scheduled alignment. This is
 * deliberately conservative for sparse stop-only Bustimes paths: a motorway
 * curve can be hundreds of metres from a straight stop-to-stop chord without
 * being a diversion. Dense track geometry can use the tighter threshold.
 */
function routeDeviationEvidence({ plannedPath, gpsPoints = [], livePing = null } = {}) {
  const path = flattenTrailLatLngs(plannedPath);
  const points = normalizeGpsTrailPoints(gpsPoints).filter(
    (point) => Number.isFinite(point.lat) && Number.isFinite(point.lng),
  );
  if (path.length < 2 || !points.length) {
    return { detected: false, currentDistanceM: Infinity, offRoutePoints: 0, sparse: false };
  }

  const gaps = [];
  for (let i = 1; i < path.length; i += 1) {
    gaps.push(haversineMeters(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]));
  }
  const averageGap = gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : 0;
  const sparse = path.length <= 24 || averageGap > 800;
  // A dense published track can be compared tightly. A sparse stop list needs
  // a much larger margin so an ordinary road curve is not called a diversion.
  const offRouteLimitM = sparse ? 650 : 180;
  const singlePointLimitM = sparse ? 1100 : 420;
  const lastPoint = points[points.length - 1];
  const ping = livePing && Number.isFinite(Number(livePing.lat)) && Number.isFinite(Number(livePing.lng))
    ? {
        lat: Number(livePing.lat),
        lng: Number(livePing.lng),
        t: Number(livePing.t),
      }
    : null;
  const usePing =
    ping &&
    (!lastPoint.t || !ping.t || Math.abs(ping.t - lastPoint.t) <= 10 * 60_000);
  const anchor = usePing ? ping : lastPoint;
  const recent = points
    .filter((point) => !anchor.t || !point.t || point.t >= anchor.t - 20 * 60_000)
    .slice(-6);
  const samples = recent.length ? recent : [lastPoint];
  const distances = samples.map((point) => distanceToTrailPath(point, path));
  const currentDistanceM = distanceToTrailPath(anchor, path);
  const offRoutePoints = distances.filter((distance) => distance >= offRouteLimitM).length;
  const sortedDistances = distances.filter(Number.isFinite).sort((a, b) => a - b);
  const medianDistanceM = sortedDistances.length
    ? sortedDistances[Math.floor(sortedDistances.length / 2)]
    : Infinity;
  const enoughSamples = samples.length >= 2;
  const detected = enoughSamples
    ? currentDistanceM >= offRouteLimitM &&
      offRoutePoints >= Math.min(2, samples.length) &&
      medianDistanceM >= offRouteLimitM
    : currentDistanceM >= singlePointLimitM;
  return { detected, currentDistanceM, offRoutePoints, medianDistanceM, sparse };
}

/**
 * Prefer road-matched geometry. Never draw raw GPS chords while road matching
 * is pending: a sparse GPS sample can cut across fields and look like a false
 * route. The async aligner will paint the on-road version when it is ready.
 */
function preferRoadMatchedTrail(gpsPath, roadPath, breakOpts = {}) {
  const roadFlat = flattenTrailLatLngs(roadPath);
  if (roadFlat.length >= 2) return roadPath;
  if (breakOpts.plannedRoute) {
    return plannedPathNeedsRoadMatch(gpsPath, breakOpts) ? [] : gpsPath;
  }
  // A local nearest-road stitch can choose the opposite carriageway at a
  // motorway junction and draw a convincing-looking loop. Coaches therefore
  // wait for the validated OSRM geometry instead of showing that fallback.
  if (
    breakOpts.coach ||
    isCoachTrailOperator(breakOpts.operator)
  ) return [];
  const local = alignTrailToRoadsLocal(gpsPath, { ...breakOpts, staffs: true });
  if (flattenTrailLatLngs(local).length >= 2) return local;
  return [];
}

function gpsTimeAtPathFraction(gpsPts, frac) {
  const pts = normalizeGpsTrailPoints(gpsPts);
  if (!pts.length) return null;
  if (pts.length === 1) return Number.isFinite(pts[0].t) ? pts[0].t : null;
  const cumulative = [0];
  for (let i = 1; i < pts.length; i += 1) {
    cumulative[i] =
      cumulative[i - 1] +
      Math.max(
        0,
        haversineMeters(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng),
      );
  }
  const total = cumulative[cumulative.length - 1];
  if (!(total > 0)) {
    return Number.isFinite(pts[pts.length - 1].t) ? pts[pts.length - 1].t : pts[0].t;
  }
  const target = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0)) * total;
  let lo = 1;
  let hi = cumulative.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  const right = Math.max(1, Math.min(cumulative.length - 1, lo));
  const left = right - 1;
  const edgeLength = cumulative[right] - cumulative[left];
  const portion = edgeLength > 0 ? (target - cumulative[left]) / edgeLength : 0;
  return interpolateTrailTime(pts[left], pts[right], portion);
}

/** Direction arrows along the drawn (road-aligned) path — never raw GPS chords across fields. */
function buildTrailArrowsAlongRoad(path, layer, opts = {}) {
  const arrows = [];
  if (!layer) return arrows;
  const breakOpts = opts.breakOpts || {};
  const segs = asTrailLatLngs(path, breakOpts);
  if (!segs.length) return arrows;
  const gps = opts.gpsPoints || opts.gpsPath || null;
  const total = segs.reduce((sum, seg) => sum + pathLengthMeters(seg), 0);
  if (!(total > 1)) return arrows;
  const maxArrows = 72;
  const z = map.getZoom();
  // Keep direction markers readable: one arrow every ~80–100m, not one on
  // every GPS/road vertex. Dense chevrons can make a valid route look like a
  // loop or a second bus trail.
  const spacingMul = z < 12 ? 2 : z < 13 ? 1.6 : z < 14 ? 1.25 : z < 15 ? 1 : 0.9;
  const spacing =
    Math.max(50, Math.min(100, total / Math.max(12, Math.ceil(total / 85)))) * spacingMul;
  let placed = 0;
  let covered = 0;
  const placeArrow = (lat, lng, bear, frac) => {
    const sample = gpsSampleForTrailArrow(gps, lat, lng, frac);
    const when = formatTrailArrowTime(sample?.t);
    const marker = L.marker([lat, lng], {
      icon: trailArrowIcon(bear),
      interactive: true,
      keyboard: true,
      zIndexOffset: 250,
      title: when ? `Bus here at ${when}` : "Tracked position",
    });
    marker.bindPopup(trailArrowPopupHtml(sample), {
      className: "trail-arrow-popup-wrap",
      maxWidth: 240,
      closeButton: true,
    });
    marker.on("click", (event) => {
      L.DomEvent.stopPropagation(event);
      marker.openPopup();
    });
    marker.addTo(layer);
    trailArrowMarkers.add(marker);
    arrows.push(marker);
    placed += 1;
  };

  for (const seg of segs) {
    if (seg.length < 2 || placed >= maxArrows) {
      covered += pathLengthMeters(seg);
      continue;
    }
    let travelled = 0;
    let nextAt = Math.min(spacing * 0.4, Math.max(10, pathLengthMeters(seg) * 0.02));
    for (let i = 1; i < seg.length; i += 1) {
      const a = seg[i - 1];
      const b = seg[i];
      const lat1 = a[0];
      const lng1 = a[1];
      const lat2 = b[0];
      const lng2 = b[1];
      const edge = haversineMeters(lat1, lng1, lat2, lng2);
      if (!(edge > 0.5)) continue;
      const bear = segmentBearing([lat1, lng1], [lat2, lng2]);
      while (nextAt <= travelled + edge && placed < maxArrows) {
        const t = edge > 0 ? (nextAt - travelled) / edge : 0;
        const lat = lat1 + (lat2 - lat1) * t;
        const lng = lng1 + (lng2 - lng1) * t;
        const frac = total > 0 ? (covered + nextAt) / total : 0;
        placeArrow(lat, lng, bear, frac);
        nextAt += spacing;
      }
      travelled += edge;
    }
    const last = seg[seg.length - 1];
    const prev = seg[seg.length - 2];
    const endBear = segmentBearing(prev, last);
    const tooClose =
      arrows.length &&
      haversineMeters(
        arrows[arrows.length - 1].getLatLng().lat,
        arrows[arrows.length - 1].getLatLng().lng,
        last[0],
        last[1],
      ) < Math.min(20, spacing * 0.45);
    if (!tooClose && placed < maxArrows + 1) {
      placeArrow(last[0], last[1], endBear, total > 0 ? (covered + travelled) / total : 1);
    }
    covered += travelled;
  }
  return arrows;
}

function trailPairBreakOpts(opts = {}, fallback = {}) {
  return {
    operator: opts.operator || fallback.operator || "",
    coach: !!(opts.coach ?? fallback.coach),
    staffs: !!(opts.staffs ?? fallback.staffs),
    actualRoute: !!(opts.actualRoute ?? fallback.actualRoute),
    plannedRoute: !!(opts.plannedRoute ?? fallback.plannedRoute),
  };
}

function isMultiTrailPath(latlngs) {
  return Array.isArray(latlngs) && Array.isArray(latlngs[0]) && Array.isArray(latlngs[0][0]);
}

/**
 * Leaflet's L.polyline accepts one coordinate list, not a MultiPolyline.
 * Road matching deliberately returns multiple fragments when a sparse GPS
 * bridge is unsafe; render those fragments as a LayerGroup of ordinary
 * polylines instead of letting Leaflet flatten the nested array into a bogus
 * zig-zag/loop.
 */
function makeTrailPathLayer(latlngs, options, target) {
  if (!isMultiTrailPath(latlngs)) return L.polyline(latlngs, options).addTo(target);
  const group = L.layerGroup().addTo(target);
  const render = (next) => {
    group.clearLayers();
    const segments = isMultiTrailPath(next) ? next : next?.length ? [next] : [];
    for (const segment of segments) {
      if (!Array.isArray(segment) || segment.length < 2) continue;
      group.addLayer(L.polyline(segment, options));
    }
  };
  render(latlngs);
  group.__trailMulti = true;
  group.setLatLngs = render;
  group.setStyle = (style) => {
    group.eachLayer((child) => child.setStyle?.(style));
    return group;
  };
  return group;
}

function setTrailPathLayerLatLngs(layer, latlngs) {
  if (layer?.__trailMulti) {
    layer.setLatLngs(latlngs);
    return;
  }
  layer?.setLatLngs?.(latlngs);
}

function makeTrailPair(path, layer, opts = {}) {
  const breakOpts = trailPairBreakOpts(opts);
  const latlngs = asTrailLatLngs(path, breakOpts);
  // White casing + coloured centre keeps the route readable over both light
  // street maps and the dark night tiles, like the reference replay view.
  const casing = makeTrailPathLayer(latlngs, TRAIL_CASING, layer);
  const line = makeTrailPathLayer(
    latlngs,
    { ...TRAIL_STROKE, color: trailLineColor(breakOpts.operator) },
    layer,
  );
  const gps = opts.gpsPoints || opts.gpsPath || null;
  const arrows = opts.deferArrows
    ? []
    : buildTrailArrowsAlongRoad(path, layer, { gpsPoints: gps, breakOpts });
  return { casing, line, arrows, layer, gpsPoints: gps || null, breakOpts, path };
}

function setTrailPairPath(pair, path, opts = {}) {
  if (!pair) return;
  const breakOpts = trailPairBreakOpts(
    {
      ...(pair.breakOpts || {}),
      ...(opts.operator != null || opts.coach != null || opts.staffs != null || opts.actualRoute != null || opts.plannedRoute != null
        ? {
            operator: opts.operator ?? pair.breakOpts?.operator,
            coach: opts.coach ?? pair.breakOpts?.coach,
            staffs: opts.staffs ?? pair.breakOpts?.staffs,
            actualRoute: opts.actualRoute ?? pair.breakOpts?.actualRoute,
            plannedRoute: opts.plannedRoute ?? pair.breakOpts?.plannedRoute,
          }
        : {}),
    },
    pair.breakOpts || {},
  );
  pair.breakOpts = breakOpts;
  pair.path = path;
  const latlngs = asTrailLatLngs(path, breakOpts);
  setTrailPathLayerLatLngs(pair.casing, latlngs);
  setTrailPathLayerLatLngs(pair.line, latlngs);
  if (opts.gpsPoints || opts.gpsPath) {
    pair.gpsPoints = opts.gpsPoints || opts.gpsPath;
  }
  clearTrailArrows(pair, pair.layer);
  if (opts.deferArrows) {
    pair.arrows = [];
    return;
  }
  // Rebuild arrows on the path being shown (road-aligned when prepareRoadTrail finishes).
  pair.arrows = buildTrailArrowsAlongRoad(path, pair.layer, {
    gpsPoints: pair.gpsPoints,
    breakOpts,
  });
}

function removeTrailPair(pair, layer) {
  if (!pair) return;
  clearTrailArrows(pair, layer || pair.layer);
  const target = layer || pair.layer;
  if (pair.casing) target?.removeLayer(pair.casing);
  target?.removeLayer(pair.line);
}

function bestTrackedPath(keys, opts = {}) {
  let best = [];
  const dir = normalizeTrailDirection(opts.direction || "");
  for (const key of keys) {
    if (!key) continue;
    let path = trackedPathLatLngs(key, { ...opts, direction: dir });
    if (opts.line || opts.fromMs || opts.toMs || dir) {
      const continuous = trackedPathLatLngs(key, {
        fromMs: opts.fromMs || 0,
        toMs: opts.toMs || 0,
        line: opts.line || "",
        direction: dir,
      });
      if (continuous.length > path.length) path = continuous;
    }
    if (path.length < 3 && (opts.journeyId || opts.tripId || opts.line || dir)) {
      path = trackedPathLatLngs(key, {
        fromMs: opts.fromMs || 0,
        toMs: opts.toMs || 0,
        line: opts.line || "",
        direction: dir,
      });
    }
    if (path.length < 3 && (opts.fromMs || opts.toMs)) {
      const fromMs = opts.fromMs ? opts.fromMs - 45 * 60 * 1000 : 0;
      const toMs = opts.toMs ? opts.toMs + 60 * 60 * 1000 : 0;
      path = trackedPathLatLngs(key, { fromMs, toMs, line: opts.line || "", direction: dir });
    }
    // Never fall back to the full undirected day when a direction was requested.
    if (path.length < 2 && !dir) {
      path = trackedPathLatLngs(key, {
        ...(opts.line ? { line: opts.line } : {}),
      });
    }
    if (path.length > best.length) best = path;
  }
  return best;
}

/** Same selection as bestTrackedPath, but keep GPS timestamps/headings for arrow popups. */
function bestTrackedGpsPoints(keys, opts = {}) {
  let best = [];
  const dir = normalizeTrailDirection(opts.direction || "");
  for (const key of keys) {
    if (!key) continue;
    let pts = trackedPointsFor(key, { ...opts, direction: dir });
    if (opts.line || opts.fromMs || opts.toMs || dir) {
      const continuous = trackedPointsFor(key, {
        fromMs: opts.fromMs || 0,
        toMs: opts.toMs || 0,
        line: opts.line || "",
        direction: dir,
      });
      if (continuous.length > pts.length) pts = continuous;
    }
    if (pts.length < 3 && (opts.journeyId || opts.tripId || opts.line || dir)) {
      pts = trackedPointsFor(key, {
        fromMs: opts.fromMs || 0,
        toMs: opts.toMs || 0,
        line: opts.line || "",
        direction: dir,
      });
    }
    if (pts.length < 3 && (opts.fromMs || opts.toMs)) {
      const fromMs = opts.fromMs ? opts.fromMs - 45 * 60 * 1000 : 0;
      const toMs = opts.toMs ? opts.toMs + 60 * 60 * 1000 : 0;
      pts = trackedPointsFor(key, { fromMs, toMs, line: opts.line || "", direction: dir });
    }
    if (pts.length < 2 && !dir) {
      pts = trackedPointsFor(key, {
        ...(opts.line ? { line: opts.line } : {}),
      });
    }
    if (pts.length > best.length) best = pts;
  }
  return best;
}

function bustimesLineMatches(a, b) {
  const clean = (value) => String(value || "").toUpperCase().replace(/^UK/, "").replace(/[^A-Z0-9]/g, "");
  return sameServiceLine(clean(a), clean(b));
}

function bustimesServiceMatchesOperator(service, operator) {
  const noc = String(operator || "").trim().toUpperCase();
  const ops = (Array.isArray(service?.operator) ? service.operator : [service?.operator])
    .filter(Boolean)
    .map((value) => String(value).toUpperCase());
  const text = `${ops.join(" ")} ${service?.description || ""}`;
  if (noc === "NATX") return /(?:NATX|NATIONAL\s+EXPRESS|IE-1178)/i.test(text);
  if (noc === "FLIX") return /(?:FLIX|FLIXBUS)/i.test(text);
  return true;
}

const bustimesCoachLookupCache = new Map();

async function resolveBustimesTripForPlayback({
  operator = "",
  line = "",
  datetime = "",
  destination = "",
  vehicleId = "",
} = {}) {
  const noc = String(operator || "").trim().toUpperCase();
  if (!isCoachTrailOperator(noc) || !line) return "";
  const date = String(datetime || "").slice(0, 10) || ukDateKey();
  const cacheKey = `${noc}|${line}|${date}|${compactQuery(destination)}`;
  if (bustimesCoachLookupCache.has(cacheKey)) return bustimesCoachLookupCache.get(cacheKey);
  try {
    const serviceResults = [];
    const queries = [...new Set([String(line).trim(), `UK${String(line).trim()}`, noc === "FLIX" ? "FlixBus" : "National Express"])];
    for (const query of queries) {
      const res = await fetch(`/api/bt-services/?search=${encodeURIComponent(query)}&limit=50`);
      if (!res.ok) continue;
      const data = await res.json();
      for (const service of data?.results || []) {
        if (bustimesLineMatches(service.line_name, line) && bustimesServiceMatchesOperator(service, noc)) {
          serviceResults.push(service);
        }
      }
    }
    if (!serviceResults.length) {
      bustimesCoachLookupCache.set(cacheKey, "");
      return "";
    }
    const destWords = new Set(normalizeTrailDestination(destination).split(/[^a-z0-9]+/).filter((word) => word.length >= 4));
    serviceResults.sort((a, b) => {
      const score = (service) => {
        const text = normalizeTrailDestination(`${service.description || ""} ${service.headsign || ""}`);
        return [...destWords].filter((word) => text.includes(word)).length;
      };
      return score(b) - score(a);
    });
    const targetMs = datetime ? new Date(datetime).getTime() : Date.now();
    for (const service of serviceResults.slice(0, 4)) {
      const res = await fetch(`/api/bt-trips/?service=${encodeURIComponent(service.id)}&date=${encodeURIComponent(date)}&limit=100`);
      if (!res.ok) continue;
      const data = await res.json();
      const trips = Array.isArray(data?.results) ? data.results : [];
      const ranked = trips
        .map((trip) => {
          const tripText = normalizeTrailDestination(`${trip.headsign || ""} ${service.description || ""}`);
          const destinationScore = [...destWords].filter((word) => tripText.includes(word)).length;
          const startMs = tripAimedMs(trip.start, targetMs);
          const timeDistance = Number.isFinite(startMs) ? Math.abs(startMs - targetMs) : Number.POSITIVE_INFINITY;
          return { trip, score: destinationScore * 10_000_000 - timeDistance };
        })
        .sort((a, b) => b.score - a.score);
      const selected = ranked.find((row) => row.trip?.id)?.trip;
      if (selected?.id) {
        bustimesCoachLookupCache.set(cacheKey, String(selected.id));
        return String(selected.id);
      }
    }
  } catch {
    /* GPS remains the fallback when Bustimes cannot resolve this coach. */
  }
  bustimesCoachLookupCache.set(cacheKey, "");
  return "";
}

async function resolveTripIdForPlayback({ tripId = "", journeyId = "", vehicleId = "", line = "", datetime = "" } = {}) {
  if (tripId) return String(tripId);
  const wantJourney = journeyId ? String(journeyId) : "";
  // Bustimes vehiclejourneys need a numeric vehicle id — skip BODS/Flix journey ids.
  if (!vehicleId || !/^\d+$/.test(String(vehicleId))) return "";
  const rows = await fetchVehicleHistory(vehicleId, Math.max(historyDays, 5));
  if (!rows.length) return "";
  const wantLine = String(line || "").trim();
  const targetMs = datetime ? new Date(datetime).getTime() : NaN;
  let best = null;
  for (const row of rows) {
    if (!row?.trip_id) continue;
    if (
      wantJourney &&
      (String(row.id) === wantJourney ||
        String(row.journey_id || "") === wantJourney ||
        String(row.trip_id) === wantJourney)
    ) {
      return String(row.trip_id);
    }
    if (wantLine && row.route_name && !sameServiceLine(row.route_name, wantLine)) continue;
    const rowMs = row.datetime ? new Date(row.datetime).getTime() : NaN;
    const dt =
      Number.isFinite(targetMs) && Number.isFinite(rowMs) ? Math.abs(rowMs - targetMs) : Number.POSITIVE_INFINITY;
    if (!best || dt < best.dt) best = { tripId: String(row.trip_id), dt };
  }
  return best?.tripId || "";
}

/** True when two trail paths are identical — lets refresh skip a needless redraw. */
function trailPathEquals(a, b) {
  const fa = flattenTrailLatLngs(a);
  const fb = flattenTrailLatLngs(b);
  if (!fa.length || fa.length !== fb.length) return false;
  for (let i = 0; i < fa.length; i += 1) {
    if (Math.abs(fa[i][0] - fb[i][0]) > 1e-7 || Math.abs(fa[i][1] - fb[i][1]) > 1e-7) return false;
  }
  return true;
}

/** Find the current live position for a live trail filter. */
function livePingForTrailFilter(filter = {}, fallbackPoints = []) {
  const vehicleId = String(filter.liveVehicleId || filter.vehicleId || "").trim();
  const trailKey = String(filter.liveTrailKey || filter.trailKey || "").trim();
  const reg = compactReg(
    filter.liveReg ||
      filter.reg ||
      (trailKey.startsWith("reg:") ? trailKey.slice(4) : ""),
  );
  const journeyId = String(filter.liveJourneyId || filter.journeyId || "").trim();
  const tripId = String(filter.liveTripId || filter.tripId || "").trim();
  const focus = {
    hideAll: false,
    journeyOnly: true,
    vehicleIds: new Set(vehicleId ? [vehicleId] : []),
    trailKeys: new Set(trailKey ? [trailKey] : []),
    regs: new Set(reg ? [reg] : []),
  };
  const hasIdentity = vehicleId || trailKey || reg;
  const explicitLivePing = filter.livePing;
  if (
    explicitLivePing &&
    Number.isFinite(Number(explicitLivePing.lat)) &&
    Number.isFinite(Number(explicitLivePing.lng))
  ) {
    return { ...explicitLivePing, source: explicitLivePing.source || "playback" };
  }
  const candidates = [];

  for (const marker of markers.values()) {
    const bus = marker?.bus;
    if (!bus) continue;
    if (journeyId && bus.journey_id && String(bus.journey_id) !== journeyId) continue;
    if (tripId && bus.trip_id && String(bus.trip_id) !== tripId) continue;
    let markerKeys = [];
    if (hasIdentity) {
      markerKeys = trailKeysForVehicle({
        vehicleId: historyVehicleId(bus, marker.extra || {}),
        trailKey: marker.extra?.trailKey || String(bus.id || ""),
        journeyId: bus.journey_id,
        tripId: bus.trip_id,
        line: bus.service?.line_name || marker.extra?.line || "",
        datetime: bus.datetime || new Date().toISOString(),
        reg: busRegistration(bus, marker.extra || {}),
      });
      const keyMatch = trailKey && markerKeys.includes(trailKey);
      if (!keyMatch && !busMatchesHistoryFocus(bus, marker.extra || {}, focus)) continue;
    }
    let ll = null;
    try {
      ll = marker.getLatLng?.() || null;
    } catch {
      /* marker may have been removed */
    }
    const lat = Number(ll?.lat ?? bus.coordinates?.[1]);
    const lng = Number(ll?.lng ?? bus.coordinates?.[0]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const parsed = bus.datetime ? new Date(bus.datetime).getTime() : NaN;
    const at = Number.isFinite(parsed) ? parsed : Date.now();
    let score = 0;
    if (tripId && String(bus.trip_id || "") === tripId) score += 100;
    if (journeyId && String(bus.journey_id || "") === journeyId) score += 80;
    if (trailKey && markerKeys.includes(trailKey)) score += 50;
    if (selectedMapMarker === marker) score += 10;
    candidates.push({
      lat,
      lng,
      t: at,
      heading: Number(bus.heading),
      speedMph: Number(bus.speedMph),
      source: "live-marker",
      score,
    });
  }

  for (const marker of staffMarkers.values()) {
    const item = marker?.staff;
    if (!item) continue;
    const key = staffTrailKey(item);
    const staffReg = compactReg(parseFleetReg(item.vehicle?.ref).reg || key.replace(/^staff-/, ""));
    if (hasIdentity && key !== trailKey && staffReg !== reg) continue;
    const snapped = staffWhere(item);
    if (!Number.isFinite(snapped.lat) || !Number.isFinite(snapped.lng)) continue;
    const parsed = item.recordedAtTime ? new Date(item.recordedAtTime).getTime() : NaN;
    candidates.push({
      lat: snapped.lat,
      lng: snapped.lng,
      t: Number.isFinite(parsed) ? parsed : Date.now(),
      heading: Number(snapped.heading),
      speedMph: Number(item.speedMph),
      source: "staff-marker",
      score: selectedMapMarker === marker ? 10 : 0,
    });
  }
  candidates.sort((a, b) => b.score - a.score || b.t - a.t);
  if (candidates.length) return candidates[0];

  const points = normalizeGpsTrailPoints(fallbackPoints);
  const last = points[points.length - 1];
  return last
    ? {
        lat: last.lat,
        lng: last.lng,
        t: last.t,
        heading: last.heading,
        speedMph: last.speedMph,
        source: "trail",
      }
    : null;
}

/** Keep only recorded points at or before the bus's current ping, then join to the bus. */
function clipGpsPointsAtPing(gpsPoints, ping) {
  const points = (Array.isArray(gpsPoints) ? gpsPoints : [])
    .map((point) => {
      const t = observedPointTimestamp(point);
      const lat = Number(Array.isArray(point) ? point[0] : point?.lat);
      const lng = Number(Array.isArray(point) ? point[1] : point?.lng);
      if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { ...(Array.isArray(point) ? {} : point), t, lat, lng };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
  if (!ping || !Number.isFinite(Number(ping.lat)) || !Number.isFinite(Number(ping.lng))) {
    return points;
  }
  const pingT = Number(ping.t);
  if (!Number.isFinite(pingT)) return points;
  let out = [];
  for (const point of points) {
    if (point.t <= pingT) {
      out.push(point);
      continue;
    }
    const previous = out[out.length - 1];
    if (previous && pingT > previous.t) {
      const fraction = (pingT - previous.t) / Math.max(1, point.t - previous.t);
      out.push({
        ...previous,
        lat: previous.lat + (point.lat - previous.lat) * fraction,
        lng: previous.lng + (point.lng - previous.lng) * fraction,
        t: pingT,
      });
    }
    break;
  }
  // If the bus is spatially near an earlier point (GPS can be a little behind the
  // marker), discard any later points so the visible stroke cannot run ahead of it.
  let nearestIndex = -1;
  let nearestDistance = Infinity;
  for (let i = 0; i < out.length; i += 1) {
    const distance = haversineMeters(out[i].lat, out[i].lng, Number(ping.lat), Number(ping.lng));
    if (distance <= nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }
  if (nearestIndex < 0 || nearestDistance > 350) {
    // The live marker is on another journey or the GPS is too sparse to prove
    // it belongs to this tail. Never append that remote coach/bus position:
    // an OSRM road route can otherwise stretch the tail past the vehicle.
    return out;
  }
  out = out.slice(0, nearestIndex + 1);

  const last = out[out.length - 1];
  const shouldJoin =
    !last ||
    haversineMeters(last.lat, last.lng, Number(ping.lat), Number(ping.lng)) > 1;
  if (shouldJoin) {
    out.push({
      ...(last || {}),
      lat: Number(ping.lat),
      lng: Number(ping.lng),
      t: Math.max(pingT, Number(last?.t) || pingT),
      heading: Number.isFinite(Number(ping.heading)) ? Number(ping.heading) : last?.heading,
      speedMph: Number.isFinite(Number(ping.speedMph)) ? Number(ping.speedMph) : last?.speedMph,
      source: ping.source || "live",
    });
  }
  return out;
}

function refreshPinnedTrailLine(key) {
  const id = String(key || "");
  if (!id) return;
  const filter = { ...(pinnedTrailFilters.get(id) || {}) };
  // Live / following tails must keep growing with the bus (don't freeze at pin time).
  if (filter.live || filter.follow) {
    filter.toMs = 0;
    pinnedTrailFilters.set(id, filter);
  }
  const breakOpts = {
    ...trailBreakOptsFromFilter(filter, id),
    staffs:
      isStaffsTrailOperator(filter.operator) ||
      isAltonLine(filter.line) ||
      String(id).startsWith("staff-") ||
      String(id).startsWith("at:"),
  };
  let gpsPoints = trackedPointsFor(id, filter);
  // Alias feeds can contribute points with no journey ID. Once a live
  // selection has a real journey/trip identity, do not let those unrelated
  // points extend a NatEx/Flix tail beyond the selected coach.
  if (filter.live && filter.journeyId) {
    const exact = gpsPoints.filter((point) => String(point.journeyId || "") === String(filter.journeyId));
    if (exact.length >= 2) gpsPoints = exact;
  } else if (filter.live && filter.tripId) {
    const exact = gpsPoints.filter((point) => String(point.tripId || "") === String(filter.tripId));
    if (exact.length >= 2) gpsPoints = exact;
  }
  if (filter.live || filter.follow) {
    const ping = livePingForTrailFilter(filter, gpsPoints);
    gpsPoints = clipGpsPointsAtPing(gpsPoints, ping);
  }
  // Split there-and-back / multi-route GPS into separate strokes (never one continuous line).
  // tripseg: keys are already one trip from pinSeparateTripTails.
  let path;
  if (String(id).startsWith("tripseg:")) {
    path = pathFromGpsPoints(gpsPoints);
  } else {
    const gapMs = breakOpts.coach
      ? COACH_TRAIL_BREAK_GAP_MS
      : breakOpts.staffs
        ? STAFFS_TRAIL_BREAK_GAP_MS
        : 18 * 60_000;
    const segs = segmentTrailIntoTrips(gpsPoints, { gapMs });
    if (segs.length > 1) {
      path = segs
        .map((seg) => pathFromGpsPoints(seg))
        .filter((latlngs) => latlngs.length >= 2);
    } else {
      path = pathFromGpsPoints(gpsPoints);
    }
  }
  const existing = pinnedTrailLines.get(id);
  if (flattenTrailLatLngs(path).length < 2) {
    if (existing) {
      removeTrailPair(existing, liveTrailLayer);
      pinnedTrailLines.delete(id);
    }
    pinnedTrailAlignWanted.delete(id);
    return;
  }
  // Show GPS immediately so rural AT / Staffs runs appear even before OSM matching finishes.
  // Clickable arrows use GPS times now; prepareRoadTrail rebuilds them onto the road path.
  const immediate = preferRoadMatchedTrail(path, [], breakOpts);
  if (!existing) {
    pinnedTrailLines.set(
      id,
      makeTrailPair(immediate, liveTrailLayer, { gpsPoints, ...breakOpts }),
    );
  } else {
    // Historical route tails never change once drawn. Re-drawing on every GPS ping
    // reset the line to raw points, cleared/rebuilt all arrow markers and re-ran OSM
    // road matching — visible flicker plus a request per ping. Keep the drawn tail.
    if (trailPathEquals(existing.path, immediate)) return;
    existing.gpsPoints = gpsPoints;
    existing.breakOpts = trailPairBreakOpts({ ...(existing.breakOpts || {}), ...breakOpts });
    if (flattenTrailLatLngs(immediate).length >= 2) {
      setTrailPairPath(existing, immediate, { gpsPoints, ...breakOpts });
    }
  }
  pinnedTrailAlignWanted.set(id, { path, gpsPoints, breakOpts });
  runPinnedTrailAlign(id);
}

async function runPinnedTrailAlign(id) {
  const key = String(id || "");
  if (!key || pinnedTrailAlignBusy.get(key)) return;
  pinnedTrailAlignBusy.set(key, true);
  try {
    while (pinnedTrailKeys.has(key) && pinnedTrailAlignWanted.has(key)) {
      const job = pinnedTrailAlignWanted.get(key);
      pinnedTrailAlignWanted.delete(key);
      const gen = (pinnedTrailAlignGen.set(key, (pinnedTrailAlignGen.get(key) || 0) + 1), pinnedTrailAlignGen.get(key));
      let aligned = [];
      try {
        aligned = await prepareRoadTrail(job.path, undefined, job.breakOpts);
      } catch {
        aligned = [];
      }
      if (!pinnedTrailKeys.has(key)) return;
      if (pinnedTrailAlignGen.get(key) !== gen) continue;
      const pair = pinnedTrailLines.get(key);
      if (!pair) continue;
      const drawn = preferRoadMatchedTrail(job.path, aligned, job.breakOpts || {});
      if (flattenTrailLatLngs(drawn).length < 2) continue;
      setTrailPairPath(pair, drawn, { gpsPoints: job.gpsPoints, ...job.breakOpts });
    }
  } finally {
    pinnedTrailAlignBusy.set(key, false);
    if (pinnedTrailKeys.has(key) && pinnedTrailAlignWanted.has(key)) runPinnedTrailAlign(key);
  }
}

function refreshLiveTrailLine(key) {
  const filter = {
    ...(pinnedTrailFilters.get(String(key)) || {}),
    live: true,
    liveTrailKey: String(key),
  };
  const breakOpts = trailBreakOptsFromFilter(filter, key);
  let gpsPoints = trackedPointsFor(key, filter);
  const ping = livePingForTrailFilter(filter, gpsPoints);
  gpsPoints = clipGpsPointsAtPing(gpsPoints, ping);
  const playbackDeviation =
    playback &&
    !playback.diverted &&
    Array.isArray(playback.plannedPath) &&
    playback.plannedPath.length >= 2 &&
    isCoachTrailOperator(breakOpts.operator)
      ? routeDeviationEvidence({
          plannedPath: playback.plannedPath,
          gpsPoints,
          livePing: ping,
        })
      : null;
  if (playbackDeviation?.detected && !playbackDeviation.sparse) {
    switchPlaybackToActualRoute();
  }
  const path = pathFromGpsPoints(gpsPoints);
  if (path.length < 2) {
    if (liveTrailLine) {
      removeTrailPair(liveTrailLine, liveTrailLayer);
      liveTrailLine = null;
    }
    liveTrailAlignWanted = null;
    return;
  }
  // Show GPS immediately so the tail keeps following even when OSM match is slow/fails.
  const immediate = preferRoadMatchedTrail(path, [], breakOpts);
  if (!liveTrailLine) {
    liveTrailLine = makeTrailPair(immediate, liveTrailLayer, {
      gpsPoints,
      ...breakOpts,
    });
  } else {
    liveTrailLine.gpsPoints = gpsPoints;
    liveTrailLine.breakOpts = { ...(liveTrailLine.breakOpts || {}), ...breakOpts };
    if (flattenTrailLatLngs(immediate).length >= 2) {
      setTrailPairPath(liveTrailLine, immediate, { gpsPoints, ...breakOpts });
    }
  }
  liveTrailAlignWanted = { key: String(key), path, gpsPoints, breakOpts };
  runLiveTrailAlign();
}

async function runLiveTrailAlign() {
  if (liveTrailAlignBusy) return;
  liveTrailAlignBusy = true;
  try {
    while (liveTrailAlignWanted) {
      const job = liveTrailAlignWanted;
      liveTrailAlignWanted = null;
      if (String(liveTrailKey) !== String(job.key)) continue;
      const gen = ++liveTrailAlignGen;
      let aligned = [];
      try {
        aligned = await prepareRoadTrail(job.path, undefined, job.breakOpts);
      } catch {
        aligned = [];
      }
      if (liveTrailAlignGen !== gen) continue;
      if (String(liveTrailKey) !== String(job.key) || !liveTrailLine) continue;
      const drawn = preferRoadMatchedTrail(job.path, aligned, job.breakOpts || {});
      if (flattenTrailLatLngs(drawn).length < 2) continue;
      setTrailPairPath(liveTrailLine, drawn, { gpsPoints: job.gpsPoints });
    }
  } finally {
    liveTrailAlignBusy = false;
    if (liveTrailAlignWanted) runLiveTrailAlign();
  }
}

function refreshAllPinnedTrails() {
  for (const key of pinnedTrailKeys) refreshPinnedTrailLine(key);
}

function isSingleVehicleRouteOperator(operator) {
  return SINGLE_VEHICLE_ROUTE_NOCS.has(String(operator || "").trim().toUpperCase());
}

function isSingleVehicleRouteLine(line) {
  return ALTON_LINES.has(String(line || "").trim().toUpperCase());
}

function routeTailLinesFor(line) {
  const code = String(line || "").trim();
  if (!code) return [];
  if (isStokeFcLine(code)) return [normalizeStokeFcLine(code) || code.toUpperCase()];
  return [code];
}

function trailTimeWindow(datetime, { coach = false } = {}) {
  if (!datetime) {
    return coach ? { fromMs: Date.now() - COACH_TRAIL_LIVE_MS, toMs: 0 } : { fromMs: 0, toMs: 0 };
  }
  const start = new Date(datetime).getTime();
  if (!Number.isFinite(start)) return { fromMs: 0, toMs: 0 };
  if (coach) {
    // Long coach runs exceed 5h — never cap the upper end; keep the last ~14h of GPS.
    return {
      fromMs: Math.min(start - 30 * 60 * 1000, Date.now() - COACH_TRAIL_LIVE_MS),
      toMs: 0,
    };
  }
  return {
    fromMs: start - 30 * 60 * 1000,
    // One there OR back run — not a full day of both directions.
    toMs: start + 5 * 60 * 60 * 1000,
  };
}

async function fetchPlannedRoutePath({
  targets = [],
  code = "",
  opCode = "",
  plannedTripId = "",
  plannedServiceId = "",
  plannedDate = "",
} = {}) {
  if (
    !usesPlannedRouteOverride(code, opCode) ||
    (!targets.length && !plannedTripId && !plannedServiceId)
  ) {
    return [];
  }
  let serviceTripId = String(plannedTripId || "").trim();
  const routeDate = String(plannedDate || ukDateKey()).slice(0, 10);

  // Anonymous coach AVL has no trip/vehicle id. Resolve a current Bustimes trip
  // from the route + destination so route-wide Map · tails still has a planned
  // path even when the live feed supplied no usable GPS key.
  if (!serviceTripId && !plannedServiceId && isCoachTrailOperator(opCode)) {
    serviceTripId = await resolveBustimesTripForPlayback({
      operator: opCode,
      line: code,
      datetime: plannedDate || "",
      destination: targets[0]?.destination || targets[0]?.dest || "",
    });
  }
  if (!serviceTripId && plannedServiceId) {
    try {
      const res = await fetch(
        `/api/bt-trips/?service=${encodeURIComponent(plannedServiceId)}&date=${encodeURIComponent(routeDate)}&limit=20`,
      );
      const data = res.ok ? await res.json() : null;
      serviceTripId = String(data?.results?.[0]?.id || data?.[0]?.id || "").trim();
    } catch {
      serviceTripId = "";
    }
  }

  // A service id/trip id is enough even when the live vehicle list is empty.
  const candidates = targets.length
    ? targets
    : [{ line: code, datetime: plannedDate || "", destination: "" }];
  for (const v of candidates.slice(0, 4)) {
    const directTrip = String(v.trip_id || v.tripId || serviceTripId || "").trim();
    const numericVehicle = String(v.id || v.btId || v.vehicleId || "").trim();
    let candidateTrip = directTrip;
    if (!candidateTrip && /^\d+$/.test(numericVehicle)) {
      candidateTrip = await Promise.race([
        resolveTripIdForPlayback({
          vehicleId: numericVehicle,
          line: code,
          datetime: v.datetime || v.recordedAtTime || "",
        }),
        new Promise((resolve) => setTimeout(() => resolve(""), 3500)),
      ]);
    }
    if (!candidateTrip) continue;
    const trip = await Promise.race([
      tripEnds(candidateTrip, {
        date: String(plannedDate || v.datetime || v.recordedAtTime || routeDate).slice(0, 10),
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), 4500)),
    ]);
    const candidatePath = Array.isArray(trip?.path) ? thinTrailPoints(trip.path, 55) : [];
    if (candidatePath.length >= 2) {
       rememberPlannedRoute(candidatePath, {
         tripId: candidateTrip,
         line: code,
         operator: opCode,
         date: String(plannedDate || v.datetime || v.recordedAtTime || routeDate).slice(0, 10),
         destination: v.destination || v.dest || "",
       });
       return candidatePath;
     }
  }
  return [];
}

async function showFleetRouteTails({
  line = "",
  operator = "",
  vehicles = [],
  vehicleId = "",
  trailKey = "",
  reg = "",
  journeyId = "",
  tripId = "",
  datetime = "",
  direction = "",
  plannedTripId = "",
  plannedServiceId = "",
  plannedDate = "",
} = {}) {
  const code = String(line || "").trim();
  const opCode = String(operator || "").trim().toUpperCase();
  const hasExplicitSelection = Boolean(vehicleId || trailKey || reg || journeyId || tripId);
  // A selected coach journey stays single-run. A route-wide Map · tails request
  // may use the matching Bustimes service path even when the live feed has many
  // anonymous vehicles (and therefore no single safe target to select).
  const forceSingle = isSingleVehicleRouteLine(code) ||
    (isSingleVehicleRouteOperator(opCode) &&
      (hasExplicitSelection || !isCoachTrailOperator(opCode)));
  if (!code && !vehicleId && !trailKey && !reg) {
    showMessage("No route to show");
    return;
  }
  setAppTab("map");
  stopRoutePlayback("", { clearTail: true });

  const list = Array.isArray(vehicles) ? vehicles.filter(Boolean) : [];
  const single =
    vehicleId || trailKey || reg || journeyId || tripId
      ? [
          {
            id: vehicleId,
            trailKey,
            reg,
            journey_id: journeyId,
            trip_id: tripId,
            datetime,
            line: code,
            direction,
          },
        ]
      : [];

  // FlixBus / National Express / D&G / First Potteries / Stanton's: one vehicle + one route only.
  let targets = list.length ? list : single;
  // Route-wide coach requests can contain hundreds of anonymous live rows. The
  // published service path is the useful fallback; a small GPS sample is enough
  // when it is available and avoids fanning out hundreds of recorder requests.
  if (!hasExplicitSelection && isCoachTrailOperator(opCode) && targets.length > 12) {
    targets = targets.slice(0, 12);
  }
  if (forceSingle && hasExplicitSelection) {
    targets = single.length ? single : targets.slice(0, 1);
  }

  const label = code
    ? targets.length === 1
      ? `Route ${code}${compactReg(targets[0].reg || targets[0].regLabel || reg) ? ` · ${compactReg(targets[0].reg || targets[0].regLabel || reg)}` : ""}`
      : `Route ${code}`
    : targets.length === 1
      ? compactReg(targets[0].reg || targets[0].regLabel || reg) || "Tracked bus"
      : "Tracked route";

  showMessage(`Loading ${label}…`);

  const keys = new Set();
  const filterByKey = new Map();
  for (const v of targets) {
    const vLine = String(v.line || v.route_name || code || "").trim();
    const vJourney = String(v.journey_id || v.journeyId || journeyId || "").trim();
    const vTrip = String(v.trip_id || v.tripId || tripId || "").trim();
    const vWhen = v.datetime || v.recordedAtTime || v.trackedAt || datetime || "";
    let vDir = normalizeTrailDirection(v.direction || direction || "");
    const window = trailTimeWindow(vWhen, { coach: isCoachTrailOperator(opCode) });
    const filter = {
      line: vLine,
      journeyId: vJourney,
      tripId: vTrip,
      direction: vDir,
      fromMs: window.fromMs,
      toMs: window.toMs,
    };
    for (const key of trailKeysForVehicle({
      vehicleId: v.id || v.btId || v.vehicleId || vehicleId || "",
      trailKey: v.trailKey || (v.ref ? `staff-${v.ref}` : "") || trailKey || "",
      reg: v.reg || v.regLabel || reg || "",
      journeyId: vJourney,
      tripId: vTrip,
      line: vLine,
      datetime: vWhen,
      direction: vDir,
    })) {
      keys.add(key);
      filterByKey.set(key, { ...filter });
    }
  }

  // Line-wide server lookup only when not a single-vehicle operator. A coach
  // route with a Bustimes service/trip already has a planned path, so do not
  // wait on a broad recorder lookup before drawing it.
  const hasPlannedService = Boolean(plannedTripId || plannedServiceId);
  if (
    !keys.size &&
    code &&
    !forceSingle &&
    !(isCoachTrailOperator(opCode) && hasPlannedService)
  ) {
    const serverKeys = await fetchTrailKeysForGroup({
      id: `line:${code}`,
      label: `Route ${code}`,
      lines: routeTailLinesFor(code),
    });
    for (const key of serverKeys) {
      keys.add(key);
      filterByKey.set(key, { line: code });
    }
  }

  // Start the Bustimes route lookup before the GPS-key check. A coach route can
  // have no usable recorder key (anonymous AVL / stale feed) but still has a
  // valid published service path.
  const plannedRoutePromise =
    keys.size || isCoachTrailOperator(opCode)
      ? fetchPlannedRoutePath({
          targets,
          code,
          opCode,
          plannedTripId,
          plannedServiceId,
          plannedDate,
        })
      : Promise.resolve([]);
  if (isCoachTrailOperator(opCode) && targets.length === 1) {
    const v = targets[0];
    const expanded = await expandCoachTrailKeys([...keys], {
      operator: opCode,
      line: String(v.line || v.route_name || code || "").trim(),
      reg: v.reg || v.regLabel || reg || "",
      vehicleId: v.id || v.btId || v.vehicleId || vehicleId || "",
      journeyId: String(v.journey_id || v.journeyId || journeyId || "").trim(),
      tripId: String(v.trip_id || v.tripId || tripId || "").trim(),
    });
    for (const key of expanded) keys.add(key);
  }
  const trailsPromise = keys.size
    ? fetchServerTrailsChunked([...keys], { force: true }).catch(() => {})
    : Promise.resolve();
  const plannedRoutePath = await plannedRoutePromise;
  const plannedPathUsable =
    plannedRoutePath.length >= 2 && !pathCrossesActiveRoadNotice(plannedRoutePath);
  // A route-wide coach tail is useful immediately from the published path; do
  // not make the user wait for a large/slow recorder response. If the planned
  // path is blocked by an active closure, wait for the recorded GPS fallback.
  // Explicit bus selections still wait for their recorded run so GPS can remain authoritative.
  if (keys.size && !(isCoachTrailOperator(opCode) && !hasExplicitSelection && plannedPathUsable)) {
    await trailsPromise;
  } else if (keys.size) {
    await Promise.race([
      trailsPromise,
      new Promise((resolve) => setTimeout(resolve, 1200)),
    ]);
  }
  if (!keys.size && (!isCoachTrailOperator(opCode) || plannedRoutePath.length < 2)) {
    showMessage(
      forceSingle
        ? `No GPS tail for this bus yet — leave it open on the map or wait for the server recorder`
        : `No GPS tails for ${label} yet`,
    );
    return;
  }

  clearPinnedTrails();
  const focusRegs = new Set(
    targets.map((v) => compactReg(v.reg || v.regLabel || reg || "")).filter(Boolean),
  );
  const focusVehicleIds = new Set(
    targets
      .flatMap((v) => [v.id, v.btId, v.vehicleId, vehicleId])
      .map((v) => String(v || "").trim())
      .filter((v) => v && /^\d+$/.test(v)),
  );
  const focusTrailKeys = new Set(
    targets
      .flatMap((v) => [v.trailKey, v.ref ? `staff-${v.ref}` : "", trailKey])
      .map((v) => String(v || "").trim())
      .filter(Boolean),
  );
  multiTailActiveGroup = {
    id: `route:${code || "one"}`,
    label,
    focus:
      targets.length === 1
        ? { hideAll: false, vehicleIds: focusVehicleIds, trailKeys: focusTrailKeys, regs: focusRegs }
        : { hideAll: true, vehicleIds: new Set(), trailKeys: new Set(), regs: new Set() },
  };
  const drawn = [];
  const seenSeg = new Set();

  // One tail polyline per trip — never glue Hanley→Newcastle with Newcastle→Hanley.
  for (const v of targets) {
    const vLine = String(v.line || v.route_name || code || "").trim();
    const vJourney = String(v.journey_id || v.journeyId || journeyId || "").trim();
    const vTrip = String(v.trip_id || v.tripId || tripId || "").trim();
    const vWhen = v.datetime || v.recordedAtTime || v.trackedAt || datetime || "";
    const window = trailTimeWindow(vWhen, { coach: isCoachTrailOperator(opCode) });
    const vKeys = trailKeysForVehicle({
      vehicleId: v.id || v.btId || v.vehicleId || vehicleId || "",
      trailKey: v.trailKey || (v.ref ? `staff-${v.ref}` : "") || trailKey || "",
      reg: v.reg || v.regLabel || reg || "",
      journeyId: String(v.journey_id || v.journeyId || journeyId || "").trim(),
      tripId: String(v.trip_id || v.tripId || tripId || "").trim(),
      line: vLine,
      datetime: vWhen,
      direction: "",
    });
    let gps = collectTrailGpsForKeys(vKeys.length ? vKeys : [...keys], {
      line: vLine || code,
      fromMs: window.fromMs,
      toMs: window.toMs,
    });
    // A single-vehicle Map·tails action may carry the selected journey ID.
    // Do not fall back to every recent run for that vehicle: that creates
    // several extra tails on the map. Route-wide tails without an ID still
    // intentionally show all recorded trips.
    // A route-wide view may contain several buses, but each supplied live
    // target still represents one current stint. Do not append that bus's older
    // journeys to the target and create a false there-and-back shape.
    const selectedRun = Boolean(vWhen);
    if (vJourney) {
      gps = gps.filter((point) => String(point.journeyId || "") === vJourney);
    } else if (vTrip) {
      gps = gps.filter((point) => String(point.tripId || "") === vTrip);
    } else if (selectedRun) {
      // Flix/NATX and AT employee IDs can flap or be absent. Select the one
      // recorded stint nearest the selected row's time, never every nearby run.
      const selected = clipPointsToSingleDirectionRun(gps, {
        direction: normalizeTrailDirection(v.direction || direction || ""),
        aroundMs: new Date(vWhen).getTime(),
      });
      gps = selected.length >= 2 ? selected : [];
    }
    const staffsGap =
      isStaffsTrailOperator(opCode) ||
      isAltonLine(vLine || code) ||
      String(v.trailKey || trailKey || "").startsWith("staff-");
    const segments = selectedRun && gps.length >= 2
      ? [gps]
      : segmentTrailIntoTrips(gps, {
          gapMs: staffsGap ? STAFFS_TRAIL_BREAK_GAP_MS : 18 * 60_000,
        });
    const base =
      v.id ||
      v.btId ||
      v.trailKey ||
      v.reg ||
      vehicleId ||
      trailKey ||
      reg ||
      code ||
      "bus";
    const pinned = pinSeparateTripTails(segments, {
      baseKey: base,
      line: vLine || code,
      operator: opCode,
    });
    for (const key of pinned) {
      if (seenSeg.has(key)) continue;
      seenSeg.add(key);
      drawn.push(key);
    }
  }

  if (plannedPathUsable) {
    clearPinnedTrails();
    const plannedStart = Date.now() - Math.max(60_000, plannedRoutePath.length * 1000);
    const plannedGps = plannedRoutePath.map((point, index) => ({
      t: plannedStart + index * 1000,
      lat: Number(point[0]),
      lng: Number(point[1]),
      line: code,
      operator: opCode,
      direction: normalizeTrailDirection(direction),
      journeyId: `planned-${code}`,
      tripId: "",
      destination: "",
    }));
    const plannedKeys = pinSeparateTripTails([plannedGps], {
      baseKey: `planned-${code}`,
      line: code,
      operator: opCode,
      plannedRoute: true,
    });
    drawn.length = 0;
    drawn.push(...plannedKeys);
  }

  // Line-wide fallback: segment whatever keys we found for the route.
  const requestedSingleJourney = Boolean(
    String(targets[0]?.journey_id || targets[0]?.journeyId || journeyId || "").trim() ||
      String(targets[0]?.trip_id || targets[0]?.tripId || tripId || "").trim() ||
      (targets.length === 1 &&
        String(targets[0]?.datetime || targets[0]?.recordedAtTime || targets[0]?.trackedAt || datetime || "").trim()),
  );
  if (!drawn.length && keys.size && !requestedSingleJourney) {
    const gps = collectTrailGpsForKeys([...keys], { line: code });
    const pinned = pinSeparateTripTails(segmentTrailIntoTrips(gps), {
      baseKey: code || "route",
      line: code,
      operator: opCode,
    });
    drawn.push(...pinned);
  }
  updatePlaybackChrome();
  if (code) applyHistoryLineFilterToMarkers({ line: code, vehicleId, trailKey, reg });

  const boundsPath = [];
  for (const key of pinnedTrailKeys) {
    const filter = pinnedTrailFilters.get(String(key)) || {};
    const pts = trackedPathLatLngs(key, filter);
    if (pts.length >= 2) boundsPath.push(...pts);
  }
  if (boundsPath.length >= 2) {
    map.fitBounds(L.latLngBounds(boundsPath).pad(0.12), { maxZoom: 15, animate: true });
  }

  if (!drawn.length) {
    showMessage(`No GPS tails for ${label} yet — open the live bus or wait for the server recorder`);
  } else {
    const prevFocus = multiTailActiveGroup?.focus;
    multiTailActiveGroup = {
      id: `route:${code || "one"}`,
      label: `${label}${drawn.length > 1 ? ` · ${drawn.length} trips` : ""}`,
      focus: prevFocus,
    };
    applyHistoryMapFocusToLiveMarkers();
    messageEl.hidden = true;
    updatePlaybackChrome();
  }
}

function lineMatchesMultiGroup(line, group) {
  if (!group?.lines?.length) return false;
  const code = String(line || "").trim();
  if (!code) return false;
  return group.lines.some((l) => sameServiceLine(l, code));
}

function operatorMatchesMultiGroup(operator, group) {
  if (!group?.operators?.length) return false;
  const code = String(operator || "").trim().toUpperCase();
  if (!code) return false;
  return group.operators.some((o) => o === code);
}

function collectLiveTrailKeysForGroup(group) {
  if (!group) return [];
  const keys = new Set();
  for (const marker of [...markers.values(), ...staffMarkers.values()]) {
    let match = false;
    if (group.operators?.length) {
      if (group.id === "flix" && marker.bus && isFlixBus(marker.bus)) match = true;
      else if (group.id === "natx" && marker.bus && isNationalExpress(marker.bus)) match = true;
      else {
        const op = String(
          marker.extra?.trailOperator ||
            marker.bus?.operator?.noc ||
            marker.bus?.operator?.id ||
            "",
        )
          .trim()
          .toUpperCase();
        match = operatorMatchesMultiGroup(op, group);
      }
    } else {
      const line = marker.staff
        ? staffLineName(marker.staff)
        : String(
            marker.bus?.service?.line_name ||
              marker.extra?.line ||
              marker.extra?.historyLineFilter ||
              "",
          ).trim();
      match = lineMatchesMultiGroup(line, group);
    }
    if (!match) continue;
    const vehicleId =
      historyVehicleId(marker.bus, marker.extra) ||
      (marker.bus?.id != null && !String(marker.bus.id).startsWith("dg-")
        ? String(marker.bus.id)
        : "");
    const trailKey =
      marker.extra?.trailKey || (marker.staff ? staffTrailKey(marker.staff) : "") || "";
    const reg =
      marker.extra?.btVehicle?.reg ||
      marker.bus?.vehicle?.reg ||
      marker.extra?.vehicle?.reg ||
      "";
    for (const key of trailKeysForVehicle({ vehicleId, trailKey, reg })) keys.add(key);
  }
  return [...keys];
}

/** Short-lived cache for /api/trails/keys lookups — same op+line is reused across map clicks. */
const trailKeysForGroupCache = new Map();
const TRAIL_KEYS_GROUP_TTL_MS = 90_000;

async function fetchTrailKeysForGroup(group, { days = TRAIL_KEEP_DAYS } = {}) {
  if (!group) return [];
  const cacheKey = `${String(group.operators || []).join(",")}|${String(group.lines || []).join(",")}|${days}`;
  const cachedAt = trailKeysForGroupCache.get(cacheKey + ":at") || 0;
  const cached = trailKeysForGroupCache.get(cacheKey);
  if (cached && Date.now() - cachedAt < TRAIL_KEYS_GROUP_TTL_MS) return cached;
  try {
    const params = new URLSearchParams({
      days: String(days),
      limit: "40",
    });
    if (group.operators?.length) params.set("operators", group.operators.join(","));
    if (group.lines?.length) params.set("lines", group.lines.join(","));
    const res = await fetch(`/api/trails/keys?${params}`);
    if (!res.ok) return cached || [];
    const data = await res.json();
    const keys = Array.isArray(data?.keys)
      ? data.keys.map((row) => String(row?.key || "").trim()).filter(Boolean)
      : [];
    trailKeysForGroupCache.set(cacheKey, keys);
    trailKeysForGroupCache.set(cacheKey + ":at", Date.now());
    return keys;
  } catch {
    return cached || [];
  }
}

/** Merge server-side coach GPS keys (reg / bustimes id / journey) for BODS NATX & Flix. */
async function expandCoachTrailKeys(keys, { operator = "", line = "", reg = "", vehicleId = "", journeyId = "", tripId = "" } = {}) {
  const out = new Set((keys || []).map((k) => String(k || "").trim()).filter(Boolean));
  if (!isCoachTrailOperator(operator)) return [...out];

  const plate = compactReg(reg);
  const jid = trailFilterJourneyId(journeyId, line);
  const tid = String(tripId || "").trim();
  const vid = String(vehicleId || "").trim();
  if (plate) out.add(regTrailKey(plate));
  if (vid && /^\d+$/.test(vid)) out.add(vid);
  if (jid) out.add(`jny:${jid}`);
  if (tid) out.add(`trip:${tid}`);

  try {
    const op = String(operator || "").trim().toUpperCase();
    const group = { operators: [op] };
    const lineCode = String(line || "").trim();
    if (lineCode) group.lines = [lineCode];
    const serverKeys = await fetchTrailKeysForGroup(group, { days: TRAIL_KEEP_DAYS });
    for (const key of serverKeys) {
      if (!key) continue;
      if (vid && key === vid) out.add(key);
      if (plate && (key === regTrailKey(plate) || key.includes(plate))) out.add(key);
      if (jid && (key === `jny:${jid}` || key.includes(jid))) out.add(key);
      if (tid && (key === `trip:${tid}` || key.includes(tid))) out.add(key);
      if (plate && key.startsWith(`run:reg:${plate}:`)) out.add(key);
      if (vid && key.startsWith(`run:${vid}:`)) out.add(key);
    }
  } catch {
    /* optional */
  }

  return [...out];
}

async function fetchServerTrailsChunked(keys, opts = {}) {
  const list = preferTrailFetchKeys(keys, { limit: 0 });
  for (let i = 0; i < list.length; i += 12) {
    await fetchServerTrails(list.slice(i, i + 12), opts);
  }
}

function pinTrailKey(key) {
  const id = String(key || "").trim();
  if (!id) return;
  pinnedTrailKeys.add(id);
  rememberTrailVehicle(id);
  refreshPinnedTrailLine(id);
}

function pinVehicleTrail({
  vehicleId = "",
  trailKey = "",
  reg = "",
  journeyId = "",
  tripId = "",
  line = "",
  operator = "",
  direction = "",
  datetime = "",
  liveFromMs = 0,
  liveToMs = 0,
  live = false,
  liveFocus = true,
  livePing = null,
  diverted = false,
} = {}) {
  const safeDirection = normalizeTrailDirection(direction);
  const keys = trailKeysForVehicle({
    vehicleId,
    trailKey,
    reg,
    journeyId,
    tripId,
    line,
    datetime,
    direction: safeDirection,
  });
  if (!keys.length) return;
  const renderKey = String(trailKey || vehicleId || regTrailKey(reg) || keys[0] || "").trim();
  if (!renderKey) return;
  // Alias keys (reg, Bustimes id, journey and run keys) describe the same
  // physical coach. Merge their already-fetched points into one canonical
  // in-memory key and draw one live tail, not one overlapping tail per alias.
  let mergedPoints = trailMem.get(renderKey) || [];
  for (const key of keys) {
    const id = String(key || "");
    if (!id || id === renderKey) continue;
    const points = trailMem.get(id);
    if (points?.length) mergedPoints = mergeTrailPoints(mergedPoints, points);
  }
  if (mergedPoints.length) trailMem.set(renderKey, mergedPoints);
  const window = trailTimeWindow(datetime);
  const followLive = live || !datetime;
  const coachLive = isCoachTrailOperator(operator);
  const filter = {
    line: String(line || "").trim(),
    journeyId: trailFilterJourneyId(journeyId, line),
    tripId: String(tripId || "").trim(),
    direction: safeDirection,
    operator: String(operator || "").trim().toUpperCase(),
    fromMs: followLive
      ? Number(liveFromMs) > 0
        ? Number(liveFromMs)
        : Date.now() - (coachLive ? COACH_TRAIL_LIVE_MS : 4 * 60 * 60 * 1000)
      : window.fromMs,
    toMs: followLive ? Number(liveToMs) || 0 : window.toMs,
    live: followLive,
    follow: followLive,
    liveVehicleId: followLive ? String(vehicleId || "") : "",
    liveTrailKey: followLive ? String(trailKey || "") : "",
    liveReg: followLive ? compactReg(reg) : "",
    liveJourneyId: followLive ? String(journeyId || "") : "",
    liveTripId: followLive ? String(tripId || "") : "",
    livePing: followLive ? livePing : null,
    diverted: Boolean(diverted),
    actualRoute: Boolean(diverted),
  };
  multiTailActiveGroup = null;
  if (
    filter.line ||
    filter.journeyId ||
    filter.tripId ||
    filter.direction ||
    filter.operator ||
    filter.fromMs ||
    filter.live ||
    filter.diverted ||
    filter.actualRoute
  ) {
    pinnedTrailFilters.set(renderKey, filter);
  } else {
    pinnedTrailFilters.delete(renderKey);
  }
  pinnedTrailKeys.add(renderKey);
  rememberTrailVehicle(renderKey);
  refreshPinnedTrailLine(renderKey);
  // History · Map pins its own stroke — skip a second liveTrailLine overlay.
  if (followLive && renderKey && liveFocus) setLiveTrailFocus(renderKey);
  updatePlaybackChrome();
}

function clearTrailArtifacts(layer) {
  if (!layer?.eachLayer) return;
  layer.eachLayer((child) => {
    const className = String(child?.options?.className || "");
    const title = String(child?.options?.title || "");
    const element = child?.getElement?.();
    const elementClass = String(element?.className || "");
    const iconClass = String(child?.options?.icon?.options?.className || "");
    const isTrailLine = className.includes("trail-line") || elementClass.includes("trail-line");
    const isTrailArrow =
      title.startsWith("Bus here at") ||
      title === "Tracked position" ||
      elementClass.includes("trail-arrow-icon") ||
      iconClass.includes("trail-arrow-icon") ||
      Boolean(element?.querySelector?.(".trail-arrow-chevron"));
    if (isTrailLine || isTrailArrow) layer.removeLayer(child);
  });
  // Clean pairs that lost their map reference during a rapid row switch.
  for (const marker of [...trailArrowMarkers]) {
    try {
      marker.remove?.();
    } catch {
      /* already removed */
    }
    trailArrowMarkers.delete(marker);
  }
}

function clearPinnedTrails() {
  for (const pair of pinnedTrailLines.values()) removeTrailPair(pair, liveTrailLayer);
  // The layer can contain orphaned pairs from an interrupted async render that
  // are no longer present in pinnedTrailLines. Clear the whole tail layer so a
  // NatEx/Flix selection cannot inherit a previous coach's arrows.
  liveTrailLayer.clearLayers();
  liveTrailLine = null;
  clearTrailArtifacts(liveTrailLayer);
  pinnedTrailLines.clear();
  pinnedTrailKeys.clear();
  pinnedTrailFilters.clear();
  multiTailActiveGroup = null;
  updatePlaybackChrome();
}

function setLiveTrailFocus(key) {
  const nextKey = key ? String(key) : "";
  if (liveTrailKey && liveTrailKey !== nextKey && liveTrailLine) {
    removeTrailPair(liveTrailLine, liveTrailLayer);
    liveTrailLine = null;
    clearTrailArtifacts(liveTrailLayer);
  }
  liveTrailKey = nextKey;
  if (!liveTrailKey) {
    if (liveTrailLine) {
      removeTrailPair(liveTrailLine, liveTrailLayer);
      liveTrailLine = null;
    }
    clearTrailArtifacts(liveTrailLayer);
    return;
  }
  rememberTrailVehicle(liveTrailKey);
  hydrateLiveTrailFromServer(liveTrailKey).catch(() => {
    refreshLiveTrailLine(liveTrailKey);
  });
}

/** Pull saved GPS tails before drawing live / history Map arrows. */
async function hydrateLiveTrailFromServer(key) {
  const id = String(key || "").trim();
  if (!id) return;
  const marker =
    [...markers.values()].find((m) => String(m?.bus?.id) === id) ||
    [...markers.values()].find((m) => String(m?.extra?.trailKey || "") === id) ||
    [...staffMarkers.values()].find(
      (m) => String(m?.extra?.trailKey || staffTrailKey(m.staff) || "") === id,
    ) ||
    null;
  const bus = marker?.bus || null;
  const extra = marker?.extra || {};
  const reg =
    busRegistration(bus || {}, extra) ||
    extra.btVehicle?.reg ||
    extra.vehicle?.reg ||
    "";
  const journeyId = String(
    bus?.journey_id || (!bus?.vehicle?.id && !String(id).startsWith("bods-") ? bus?.id : "") || "",
  ).trim();
  const keys = trailKeysForVehicle({
    trailKey: id,
    vehicleId: historyVehicleId(bus, extra) || ( /^\d+$/.test(id) ? id : ""),
    journeyId: journeyId && !/^(live-|at-)/i.test(journeyId) ? journeyId : "",
    tripId: bus?.trip_id || "",
    line: bus?.service?.line_name || extra.line || extra.historyLineFilter || "",
    datetime: bus?.datetime || new Date().toISOString(),
    reg,
  });
  if (journeyId && !/^(live-|at-)/i.test(journeyId)) {
    if (!keys.includes(journeyId)) keys.push(journeyId);
    if (!keys.includes(`jny:${journeyId}`)) keys.push(`jny:${journeyId}`);
  }
  if (/^\d{6,}$/.test(id) && !keys.includes(`jny:${id}`)) keys.push(`jny:${id}`);
  const plateKey = regTrailKey(reg);
  if (plateKey && !keys.includes(plateKey)) keys.push(plateKey);
  // BODS live id + bustimes numeric id both hold Staffs GPS — merge them.
  const btId = historyVehicleId(bus, extra);
  if (btId && !keys.includes(String(btId))) keys.push(String(btId));
  if (bus?.id && !keys.includes(String(bus.id))) keys.push(String(bus.id));

  const coachOp = isCoachTrailOperator(extra.operatorNoc || trailOperatorForBus(bus) || "");
  if (coachOp) {
    const expanded = await expandCoachTrailKeys(keys, {
      operator: extra.operatorNoc || trailOperatorForBus(bus) || "",
      line: bus?.service?.line_name || extra.line || "",
      reg,
      vehicleId: btId || "",
      journeyId: journeyId && !/^(live-|at-)/i.test(journeyId) ? journeyId : "",
      tripId: bus?.trip_id || "",
    });
    for (const key of expanded) {
      if (!keys.includes(key)) keys.push(key);
    }
  }

  await fetchServerTrailsChunked(keys, { force: true });

  let merged = trailMem.get(id) || [];
  for (const k of keys) {
    if (!k || k === id) continue;
    const pts = trailMem.get(String(k)) || [];
    if (pts.length) merged = mergeTrailPoints(merged, pts);
  }
  if (merged.length) trailMem.set(id, merged);
  if (String(liveTrailKey) === id) refreshLiveTrailLine(id);
}

/** GPS points for the live marker's current trip, not the vehicle's whole day. */
function observedGpsForMarker(marker, { fromMs = 0, toMs = 0 } = {}) {
  const bus = marker?.bus;
  if (!bus) return [];
  const extra = marker.extra || {};
  const line = String(bus.service?.line_name || extra.line || extra.historyLineFilter || "").trim();
  const journeyId = String(bus.journey_id || "").trim();
  const vehicleId = historyVehicleId(bus, extra);
  const reg =
    compactReg(
      extra.btVehicle?.reg ||
        extra.vehicle?.reg ||
        bus.vehicle?.reg ||
        busRegistration(bus, extra) ||
        "",
    ) || "";
  const keys = trailKeysForVehicle({
    vehicleId,
    trailKey: extra.trailKey || String(bus.id || ""),
    reg,
    journeyId,
    tripId: bus.trip_id || extra.tripId || "",
    line,
    datetime: bus.datetime || new Date().toISOString(),
  });
  const start = Number(extra.tripStartMs);
  const end = Number(extra.tripEndMs);
  const from = fromMs || (Number.isFinite(start) && start > 0 ? start - 60 * 60_000 : 0);
  const to = toMs || (Number.isFinite(end) && end > 0 ? end + 60 * 60_000 : 0);
  return collectTrailGpsForKeys(keys, { fromMs: from, toMs: to });
}

/** Refresh the ACTUAL column as new recorder pings arrive. */
function refreshObservedStopTimes(marker, { force = false } = {}) {
  if (!marker?.bus || !Array.isArray(marker.extra?.stops) || !marker.extra.stops.length) return false;
  const extra = marker.extra;
  const bus = marker.bus;
  const tripId = String(bus.trip_id || extra.tripId || "").trim();
  const points = observedGpsForMarker(marker);
  const lastT = points.length ? points[points.length - 1].t : 0;
  const signature = `${tripId}|${points.length}|${lastT}|${extra.stops.length}`;
  if (!force && extra._observedStopSig === signature) return false;
  const line = String(bus.service?.line_name || extra.line || extra.historyLineFilter || "").trim();
  const start = Number(extra.tripStartMs);
  const end = Number(extra.tripEndMs);
  extra.stops = attachObservedStopTimes(extra.stops, points, {
    tripId,
    journeyId: bus.journey_id || "",
    line,
    fromMs: Number.isFinite(start) && start > 0 ? start - 60 * 60_000 : 0,
    toMs: Number.isFinite(end) && end > 0 ? end + 60 * 60_000 : 0,
    nowMs: Date.now(),
  });
  extra._observedStopSig = signature;
  return true;
}

loadTrailStore();
loadPlannedRouteStore();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    saveMapView();
    stopLiveSchedule();
    syncHomeLiveCountPolling();
    flushTrailStore();
    flushTrailUpload().catch(() => {});
  } else {
    syncLiveSchedule();
    syncHomeLiveCountPolling();
  }
});
window.addEventListener("pagehide", () => {
  saveMapView();
  flushTrailStore();
  flushTrailUpload().catch(() => {});
});

function clearPlaybackLayers() {
  playbackLayer.clearLayers();
}

function updatePlaybackChrome() {
  if (!playbackBarEl) return;
  if (playback) {
    playbackBarEl.hidden = false;
    playbackLabelEl.textContent = playback.label;
    return;
  }
  if (pinnedTrailKeys.size) {
    playbackBarEl.hidden = false;
    if (multiTailActiveGroup) {
      playbackLabelEl.textContent = `Tails · ${multiTailActiveGroup.label}`;
      return;
    }
    const regs = [...pinnedTrailKeys]
      .filter((key) => String(key).startsWith("reg:"))
      .map((key) => String(key).slice(4));
    playbackLabelEl.textContent = regs.length ? `Tail · ${regs.join(", ")}` : "Tracked tail";
    return;
  }
  playbackBarEl.hidden = true;
  playbackLabelEl.textContent = "";
}

function stopRoutePlayback(message = "", { clearTail = false, invalidatePending = true } = {}) {
  if (invalidatePending) playbackRequestSeq += 1;
  clearPlaybackLayers();
  gpsReplayTeardown();
  playback = null;
  hideJourneyPanel();
  if (clearTail) {
    clearPinnedTrails();
    setLiveTrailFocus("");
  }
  updatePlaybackChrome();
  if (message) showMessage(message);
  const open = openJourneyMarker();
  if (open) refreshPopup(open, { force: true });
  // Restore normal live map after leaving history Map mode.
  loadBuses({ replace: true }).catch(() => {});
}

/** While History · Map is open, prefer that bus — but never freeze the whole live map forever. */
function historyMapFocus() {
  if (playback) {
    const vehicleIds = new Set();
    const trailKeys = new Set();
    const regs = new Set();
    const vid = String(playback.vehicleId || "").trim();
    const trail = String(playback.trailKey || "").trim();
    const reg = compactReg(playback.reg || "");
    const playKey = String(playback.playKey || "").trim();
    if (vid) {
      vehicleIds.add(vid);
      trailKeys.add(vid);
    }
    if (trail) trailKeys.add(trail);
    if (playKey) trailKeys.add(playKey);
    if (reg) {
      regs.add(reg);
      trailKeys.add(`reg:${reg}`);
    }
    return { hideAll: false, journeyOnly: true, vehicleIds, trailKeys, regs };
  }
  if (multiTailActiveGroup && pinnedTrailKeys.size) {
    const focus = multiTailActiveGroup.focus;
    // Single-bus / focused tails: keep that vehicle visible as journeyOnly.
    if (focus && !focus.hideAll && (focus.vehicleIds?.size || focus.trailKeys?.size || focus.regs?.size)) {
      return {
        hideAll: false,
        journeyOnly: true,
        vehicleIds: focus.vehicleIds || new Set(),
        trailKeys: focus.trailKeys || new Set(),
        regs: focus.regs || new Set(),
      };
    }
    // Route-wide Map · tails: hide other live pins while tails are open —
    // but loadBuses still runs so exiting tails instantly restores Staffs buses.
    return { hideAll: true, vehicleIds: new Set(), trailKeys: new Set(), regs: new Set() };
  }
  return null;
}

function busMatchesHistoryFocus(bus, extra = {}, focus) {
  if (!focus) return true;
  if (focus.hideAll) return false;
  const id = String(bus?.id || "").trim();
  const btId = String(historyVehicleId(bus, extra) || bus?.btId || "").trim();
  const trail = String(extra?.trailKey || id || "").trim();
  const reg = compactReg(
    busRegistration(bus || {}, extra) || bus?.vehicle?.reg || bus?.vehicle?.name || extra?.reg || "",
  );
  if (id && focus.trailKeys.has(id)) return true;
  if (trail && focus.trailKeys.has(trail)) return true;
  if (btId && (focus.vehicleIds.has(btId) || focus.trailKeys.has(btId))) return true;
  if (id && focus.vehicleIds.has(id)) return true;
  if (reg && focus.regs.has(reg)) return true;
  return false;
}

function markerMatchesHistoryFocus(marker, focus) {
  if (!focus) return true;
  if (focus.hideAll) return false;
  if (marker?.staff) {
    const key = String(marker.extra?.trailKey || staffTrailKey(marker.staff) || "").trim();
    const reg = compactReg(parseFleetReg(marker.staff?.vehicle?.ref).reg || "");
    if (key && focus.trailKeys.has(key)) return true;
    if (reg && focus.regs.has(reg)) return true;
    return false;
  }
  return busMatchesHistoryFocus(marker?.bus, marker?.extra || {}, focus);
}

function applyHistoryMapFocusToLiveMarkers(focus = historyMapFocus()) {
  if (!focus) return;
  if (focus.hideAll) {
    for (const [id] of [...markers.entries()]) {
      dropServiceBus(id);
      motion.delete(`bus-${id}`);
    }
    for (const [id, marker] of [...staffMarkers.entries()]) {
      staffLayer.removeLayer(marker);
      staffMarkers.delete(id);
      motion.delete(`staff-${id}`);
    }
    if (followTarget) stopFollowBus();
    return;
  }
  if (!focus.journeyOnly) return;
  for (const [id, marker] of [...markers.entries()]) {
    if (markerMatchesHistoryFocus(marker, focus)) continue;
    dropServiceBus(id);
    motion.delete(`bus-${id}`);
  }
  for (const [id, marker] of [...staffMarkers.entries()]) {
    if (markerMatchesHistoryFocus(marker, focus)) continue;
    staffLayer.removeLayer(marker);
    staffMarkers.delete(id);
    motion.delete(`staff-${id}`);
  }
}

function routeOverlayActive(playKey, { vehicleId = "", trailKey = "" } = {}) {
  if (!playback?.playKey) return false;
  return (
    String(playback.playKey) === String(playKey) ||
    (vehicleId && String(playback.vehicleId) === String(vehicleId)) ||
    (trailKey && String(playback.trailKey || "") === String(trailKey))
  );
}


function resolvePlaybackVehiclePing({ vehicleId = "", trailKey = "", reg = "", trackedGps = [] } = {}) {
  const vid = String(vehicleId || "").trim();
  const trail = String(trailKey || "").trim();
  const plate = compactReg(reg || "");
  const focus = {
    hideAll: false,
    journeyOnly: true,
    vehicleIds: new Set([vid].filter(Boolean)),
    trailKeys: new Set([vid, trail, plate ? "reg:" + plate : ""].filter(Boolean)),
    regs: new Set([plate].filter(Boolean)),
  };
  for (const marker of markers.values()) {
    if (!busMatchesHistoryFocus(marker.bus, marker.extra || {}, focus)) continue;
    const [lng, lat] = marker.bus?.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const t = marker.bus?.datetime ? new Date(marker.bus.datetime).getTime() : NaN;
    return {
      lat,
      lng,
      heading: Number(marker.bus?.heading),
      t: Number.isFinite(t) ? t : Date.now(),
      speedMph: Number.isFinite(marker.bus?.speedMph) ? marker.bus.speedMph : null,
      source: "live",
    };
  }
  for (const marker of staffMarkers.values()) {
    if (!markerMatchesHistoryFocus(marker, focus)) continue;
    const lat = Number(marker.staff?.positioning?.latitude);
    const lng = Number(marker.staff?.positioning?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const t = marker.staff?.recordedAtTime ? new Date(marker.staff.recordedAtTime).getTime() : NaN;
    return {
      lat,
      lng,
      heading: Number(marker.staff?.positioning?.bearing),
      t: Number.isFinite(t) ? t : Date.now(),
      speedMph: Number.isFinite(marker.staff?.speedMph) ? marker.staff.speedMph : null,
      source: "staff",
    };
  }
  return recordedTrailEndPing(trackedGps);
}

/** Use the recorded run's own endpoint for history; a current marker may be on a later return leg. */
function recordedTrailEndPing(gpsPoints) {
  const points = normalizeGpsTrailPoints(gpsPoints)
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    .sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
  const last = points[points.length - 1];
  if (!last) return null;
  return {
    lat: last.lat,
    lng: last.lng,
    heading: Number(last.heading),
    t: Number.isFinite(last.t) ? last.t : Date.now(),
    speedMph: Number.isFinite(last.speedMph) ? last.speedMph : null,
    source: "trail",
  };
}

/** Build GPS samples for trail arrows: prefer real pings, else last ping projected along the road path. */
function gpsPointsForJourneyArrows(roadPath, lastPing, trackedGps = [], datetime = "") {
  const real = normalizeGpsTrailPoints(trackedGps);
  if (real.length >= 2) return real;
  const flat = flattenTrailLatLngs(roadPath);
  if (!lastPing || !Number.isFinite(lastPing.lat) || !Number.isFinite(lastPing.lng) || flat.length < 2) {
    return real.length
      ? real
      : lastPing && Number.isFinite(lastPing.lat)
        ? [
            {
              lat: lastPing.lat,
              lng: lastPing.lng,
              t: lastPing.t,
              heading: lastPing.heading,
              speedMph: lastPing.speedMph,
            },
          ]
        : [];
  }
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < flat.length; i += 1) {
    const d = haversineMeters(lastPing.lat, lastPing.lng, flat[i][0], flat[i][1]);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  const startMs = datetime ? new Date(datetime).getTime() : NaN;
  const endMs = Number.isFinite(lastPing.t) ? lastPing.t : Date.now();
  const origin = Number.isFinite(startMs) && startMs < endMs ? startMs : endMs - 45 * 60_000;
  const out = [];
  const step = Math.max(1, Math.floor(Math.max(bestI, 1) / 48));
  for (let i = 0; i <= bestI; i += step) {
    const frac = bestI > 0 ? i / bestI : 1;
    const a = flat[Math.max(0, i - 1)];
    const b = flat[i];
    const heading =
      i === bestI && Number.isFinite(lastPing.heading) ? lastPing.heading : segmentBearing(a, b);
    out.push({
      lat: b[0],
      lng: b[1],
      t: origin + (endMs - origin) * frac,
      heading,
      speedMph: i === bestI ? lastPing.speedMph : null,
    });
  }
  out.push({
    lat: lastPing.lat,
    lng: lastPing.lng,
    t: endMs,
    heading: Number.isFinite(lastPing.heading) ? lastPing.heading : out[out.length - 1]?.heading,
    speedMph: lastPing.speedMph,
  });
  return out;
}

/** Bustimes-style playback colour — deep indigo route tail. */
const PLAYBACK_LINE_COLOR = "#5b51e3";

/** The planned remainder is deliberately white: green/blue is the travelled tail. */
function drawPlannedRouteAhead(path, layer, breakOpts = {}) {
  if (!layer || !Array.isArray(path) || path.length < 2) return;
  const segs = asTrailLatLngs(path, breakOpts);
  if (!segs.length) return;
  const casing = {
    color: "#0b1018",
    weight: 8,
    opacity: 0.38,
    lineJoin: "round",
    lineCap: "round",
    interactive: false,
    className: "planned-route-ahead-casing",
  };
  const line = {
    color: "#f8fafc",
    weight: 5,
    opacity: 0.94,
    lineJoin: "round",
    lineCap: "round",
    interactive: false,
    className: "planned-route-ahead",
  };
  makeTrailPathLayer(segs, casing, layer);
  makeTrailPathLayer(segs, line, layer);
}

/** Cut a path at the bus's current ping so the tail never runs ahead of it. */
function clipTrailPathAtPing(path, ping, { failClosed = false } = {}) {
  if (!ping || !Number.isFinite(ping.lat) || !Number.isFinite(ping.lng)) {
    return failClosed ? [] : path;
  }
  const segs = asTrailLatLngs(path);
  if (!segs.length) return failClosed ? [] : path;
  let bestSeg = -1;
  let bestIdx = -1;
  let bestD = Infinity;
  for (let s = 0; s < segs.length; s += 1) {
    const seg = segs[s];
    for (let i = 0; i < seg.length; i += 1) {
      const d = haversineMeters(ping.lat, ping.lng, seg[i][0], seg[i][1]);
      if (d < bestD) {
        bestD = d;
        bestSeg = s;
        bestIdx = i;
      }
    }
  }
  // Ping must sit on this path (±350m) — otherwise it belongs to another leg.
  // Never fall back to the full path here: doing so lets a live coach tail run
  // beyond the vehicle whenever identity matching briefly fails.
  if (bestSeg < 0 || bestIdx < 1 || bestD > 350) return [];
  const out = segs.slice(0, bestSeg).map((seg) => seg.slice());
  const tail = segs[bestSeg].slice(0, bestIdx + 1);
  tail.push([ping.lat, ping.lng]);
  out.push(tail);
  return out.filter((seg) => seg.length >= 2);
}

/** One bustimes-style scene: indigo stroke, white chevrons, ping pin, stops.
 * For GPS-tail playbacks the pinned strokes carry the line + arrows; the scene adds
 * ping/stop markers only, so nothing is drawn twice.
 */
function drawPlaybackScene(drawPath, opts = {}, { fit = true } = {}) {
  const {
    trackedGps = [],
    lastPing = null,
    isHistorical = false,
    usingTracked = false,
    replayOnly = false,
    alignBreak = {},
    datetime = "",
    tripStops = [],
    plannedAheadPath = null,
  } = opts;
  playbackLayer.clearLayers();
  restoreGpsReplayLayers();
  if (plannedAheadPath) drawPlannedRouteAhead(plannedAheadPath, playbackLayer, alignBreak);
  const flat = flattenTrailLatLngs(drawPath);
  if (flat.length < 2 && !plannedAheadPath) return;
  // For a live coach, the green line is the recorded GPS tail rendered in
  // liveTrailLayer. Never paint the planned Bustimes path a second time as a
  // green "tail" — that made a diverted coach appear to stick to the schedule.
  const plannedLiveCoachTail = Boolean(
    plannedAheadPath &&
    isCoachTrailOperator(alignBreak.operator) &&
    !isHistorical &&
    !replayOnly,
  );
  if (!plannedLiveCoachTail && !usingTracked && !replayOnly && flat.length >= 2) {
    const arrowGps =
      trackedGps.length >= 2
        ? normalizeGpsTrailPoints(trackedGps)
        : gpsPointsForJourneyArrows(drawPath, lastPing, trackedGps, datetime);
    const pair = makeTrailPair(drawPath, playbackLayer, {
      gpsPoints: arrowGps.length ? arrowGps : lastPing ? [lastPing] : [],
      ...alignBreak,
    });
    try {
      pair.line.setStyle({
        color: trailLineColor(alignBreak?.operator),
        weight: 4,
        opacity: 0.96,
        lineJoin: "round",
        lineCap: "round",
      });
    } catch {
      /* ignore */
    }
    if (!pair?.arrows?.length) {
      pair.arrows = buildTrailArrowsAlongRoad(drawPath, playbackLayer, {
        gpsPoints: arrowGps.length ? arrowGps : lastPing ? [lastPing] : [],
        breakOpts: alignBreak,
      });
    }
  }
  if (isHistorical && !replayOnly) {
    L.circleMarker(flat[0], {
      radius: 6,
      color: "#ffffff",
      weight: 2,
      fillColor: "#22c55e",
      fillOpacity: 1,
    })
      .addTo(playbackLayer)
      .bindTooltip("Start", { direction: "top", opacity: 0.9 });
    L.circleMarker(flat[flat.length - 1], {
      radius: 6,
      color: "#ffffff",
      weight: 2,
      fillColor: "#ef4444",
      fillOpacity: 1,
    })
      .addTo(playbackLayer)
      .bindTooltip("End", { direction: "top", opacity: 0.9 });
  }
  // Last AVL ping on the road (where arrows / bus orientation come from).
  // During Replay the animated cursor is authoritative; do not show the
  // recorded final ping ahead of it.
  if (!replayOnly && lastPing && Number.isFinite(lastPing.lat) && Number.isFinite(lastPing.lng)) {
    const snap = snapHit(lastPing.lat, lastPing.lng, lastPing.heading, 120) || null;
    const plat = snap?.lat ?? lastPing.lat;
    const plng = snap?.lng ?? lastPing.lng;
    const pHead = Number.isFinite(snap?.heading) ? snap.heading : lastPing.heading;
    const when = formatTrailArrowTime(lastPing.t);
    L.circleMarker([plat, plng], {
      radius: 7,
      color: "#0b1018",
      weight: 2,
      fillColor: "#73d700",
      fillOpacity: 1,
    })
      .addTo(playbackLayer)
      .bindTooltip(when ? "Last ping · " + when : "Last ping", { direction: "top", opacity: 0.95 });
    if (Number.isFinite(pHead)) {
      L.marker([plat, plng], {
        interactive: false,
        keyboard: false,
        zIndexOffset: 400,
        icon: trailArrowIcon(pHead),
      }).addTo(playbackLayer);
    }
  }
  for (const stop of tripStops) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) continue;
    L.circleMarker([stop.lat, stop.lng], {
      radius: stop.timingStatus === "PTP" ? 4 : 3,
      color: "#0b1018",
      weight: 1,
      fillColor: stop.done ? "#94a3b8" : "#c4b5fd",
      fillOpacity: 0.95,
    })
      .addTo(playbackLayer)
      .bindTooltip(stop.name || "Stop", { direction: "top", opacity: 0.9 });
  }
  if (fit) {
    map.fitBounds(L.latLngBounds(flat).pad(0.1), { maxZoom: 13, animate: true });
  }
  // A late scene/road redraw must not detach the replay cursor or its tail.
  restoreGpsReplayLayers();
}

/**
 * A planned route can become wrong while a coach is already being followed.
 * Rebuild the same journey as an actual/diverted GPS route rather than leaving
 * the scheduled line stuck to the map. The request arguments are captured on
 * playback so direction, identity and history/replay mode are preserved.
 */
function switchPlaybackToActualRoute() {
  const current = playback;
  if (
    !current ||
    current.diverted ||
    playbackDiversionSwitchBusy ||
    !current.requestArgs
  ) {
    return false;
  }
  playbackDiversionSwitchBusy = true;
  markPlannedRouteDiverted(current.requestArgs);
  const args = {
    ...current.requestArgs,
    diverted: true,
    autoReplay: Boolean(current.requestArgs.autoReplay),
    recordedReplay: Boolean(current.requestArgs.recordedReplay),
  };
  try {
    stopRoutePlayback("", { clearTail: true, invalidatePending: false });
    startRoutePlayback(args)
      .catch(() => {})
      .finally(() => {
        playbackDiversionSwitchBusy = false;
      });
  } catch {
    playbackDiversionSwitchBusy = false;
    return false;
  }
  return true;
}

async function startRoutePlayback({
  tripId,
  journeyId = "",
  vehicleId = "",
  trailKey = "",
  line = "",
  operator = "",
  direction = "",
  dest = "",
  datetime = "",
  reg = "",
  showTail = false,
  diverted = false,
  autoReplay = false,
  recordedReplay = false,
  live = false,
} = {}) {
  const requestId = ++playbackRequestSeq;
  const playKey = tripId || journeyId || trailKey || vehicleId || regTrailKey(reg);
  const requestedRecordedReplay =
    recordedReplay === true ||
    Boolean(
      !live &&
      datetime &&
        Number.isFinite(new Date(datetime).getTime()) &&
        Date.now() - new Date(datetime).getTime() > 12 * 60_000,
    );
  // Staffordshire buses and coaches use the matching Bustimes trip alignment
  // when one is available; the current marker still clips live playback to the
  // bus. A real diversion is different: keep the recorded GPS route instead of
  // substituting the scheduled alignment. 36A retains its explicit A50 override;
  // its active Longton closure is handled by the road-notice check below.
  const plannedRouteOverride = usesPlannedRouteOverride(line, operator);
  const route36AOverride =
    sameServiceLine(line, "36A") &&
    (!operator || String(operator).trim().toUpperCase() === "FPOT");
  let actualRouteRequired = Boolean(
    !route36AOverride && (diverted || isDivertedText(dest, line, operator)),
  );
  if (!playKey) {
    showMessage("No route to show");
    return;
  }
  if (routeOverlayActive(playKey, { vehicleId, trailKey })) {
    // Reuse an existing replay only when it has the same live/recorded mode.
    // Switching from a Fleet history replay to a live bus replay must rebuild
    // the clipped path rather than merely restarting the full historical one.
    const sameReplayMode = Boolean(playback?.replayRecorded) === requestedRecordedReplay;
    const sameActualRoute = Boolean(playback?.diverted) === actualRouteRequired;
    const sameInputMode = Boolean(playback?.requestArgs?.live) === Boolean(live);
    if (autoReplay && gpsReplay?.pts?.length >= 2 && sameReplayMode && sameActualRoute) {
      gpsReplayStart();
      return;
    }
    if (!autoReplay && sameReplayMode && sameActualRoute && sameInputMode) {
      stopRoutePlayback("", { clearTail: true });
      return;
    }
  }
  gpsReplayTeardown();
  showMessage("Loading route…");
  // A new history row replaces the previous replay immediately; never leave old
  // outbound/inbound tails visible while the next Bustimes trip is loading.
  stopRoutePlayback("", { clearTail: true, invalidatePending: false });
  clearPinnedTrails();
  setLiveTrailFocus("");
  const safeJourneyId = trailFilterJourneyId(journeyId, line);
  let safeDirection = normalizeTrailDirection(direction);
  const keys = trailKeysForVehicle({
    vehicleId,
    trailKey,
    reg,
    journeyId: safeJourneyId,
    tripId,
    line,
    datetime,
    direction: safeDirection,
  });
  for (const key of keys) rememberTrailVehicle(key);

  const coachPlayback = isCoachTrailOperator(operator);
  let fromMs = 0;
  let toMs = 0;
  let aroundMs = 0;
  const historicalPlayback = Boolean(
    !live &&
      datetime &&
      Number.isFinite(new Date(datetime).getTime()) &&
      Date.now() - new Date(datetime).getTime() > 12 * 60_000,
  );
  // A live bus-card Replay follows the bus and must remain clipped to its
  // current marker. Fleet history replays opt into the complete recorded run
  // separately, so they can show the whole journey that was actually stored.
  const replayRecordedRun = requestedRecordedReplay;
  let preserveRecordedRun = replayRecordedRun;
  if (datetime) {
    const start = new Date(datetime).getTime();
    if (Number.isFinite(start)) {
      aroundMs = start;
      if (coachPlayback) {
        fromMs = Math.min(start - 30 * 60 * 1000, Date.now() - COACH_TRAIL_LIVE_MS);
        toMs = 0;
      } else {
        // One outbound or inbound run — not the whole day there-and-back.
        fromMs = start - 30 * 60 * 1000;
        toMs = start + 5 * 60 * 60 * 1000;
      }
    }
  } else if (coachPlayback) {
    fromMs = Date.now() - COACH_TRAIL_LIVE_MS;
    toMs = 0;
    aroundMs = Date.now();
  }

  let resolvedTripId = await resolveTripIdForPlayback({
    tripId,
    journeyId: safeJourneyId,
    vehicleId,
    line,
    datetime,
  });
  if (!resolvedTripId && isCoachTrailOperator(operator)) {
    resolvedTripId = await resolveBustimesTripForPlayback({
      operator,
      line,
      datetime,
      destination: dest,
      vehicleId,
    });
  }
  if (requestId !== playbackRequestSeq) return;
  // Prefer journey/trip segment keys first so Map shows this route only, not the whole day.
  if (resolvedTripId) {
    const tripSeg = `trip:${resolvedTripId}`;
    if (!keys.includes(tripSeg)) keys.unshift(tripSeg);
  }
  if (safeJourneyId) {
    const jnySeg = `jny:${safeJourneyId}`;
    if (!keys.includes(jnySeg)) keys.unshift(jnySeg);
  }
  if (coachPlayback) {
    const expanded = await expandCoachTrailKeys(keys, {
      operator,
      line,
      reg,
      vehicleId,
      journeyId: safeJourneyId,
      tripId: resolvedTripId || tripId,
    });
    for (const key of expanded) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  await fetchServerTrailsChunked(keys, {
    fromMs: fromMs ? fromMs - 30 * 60_000 : 0,
    toMs: toMs ? toMs + 30 * 60_000 : 0,
    force: true,
  });
  if (requestId !== playbackRequestSeq) return;

  // If Map didn't say in/out, infer from GPS near this run — never draw both legs.
  if (!safeDirection) {
    const sample = [];
    for (const key of keys) {
      for (const p of trailMem.get(String(key)) || []) {
        if (fromMs && Number(p.t) < fromMs) continue;
        if (toMs && Number(p.t) > toMs) continue;
        sample.push(p);
      }
    }
    safeDirection = inferTrailDirection(sample, aroundMs || Date.now());
    if (safeDirection) {
      for (const key of trailKeysForVehicle({
        vehicleId,
        trailKey,
        reg,
        journeyId: safeJourneyId,
        tripId: resolvedTripId || tripId,
        line,
        datetime,
        direction: safeDirection,
      })) {
        if (!keys.includes(key)) keys.push(key);
      }
      await fetchServerTrailsChunked(keys, {
        fromMs: fromMs ? fromMs - 30 * 60_000 : 0,
        toMs: toMs ? toMs + 30 * 60_000 : 0,
        force: true,
      });
    }
  }
  if (requestId !== playbackRequestSeq) return;

  // Load the full window without forcing one direction — we split trips below.
  const staffsGap =
    isStaffsTrailOperator(operator) || isAltonLine(line) || String(trailKey || "").startsWith("staff-");
  const coachGapMs = coachPlayback ? COACH_TRAIL_BREAK_GAP_MS : staffsGap ? STAFFS_TRAIL_BREAK_GAP_MS : 18 * 60_000;
  let trackOpts = {
    journeyId: "",
    tripId: "",
    fromMs,
    toMs,
    line,
    direction: "",
  };
  let allGps = collectTrailGpsForKeys(keys, trackOpts);
  if (allGps.length < 2 && reg) {
    const regKey = regTrailKey(reg);
    if (regKey && !keys.includes(regKey)) keys.push(regKey);
    await fetchServerTrails([regKey], { fromMs, toMs, force: true });
    allGps = collectTrailGpsForKeys(keys, trackOpts);
  }
  if (coachPlayback && allGps.length < 2) {
    await fetchServerTrailsChunked(keys, { force: true });
    if (requestId !== playbackRequestSeq) return;
    trackOpts = { ...trackOpts, fromMs: Date.now() - COACH_TRAIL_LIVE_MS, toMs: 0 };
    allGps = collectTrailGpsForKeys(keys, trackOpts);
  }
  if (requestId !== playbackRequestSeq) return;
  // Scope the run before segmentation. NatEx/Flix feeds can expose two journey
  // IDs with the same trip/direction; segmenting the combined vehicle day can
  // otherwise splice a second coach path into the selected tail.
  const exactJourneyGps = safeJourneyId
    ? allGps.filter((point) => String(point.journeyId || "") === safeJourneyId)
    : [];
  const exactTripGps = resolvedTripId
    ? allGps.filter((point) => String(point.tripId || "") === String(resolvedTripId))
    : [];
  const scopedGps = exactJourneyGps.length >= 2
    ? exactJourneyGps
    : exactTripGps.length >= 2
      ? exactTripGps
      : allGps;
  const tripSegments = segmentTrailIntoTrips(scopedGps, { gapMs: coachGapMs });

  // Playback highlight: start with the trip matching journey/trip/time. Recorded
  // Fleet rows are then expanded below when a feed changes IDs mid-run.
  let trackedGps = [];
  let trackedRunIndex = -1;
  let exactJourneyUnavailable = false;
  if (resolvedTripId || safeJourneyId || safeDirection || aroundMs) {
    const wantTrip = String(resolvedTripId || tripId || "").trim();
    const wantJny = String(safeJourneyId || "").trim();
    const match = tripSegments.find((seg) => {
      if (wantTrip && seg.some((p) => String(p.tripId || "") === wantTrip)) return true;
      if (wantJny && seg.some((p) => String(p.journeyId || "") === wantJny)) return true;
      return false;
    });
    if (match) {
      trackedGps = match;
      trackedRunIndex = tripSegments.indexOf(match);
    } else if (wantJny && allGps.filter((p) => String(p.journeyId || "") === wantJny).length < 2) {
      // Bustimes history IDs and recorder IDs can differ. If the exact journey
      // is absent, use the nearest same-direction stint only when the selected
      // trip/time still identifies a real GPS run.
      const nearby = clipPointsToSingleDirectionRun(scopedGps, {
        direction: safeDirection,
        aroundMs: aroundMs || (scopedGps[0] ? Number(scopedGps[0].t) : 0),
      });
      if (nearby.length >= 2) {
        trackedGps = nearby;
        trackedRunIndex = findTrailRunIndex(tripSegments, trackedGps, aroundMs);
      } else {
        exactJourneyUnavailable = true;
        trackedGps = [];
        trackedRunIndex = -1;
      }
    } else {
      trackedGps = clipPointsToSingleDirectionRun(scopedGps, {
        direction: safeDirection,
        aroundMs: aroundMs || (scopedGps[0] ? Number(scopedGps[0].t) : 0),
      });
      trackedRunIndex = findTrailRunIndex(tripSegments, trackedGps, aroundMs);
    }
  } else if (tripSegments.length) {
    trackedGps = tripSegments[0];
    trackedRunIndex = 0;
  }
  if (!exactJourneyUnavailable && trackedGps.length < 2 && scopedGps.length >= 2) {
    trackedGps = clipPointsToSingleDirectionRun(scopedGps, {
      direction: safeDirection,
      aroundMs: aroundMs || Number(scopedGps[0].t) || 0,
    });
    trackedRunIndex = findTrailRunIndex(tripSegments, trackedGps, aroundMs);
  }
  const liveFilter = {
    liveVehicleId: vehicleId,
    liveTrailKey: trailKey,
    liveReg: reg,
    liveJourneyId: safeJourneyId,
    liveTripId: resolvedTripId || tripId,
  };
  const lastRecordedT = Number(trackedGps[trackedGps.length - 1]?.t);
  const recordedRunFresh =
    Number.isFinite(lastRecordedT) &&
    Date.now() - lastRecordedT >= 0 &&
    Date.now() - lastRecordedT <= 90_000;
  const candidateLivePing = livePingForTrailFilter(liveFilter, trackedGps);
  // A Fleet row can still be marked historical while its final GPS ping is
  // only a few seconds old (the recorder updates after the row was rendered).
  // Follow that run live until it goes quiet; explicit Replay remains recorded.
  if (preserveRecordedRun && !autoReplay && recordedRunFresh && (live || candidateLivePing)) {
    preserveRecordedRun = false;
  }

  if (preserveRecordedRun && trackedRunIndex >= 0 && tripSegments.length > 1) {
    trackedGps = mergeRecordedReplayRuns(tripSegments, trackedRunIndex, {
      line: line || trackedGps.find((p) => p?.line)?.line || "",
      direction: safeDirection || recordedReplayRunDirection(trackedGps),
      maxGapMs: coachPlayback ? COACH_TRAIL_BREAK_GAP_MS : RECORDED_REPLAY_JOIN_GAP_MS,
    });
  }
  if (replayRecordedRun) {
    // Never animate a clock-skewed/future recorder point as if it were history.
    const maxRecordedT = Date.now() + OBSERVED_STOP_FUTURE_GRACE_MS;
    trackedGps = trackedGps.filter((point) => Number(point.t) <= maxRecordedT);
  }

  // A live route may already contain a few recorder pings beyond the bus's current
  // position. Cut the selected run at the bus before building the path, timetable
  // observations, replay, or pinned tail; historical replays keep the whole run.
  const currentLivePing = preserveRecordedRun ? null : candidateLivePing;
  if (currentLivePing) {
    trackedGps = clipGpsPointsAtPing(trackedGps, currentLivePing);
  }

  let tracked = pathFromGpsPoints(trackedGps);
  const tripDate = datetime ? String(datetime).slice(0, 10) : "";
  const trip = resolvedTripId
    ? await tripEnds(resolvedTripId, { date: tripDate })
    : tripId
      ? await tripEnds(tripId, { date: tripDate })
      : null;
  if (requestId !== playbackRequestSeq) return;
  const fetchedTripPath = Array.isArray(trip?.path) ? trip.path : [];
  const plannedMeta = {
    tripId: resolvedTripId || tripId,
    line,
    operator,
    date: tripDate,
    destination: dest,
  };
  // Show route is the source for a coach replay. Once a route has been shown,
  // reuse that exact five-day geometry instead of resolving a different same-
  // numbered service on the next click. Fresh live previews still prefer the
  // current Bustimes response until the route has been saved.
  const cachedTripPath = requestedRecordedReplay ? recallPlannedRoute(plannedMeta) : [];
  const tripPath = cachedTripPath.length >= 2 ? cachedTripPath : fetchedTripPath;
  if (plannedRouteOverride && !actualRouteRequired && tripPath.length >= 2) {
    rememberPlannedRoute(tripPath, plannedMeta);
  }
  // A diversion is not always present in the feed text. If the selected
  // vehicle is already clearly away from a dense Bustimes alignment, prefer
  // its recorded GPS before choosing the planned path. Sparse stop lists are
  // rechecked after road matching below.
  const quickRouteEvidence =
    plannedRouteOverride && tripPath.length >= 2
      ? routeDeviationEvidence({
          plannedPath: tripPath,
          gpsPoints: trackedGps,
          livePing: currentLivePing,
        })
      : null;
  const quickSpatialDeviation = Boolean(
    !route36AOverride &&
    quickRouteEvidence &&
    !quickRouteEvidence.sparse &&
    quickRouteEvidence.detected,
  );
  if (quickSpatialDeviation) actualRouteRequired = true;
  const tripStops = attachObservedStopTimes(
    Array.isArray(trip?.stops) ? trip.stops : [],
    trackedGps,
    {
      tripId: resolvedTripId || tripId,
      journeyId: safeJourneyId,
      line: line || trip?.line || "",
      fromMs,
      toMs,
      nowMs: Date.now(),
    },
  );
  const coachOp = coachPlayback;
  // Route 36A explicitly displays the published A50 alignment instead of the
  // recorded Longton diversion. Other journeys still prefer recorded GPS.
  const plannedPathBlocked =
    plannedRouteOverride &&
    tripPath.length >= 2 &&
    trackedGps.length >= 2 &&
    pathCrossesActiveRoadNotice(tripPath);
  let plannedPath =
    plannedRouteOverride &&
    !actualRouteRequired &&
    tripPath.length >= 2 &&
    !plannedPathBlocked
      ? tripPath
      : [];
  // Prefer the recorded GPS whenever this journey has a usable recorded run,
  // including historical Fleet rows. A scheduled/timetable path is only a
  // fallback when no GPS was captured; otherwise the row can silently show a
  // planned line instead of the route the bus actually drove.
  const hasRecordedGps = tracked.length >= 2;
  if (
    !plannedPath.length &&
    !actualRouteRequired &&
    usesPlannedRouteOverride(line, operator) &&
    !hasRecordedGps &&
    tripPath.length >= 2
  ) {
    plannedPath = tripPath;
  }
  const plannedReplayPoints = plannedPath.length >= 2
    ? plannedPathReplayPoints(plannedPath, {
        startMs: trip?.startMs || aroundMs || Date.now(),
        endMs: trip?.endMs || 0,
        direction: safeDirection,
      })
    : [];
  let usingTracked = hasRecordedGps && !plannedPath;
  if (coachOp && hasRecordedGps && !plannedPath) {
    // Coaches: always show the roads actually driven — never substitute the full timetable.
    usingTracked = true;
  }
  // An explicit Replay uses the recorded GPS line unless the route-specific
  // planned override is active.
  const replayOnly = Boolean(autoReplay);
  if (autoReplay && !plannedPath) usingTracked = hasRecordedGps;
  let path = plannedPath.length >= 2
    ? plannedPath
    : actualRouteRequired
      ? tracked
      : replayOnly
        ? tracked
        : historicalPlayback && tripPath.length >= 2 && !usingTracked
          ? tripPath
          : usingTracked
            ? tracked
            : tripPath.length >= 2
              ? tripPath
              : tracked.length >= 2
                ? tracked
                : [];
  usingTracked = path === tracked && tracked.length >= 2;
  if (!autoReplay && path.length < 2 && tripSegments.some((seg) => seg.length >= 2)) {
    const fallbackRun = tripSegments.reduce((best, run) => (run.length > best.length ? run : best), tripSegments[0]);
    trackedGps = preserveRecordedRun
      ? fallbackRun
      : currentLivePing
        ? clipGpsPointsAtPing(fallbackRun, currentLivePing)
        : [];
    tracked = pathFromGpsPoints(trackedGps);
    path = tracked;
    usingTracked = path.length >= 2;
  }
  if (actualRouteRequired && tracked.length < 2) {
    showMessage(
      "This journey is diverted, but no recorded GPS is available yet — the planned route will not be shown",
    );
    return;
  }
  if (path.length < 2 && !(replayOnly && allGps.length >= 2)) {
    showMessage(
      "No GPS path recorded yet for that journey — keep the live map open while it runs so we can record the roads it takes, then try Replay again",
    );
    return;
  }
  const lineName = line || trip?.line || "Bus";
  const opUpper = String(operator || "").trim().toUpperCase();
  const opName =
    opUpper === "FLIX"
      ? "FlixBus"
      : opUpper === "NATX"
        ? "National Express"
        : trip?.operator || operator || "";
  const headsign = dest || trip?.headsign || trip?.to || "";
  const journeyDate = datetime ? String(datetime).slice(0, 10) : "";
  const roadBreak = {
    operator,
    line: lineName,
    coach: coachOp || isCoachTrailOperator(operator),
    staffs: isStaffsTrailOperator(operator) || isAltonLine(lineName),
    actualRoute: actualRouteRequired,
    plannedRoute: plannedPath.length >= 2 || (usesPlannedRouteOverride(line, operator) && !usingTracked),
  };

  // A historical Map view still has a live vehicle marker when the bus is
  // tracked now. Use that position (or the final recorded ping as fallback)
  // for every visible tail; a planned/recorded route must never run past it.
  const isHistorical = preserveRecordedRun;
  const plannedEnd = plannedPath.length >= 2
    ? Array.isArray(plannedPath[0]?.[0])
      ? plannedPath[plannedPath.length - 1]?.[plannedPath[plannedPath.length - 1].length - 1]
      : plannedPath[plannedPath.length - 1]
    : null;
  const plannedEndPing =
    plannedPath.length >= 2 && Array.isArray(plannedEnd)
      ? {
          lat: Number(plannedEnd[0]),
          lng: Number(plannedEnd[1]),
          t: Number(trip?.endMs) || aroundMs || Date.now(),
          source: "planned-route",
        }
      : null;
  const lastPing =
    (plannedPath.length >= 2 && preserveRecordedRun ? plannedEndPing : null) ||
    currentLivePing ||
    (preserveRecordedRun
      ? recordedTrailEndPing(trackedGps)
      : resolvePlaybackVehiclePing({ vehicleId, trailKey, reg, trackedGps }));
  // A recorded/history run owns its full extent. Only live playback clips to
  // the current bus marker; using a later marker's position here would append
  // the next return leg to an older journey.
  const clipPing = preserveRecordedRun ? null : lastPing;

  showMessage(usingTracked ? "Matching GPS to roads…" : "Matching route to roads…");
  let drawPath = path;
  const alignBreak = {
    ...roadBreak,
    continuous: !usingTracked,
    coach: roadBreak.coach || (!usingTracked && tripStops.length >= 2),
  };

  // GPS trails: one stroke per trip/route leg — never glue outbound+inbound or other routes.
  // Live current run: growing filtered tail. Historical Map: pin the clipped segment only.
  if (requestId !== playbackRequestSeq) return;
  if (usingTracked) {
    const liveKey = String(trailKey || vehicleId || regTrailKey(reg) || "").trim();

    if (isHistorical || !liveKey) {
      if (replayOnly) {
        // Replay draws its travelled line progressively; do not pin the full
        // historical tail ahead of the replay marker.
        multiTailActiveGroup = null;
      } else {
      // The selected row is already scoped to one journey/direction. Do not
      // re-segment it here: doing so can turn one Fleet row into several
      // visible tails when journey IDs flap at stops. Keep one synthetic tail;
      // gap splitting still happens safely inside the road renderer.
      const selectedGps = isHistorical
        ? trackedGps
        : lastPing
          ? clipGpsPointsAtPing(trackedGps, lastPing)
          : [];
      const segs = selectedGps.length >= 2 ? [selectedGps] : [];
      pinSeparateTripTails(segs, {
        baseKey: liveKey || resolvedTripId || tripId || safeJourneyId || "hist",
        line: lineName,
        operator,
        actualRoute: actualRouteRequired,
      });
      multiTailActiveGroup = {
        id: `hist:${playKey}`,
        label:
          lineName +
          (headsign ? ` → ${headsign}` : "") +
          (segs.length > 1 ? ` · ${segs.length} trips` : ""),
      };
      for (const key of pinnedTrailKeys) {
        const pinned = pinnedTrailLines.get(key);
        if (!pinned?.line) continue;
        try {
          pinned.line.setStyle({
            color: trailLineColor(operator),
            weight: 4,
            opacity: 0.96,
            lineJoin: "round",
            lineCap: "round",
          });
        } catch {
          /* ignore */
        }
      }
      }
    } else if (liveKey) {
      pinVehicleTrail({
        vehicleId,
        trailKey: liveKey,
        reg,
        // Keep the selected identity when the feed provides one; this prevents
        // a NatEx/Flix vehicle's next journey from being appended to the live tail.
        journeyId: safeJourneyId,
        tripId: resolvedTripId || "",
        line: lineName,
        operator,
        direction: safeDirection,
        datetime,
        liveFromMs: Number(trackedGps[0]?.t) > 0 ? Number(trackedGps[0]?.t) - 30_000 : 0,
        live: true,
        liveFocus: false,
        livePing: currentLivePing || lastPing,
        diverted: actualRouteRequired,
      });
      const pinned = pinnedTrailLines.get(liveKey) || pinnedTrailLines.get(String(vehicleId || ""));
      if (pinned?.line) {
        try {
          pinned.line.setStyle({
            color: trailLineColor(operator),
            weight: 4,
            opacity: 0.96,
            lineJoin: "round",
            lineCap: "round",
          });
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Bustimes-style instant tail: locally road-snapped path, clipped at the bus's current
  // position — no OSRM wait, so the route paints immediately.
  const fastBase = preferRoadMatchedTrail(path, [], alignBreak);
  const plannedNeedsRoadMatch =
    coachPlayback &&
    plannedPath.length >= 2 &&
    plannedPathNeedsRoadMatch(fastBase, alignBreak);
  const fastPath =
    flattenTrailLatLngs(fastBase).length >= 2 && !plannedNeedsRoadMatch
      ? isHistorical
        ? fastBase
        : clipTrailPathAtPing(fastBase, clipPing, { failClosed: true })
      : [];
  // Bustimes shows the scheduled road ahead in white and the travelled portion
  // in the operator colour. Keep that visual distinction for live coach routes.
  // A sparse stop list stays hidden until the road matcher returns.
  const plannedAheadPath =
    coachPlayback &&
    !isHistorical &&
    !replayOnly &&
    plannedPath.length >= 2 &&
    !plannedNeedsRoadMatch
      ? fastBase
      : null;
  const scene = {
    trackedGps: plannedPath.length >= 2 ? [] : trackedGps,
    lastPing,
    isHistorical,
    usingTracked,
    replayOnly,
    alignBreak,
    datetime,
    tripStops,
    plannedAheadPath,
  };
  drawPlaybackScene(fastPath, scene, { fit: true });
  const label =
    lineName +
    (headsign ? " → " + headsign : "") +
    (plannedPath.length >= 2
      ? " · A50 route"
      : plannedPathBlocked
        ? " · diverted GPS route"
        : actualRouteRequired
        ? " · actual GPS route"
        : usingTracked
          ? " · GPS path"
          : " · timetable");
  if (requestId !== playbackRequestSeq) return;
  playback = {
    requestId,
    playKey,
    tripId: resolvedTripId || tripId,
    journeyId,
    vehicleId,
    trailKey,
    reg: compactReg(reg),
    path: fastPath,
    label,
    line: lineName,
    tracked: Boolean(usingTracked),
    showTail: Boolean(usingTracked || plannedPath.length >= 2),
    stops: tripStops,
    diverted: actualRouteRequired,
    operator: opName,
    headsign,
    date: journeyDate,
    lastPing,
    plannedPath: plannedPath.slice(),
    requestArgs: {
      tripId: resolvedTripId || tripId,
      journeyId,
      vehicleId,
      trailKey,
      reg: compactReg(reg),
      line: lineName,
      operator,
      date: tripDate,
      direction: safeDirection,
      dest,
      datetime,
      showTail: true,
      diverted: actualRouteRequired,
      autoReplay,
      recordedReplay: requestedRecordedReplay,
      live: !isHistorical,
    },
    replayRecorded: preserveRecordedRun && plannedPath.length < 2,
  };
  // Offer a true GPS replay when we recorded pings for this journey. A live
  // replay must never fall back to the un-clipped allGps window.
  const useLiveGpsReplay =
    coachPlayback && actualRouteRequired && !preserveRecordedRun && trackedGps.length >= 2;
  let replayPoints = useLiveGpsReplay
    ? trackedGps
    : plannedReplayPoints.length >= 2
      ? plannedReplayPoints
      : trackedGps.length >= 2
        ? trackedGps
        : preserveRecordedRun
          ? allGps
          : currentLivePing
            ? clipGpsPointsAtPing(allGps, currentLivePing)
            : [];
  if (replayOnly) {
    const roadSource = plannedPath.length >= 2
      ? plannedPath
      : replayPoints.length >= 2
        ? replayPoints
        : tracked;
    let roadPath = [];
    let roadTimeout = 0;
    try {
      roadPath = await Promise.race([
        prepareRoadTrail(roadSource, undefined, alignBreak),
        new Promise((resolve) => {
          roadTimeout = setTimeout(() => resolve(null), 3500);
        }),
      ]) || [];
    } catch {
      roadPath = [];
    } finally {
      if (roadTimeout) clearTimeout(roadTimeout);
    }
    const replayRoadPath = Array.isArray(roadPath?.[0]?.[0])
      ? roadPath
        .map((segment) => thinTrailPoints(segment, 35))
        .filter((segment) => segment.length >= 2)
      : thinTrailPoints(roadPath, 35);
    const roadReplayPoints = roadPathToReplayPoints(
      replayRoadPath,
      plannedPath.length >= 2 ? plannedReplayPoints : replayPoints,
      alignBreak,
    );
    if (roadReplayPoints.length >= 2) {
      replayPoints = roadReplayPoints;
    } else if (plannedPath.length >= 2 && plannedReplayPoints.length >= 2) {
      // A sparse Bustimes stop list is still the correct scheduled route. Do
      // not leave Replay stuck on a slow OSRM response; the next replay can use
      // the road-aligned copy once the background match completes.
      replayPoints = plannedReplayPoints;
    } else {
      showMessage("No road-matched GPS is available for this replay yet — the planned route will not be shown");
      return;
    }
    if (playback) playback.path = roadPath.length >= 2 ? roadPath : roadSource;
    const roadFlat = flattenTrailLatLngs(roadPath.length >= 2 ? roadPath : roadSource);
    if (roadFlat.length >= 2) {
      map.fitBounds(L.latLngBounds(roadFlat).pad(0.1), { maxZoom: 15, animate: true });
    }
  }
  if (replayOnly && plannedPath.length >= 2) {
    // The replay fallback above is deliberately immediate; retain the route
    // matching in the background so the saved five-day copy becomes road-safe.
    prepareRoadTrail(plannedPath, undefined, alignBreak)
      .then((aligned) => {
        if (flattenTrailLatLngs(aligned).length >= 2) {
          rememberPlannedRoute(aligned, { ...plannedMeta, roadAligned: true });
        }
      })
      .catch(() => {});
  }
  if (replayPoints.length > 1200) {
    const step = Math.ceil(replayPoints.length / 1200);
    replayPoints = replayPoints.filter((_, index) => index % step === 0 || index === replayPoints.length - 1);
  }
  gpsReplaySetup(replayPoints);
  showJourneyPanel({
    operator: opName,
    line: lineName,
    headsign,
    date: journeyDate,
    stops: tripStops,
    lat: lastPing?.lat,
    lng: lastPing?.lng,
  });
  applyHistoryLineFilterToMarkers({ vehicleId, trailKey, reg, line });
  applyHistoryMapFocusToLiveMarkers();
  messageEl.hidden = true;
  updatePlaybackChrome();
  loadBuses({ replace: false }).catch(() => {});
  const open = openJourneyMarker();
  if (open) refreshPopup(open, { force: true });
  // One-click Replay: start animating along the recorded pings straight away.
  if (autoReplay && gpsReplay?.pts?.length >= 2) gpsReplayStart();

  // Quality upgrade in the background: once OSRM road-matching finishes, redraw the
  // timetable path onto real roads (still clipped at the bus). Never blocks first paint.
  if (!usingTracked && !replayOnly) {
    prepareRoadTrail(path, undefined, alignBreak)
      .then((aligned) => {
        if (!playback || playback.requestId !== requestId || playback.playKey !== playKey) return;
        let upgraded = aligned;
        const deviationPath = flattenTrailLatLngs(upgraded).length >= 2 ? upgraded : plannedPath;
        const deviationEvidence = routeDeviationEvidence({
          plannedPath: deviationPath,
          gpsPoints: trackedGps,
          livePing: clipPing,
        });
        if (
          !actualRouteRequired &&
          !route36AOverride &&
          coachPlayback &&
          deviationEvidence.detected &&
          !deviationEvidence.sparse
        ) {
          switchPlaybackToActualRoute();
          return;
        }
        if (
          flattenTrailLatLngs(upgraded).length < 2 &&
          tripStops.length >= 2 &&
          !coachPlayback
        ) {
          const stopPath = tripStops
            .filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lng))
            .map((stop) => [stop.lat, stop.lng]);
          if (stopPath.length >= 2) upgraded = stopPath;
        }
        if (
           plannedRouteOverride &&
           !actualRouteRequired &&
           flattenTrailLatLngs(upgraded).length >= 2
         ) {
           rememberPlannedRoute(upgraded, { ...plannedMeta, roadAligned: true });
         }
         const upPath = clipTrailPathAtPing(upgraded, clipPing, { failClosed: true });
        const alignedAhead =
          coachPlayback && !isHistorical && !replayOnly && flattenTrailLatLngs(upgraded).length >= 2
            ? upgraded
            : plannedAheadPath;
        if (flattenTrailLatLngs(upPath).length >= 2 || alignedAhead) {
          drawPlaybackScene(
            upPath,
            { ...scene, plannedAheadPath: alignedAhead },
            { fit: false },
          );
          if (flattenTrailLatLngs(upPath).length >= 2) playback.path = upPath;
        }
      })
      .catch(() => {});
  }
}

function followKindFor(marker) {
  if (marker?.staff) return "staff";
  return "bus";
}

function followIdFor(marker) {
  if (marker?.staff) return String(marker.staff.vehicle?.ref || marker.staff.vehicle?.vehicleUniqueId || "");
  return String(marker?.bus?.id ?? "");
}

/** Primary trail memory key for a live bus / AT staff marker. */
function liveTrailKeyForMarker(marker) {
  if (!marker) return "";
  if (marker.staff) {
    return String(marker.extra?.trailKey || staffTrailKey(marker.staff) || "").trim();
  }
  return String(marker.extra?.trailKey || marker.bus?.id || "").trim();
}

function followLabelFor(marker) {
  if (marker?.staff) return staffLineName(marker.staff) || "Staff bus";
  const bus = marker?.bus;
  if (!bus) return "Bus";
  if (isNotInService(bus)) return bus.vehicle?.name || "Not in service";
  return bus.service?.line_name || bus.vehicle?.name || "Bus";
}

function isFollowingMarker(marker) {
  if (!followTarget || !marker) return false;
  return followTarget.kind === followKindFor(marker) && followTarget.id === followIdFor(marker);
}

function followButtonHtml(marker) {
  const on = isFollowingMarker(marker);
  return `<button type="button" class="follow-bus-btn${on ? " is-on" : ""}">${on ? "Following" : "Follow"}</button>`;
}

/** Clickable reg (or fleet#) that opens the Fleet vehicle page. */
function fleetRegButtonHtml(
  reg,
  { fleet = "", vehicleId = "", operatorSlug = "", serviceId = "", line = "", operatorNoc = "" } = {},
) {
  const plate = String(reg || "").replace(/\s+/g, " ").trim();
  const fleetCode = String(fleet || "").trim();
  const id = String(vehicleId || "").trim();
  const slug = String(operatorSlug || "").trim();
  const svc = String(serviceId || "").trim();
  const route = String(line || "").trim();
  const noc = String(operatorNoc || "").trim();
  if (!plate && !fleetCode && !id && !slug && !svc) return "";
  const label = plate || (fleetCode ? `#${fleetCode}` : "Fleet");
  return `<button type="button" class="popup-fleet-reg" data-action="open-fleet-vehicle" data-reg="${esc(plate)}" data-fleet="${esc(fleetCode)}" data-vehicle-id="${esc(id)}" data-operator-slug="${esc(slug)}" data-service-id="${esc(svc)}" data-line="${esc(route)}" data-operator-noc="${esc(noc)}" title="Open in Fleet">${esc(label)}</button>`;
}

/** True only for real bustimes vehicle ids — not journey/trip ids (Flix AVL uses those as bus.id). */
function isLikelyBustimesVehicleId(bus = {}, id = "") {
  const raw = String(id ?? "").trim();
  if (!raw || /^(dg-|bods-|staff-|at-)/i.test(raw)) return false;
  if (bus?.vehicle?.id != null && String(bus.vehicle.id) === raw) return true;
  if (bus?.vehicle?.reg && /^\d+$/.test(raw)) return true;
  // Anonymised coach AVL: name only, no vehicle id/reg — bus.id is a journey id.
  if (String(bus?.journey_id) === raw && !bus?.vehicle?.id) return false;
  if (
    (isFlixBus(bus) || isNationalExpress(bus)) &&
    !bus?.vehicle?.id &&
    !bus?.vehicle?.reg &&
    !bus?.vehicle?.url
  ) {
    return false;
  }
  return /^\d+$/.test(raw) || /^[a-z0-9_-]+$/i.test(raw);
}

function bustimesVehicleIdForFleet(bus = {}, extra = {}) {
  const candidates = [
    extra.vehicle?.id,
    extra.btVehicle?.id,
    bus.vehicle?.id,
    bus.btId,
    bus.id,
  ];
  for (const raw of candidates) {
    const id = String(raw ?? "").trim();
    if (!id) continue;
    if (!isLikelyBustimesVehicleId(bus, id)) continue;
    // Prefer ids we already resolved to a vehicle record.
    if (extra.vehicle?.id != null && String(extra.vehicle.id) === id) return id;
    if (extra.btVehicle?.id != null && String(extra.btVehicle.id) === id) return id;
    if (bus.vehicle?.id != null && String(bus.vehicle.id) === id) return id;
  }
  // Only fall back to bus id when it is a real vehicle id.
  for (const raw of [extra.vehicle?.id, extra.btVehicle?.id, bus.vehicle?.id]) {
    const id = String(raw ?? "").trim();
    if (id && isLikelyBustimesVehicleId(bus, id)) return id;
  }
  return "";
}

function fleetOperatorSlugForBus(bus = {}, extra = {}) {
  if (isFlixBus(bus)) return "flixbus";
  if (isNationalExpress(bus)) return "national-express";
  const slug = String(
    extra.vehicle?.operator?.slug ||
      extra.btVehicle?.operator?.slug ||
      bus.operator?.slug ||
      "",
  ).trim();
  return slug;
}

function extractUkRegCandidate(raw) {
  const text = String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  if (!text) return "";
  const compact = text.replace(/\s+/g, "");
  const match =
    compact.match(/([A-Z]{2}\d{2}[A-Z]{3})/) ||
    compact.match(/([A-Z]\d{1,3}[A-Z]{3})/) ||
    text.match(/\b([A-Z]{2}\d{2}\s*[A-Z]{3})\b/) ||
    text.match(/\b([A-Z]\d{1,3}\s*[A-Z]{3})\b/);
  return match ? String(match[1]).replace(/\s+/g, "") : "";
}

/** Flix/NATX AVL hides plates — try BODS VehicleRef near the coach, then bustimes. */
async function resolveCoachRegFromBods(bus, extra = {}, lat, lng) {
  if (!(isFlixBus(bus) || isNationalExpress(bus))) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const pad = 0.06;
  const bbox = `${(lng - pad).toFixed(4)},${(lat - pad).toFixed(4)},${(lng + pad).toFixed(4)},${(lat + pad).toFixed(4)}`;
  const { vehicles, ok } = await fetchBodsVehicles(`bbox=${encodeURIComponent(bbox)}`);
  if (!ok || !vehicles.length) return null;
  const wantLine = compactQuery(bus.service?.line_name || extra.line || "");
  const wantOp = isFlixBus(bus) ? "FLIX" : "NATX";
  let best = null;
  let bestScore = 0;
  for (const row of vehicles) {
    const op = String(row._bods?.operator || row.operator?.noc || row.operator || "").toUpperCase();
    if (op && op !== wantOp && !op.includes(wantOp)) continue;
    const [rLng, rLat] = row.coordinates || [];
    if (!Number.isFinite(rLat) || !Number.isFinite(rLng)) continue;
    const d = haversineMeters(lat, lng, rLat, rLng);
    if (d > 450) continue;
    let score = Math.max(0, 40 - d / 12);
    const line = compactQuery(row.service?.line_name || row._bods?.line || "");
    if (wantLine && line && (line === wantLine || line.includes(wantLine) || wantLine.includes(line))) {
      score += 18;
    }
    const reg = extractUkRegCandidate(row._bods?.vehicleRef || row.vehicle?.name || "");
    if (!reg) continue;
    score += 25;
    if (score > bestScore) {
      best = { reg, row };
      bestScore = score;
    }
  }
  if (!best?.reg || bestScore < 30) return null;
  const vehicle = await bustimesVehicleByReg(best.reg, { operator: wantOp });
  return {
    reg: vehicle?.reg || best.reg,
    vehicle: vehicle || null,
    vehicleRef: best.row?._bods?.vehicleRef || "",
  };
}

async function openFleetVehiclePage({
  reg = "",
  fleet = "",
  vehicleId = "",
  operatorSlug = "",
  serviceId = "",
  line = "",
  operatorNoc = "",
} = {}) {
  if (!fleetBrowser) {
    showMessage("Fleet is not available");
    return;
  }
  setAppTab("fleet");
  let id = String(vehicleId || "").trim();
  // BODS ids (bods-FPOT-FPOT-BN72TTX) are not bustimes ids — but they carry the plate.
  const bodsRegMatch = String(id).match(/^bods-[A-Z]+-(?:[A-Z]+-)?([A-Z]{2}\d{2}[_]?[A-Z]{3})$/i);
  if (id && bodsRegMatch && !reg) reg = bodsRegMatch[1].replace(/_/g, "");
  if (id && /^(dg-|bods-|staff-|at-)/i.test(id)) id = "";
  const slug = String(operatorSlug || "").trim();
  const noc = String(operatorNoc || "").trim().toUpperCase();
  const preferOp = noc || (slug === "flixbus" ? "FLIX" : slug === "national-express" ? "NATX" : "");

  if (!id && (reg || fleet)) {
    showMessage("Opening fleet…");
    try {
      const hit =
        (await bustimesVehicleByReg(reg, { fleet, operator: preferOp })) ||
        (fleet ? await bustimesVehicleByReg("", { fleet, operator: preferOp }) : null) ||
        (await bustimesVehicleByReg(reg, { fleet })) ||
        (fleet ? await bustimesVehicleByReg("", { fleet }) : null);
      if (hit?.id != null) id = String(hit.id);
    } catch {
      /* fall through */
    }
  }

  if (id) {
    try {
      await fleetBrowser.showVehicle(id, undefined, {
        seed: {
          id,
          reg,
          fleet,
          line,
          operator: {
            name: noc || operatorSlug || "Operator",
            slug: operatorSlug,
            id: noc || null,
            noc: noc || null,
          },
          lastRoute: line ? { route: line, live: true, trackedAt: "" } : null,
        },
      });
      showMessage("");
      return;
    } catch {
      /* fall through to operator / search */
    }
  }

  const svc = String(serviceId || "").trim();
  if (svc && fleetBrowser.showRouteService) {
    try {
      await fleetBrowser.showRouteService(svc);
      showMessage("");
      return;
    } catch {
      /* try operator */
    }
  }

  if (slug && fleetBrowser.showOperator) {
    try {
      await fleetBrowser.showOperator(slug);
      showMessage(
        reg
          ? ""
          : preferOp === "FLIX" || preferOp === "NATX"
            ? "Live map hides this coach’s plate — browse the fleet / routes below"
            : "",
      );
      return;
    } catch (error) {
      showMessage(error?.message || "Could not open fleet");
      return;
    }
  }

  const query = String(reg || fleet || line || "").trim();
  if (query) {
    fleetBrowser.search(query);
    const input = document.getElementById("fleet-query");
    if (input) input.value = query;
    showMessage("");
    return;
  }
  showMessage("No registration to open in Fleet");
}

function playRouteButtonHtml(bus, extra = {}) {
  const tripId = bus?.trip_id || extra.tripId || "";
  const vehicleId = historyVehicleId(bus, extra) || "";
  const trailKey = extra.trailKey || String(bus?.id || "").trim();
  const reg =
    extra.vehicle?.reg ||
    extra.btVehicle?.reg ||
    extra.coachReg ||
    bus?.vehicle?.reg ||
    busRegistration(bus, extra) ||
    "";
  if (!tripId && !vehicleId && !trailKey && !compactReg(reg) && !bus?.journey_id) return "";
  const playKey = tripId || trailKey || vehicleId || regTrailKey(reg) || bus?.journey_id || "";
  const on = routeOverlayActive(playKey, { vehicleId, trailKey });
  const direction = normalizeTrailDirection(
    extra.direction ||
      bus?.direction ||
      bus?.directionRef ||
      bus?.currentJourney?.directionRef ||
      "",
  );
  const diverted = isDivertedText(extra.to, bus?.destination, extra.notes, bus?.origin);
  return `<button type="button" class="play-route-btn${on ? " is-on" : ""}" data-trip-id="${esc(tripId)}" data-journey-id="${esc(bus?.journey_id || "")}" data-vehicle-id="${esc(vehicleId)}" data-trail-key="${esc(trailKey)}" data-reg="${esc(reg)}" data-line="${esc(bus?.service?.line_name || extra.line || "")}" data-operator="${esc(trailOperatorForBus(bus) || extra.operator || "")}" data-direction="${esc(direction)}" data-dest="${esc(extra.to || bus?.destination || "")}" data-datetime="${esc(bus?.datetime || "")}" data-diverted="${diverted ? "1" : "0"}">${on ? "Hide route" : "Show route"}</button>`;
}

/**
 * One-click GPS replay straight off the bus card. Reuses the same recorded BODS pings as
 * "Show route" but starts the animation immediately, so the user does not have to open the
 * playback bar and hunt for the Replay control.
 */
function replayBusButtonHtml(bus, extra = {}) {
  const tripId = bus?.trip_id || extra.tripId || "";
  const vehicleId = historyVehicleId(bus, extra) || "";
  const trailKey = extra.trailKey || String(bus?.id || "").trim();
  const reg =
    extra.vehicle?.reg ||
    extra.btVehicle?.reg ||
    extra.coachReg ||
    bus?.vehicle?.reg ||
    busRegistration(bus, extra) ||
    "";
  if (!tripId && !vehicleId && !trailKey && !compactReg(reg) && !bus?.journey_id) return "";
  const playKey = tripId || trailKey || vehicleId || regTrailKey(reg) || bus?.journey_id || "";
  const on = routeOverlayActive(playKey, { vehicleId, trailKey });
  const direction = normalizeTrailDirection(
    extra.direction || bus?.direction || bus?.directionRef || bus?.currentJourney?.directionRef || "",
  );
  const diverted = isDivertedText(extra.to, bus?.destination, extra.notes, bus?.origin);
  return `<button type="button" class="play-route-btn replay-bus-btn${on ? " is-on" : ""}" data-replay="1" data-trip-id="${esc(tripId)}" data-journey-id="${esc(bus?.journey_id || "")}" data-vehicle-id="${esc(vehicleId)}" data-trail-key="${esc(trailKey)}" data-reg="${esc(reg)}" data-line="${esc(bus?.service?.line_name || extra.line || "")}" data-operator="${esc(trailOperatorForBus(bus) || extra.operator || "")}" data-direction="${esc(direction)}" data-dest="${esc(extra.to || bus?.destination || "")}" data-datetime="${esc(bus?.datetime || "")}" data-diverted="${diverted ? "1" : "0"}" title="Replay the roads this bus has actually driven">⏵ Replay</button>`;
}

function playStaffRouteButtonHtml(item, extra = {}) {
  const trailKey = extra.trailKey || staffTrailKey(item);
  const vehicleId = historyVehicleId(null, extra);
  const latest = Array.isArray(extra.history) && extra.history.length ? extra.history[0] : null;
  const tripId = latest?.trip_id || extra.tripId || "";
  const line = staffLineName(item) || extra.line || "";
  const journeyId = trailFilterJourneyId(
    latest?.journey_id || item?.currentJourney?.id || item?.currentJourney?.journeyId || "",
    line,
  );
  const direction = normalizeTrailDirection(
    latest?.direction || item?.currentJourney?.directionRef || "",
  );
  const reg = extra.btVehicle?.reg || extra.vehicle?.reg || parseFleetReg(item?.vehicle?.ref).reg || "";
  if (!trailKey && !vehicleId && !tripId && !compactReg(reg)) return "";
  const playKey = tripId || trailKey || vehicleId || regTrailKey(reg);
  const on = routeOverlayActive(playKey, { vehicleId, trailKey });
  const diverted = isDivertedText(extra.to, item?.currentJourney?.destination?.name, extra.notes);
  return `<button type="button" class="play-route-btn${on ? " is-on" : ""}" data-trip-id="${esc(tripId)}" data-journey-id="${esc(journeyId)}" data-vehicle-id="${esc(vehicleId)}" data-trail-key="${esc(trailKey)}" data-reg="${esc(reg)}" data-line="${esc(line)}" data-direction="${esc(direction)}" data-dest="${esc(extra.to || item.currentJourney?.destination?.name || "")}" data-datetime="${esc(latest?.datetime || item.recordedAtTime || "")}" data-diverted="${diverted ? "1" : "0"}">${on ? "Hide route" : "Show route"}</button>`;
}

function followedMarker() {
  if (!followTarget) return null;
  if (followTarget.kind === "staff") return staffMarkers.get(followTarget.id) || null;
  return markers.get(followTarget.id) || markers.get(Number(followTarget.id)) || null;
}

/** Same early / late wording as the bus card delay line. */
function followDelayChipText(marker) {
  if (!marker?.bus) return "";
  const bus = marker.bus;
  if (isNotInService(bus)) return "";
  const extra = marker.extra || {};
  const [lng, lat] = bus.coordinates || [];
  const delaySec = resolveLiveDelaySec(bus, extra, lat, lng, { live: true });
  if (delaySec == null || Number.isNaN(Number(delaySec))) return "";
  return formatDelay(delaySec);
}

function updateFollowChip() {
  if (!followChipEl) return;
  if (!followTarget) {
    followChipEl.hidden = true;
    followChipEl.textContent = "";
    return;
  }
  followChipEl.hidden = false;
  const started = Number(followTarget.startedAt);
  const since = Number.isFinite(started)
    ? new Date(started).toLocaleTimeString("en-GB", {
        timeZone: UK_TZ,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";
  const marker = followedMarker();
  const delay = followDelayChipText(marker);
  const parts = [`Following ${followTarget.label}`];
  if (delay) parts.push(delay);
  if (since) parts.push(`since ${since}`);
  parts.push("Stop");
  followChipEl.textContent = parts.join(" · ");
}

function stopFollowBus(message = "") {
  const marker = followedMarker();
  const trailKey = liveTrailKeyForMarker(marker);
  stopFollowDelayPolling();
  followTarget = null;
  updateFollowChip();
  // Keep the tail if Show route / pinned trails are still on the map.
  if (trailKey && String(liveTrailKey) === String(trailKey) && !pinnedTrailKeys.has(trailKey)) {
    setLiveTrailFocus("");
  } else if (!pinnedTrailKeys.size && !playback) {
    setLiveTrailFocus("");
  }
  refreshPopup(marker, { force: true });
  if (message) showMessage(message);
}

function keepFollowedInView(marker, { force = false } = {}) {
  if (!followTarget || !marker || !isFollowingMarker(marker)) return;
  const now = Date.now();
  if (!force && now - lastFollowPanAt < 1400) return;
  const ll = marker.getLatLng();
  const size = map.getSize();
  const point = map.latLngToContainerPoint(ll);
  const dx = point.x - size.x / 2;
  const dy = point.y - size.y / 2;
  const offCentre = !map.getBounds().pad(-0.2).contains(ll) || Math.hypot(dx, dy) > 70;
  if (!force && !offCentre) return;
  lastFollowPanAt = now;
  followPanning = true;
  if (force) map.setView(ll, Math.max(map.getZoom(), 16), { animate: true });
  else map.panTo(ll, { animate: true, duration: 0.35 });
  const clearPan = () => {
    followPanning = false;
  };
  map.once("moveend", clearPan);
  setTimeout(clearPan, 600);
}

function startFollowBus(marker) {
  if (!marker) return;
  followYou = false;
  locateButton?.classList.remove("active");
  followTarget = {
    kind: followKindFor(marker),
    id: followIdFor(marker),
    label: followLabelFor(marker),
    startedAt: Date.now(),
  };
  showMessage("");
  // Keep ordinary local-bus follow as marker-only, but coaches need the live
  // growing tail requested by the map view. The tail renderer clips it at the
  // current ping, so it can never run ahead of the followed vehicle.
  const trailKey = liveTrailKeyForMarker(marker);
  const showFollowTail =
    SHOW_LIVE_TAIL_WHILE_FOLLOWING ||
    Boolean(marker.bus && isCoachTrailOperator(trailOperatorForBus(marker.bus)));
  if (trailKey) rememberTrailVehicle(trailKey);
  if (showFollowTail && trailKey) {
    setLiveTrailFocus(trailKey);
  } else if (liveTrailKey) {
    // Ordinary local follow shows the bus only — drop any growing day tail that
    // was already up. Coach follows deliberately retain the live tail.
    setLiveTrailFocus("");
  }
  keepFollowedInView(marker, { force: true });
  if (announceOn) followJourney(marker, true);
  updateFollowChip();
  ensureFollowDelayPolling(marker);
}

function toggleFollowBus(marker) {
  if (isFollowingMarker(marker)) stopFollowBus();
  else startFollowBus(marker);
}

document.addEventListener(
  "click",
  (event) => {
    const photoBtn = event.target.closest(".bus-photo-btn");
    if (photoBtn) {
      event.preventDefault();
      event.stopPropagation();
      beginBusPhotoUpload(photoBtn);
      return;
    }
    if (event.target.closest(".bus-photo-name, .fleet-photo-name, .popup-photo-name-label, .fleet-photo-name-label")) {
      event.stopPropagation();
    }
    const historyBtn = event.target.closest(".history-days-btn");
    if (historyBtn) {
      event.preventDefault();
      event.stopPropagation();
      const days = Number(historyBtn.dataset.days);
      if (!HISTORY_DAY_OPTIONS.includes(days)) return;
      if (days > FREE_HISTORY_DAYS && !requirePlus("history")) return;
      historyDays = days;
      localStorage.setItem(HISTORY_DAYS_KEY, String(days));
      const marker = openJourneyMarker();
      if (!marker) return;
      marker.extra ||= {};
      marker.extra.historyDays = days;
      loadHistoryIntoMarker(marker, { force: true });
      return;
    }
    const playBtn = event.target.closest(".play-route-btn, .history-play-btn");
    if (playBtn) {
      event.preventDefault();
      event.stopPropagation();
      if (playBtn.dataset.live === "1") {
        const marker = openJourneyMarker();
        if (marker?.bus) {
          setAppTab("map");
          startFollowBus(marker);
        }
        return;
      }
      startRoutePlayback({
        tripId: playBtn.dataset.tripId,
        journeyId: playBtn.dataset.journeyId || "",
        vehicleId: playBtn.dataset.vehicleId || "",
        trailKey: playBtn.dataset.trailKey || "",
        reg: playBtn.dataset.reg || "",
        line: playBtn.dataset.line || "",
        operator: playBtn.dataset.operator || "",
        direction: playBtn.dataset.direction || "",
        dest: playBtn.dataset.dest || "",
        datetime: playBtn.dataset.datetime || "",
        showTail: true,
        diverted: playBtn.dataset.diverted === "1",
        live: playBtn.dataset.live === "1",
        recordedReplay:
          playBtn.dataset.replayRecorded === "1" || playBtn.dataset.live === "0",
        autoReplay: playBtn.dataset.replay === "1",
      })
        .catch(() => {});
      return;
    }
    const fleetRegBtn = event.target.closest(".popup-fleet-reg, [data-action='open-fleet-vehicle']");
    if (fleetRegBtn) {
      event.preventDefault();
      event.stopPropagation();
      openFleetVehiclePage({
        reg: fleetRegBtn.dataset.reg || "",
        fleet: fleetRegBtn.dataset.fleet || "",
        vehicleId: fleetRegBtn.dataset.vehicleId || "",
        operatorSlug: fleetRegBtn.dataset.operatorSlug || "",
        serviceId: fleetRegBtn.dataset.serviceId || "",
        line: fleetRegBtn.dataset.line || "",
        operatorNoc: fleetRegBtn.dataset.operatorNoc || "",
      });
      return;
    }
    const btn = event.target.closest(".follow-bus-btn");
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    const marker = openJourneyMarker();
    if (!marker) return;
    toggleFollowBus(marker);
    refreshPopup(marker, { force: true });
  },
  true,
);

document.addEventListener(
  "toggle",
  (event) => {
    const history = event.target.closest?.(".popup-history");
    if (!history || !history.open) return;
    const marker = openJourneyMarker();
    if (!marker) return;
    if (marker.extra?.historyStatus === "ready" && marker.extra.history?.length) return;
    loadHistoryIntoMarker(marker, { force: true });
  },
  true,
);

function openJourneyMarker() {
  if (selectedMapMarker) {
    const id = selectedMapMarker.bus?.id ?? selectedMapMarker.staff?.vehicle?.ref;
    if (selectedMapMarker.bus && markers.get(selectedMapMarker.bus.id) === selectedMapMarker) {
      return selectedMapMarker;
    }
    if (selectedMapMarker.staff) {
      const sid = String(selectedMapMarker.staff.vehicle?.ref || selectedMapMarker.staff.vehicle?.vehicleUniqueId || "");
      if (sid && staffMarkers.get(sid) === selectedMapMarker) return selectedMapMarker;
    }
    // Marker gone — clear stale selection.
    if (!id) selectedMapMarker = null;
  }
  for (const marker of [...markers.values(), ...staffMarkers.values()]) {
    if (marker.isPopupOpen()) return marker;
  }
  return announceFollow;
}

function timeAgo(iso) {
  if (!iso) return "No timestamp";
  const delta = Date.now() - new Date(iso).getTime();
  const secs = Math.max(0, Math.round(delta / 1000));
  // Bucket seconds so open cards don't rebuild every poll on a 1s tick.
  if (secs < 60) {
    const bucket = Math.floor(secs / 5) * 5;
    return bucket < 5 ? "just now" : `${bucket}s ago`;
  }
  return `${Math.round(secs / 60)}m ago`;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

installRoadNotices();

function staffLineName(item) {
  return (item.currentJourney?.publishedLineName || "").toUpperCase();
}

const STAFF_COLOURS = {
  AT1: "#ff6700",
  AT2: "#cc181a",
  AT3: "#cc181a",
};

const liveryCache = new Map();
const liveryById = new Map();
const btRegCache = new Map();
const LIVERY_CACHE_KEY = "uk-bus-livery-css-v1";
const LIVERY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let liveryPersistTimer = null;

function restoreLiveryCache() {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(LIVERY_CACHE_KEY);
    const entries = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(entries)) return;
    const now = Date.now();
    for (const entry of entries) {
      const id = String(entry?.id || "");
      const at = Number(entry?.at || 0);
      const row = entry?.row;
      if (!id || !row || !at || now - at > LIVERY_CACHE_TTL_MS) continue;
      if (row.left_css || row.left) liveryById.set(id, row);
    }
  } catch {
    /* ignore malformed/old cache */
  }
}

function scheduleLiveryCachePersist() {
  if (typeof localStorage === "undefined" || liveryPersistTimer) return;
  liveryPersistTimer = setTimeout(() => {
    liveryPersistTimer = null;
    try {
      const now = Date.now();
      const entries = [...liveryById.entries()]
        .slice(-400)
        .map(([id, row]) => ({ id, at: now, row }));
      localStorage.setItem(LIVERY_CACHE_KEY, JSON.stringify(entries));
    } catch {
      /* storage is optional */
    }
  }, 1000);
}

restoreLiveryCache();

/** Resolve paint: bustimes.org livery CSS first, then photo/fleet, then local brand. */
function resolveBusLivery(bus) {
  if (!bus) return null;
  const id = liveryIdOf(bus);
  const numeric = /^\d+$/.test(String(id || ""));
  // Matched bustimes.org livery id — never substitute local brand/fleet stripes.
  if (numeric) {
    const hit = liveryById.get(String(id));
    if (liveryCss(hit)) return hit;
    // A known local/fleet paint is a safe immediate fallback while the
    // bustimes CSS request is still in flight; the numeric CSS replaces it
    // as soon as ensureLiveries completes.
    const local = fleetLiveryForBus(bus);
    return liveryCss(local) ? local : null;
  }
  const raw = bus.vehicle?.livery;
  if (raw && typeof raw === "object") {
    const rawId = String(raw.id || "");
    if (/^\d+$/.test(rawId) && liveryCss(liveryById.get(rawId))) {
      return liveryById.get(rawId);
    }
    const css = liveryCss(raw);
    // Ignore synthetic op:/reg:/fleet: placeholders once paint may supply a real id.
    if (css && !/^(op|reg|fleet|line):/.test(rawId)) return raw;
  }
  const fleet = fleetLiveryForBus(bus);
  if (fleet && liveryCss(fleet)) return fleet;
  const brand = brandLiveryForBus(bus);
  if (brand && liveryCss(brand)) return brand;
  return fleet || brand || null;
}

async function ensureLiveries(idsOrBuses) {
  const list = Array.isArray(idsOrBuses) ? idsOrBuses : [];
  const bustimesIds = new Set();
  for (const item of list) {
    if (item && typeof item === "object" && (item.vehicle || item.service || item._bods)) {
      const id = liveryIdOf(item);
      if (id && /^\d+$/.test(String(id))) bustimesIds.add(String(id));
      continue;
    }
    const id = item == null || item === "" ? "" : String(typeof item === "object" ? item.id ?? "" : item);
    if (id && /^\d+$/.test(id)) bustimesIds.add(id);
  }

  const ids = [...bustimesIds].filter((id) => !liveryCss(liveryById.get(id)));
  if (!ids.length) return;
  // Bustimes flakes under a flood — few at a time; drop misses so the next poll retries.
  const concurrency = 8;
  for (let i = 0; i < ids.length; i += concurrency) {
    const chunk = ids.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (id) => {
        if (liveryCss(liveryById.get(id))) return;
        if (!liveryCache.has(id)) {
          liveryCache.set(
            id,
            fetch(`/api/bt-liveries/${encodeURIComponent(id)}/`, {
              signal: AbortSignal.timeout(8_000),
            })
              .then(async (res) => {
                if (!res.ok) {
                  liveryCache.delete(id);
                  return null;
                }
                try {
                  return await res.json();
                } catch {
                  liveryCache.delete(id);
                  return null;
                }
              })
              .catch(() => {
                liveryCache.delete(id);
                return null;
              }),
          );
        }
        const row = await liveryCache.get(id);
        if (row?.left_css || row?.left) {
          liveryById.set(id, row);
          scheduleLiveryCachePersist();
        } else liveryCache.delete(id);
      }),
    );
  }
}

/** True when bustimes supplied a numeric livery id (not local op:/reg:/fleet: tags). */
function hasNumericBustimesLivery(busOrLivery) {
  return /^\d+$/.test(String(liveryIdOf(busOrLivery) || ""));
}

/**
 * Paint needs a strong match — line-only (score 10) used to steal NATX/Flix white
 * coach paint onto Staffordshire locals sharing a route number.
 */
function paintScoreStrongEnough(score) {
  return Number(score) >= 18;
}

/** Copy bustimes colour/livery onto BODS buses — keep BODS position/id. */
function paintBodsWithBustimesLiveries(bodsBuses, btBuses) {
  const bodsList = Array.isArray(bodsBuses) ? bodsBuses : [];
  const btList = Array.isArray(btBuses) ? btBuses : [];
  if (!btList.length) return bodsList;

  return bodsList.map((bods) => {
    const bodsIsCoach = isNationalExpress(bods) || isFlixBus(bods);
    let best = null;
    let bestScore = 0;
    for (const bt of btList) {
      if (isFlixBus(bt)) continue;
      // Never let coach paint (white NATX etc.) land on local Staffs buses.
      if (!bodsIsCoach && isNationalExpress(bt)) continue;
      const score = liveBusMatchScore(bods, bt);
      if (score > bestScore) {
        best = bt;
        bestScore = score;
      }
    }
    // Synthetic op:FPOT / op:DAGC tags must not block proximity paint fallback.
    if ((!best || !paintScoreStrongEnough(bestScore)) && !hasNumericBustimesLivery(bods)) {
      const [bLng, bLat] = bods.coordinates || [];
      const lineB = compactQuery(bods.service?.line_name);
      const nearLimit = bodsIsCoach ? 12_000 : 500;
      let near = null;
      let nearD = Infinity;
      if (Number.isFinite(bLat) && Number.isFinite(bLng)) {
        for (const bt of btList) {
          if (isFlixBus(bt) || !liveryIdOf(bt)) continue;
          if (!bodsIsCoach && isNationalExpress(bt)) continue;
          const opNear = compactQuery(btOperatorNoc(bt));
          const opBods = compactQuery(bods._bods?.operator || bods.operator?.noc || bods.operator);
          if (opBods && opNear && opBods !== opNear) continue;
          if (
            bodsIsCoach &&
            isNationalExpress(bods) &&
            !isNationalExpress(bt) &&
            !/natx|national\s*express/i.test(String(bt.operator?.name || btOperatorNoc(bt) || ""))
          ) {
            const op = btOperatorNoc(bt);
            if (op && op !== "NATX") continue;
          }
          const lineT = compactQuery(bt.service?.line_name);
          if (lineB && lineT && lineB !== lineT) continue;
          const [tLng, tLat] = bt.coordinates || [];
          if (!Number.isFinite(tLat) || !Number.isFinite(tLng)) continue;
          const d = haversineMeters(bLat, bLng, tLat, tLng);
          if (d < nearD && d < nearLimit) {
            nearD = d;
            near = bt;
          }
        }
      }
      if (near) {
        best = near;
        bestScore = Math.max(bestScore, 18);
      }
    }
    // NATX BODS refs rarely include plates — if still unmatched, use the common
    // National Express white coach livery (bustimes id 643) via brand CSS / id.
    if ((!best || !paintScoreStrongEnough(bestScore)) && isNationalExpress(bods) && !hasNumericBustimesLivery(bods)) {
      let tripFromNear = null;
      let jnyFromNear = null;
      let btFromNear = null;
      const [bLng, bLat] = bods.coordinates || [];
      const lineB = compactQuery(bods.service?.line_name);
      if (Number.isFinite(bLat) && Number.isFinite(bLng)) {
        let nearD = Infinity;
        for (const bt of btList) {
          if (!bt?.trip_id) continue;
          if (
            !isNationalExpress(bt) &&
            !/natx|national\s*express/i.test(String(bt.operator?.name || bt.operator?.noc || ""))
          ) {
            continue;
          }
          const lineT = compactQuery(bt.service?.line_name);
          if (lineB && lineT && lineB !== lineT) continue;
          const [tLng, tLat] = bt.coordinates || [];
          if (!Number.isFinite(tLat) || !Number.isFinite(tLng)) continue;
          const d = haversineMeters(bLat, bLng, tLat, tLng);
          if (d < nearD && d < 12_000) {
            nearD = d;
            tripFromNear = bt.trip_id;
            jnyFromNear = bt.journey_id;
            btFromNear = bt.id;
          }
        }
      }
      return {
        ...bods,
        trip_id: bods.trip_id || tripFromNear || null,
        journey_id: bods.journey_id || jnyFromNear || null,
        btId: bods.btId || btFromNear || null,
        vehicle: {
          ...(bods.vehicle || {}),
          colour: bods.vehicle?.colour || "#ffffff",
          livery: 643,
        },
        paintSource: "bustimes",
      };
    }
    if (!best) return bods;
    // Weak matches: keep trip ids for History · Map, but do not overwrite local liveries.
    if (!paintScoreStrongEnough(bestScore)) {
      return {
        ...bods,
        trip_id: bods.trip_id || best.trip_id || null,
        journey_id: bods.journey_id || best.journey_id || null,
        btId: best.id ?? bods.btId,
      };
    }
    const liv = best.vehicle?.livery;
    if (liv == null && !best.vehicle?.colour) {
      return {
        ...bods,
        trip_id: bods.trip_id || best.trip_id || null,
        journey_id: bods.journey_id || best.journey_id || null,
        btId: best.id ?? bods.btId,
        paintSource: bods.paintSource || "bustimes",
      };
    }
    // White / silver AVL colours blank Staffs pins before livery CSS loads — keep the
    // local brand colour and still take the numeric livery id for ensureLiveries.
    const btColour = best.vehicle?.colour;
    const keepColour =
      !bodsIsCoach && isNearWhite(btColour) && !isNearWhite(bods.vehicle?.colour)
        ? bods.vehicle?.colour
        : btColour || bods.vehicle?.colour;
    return {
      ...bods,
      trip_id: bods.trip_id || best.trip_id || null,
      journey_id: bods.journey_id || best.journey_id || null,
      destination: bods.destination || best.destination || "",
      service: {
        ...(best.service || {}),
        ...(bods.service || {}),
        line_name: bods.service?.line_name || best.service?.line_name,
      },
      vehicle: {
        ...(bods.vehicle || {}),
        colour: keepColour,
        livery: liv ?? bods.vehicle?.livery,
        name: bods.vehicle?.name || best.vehicle?.name,
        reg: bods.vehicle?.reg || best.vehicle?.reg,
        id: bods.vehicle?.id || best.vehicle?.id,
      },
      paintSource: "bustimes",
      btId: best.id,
    };
  });
}

function liveryIdOf(busOrLivery) {
  if (busOrLivery == null || busOrLivery === "") return "";
  const liv =
    typeof busOrLivery === "object" && !busOrLivery.vehicle
      ? busOrLivery
      : busOrLivery?.vehicle?.livery ?? busOrLivery;
  if (liv == null || liv === "") return "";
  if (typeof liv === "object") return String(liv.id ?? "");
  return String(liv);
}

function getLivery(idOrBus) {
  if (idOrBus && typeof idOrBus === "object" && (idOrBus.vehicle || idOrBus.service || idOrBus._bods)) {
    return resolveBusLivery(idOrBus);
  }
  const key = liveryIdOf(idOrBus);
  if (!key) return null;
  return liveryById.get(key) || null;
}

const FLIX_GREEN = "#73d700";
const FLIX_LIVERY = {
  left_css: `linear-gradient(${FLIX_GREEN} 0 58%, #ff8500 58% 70%, ${FLIX_GREEN} 70%)`,
  stroke_colour: "#1a1a1a",
};

/** BODS/Ticketer AVL often uses underscores (Adderley_Green__First_Bus_Depot). */
function normalizeAvlText(value) {
  return String(value || "")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function avlToken(value) {
  return normalizeAvlText(value)
    .replace(/[-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDeadRunLine(line) {
  const t = avlToken(line);
  if (!t) return false;
  if (/^(dead\s*run|deadrun|oos|nis|n\/?s|not\s*in\s*service|out\s*of\s*service|positioning)$/i.test(t)) {
    return true;
  }
  return /\bdead\s*run\b/i.test(t);
}

function ticketMachineLooksOos(code) {
  const t = avlToken(code);
  if (!t) return false;
  if (/^dr$/i.test(t)) return true;
  return isDeadRunLine(t);
}

/** Ticketer dead run (line Dead_Run / TM code / dead-running destination). */
function isTicketerDeadRun(bus) {
  if (!bus) return false;
  if (bus.deadRun) return true;
  if (isDeadRunLine(bus.service?.line_name)) return true;
  if (ticketMachineLooksOos(bus._bods?.ticketMachineServiceCode)) return true;
  if (isDeadRunLine(bus._bods?.line) || isDeadRunLine(bus._bods?.lineRef)) return true;
  const dest = avlToken(bus.destination);
  return /\bdead\s*run(?:ning)?\b/i.test(dest);
}

/** Non-empty line that is not an explicit dead-run / OOS marker (e.g. 11B, 25, BS1). */
function isPassengerServiceLine(line) {
  const t = avlToken(line);
  if (!t || t === "?") return false;
  return !isDeadRunLine(t);
}

function isNisDestination(dest) {
  const t = avlToken(dest);
  if (!t) return false;
  return /^(not in service|nis|n\/?s|out of service|oos|positioning|dead running|dead run|empty to|to garage|to depot)$/i.test(t)
    || /\b(not in service|out of service|dead\s*run(?:ning)?|empty to)\b/i.test(t);
}

/**
 * Garage / depot / yard destination (trip purpose = to depot).
 * Does NOT match bare place names like "Adderley Green" on passenger routes.
 */
function isDepotRunDestination(dest) {
  const t = normalizeAvlText(dest);
  if (!t) return false;
  if (isNisDestination(t)) return true;
  return /^(garage|depot|to\s+(?:the\s+)?(?:garage|depot)|out\s*of\s*service|oos)$/i.test(t)
    || /\b(?:to\s+)?(?:the\s+)?(?:garage|depot)\b|\bout\s*of\s*service\b|\boos\b/i.test(t)
    || /\b(?:bus\s*)?(?:garage|depot|yard)\b/i.test(t)
    || /\bfirst\s*bus\s*depot\b/i.test(t);
}

/**
 * True depot OOS: dest says depot AND no active passenger service
 * (empty/dead line, or aimed arrival already well past).
 */
function isDepotOosForService(bus, { finishedTrip = false } = {}) {
  if (!isDepotRunDestination(bus?.destination)) return false;
  if (finishedTrip || bus?.tripFinished) return true;
  const line = bus?.service?.line_name || "";
  return !isPassengerServiceLine(line);
}

/** Ticketer (FPOT / DAGC) trip finished: last GPS ping is >10 min past DestinationAimedArrivalTime. */
function isTicketerFinishedTrip(bus, extra = {}) {
  if (!bus) return false;
  if (!(isFirstPotteriesBus(bus, extra) || isDgBus(bus, extra))) return false;
  if (bus.tripFinished) return true;
  const aimRaw = bus._bods?.destinationAimedArrival || bus.destinationAimedArrival || "";
  const aimMs = Date.parse(aimRaw);
  const recMs = Date.parse(bus.datetime || "");
  if (!Number.isFinite(aimMs) || !Number.isFinite(recMs)) return false;
  return recMs - aimMs > 10 * 60 * 1000;
}

/** @deprecated Prefer isTicketerFinishedTrip — kept as alias for FPOT call sites. */
function isFpotFinishedTrip(bus, extra = {}) {
  return isFirstPotteriesBus(bus, extra) && isTicketerFinishedTrip(bus, extra);
}

function operatorHaystack(bus, extra = {}) {
  return [
    bus?.operator,
    bus?.operator?.noc,
    bus?.operator?.id,
    bus?.operator?.name,
    bus?.operator?.slug,
    bus?._bods?.operator,
    bus?.service?.operator?.name,
    bus?.service?.operator?.noc,
    bus?.service?.url,
    bus?.vehicle?.operator?.name,
    bus?.vehicle?.operator?.noc,
    bus?.nisSource,
    extra?.operator,
    extra?.vehicle?.operator?.noc,
    extra?.vehicle?.operator?.name,
    extra?.btVehicle?.operator?.noc,
    extra?.btVehicle?.operator?.name,
  ]
    .filter(Boolean)
    .join(" ");
}

function isFirstPotteriesBus(bus, extra = {}) {
  return /FPOT|First Potteries|first-potteries/i.test(operatorHaystack(bus, extra));
}

function isDgBus(bus, extra = {}) {
  if (bus?.nisSource === "dg") return true;
  return /DAGC|D\s*&\s*G|D and G|d-g-coach|dgbus/i.test(operatorHaystack(bus, extra));
}

function isStantonsBus(bus, extra = {}) {
  return /SOST|Stanton'?s?\s+of\s+Stoke|stantons-of-stoke/i.test(
    operatorHaystack(bus, extra),
  );
}

function isScraggsBus(bus, extra = {}) {
  return /SCRT|Scragg'?s?|scraggs-taxis/i.test(operatorHaystack(bus, extra));
}

/** Matching Stoke-area depot for First / D&G / Stanton's / Scraggs (null for other operators). */
function ownStokeDepot(bus, extra = {}) {
  if (isFirstPotteriesBus(bus, extra)) {
    return BUS_DEPOTS.find((d) => d.id === "first-potteries-adderley-green") || null;
  }
  if (isDgBus(bus, extra)) {
    return BUS_DEPOTS.find((d) => d.id === "dg-mossfield") || null;
  }
  if (isStantonsBus(bus, extra)) {
    return BUS_DEPOTS.find((d) => d.id === "stantons-endon") || null;
  }
  if (isScraggsBus(bus, extra)) {
    return BUS_DEPOTS.find((d) => d.id === "scraggs-parkhall") || null;
  }
  return null;
}

/** True when the bus is near its depot and the AVL heading points toward it. */
function isHeadingToOwnDepot(bus, extra = {}) {
  const depot = ownStokeDepot(bus, extra);
  if (!depot) return false;
  const [lng, lat] = bus?.coordinates || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const dist = haversineMeters(lat, lng, depot.lat, depot.lng);
  if (dist <= 100) return true;
  if (dist > 4500) return false;
  const heading = Number(bus?.heading);
  if (!Number.isFinite(heading)) return dist < 350;
  const bearing = segmentBearing([lat, lng], [depot.lat, depot.lng]);
  if (angleDiff(heading, bearing) > 55) return false;
  const speed = Number(bus?.speedMph);
  if (dist > 280 && Number.isFinite(speed) && speed < 2.5) return false;
  return true;
}

/**
 * First / D&G / Stanton's / Scraggs deadhead to their yard.
 * Passenger services with a real line are never OOS just for proximity to the depot
 * (routes past Adderley Green / Mossfield / etc. stay in service).
 */
function isStokeDepotBound(bus, extra = {}) {
  if (!bus || !ownStokeDepot(bus, extra)) return false;
  const line = String(bus.service?.line_name || "").trim();
  const passenger = isPassengerServiceLine(line);
  const finished = isTicketerFinishedTrip(bus, extra);

  // Explicit depot/garage destination — only OOS when not an active passenger trip.
  if (isDepotRunDestination(bus.destination)) {
    return isDepotOosForService(bus, { finishedTrip: finished });
  }

  // Active passenger service: never flip to NIS from GPS proximity alone.
  if (passenger && !finished) return false;

  if (!line && isHeadingToOwnDepot(bus, extra)) return true;
  if (!isHeadingToOwnDepot(bus, extra)) return false;
  const depot = ownStokeDepot(bus, extra);
  const [lng, lat] = bus.coordinates || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const dist = haversineMeters(lat, lng, depot.lat, depot.lng);
  if (dist <= 750) return true;
  const dest = String(bus.destination || "").trim();
  if (!bus.trip_id && dist <= 2500) return true;
  if (!dest && dist <= 2500) return true;
  if (
    /adderley|mossfield|adelaide|park\s*farm|endon|parkhall|scragg/i.test(dest) &&
    dist <= 2500
  ) {
    return true;
  }
  return false;
}

function isNotInService(bus) {
  if (!bus) return false;
  const line = String(bus.service?.line_name || "").trim();
  const finished = Boolean(bus.tripFinished) || isTicketerFinishedTrip(bus);
  if (finished) return true;
  if (isTicketerDeadRun(bus) || isDeadRunLine(line)) return true;
  if (isNisDestination(bus.destination)) return true;
  if (!line || line === "?") return true;
  // Depot dest + passenger line only counts once finished (handled above) or if no line.
  if (isDepotOosForService(bus, { finishedTrip: finished })) return true;
  // Proximity to own yard — never for active passenger services past a depot.
  if (isStokeDepotBound(bus)) return true;
  // Do not trust a stale bus.nis / depotOos from BODS when the trip is still a
  // passenger service (e.g. 11B past the depot with an old nis bit).
  return false;
}

/** First Potteries / D&G dead runs / depot transfers / finished trips (Ticketer → BODS / bustimes). */
function isOperatorOutOfServiceBus(bus, extra = {}) {
  if (!bus) return false;
  if (!(isFirstPotteriesBus(bus, extra) || isDgBus(bus, extra))) return false;
  return isNotInService(bus);
}

function isFpotOutOfService(bus, extra = {}) {
  if (!bus || !isFirstPotteriesBus(bus, extra)) return false;
  return isNotInService(bus);
}

function isDgOutOfService(bus, extra = {}) {
  if (!bus || !isDgBus(bus, extra)) return false;
  return isNotInService(bus);
}

/**
 * Inject FPOT / DAGC OOS from BODS SIRI-VM (Ticketer AVL).
 * Bustimes often omits depot / DEAD_RUN pings that BODS still publishes.
 */
function mergeTicketerOosFromBods(byId, bodsVehicles) {
  if (!(byId instanceof Map) || !Array.isArray(bodsVehicles)) return;
  for (const bods of bodsVehicles) {
    if (!isOperatorOutOfServiceBus(bods)) continue;
    const finished = Boolean(bods.tripFinished || isTicketerFinishedTrip(bods));
    const deadRun = Boolean(bods.deadRun) || isTicketerDeadRun(bods);
    const tagged = {
      ...bods,
      nis: true,
      deadRun: deadRun || undefined,
      depotOos: Boolean(
        bods.depotOos ||
          isStokeDepotBound(bods) ||
          isDepotOosForService(bods, { finishedTrip: finished }),
      ),
      tripFinished: finished,
      nisSource: bods.nisSource || "bods-ticketer",
      destination: normalizeAvlText(bods.destination) || bods.destination || "",
      service: {
        ...(bods.service || {}),
        line_name: deadRun
          ? "DEAD_RUN"
          : bods.service?.line_name || "",
      },
    };
    let matchedId = null;
    for (const [id, existing] of byId) {
      if (busesAreSameVehicle(existing, tagged)) {
        matchedId = id;
        break;
      }
    }
    if (matchedId != null) {
      const existing = byId.get(matchedId);
      const existingAt = busFeedTime(existing);
      const taggedAt = busFeedTime(tagged);
      const taggedPositionNewer = !existingAt || (taggedAt && taggedAt >= existingAt);
      byId.set(matchedId, {
        ...existing,
        ...tagged,
        id: existing.id,
        vehicle: {
          ...(existing.vehicle || {}),
          ...(tagged.vehicle || {}),
          name: existing.vehicle?.name || tagged.vehicle?.name,
          reg: existing.vehicle?.reg || tagged.vehicle?.reg,
          colour: existing.vehicle?.colour || tagged.vehicle?.colour,
          livery: existing.vehicle?.livery ?? tagged.vehicle?.livery,
        },
        service: {
          ...(existing.service || {}),
          ...(tagged.service || {}),
          line_name: tagged.service?.line_name || existing.service?.line_name || "",
        },
        operator: existing.operator || tagged.operator,
        coordinates: taggedPositionNewer
          ? tagged.coordinates || existing.coordinates
          : existing.coordinates || tagged.coordinates,
        heading: taggedPositionNewer && Number.isFinite(tagged.heading)
          ? tagged.heading
          : existing.heading ?? tagged.heading,
        datetime: taggedPositionNewer
          ? tagged.datetime || existing.datetime
          : existing.datetime || tagged.datetime,
        destination: taggedPositionNewer
          ? tagged.destination || existing.destination
          : existing.destination || tagged.destination,
        nis: true,
        deadRun: tagged.deadRun || existing.deadRun,
        depotOos: tagged.depotOos,
        nisSource: tagged.nisSource,
        trackSource: "bods",
        source: "bods",
        _bods: tagged._bods || existing._bods,
      });
    } else {
      byId.set(tagged.id, tagged);
    }
  }
}

/** @deprecated Prefer mergeTicketerOosFromBods */
function mergeFpotOosFromBods(byId, bodsVehicles) {
  mergeTicketerOosFromBods(byId, bodsVehicles);
}

function dgIsNotInService(item) {
  if (!item) return true;
  if (item.inService === false) return true;
  const line = staffLineName(item);
  if (!item.currentJourney || !line) return true;
  const dest =
    item.currentJourney.destination?.name ||
    item.currentJourney.destinationRef ||
    "";
  return isNisDestination(dest) || isDepotRunDestination(dest);
}

function nisStatus(bus) {
  const dest = String(bus.destination || "").trim();
  const moving = Number.isFinite(bus.speedMph) && bus.speedMph >= 3;
  const finished = Boolean(bus.tripFinished) || isTicketerFinishedTrip(bus);
  const depotBound =
    bus.depotOos ||
    isStokeDepotBound(bus) ||
    isDepotOosForService(bus, { finishedTrip: finished });
  if (depotBound) {
    return moving ? "Out of service — heading to depot" : "Out of service at depot";
  }
  if (isTicketerDeadRun(bus)) {
    return "Dead run";
  }
  if (/position|empty to|to start/i.test(dest)) {
    return "Heading to start the next trip";
  }
  if (finished) {
    return moving ? "Finished — positioning" : "Finished / not in service";
  }
  if (moving) return "Off route — positioning / heading to start";
  return "Finished / not in service";
}

function isFlixBus(bus) {
  if (!bus) return false;
  const name = String(bus?.vehicle?.name || "");
  const colour = String(bus?.vehicle?.colour || "").toLowerCase();
  const url = String(bus?.vehicle?.url || bus?.service?.url || "");
  const op = String(bus?.operator?.id || bus?.operator?.noc || bus?.operator || "");
  const source = String(bus?._source || bus?.source || "");
  return (
    bus?.vehicle?.livery === 1046 ||
    colour === FLIX_GREEN.toLowerCase() ||
    colour === "#73d700" ||
    /flixbus/i.test(name) ||
    /flixbus/i.test(url) ||
    /^flix$/i.test(op) ||
    String(op).toUpperCase() === "FLIX" ||
    source === "bustimes-flix"
  );
}

async function fetchFlixBuses(signal) {
  try {
    const res = await fetch("/api/vehicles?operator=FLIX", { signal });
    if (!res.ok) return [];
    const data = await res.json();
    const rows = Array.isArray(data) ? data : [];
    // Tag so paint/history treat them as Flix even if upstream omits operator.noc.
    return rows
      .map((bus) => ({
        ...bus,
        _source: bus._source || "bustimes-flix",
        operator: {
          ...(bus.operator && typeof bus.operator === "object" ? bus.operator : {}),
          noc: "FLIX",
          id: bus.operator?.id || "FLIX",
          name: bus.operator?.name || "FlixBus",
          slug: bus.operator?.slug || "flixbus",
        },
      }))
      .filter(isFlixBus);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return [];
  }
}

function isNationalExpress(bus) {
  if (!bus) return false;
  const op = String(bus?.operator?.id || bus?.operator?.noc || "").toUpperCase();
  if (op === "NATX") return true;
  const name = String(bus?.operator?.name || bus?.vehicle?.name || "");
  const url = String(bus?.service?.url || bus?.vehicle?.url || "");
  return /national\s*express/i.test(name) || /national-express/i.test(url);
}

function trailOperatorForBus(bus) {
  if (!bus) return "";
  if (isFlixBus(bus)) return "FLIX";
  if (isNationalExpress(bus)) return "NATX";
  return String(bus?.operator?.noc || bus?.operator?.id || "")
    .trim()
    .toUpperCase()
    .slice(0, 16);
}

/** Cities from Flix service slug, e.g. 700-paris-london → Paris → London */
function flixRouteTitle(bus) {
  const url = String(bus?.service?.url || "");
  const slug = url.split("/").filter(Boolean).pop() || "";
  const raw = slug
    .replace(/^(uk|n)?\d+[a-z]*-/i, "")
    .replace(/^[a-z]*\d+-?/i, "");
  const bits = raw
    .split("-")
    .map((part) => part.trim())
    .filter((part) => part && !/^\d+$/.test(part) && !/^(uk|n)$/i.test(part));
  if (bits.length < 2) return "";
  const pretty = bits.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
  // Collapse victoria/belgravia noise in titles a bit
  return pretty.join(" → ");
}

function isInternationalFlix(bus) {
  const text = `${bus?.destination || ""} ${bus?.service?.url || ""} ${flixRouteTitle(bus)}`.toLowerCase();
  return /paris|amsterdam|brussels|dublin|berlin|calais|lille|rotterdam|cologne|france|germany|belgium|netherland|spain|italy|prague|vienna|warsaw|budapest|zurich|milan|lyon|munich|dortmund|frankfurt|hamburg|dusseldorf|antwerp|bruges/.test(
    text,
  );
}

async function fetchNatxBuses(signal) {
  try {
    const res = await fetch("/api/vehicles?operator=NATX", { signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data.filter(isNationalExpress) : [];
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return [];
  }
}

function formatSpeed(mph) {
  if (!Number.isFinite(mph)) return "Speed unknown";
  if (mph < 1.5) return "Stopped";
  return `${Math.round(mph)} mph`;
}

/** UK-style circular speed-limit roundel (red ring, white face, black number). */
function speedLimitBadgeHtml(limitMph) {
  if (!Number.isFinite(limitMph)) return "";
  const n = Math.round(limitMph);
  return `<span class="speed-limit-badge" title="Speed limit ${n} mph" aria-label="Speed limit ${n} mph"><span class="speed-limit-badge-num">${esc(String(n))}</span></span>`;
}

function formatSpeedLine(speedMph, limitMph) {
  const speed = formatSpeed(speedMph);
  if (!Number.isFinite(limitMph)) return speed;
  return `${speed} · limit ${Math.round(limitMph)}`;
}

/** Live card line: speed text + roundel + age (HTML). */
function formatSpeedLiveHtml(speedMph, limitMph, ageText = "") {
  const over =
    Number.isFinite(speedMph) && Number.isFinite(limitMph) && speedMph > limitMph + 2.5;
  const badge = speedLimitBadgeHtml(limitMph);
  const bits = [`<span class="popup-speed-text">${esc(formatSpeed(speedMph))}</span>`];
  if (badge) bits.push(badge);
  if (ageText) bits.push(`<span class="popup-speed-age">${esc(ageText)}</span>`);
  return `<span class="popup-speed-live${over ? " is-over" : ""}">${bits.join('<span class="popup-speed-sep"> · </span>')}</span>`;
}

function speedBlock(speedMph, limitMph) {
  const over =
    Number.isFinite(speedMph) && Number.isFinite(limitMph) && speedMph > limitMph + 2.5;
  const badge = speedLimitBadgeHtml(limitMph);
  return `<div class="popup-speed${over ? " is-over" : ""}"><span class="popup-speed-text">${esc(formatSpeed(speedMph))}</span>${badge ? `<span class="popup-speed-sep"> · </span>${badge}` : ""}</div>`;
}

function asCount(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n);
  if (v < min || v > max) return null;
  return v;
}

function typicalSeatCount(bus = {}, extra = {}) {
  const type = extra.vehicle?.vehicle_type || {};
  const name = `${type.name || ""} ${type.style || ""} ${bus.vehicle?.features || ""} ${extra.dgVehicle?.size || ""}`.toLowerCase();
  if (type.coach || /\bcoach\b/.test(name)) return 49;
  if (type.double_decker || /double/.test(name)) {
    if (/routemaster|new rm/.test(name)) return 62;
    return 80;
  }
  if (/versa|solo/.test(name)) return 37;
  if (/enviro200|dart|streetlite|pointer/.test(name)) return 41;
  return 41;
}

function occupancyFromSources(bus = {}, extra = {}) {
  // D&G / AT employee buses do not publish live seat counts — hide guessed capacity.
  if (isDgBus(bus, extra)) return null;
  if (
    isAltonLine(
      extra.line || bus?.service?.line_name || bus?.line || bus?.currentJourney?.publishedLineName,
    )
  ) {
    return null;
  }

  const first = extra.firstOccupancy;
  if (first && (first.remaining != null || first.occupied != null)) {
    const seats = first.seats ?? typicalSeatCount(bus, extra);
    if (seats == null && first.remaining == null) return null;
    return {
      seats,
      remaining:
        first.remaining != null
          ? first.remaining
          : seats != null && first.occupied != null
            ? Math.max(0, seats - first.occupied)
            : null,
      occupied: first.occupied,
      typical: first.seats == null,
      wheelchair: first.wheelchair,
      wheelchairLeft: first.wheelchairLeft,
      priority: first.priority,
      source: "First Bus",
    };
  }
  const dg = extra.dgVehicle || extra.vehicle;
  const occ = extra.occupancy || bus.occupancy || dg?.occupancy || extra.vehicle?.occupancy || {};
  const cap = dg?.capacity || extra.vehicle?.capacity || bus.capacity || {};
  const type = extra.vehicle?.vehicle_type || {};
  const name = `${type.name || ""} ${type.style || ""} ${bus.vehicle?.features || ""} ${dg?.size || ""}`.toLowerCase();
  const double = Boolean(type.double_decker || /double/.test(name));
  const exactSeats =
    asCount(cap.seats, 8, 120) ||
    asCount(cap.total, 8, 120) ||
    asCount(occ.seatedCapacity, 8, 120) ||
    asCount(bus.seats, 8, 120);
  const typical = exactSeats == null;
  const seats = exactSeats ?? typicalSeatCount(bus, extra);
  if (seats == null) return null;

  const status = String(occ.status || occ.occupancyStatus || bus.occupancy_status || "").toLowerCase();
  const reported = status && status !== "notavailable" && status !== "unknown" && status !== "no data";
  const passengers =
    asCount(occ.numberOfPassengers ?? occ.passengerCount ?? occ.passengers ?? occ.occupiedSeats, 0, seats);
  const pct = Number(cap.fillUpPercentage ?? occ.fillUpPercentage ?? occ.percentage);
  let remaining = null;
  if (passengers != null) remaining = Math.max(0, seats - passengers);
  else if (reported && Number.isFinite(pct) && pct >= 0 && pct <= 100) {
    remaining = Math.max(0, seats - Math.round((seats * pct) / 100));
  }
  const band = normaliseOccupancyBand(
    extra.bodsOccupancy || bus.bodsOccupancy || occ.occupancy || occ.status,
  );
  if (remaining == null && (band === "full" || band === "standing")) remaining = 0;

  // Allow typical seat capacity even without live telemetry

  const wheelchair =
    asCount(occ.wheelchairCapacity ?? dg?.accessibility?.wheelchairCapacity ?? cap.wheelchairCapacity, 0, 6) ??
    (type.name || bus.vehicle?.features || dg?.size ? 1 : null);
  const priority =
    asCount(cap.prioritySeats ?? occ.prioritySeats ?? cap.firstSeats, 1, 12) ??
    (seats ? (double ? 6 : 4) : null);

  return {
    seats,
    remaining,
    typical,
    wheelchair,
    priority,
    band,
    source: extra.bodsOccupancy || bus.bodsOccupancy ? "BODS" : undefined,
  };
}

function seatsBlock(bus, extra = {}) {
  const info = extra.seatsInfo || occupancyFromSources(bus, extra) || {
    seats: 41,
    remaining: null,
    typical: true,
    wheelchair: 1,
    priority: 4,
    band: "seats",
  };
  let leftLabel = "seats available";
  let cls = "is-ok";
  if (info.band === "standing") {
    leftLabel = "standing room only";
    cls = "is-full";
  } else if (info.remaining != null) {
    leftLabel = `${info.remaining} left`;
    cls = info.remaining <= 8 ? "is-low" : "is-ok";
  }
  if (leftLabel === "seats available") return ""; // no real reading — don't show a guess
  // Live wheelchair-space count — only First Bus publishes a real reading.
  const wheelFree =
    info.source === "First Bus" &&
    info.wheelchairLeft != null &&
    Number.isFinite(Number(info.wheelchairLeft))
      ? Math.round(Number(info.wheelchairLeft))
      : null;
  const wheelTotal =
    info.wheelchair != null && Number.isFinite(Number(info.wheelchair))
      ? Math.round(Number(info.wheelchair))
      : null;
  const wheel =
    wheelFree != null
      ? ` · ♿ ${wheelTotal != null ? `${wheelFree}/${wheelTotal}` : wheelFree} free`
      : "";
  return `
    <div class="popup-seats ${cls}">
      <div class="popup-seats-main">${esc(`${leftLabel}${wheel}`)}</div>
    </div>
  `;
}

function isFirstBus(bus, extra = {}) {
  const name = `${operatorName(bus, extra)} ${extra.vehicle?.operator?.name || extra.operator || ""}`;
  if (/\bflix/i.test(name)) return false;
  return /\bfirst\b/i.test(name);
}

function parseFirstOccupancy(row) {
  if (!row || typeof row !== "object") return null;
  const types =
    row.occupancy?.types ||
    row.Occupancy?.types ||
    row.status?.occupancy?.types ||
    [];
  const list = Array.isArray(types) ? types : [];
  if (!list.length) return null;
  const seated = list.find((item) => /seat/i.test(item?.name || "")) || {};
  const wheel = list.find((item) => /wheel/i.test(item?.name || "")) || {};
  const seats =
    asCount(seated.capacity, 8, 120) ||
    asCount(row.SeatsCapacity ?? row.seatCapacity ?? row.capacity, 8, 120);
  // occupied can be 0 — treat as a real reading.
  const occupiedRaw = seated.occupied ?? row.OccupiedSeats ?? row.occupied;
  const occupied =
    occupiedRaw === 0 || occupiedRaw === "0"
      ? 0
      : asCount(occupiedRaw, 0, 120);
  const seatsLeft = asCount(
    row.SeatsAvailable ?? row.availableSeats ?? row.EmptySeats ?? row.seatsAvailable,
    0,
    120,
  );
  const remaining =
    seatsLeft != null
      ? seatsLeft
      : seats != null && occupied != null
        ? Math.max(0, seats - occupied)
        : null;
  // Need a live remaining/occupied reading — capacity alone is not enough.
  if (remaining == null && occupied == null) return null;
  if (seats == null && remaining == null) return null;
  const wheelchair = asCount(wheel.capacity ?? row.WheelchairCapacity ?? row.wheelchairCapacity, 0, 6);
  const wheelOccRaw = wheel.occupied;
  const wheelOcc =
    wheelOccRaw === 0 || wheelOccRaw === "0" ? 0 : asCount(wheelOccRaw, 0, 6);
  const wheelchairLeft =
    asCount(row.WheelchairSpaces ?? row.availableWheelchairs ?? row.wheelchairSpaces, 0, 6) ??
    (wheelchair != null && wheelOcc != null ? Math.max(0, wheelchair - wheelOcc) : null);
  return {
    seats: seats ?? (remaining != null && occupied != null ? remaining + occupied : null),
    remaining: remaining ?? (seats != null && occupied != null ? Math.max(0, seats - occupied) : null),
    occupied,
    wheelchair,
    wheelchairLeft,
  };
}

async function fetchFirstStopTimes(atco) {
  if (!atco) return null;
  const hit = firstStopCache.get(atco);
  if (hit && Date.now() - hit.at < 20000) return hit.data;
  try {
    // Server-side cached gateway call — includes live seat / wheelchair counts (?live=true).
    const res = await fetch(`/api/first-stop-times?stop=${encodeURIComponent(atco)}`);
    const data = res.ok ? await res.json() : null;
    firstStopCache.set(atco, { at: Date.now(), data });
    if (firstStopCache.size > 80) firstStopCache.delete(firstStopCache.keys().next().value);
    return data;
  } catch {
    return null;
  }
}

// Bustimes trip times are bare "HH:MM" wall clocks in Europe/London (proven: a bus sitting at
// its 17:10-timed stop while the true instant was 16:10Z), while First's board publishes true
// UTC ("…T16:10:00Z"). Binding needs both on one axis.
const LONDON_CLOCK_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function londonWallParts(ms) {
  const out = {};
  for (const p of LONDON_CLOCK_FMT.formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

function londonOffsetMinutes(ms) {
  const w = londonWallParts(ms);
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((wall - ms) / 60000);
}

/** "17:10" (London local) or an ISO instant → epoch ms of that moment (DST-safe). */
function tripAimedMs(aimed, refMs = Date.now()) {
  const s = String(aimed || "").trim();
  if (!s) return NaN;
  if (s.includes("T")) return Date.parse(s);
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return NaN;
  const p = londonWallParts(refMs);
  const guess = Date.UTC(p.year, p.month - 1, p.day, Number(m[1]), Number(m[2]));
  // Two passes settle the instant if the first guess straddles a DST change.
  const utc1 = guess - londonOffsetMinutes(guess) * 60000;
  return guess - londonOffsetMinutes(utc1) * 60000;
}

function matchFirstDeparture(data, bus, stopIso = "") {
  const times = data?.times || data?.departures || [];
  const rows = Array.isArray(times)
    ? times
    : Array.isArray(times?.all)
      ? times.all
      : Object.values(times || {}).flat?.() || [];
  const line = String(bus.service?.line_name || "").toUpperCase();
  const dest = compactQuery(bus.destination || "");
  const matches = rows.filter((row) => {
    const svc = String(row.ServiceNumber || row.line_name || row.line || "").toUpperCase();
    return svc && svc === line;
  });
  const firstOnly = matches.filter((row) => {
    const op = String(row.operator || row.operator_name || "");
    if (/FPOT|First/i.test(op)) return true;
    return !/^[nN]$/.test(String(row.IsFG ?? row.is_fg ?? "Y"));
  });
  const pool = firstOnly.length ? firstOnly : matches;
  if (!pool.length) return null;
  const destMatch = (row) =>
    !dest || compactQuery(row.Destination || row.direction || "").includes(dest.slice(0, 6));

  // Pin the row to THIS trip: the row whose scheduled time matches this stop's own
  // timetable time. Without this, a fuller/later bus on the same line could be shown.
  const t0 = tripAimedMs(stopIso);
  if (Number.isFinite(t0)) {
    const near = [];
    for (const row of pool) {
      const t = Date.parse(row.scheduledTime || row["departure-time"] || "");
      if (!Number.isFinite(t)) continue;
      const d = Math.abs(t - t0);
      if (d <= 20 * 60_000) near.push({ row, d });
    }
    // This trip isn't on this stop's board (already departed / row dropped) — don't guess.
    if (!near.length) return null;
    near.sort((a, b) => a.d - b.d);
    return (near.find((x) => destMatch(x.row)) || near[0]).row;
  }

  // No trip time available — best effort, but never borrow another direction's counts.
  const destPool = pool.filter(destMatch);
  if (!destPool.length) return null;
  const withOcc = destPool.filter((row) => parseFirstOccupancy(row));
  return withOcc[0] || destPool.find((row) => parseFirstOccupancy(row)) || destPool[0];
}

async function fetchFirstStreamOccupancy(bus, extra = {}, lat = null, lng = null) {
  if (!(isFirstPotteriesBus(bus, extra) || isFirstBus(bus, extra))) return null;
  const params = new URLSearchParams();
  const line = String(bus.service?.line_name || extra.line || "").trim();
  if (line) params.set("line", line);
  const destination = String(extra.to || bus.destination || "").trim();
  if (destination) params.set("destination", destination);
  const direction = String(extra.direction || bus.direction || "").trim();
  if (direction) params.set("direction", direction);
  const vehicle = String(
    extra.vehicle?.reg || extra.btVehicle?.reg || bus.vehicle?.reg || bus.vehicle?.name || "",
  ).trim();
  if (vehicle) params.set("vehicle", vehicle);
  if (Number.isFinite(lat)) params.set("lat", String(Number(lat)));
  if (Number.isFinite(lng)) params.set("lng", String(Number(lng)));
  try {
    const res = await fetch(`/api/first-occupancy?${params}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return parseFirstOccupancy(data);
  } catch {
    return null;
  }
}

async function firstOccupancyFor(bus, extra = {}, lat, lng) {
  if (!(isFirstPotteriesBus(bus, extra) || isFirstBus(bus, extra))) return null;
  // The continuous First vehicle stream is the fast path: it already contains
  // this bus's live seat/wheelchair counts before a stop board is queried.
  const streamOccupancy = await fetchFirstStreamOccupancy(bus, extra, lat, lng);
  if (streamOccupancy) return streamOccupancy;
  // Fallback to the exact departure-board row when the stream has not seen this
  // vehicle yet. Unserved stops still carry this trip's row; each is pinned to
  // its own aimed time in matchFirstDeparture.
  const upcoming = upcomingStops(extra.stops || [], lat, lng);
  const list = (upcoming.length ? upcoming : extra.stops || []).filter(
    (stop) => stop?.atco && !stop.done,
  );
  const seen = new Set();
  for (const stop of list) {
    if (seen.has(stop.atco)) continue;
    seen.add(stop.atco);
    if (seen.size > 8) break;
    const data = await fetchFirstStopTimes(stop.atco);
    const occ = parseFirstOccupancy(matchFirstDeparture(data, bus, stop.aimedIso));
    if (occ) return occ;
  }
  return null;
}

const FIRST_OCCUPANCY_REFRESH_MS = 60_000;
const FIRST_OCCUPANCY_RETRY_MS = 900;

/** Re-fetch live seats for an open First Bus card and repaint when the numbers change. */
async function refreshFirstOccupancy(marker, gen) {
  if (!marker?.bus) return null;
  marker.extra ||= {};
  const ll = marker.getLatLng?.() || {};
  const occ = await firstOccupancyFor(marker.bus, marker.extra, ll.lat, ll.lng);
  if ((marker._enrichGen || 0) !== gen) return null; // card re-selected mid-fetch
  const prev = marker.extra.firstOccupancy || null;
  // Keep the last good app reading through a transient stream/board miss.
  const value = occ || prev;
  const same =
    (prev?.seats ?? null) === (value?.seats ?? null) &&
    (prev?.remaining ?? null) === (value?.remaining ?? null) &&
    (prev?.occupied ?? null) === (value?.occupied ?? null) &&
    (prev?.wheelchairLeft ?? null) === (value?.wheelchairLeft ?? null);
  if (value) marker.extra.firstOccupancy = value;
  if (!same) refreshPopup(marker, { force: true }); // seats sit outside the structure key
  return value || null;
}

/** Called from refreshPopup — polls First seats at most once a minute while the card is open,
 *  but loads immediately the first time a bus is selected (no prior data yet). */
function refreshFirstOccupancyIfDue(marker) {
  const bus = marker?.bus;
  if (!bus) return;
  if (!(isFirstPotteriesBus(bus, marker.extra) || isFirstBus(bus, marker.extra))) return;
  if (!(selectedMapMarker === marker || marker.isPopupOpen?.())) return;
  const now = Date.now();
  // Load immediately when there is no prior occupancy data (first click).
  const hasPriorData = marker.extra?.firstOccupancy != null;
  if (hasPriorData && marker._occAt && now - marker._occAt < FIRST_OCCUPANCY_REFRESH_MS) return;
  if (!hasPriorData && marker._occRetryAt && now < marker._occRetryAt) return;
  if (marker._occBusy) return;
  marker._occBusy = true;
  const gen = marker._enrichGen || 0;
  refreshFirstOccupancy(marker, gen)
    .then((value) => {
      if (value) {
        marker._occAt = Date.now();
        marker._occAttempts = 0;
        marker._occRetryAt = 0;
        return;
      }
      // The websocket may still be connecting on the first card view. Retry
      // briefly so the seat block appears without waiting for the next poll.
      if (hasPriorData) {
        marker._occAt = Date.now();
        return;
      }
      marker._occAttempts = (marker._occAttempts || 0) + 1;
      const delay = marker._occAttempts < 3 ? FIRST_OCCUPANCY_RETRY_MS : 10_000;
      marker._occRetryAt = Date.now() + delay;
      if (!marker._occRetry) {
        marker._occRetry = setTimeout(() => {
          marker._occRetry = null;
          marker._occRetryAt = 0;
          refreshFirstOccupancyIfDue(marker);
        }, delay);
      }
    })
    .catch(() => {
      marker._occRetryAt = Date.now() + FIRST_OCCUPANCY_RETRY_MS;
    })
    .finally(() => {
      marker._occBusy = false;
    });
}

function normaliseOccupancyBand(value) {
  const s = String(value || "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  if (s === "full" || s === "crushedstanding") return "full";
  if (s === "standingavailable" || s === "standingroomonly") return "standing";
  if (s === "fewseatsavailable") return "few";
  if (s === "seatsavailable" || s === "manyseatsavailable" || s === "notcrowded") return "seats";
  return "";
}

async function fetchBodsOccupancy(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const pad = 0.025;
  const bbox = `${(lng - pad).toFixed(4)},${(lat - pad).toFixed(4)},${(lng + pad).toFixed(4)},${(lat + pad).toFixed(4)}`;
  if (bodsCache.key === bbox && Date.now() - bodsCache.at < 25000) return bodsCache.items;
  try {
    const res = await fetch(`/api/bods-occupancy?bbox=${encodeURIComponent(bbox)}`);
    const data = res.ok ? await res.json() : { items: [] };
    bodsCache.key = bbox;
    bodsCache.at = Date.now();
    bodsCache.items = Array.isArray(data.items) ? data.items : [];
    return bodsCache.items;
  } catch {
    return [];
  }
}

function identityTokens(...values) {
  const tokens = new Set();
  for (const value of values) {
    if (value == null || value === "") continue;
    const text = String(value);
    if (/https?:|bustimes\.org|\/vehicles\//i.test(text)) continue;
    const plate = compactReg(text);
    if (/^[A-Z]{1,2}\d{1,2}[A-Z]{3}$/.test(plate)) tokens.add(plate);
    // Bustimes often embeds plates in names like "67151 - YX66 WFJ".
    for (const hit of text.toUpperCase().match(/[A-Z]{1,2}\s*\d{1,2}\s*[A-Z]{3}/g) || []) {
      const p = compactReg(hit);
      if (/^[A-Z]{1,2}\d{1,2}[A-Z]{3}$/.test(p)) tokens.add(p);
    }
    // Fleet codes: "DAGC-102", "102 - YJ13 HNB", bare "102".
    const nocFleet = text.toUpperCase().match(/\b([A-Z]{2,5})[-_](\d{2,5})\b/);
    if (nocFleet) {
      tokens.add(nocFleet[2]);
      tokens.add(`${nocFleet[1]}${nocFleet[2]}`);
    }
    const leadFleet = text.match(/^\s*(\d{2,5})\s*[-–—]/);
    if (leadFleet) tokens.add(leadFleet[1]);
    const compact = compactQuery(text);
    if (/^\d{2,7}$/.test(compact)) tokens.add(compact);
    for (const num of compact.match(/\d{4,7}/g) || []) tokens.add(num);
  }
  tokens.delete("");
  return tokens;
}

function busIdentityTokens(bus = {}, extra = {}) {
  return identityTokens(
    extra.vehicle?.fleet_code,
    extra.vehicle?.fleet_number,
    extra.vehicle?.name,
    extra.vehicle?.reg,
    bus.vehicle?.name,
    bus.vehicle?.reg,
    bus.vehicle?.fleet_code,
    bus.vehicle?.fleet_number,
  );
}

/** Bustimes vehicles.json often omits `operator` — recover NOC from /vehicles/{noc}-… URLs. */
function btOperatorNoc(bt) {
  const direct = String(
    bt?.operator?.noc || bt?.operator?.id || bt?.service?.operator?.noc || bt?.operator || "",
  )
    .trim()
    .toUpperCase();
  if (direct && direct !== "[OBJECT OBJECT]") return direct;
  const url = String(bt?.vehicle?.url || bt?.url || "");
  const m = url.match(/\/vehicles\/([a-z0-9]+)-/i);
  return m ? m[1].toUpperCase() : "";
}

function bodsIdentityTokens(item = {}) {
  return identityTokens(item.vehicleRef);
}

function tokensOverlap(a, b) {
  if (!a?.size || !b?.size) return false;
  for (const token of a) {
    // Plates / long fleet codes (YX66WFJ, 67151, DAGC102).
    if (token.length >= 4 && b.has(token)) return true;
  }
  // Short D&G-style fleet numbers (30, 102) shared on both sides.
  for (const token of a) {
    if (/^\d{2,3}$/.test(token) && b.has(token)) return true;
  }
  return false;
}

function bodsMatchScore(bus, extra, item, lat, lng) {
  if (!item) return 0;
  const line = compactQuery(bus.service?.line_name);
  const op = compactQuery(
    extra?.vehicle?.operator?.noc || extra?.vehicle?.operator?.id || extra?.operator || bus.operator,
  );
  let score = 0;
  if (tokensOverlap(busIdentityTokens(bus, extra), bodsIdentityTokens(item))) score += 28;
  if (line && compactQuery(item.line) === line) score += 6;
  if (op && compactQuery(item.operator) === op) score += 5;
  if (Number.isFinite(lat) && Number.isFinite(item.lat) && Number.isFinite(item.lng)) {
    const d = haversineMeters(lat, lng, item.lat, item.lng);
    if (d < 90) score += 12;
    else if (d < 180) score += 7;
    else if (d < 400) score += 3;
    else if (score < 20) return 0;
  }
  return score;
}

function matchBodsOccupancy(bus, extra, items, lat, lng) {
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    if (!item?.occupancy) continue;
    const score = bodsMatchScore(bus, extra, item, lat, lng);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 10 ? best : null;
}

async function bodsOccupancyFor(bus, extra, lat, lng) {
  const items = await fetchBodsOccupancy(lat, lng);
  return matchBodsOccupancy(bus, extra, items, lat, lng)?.occupancy || null;
}

async function fetchBodsVehicles(params, signal) {
  try {
    const res = await fetch(`/api/bods-vehicles?${params}`, { signal });
    if (!res.ok) return { vehicles: [], ok: false };
    const data = await res.json();
    if (data?.error === "missing_key" || data?.error === "bad_bbox") {
      return { vehicles: [], ok: false };
    }
    return {
      vehicles: Array.isArray(data.vehicles) ? data.vehicles : [],
      ok: true,
    };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { vehicles: [], ok: false };
  }
}

function liveBusMatchScore(bods, bt) {
  if (!bods || !bt) return 0;
  const [bLng, bLat] = bods.coordinates || [];
  const [tLng, tLat] = bt.coordinates || [];
  const lineB = compactQuery(bods.service?.line_name);
  const lineT = compactQuery(bt.service?.line_name);
  const opB = compactQuery(bods._bods?.operator || bods.operator?.noc || bods.operator);
  const opT = compactQuery(btOperatorNoc(bt));
  const bodsTokens = identityTokens(
    bods._bods?.vehicleRef,
    bods.vehicle?.name,
    bods.vehicle?.reg,
    bods.vehicle?.fleet_code,
  );
  const btTokens = busIdentityTokens(bt);
  const sameVehicle = tokensOverlap(bodsTokens, btTokens);
  // Different operators only when we are sure it is not the same plate/fleet.
  if (opB && opT && opB !== opT && !sameVehicle) return 0;
  let score = 0;
  if (sameVehicle) score += 50;
  if (lineB && lineT && lineB === lineT) score += 10;
  if (opB && opT && opB === opT) score += 8;
  if (
    Number.isFinite(bLat) &&
    Number.isFinite(bLng) &&
    Number.isFinite(tLat) &&
    Number.isFinite(tLng)
  ) {
    const d = haversineMeters(bLat, bLng, tLat, tLng);
    if (d < 80) score += 16;
    else if (d < 180) score += 10;
    else if (d < 400) score += 5;
    else if (d < 900 && score >= 18) score += 2;
  }
  return score;
}

function busesAreSameVehicle(a, b) {
  if (!a || !b || a === b) return false;
  if (a.id != null && b.id != null && String(a.id) === String(b.id)) return true;
  const tokensA = identityTokens(
    a._bods?.vehicleRef,
    a.vehicle?.name,
    a.vehicle?.reg,
    a.vehicle?.fleet_code,
  );
  const tokensB = identityTokens(
    b._bods?.vehicleRef,
    b.vehicle?.name,
    b.vehicle?.reg,
    b.vehicle?.fleet_code,
  );
  if (tokensOverlap(tokensA, tokensB)) return true;
  const [aLng, aLat] = a.coordinates || [];
  const [bLng, bLat] = b.coordinates || [];
  if (![aLat, aLng, bLat, bLng].every(Number.isFinite)) return false;
  const d = haversineMeters(aLat, aLng, bLat, bLng);
  const lineA = compactQuery(a.service?.line_name);
  const lineB = compactQuery(b.service?.line_name);
  if (d < 45) return true;
  if (d < 140 && lineA && lineB && lineA === lineB) return true;
  return false;
}

/**
 * Primary: BODS SIRI-VM live positions.
 * Secondary: bustimes — enrich matched buses (livery/trip) and fill gaps when BODS is empty/down.
 */
function enrichBodsFromBustimes(bods, bt) {
  if (!bods || !bt) return bods;
  // Do not use Number(null) — that becomes 0 and falsely marks every bus Stopped.
  const feedSpeed = readProvidedSpeedMph(
    bods.feedSpeedMph,
    bods.speedMph,
    bods._bods?.velocityMph,
  );
  return {
    ...bt,
    id: bt.id,
    coordinates: bods.coordinates,
    heading: Number.isFinite(bods.heading) ? bods.heading : bt.heading,
    datetime: bods.datetime || bt.datetime,
    delay: bods.delay ?? bt.delay,
    destination: bt.destination || bods.destination,
    origin: bt.origin || bods.origin,
    speedMph: feedSpeed ?? undefined,
    feedSpeedMph: feedSpeed ?? undefined,
    service: {
      ...(bt.service || {}),
      line_name: bt.service?.line_name || bods.service?.line_name,
      operator: bt.service?.operator || bods.service?.operator,
    },
    vehicle: {
      ...(bt.vehicle || {}),
      name: bt.vehicle?.name || bods.vehicle?.name,
      colour: bt.vehicle?.colour || bods.vehicle?.colour || "#2563eb",
      livery: bt.vehicle?.livery ?? bods.vehicle?.livery,
    },
    source: "bods",
    trackSource: "bods",
    metaSource: "bustimes",
    btId: bt.id,
    _bods: bods._bods,
  };
}

function mergeBodsWithBustimes(bodsBuses, btBuses, { bodsOk = false } = {}) {
  const bodsList = Array.isArray(bodsBuses) ? bodsBuses : [];
  const btList = Array.isArray(btBuses) ? btBuses : [];
  const usedBt = new Set();
  const out = [];
  const bodsPrimary = bodsOk && bodsList.length > 0;

  // 1) Main tracking layer — every BODS vehicle, with bustimes livery when possible.
  for (const bods of bodsList) {
    let best = null;
    let bestScore = 0;
    for (const bt of btList) {
      if (usedBt.has(bt.id) || isFlixBus(bt)) continue;
      const score = liveBusMatchScore(bods, bt);
      if (score > bestScore) {
        best = bt;
        bestScore = score;
      }
    }
    // Soft match for paint: nearest same-line bustimes bus with a livery.
    if ((!best || bestScore < 10) && !liveryIdOf(bods)) {
      const [bLng, bLat] = bods.coordinates || [];
      const lineB = compactQuery(bods.service?.line_name);
      let near = null;
      let nearD = Infinity;
      if (Number.isFinite(bLat) && Number.isFinite(bLng)) {
        for (const bt of btList) {
          if (usedBt.has(bt.id) || isFlixBus(bt) || !liveryIdOf(bt)) continue;
          const lineT = compactQuery(bt.service?.line_name);
          if (lineB && lineT && lineB !== lineT) continue;
          const [tLng, tLat] = bt.coordinates || [];
          if (!Number.isFinite(tLat) || !Number.isFinite(tLng)) continue;
          const d = haversineMeters(bLat, bLng, tLat, tLng);
          if (d < nearD && d < 500) {
            nearD = d;
            near = bt;
          }
        }
      }
      if (near) {
        best = near;
        bestScore = Math.max(bestScore, 12);
      }
    }
    if (best && bestScore >= 10) {
      usedBt.add(best.id);
      out.push(enrichBodsFromBustimes(bods, best));
    } else {
      out.push({ ...bods, trackSource: "bods", metaSource: "bods" });
    }
  }

  // 2) Secondary — bustimes only for gaps / fallback (never duplicate BODS).
  for (const bt of btList) {
    if (usedBt.has(bt.id) || isFlixBus(bt)) continue;
    if (bodsPrimary) {
      if (out.some((bus) => busesAreSameVehicle(bus, bt))) continue;
      const [lng, lat] = bt.coordinates || [];
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const nearBods = out.some((bus) => {
          if (bus.trackSource !== "bods" && bus.source !== "bods") return false;
          const [olng, olat] = bus.coordinates || [];
          if (!Number.isFinite(olat) || !Number.isFinite(olng)) return false;
          return haversineMeters(lat, lng, olat, olng) < 220;
        });
        if (nearBods) continue;
      }
    }
    out.push({ ...bt, source: "bustimes", trackSource: "bustimes", metaSource: "bustimes" });
  }

  return dedupeLiveBuses(out);
}

/** Drop near-duplicate markers; always keep BODS-tracked copy first. */
function dedupeLiveBuses(buses) {
  const ranked = [...(buses || [])].sort((a, b) => {
    const rank = (bus) => (bus?.trackSource === "bods" || bus?.source === "bods" ? 0 : 1);
    return rank(a) - rank(b);
  });
  const kept = [];
  for (const bus of ranked) {
    if (kept.some((other) => busesAreSameVehicle(other, bus))) continue;
    kept.push(bus);
  }
  return kept;
}

function gbLimitFromType(type) {
  const t = String(type || "").toLowerCase();
  if (!t) return null;
  if (t.includes("motorway") || t.includes("nsl_dual")) return 70;
  if (t.includes("nsl_single")) return 60;
  if (t.includes("zone20") || /\b20\b/.test(t) && t.includes("zone")) return 20;
  if (t.includes("zone40")) return 40;
  if (t.includes("urban") || t.includes("nsl_restricted") || t.includes("zone30")) return 30;
  return null;
}

function parseSpeedValueMph(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().toLowerCase();
  if (!s || s === "none" || s === "signals" || s === "variable" || s === "walk") return null;
  const fromType = gbLimitFromType(s);
  if (fromType != null) return fromType;
  const km = s.match(/^([\d.]+)\s*km/);
  if (km) return Number(km[1]) * 0.621371;
  const mph = s.match(/^([\d.]+)\s*mph/);
  if (mph) return Number(mph[1]);
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 70) return n;
  return n * 0.621371;
}

function parseMaxspeedMph(tags = {}) {
  const fromType = gbLimitFromType(
    tags["maxspeed:type"] || tags["source:maxspeed"] || tags["zone:maxspeed"],
  );
  const fromTag = parseSpeedValueMph(
    tags.maxspeed || tags["maxspeed:forward"] || tags["maxspeed:backward"],
  );
  return fromTag ?? fromType;
}

function classLimitMph(cls) {
  const c = String(cls || "").toLowerCase();
  if (!c) return null;
  if (c === "motorway" || c === "motorway_link") return 70;
  if (c === "trunk" || c === "trunk_link") return 60;
  if (c === "primary" || c === "primary_link") return 40;
  if (
    c === "secondary" ||
    c === "secondary_link" ||
    c === "tertiary" ||
    c === "tertiary_link" ||
    c === "unclassified" ||
    c === "residential" ||
    c === "busway" ||
    c === "service" ||
    c === "minor" ||
    c === "road"
  ) {
    return 30;
  }
  if (c === "living_street") return 20;
  return null;
}

const SPEED_LIMIT_CACHE_TTL_MS = 10 * 60_000;
const speedLimitCache = new Map();

function limitCacheKey(lat, lng) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

function nearestRoadLimit(lat, lng) {
  const roads = roadsForSnap();
  if (!roads.length) return null;
  const p = [lat, lng];
  let best = null;
  let bestD = Infinity;
  const pad = 0.0025;
  for (const road of roads) {
    if (
      lat < road.bbox.minLat - pad ||
      lat > road.bbox.maxLat + pad ||
      lng < road.bbox.minLng - pad ||
      lng > road.bbox.maxLng + pad
    ) {
      continue;
    }
    const d = minDistToRoad(p, road.latlngs);
    if (d < bestD) {
      bestD = d;
      best = road.limitMph ?? classLimitMph(road.class);
    }
  }
  return bestD <= 180 && Number.isFinite(best) ? best : null;
}

/** Best available speed limit for the card (local road snap → cached vehicle value). */
function resolveLimitMph(bus, extra = {}, lat, lng) {
  const fromExtra = Number(extra?.limitMph);
  if (Number.isFinite(fromExtra) && fromExtra > 0) return fromExtra;
  const fromBus = Number(bus?.limitMph);
  if (Number.isFinite(fromBus) && fromBus > 0) return fromBus;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const near = nearestRoadLimit(lat, lng);
    if (Number.isFinite(near) && near > 0) return near;
  }
  return null;
}

async function fetchLimitNear(lat, lng, fallback) {
  const key = limitCacheKey(lat, lng);
  const hit = speedLimitCache.get(key);
  if (hit && Date.now() - hit.at < SPEED_LIMIT_CACHE_TTL_MS) return hit.value;
  // Use the local OpenFreeMap road snap only. Public Overpass endpoints are
  // rate-limited and must never be called for every marker selection.
  const result =
    Number.isFinite(fallback) && fallback > 0 ? fallback : nearestRoadLimit(lat, lng);
  speedLimitCache.set(key, { at: Date.now(), value: Number.isFinite(result) ? result : null });
  if (speedLimitCache.size > 400) speedLimitCache.delete(speedLimitCache.keys().next().value);
  return result;
}

/** Keep limit on the marker and refresh the card once the local road snap has a value. */
function ensureMarkerSpeedLimit(marker) {
  if (!marker?.bus) return;
  const bus = marker.bus;
  const extra = marker.extra || (marker.extra = {});
  const [lng, lat] = bus.coordinates || [];
  const ll = marker.getLatLng?.() || {};
  const useLat = Number.isFinite(ll.lat) ? ll.lat : lat;
  const useLng = Number.isFinite(ll.lng) ? ll.lng : lng;
  const known = resolveLimitMph(bus, extra, useLat, useLng);
  if (Number.isFinite(known)) {
    extra.limitMph = known;
    bus.limitMph = known;
    return;
  }
  if (!Number.isFinite(useLat) || !Number.isFinite(useLng)) return;
  if (marker._limitFetchAt && Date.now() - marker._limitFetchAt < 8000) return;
  marker._limitFetchAt = Date.now();
  const gen = marker._enrichGen || 0;
  fetchLimitNear(useLat, useLng, extra.limitMph ?? bus.limitMph).then((limit) => {
    if (marker._enrichGen && marker._enrichGen !== gen) return;
    if (!Number.isFinite(limit) || limit <= 0) return;
    marker.extra ||= {};
    marker.extra.limitMph = limit;
    if (marker.bus) marker.bus.limitMph = limit;
    refreshPopup(marker);
    if (isFollowingMarker(marker)) updateFollowChip();
  });
}

function colourChannels(value) {
  const s = String(value || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "white" || s === "#fff" || s === "#ffffff") return [255, 255, 255];
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

function isNearWhite(value) {
  const rgb = colourChannels(value);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  return r >= 230 && g >= 230 && b >= 230;
}

function liveryCss(livery) {
  return String(livery?.left_css || livery?.left || livery?.right_css || livery?.right || "").trim();
}

function cssColourTokens(css) {
  return String(css || "").match(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b|rgba?\([^)]+\)|\bwhite\b/gi) || [];
}

function isAllWhiteCss(css) {
  const colours = cssColourTokens(css);
  if (!colours.length) return false;
  return colours.every((c) => c.toLowerCase() === "white" || isNearWhite(c));
}

function firstUsefulColour(css) {
  for (const token of cssColourTokens(css)) {
    if (token.toLowerCase() === "white" || isNearWhite(token)) continue;
    return token;
  }
  return "";
}

/** Prefer loaded livery artwork over AVL "white" colour (common for branded fleets). */
function isWhiteLivery(colour, livery = null) {
  const css = liveryCss(livery);
  if (css) return isAllWhiteCss(css);
  return isNearWhite(colour);
}

function resolveBusPaint(colour, livery, { nis = false, school = false, scfc = false } = {}) {
  const css = liveryCss(livery);
  const white = isWhiteLivery(colour, livery);
  const fallback =
    (colour && !isNearWhite(colour) ? colour : "") ||
    (nis ? "#64748b" : scfc ? "#e03c31" : school ? "#f59e0b" : "#2563eb");

  let paint = fallback;
  let base = fallback;
  if (css && !isAllWhiteCss(css)) {
    paint = css;
    base = firstUsefulColour(css) || fallback;
  } else if (white) {
    paint = "#ffffff";
    base = "#ffffff";
  }

  let stroke = livery?.stroke_colour || "";
  if (!stroke || isNearWhite(stroke)) {
    stroke = white ? "#111827" : nis ? "#94a3b8" : scfc ? "#ffffff" : school ? "#f59e0b" : "#ffffff";
  }

  return { paint, base, stroke, white };
}

function vehicleIcon(line, heading, colour = "#2563eb", livery = null, speedMph = null, opts = {}) {
  const nis = Boolean(opts.nis);
  const school = Boolean(opts.school) && !nis;
  const scfc = Boolean(opts.scfc) && !nis && !school;
  const label = esc(String(line || (nis ? "NIS" : "?")).slice(0, 4));
  const rot = Number.isFinite(Number(heading)) ? Number(heading) : 0;
  const { paint, base, stroke, white } = resolveBusPaint(colour, livery, { nis, school, scfc });
  const compact = map.getZoom() < 15;
  const showSpeed = !compact && Number.isFinite(speedMph);
  const speed = showSpeed
    ? speedMph < 1.5
      ? "0 mph"
      : `${Math.round(speedMph)} mph`
    : "";
  const html = `
    <div class="bus-pin${compact ? " bus-pin-compact" : ""}${nis ? " bus-pin-nis" : ""}${school ? " bus-pin-school" : ""}${scfc ? " bus-pin-scfc" : ""}${white ? " bus-pin-white" : ""}">
      <div class="bus-2d" style="transform:rotate(${rot}deg)">
        <span class="bus-dir" aria-hidden="true"></span>
        <span class="bus-wheel bus-wheel-fl"></span>
        <span class="bus-wheel bus-wheel-fr"></span>
        <span class="bus-wheel bus-wheel-rl"></span>
        <span class="bus-wheel bus-wheel-rr"></span>
        <div class="bus-shell" style="background:${esc(base)};box-shadow:0 0 0 1.5px ${esc(stroke)}, 0 1px 2px rgba(0,0,0,.4)">
          <div class="bus-livery" style="background:${esc(paint)}"></div>
          <div class="bus-glass"></div>
          <div class="bus-number" style="transform:translate(-50%,-50%) rotate(${-rot}deg)">${label}</div>
        </div>
      </div>
      ${speed ? `<div class="bus-speed">${esc(speed)}</div>` : ""}
    </div>
  `;
  return L.divIcon({
    className: nis
      ? "bus-marker nis-marker"
      : scfc
        ? "bus-marker scfc-marker"
        : school
          ? "bus-marker school-marker"
          : "bus-marker",
    html,
    iconSize: compact ? [26, 44] : [30, 52],
    iconAnchor: compact ? [13, 18] : [15, 22],
    popupAnchor: [0, -18],
  });
}

function staffIcon(line, heading, livery = null, speedMph = null) {
  const paint = livery || brandLiveryForLine(line);
  return vehicleIcon(line, heading, paint?.colour || STAFF_COLOURS[line] || "#cc181a", paint, speedMph);
}

function speedBucket(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n / 5) * 5 : 0;
}

function busIconKey(bus, heading = null, speedMph = null) {
  const liv = resolveBusLivery(bus);
  const livId = liv?.id || liveryIdOf(bus);
  const h = Number.isFinite(heading) ? heading : Number(bus?.heading) || 0;
  const speed = Number.isFinite(speedMph) ? speedMph : Number(bus?.speedMph) || 0;
  const zoomBand = map.getZoom() >= 15 ? "close" : "mid";
  return [
    zoomBand,
    Math.round(h),
    speedBucket(speed),
    livId,
    liveryCss(liv) || bus?.vehicle?.colour || "",
    bus?.service?.line_name || "",
    isNotInService(bus) ? "nis" : "svc",
    isTicketerDeadRun(bus) ? "dr" : "",
  ].join("|");
}

function busIcon(bus, headingOverride = null) {
  const nis = isNotInService(bus);
  const dead = nis && isTicketerDeadRun(bus);
  const school = !nis && isSchoolBusLive(bus);
  const scfc = !nis && !school && isStokeFcShuttleLive(bus);
  // Dead runs: distinct DR label; other OOS keeps grey NIS pin style.
  const line = dead
    ? "DR"
    : nis && !isPassengerServiceLine(bus.service?.line_name)
      ? "NIS"
      : bus.service?.line_name || (nis ? "NIS" : "?");
  const heading = Number.isFinite(headingOverride)
    ? headingOverride
    : Number.isFinite(bus.heading)
      ? bus.heading
      : 0;
  const livery = resolveBusLivery(bus);
  if (nis) {
    return vehicleIcon(line, heading, "#64748b", livery, bus.speedMph, { nis: true });
  }
  if (isFlixBus(bus)) {
    // Prefer bustimes.org Flix livery when paint matched; else local Flix green.
    if (liveryCss(livery)) {
      return vehicleIcon(line, heading, bus.vehicle?.colour || FLIX_GREEN, livery, bus.speedMph);
    }
    return vehicleIcon(line, heading, FLIX_GREEN, FLIX_LIVERY, bus.speedMph);
  }
  if (isNationalExpress(bus)) {
    const natxLiv = liveryCss(livery) ? livery : brandLiveryForBus(bus);
    const colour =
      bus.vehicle?.colour && bus.vehicle.colour !== "#2563eb"
        ? bus.vehicle.colour
        : natxLiv?.colour || "#ffffff";
    return vehicleIcon(line, heading, colour, natxLiv, bus.speedMph);
  }
  const brand = brandLiveryForBus(bus);
  const immediateLivery = liveryCss(livery) ? livery : fleetLiveryForBus(bus) || brand;
  // bustimes.org colour when present; local/operator paint is the immediate fallback.
  let colour = scfc
    ? bus.vehicle?.colour || "#e03c31"
    : bus.vehicle?.colour && bus.vehicle.colour !== "#2563eb"
      ? bus.vehicle.colour
      : immediateLivery?.colour || brandColourForBus(bus, "#2563eb");
  if (
    !scfc &&
    isNearWhite(colour) &&
    immediateLivery?.colour &&
    !isNearWhite(immediateLivery.colour)
  ) {
    colour = immediateLivery.colour;
  }
  // Bustimes CSS wins whenever loaded; local/operator paint is temporary only.
  let paintLiv = immediateLivery;
  return vehicleIcon(line, heading, colour, paintLiv, bus.speedMph, { school, scfc });
}

function parseFleetReg(ref) {
  if (!ref) return { fleet: "", reg: "" };
  const cleaned = String(ref).replace(/[_-]+/g, " ").trim();
  const plate = cleaned.match(/[A-Z]{2}\d{2}\s*[A-Z]{3}/i);
  const parts = cleaned.split(/\s+/);
  return {
    fleet: parts[0] || "",
    reg: plate ? plate[0].replace(/\s+/g, " ").toUpperCase() : parts.slice(1).join(" "),
  };
}

/** NATX/Flix often put the plate in vehicle.name ("BV19 XOH", "441 - BF68 LCK"). */
function regFromVehicleName(name) {
  const text = String(name || "").toUpperCase();
  if (!text) return "";
  const match =
    text.match(/\b([A-Z]{2}\d{2}\s*[A-Z]{3})\b/) || text.match(/\b([A-Z]\d{1,3}\s*[A-Z]{3})\b/);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

function busRegistration(bus = {}, extra = {}) {
  return (
    String(extra.vehicle?.reg || extra.btVehicle?.reg || bus.vehicle?.reg || extra.coachReg || "").trim() ||
    regFromVehicleName(extra.vehicle?.name || bus.vehicle?.name || "") ||
    ""
  );
}

/** Fleet number from BODS/Ticketer (D&G often has no plate on SIRI — only "119"). */
function busFleetCode(bus = {}, extra = {}) {
  const direct = String(
    extra.btVehicle?.fleet_code ||
      extra.btVehicle?.fleet_number ||
      extra.vehicle?.fleet_code ||
      extra.vehicle?.fleet_number ||
      bus?.vehicle?.fleet_code ||
      bus?.vehicle?.fleet_number ||
      "",
  ).trim();
  if (direct) return direct;
  const name = String(extra.vehicle?.name || bus?.vehicle?.name || "").trim();
  if (/^\d{1,5}[A-Z]?$/i.test(name)) return name;
  // bods-DAGC-DAGC-119 / bods-FPOT-FPOT-35939
  const fromId = String(bus?.id || "").match(/-(\d{1,5}[A-Z]?)$/i);
  if (fromId) return fromId[1];
  const ref = String(bus?._bods?.vehicleRef || "").trim();
  const fromRef = ref.match(/(?:^|-)(\d{1,5}[A-Z]?)$/i);
  if (fromRef && !/[A-Z]{2}\d{2}/i.test(ref)) return fromRef[1];
  return "";
}

function compactReg(reg) {
  return String(reg || "").replace(/\s+/g, "").toUpperCase();
}

const photoCache = new Map();
let photoFileInput = null;
let photoUploadTarget = null;
const PHOTO_UPLOADER_NAME_KEY = "uk-bus-photo-uploader-name";

function savedPhotoUploaderName() {
  try {
    return String(localStorage.getItem(PHOTO_UPLOADER_NAME_KEY) || "").trim().slice(0, 60);
  } catch {
    return "";
  }
}

function rememberPhotoUploaderName(name) {
  const credit = String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
  try {
    if (credit) localStorage.setItem(PHOTO_UPLOADER_NAME_KEY, credit);
  } catch {
    // Ignore storage failures.
  }
  return credit;
}

function photoUploaderNameFrom(el) {
  const root = el?.closest?.(".popup-photo, .fleet-photo");
  const input = root?.querySelector(".bus-photo-name, .fleet-photo-name");
  return rememberPhotoUploaderName(input?.value || savedPhotoUploaderName());
}

function vehicleRegForPhoto(marker) {
  if (!marker) return "";
  const extra = marker.extra || {};
  return compactReg(
    extra.vehicle?.reg ||
      extra.btVehicle?.reg ||
      marker.bus?.vehicle?.reg ||
      parseFleetReg(marker.staff?.vehicle?.ref).reg ||
      "",
  );
}

function vehicleFleetForPhoto(marker) {
  if (!marker) return "";
  const extra = marker.extra || {};
  return String(
    extra.vehicle?.fleet_code ||
      extra.btVehicle?.fleet_code ||
      parseFleetReg(marker.staff?.vehicle?.ref).fleet ||
      "",
  ).trim();
}

function photoBlock(extra = {}, { reg = "", fleet = "", operator = "" } = {}) {
  const plate = compactReg(reg || extra.photoReg || "");
  const photo = extra.photo;
  const pending = Boolean(extra.photoPending);
  const status = extra.photoStatus || "";
  const canUpload = Boolean(plate);
  const img = photo?.url
    ? `<img class="popup-bus-photo" src="${esc(photo.url)}" alt="Photo of ${esc(plate)}" loading="lazy" />`
    : "";
  const credit = photo?.uploaderName
    ? `<p class="popup-photo-credit">Photo by ${esc(photo.uploaderName)}</p>`
    : "";
  const note = pending
    ? `<p class="popup-photo-note">Photo submitted — waiting for owner approval. You can upload more anytime.</p>`
    : status
      ? `<p class="popup-photo-note">${esc(status)}</p>`
      : !photo && canUpload
        ? `<p class="popup-photo-note">Plus members can add a photo of this bus (needs owner approval).</p>`
        : "";
  const nameField = canUpload
    ? `<label class="popup-photo-name-label"><span class="sr-only">Your name</span><input type="text" class="bus-photo-name" maxlength="60" placeholder="Your name (optional)" value="${esc(savedPhotoUploaderName())}" autocomplete="nickname" enterkeyhint="done" /></label>`
    : "";
  const btn = canUpload
    ? `<button type="button" class="bus-photo-btn" data-reg="${esc(plate)}" data-fleet="${esc(fleet)}" data-operator="${esc(operator)}">${
        pending ? "Add another photo" : photo ? "Replace photo" : "Add photo"
      }</button>`
    : "";
  if (!img && !btn && !note) return "";
  return `<div class="popup-photo">${img}${credit}${note}${nameField}${btn}</div>`;
}

async function fetchApprovedPhoto(reg) {
  const key = compactReg(reg);
  if (!key) return null;
  if (photoCache.has(key)) return photoCache.get(key);
  const promise = fetch(`/api/bus-photos?reg=${encodeURIComponent(key)}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => data?.photo || null)
    .catch(() => null);
  photoCache.set(key, promise);
  return promise;
}

async function loadPhotoIntoMarker(marker) {
  if (!marker) return;
  marker.extra ||= {};
  const reg = vehicleRegForPhoto(marker);
  marker.extra.photoReg = reg;
  if (!reg) {
    marker.extra.photo = null;
    return;
  }
  const photo = await fetchApprovedPhoto(reg);
  if (vehicleRegForPhoto(marker) !== reg) return;
  marker.extra.photo = photo;
  if (photo) marker.extra.photoPending = false;
  refreshPopup(marker);
}

function ensurePhotoFileInput() {
  if (photoFileInput) return photoFileInput;
  photoFileInput = document.createElement("input");
  photoFileInput.type = "file";
  photoFileInput.accept = "image/jpeg,image/png,image/webp,image/*";
  photoFileInput.hidden = true;
  photoFileInput.addEventListener("change", () => {
    const file = photoFileInput.files?.[0];
    photoFileInput.value = "";
    if (file && photoUploadTarget) submitBusPhotoFile(file, photoUploadTarget);
  });
  document.body.appendChild(photoFileInput);
  return photoFileInput;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read that photo"));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not open that photo"));
    img.src = url;
  });
}

async function compressPhotoFile(file) {
  const raw = await readFileAsDataUrl(file);
  const img = await loadImageElement(raw);
  const maxEdge = 960;
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  let quality = 0.82;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > 750_000 && quality > 0.45) {
    quality -= 0.08;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  if (dataUrl.length > 900_000) {
    throw new Error("Photo is still too large after compression");
  }
  return dataUrl;
}

async function submitBusPhotoFile(file, meta = {}) {
  if (!requirePlus("bus-photo")) {
    throw new Error("Plus is required to submit bus photos");
  }
  if (!getUser()) {
    throw new Error("Log in with your Plus account to submit a photo.");
  }
  const marker = openJourneyMarker();
  const reg = compactReg(meta?.reg || (marker ? vehicleRegForPhoto(marker) : ""));
  if (!reg) {
    throw new Error("This bus needs a registration plate before a photo can be added.");
  }
  if (marker) {
    marker.extra ||= {};
    marker.extra.photoStatus = "Uploading photo…";
    marker.extra.photoPending = false;
    refreshPopup(marker, { force: true });
  }
  try {
    const image = await compressPhotoFile(file);
    const res = await fetch("/api/bus-photos", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reg,
        fleet: meta?.fleet || (marker ? vehicleFleetForPhoto(marker) : ""),
        operator:
          meta?.operator ||
          (marker ? operatorName(marker.bus, marker.extra) : "") ||
          "Bus",
        uploaderName: meta?.uploaderName || savedPhotoUploaderName(),
        mime: "image/jpeg",
        image,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    if (marker) {
      marker.extra.photoPending = true;
      marker.extra.photoStatus = "";
      photoCache.delete(reg);
      refreshPopup(marker, { force: true });
    }
    showMessage(data.message || "Photo submitted for approval");
    return data;
  } catch (error) {
    if (marker) {
      marker.extra.photoPending = false;
      marker.extra.photoStatus = error.message || "Could not upload photo";
      refreshPopup(marker, { force: true });
    }
    throw error;
  }
}

function beginBusPhotoUpload(btn) {
  if (!requirePlus("bus-photo")) return;
  if (!getUser()) {
    const marker = openJourneyMarker();
    if (marker) {
      marker.extra ||= {};
      marker.extra.photoStatus = "Log in with your Plus account first.";
      refreshPopup(marker, { force: true });
    } else {
      showMessage("Log in with your Plus account to submit a photo");
    }
    return;
  }
  photoUploadTarget = {
    reg: btn.dataset.reg || "",
    fleet: btn.dataset.fleet || "",
    operator: btn.dataset.operator || "",
    uploaderName: photoUploaderNameFrom(btn),
  };
  ensurePhotoFileInput().click();
}

document.addEventListener("input", (event) => {
  const input = event.target?.closest?.(".bus-photo-name, .fleet-photo-name");
  if (!input) return;
  rememberPhotoUploaderName(input.value);
});

document.addEventListener(
  "pointerdown",
  (event) => {
    if (event.target.closest?.(".bus-photo-name, .fleet-photo-name")) {
      event.stopPropagation();
    }
  },
  true,
);

function pickBustimesVehicle(results, { reg = "", fleet = "", operator = "" } = {}) {
  const list = Array.isArray(results) ? results.filter(Boolean) : [];
  if (!list.length) return null;
  const wantReg = compactReg(reg);
  const wantFleet = compactReg(fleet);
  const wantOp = String(operator || "").toUpperCase();
  let best = null;
  let bestScore = -Infinity;
  for (const vehicle of list) {
    let score = 0;
    if (wantReg && compactReg(vehicle.reg) === wantReg) score += 8;
    else if (wantReg && compactReg(vehicle.previous_reg) === wantReg) score += 4;
    const fleetCode = compactReg(vehicle.fleet_code || vehicle.fleet_number);
    if (wantFleet && fleetCode === wantFleet) score += 12;
    const op = String(vehicle.operator?.id || vehicle.operator?.name || "").toUpperCase();
    if (wantOp && (op === wantOp || op.includes(wantOp))) score += 10;
    if (vehicle.withdrawn) score -= 25;
    if (vehicle.livery?.left || vehicle.livery?.left_css) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = vehicle;
    }
  }
  return best;
}

async function bustimesVehicleByReg(reg, extras = {}) {
  const key = [compactReg(reg), compactReg(extras.fleet), String(extras.operator || "").toUpperCase()].join("|");
  if (!compactReg(reg) && !extras.fleet) return null;
  if (!btRegCache.has(key)) {
    btRegCache.set(
      key,
      (async () => {
        const params = new URLSearchParams();
        if (compactReg(reg)) params.set("reg", compactReg(reg));
        else params.set("search", extras.fleet);
        params.set("withdrawn", "false");
        if (extras.operator) params.set("operator", extras.operator);
        const fetchList = async (query) => {
          const res = await fetch(`/api/bt-vehicles/?${query}`);
          if (!res.ok) return [];
          const data = await res.json();
          return data?.results || [];
        };
        let results = await fetchList(params);
        let vehicle = pickBustimesVehicle(results, { reg, ...extras });
        if (!vehicle && extras.operator) {
          params.delete("operator");
          results = await fetchList(params);
          vehicle = pickBustimesVehicle(results, { reg, ...extras });
        }
        if (!vehicle) {
          params.delete("withdrawn");
          results = await fetchList(params);
          vehicle = pickBustimesVehicle(results, { reg, ...extras });
        }
        return vehicle;
      })().catch(() => null),
    );
  }
  return btRegCache.get(key);
}

/**
 * BODS live ids are `bods-FPOT-…` — bustimes journey history needs the numeric vehicle id.
 * Resolve via plate (and optional NOC) when paint matching did not attach btId.
 */
async function resolveBustimesVehicleForBus(bus, extra = {}) {
  if (!bus && !extra) return null;
  const existingId = historyVehicleId(bus, extra);
  if (existingId && (extra.btVehicle?.id || extra.vehicle?.id)) {
    return extra.btVehicle || extra.vehicle || null;
  }
  if (existingId) {
    try {
      return await vehicleDetails(existingId);
    } catch {
      /* fall through to reg lookup */
    }
  }
  const reg =
    compactReg(
      busRegistration(bus || {}, extra) ||
        extra.btVehicle?.reg ||
        extra.vehicle?.reg ||
        bus?.vehicle?.reg ||
        "",
    ) || "";
  const noc = String(
    trailOperatorForBus(bus) ||
      bus?._bods?.operator ||
      bus?.operator?.noc ||
      bus?.operator?.id ||
      extra.operatorNoc ||
      "",
  )
    .trim()
    .toUpperCase();
  const fleet = busFleetCode(bus, extra);
  // D&G / Staffs Ticketer often publish fleet number only (no plate on BODS).
  if (!reg && !fleet) return null;
  if (!reg && fleet) {
    return (
      (noc ? await bustimesVehicleByReg("", { fleet, operator: noc }) : null) ||
      (await bustimesVehicleByReg("", { fleet }))
    );
  }
  return (
    (noc ? await bustimesVehicleByReg(reg, { fleet, operator: noc }) : null) ||
    (await bustimesVehicleByReg(reg, { fleet })) ||
    (fleet ? await bustimesVehicleByReg("", { fleet, operator: noc || undefined }) : null)
  );
}
function liveryFromBtVehicle(vehicle) {
  if (!vehicle) return null;
  const rawLiv = vehicle.livery;
  const id =
    rawLiv && typeof rawLiv === "object"
      ? rawLiv.id
      : rawLiv != null && rawLiv !== ""
        ? rawLiv
        : null;
  if (id != null) {
    const cached = getLivery(id);
    if (cached) return cached;
  }
  const left = rawLiv?.left_css || rawLiv?.left;
  if (!left) return null;
  return {
    id: id != null ? String(id) : undefined,
    left_css: left,
    right_css: rawLiv?.right_css || rawLiv?.right || left,
    white_text: true,
    stroke_colour: rawLiv?.stroke_colour || "#111827",
  };
}

async function staffLivery(item) {
  const line = staffLineName(item);
  const parsed = parseFleetReg(item.vehicle?.ref);
  let vehicle =
    (await bustimesVehicleByReg(parsed.reg, { fleet: parsed.fleet, operator: "DAGC" })) ||
    (parsed.reg || parsed.fleet
      ? await bustimesVehicleByReg(parsed.reg, { fleet: parsed.fleet })
      : null);
  const id = vehicle?.livery?.id ?? vehicle?.livery;
  if (id != null && id !== "") await ensureLiveries([id]);
  const fromBt = liveryFromBtVehicle(vehicle);
  if (fromBt?.left_css || fromBt?.left) return fromBt;
  if (id != null && id !== "") {
    const hit = getLivery(id);
    if (hit?.left_css || hit?.left) return hit;
  }
  const fleet = fleetLiveryForBus({
    vehicle: { reg: parsed.reg, name: parsed.fleet || parsed.reg },
    operator: { noc: "DAGC" },
    service: { line_name: line },
  });
  if (fleet) return fleet;
  return (
    brandLiveryForLine(line) ||
    brandLiveryForBus({ service: { line_name: line }, operator: { noc: "DAGC" } })
  );
}

function getStaffRoutes() {
  if (!staffRoutesPromise) {
    staffRoutesPromise = fetch("/api/dg-services")
      .then((res) => (res.ok ? res.json() : { objects: [] }))
      .then((data) => {
        const routes = new Map();
        for (const row of data.objects || []) {
          const service = row.service || row;
          const line = (service.lineName || "").toUpperCase();
          if (line) routes.set(line, service);
        }
        return routes;
      })
      .catch(() => new Map());
  }
  return staffRoutesPromise;
}

async function stopDetails(atco) {
  if (!atco) return null;
  if (!stopCache.has(atco)) {
    stopCache.set(
      atco,
      fetch(`/api/bt-stops/${encodeURIComponent(atco)}/`)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    );
  }
  const stop = await stopCache.get(atco);
  if (!stop) return null;
  const lng = Number(stop.location?.[0] ?? stop.longitude ?? stop.lng);
  const lat = Number(stop.location?.[1] ?? stop.latitude ?? stop.lat);
  return {
    name: stop.name || stop.long_name || stop.common_name || "",
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

async function stopName(atco) {
  const stop = await stopDetails(atco);
  return stop?.name || "";
}

function tripPathFromTimes(times) {
  const path = [];
  let last = "";
  const push = (lat, lng) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    if (key === last) return;
    last = key;
    path.push([lat, lng]);
  };
  for (const row of times || []) {
    if (Array.isArray(row.track)) {
      for (const pt of row.track) push(Number(pt[1]), Number(pt[0]));
    }
    const loc = row.stop?.location;
    if (loc) push(Number(loc[1]), Number(loc[0]));
  }
  return path;
}

function pathCrossesActiveRoadNotice(path) {
  const flat = Array.isArray(path?.[0]?.[0]) ? path.flat() : path;
  if (!Array.isArray(flat) || flat.length < 2) return false;
  const now = Date.now();
  for (const notice of ROAD_NOTICES || []) {
    if (!roadNoticeIsActive(notice, now) || !Array.isArray(notice.path) || notice.path.length < 2) continue;
    for (let i = 0; i < flat.length; i += 1) {
      const point = flat[i];
      if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
      for (let j = 1; j < notice.path.length; j += 1) {
        if (distPointToSegmentMeters(point, notice.path[j - 1], notice.path[j]) <= 90) return true;
      }
    }
  }
  return false;
}

function plannedPathReplayPoints(path, { startMs = Date.now(), endMs = 0, direction = "" } = {}) {
  const flat = Array.isArray(path?.[0]?.[0]) ? path.flat() : path;
  const points = thinTrailPoints(
    (Array.isArray(flat) ? flat : [])
      .map((point) => [Number(point?.[0]), Number(point?.[1])])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng)),
    35,
  ).slice(0, 1200);
  if (points.length < 2) return [];
  const start = Number.isFinite(Number(startMs)) ? Number(startMs) : Date.now();
  const end = Number.isFinite(Number(endMs)) && Number(endMs) > start ? Number(endMs) : start + Math.max(60_000, points.length * 1000);
  return points.map(([lat, lng], index) => {
    const prev = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    return {
      lat,
      lng,
      t: start + ((end - start) * index) / (points.length - 1),
      heading: segmentBearing(prev, next),
      direction: normalizeTrailDirection(direction),
      speedMph: null,
    };
  });
}

async function tripEnds(tripId, { force = false, date = "" } = {}) {
  if (!tripId) return null;
  const fresh =
    !force && tripCache.has(tripId) && Date.now() - (tripCacheAt.get(tripId) || 0) < 25000;
  if (!fresh) {
    tripCacheAt.set(tripId, Date.now());
    tripCache.set(
      tripId,
      fetch(`/api/bt-trips/${encodeURIComponent(tripId)}/`)
        .then((res) => (res.ok ? res.json() : null))
        .then((trip) => {
          const times = trip?.times || [];
          const stops = mapTripStops(times);
          const from = stops[0]?.name || times[0]?.stop?.name || "";
          const to = stops[stops.length - 1]?.name || trip?.headsign || "";
          const operator =
            trip?.operator?.name ||
            trip?.operator?.noc ||
            (typeof trip?.operator === "string" ? trip.operator : "");
          const tripDate = String(trip?.date || date || "").slice(0, 10);
          const dateRef = /^\d{4}-\d{2}-\d{2}$/.test(tripDate)
            ? Date.parse(`${tripDate}T12:00:00Z`)
            : Date.now();
          const start = String(trip?.start || "");
          const end = String(trip?.end || "");
          const startMs = tripDate ? tripAimedMs(start, dateRef) : NaN;
          let endMs = tripDate ? tripAimedMs(end, dateRef) : NaN;
          if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= startMs) {
            endMs += 24 * 60 * 60_000;
          }
          return {
            from,
            to,
            stops,
            operator,
            delaySec: tripDelaySeconds(times),
            path: tripPathFromTimes(times),
            line: trip?.service?.line_name || "",
            headsign: trip?.headsign || to,
            date: tripDate,
            start,
            end,
            startMs: Number.isFinite(startMs) ? startMs : null,
            endMs: Number.isFinite(endMs) ? endMs : null,
          };
        })
        .catch(() => null),
    );
  }
  return tripCache.get(tripId);
}

async function vehicleDetails(vehicleId) {
  if (!vehicleId) return null;
  if (!vehicleCache.has(vehicleId)) {
    vehicleCache.set(
      vehicleId,
      fetch(`/api/bt-vehicles/${encodeURIComponent(vehicleId)}/`)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    );
  }
  return vehicleCache.get(vehicleId);
}

async function dgVehicleDetails(ref) {
  if (!ref) return null;
  if (!dgVehicleCache.has(ref)) {
    dgVehicleCache.set(
      ref,
      fetch(`/api/dg-vehicle/${encodeURIComponent(ref)}?regionId=526`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => data?.objects?.[0] || null)
        .catch(() => null),
    );
  }
  return dgVehicleCache.get(ref);
}

async function dgVehicleFromBt(vehicle) {
  if (!vehicle || String(vehicle.operator?.id || "") !== "DAGC") return null;
  const fleet = vehicle.fleet_code || vehicle.fleet_number;
  const plate = compactReg(vehicle.reg);
  const pretty = plate.replace(/^([A-Z]{1,2}\d{1,2})([A-Z]{3})$/, "$1_$2");
  if (!fleet || pretty === plate) return null;
  return dgVehicleDetails(`${fleet}_-_${pretty}`);
}

function pickOperatorName(...sources) {
  for (const src of sources) {
    if (!src) continue;
    if (typeof src === "string" && src.trim()) return src.trim();
    const name = src.name || src.operator_name || src.trading_name;
    if (name) return String(name).trim();
    if (src.noc) return String(src.noc).trim();
  }
  return "";
}

function operatorName(bus, extra = {}) {
  if (bus?.nisSource === "dg") return "D&G Bus";
  return pickOperatorName(
    extra.operator,
    extra.vehicle?.operator,
    extra.vehicle?.livery?.operator,
    bus?.operator,
    bus?.service?.operator,
  );
}

function routeBlock(from, to) {
  const a = from || "Unknown";
  const b = to || "Unknown";
  return `<div class="popup-route" title="${esc(a)} → ${esc(b)}"><span class="route-from">${esc(a)}</span><span class="route-arrow" aria-hidden="true">→</span><span class="route-to">${esc(b)}</span></div>`;
}

const POPUP_OPTS = { maxWidth: 320, minWidth: 220, autoPan: false, className: "bus-popup" };

function schoolRouteTitle(bus) {
  const line = String(bus?.service?.line_name || "").toUpperCase();
  const meta = STAFFS_SCHOOL_ROUTES.find((row) => row.line === line);
  if (meta?.name) return meta.name;
  return bus?.destination || "School / college service";
}

function stokeFcShuttleTitle(bus) {
  const line = normalizeStokeFcLine(bus?.service?.line_name || "");
  const meta = STOKE_FC_SHUTTLE_ROUTES.find(
    (row) => row.line === line || (row.aliases || []).map((a) => String(a).toUpperCase()).includes(line),
  );
  if (meta?.name) return meta.name;
  return bus?.destination || "bet365 Stadium";
}

function popupHtml(bus, extra = {}, { omitStops = false, sidePanel = false } = {}) {
  const nis = isNotInService(bus);
  const dead = nis && isTicketerDeadRun(bus);
  const school = !nis && isSchoolBusLive(bus);
  const scfc = !nis && !school && isStokeFcShuttleLive(bus);
  const line =
    dead
      ? "Dead run"
      : extractRouteFromVehicle(bus) ||
        bus.service?.line_name ||
        (nis ? "Not in service" : "Unknown line");
  const from = extra.from || bus.origin || "";
  const to = extra.to || bus.destination || (dead ? "Dead run" : "");
  const diverted = isDivertedText(to, bus.destination);
  const liveName = bus.vehicle?.name || "Unknown vehicle";
  const detail = extra.vehicle || {};
  const type = detail.vehicle_type?.name || "";
  const fuel = detail.vehicle_type?.fuel || "";
  const deck = detail.vehicle_type?.double_decker
    ? "Double"
    : detail.vehicle_type
      ? "Single"
      : bus.vehicle?.features?.includes?.("Double")
        ? "Double"
        : "";
  const fleet = detail.fleet_code || "";
  const reg = busRegistration(bus, extra) || detail.reg || bus.vehicle?.reg || extra.coachReg || "";
  const livery = detail.livery?.name || "";
  const fleetVehicleId = bustimesVehicleIdForFleet(bus, extra);
  const opSlug = fleetOperatorSlugForBus(bus, extra);
  const opNoc = trailOperatorForBus(bus) || (isFlixBus(bus) ? "FLIX" : isNationalExpress(bus) ? "NATX" : "");
  const regLink = fleetRegButtonHtml(reg, {
    fleet,
    vehicleId: fleetVehicleId,
    operatorSlug: opSlug,
    serviceId: bus.service_id || bus.service?.id || "",
    line: bus.service?.line_name || extra.line || "",
    operatorNoc: opNoc,
  });
  const idLine =
    [fleet ? esc(`#${fleet}`) : "", regLink || (reg ? esc(reg) : "")].filter(Boolean).join(" · ") ||
    (opSlug
      ? fleetRegButtonHtml("", {
          operatorSlug: opSlug,
          serviceId: bus.service_id || bus.service?.id || "",
          line: bus.service?.line_name || extra.line || "",
          operatorNoc: opNoc,
        })
      : esc(liveName));
  const typeLine = [type, deck, fuel].filter(Boolean).join(" · ");
  const operator = operatorName(bus, extra);
  const [lng, lat] = bus.coordinates || [];
  const delaySec = resolveLiveDelaySec(bus, extra, lat, lng, {
    live: Boolean(sidePanel),
  });
  if (extra && delaySec != null) extra.delaySec = delaySec;
  const delayText = nis ? "" : formatDelay(delaySec);
  const metaBits = [idLine, esc(operator), esc(typeLine), esc(livery)].filter(Boolean);
  const stickyNext = Number.isInteger(extra._nextStopIdx) ? extra._nextStopIdx : null;
  const photoReg = reg || bus.vehicle?.reg || extra.coachReg || "";
  const historyExtra = {
    ...extra,
    operator: extra.operator || operator,
    line: extra.line || (scfc ? normalizeStokeFcLine(line) : line),
    historyLineFilter:
      extra.historyLineFilter || (scfc ? normalizeStokeFcLine(line) : extra.line || line || ""),
  };

  return `
    <div class="popup-card${sidePanel ? " is-side-panel" : ""}">
      <div class="popup-top">
        <div class="popup-line">${esc(line)}${diverted ? ` <span class="history-divert-tag" title="Diverted">div</span>` : ""}</div>
        ${
          nis
            ? ""
            : `<div class="popup-delay ${delayClass(delaySec)}">${esc(delayText)}</div>`
        }
      </div>
      ${nis ? `<div class="popup-title popup-nis">${esc(nisStatus(bus))}</div>` : ""}
      ${school ? `<div class="popup-title popup-school">School / college · ${esc(schoolRouteTitle(bus))}</div>` : ""}
      ${scfc ? `<div class="popup-title popup-scfc">Stoke City FC shuttle · ${esc(stokeFcShuttleTitle(bus))}</div>` : ""}
      ${
        !nis && isFlixBus(bus)
          ? `<div class="popup-title popup-flix">FlixBus${
              isInternationalFlix(bus) ? " · Europe" : ""
            }${flixRouteTitle(bus) ? ` · ${esc(flixRouteTitle(bus))}` : ""}</div>`
          : ""
      }
      ${
        !nis && !isFlixBus(bus) && isNationalExpress(bus)
          ? `<div class="popup-title popup-natx">National Express</div>`
          : ""
      }
      ${nis ? (to ? `<div class="popup-meta">Shown as ${esc(to)}</div>` : "") : routeBlock(from, to)}
      <div class="popup-actions">
        ${followButtonHtml({ bus })}
        ${playRouteButtonHtml(bus, historyExtra)}
        ${isCoachTrailOperator(trailOperatorForBus(bus)) ? "" : replayBusButtonHtml(bus, historyExtra)}
      </div>
      ${photoBlock(extra, { reg: photoReg, fleet, operator })}
      ${seatsBlock(bus, extra)}
      ${omitStops || nis ? "" : stopsBlock(extra.stops, lat, lng, stickyNext)}
      <div class="popup-details">
        <div>${metaBits.join(" · ")}</div>
        <div class="popup-details-live">${formatSpeedLiveHtml(bus.speedMph, resolveLimitMph(bus, extra, lat, lng), timeAgo(bus.datetime))}</div>
      </div>
    </div>
  `;
}

function markerPopupHtml(marker) {
  if (marker?.bus) return popupHtml(marker.bus, marker.extra);
  if (marker?.staff) return staffPopup(marker.staff, marker.extra);
  return "";
}

/** Strip volatile live bits so we can detect real card structure changes. */
function popupStructureKey(html) {
  return String(html || "")
    .replace(/class="popup-delay[^"]*"[^<]*/g, 'class="popup-delay"')
    .replace(/class="popup-details-live[^"]*"[\s\S]*?<\/div>/g, 'class="popup-details-live"></div>')
    .replace(/class="popup-seats[^"]*"[\s\S]*?<\/div>\s*<\/div>/g, 'class="popup-seats"></div>')
    .replace(/class="follow-bus-btn[^"]*"[^<]*/g, 'class="follow-bus-btn"')
    .replace(/ class="popup-stop[^"]*"/g, ' class="popup-stop"')
    .replace(/<span class="popup-fold-hint">[^<]*<\/span>/g, "")
    .replace(/<p class="popup-photo-note">[^<]*<\/p>/g, "")
    .replace(/\d+s ago|just now|\d+m ago/g, "AGE")
    .replace(/Stopped|\d+ mph/g, "SPEED")
    .replace(/speed-limit-badge-num">\d+/g, 'speed-limit-badge-num">N')
    .replace(/limit \d+/g, "LIMIT")
    .replace(/On time|\d+ min late|\d+ min early|Timing unknown/g, "DELAY")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, "TIME");
}

function rememberNextStop(marker) {
  if (!marker?.bus || !marker.extra?.stops?.length) return;
  const [lng, lat] = marker.bus.coordinates || [];
  const rows = cardStops(marker.extra.stops, lat, lng, marker.extra._nextStopIdx);
  const idx = rows.findIndex((stop) => stop.next);
  if (idx >= 0) marker.extra._nextStopIdx = idx;
}

/** Update speed / delay / follow label without rebuilding the popup DOM. */
function patchPopupLive(marker) {
  const root =
    (selectedMapMarker === marker && journeyPanelDetailEl?.querySelector(".popup-card")) ||
    marker.getPopup()?.getElement()?.querySelector(".popup-card");
  if (!root) return false;
  rememberNextStop(marker);

  if (marker.bus) {
    const bus = marker.bus;
    const extra = marker.extra || {};
    const nis = isNotInService(bus);
    const [lng, lat] = bus.coordinates || [];
    const delaySec = resolveLiveDelaySec(bus, extra, lat, lng, {
      live: isFollowingMarker(marker) || selectedMapMarker === marker,
    });
    if (delaySec != null) extra.delaySec = delaySec;
    const delayEl = root.querySelector(".popup-delay");
    if (delayEl && !nis) {
      delayEl.textContent = formatDelay(delaySec);
      delayEl.className = `popup-delay ${delayClass(delaySec)}`.trim();
    }
    scheduleTripDelayRefresh(marker);
    if (isFollowingMarker(marker)) updateFollowChip();
    const liveEl = root.querySelector(".popup-details-live");
    if (liveEl) {
      const limit = resolveLimitMph(bus, extra, lat, lng);
      if (Number.isFinite(limit)) {
        extra.limitMph = limit;
        bus.limitMph = limit;
      } else {
        ensureMarkerSpeedLimit(marker);
      }
      liveEl.innerHTML = formatSpeedLiveHtml(bus.speedMph, limit, timeAgo(bus.datetime));
    }
    if (!nis && extra.stops?.length) {
      const rows = cardStops(extra.stops, lat, lng, extra._nextStopIdx);
      const next = rows.find((stop) => stop.next);
      const hint = root.querySelector(".popup-fold-hint");
      if (hint && next) hint.textContent = `${next.name} · ${next.live || ""}`;
      const stopEls = root.querySelectorAll(".popup-stop");
      stopEls.forEach((el, i) => {
        const stop = rows[i];
        if (!stop) return;
        el.classList.toggle("is-done", Boolean(stop.done));
        el.classList.toggle("is-next", Boolean(stop.next));
      });
    }
  } else if (marker.staff) {
    const item = marker.staff;
    const extra = marker.extra || {};
    const liveEl = root.querySelector(".popup-details-live");
    if (liveEl) {
      const recorded = item.recordedAtTime
        ? new Date(item.recordedAtTime).toLocaleTimeString("en-GB", { timeZone: UK_TZ })
        : "Unknown time";
      liveEl.innerHTML = formatSpeedLiveHtml(
        item.speedMph,
        extra.limitMph ?? item.limitMph,
        recorded,
      );
    }
  }

  const followBtn = root.querySelector(".follow-bus-btn");
  if (followBtn) {
    const on = isFollowingMarker(marker);
    followBtn.classList.toggle("is-on", on);
    followBtn.textContent = on ? "Following" : "Follow";
  }
  return true;
}

/** Rebuild open popup / left panel only when HTML structure changed; keep scroll + fold state. */
function refreshPopup(marker, { force = false } = {}) {
  if (!marker) return;
  refreshObservedStopTimes(marker);
  refreshFirstOccupancyIfDue(marker);
  if (selectedMapMarker === marker && journeyPanelEl && !journeyPanelEl.hidden) {
    rememberNextStop(marker);
    const html = markerPopupHtml(marker);
    const structure = popupStructureKey(html);
    if (!force && structure === marker._lastPopupStructure) {
      if (patchPopupLive(marker)) {
        marker._lastPopupHtml = html;
        renderJourneyPanelStops(marker.extra?.stops || [], {
          lat: marker.getLatLng?.()?.lat,
          lng: marker.getLatLng?.()?.lng,
        });
        return;
      }
    }
    marker._lastPopupHtml = html;
    marker._lastPopupStructure = structure;
    const detailScroll = journeyPanelDetailEl?.scrollTop ?? 0;
    const stopsScroll = journeyPanelStopsEl?.scrollTop ?? 0;
    refreshBusSidePanel(marker);
    requestAnimationFrame(() => {
      if (journeyPanelDetailEl) journeyPanelDetailEl.scrollTop = detailScroll;
      if (journeyPanelStopsEl) journeyPanelStopsEl.scrollTop = stopsScroll;
    });
    if (!marker?.isPopupOpen()) return;
  }
  if (!marker?.isPopupOpen()) return;
  rememberNextStop(marker);
  const html = markerPopupHtml(marker);
  if (!html) return;
  const structure = popupStructureKey(html);
  if (!force && structure === marker._lastPopupStructure) {
    if (patchPopupLive(marker)) {
      marker._lastPopupHtml = html;
      return;
    }
  }
  if (!force && html === marker._lastPopupHtml) return;
  const root = marker.getPopup()?.getElement();
  const stopsEl = root?.querySelector(".popup-stops");
  const histEl = root?.querySelector(".popup-history-list");
  const scroll = stopsEl?.scrollTop ?? 0;
  const histScroll = histEl?.scrollTop ?? 0;
  const stopsOpen = root?.querySelector(".popup-stops-fold")?.open ?? false;
  const histOpen = root?.querySelector(".popup-history")?.open ?? false;
  marker._lastPopupHtml = html;
  marker._lastPopupStructure = structure;
  marker.setPopupContent(html);
  requestAnimationFrame(() => {
    const nextRoot = marker.getPopup()?.getElement();
    const nextStopsFold = nextRoot?.querySelector(".popup-stops-fold");
    if (nextStopsFold && stopsOpen) nextStopsFold.open = true;
    const nextHistFold = nextRoot?.querySelector(".popup-history");
    if (nextHistFold && histOpen) nextHistFold.open = true;
    const next = nextRoot?.querySelector(".popup-stops");
    if (next) next.scrollTop = scroll;
    const nextHist = nextRoot?.querySelector(".popup-history-list");
    if (nextHist) nextHist.scrollTop = histScroll;
  });
}

function moveMarkerTo(marker, lat, lng, minMeters = 1.2) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const cur = marker.getLatLng();
  if (cur && haversineMeters(cur.lat, cur.lng, lat, lng) < minMeters) return false;
  marker.setLatLng([lat, lng]);
  return true;
}

async function loadHistoryIntoMarker(marker, { force = false } = {}) {
  if (!marker) return;
  marker.extra ||= {};
  const days = Number(marker.extra.historyDays) || historyDays;
  marker.extra.historyDays = days;
  const lineFilter = historyLineFilterFor(marker);
  if (lineFilter) marker.extra.historyLineFilter = lineFilter;
  if (marker.staff && !marker.extra.trailKey) marker.extra.trailKey = staffTrailKey(marker.staff);
  let vehicleId = historyVehicleId(marker.bus, marker.extra);
  // BODS Potteries / Staffs buses use bods-… ids — look up bustimes vehicle by plate for history.
  if (!vehicleId && marker.bus && !isFlixBus(marker.bus)) {
    try {
      const resolved = await resolveBustimesVehicleForBus(marker.bus, marker.extra);
      if (resolved?.id) {
        marker.extra.btVehicle = resolved;
        marker.extra.vehicle = marker.extra.vehicle || resolved;
        marker.bus.btId = resolved.id;
        vehicleId = String(resolved.id);
      }
    } catch {
      /* optional */
    }
  }
  const trailKey =
    marker.extra.trailKey ||
    (marker.staff ? staffTrailKey(marker.staff) : "") ||
    String(marker.bus?.id || "");
  const staffLine = marker.staff ? staffLineName(marker.staff) : "";
  const atLine = isAltonLine(lineFilter)
    ? String(lineFilter).trim().toUpperCase()
    : isAltonLine(staffLine)
      ? String(staffLine).trim().toUpperCase()
      : "";
  const wantAtTrails = Boolean(
    atLine ||
      (marker.staff && isAltonLine(staffLine)) ||
      isDgBusContext(marker, marker.extra),
  );
  // Flix / NATX: merge GPS trail segments (actual roads driven) with bustimes journeys.
  const wantCoachTrails = Boolean(
    marker.bus && (isFlixBus(marker.bus) || isNationalExpress(marker.bus)),
  );
  // First Potteries (and other Staffs locals): BODS often has no reg/fleet match on
  // bustimes — merge GPS-trail run history so every tracked journey still shows + plays.
  const isStaffsBusTrail =
    !wantAtTrails &&
    !wantCoachTrails &&
    (isStaffsTrailOperator(String(marker.bus?.operator?.noc || marker.bus?.operator?.id || "")) ||
      /^bods-(FPOT|DAGC|SOST|CRDR|SLBS)-/i.test(String(marker.bus?.id || "")));
  if (!vehicleId && !wantAtTrails && !wantCoachTrails && !isStaffsBusTrail) {
    marker.extra.history = [];
    marker.extra.historyStatus = "unavailable";
    refreshPopup(marker);
    return;
  }
  const coachNoc = isNationalExpress(marker.bus) ? "NATX" : isFlixBus(marker.bus) ? "FLIX" : "";
  const busTrailNoc = isStaffsBusTrail
    ? String(
        marker.bus?.operator?.noc ||
          marker.bus?.operator?.id ||
          String(marker.bus?.id || "").match(/^bods-([A-Z]+)-/i)?.[1] ||
          "FPOT",
      ).toUpperCase()
    : "";
  const cacheKey = `${vehicleId || trailKey || "at"}:${atLine || ""}:${coachNoc || busTrailNoc}:${days}`;
  if (force) historyCache.delete(cacheKey);
  marker.extra.historyStatus = "loading";
  refreshPopup(marker);

  // Kick off every independent fetch in parallel (reg lookup, journeys, trail keys).
  // Previously these ran as a serial waterfall — 3+ round trips before first paint.
  const regForKeys =
    compactReg(
      marker.extra.btVehicle?.reg ||
        marker.extra.vehicle?.reg ||
        marker.extra.coachReg ||
        marker.bus?.vehicle?.reg ||
        busRegistration(marker.bus, marker.extra) ||
        regFromVehicleName(marker.bus?.vehicle?.name || "") ||
        String(marker.bus?.id || "").match(/^bods-[A-Z]+-([A-Z]{2}\d{2}[A-Z]{3})$/i)?.[1] ||
        "",
    ) || "";
  const resolvePromise = vehicleId
    ? Promise.resolve(marker.extra.btVehicle || marker.extra.vehicle || { id: vehicleId })
    : marker.bus && !isFlixBus(marker.bus)
      ? resolveBustimesVehicleForBus(marker.bus, marker.extra).catch(() => null)
      : Promise.resolve(null);
  const journeysPromise = vehicleId ? fetchVehicleHistory(vehicleId, days) : Promise.resolve([]);
  const trailWindow = Math.min(7, Math.max(Number(days) || 1, 1));
  const coachLine = String(lineFilter || marker.bus?.service?.line_name || "").trim();
  const trailKeysGroupPromise = (wantCoachTrails || isStaffsBusTrail) && coachLine
    ? fetchTrailKeysForGroup(
        { operators: [coachNoc || busTrailNoc || "FLIX"], lines: [coachLine] },
        { days: trailWindow },
      ).catch(() => [])
    : Promise.resolve([]);

  const resolved = await resolvePromise;
  if ((Number(marker.extra.historyDays) || historyDays) !== days) return;
  if (resolved?.id && !vehicleId) {
    marker.extra.btVehicle = resolved;
    marker.extra.vehicle = marker.extra.vehicle || resolved;
    marker.bus.btId = resolved.id;
    vehicleId = String(resolved.id);
  }
  let rowsRaw = await journeysPromise;
  if ((Number(marker.extra.historyDays) || historyDays) !== days) return;
  // AT1–AT3: merge GPS trail segments (employee journeys often missing on bustimes).
  if (wantAtTrails) {
    const reg =
      compactReg(
        marker.extra.btVehicle?.reg ||
          marker.extra.vehicle?.reg ||
          parseFleetReg(marker.staff?.vehicle?.ref).reg ||
          marker.bus?.vehicle?.reg ||
          "",
      ) || "";
    const atRows = await fetchAtHistoryFromTrails({
      trailKeys: [trailKey, vehicleId, reg ? `reg:${reg}` : ""].filter(Boolean),
      line: atLine || "",
      days,
    });
    rowsRaw = mergeAtHistoryRows(rowsRaw, atRows);
  }
  if (wantCoachTrails || isStaffsBusTrail) {
    const reg = regForKeys;
    const jny = String(marker.bus?.journey_id || marker.bus?.id || "").trim();
    const trailKeyList = [
      trailKey,
      jny,
      jny ? `jny:${jny}` : "",
      marker.bus?.id ? String(marker.bus.id) : "",
      marker.bus?.btId ? String(marker.bus.btId) : "",
      vehicleId,
      reg ? `reg:${reg}` : "",
    ].filter(Boolean);
    // BODS NATX keys: bods-NATX-<ref>
    const bodsRef = String(marker.bus?.id || "").match(/^bods-NATX-(.+)$/i)?.[1];
    if (bodsRef) {
      trailKeyList.push(`bods-NATX-${bodsRef}`, `bods-${bodsRef}`);
    }
    const trailNoc = coachNoc || busTrailNoc || "FLIX";
    // Reuse the parallel trail-keys lookup (already in flight since "loading" painted).
    const extra = await trailKeysGroupPromise;
    for (const key of extra) {
      const k = String(key || "").trim();
      if (!k) continue;
      if (k.startsWith("coach:") || k.startsWith("reg:") || k.startsWith("run:") || k.startsWith("bods-")) {
        trailKeyList.push(k);
      }
    }
    const coachRows = await fetchCoachHistoryFromTrails({
      trailKeys: [...new Set(trailKeyList)].slice(0, 24),
      line: coachLine,
      days: trailWindow,
      operator: trailNoc,
      busMode: isStaffsBusTrail,
    });
    rowsRaw = mergeAtHistoryRows(coachRows, rowsRaw);
  }
  if ((Number(marker.extra.historyDays) || historyDays) !== days) return;
  // Fast first paint: show bustimes rows the moment they're ready — don't wait for
  // the GPS merge. GPS rows are merged into the same card a moment later (below).
  if (wantCoachTrails || isStaffsBusTrail) {
    const liveBusEarly = marker.bus;
    const earlyRows = rowsRaw.map((row) => enrichJourneyRow(row, liveBusEarly));
    if (earlyRows.length) {
      marker.extra.history = earlyRows;
      marker.extra.historyStatus = "ready";
      refreshPopup(marker);
    }
  }
  const liveBus = marker.bus;
  const liveRow = liveBus
    ? liveVehicleAsHistoryRow(liveBus, {
        trailKey: trailKey || String(liveBus.id || ""),
      })
    : marker.staff && atLine
      ? enrichJourneyRow(
          {
            id: `at-live-${atLine}`,
            datetime: marker.staff.recordedAtTime || new Date().toISOString(),
            date: ukDateKey(marker.staff.recordedAtTime || Date.now()),
            route_name: atLine,
            destination:
              marker.extra.to ||
              marker.staff.currentJourney?.destination?.name ||
              "Alton Towers",
            trip_id: null,
            trailKey,
            atLive: true,
            live: true,
          },
          null,
        )
      : null;
  let enriched = rowsRaw.map((row) => enrichJourneyRow(row, liveBus));
  // Prefer live AVL row when the current journey is diverted / missing from history.
  if (liveRow) {
    enriched = mergeLiveHistoryRow(enriched, liveRow);
  }
  marker.extra.history = enriched;
  const keepStokeFc =
    isFirstPotteriesContext(marker, marker.extra) ||
    isStokeFcLine(marker.extra.historyLineFilter || lineFilter);
  let visible = filterHistoryByLine(enriched, marker.extra.historyLineFilter || lineFilter, {
    keepStokeFc,
  });
  // If the current line has no rows yet (bus just changed route), show the full
  // vehicle history rather than an empty "unavailable" card.
  if (!visible.length && enriched.length && marker.extra.historyLineFilter) {
    marker.extra.historyLineFilter = "";
    visible = enriched;
  }
  marker.extra.historyStatus = enriched.length ? "ready" : "empty";
  refreshPopup(marker);
  // Prefetch GPS so History · Map has the current overnight trail ready.
  const hydrateKeys = trailKeysForVehicle({
    vehicleId,
    trailKey,
    reg:
      compactReg(
        marker.extra.btVehicle?.reg ||
          marker.extra.vehicle?.reg ||
          marker.bus?.vehicle?.reg ||
          busRegistration(marker.bus || {}, marker.extra) ||
          "",
      ) || "",
    line: lineFilter || marker.bus?.service?.line_name || "",
    datetime: marker.bus?.datetime || new Date().toISOString(),
  });
  fetchServerTrails(hydrateKeys, { force: false }).catch(() => {});
}

async function enrichBustimes(eventOrMarker) {
  const marker = eventOrMarker?.target || eventOrMarker;
  const bus = marker?.bus;
  if (!bus || !marker) return;
  const gen = (marker._enrichGen = (marker._enrichGen || 0) + 1);
  marker.extra ||= {};
  marker.extra.historyDays ||= historyDays;
  // Historical rows are loaded only when a history/replay control is opened.
  // The normal live card only needs current vehicle and trip enrichment.
  rememberTrailVehicle(bus.id);
  // Load saved GPS tail so History · Map / Follow arrows work for locals and coaches.
  marker.extra.trailKey = marker.extra.trailKey || String(bus.id || "");
  if (isFlixBus(bus)) marker.extra.operatorNoc = "FLIX";
  if (isNationalExpress(bus)) marker.extra.operatorNoc = "NATX";
  const trailHydrate = hydrateLiveTrailFromServer(String(bus.id)).catch(() => {});
  trailHydrate.then(() => {
    if (gen !== marker._enrichGen) return;
    refreshObservedStopTimes(marker, { force: true });
    if (selectedMapMarker === marker || marker.isPopupOpen?.()) refreshPopup(marker);
  });
  const ll = marker.getLatLng();
  marker.extra.limitMph = resolveLimitMph(bus, marker.extra, ll.lat, ll.lng);
  ensureMarkerSpeedLimit(marker);
  const [ends, vehicleFromId] = await Promise.all([
    // Only real trip ids — journey_id is not a trip (NATX BODS often has journey, not trip).
    bus.trip_id ? tripEnds(bus.trip_id, { date: bus.date || "" }) : Promise.resolve(null),
    isLikelyBustimesVehicleId(bus, bus.btId || bus.id)
      ? vehicleDetails(bus.btId || bus.id)
      : null,
  ]);
  if (gen !== marker._enrichGen) return;
  let vehicle = vehicleFromId;
  // BODS / NATX / locals: resolve bustimes vehicle by plate so history + Map work.
  if (!vehicle && !isFlixBus(bus)) {
    try {
      vehicle = await resolveBustimesVehicleForBus(bus, marker.extra);
    } catch {
      vehicle = null;
    }
  }
  if (gen !== marker._enrichGen) return;
  if (ends) {
    marker.extra.from = ends.from;
    marker.extra.to = ends.to || bus.destination;
    marker.extra.stops = ends.stops || [];
    marker.extra._observedStopSig = "";
    marker.extra._nextStopIdx = undefined;
    if (ends.operator) marker.extra.operator = ends.operator;
    marker.extra.tripId = bus.trip_id || marker.extra.tripId || "";
    marker.extra.tripDate = ends.date || bus.date || "";
    marker.extra.tripStartMs = ends.startMs;
    marker.extra.tripEndMs = ends.endMs;
    // Start the live seat lookup as soon as this trip's stops are available;
    // do not make the open card wait for the remaining vehicle/history requests.
    refreshFirstOccupancyIfDue(marker);
    marker.extra.delaySec = resolveLiveDelaySec(
      bus,
      { ...marker.extra, stops: ends.stops, delaySec: ends.delaySec },
      ll.lat,
      ll.lng,
      { live: isFollowingMarker(marker) || selectedMapMarker === marker },
    );
    marker.extra._tripDelayFreshAt = Date.now();
    marker._tripDelayAt = Date.now();
  }
  refreshObservedStopTimes(marker, { force: true });
  if (vehicle) {
    marker.extra.vehicle = vehicle;
    marker.extra.btVehicle = marker.extra.btVehicle || vehicle;
    if (vehicle.id != null) bus.btId = vehicle.id;
  }
  // Prefer plate from NATX-style vehicle.name when AVL omits .reg
  const plate = busRegistration(bus, marker.extra);
  if (plate && !marker.extra.vehicle?.reg) {
    marker.extra.coachReg = plate;
    if (marker.extra.vehicle && !marker.extra.vehicle.reg) {
      marker.extra.vehicle = { ...marker.extra.vehicle, reg: plate };
    }
  }
  // Flix / NATX hide plates on the live map — try BODS VehicleRef → bustimes reg.
  if (!marker.extra.vehicle?.reg && !marker.extra.coachReg && (isFlixBus(bus) || isNationalExpress(bus))) {
    try {
      const coach = await resolveCoachRegFromBods(bus, marker.extra, ll.lat, ll.lng);
      if (gen !== marker._enrichGen) return;
      if (coach?.reg) marker.extra.coachReg = coach.reg;
      if (coach?.vehicle) {
        marker.extra.vehicle = coach.vehicle;
        marker.extra.btVehicle = coach.vehicle;
      }
    } catch {
      /* optional */
    }
  }
  refreshPopup(marker);
  const dgVehicle = String(bus.id).startsWith("dg-")
    ? await dgVehicleDetails(bus.vehicle?.name)
    : await dgVehicleFromBt(vehicle);
  if (gen !== marker._enrichGen) return;
  if (dgVehicle) marker.extra.dgVehicle = dgVehicle;
  fetchLimitNear(ll.lat, ll.lng, marker.extra.limitMph).then((limit) => {
    if (gen !== marker._enrichGen) return;
    if (!Number.isFinite(limit) || limit <= 0) return;
    marker.extra.limitMph = limit;
    if (marker.bus) marker.bus.limitMph = limit;
    if (marker.staff) marker.staff.limitMph = limit;
    refreshPopup(marker);
  });
  refreshPopup(marker);
  if (isFollowingMarker(marker)) updateFollowChip();
  followJourney(marker, true);
  loadPhotoIntoMarker(marker);
}

function staffPopup(item, extra = {}, { omitStops = false, sidePanel = false } = {}) {
  const journey = item.currentJourney || {};
  const line = staffLineName(item) || "AT";
  const route = extra.route || {};
  const inbound = (journey.directionRef || "").toLowerCase() === "inbound";
  const origin = route.origin || "";
  const dest = route.destination || "";
  const from = extra.from || (inbound ? dest : origin);
  const to = extra.to || (inbound ? origin : dest);
  const via = Array.isArray(route.via) && route.via.length ? `Via ${route.via.join(", ")}` : "";
  const parsed = parseFleetReg(item.vehicle?.ref);
  const dg = extra.vehicle || {};
  const size =
    dg.size === "singleDecker" ? "Single" : dg.size === "doubleDecker" ? "Double" : "";
  const recorded = item.recordedAtTime
    ? new Date(item.recordedAtTime).toLocaleTimeString("en-GB", { timeZone: UK_TZ })
    : "Unknown time";
  const trailKey = extra.trailKey || staffTrailKey(item);
  const popupExtra = { ...extra, trailKey, line };
  void omitStops;

  return `
    <div class="popup-card${sidePanel ? " is-side-panel" : ""}">
      <div class="popup-top">
        <div class="popup-line">${esc(line)}</div>
      </div>
      <div class="popup-title popup-nis">Alton Towers employee-only service</div>
      ${routeBlock(from, to)}
      ${via ? `<div class="popup-meta">${esc(via)}</div>` : ""}
      <div class="popup-actions">
        ${followButtonHtml({ staff: item })}
        ${playStaffRouteButtonHtml(item, popupExtra)}
      </div>
      ${photoBlock(popupExtra, {
        reg: parsed.reg || extra.btVehicle?.reg || "",
        fleet: parsed.fleet || "",
        operator: "D&G Bus",
      })}
      <div class="popup-details">
        <div>${[
          parsed.fleet ? esc(`#${parsed.fleet}`) : "",
          fleetRegButtonHtml(parsed.reg || extra.btVehicle?.reg || "", {
            fleet: parsed.fleet || "",
            vehicleId: extra.btVehicle?.id || "",
          }) || (parsed.reg ? esc(parsed.reg) : ""),
          esc("D&G Bus"),
          esc(extra.liveryName || ""),
          esc(size),
        ]
          .filter(Boolean)
          .join(" · ")}</div>
        <div class="popup-details-live">${formatSpeedLiveHtml(item.speedMph, extra.limitMph ?? item.limitMph, recorded)}</div>
      </div>
    </div>
  `;
}

async function enrichStaff(eventOrMarker) {
  const marker = eventOrMarker?.target || eventOrMarker;
  const item = marker?.staff;
  if (!item || !marker) return;
  const gen = (marker._enrichGen = (marker._enrichGen || 0) + 1);
  marker.extra ||= {};
  marker.extra.historyDays ||= historyDays;
  marker.extra.trailKey = staffTrailKey(item);
  rememberTrailVehicle(marker.extra.trailKey);
  const line = staffLineName(item);
  const inbound = (item.currentJourney?.directionRef || "").toLowerCase() === "inbound";
  const ll = marker.getLatLng();
  marker.extra.limitMph = item.limitMph ?? nearestRoadLimit(ll.lat, ll.lng);
  const [routes, destStop, vehicle] = await Promise.all([
    getStaffRoutes(),
    stopDetails(item.currentJourney?.destination?.atcocode),
    dgVehicleDetails(item.vehicle?.ref),
  ]);
  if (gen !== marker._enrichGen) return;
  marker.extra.route = routes.get(line) || {};
  const origin = marker.extra.route.origin || "";
  const dest = marker.extra.route.destination || "";
  marker.extra.from = inbound ? dest : origin;
  marker.extra.to = destStop?.name || (inbound ? origin : dest);
  marker.extra.vehicle = vehicle;
  marker.extra.dgVehicle = vehicle;
  refreshPopup(marker);
  const parsed = parseFleetReg(item.vehicle?.ref);
  let btVehicle = await bustimesVehicleByReg(parsed.reg, { fleet: parsed.fleet, operator: "DAGC" });
  if (!btVehicle && (parsed.reg || parsed.fleet)) {
    btVehicle = await bustimesVehicleByReg(parsed.reg, { fleet: parsed.fleet });
  }
  if (gen !== marker._enrichGen) return;
  if (btVehicle) marker.extra.btVehicle = btVehicle;
  marker.extra.liveryName = btVehicle?.livery?.name || marker.extra.liveryName || "";
  // Historical rows are fetched on demand by the history/replay controls.
  fetchLimitNear(ll.lat, ll.lng, marker.extra.limitMph).then((limit) => {
    if (gen !== marker._enrichGen) return;
    if (!Number.isFinite(limit) || limit <= 0) return;
    marker.extra.limitMph = limit;
    if (marker.bus) marker.bus.limitMph = limit;
    if (marker.staff) marker.staff.limitMph = limit;
    refreshPopup(marker);
  });
  refreshPopup(marker);
  followJourney(marker, true);
  loadPhotoIntoMarker(marker);
}

let altonLoadBusy = false;
let altonLoadGen = 0;

async function loadAltonTowers() {
  if (historyMapFocus()) {
    applyHistoryMapFocusToLiveMarkers();
    return;
  }
  if (altonLoadBusy) return;
  const gen = ++altonLoadGen;
  altonLoadBusy = true;
  try {
    const response = await fetch(
      "/api/dg-vehicles?regionId=526&showBusesNotInService=true",
    );
    if (!response.ok) throw new Error(`Alton Towers feed ${response.status}`);
    if (gen !== altonLoadGen) return;
    const data = await response.json();
    if (gen !== altonLoadGen) return;
    const items = data.items || [];
    const seen = new Set();

    for (const item of items) {
      const lat = Number(item.positioning?.latitude);
      const lng = Number(item.positioning?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (isStalePing(item.recordedAtTime)) continue;
      const id = item.vehicle?.ref || item.vehicle?.vehicleUniqueId;
      if (!id) continue;
      if (dgIsNotInService(item)) continue;
      if (!ALTON_LINES.has(staffLineName(item))) continue;
      const existing = staffMarkers.get(id);
      const incomingAt = item.recordedAtTime ? new Date(item.recordedAtTime).getTime() : 0;
      const existingAt = existing?.staff?.recordedAtTime
        ? new Date(existing.staff.recordedAtTime).getTime()
        : 0;
      seen.add(id);
      if (existing && incomingAt && existingAt && incomingAt + 1_000 < existingAt) continue;
      const line = staffLineName(item);
      const heading = Number(item.positioning?.bearing);
      item.speedMph = updateMotion(`staff-${id}`, lat, lng, item.recordedAtTime);
      const snapped = staffWhere(item);
      item.limitMph = snapped.limitMph ?? nearestRoadLimit(snapped.lat, snapped.lng);
      recordStaffTrail(existing || { staff: item, extra: {} }, snapped.lat, snapped.lng, snapped.heading, {
        t: item.recordedAtTime ? new Date(item.recordedAtTime).getTime() || Date.now() : Date.now(),
      });
      const livery = existing?.staffLivery || brandLiveryForLine(line);
      if (existing) {
        existing.staff = item;
        existing.line = line;
        if (!existing._sideSelectBound) {
          existing._sideSelectBound = true;
          try {
            existing.unbindPopup();
          } catch {
            /* ignore */
          }
          existing.off("popupopen");
          existing.on("click", () => selectMapMarker(existing));
        }
        moveMarkerTo(existing, snapped.lat, snapped.lng);
        const iconKey = `${line}|${Math.round(snapped.heading || 0)}|${speedBucket(item.speedMph)}|${liveryCss(livery) || ""}`;
        if (existing._iconKey !== iconKey) {
          existing._iconKey = iconKey;
          existing.setIcon(staffIcon(line, snapped.heading, livery, item.speedMph));
        }
        if (selectedMapMarker === existing || existing.isPopupOpen?.() || isFollowingMarker(existing)) {
          refreshPopup(existing);
        }
        if (existing === announceFollow) announceJourney(existing);
        keepFollowedInView(existing);
      } else {
        const marker = L.marker([snapped.lat, snapped.lng], {
          icon: staffIcon(line, snapped.heading, livery, item.speedMph),
          zIndexOffset: 1500,
        });
        marker.staff = item;
        marker.line = line;
        marker.staffLivery = livery;
        marker.extra = { trailKey: staffTrailKey(item), historyDays };
        marker._sideSelectBound = true;
        marker.on("click", () => selectMapMarker(marker));
        staffLayer.addLayer(marker);
        staffMarkers.set(id, marker);
      }
      staffLivery(item).then((next) => {
        const marker = staffMarkers.get(id);
        if (!marker || !next) return;
        marker.staffLivery = next;
        const snap = staffWhere(marker.staff);
        marker.setIcon(staffIcon(marker.line, snap.heading, next, marker.staff?.speedMph));
      });
    }

    for (const [id, marker] of staffMarkers) {
      if (!seen.has(id)) {
        if (selectedMapMarker === marker) {
          selectedMapMarker = null;
          if (!playback) hideJourneyPanel();
        }
        staffLayer.removeLayer(marker);
        staffMarkers.delete(id);
        if (announceFollow === marker) announceFollow = null;
        if (isFollowingMarker(marker)) stopFollowBus("Lost live position for that bus");
        motion.delete(`staff-${id}`);
      }
    }
    revealPendingFocus();
  } catch {
    // Keep the rest of the map working if the D&G feed is down.
  } finally {
    if (gen === altonLoadGen) altonLoadBusy = false;
  }
}

function dropServiceBus(id) {
  const marker = markers.get(id);
  if (!marker) return;
  if (selectedMapMarker === marker) {
    selectedMapMarker = null;
    if (!playback) hideJourneyPanel();
  }
  if (announceFollow === marker) announceFollow = null;
  if (isFollowingMarker(marker)) stopFollowBus("Lost live position for that bus");
  cluster.removeLayer(marker);
  markers.delete(id);
}

function busFeedTime(bus) {
  const value = bus?.datetime ? new Date(bus.datetime).getTime() : NaN;
  return Number.isFinite(value) ? value : 0;
}

function isBackwardPositionJump(existing, bus, snapped) {
  if (!existing || !Number.isFinite(Number(bus?.coordinates?.[1])) || !Number.isFinite(snapped?.heading)) return false;
  const incomingAt = busFeedTime(bus);
  const previousAt = busFeedTime(existing.bus);
  if (!incomingAt || !previousAt || incomingAt <= previousAt) return false;
  const dtSec = (incomingAt - previousAt) / 1000;
  if (dtSec > 20) return false;
  const previous = existing.getLatLng?.();
  if (!previous) return false;
  const distance = haversineMeters(previous.lat, previous.lng, snapped.lat, snapped.lng);
  if (distance < 180) return false;
  const bearing = segmentBearing([previous.lat, previous.lng], [snapped.lat, snapped.lng]);
  return angleDiff(bearing, snapped.heading) > 120;
}

function upsertLiveBus(bus, snapped) {
  const existing = markers.get(bus.id);
  const incomingAt = busFeedTime(bus);
  const existingAt = busFeedTime(existing?.bus);
  // Do not let a slower/out-of-order upstream response move a marker back to
  // an older GPS point. The next poll will replace it when a newer ping arrives.
  if (existing && incomingAt && existingAt && incomingAt + 1_000 < existingAt) return existing;
  const reg =
    busRegistration(bus, existing?.extra || {}) ||
    existing?.extra?.vehicle?.reg ||
    bus.vehicle?.reg ||
    "";
  const trailMeta = {
    journeyId: bus.journey_id,
    tripId: bus.trip_id,
    line: bus.service?.line_name || "",
    operator: trailOperatorForBus(bus),
    direction: bus.direction || bus.directionRef || "",
    destination: bus.destination || "",
    t: bus.datetime ? new Date(bus.datetime).getTime() || Date.now() : Date.now(),
    reg,
  };
  const [rawLng, rawLat] = bus.coordinates || [];
  const recordLat = Number.isFinite(Number(rawLat)) ? Number(rawLat) : snapped.lat;
  const recordLng = Number.isFinite(Number(rawLng)) ? Number(rawLng) : snapped.lng;
  // Store the feed's real position, never the short forward coast used to smooth
  // the moving marker; coasting must not make the recorded tail run ahead.
  // Ordinary viewers only retain the selected/followed/pinned vehicle; the
  // server recorder owns the full seven-day history.
  if (shouldRecordClientTrail(bus.id, trailMeta)) {
    recordVehicleTrail(bus.id, recordLat, recordLng, snapped.heading, trailMeta);
    const btId = bus.btId ?? bus.vehicle?.id;
    if (btId != null && String(btId) !== String(bus.id) && /^\d+$/.test(String(btId))) {
      recordVehicleTrail(String(btId), recordLat, recordLng, snapped.heading, {
        ...trailMeta,
        _force: true,
      });
    }
  }
  if (existing) {
    existing.bus = bus;
    if (!existing._sideSelectBound) {
      existing._sideSelectBound = true;
      try {
        existing.unbindPopup();
      } catch {
        /* ignore */
      }
      existing.off("popupopen");
      existing.on("click", () => selectMapMarker(existing));
    }
    moveMarkerTo(existing, snapped.lat, snapped.lng);
    const iconKey = busIconKey(bus, snapped.heading, bus.speedMph);
    if (existing._iconKey !== iconKey) {
      existing._iconKey = iconKey;
      existing.setIcon(busIcon(bus, snapped.heading));
    }
    // Keep early/late moving while the card is open (trip predictions refresh ~15–25s).
    scheduleTripDelayRefresh(existing);
    const [blng, blat] = bus.coordinates || [];
    if (existing.extra) {
      existing.extra.delaySec = resolveLiveDelaySec(bus, existing.extra, blat, blng, {
        live: isFollowingMarker(existing) || selectedMapMarker === existing,
      });
      const limit = resolveLimitMph(bus, existing.extra, blat, blng);
      if (Number.isFinite(limit)) {
        existing.extra.limitMph = limit;
        bus.limitMph = limit;
      } else {
        ensureMarkerSpeedLimit(existing);
      }
    }
    refreshPopup(existing);
    if (isFollowingMarker(existing)) updateFollowChip();
    if (existing === announceFollow) announceJourney(existing);
    keepFollowedInView(existing);
    return existing;
  }
  const marker = L.marker([snapped.lat, snapped.lng], { icon: busIcon(bus, snapped.heading) });
  marker.bus = bus;
  marker.extra = {};
  if (!marker._sideSelectBound) {
    marker._sideSelectBound = true;
    try {
      marker.unbindPopup();
    } catch {
      /* ignore */
    }
    marker.off("popupopen");
    marker.on("click", () => selectMapMarker(marker));
  }
  cluster.addLayer(marker);
  markers.set(bus.id, marker);
  return marker;
}

async function loadBuses({ replace = false } = {}) {
  if (!liveMapActive()) return;
  const zoom = map.getZoom();
  const overStaffs = mapOverlapsStaffordshire();
  const histFocus = historyMapFocus();
  // Never skip fetching because of History · Map hideAll — that left Staffordshire
  // empty after tails until a full refresh. Fetch always; only hide pins while focused.
  const showLocal = zoom >= MIN_ZOOM || overStaffs;
  const showCoach = zoom >= FLIX_MIN_ZOOM;
  // Small force-op set only — nationwide TBTN/DIAM feeds crush nginx + kill paint.
  const staffsOpList = overStaffs
    ? STAFFS_FORCE_OPS
    : showLocal
      ? ["FPOT", "DAGC"]
      : [];

  if (histFocus?.hideAll) {
    hint.hidden = false;
    hint.textContent = "History map · live buses hidden · pan or press ✕ to restore";
  } else if (histFocus?.journeyOnly) {
    hint.hidden = false;
    hint.textContent = "Journey map";
  } else {
    hint.hidden = true;
  }

  if (!showLocal && !showCoach && !staffsOpList.length) {
    cluster.clearLayers();
    markers.clear();
    if (followTarget) stopFollowBus();
    hint.hidden = false;
    hint.textContent = "Search a place or zoom in to a town to see live buses";
    return;
  }

  pruneStaleMarkers();

  if (busesBusy && !replace) return;
  const gen = ++busesGen;
  if (inflight) inflight.abort();
  busesBusy = true;
  inflight = new AbortController();
  const { signal } = inflight;

  const bounds = map.getBounds().pad(0.08);
  const params = new URLSearchParams({
    xmin: bounds.getWest().toFixed(5),
    ymin: bounds.getSouth().toFixed(5),
    xmax: bounds.getEast().toFixed(5),
    ymax: bounds.getNorth().toFixed(5),
  });
  const paintViewKey = `${map.getZoom()}|${bounds
    .getWest()
    .toFixed(2)}|${bounds.getSouth().toFixed(2)}|${bounds.getEast().toFixed(2)}|${bounds
    .getNorth()
    .toFixed(2)}`;

  try {
    showMessage("");
    // Paint from bustimes.org for every UK viewport (bbox). Staffs operator
    // extras only fill overnight / sparse AVL gaps — never replace bbox paint.
    const staffsPaintOps = overStaffs ? ["FPOT", "DAGC", "CRDR", "SLBS"] : [];
    const coachPaintOps = ["NATX", "FLIX"];
    // Paint is a slow-changing dataset. Keep the first load immediate, then
    // debounce map moves/repeated polls so one viewport does not fan out into
    // several paint requests every six seconds.
    const paintAgeMs = lastPaintAt ? Date.now() - lastPaintAt : Infinity;
    const paintRequestAgeMs = lastPaintRequestAt ? Date.now() - lastPaintRequestAt : Infinity;
    const paintViewChanged = paintViewKey !== lastPaintViewKey;
    const staffsNeedPaint =
      overStaffs &&
      [...markers.values()].some(
        (m) =>
          m?.bus &&
          STAFFS_LIVE_OPS.includes(
            String(m.bus.operator?.noc || m.bus._bods?.operator || "").toUpperCase(),
          ) &&
          !hasNumericBustimesLivery(m.bus),
      );
    const paintDue =
      !lastPaintBuses.length ||
      paintAgeMs >= PAINT_REFRESH_MS ||
      (paintViewChanged && paintAgeMs >= PAINT_MOVE_REFRESH_MS);
    const paintRetryAllowed =
      !Number.isFinite(paintRequestAgeMs) ||
      paintRequestAgeMs >= (paintViewChanged ? 10_000 : 30_000);
    const wantPaint =
      paintRetryAllowed && (paintDue || (staffsNeedPaint && paintAgeMs >= PAINT_STAFF_RETRY_MS));
    if (wantPaint) {
      lastPaintRequestAt = Date.now();
      lastPaintViewKey = paintViewKey;
    }
    const safeJson = async (res) => {
      if (!res || !res.ok) return [];
      try {
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    };
    // Position polls abort each other every ~7s — paint must NOT share that signal
    // or bustimes.org liveries never finish loading (Staffs stayed on brand stripes).
    const safeFetch = (url) => fetch(url, { signal }).catch(() => null);
    const paintFetch = (url) => fetch(url).catch(() => null);

    const [localRes, flixBuses, natxBuses, staffsOpFeeds, paintRes, ...extraPaintRes] =
      await Promise.all([
        showLocal ? safeFetch(`/api/vehicles?${params}`) : Promise.resolve(null),
        showCoach ? fetchFlixBuses(signal) : Promise.resolve([]),
        showCoach ? fetchNatxBuses(signal) : Promise.resolve([]),
        staffsOpList.length
          ? Promise.all(
              staffsOpList.map((op) =>
                fetchBodsVehicles(`operator=${encodeURIComponent(op)}`, signal),
              ),
            )
          : Promise.resolve([]),
        wantPaint && showLocal
          ? paintFetch(`/api/bt-paint?${params}`)
          : Promise.resolve(null),
        ...(wantPaint && overStaffs && staffsPaintOps.length
          ? staffsPaintOps.map((op) =>
              paintFetch(`/api/bt-paint?operator=${encodeURIComponent(op)}`),
            )
          : []),
        // Coach paint fetched separately below — not mixed into local paintById.
      ]);
    // Coach paint in a second wave so it never blocks / contaminates local liveries.
    let coachPaintRes = [];
    if (wantPaint && showCoach) {
      coachPaintRes = await Promise.all(
        coachPaintOps.map((op) =>
          paintFetch(`/api/bt-paint?operator=${encodeURIComponent(op)}`),
        ),
      );
    }
    if (signal.aborted || gen !== busesGen) return;
    if (showLocal && (!localRes || !localRes.ok)) return;
    let localBuses = await safeJson(localRes);
    // /api/vehicles already returns the same parsed BODS snapshot for normal
    // operators, including SIRI velocity. Reuse it for the OOS fallback rather
    // than downloading and parsing the identical bbox a second time.
    const bodsLive = { vehicles: localBuses, ok: Boolean(localRes?.ok) };

    let paintBuses = lastPaintBuses;
    let coachPaintBuses = lastCoachPaintBuses;
    if (wantPaint) {
      const paintById = new Map();
      // Keep prior paint on partial failure so liveries don't flash off.
      for (const row of lastPaintBuses) {
        if (row?.id != null) paintById.set(row.id, row);
      }
      for (const res of [paintRes, ...extraPaintRes]) {
        if (!res?.ok) continue;
        try {
          const pdata = await res.json();
          if (!Array.isArray(pdata)) continue;
          for (const row of pdata) {
            if (row?.id != null) paintById.set(row.id, row);
          }
        } catch {
          /* ignore */
        }
      }
      paintBuses = [...paintById.values()];
      if (paintBuses.length) {
        lastPaintBuses = paintBuses;
        lastPaintAt = Date.now();
      }

      const coachById = new Map();
      for (const row of lastCoachPaintBuses) {
        if (row?.id != null) coachById.set(row.id, row);
      }
      for (const res of coachPaintRes) {
        if (!res?.ok) continue;
        try {
          const pdata = await res.json();
          if (!Array.isArray(pdata)) continue;
          for (const row of pdata) {
            if (row?.id != null) coachById.set(row.id, row);
          }
        } catch {
          /* ignore */
        }
      }
      const nextCoachPaint = [...coachById.values()];
      if (nextCoachPaint.length || !lastCoachPaintBuses.length) {
        lastCoachPaintBuses = nextCoachPaint;
      }
      coachPaintBuses = lastCoachPaintBuses;
    }

    const byId = new Map();
    for (const bus of localBuses) {
      if (!showLocal && !isFlixBus(bus) && !isNationalExpress(bus)) continue;
      byId.set(bus.id, bus);
    }
    for (const bus of flixBuses) byId.set(bus.id, bus);
    for (const bus of natxBuses) byId.set(bus.id, bus);

    if (staffsOpList.length) {
      const oosPool = [];
      const opFeeds = Array.isArray(staffsOpFeeds) ? staffsOpFeeds : [];
      for (const pool of opFeeds) {
        if (!pool?.ok) continue;
        for (const bus of pool.vehicles || []) {
          if (!bus?.id || !Array.isArray(bus.coordinates)) continue;
          if (!byId.has(bus.id)) byId.set(bus.id, bus);
        }
        oosPool.push(...(pool.vehicles || []));
      }
      if (!oosPool.length && bodsLive?.ok) oosPool.push(...(bodsLive.vehicles || []));
      mergeTicketerOosFromBods(byId, oosPool);
    }

    if (paintBuses.length || coachPaintBuses.length) {
      const locals = [];
      const coaches = [];
      for (const bus of byId.values()) {
        if (isFlixBus(bus) || isNationalExpress(bus)) coaches.push(bus);
        else locals.push(bus);
      }
      const paintedLocals = paintBuses.length
        ? paintBodsWithBustimesLiveries(locals, paintBuses)
        : locals;
      const paintedCoaches = coachPaintBuses.length
        ? paintBodsWithBustimesLiveries(coaches, coachPaintBuses)
        : coaches;
      byId.clear();
      for (const bus of paintedLocals) byId.set(bus.id, bus);
      for (const bus of paintedCoaches) byId.set(bus.id, bus);
    }

    const live = [];
    const seenService = new Set();
    const viewPad = bounds.pad(overStaffs ? 0.55 : 0.35);

    for (const bus of byId.values()) {
      const [lng, lat] = bus.coordinates || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (isStalePing(bus.datetime, stalePingLimitMs(bus))) continue;
      const coach = isFlixBus(bus) || isNationalExpress(bus);
      if (!showLocal && !coach) continue;
      if (!showCoach && coach) continue;
      // Operator-wide feeds include whole fleets — keep pins near the viewport.
      if (!coach && !viewPad.contains([lat, lng])) continue;
      if (histFocus?.journeyOnly && !busMatchesHistoryFocus(bus, {}, histFocus)) continue;
      if (histFocus?.hideAll) continue;
      if (isNotInService(bus)) {
        if (!isOperatorOutOfServiceBus(bus)) {
          dropServiceBus(bus.id);
          continue;
        }
        bus.nis = true;
        if (isTicketerDeadRun(bus)) {
          bus.deadRun = true;
          if (!isPassengerServiceLine(bus.service?.line_name)) {
            bus.service = { ...(bus.service || {}), line_name: "DEAD_RUN" };
          }
        }
        if (isStokeDepotBound(bus)) bus.depotOos = true;
      }
      bus.speedMph = resolveBusSpeedMph(`bus-${bus.id}`, bus, lat, lng, bus.datetime);
      // Temporary brand colour only — never replace a bustimes numeric livery id.
      // ensureLiveries loads left_css from bustimes.org for every matched id.
      if (!hasNumericBustimesLivery(bus)) {
        const resolvedLiv = resolveBusLivery(bus);
        if (!liveryCss(resolvedLiv)) {
          const brand = fleetLiveryForBus(bus) || brandLiveryForBus(bus);
          if (brand?.left_css || brand?.left) {
            bus.vehicle = {
              ...(bus.vehicle || {}),
              colour:
                bus.vehicle?.colour &&
                bus.vehicle.colour !== "#2563eb" &&
                !isNearWhite(bus.vehicle.colour)
                  ? bus.vehicle.colour
                  : brand.colour,
              livery: brand,
            };
          }
        }
      } else if (isNearWhite(bus.vehicle?.colour)) {
        // Solid brand tint only until bustimes CSS arrives — do not attach brand left_css.
        const brand = brandLiveryForBus(bus);
        if (brand?.colour && !isNearWhite(brand.colour)) {
          bus.vehicle = { ...(bus.vehicle || {}), colour: brand.colour };
        }
      }
      const snapped = liveWhere(bus);
      bus.limitMph = snapped.limitMph ?? nearestRoadLimit(snapped.lat, snapped.lng);
      live.push({ bus, snapped });
    }

    // Give cached/quick livery responses a short head start so the first map
    // paint already has the real CSS. Never wait indefinitely for Bustimes.
    const liveryReady = ensureLiveries(live.map((row) => row.bus)).catch(() => {});
    await Promise.race([
      liveryReady,
      new Promise((resolve) => setTimeout(resolve, 700)),
    ]);
    liveryReady.then(() => {
      if (gen !== busesGen) return;
      for (const marker of markers.values()) {
        const bus = marker.bus;
        if (!bus) continue;
        const heading = Number.isFinite(Number(bus.heading)) ? Number(bus.heading) : 0;
        const iconKey = busIconKey(bus, heading, bus.speedMph);
        if (marker._iconKey === iconKey) continue;
        marker._iconKey = iconKey;
        marker.setIcon(busIcon(bus, heading));
      }
    });

    for (const { bus, snapped } of live) {
      seenService.add(bus.id);
      upsertLiveBus(bus, snapped);
    }
    for (const [id, marker] of markers) {
      const coach = isFlixBus(marker.bus) || isNationalExpress(marker.bus);
      const keep =
        seenService.has(id) && !isStalePing(marker.bus?.datetime, stalePingLimitMs(marker.bus));
      const allowed =
        (showLocal || coach) &&
        (showCoach || !coach) &&
        !histFocus?.hideAll &&
        !(histFocus?.journeyOnly && !markerMatchesHistoryFocus(marker, histFocus));
      if (!keep || !allowed) {
        dropServiceBus(id);
        motion.delete(`bus-${id}`);
      }
    }
    revealPendingFocus();

    // If Staffs view came back empty after a replace, retry once shortly
    // (common after leaving history tails or a blippy BODS poll).
    if (overStaffs && !histFocus?.hideAll && live.length < 3 && replace) {
      setTimeout(() => {
        if (mapOverlapsStaffordshire()) loadBuses({ replace: true }).catch(() => {});
      }, 2500);
    }

    ensureSnapRoads(signal)
      .then(() => {
        if (signal.aborted) return;
        for (const marker of markers.values()) {
          const bus = marker.bus;
          if (!bus?.coordinates) continue;
          const [lng, lat] = bus.coordinates;
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
          const snapped = liveWhere(bus);
          bus.limitMph = snapped.limitMph ?? nearestRoadLimit(snapped.lat, snapped.lng);
          if (Number.isFinite(bus.limitMph) && marker.extra) marker.extra.limitMph = bus.limitMph;
          moveMarkerTo(marker, snapped.lat, snapped.lng);
          const iconKey = busIconKey(bus, snapped.heading, bus.speedMph);
          if (marker._iconKey !== iconKey) {
            marker._iconKey = iconKey;
            marker.setIcon(busIcon(bus, snapped.heading));
          }
          if (selectedMapMarker === marker || isFollowingMarker(marker)) refreshPopup(marker);
          keepFollowedInView(marker);
        }
        for (const marker of staffMarkers.values()) {
          const item = marker.staff;
          if (!item?.positioning) continue;
          const snapped = staffWhere(item);
          moveMarkerTo(marker, snapped.lat, snapped.lng);
          const iconKey = `${marker.line}|${Math.round(snapped.heading || 0)}|${speedBucket(item.speedMph)}|${liveryCss(marker.staffLivery) || ""}`;
          if (marker._iconKey !== iconKey) {
            marker._iconKey = iconKey;
            marker.setIcon(staffIcon(marker.line, snapped.heading, marker.staffLivery, item.speedMph));
          }
          keepFollowedInView(marker);
        }
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
      });
  } catch (error) {
    if (error.name === "AbortError") return;
    pruneStaleMarkers();
    // Keep existing pins on transient errors — blanking Staffs on every blip is worse.
    if (!markers.size) showMessage(error.message);
  } finally {
    if (gen === busesGen) busesBusy = false;
  }
}

function refreshAltonIfRelevant() {
  if (!liveMapActive()) return;
  if (!mapOverlapsStaffordshire() && !staffMarkers.size) return;
  loadAltonTowers().catch(() => {});
}

function liveMapActive() {
  return appTab === "map" && !document.hidden;
}

function stopLiveSchedule() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (coastTimer) {
    clearInterval(coastTimer);
    coastTimer = null;
  }
  if (inflight) {
    inflight.abort();
    inflight = null;
  }
  busesGen += 1;
  busesBusy = false;
  liveScheduleRunning = false;
}

function schedule() {
  if (!liveMapActive() || liveScheduleRunning) return;
  liveScheduleRunning = true;
  loadBuses({ replace: true }).catch(() => {});
  refreshAltonIfRelevant();
  timer = setInterval(() => {
    if (!liveMapActive()) {
      stopLiveSchedule();
      return;
    }
    pruneStaleMarkers();
    loadBuses().catch(() => {});
    refreshAltonIfRelevant();
  }, BUS_POLL_MS);
  // Coasting is currently disabled because replacing feed objects discarded its
  // state and caused marker snap-back. Do not pay for a no-op 1 Hz loop.
  if (COAST_MAX_M > 0) coastTimer = setInterval(advanceLiveMarkers, 1000);
}

function syncLiveSchedule() {
  if (liveMapActive()) schedule();
  else stopLiveSchedule();
}

map.on("moveend", () => {
  saveMapView();
  applyMapDayNight();
  // Follow pans must not thrash vehicle reloads — that rebuilds the open bus card.
  if (followPanning || followTarget) {
    return;
  }
  // Panning/zooming must NOT clear History · Map / tails — the user is still looking at that
  // journey, and the trails live in their own layers. This used to call exitHistoryMapMode(),
  // which stopped playback and wiped every pinned trail on the first pan (Staffs "stuck blank").
  // Restoring live buses only needs a reload: loadBuses() consults historyMapFocus() itself and
  // the history layers (playbackLayer / pinned trail lines) are untouched by a bus reload.
  clearTimeout(map._loadTimer);
  map._loadTimer = setTimeout(() => {
    loadBuses({ replace: true });
  }, 120);
  scheduleMapStops();
  refreshAltonIfRelevant();
});

function stopAtcoFromFeature(feature) {
  const url = feature?.properties?.url || "";
  const match = String(url).match(/\/stops\/([^/?#]+)/);
  return match?.[1] || "";
}

function formatStopClock(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: UK_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const stopTimesCache = new Map();

async function fetchStopTimes(atco) {
  if (!atco) return [];
  const cached = stopTimesCache.get(atco);
  if (cached && Date.now() - cached.at < 45000) return cached.times;
  try {
    const res = await fetch(`/api/stop-times/${encodeURIComponent(atco)}`);
    if (!res.ok) throw new Error(`times ${res.status}`);
    const data = await res.json();
    const times = Array.isArray(data.times) ? data.times : [];
    stopTimesCache.set(atco, { at: Date.now(), times });
    return times;
  } catch {
    return cached?.times || [];
  }
}

function upcomingStopDepartures(times, limit = 5) {
  const now = Date.now() - 60_000;
  return (times || [])
    .map((row) => {
      const liveWhen = row.expected_departure_time || row.live_departure_time || "";
      const when =
        liveWhen ||
        row.aimed_departure_time ||
        row.aimed_arrival_time ||
        "";
      return {
        line: row.service?.line_name || "?",
        dest: row.destination?.name || row.destination?.locality || "",
        when,
        ms: when ? new Date(when).getTime() : NaN,
        live: Boolean(liveWhen),
        calling: row.trip?.destination?.name || "",
      };
    })
    .filter((row) => Number.isFinite(row.ms) && row.ms >= now)
    .sort((a, b) => a.ms - b.ms)
    .slice(0, limit);
}

function stopBoardRowsHtml(times, status = "") {
  if (status === "loading") {
    return `<div class="stop-board-loading">Loading departures…</div>`;
  }
  return stopBoardRowsFromUpcoming(upcomingStopDepartures(times, 6));
}

/** Stoke-on-Trent unitary area (NaPTAN 3890) + geographic fallback. */
function isStopInStokeOnTrent(feature) {
  const atco = stopAtcoFromFeature(feature) || "";
  if (/^3890/i.test(atco)) return true;
  const coords = feature?.geometry?.coordinates;
  const lng = Number(coords?.[0]);
  const lat = Number(coords?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  // Approximate Stoke-on-Trent UA bbox (six towns + Sideway stadium)
  return lat >= 52.96 && lat <= 53.08 && lng >= -2.24 && lng <= -2.1;
}

function stopBoardIsStoke() {
  return document.getElementById("stop-board")?.classList.contains("is-stoke");
}

function applyStopBoardTheme(feature) {
  const panel = document.getElementById("stop-board");
  if (!panel) return false;
  const stoke = isStopInStokeOnTrent(feature);
  panel.classList.toggle("is-stoke", stoke);
  return stoke;
}

function stopBoardRowsFromUpcoming(upcoming) {
  if (!upcoming?.length) return "";
  const stoke = stopBoardIsStoke();
  return upcoming
    .map((row, index) => {
      const mins = Math.round((row.ms - Date.now()) / 60_000);
      if (!stoke) {
        const timeLabel =
          mins <= 0
            ? "Due"
            : row.liveEst || row.atEmployee
              ? `${mins} min`
              : formatStopClock(row.when) || "—";
        const dueClass = timeLabel === "Due" ? " is-due" : "";
        return `<div class="stop-board-row" role="listitem">
          <div class="stop-board-row-main">
            <span class="stop-board-line">${esc(row.line)}</span>
            <span class="stop-board-due${dueClass}">${esc(timeLabel)}</span>
          </div>
        </div>`;
      }
      const timeLabel =
        mins <= 0
          ? "Due"
          : row.liveEst || row.atEmployee
            ? `est ${mins} min`
            : formatStopClock(row.when) || "—";
      const ico = row.live
        ? `<span class="stop-board-ico stop-board-ico-live" title="Real-time"></span>`
        : `<span class="stop-board-ico stop-board-ico-clock" title="Scheduled"></span>`;
      const calling =
        index === 0 && row.calling && !row.atEmployee && !row.scfcShuttle
          ? `<div class="stop-board-calling">Calling at: ${esc(row.calling)}</div>`
          : "";
      const dueClass = timeLabel === "Due" ? " is-due" : "";
      const atTag = row.atEmployee ? ` <span class="stop-board-at-tag">AT</span>` : "";
      const scfcTag = row.scfcShuttle ? ` <span class="stop-board-scfc-tag">SCFC</span>` : "";
      return `<div class="stop-board-row" role="listitem">
        <div class="stop-board-row-main">
          <span class="stop-board-line">${esc(row.line)}${atTag}${scfcTag}</span>
          <div class="stop-board-dest-wrap">
            <span class="stop-board-dest" title="${esc(row.dest)}">${esc(row.dest || "—")}</span>
            ${calling}
          </div>
          <span class="stop-board-due${dueClass}">${ico}<span>${esc(timeLabel)}</span></span>
        </div>
      </div>`;
    })
    .join("");
}

function setStopBoardCover(mode) {
  const cover = document.getElementById("stop-board-cover");
  const text = cover?.querySelector(".stop-board-cover-text");
  const main = document.querySelector(".stop-board-main");
  if (!cover || !text) return;
  if (mode === "loading") {
    cover.hidden = true;
    main?.classList.remove("is-empty");
    return;
  }
  if (mode === "empty") {
    text.textContent = stopBoardIsStoke()
      ? "Sorry, no services currently running from this stop"
      : "No services currently running from this stop";
    cover.hidden = false;
    main?.classList.add("is-empty");
    return;
  }
  cover.hidden = true;
  main?.classList.remove("is-empty");
}

function syncStopBoardClock() {
  const now = new Date();
  const label = now.toLocaleTimeString("en-GB", {
    timeZone: UK_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const iso = now.toISOString();
  for (const id of ["stop-board-clock", "stop-board-clock-stoke"]) {
    const clockEl = document.getElementById(id);
    if (!clockEl) continue;
    clockEl.dateTime = iso;
    clockEl.textContent = label;
  }
}

function closeStopBoard() {
  stopBoardAtco = "";
  stopBoardFeature = null;
  clearInterval(stopBoardRefreshTimer);
  clearInterval(stopBoardClockTimer);
  stopBoardRefreshTimer = null;
  stopBoardClockTimer = null;
  const panel = document.getElementById("stop-board");
  if (panel) {
    panel.hidden = true;
    panel.classList.remove("is-stoke");
  }
}

function staffMarkerList() {
  return [...staffMarkers.values()];
}

function busMarkerList() {
  return [...markers.values()];
}

function mergeStopDepartures(times, feature, atco) {
  const atStop =
    feature?.atStop ||
    atStopByAtco(atco) ||
    (feature?.properties?.atEmployee
      ? { lat: feature.geometry?.coordinates?.[1], lng: feature.geometry?.coordinates?.[0], lines: feature.properties?.atLines || feature.properties?.services || [] }
      : null);
  const scfcStop =
    feature?.scfcStop ||
    scfcStopByAtco(atco) ||
    (feature?.properties?.scfcShuttle
      ? {
          lat: feature.geometry?.coordinates?.[1],
          lng: feature.geometry?.coordinates?.[0],
          lines: feature.properties?.scfcLines || feature.properties?.services || [],
          name: feature.properties?.name,
          label: feature.properties?.name,
          atco,
        }
      : null);
  const publicRows = upcomingStopDepartures(times, 8);
  const atRows = atStop ? atLiveDeparturesForStop(atStop, staffMarkerList(), { limit: 6 }) : [];
  const scfcLive = scfcStop ? scfcLiveDeparturesForStop(scfcStop, busMarkerList(), { limit: 6 }) : [];
  const scfcSched = scfcStop ? scfcScheduledDeparturesForStop(scfcStop, { limit: 6 }) : [];
  const merged = [...scfcLive, ...atRows, ...scfcSched, ...publicRows].sort((a, b) => a.ms - b.ms);
  // Prefer live SCFC/AT rows when both exist for same minute, keep unique line+dest+minute
  const seen = new Set();
  const out = [];
  for (const row of merged) {
    const key = `${row.line}|${row.dest}|${Math.round(row.ms / 60000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= 8) break;
  }
  return out;
}

async function refreshStopBoard(force = false) {
  const panel = document.getElementById("stop-board");
  const rowsEl = document.getElementById("stop-board-rows");
  const statusEl = document.getElementById("stop-board-status");
  const nameEl = document.getElementById("stop-board-name");
  const railNameEl = document.getElementById("stop-board-rail-name");
  if (!panel || !rowsEl || !stopBoardFeature) return;

  applyStopBoardTheme(stopBoardFeature);
  const props = stopBoardFeature.properties || {};
  const stopName = props.name || "Bus stop";
  if (nameEl) nameEl.textContent = stopName;
  if (railNameEl) railNameEl.textContent = stopName;

  if (force || !rowsEl.children.length) {
    rowsEl.innerHTML = stopBoardRowsHtml([], "loading");
    setStopBoardCover("loading");
  }
  if (statusEl) statusEl.textContent = "Updating…";

  if (force) stopTimesCache.delete(stopBoardAtco);
  const times = stopBoardAtco ? await fetchStopTimes(stopBoardAtco) : [];
  if (stopBoardFeature !== null && panel.hidden === false) {
    const upcoming = mergeStopDepartures(times, stopBoardFeature, stopBoardAtco);
    rowsEl.innerHTML = stopBoardRowsFromUpcoming(upcoming);
    setStopBoardCover(upcoming.length ? "ready" : "empty");
    if (statusEl) {
      const at = upcoming.some((row) => row.atEmployee);
      const scfc = upcoming.some((row) => row.scfcShuttle);
      statusEl.textContent = upcoming.length
        ? at && scfc
          ? "Live departures · AT + Stoke City FC shuttles"
          : at
            ? "Live departures · includes AT employee services"
            : scfc
              ? "Live departures · includes Stoke City FC shuttles"
              : "Live departures"
        : "No services currently running from this stop";
    }
  }
  syncStopBoardClock();
}

function openStopBoard(feature) {
  if (!stopBoardOn) return;
  const panel = document.getElementById("stop-board");
  if (!panel) return;
  stopBoardFeature = feature;
  stopBoardAtco = stopAtcoFromFeature(feature);
  applyStopBoardTheme(feature);
  panel.hidden = false;
  clearInterval(stopBoardRefreshTimer);
  clearInterval(stopBoardClockTimer);
  refreshStopBoard(true).catch(() => {});
  stopBoardRefreshTimer = setInterval(() => {
    refreshStopBoard(true).catch(() => {});
  }, 30_000);
  stopBoardClockTimer = setInterval(syncStopBoardClock, 1000);
  syncStopBoardClock();
}

function setStopBoardEnabled(on) {
  stopBoardOn = Boolean(on);
  localStorage.setItem(STOP_BOARD_KEY, stopBoardOn ? "1" : "0");
  const toggle = document.getElementById("stop-board-toggle");
  if (toggle) toggle.checked = stopBoardOn;
  if (!stopBoardOn) closeStopBoard();
}

function stopDeparturesHtml(upcomingOrTimes, status = "", { merged = false } = {}) {
  if (status === "loading") {
    return `<div class="stop-popup-meta">Loading next buses…</div>`;
  }
  const upcoming = merged ? upcomingOrTimes || [] : upcomingStopDepartures(upcomingOrTimes);
  if (!upcoming.length) {
    return `<div class="stop-popup-meta">No upcoming departures</div>`;
  }
  return `<div class="stop-popup-deps">${upcoming
    .map((row) => {
      const mins = Math.round((row.ms - Date.now()) / 60_000);
      const time =
        row.atEmployee || row.liveEst
          ? mins <= 0
            ? "Due"
            : `est ${mins} min`
          : formatStopClock(row.when) || "—";
      const tag = row.atEmployee ? " · AT" : row.scfcShuttle ? " · SCFC" : "";
      return `<div class="stop-popup-dep">
        <span class="stop-popup-line">${esc(row.line)}${tag}</span>
        <span class="stop-popup-dest" title="${esc(row.dest)}">${esc(row.dest || "—")}</span>
        <span class="stop-popup-time">${esc(time)}</span>
      </div>`;
    })
    .join("")}</div>`;
}

function stopPopupHtml(feature, times = null, status = "", upcoming = null) {
  const props = feature?.properties || {};
  const name = props.name || "Bus stop";
  const indicator = props.indicator || "";
  const atStop = feature?.atStop || atStopByAtco(stopAtcoFromFeature(feature));
  const scfcStop = feature?.scfcStop || scfcStopByAtco(stopAtcoFromFeature(feature));
  const atLines = [...new Set((atStop?.lines || props.atLines || []).map((l) => String(l).toUpperCase()))];
  const scfcLines = [
    ...new Set(
      (scfcStop?.lines || props.scfcLines || [])
        .map((l) => normalizeStokeFcLine(l) || String(l).toUpperCase())
        .filter(Boolean),
    ),
  ];
  const atSet = new Set(atLines);
  const scfcSet = new Set(scfcLines);
  const fromProps = Array.isArray(props.services) ? props.services : [];
  const fromTimes = (times || [])
    .map((row) => row.service?.line_name || row.line_name || "")
    .filter(Boolean);
  const fromUpcoming = (upcoming || []).map((row) => row.line || "").filter(Boolean);
  const allLines = [];
  const seen = new Set();
  for (const raw of [...scfcLines, ...atLines, ...fromProps, ...fromTimes, ...fromUpcoming]) {
    const line = String(raw).trim();
    if (!line) continue;
    const key = line.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    allLines.push(line);
  }
  allLines.sort((a, b) => {
    const aScfc = scfcSet.has(normalizeStokeFcLine(a) || a.toUpperCase()) ? 0 : 1;
    const bScfc = scfcSet.has(normalizeStokeFcLine(b) || b.toUpperCase()) ? 0 : 1;
    if (aScfc !== bScfc) return aScfc - bScfc;
    const aAt = atSet.has(a.toUpperCase()) ? 0 : 1;
    const bAt = atSet.has(b.toUpperCase()) ? 0 : 1;
    if (aAt !== bAt) return aAt - bAt;
    return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
  });
  const servicesHtml = allLines.length
    ? `<div class="stop-popup-services">${allLines
        .map((line) => {
          const isAt = atSet.has(line.toUpperCase());
          const isScfc = scfcSet.has(normalizeStokeFcLine(line) || line.toUpperCase());
          return `<span class="stop-popup-route${isScfc ? " stop-popup-scfc" : isAt ? " stop-popup-at" : ""}">${esc(line)}</span>`;
        })
        .join("")}</div>`
    : "";
  const boardPrompt = stopBoardOn
    ? `<div class="stop-board-prompt"><span class="stop-board-prompt-text">Virtual board is on — click the stop again to refresh.</span></div>`
    : `<div class="stop-board-prompt"><button type="button" class="stop-board-enable" data-stop-board-enable>Show virtual bus stop board</button></div>`;
  const deps =
    status === "loading"
      ? stopDeparturesHtml(null, "loading")
      : stopDeparturesHtml(upcoming || times, "", { merged: Boolean(upcoming) });
  return `
    <div class="stop-popup">
      <div class="stop-popup-name">${esc(name)}</div>
      ${indicator ? `<div class="stop-popup-meta">${esc(indicator)}</div>` : ""}
      ${servicesHtml}
      ${deps}
      ${boardPrompt}
    </div>
  `;
}

function scheduleMapStops() {
  clearTimeout(stopsLoadTimer);
  stopsLoadTimer = setTimeout(() => {
    loadMapStops().catch(() => {});
  }, 160);
}

async function loadMapStops() {
  if (!stopsOn) {
    if (stopsAbort) stopsAbort.abort();
    stopsAbort = null;
    stopsLayer.clearLayers();
    if (map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer);
    return;
  }
  if (!map.hasLayer(stopsLayer)) map.addLayer(stopsLayer);
  if (map.getZoom() < STOPS_MIN_ZOOM) {
    stopsLayer.clearLayers();
    return;
  }

  const bounds = map.getBounds().pad(0.02);
  const params = new URLSearchParams({
    ymin: String(bounds.getSouth()),
    ymax: String(bounds.getNorth()),
    xmin: String(bounds.getWest()),
    xmax: String(bounds.getEast()),
  });
  if (stopsAbort) stopsAbort.abort();
  stopsAbort = new AbortController();
  const { signal } = stopsAbort;
  try {
    const res = await fetch(`/api/stops-geo?${params}`, { signal });
    if (!res.ok) throw new Error(`Stops ${res.status}`);
    const data = await res.json();
    if (signal.aborted) return;
    const features = Array.isArray(data.features) ? data.features : [];
    stopsLayer.clearLayers();
    const seenAtco = new Set();
    let count = 0;

    const addStopMarker = (feature, { at = false, scfc = false } = {}) => {
      const coords = feature?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      if (!bounds.contains([lat, lng])) return;
      const special = at || scfc;
      const marker = L.circleMarker([lat, lng], {
        radius: map.getZoom() >= 16 ? (special ? 6 : 5) : special ? 5 : 4,
        color: scfc ? "#9f1239" : at ? "#4c1d95" : "#0f172a",
        weight: 1,
        fillColor: scfc ? "#e03c31" : at ? "#a78bfa" : "#38bdf8",
        fillOpacity: 0.95,
        className: scfc
          ? "map-stop-marker map-stop-scfc"
          : at
            ? "map-stop-marker map-stop-at"
            : "map-stop-marker",
      });
      marker.feature = feature;
      marker.bindPopup(() => stopPopupHtml(feature, null, "loading"), {
        maxWidth: 320,
        className: "bus-popup",
      });
      marker.on("click", () => {
        if (stopBoardOn) openStopBoard(feature);
      });
      marker.on("popupopen", async () => {
        if (stopBoardOn) openStopBoard(feature);
        const atco = stopAtcoFromFeature(feature);
        const times = atco ? await fetchStopTimes(atco) : [];
        if (!marker.isPopupOpen()) return;
        const upcoming = mergeStopDepartures(times, feature, atco);
        marker.setPopupContent(stopPopupHtml(feature, times, "", upcoming));
      });
      marker.addTo(stopsLayer);
      count += 1;
    };

    for (const feature of features) {
      if (count >= STOPS_MAX) break;
      const atco = stopAtcoFromFeature(feature);
      if (atco) seenAtco.add(atco);
      const atMeta = atco ? atStopByAtco(atco) : null;
      const scfcMeta = atco ? scfcStopByAtco(atco) : null;
      if (atMeta || scfcMeta) {
        feature.properties = {
          ...(feature.properties || {}),
          ...(atMeta
            ? {
                atEmployee: true,
                atLines: atMeta.lines,
              }
            : {}),
          ...(scfcMeta
            ? {
                scfcShuttle: true,
                scfcLines: scfcMeta.lines,
              }
            : {}),
          services: [
            ...new Set([
              ...(feature.properties?.services || []),
              ...(atMeta?.lines || []),
              ...(scfcMeta?.lines || []).map((l) => normalizeStokeFcLine(l) || l),
            ]),
          ],
        };
        if (atMeta) feature.atStop = atMeta;
        if (scfcMeta) feature.scfcStop = scfcMeta;
      }
      addStopMarker(feature, { at: Boolean(atMeta), scfc: Boolean(scfcMeta) });
    }

    for (const stop of atStopsInBounds(bounds)) {
      if (count >= STOPS_MAX + 80) break;
      if (stop.atco && seenAtco.has(stop.atco)) continue;
      addStopMarker(atFeatureFromStop(stop), { at: true });
    }

    for (const stop of scfcStopsInBounds(bounds)) {
      if (count >= STOPS_MAX + 100) break;
      if (stop.atco && seenAtco.has(stop.atco)) continue;
      seenAtco.add(stop.atco);
      addStopMarker(scfcFeatureFromStop(stop), { scfc: true });
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    // Keep previous stops if a refresh fails.
  }
}

function setStopsVisible(on) {
  stopsOn = Boolean(on);
  localStorage.setItem(STOPS_KEY, stopsOn ? "1" : "0");
  if (!stopsOn) closeStopBoard();
  scheduleMapStops();
}

function compactQuery(value) {
  return String(value || "").replace(/[\s._-]+/g, "").toUpperCase();
}

function stripVehiclePrefix(raw) {
  return String(raw || "")
    .replace(/^(bus|coach|vehicle|fleet|reg|vrm)\s+/i, "")
    .trim();
}

function looksLikeUkReg(raw) {
  const c = compactQuery(stripVehiclePrefix(raw));
  if (c.length < 5 || c.length > 8) return false;
  // Current style: AB12CDE
  if (/^[A-Z]{2}\d{2}[A-Z]{3}$/.test(c)) return true;
  // Prefix style: A123BCD / A12BCD
  if (/^[A-Z]\d{1,3}[A-Z]{3}$/.test(c)) return true;
  // Older numeric-leading: 1234ABC / 123ABC
  if (/^\d{1,4}[A-Z]{3}$/.test(c)) return true;
  // Older letter-leading: ABC1234 / AB1234
  if (/^[A-Z]{1,3}\d{1,4}$/.test(c)) return true;
  return false;
}

function extractRegFromText(value) {
  const text = String(value || "").toUpperCase();
  const compact = compactQuery(text);
  const patterns = [
    /\b([A-Z]{2}\d{2}\s*[A-Z]{3})\b/,
    /\b([A-Z]\d{1,3}\s*[A-Z]{3})\b/,
    /\b(\d{1,4}\s*[A-Z]{3})\b/,
    /\b([A-Z]{1,3}\d{1,4})\b/,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return compactQuery(m[1]);
  }
  if (looksLikeUkReg(compact)) return compact;
  return "";
}

function isVehicleQuery(raw) {
  const t = raw.trim();
  if (/^(bus|coach|vehicle|fleet|reg|vrm)\b/i.test(t)) return true;
  if (looksLikeUkReg(t)) return true;
  const c = compactQuery(t);
  if (/^AT[1-3]$/i.test(t)) return true;
  if (/^\d{4,6}$/.test(c)) return true;
  if (/^\d{1,3}$/.test(t)) return true;
  if (/^\d{1,3}[A-Z]$/i.test(t)) return true;
  if (/^[A-Z]{1,2}\d{1,3}$/i.test(t) && t.length <= 5) return true;
  return false;
}

function markerSearchText(marker) {
  if (marker.bus) {
    const bus = marker.bus;
    return [bus.service?.line_name, bus.vehicle?.name, bus.vehicle?.url, bus.id].join(" ");
  }
  if (marker.staff) {
    const parsed = parseFleetReg(marker.staff.vehicle?.ref);
    return [staffLineName(marker.staff), parsed.fleet, parsed.reg, marker.staff.vehicle?.ref].join(" ");
  }
  return "";
}

function nearestMarker(list) {
  const center = map.getCenter();
  return list
    .slice()
    .sort((a, b) => a.getLatLng().distanceTo(center) - b.getLatLng().distanceTo(center))[0];
}

function findOnMap(query) {
  const q = compactQuery(stripVehiclePrefix(query));
  if (!q) return null;
  const wantReg = looksLikeUkReg(q) ? compactQuery(q) : "";

  const staffExact = [...staffMarkers.values()].filter(
    (marker) => compactQuery(marker.line || staffLineName(marker.staff)) === q,
  );
  if (staffExact.length) return nearestMarker(staffExact);

  const lineExact = [...markers.values()].filter(
    (marker) => compactQuery(marker.bus?.service?.line_name) === q,
  );
  if (lineExact.length && !wantReg) return nearestMarker(lineExact);

  const identity = [];
  for (const marker of [...staffMarkers.values(), ...markers.values()]) {
    if (marker.staff) {
      const parsed = parseFleetReg(marker.staff.vehicle?.ref);
      const staffReg = compactQuery(parsed.reg) || extractRegFromText(marker.staff.vehicle?.ref);
      if (wantReg && staffReg === wantReg) identity.push(marker);
      else if (!wantReg && (staffReg === q || compactQuery(parsed.fleet) === q)) identity.push(marker);
      continue;
    }
    const name = compactQuery(marker.bus?.vehicle?.name);
    const busReg =
      extractRegFromText(marker.bus?.vehicle?.name) ||
      compactQuery(marker.bus?.vehicle?.reg);
    const detailReg = compactQuery(marker.extra?.vehicle?.reg || marker.extra?.btVehicle?.reg);
    if (wantReg) {
      if (busReg === wantReg || detailReg === wantReg || (name && name.includes(wantReg))) {
        identity.push(marker);
      }
      continue;
    }
    if (busReg && busReg === q) {
      identity.push(marker);
      continue;
    }
    if (!name) continue;
    if (name === q || (q.length >= 5 && name.includes(q))) identity.push(marker);
  }
  return identity.length ? nearestMarker(identity) : null;
}

function focusMarker(marker) {
  if (!marker) return;
  hint.hidden = true;
  marker.setZIndexOffset(4000);
  const latlng = marker.getLatLng();
  map.setView(latlng, Math.max(map.getZoom(), 16));
  marker.openPopup();
}

function revealPendingFocus() {
  if (!pendingFocus) return;
  const marker =
    pendingFocus.kind === "staff"
      ? staffMarkers.get(pendingFocus.id)
      : markers.get(pendingFocus.id);
  if (!marker) return;
  focusMarker(marker);
  pendingFocus = null;
}

async function getLiveIndex() {
  if (liveIndex && Date.now() - liveIndexAt < 25000) return liveIndex;
  const res = await fetch("/api/vehicles?xmin=-8.2&ymin=49.8&xmax=1.85&ymax=60.9");
  if (!res.ok) throw new Error("Could not search live vehicles");
  liveIndex = await res.json();
  liveIndexAt = Date.now();
  return liveIndex;
}

function busMatchesQuery(bus, vehicle, query) {
  const q = compactQuery(stripVehiclePrefix(query));
  const wantReg = looksLikeUkReg(q) ? q : extractRegFromText(q);
  const name = compactQuery(bus.vehicle?.name);
  const nameReg = extractRegFromText(bus.vehicle?.name);
  const url = String(bus.vehicle?.url || "").toLowerCase();
  const line = compactQuery(bus.service?.line_name);
  const vehicleReg = compactQuery(vehicle?.reg || vehicle?.previous_reg);
  const vehicleFleet = compactQuery(vehicle?.fleet_code || vehicle?.fleet_number);

  if (wantReg) {
    if (nameReg === wantReg) return true;
    if (vehicleReg && vehicleReg === wantReg && (name.includes(wantReg) || nameReg === wantReg)) return true;
    if (name.includes(wantReg)) return true;
    if (vehicle?.slug && url.includes(String(vehicle.slug).toLowerCase())) return true;
    return false;
  }

  if (vehicle?.slug && url.includes(String(vehicle.slug).toLowerCase())) return true;
  if (vehicleReg && name.includes(vehicleReg)) return true;
  if (vehicleFleet && name.includes(vehicleFleet)) return true;
  if (q && line === q) return true;
  return Boolean(q && q.length >= 5 && (name.includes(q) || url.includes(q.toLowerCase())));
}

async function searchBustimesVehicle(query) {
  const q = stripVehiclePrefix(query);
  const plate = looksLikeUkReg(q) ? compactQuery(q) : extractRegFromText(q);
  if (plate) {
    const byReg = await bustimesVehicleByReg(plate);
    if (byReg) return byReg;
  }
  try {
    const params = new URLSearchParams({
      search: plate || compactQuery(q),
      withdrawn: "false",
      limit: "40",
    });
    if (plate) params.set("reg", plate);
    const res = await fetch(`/api/bt-vehicles/?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const results = data?.results || [];
    return (
      pickBustimesVehicle(results, { reg: plate || q, fleet: plate ? "" : q }) ||
      results.find((row) => compactQuery(row.reg) === plate) ||
      results[0] ||
      null
    );
  } catch {
    return null;
  }
}

async function searchVehicleRemote(query) {
  const q = stripVehiclePrefix(query);
  if (/^AT[1-3]$/i.test(q)) {
    await loadAltonTowers();
    const staff = findOnMap(q);
    if (staff) {
      focusMarker(staff);
      return true;
    }
    showMessage(`${q.toUpperCase()} is not tracking live`);
    return true;
  }

  const local = findOnMap(query);
  if (local) {
    focusMarker(local);
    return true;
  }

  showMessage(looksLikeUkReg(q) ? "Finding registration…" : "Finding vehicle…");
  const vehicle = await searchBustimesVehicle(q);
  const plate = compactQuery(vehicle?.reg) || (looksLikeUkReg(q) ? compactQuery(q) : extractRegFromText(q));

  let live = [];
  try {
    live = await getLiveIndex();
  } catch (error) {
    showMessage(error.message || "Could not search live vehicles");
    return true;
  }

  let match =
    live.find((bus) => busMatchesQuery(bus, vehicle, q)) ||
    (plate
      ? live.find((bus) => {
          const nameReg = extractRegFromText(bus.vehicle?.name);
          const name = compactQuery(bus.vehicle?.name);
          return nameReg === plate || name.includes(plate);
        })
      : null);

  // If bustimes gave an id, try a direct live lookup too.
  if (!match?.coordinates && vehicle?.id != null) {
    try {
      const res = await fetch(`/api/vehicles?id=${encodeURIComponent(vehicle.id)}`);
      if (res.ok) {
        const rows = await res.json();
        const list = Array.isArray(rows) ? rows : [];
        match = list.find((bus) => bus?.coordinates) || list[0] || null;
      }
    } catch {
      // Keep the nationwide live-index result.
    }
  }

  if (!match?.coordinates) {
    showMessage(
      vehicle
        ? `${vehicle.reg || vehicle.fleet_code || "Vehicle"} is not tracking live`
        : looksLikeUkReg(q)
          ? `No live bus found for ${compactQuery(q)}`
          : "Vehicle not found",
    );
    return true;
  }
  showMessage("");
  pendingFocus = { kind: "bus", id: match.id };
  const [lng, lat] = match.coordinates;
  map.setView([lat, lng], 16);
  await loadBuses({ replace: true });
  revealPendingFocus();
  return true;
}

const SNAP_CLASSES = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "unclassified",
  "living_street",
  "service",
  "busway",
  "minor",
  "road",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
]);
const MAX_SNAP_M = 110;
const JUNCTION_M = 18;
let ofmTileTemplate = null;
const decodedTileCache = new Map();
let snapRoads = [];
let snapRoadsKey = "";
let snapRoadsAt = 0;
const motion = new Map();

function roadsForSnap() {
  // ensureSnapRoads() already decodes only the current viewport. Reusing that
  // array avoids rebuilding/scanning every cached tile on each marker update.
  return snapRoads;
}

function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x, y };
}

function tilesForBounds(bounds, z) {
  const nw = lngLatToTile(bounds.getWest(), bounds.getNorth(), z);
  const se = lngLatToTile(bounds.getEast(), bounds.getSouth(), z);
  const tiles = [];
  const x0 = Math.min(nw.x, se.x);
  const x1 = Math.max(nw.x, se.x);
  const y0 = Math.min(nw.y, se.y);
  const y1 = Math.max(nw.y, se.y);
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      tiles.push({ z, x, y });
    }
  }
  return tiles;
}

function geoJsonToLatLngs(gj) {
  const type = gj?.geometry?.type;
  const coords = gj?.geometry?.coordinates;
  if (!coords) return [];
  if (type === "LineString") return [coords.map(([lng, lat]) => [lat, lng])];
  if (type === "MultiLineString") return coords.map((line) => line.map(([lng, lat]) => [lat, lng]));
  return [];
}

function roadBBox(latlngs) {
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const [lat, lng] of latlngs) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

function distPointToSegmentMeters(p, a, b) {
  return closestOnSegment(p, a, b).dist;
}

function segmentBearing(a, b) {
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function closestOnSegment(p, a, b) {
  const cos = Math.cos((p[0] * Math.PI) / 180);
  const ax = (a[1] - p[1]) * cos * 111320;
  const ay = (a[0] - p[0]) * 110540;
  const bx = (b[1] - p[1]) * cos * 111320;
  const by = (b[0] - p[0]) * 110540;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2)) : 0;
  return {
    lat: a[0] + (b[0] - a[0]) * t,
    lng: a[1] + (b[1] - a[1]) * t,
    dist: Math.hypot(ax + dx * t, ay + dy * t),
    bearing: segmentBearing(a, b),
  };
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const r = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dLat = p2 - p1;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

function updateMotion(id, lat, lng, iso) {
  const at = iso ? new Date(iso).getTime() : Date.now();
  const prev = motion.get(id);
  // BODS and the paint feed can arrive out of order. Never let an older ping
  // replace the newer motion/speed baseline used by marker smoothing.
  if (prev && iso && Number.isFinite(at) && Number.isFinite(prev.at) && at < prev.at - 1_000) {
    return Number.isFinite(prev.speedMph) ? prev.speedMph : null;
  }
  let speedMph = prev?.speedMph;
  if (prev && Number.isFinite(at) && at > prev.at) {
    const dt = (at - prev.at) / 1000;
    if (dt >= 5 && dt <= 180) {
      const mph = (haversineMeters(prev.lat, prev.lng, lat, lng) / dt) * 2.23694;
      let next = mph < 1.2 ? 0 : mph;
      if (next > 80) next = Number.isFinite(speedMph) ? speedMph : 80;
      speedMph = Number.isFinite(speedMph) ? speedMph * 0.45 + next * 0.55 : next;
    }
  }
  motion.set(id, { lat, lng, at, speedMph });
  return speedMph;
}

/** Read a speed only when the feed actually provided a value (not Number(null)→0). */
function readProvidedSpeedMph(...candidates) {
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0 && v <= 90) return v;
  }
  return null;
}

/** Prefer GPS velocity from BODS SIRI-VM when the operator sends it; else estimate from pings. */
function feedSpeedMph(bus) {
  return readProvidedSpeedMph(bus?.feedSpeedMph, bus?._bods?.velocityMph);
}

function resolveBusSpeedMph(key, bus, lat, lng, iso) {
  const motionMph = updateMotion(key, lat, lng, iso);
  const feed = feedSpeedMph(bus);
  if (feed == null) return motionMph;
  const prev = motion.get(key);
  if (prev) motion.set(key, { ...prev, speedMph: feed });
  return feed;
}

/** Copy BODS SIRI Velocity onto matching Bustimes vehicles for the live card. */
function attachFeedSpeedFromBods(btBuses, bodsBuses) {
  const bodsList = Array.isArray(bodsBuses) ? bodsBuses : [];
  if (!bodsList.length) return btBuses;
  for (const bt of btBuses || []) {
    if (!bt || isFlixBus(bt)) continue;
    let best = null;
    let bestScore = 0;
    let bestFeed = null;
    for (const bods of bodsList) {
      const feed = readProvidedSpeedMph(bods.speedMph, bods._bods?.velocityMph);
      if (feed == null) continue;
      const score = liveBusMatchScore(bods, bt);
      if (score > bestScore) {
        best = bods;
        bestScore = score;
        bestFeed = feed;
      }
    }
    if (!best || bestScore < 18 || bestFeed == null) continue;
    bt.feedSpeedMph = bestFeed;
    bt._bods = { ...(bt._bods || {}), ...(best._bods || {}), velocityMph: bestFeed };
  }
  return btBuses;
}

function destinationPoint(lat, lng, bearingDeg, meters) {
  const R = 6371000;
  const br = (Number(bearingDeg) * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const ang = meters / R;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(br),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(br) * Math.sin(ang) * Math.cos(lat1),
      Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: (lat2 * 180) / Math.PI, lng: (lng2 * 180) / Math.PI };
}

function coastAlongMeters(ageMs, speedMph) {
  if (
    !(
      ageMs >= COAST_MIN_AGE_MS &&
      ageMs <= COAST_MAX_AGE_MS &&
      Number.isFinite(speedMph) &&
      speedMph >= 4
    )
  ) {
    return 0;
  }
  return Math.min(COAST_MAX_M, speedMph * 0.44704 * (Math.min(ageMs, 5000) / 1000));
}

/**
 * Brief coast between live pings. Once AVL stops updating, freeze at the last
 * shown position so markers do not keep jumping forward (or snap back).
 */
function applyLiveCoast(holder, lat, lng, heading, ageMs, speedMph, pingKey) {
  if (holder._coastPing !== pingKey) {
    holder._coastPing = pingKey;
    holder._heldPos = null;
    holder._coastFrozen = false;
  }

  const meters = coastAlongMeters(ageMs, speedMph);
  const coasting = meters > 0;
  const snapped = keepOnRoad(holder, lat, lng, heading, meters);

  if (coasting || ageMs < COAST_MIN_AGE_MS) {
    holder._heldPos = {
      lat: snapped.lat,
      lng: snapped.lng,
      heading: snapped.heading,
      limitMph: snapped.limitMph,
    };
    holder._coastFrozen = false;
    return { ...snapped, coasting, stalled: false };
  }

  if (holder._heldPos) {
    holder._coastFrozen = true;
    return {
      lat: holder._heldPos.lat,
      lng: holder._heldPos.lng,
      heading: Number.isFinite(holder._heldPos.heading) ? holder._heldPos.heading : snapped.heading,
      limitMph: holder._heldPos.limitMph ?? snapped.limitMph,
      coasting: false,
      stalled: true,
    };
  }

  holder._heldPos = {
    lat: snapped.lat,
    lng: snapped.lng,
    heading: snapped.heading,
    limitMph: snapped.limitMph,
  };
  holder._coastFrozen = true;
  return { ...snapped, coasting: false, stalled: true };
}

function liveWhere(bus) {
  const [lng, lat] = bus.coordinates || [];
  const heading = Number(bus.heading);
  const speed = Number(bus.speedMph);
  const age = pingAgeMs(bus.datetime);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { lat, lng, heading, limitMph: null };
  return applyLiveCoast(bus, lat, lng, heading, age, speed, String(bus.datetime || ""));
}

function staffWhere(item) {
  const lat = Number(item.positioning?.latitude);
  const lng = Number(item.positioning?.longitude);
  const heading = Number(item.positioning?.bearing);
  const speed = Number(item.speedMph);
  const age = pingAgeMs(item.recordedAtTime);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { lat, lng, heading, limitMph: null };
  return applyLiveCoast(item, lat, lng, heading, age, speed, String(item.recordedAtTime || ""));
}

function advanceLiveMarkers() {
  for (const marker of markers.values()) {
    const bus = marker.bus;
    if (!bus?.coordinates) continue;
    const snapped = liveWhere(bus);
    if (snapped.stalled) continue;
    placeOnRoad(marker, snapped);
  }
  for (const marker of staffMarkers.values()) {
    const item = marker.staff;
    if (!item?.positioning) continue;
    const snapped = staffWhere(item);
    if (snapped.stalled) continue;
    moveMarkerTo(marker, snapped.lat, snapped.lng);
    if (!snapped.coasting) {
      recordStaffTrail(marker, snapped.lat, snapped.lng, snapped.heading);
    }
    const prev = marker._roadHeading;
    if (!Number.isFinite(prev) || angleDiff(prev, snapped.heading) > 8) {
      marker._roadHeading = snapped.heading;
      marker.setIcon(staffIcon(marker.line, snapped.heading, marker.staffLivery, item.speedMph));
    }
    keepFollowedInView(marker);
  }
}

function placeOnRoad(marker, snapped) {
  moveMarkerTo(marker, snapped.lat, snapped.lng);
  if (marker.bus && !snapped.stalled && !snapped.coasting) {
    recordVehicleTrail(marker.bus.id, snapped.lat, snapped.lng, snapped.heading, {
      journeyId: marker.bus.journey_id,
      tripId: marker.bus.trip_id,
      line: marker.bus.service?.line_name || marker.extra?.line || "",
      operator: trailOperatorForBus(marker.bus),
      direction: marker.bus.direction || marker.bus.directionRef || "",
      destination: marker.bus.destination || marker.extra?.to || "",
      reg: busRegistration(marker.bus, marker.extra || {}),
      _force: marker === selectedMapMarker || isFollowingMarker(marker),
    });
  }
  const prev = marker._roadHeading;
  if (marker.bus && (!Number.isFinite(prev) || angleDiff(prev, snapped.heading) > 8)) {
    marker._roadHeading = snapped.heading;
    marker.setIcon(busIcon(marker.bus, snapped.heading));
  }
  keepFollowedInView(marker);
}

function snapHit(lat, lng, heading, maxDist = MAX_SNAP_M) {
  const roads = roadsForSnap();
  if (!roads.length) return null;
  const p = [lat, lng];
  let best = null;
  let bestScore = Infinity;
  const pad = 0.0016;
  for (const road of roads) {
    if (
      lat < road.bbox.minLat - pad ||
      lat > road.bbox.maxLat + pad ||
      lng < road.bbox.minLng - pad ||
      lng > road.bbox.maxLng + pad
    ) {
      continue;
    }
    const pts = road.latlngs;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const hit = closestOnSegment(p, pts[i], pts[i + 1]);
      if (hit.dist > maxDist) continue;
      let score = hit.dist;
      if (Number.isFinite(heading)) {
        const diff = Math.min(angleDiff(heading, hit.bearing), angleDiff(heading, hit.bearing + 180));
        if (diff > 70 && hit.dist > 14) continue;
        score += diff * 0.18;
      }
      if (road.class === "service" || road.class === "track") score += 8;
      if (score < bestScore) {
        bestScore = score;
        best = { ...hit, limitMph: road.limitMph, road, i };
      }
    }
  }
  if (!best) return null;
  const reverse = Number.isFinite(heading) && angleDiff(heading, best.bearing) > 90;
  return {
    lat: best.lat,
    lng: best.lng,
    heading: reverse ? (best.bearing + 180) % 360 : best.bearing,
    limitMph: best.limitMph,
    dist: best.dist,
    road: best.road,
    i: best.i,
    forward: !reverse,
    onRoad: true,
  };
}

function nextRoadSegment(pos, heading, fromRoad, fromI) {
  const roads = roadsForSnap();
  let best = null;
  let bestScore = Infinity;
  for (const road of roads) {
    const pts = road.latlngs;
    for (let i = 0; i < pts.length - 1; i += 1) {
      if (road === fromRoad && i === fromI) continue;
      const hit = closestOnSegment([pos.lat, pos.lng], pts[i], pts[i + 1]);
      if (hit.dist > JUNCTION_M) continue;
      const dFwd = angleDiff(heading, hit.bearing);
      const dRev = angleDiff(heading, hit.bearing + 180);
      const align = Math.min(dFwd, dRev);
      if (align > 78) continue;
      const score = hit.dist + align * 0.35;
      if (score < bestScore) {
        bestScore = score;
        best = { road, i, forward: dFwd <= dRev, lat: hit.lat, lng: hit.lng, heading: dFwd <= dRev ? hit.bearing : (hit.bearing + 180) % 360 };
      }
    }
  }
  return best;
}

function walkAlongRoad(hit, meters) {
  if (!hit?.road) return hit;
  if (!Number.isFinite(meters) || meters < 3) return hit;
  let remaining = meters;
  let pos = { lat: hit.lat, lng: hit.lng };
  let heading = hit.heading;
  let road = hit.road;
  let i = hit.i;
  let forward = hit.forward;
  let limitMph = hit.limitMph;
  for (let step = 0; step < 48 && remaining > 0.6; step += 1) {
    const pts = road.latlngs;
    if (i < 0 || i >= pts.length - 1) break;
    const end = forward ? pts[i + 1] : pts[i];
    const toEnd = haversineMeters(pos.lat, pos.lng, end[0], end[1]);
    if (toEnd < 0.4) {
      if (forward) i += 1;
      else i -= 1;
      if (i < 0 || i >= pts.length - 1) {
        const next = nextRoadSegment(pos, heading, road, i);
        if (!next) break;
        road = next.road;
        i = next.i;
        forward = next.forward;
        heading = next.heading;
        limitMph = road.limitMph ?? limitMph;
        pos = { lat: next.lat, lng: next.lng };
      }
      continue;
    }
    const bear = segmentBearing([pos.lat, pos.lng], end);
    heading = bear;
    if (toEnd >= remaining) {
      const t = remaining / toEnd;
      return {
        lat: pos.lat + (end[0] - pos.lat) * t,
        lng: pos.lng + (end[1] - pos.lng) * t,
        heading: bear,
        limitMph,
        onRoad: true,
      };
    }
    remaining -= toEnd;
    pos = { lat: end[0], lng: end[1] };
    if (forward) i += 1;
    else i -= 1;
    if (i < 0 || i >= pts.length - 1) {
      const next = nextRoadSegment(pos, heading, road, i);
      if (!next) break;
      road = next.road;
      i = next.i;
      forward = next.forward;
      heading = next.heading;
      limitMph = road.limitMph ?? limitMph;
    }
  }
  return { lat: pos.lat, lng: pos.lng, heading, limitMph, onRoad: true };
}

function keepOnRoad(holder, lat, lng, heading, meters = 0) {
  const hit = snapHit(lat, lng, heading);
  if (hit) {
    const walked = walkAlongRoad(hit, meters);
    holder.onRoad = walked;
    return walked;
  }
  if (holder.onRoad) return holder.onRoad;
  return { lat, lng, heading, limitMph: null };
}

function snapToRoad(lat, lng, heading) {
  return keepOnRoad({}, lat, lng, heading, 0);
}

const trailAlignCache = new Map();
const trailAlignPending = new Map();

function trailPathHash(latlngs) {
  if (!latlngs?.length) return "";
  const flat = Array.isArray(latlngs[0]?.[0]) ? latlngs.flat() : latlngs;
  if (!flat.length) return "";
  // Include the complete geometry (not just the endpoints); otherwise two
  // opposite/diverted runs with similar endpoints can share a cached alignment
  // and paint a plausible but incorrect loop.
  let hash = 2166136261;
  for (const point of flat) {
    const token = `${Number(point[0]).toFixed(5)},${Number(point[1]).toFixed(5)},${Number(point[2] ?? 0).toFixed(1)},${Number(point[3] ?? 0)};`;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  const a = flat[0];
  const b = flat[flat.length - 1];
  return `${flat.length}:${hash >>> 0}:${Number(a[0]).toFixed(5)},${Number(a[1]).toFixed(5)}:${Number(b[0]).toFixed(5)},${Number(b[1]).toFixed(5)}`;
}

function thinTrailPoints(latlngs, minGapM = 12) {
  if (!Array.isArray(latlngs) || latlngs.length < 3) return latlngs || [];
  const out = [latlngs[0]];
  for (let i = 1; i < latlngs.length - 1; i += 1) {
    const prev = out[out.length - 1];
    const cur = latlngs[i];
    if (haversineMeters(prev[0], prev[1], cur[0], cur[1]) >= minGapM) out.push(cur);
  }
  const last = latlngs[latlngs.length - 1];
  const prev = out[out.length - 1];
  if (haversineMeters(prev[0], prev[1], last[0], last[1]) > 2) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

function dedupeNearTrailPoints(latlngs, minGapM = 3) {
  if (!Array.isArray(latlngs) || latlngs.length < 2) return latlngs || [];
  const out = [latlngs[0]];
  for (let i = 1; i < latlngs.length; i += 1) {
    const prev = out[out.length - 1];
    const cur = latlngs[i];
    if (haversineMeters(prev[0], prev[1], cur[0], cur[1]) >= minGapM) out.push(cur);
  }
  return out;
}

function pointsAlongSameRoad(hitA, hitB) {
  if (!hitA?.road || !hitB?.road || hitA.road !== hitB.road) {
    return [
      [hitA.lat, hitA.lng],
      [hitB.lat, hitB.lng],
    ];
  }
  const pts = hitA.road.latlngs;
  const i0 = hitA.i;
  const i1 = hitB.i;
  const out = [[hitA.lat, hitA.lng]];
  if (i0 === i1) {
    out.push([hitB.lat, hitB.lng]);
    return out;
  }
  if (i1 > i0) {
    for (let i = i0 + 1; i <= i1; i += 1) out.push(pts[i]);
  } else {
    for (let i = i0; i >= i1 + 1; i -= 1) out.push(pts[i]);
  }
  out.push([hitB.lat, hitB.lng]);
  return out;
}

function bridgeTrailRoads(hitA, hitB) {
  const out = [[hitA.lat, hitA.lng]];
  let hit = { ...hitA };
  for (let step = 0; step < 70; step += 1) {
    const dist = haversineMeters(hit.lat, hit.lng, hitB.lat, hitB.lng);
    if (dist < 12) break;
    if (hit.road && hitB.road && hit.road === hitB.road) {
      const along = pointsAlongSameRoad(hit, hitB);
      for (const p of along.slice(1)) out.push(p);
      return out;
    }
    const bear = segmentBearing([hit.lat, hit.lng], [hitB.lat, hitB.lng]);
    const stepped = walkAlongRoad(
      { ...hit, heading: bear },
      Math.min(28, Math.max(8, dist * 0.45)),
    );
    if (!stepped || haversineMeters(hit.lat, hit.lng, stepped.lat, stepped.lng) < 0.8) {
      const t = Math.min(0.4, 18 / Math.max(dist, 1));
      const midLat = hit.lat + (hitB.lat - hit.lat) * t;
      const midLng = hit.lng + (hitB.lng - hit.lng) * t;
      const mid = snapHit(midLat, midLng, bear, 130);
      if (!mid) break;
      hit = mid;
    } else {
      const resnap =
        snapHit(stepped.lat, stepped.lng, stepped.heading ?? bear, 45) || {
          ...stepped,
          road: hit.road,
          i: hit.i,
          forward: hit.forward,
        };
      hit = resnap;
    }
    const last = out[out.length - 1];
    if (haversineMeters(last[0], last[1], hit.lat, hit.lng) >= 3) out.push([hit.lat, hit.lng]);
  }
  out.push([hitB.lat, hitB.lng]);
  return out;
}

/** Snap GPS breadcrumbs onto road geometry so the trail follows the streets driven. */
function alignTrailToRoadsLocal(latlngs, breakOpts = {}) {
  if (!Array.isArray(latlngs) || latlngs.length < 2) return latlngs || [];
  const limits = trailBreakLimits(breakOpts);
  const staffs =
    !!breakOpts.staffs ||
    isStaffsTrailOperator(breakOpts.operator) ||
    isAltonLine(breakOpts.line);
  // Rural AVL often sits further from the carriageway centreline than urban BODS.
  const snapNear = staffs ? 380 : 280;
  const snapFar = staffs ? 560 : 420;
  const inputSegs = splitLatLngsByGaps(latlngs, limits.gapM, breakOpts);
  const sourceSegs = inputSegs.length ? inputSegs : [latlngs];
  const alignedSegs = [];
  for (const seg of sourceSegs) {
    const out = [];
    let prevHit = null;
    let prevHeading = null;
    for (let i = 0; i < seg.length; i += 1) {
      const cur = seg[i];
      const next = seg[i + 1];
      const heading = next ? segmentBearing(cur, next) : Number.isFinite(prevHeading) ? prevHeading : null;
      // Prefer the nearest road — never keep raw GPS in fields (that draws chords across country).
      let hit = snapHit(cur[0], cur[1], heading, snapNear) || snapHit(cur[0], cur[1], heading, snapFar);
      if (hit && cur[3] != null && Number.isFinite(Number(cur[3]))) hit = { ...hit, t: Number(cur[3]) };
      if (!hit) {
        if (out.length >= 2) {
          alignedSegs.push(out.slice());
          out.length = 0;
        }
        prevHit = null;
        prevHeading = heading;
        continue;
      }
      if (!prevHit) {
        out.push([hit.lat, hit.lng]);
      } else if (isTrailGapJump(prevHit, hit, limits.gapM, breakOpts)) {
        if (out.length >= 2) alignedSegs.push(out.slice());
        out.length = 0;
        out.push([hit.lat, hit.lng]);
      } else if (prevHit.road === hit.road) {
        const along = pointsAlongSameRoad(prevHit, hit);
        if (roadBridgePlausible(prevHit, hit, along, breakOpts)) {
          for (const p of along.slice(1)) {
            if (haversineMeters(out[out.length - 1][0], out[out.length - 1][1], p[0], p[1]) >= 2) out.push(p);
          }
        } else {
          if (out.length >= 2) alignedSegs.push(out.slice());
          out.length = 0;
          out.push([hit.lat, hit.lng]);
        }
      } else {
        const bridge = bridgeTrailRoads(prevHit, hit);
        const bridgePlausible = roadBridgePlausible(prevHit, hit, bridge, breakOpts);
        const bridgeJump =
          bridge.length >= 2 &&
          bridge.slice(1).some((p, idx) => {
            const a = idx === 0 ? [prevHit.lat, prevHit.lng] : bridge[idx];
            const bridgeGap =
              isCoachTrailOperator(breakOpts.operator) || breakOpts.coach
                ? limits.gapM
                : Math.min(limits.gapM, 900);
            return isTrailGapJump(a, p, bridgeGap, breakOpts);
          });
        if (
          !bridgePlausible ||
          bridgeJump ||
          isTrailGapJump(
            prevHit,
            hit,
            isCoachTrailOperator(breakOpts.operator) || breakOpts.coach
              ? limits.gapM
              : Math.min(limits.gapM, 900),
            breakOpts,
          )
        ) {
          if (out.length >= 2) alignedSegs.push(out.slice());
          out.length = 0;
          out.push([hit.lat, hit.lng]);
        } else {
          for (const p of bridge.slice(1)) {
            if (haversineMeters(out[out.length - 1][0], out[out.length - 1][1], p[0], p[1]) >= 2) out.push(p);
          }
        }
      }
      prevHit = hit;
      prevHeading = hit.heading ?? heading;
    }
    const cleaned = dedupeNearTrailPoints(out, 2);
    if (cleaned.length >= 2) alignedSegs.push(cleaned);
  }
  if (!alignedSegs.length) return [];
  return alignedSegs.length === 1 ? alignedSegs[0] : alignedSegs;
}

function osrmCoordsFromLngLat(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const part = [];
  for (const [lng, lat] of coords) {
    if (Number.isFinite(lat) && Number.isFinite(lng)) part.push([lat, lng]);
  }
  const cleaned = dedupeNearTrailPoints(part, 2.5);
  return cleaned.length >= 2 ? cleaned : null;
}

function trailFetchWithDeadline(url, options = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(abort, timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.("abort", abort);
  });
}

function roadBridgePlausible(a, b, part, breakOpts = {}) {
  if (!Array.isArray(part) || part.length < 2 || !a || !b) return false;
  const aLat = Number(Array.isArray(a) ? a[0] : a.lat);
  const aLng = Number(Array.isArray(a) ? a[1] : a.lng);
  const bLat = Number(Array.isArray(b) ? b[0] : b.lat);
  const bLng = Number(Array.isArray(b) ? b[1] : b.lng);
  if (![aLat, aLng, bLat, bLng].every(Number.isFinite)) return false;
  const first = part[0];
  const last = part[part.length - 1];
  if (!Array.isArray(first) || !Array.isArray(last)) return false;
  // OSRM may snap to a nearby carriageway, but it must still begin/end at the
  // two recorded points. A large endpoint jump means the match belongs to a
  // different road/journey and must not be painted.
  if (
    haversineMeters(aLat, aLng, Number(first[0]), Number(first[1])) > 800 ||
    haversineMeters(bLat, bLng, Number(last[0]), Number(last[1])) > 800
  ) return false;
  const straight = haversineMeters(aLat, aLng, bLat, bLng);
  const routeM = pathLengthMeters(part);
  if (!Number.isFinite(routeM) || routeM < 1) return false;
  // A short pair of GPS fixes must not be turned into a motorway-sized loop.
  // Sparse coach fixes can legitimately have a sizeable detour, so scale the
  // allowance with the direct distance instead of imposing a fixed cap.
  const ratioCap = straight < 2_000 ? 6 : straight < 8_000 ? 7 : 8;
  if (routeM > Math.max(2_500, straight * ratioCap)) return false;
  const rawAt = Array.isArray(a) ? a[3] : a?.t;
  const rawBt = Array.isArray(b) ? b[3] : b?.t;
  const at = rawAt != null && rawAt !== "" && Number.isFinite(Number(rawAt)) ? Number(rawAt) : null;
  const bt = rawBt != null && rawBt !== "" && Number.isFinite(Number(rawBt)) ? Number(rawBt) : null;
  if (at != null && bt != null) {
    const seconds = Math.abs(bt - at) / 1_000;
    const mph = (routeM / Math.max(seconds, 1)) * 2.23694;
    const coach = Boolean(breakOpts.coach || isCoachTrailOperator(breakOpts.operator));
    const staffs = Boolean(breakOpts.staffs || isStaffsTrailOperator(breakOpts.operator));
    const maxMph = coach
      ? COACH_TRAIL_BREAK_SPEED_MPH
      : staffs
        ? STAFFS_TRAIL_BREAK_SPEED_MPH
        : TRAIL_BREAK_SPEED_MPH;
    // Timestamp jitter is common at coach stops. Only reject a fast, clearly
    // implausible detour; ordinary motorway samples remain accepted.
    if (seconds >= 5 && seconds <= 45 * 60 && mph > maxMph && routeM > straight + 1_000) return false;
  }
  return true;
}

async function osrmRoadBridge(a, b, signal, breakOpts = {}) {
  if (!a || !b) return null;
  const coords = `${Number(a[1]).toFixed(5)},${Number(a[0]).toFixed(5)};${Number(b[1]).toFixed(5)},${Number(b[0]).toFixed(5)}`;
  try {
    const routeRes = await trailFetchWithDeadline(
      `/api/osrm-route/${coords}?overview=full&geometries=geojson`,
      { signal },
    );
    if (routeRes.ok) {
      const data = await routeRes.json();
      const part = osrmCoordsFromLngLat(data?.routes?.[0]?.geometry?.coordinates);
      if (roadBridgePlausible(a, b, part, breakOpts)) return part;
    }
  } catch {
    /* try match fallback */
  }
  // Public OSRM rejects large radiuses (TooBig) — keep match snap tight.
  for (const radius of [35, 25]) {
    try {
      const res = await trailFetchWithDeadline(
        `/api/osrm-match/${coords}?overview=full&geometries=geojson&gaps=ignore&radiuses=${radius};${radius}`,
        { signal },
      );
      if (!res.ok) continue;
      const data = await res.json();
      const part = osrmCoordsFromLngLat(data?.matchings?.[0]?.geometry?.coordinates);
      if (roadBridgePlausible(a, b, part, breakOpts)) return part;
    } catch {
      /* try next radius */
    }
  }
  return null;
}

/** When map-matching fails, stitch consecutive GPS points via OSRM driving routes (always on roads). */
async function stitchTrailViaOsrmRoutes(latlngs, signal, breakOpts = {}) {
  const limits = trailBreakLimits(breakOpts);
  const coach = isCoachTrailOperator(breakOpts.operator) || !!breakOpts.coach;
  const staffs =
    !!breakOpts.staffs ||
    isStaffsTrailOperator(breakOpts.operator) ||
    isAltonLine(breakOpts.line);
  const inputSegs = splitLatLngsByGaps(latlngs, limits.gapM, breakOpts);
  const sourceSegs = inputSegs.length ? inputSegs : [latlngs];
  const alignedSegs = [];
  // Sparse Bustimes stop lists are best represented by one driving route per
  // stop pair. Matching every 180 m along a London→Blackpool alignment creates
  // hundreds of unnecessary OSRM calls and can take minutes.
  const plannedSparse = Boolean(breakOpts.plannedRoute) && sourceSegs.some((source) => {
    const flatSource = Array.isArray(source?.[0]?.[0]) ? source.flat() : source;
    if (!Array.isArray(flatSource) || flatSource.length < 2) return false;
    let total = 0;
    for (let i = 1; i < flatSource.length; i += 1) {
      total += haversineMeters(flatSource[i - 1][0], flatSource[i - 1][1], flatSource[i][0], flatSource[i][1]);
    }
    return flatSource.length <= 24 || total / (flatSource.length - 1) > 800;
  });
  // Coaches: wider sample spacing so long motorway legs stay fast + on-road.
  // Staffs rural: slightly wider than urban so sparse AVL still gets a road bridge.
  const thinGap = plannedSparse ? 5000 : coach ? 180 : staffs ? 140 : 28;
  const bridgeBatch = plannedSparse ? 4 : coach ? 8 : staffs ? 6 : 4;
  for (const source of sourceSegs) {
    const thinned = thinTrailPoints(source, thinGap);
    if (thinned.length < 2) continue;
    const bridges = new Array(thinned.length - 1).fill(null);
    for (let start = 0; start < thinned.length - 1; start += bridgeBatch) {
      if (signal?.aborted) return alignedSegs.length ? alignedSegs : null;
      const jobs = [];
      for (let i = start; i < Math.min(thinned.length - 1, start + bridgeBatch); i += 1) {
        const a = thinned[i];
        const b = thinned[i + 1];
        const jump = isTrailGapJump(
          { lat: a[0], lng: a[1], t: a[3] },
          { lat: b[0], lng: b[1], t: b[3] },
          limits.gapM,
          breakOpts,
        );
        if (jump) {
          bridges[i] = null;
          continue;
        }
        jobs.push(
          osrmRoadBridge(a, b, signal, breakOpts).then((part) => {
            bridges[i] = part;
          }),
        );
      }
      await Promise.all(jobs);
    }
    let merged = [thinned[0]];
    for (let i = 1; i < thinned.length; i += 1) {
      const bridge = bridges[i - 1];
      const next = thinned[i];
      if (bridge?.length >= 2) {
        for (const p of bridge.slice(1)) {
          const last = merged[merged.length - 1];
          if (haversineMeters(last[0], last[1], p[0], p[1]) >= 2) merged.push(p);
        }
      } else {
        // No road route — break rather than draw a chord off the road.
        if (merged.length >= 2) alignedSegs.push(dedupeNearTrailPoints(merged, 2.5));
        merged = [next];
      }
    }
    if (merged.length >= 2) alignedSegs.push(dedupeNearTrailPoints(merged, 2.5));
  }
  if (!alignedSegs.length) return null;
  return alignedSegs.length === 1 ? alignedSegs[0] : alignedSegs;
}

async function matchOsrmChunk(chunk, signal, radius) {
  if (!Array.isArray(chunk) || chunk.length < 2) return [];
  const coords = chunk
    .map(([lat, lng]) => `${Number(lng).toFixed(5)},${Number(lat).toFixed(5)}`)
    .join(";");
  const radiuses = chunk.map(() => String(radius)).join(";");
  const res = await trailFetchWithDeadline(
    `/api/osrm-match/${coords}?overview=full&geometries=geojson&tidy=true&gaps=ignore&radiuses=${radiuses}`,
    { signal },
  );
  if (!res.ok) return [];
  const data = await res.json();
  const matchings = Array.isArray(data?.matchings) ? data.matchings : [];
  const parts = [];
  for (const matching of matchings) {
    const part = osrmCoordsFromLngLat(matching?.geometry?.coordinates);
    if (part) parts.push(part);
  }
  return parts;
}

async function matchTrailViaOsrm(latlngs, signal, breakOpts = {}) {
  const limits = trailBreakLimits(breakOpts);
  const inputSegs = splitLatLngsByGaps(latlngs, limits.gapM, breakOpts);
  const sourceSegs = inputSegs.length ? inputSegs : [latlngs];
  const alignedSegs = [];
  for (const source of sourceSegs) {
    const thinned = thinTrailPoints(source, 18);
    if (thinned.length < 2) continue;
    const chunkSize = 40;
    const chunkParts = [];
    for (let i = 0; i < thinned.length; i += chunkSize - 1) {
      const chunk = thinned.slice(i, i + chunkSize);
      if (chunk.length < 2) continue;
      let parts = [];
      // Public demo OSRM returns TooBig for large radiuses — try tight snaps first.
      for (const radius of [35, 25]) {
        try {
          parts = await matchOsrmChunk(chunk, signal, radius);
          if (parts.length) break;
        } catch {
          parts = [];
        }
      }
      if (!parts.length && chunk.length > 8) {
        // Smaller chunks often succeed when a long match is rejected.
        const mid = Math.ceil(chunk.length / 2);
        for (const half of [chunk.slice(0, mid + 1), chunk.slice(mid)]) {
          if (half.length < 2) continue;
          try {
            const halfParts = await matchOsrmChunk(half, signal, 30);
            for (const p of halfParts) parts.push(p);
          } catch {
            /* ignore */
          }
        }
      }
      if (!parts.length) {
        // Last resort for this chunk: route-stitch so we still stay on roads.
        try {
          const stitched = await stitchTrailViaOsrmRoutes(chunk, signal, breakOpts);
          const segs = trailSegmentsOf(stitched, breakOpts);
          for (const seg of segs) parts.push(seg);
        } catch {
          /* leave gap */
        }
      }
      for (const part of parts) chunkParts.push(part);
    }
    // Stitch adjacent OSRM matchings on-road only — never draw a field chord between chunks.
    let merged = [];
    for (const part of chunkParts) {
      if (!merged.length) {
        merged = part.slice();
        continue;
      }
      const prev = merged[merged.length - 1];
      const next = part[0];
      const joinDist = haversineMeters(prev[0], prev[1], next[0], next[1]);
      if (joinDist < 90) {
        for (const p of part.slice(joinDist < 4 ? 1 : 0)) {
          if (haversineMeters(merged[merged.length - 1][0], merged[merged.length - 1][1], p[0], p[1]) >= 2) {
            merged.push(p);
          }
        }
      } else if (joinDist < 3500) {
        const bridge = await osrmRoadBridge(prev, next, signal, breakOpts);
        if (bridge?.length >= 2) {
          for (const p of bridge.slice(1)) {
            if (haversineMeters(merged[merged.length - 1][0], merged[merged.length - 1][1], p[0], p[1]) >= 2) {
              merged.push(p);
            }
          }
          for (const p of part.slice(1)) {
            if (haversineMeters(merged[merged.length - 1][0], merged[merged.length - 1][1], p[0], p[1]) >= 2) {
              merged.push(p);
            }
          }
        } else {
          if (merged.length >= 2) alignedSegs.push(merged);
          merged = part.slice();
        }
      } else {
        if (merged.length >= 2) alignedSegs.push(merged);
        merged = part.slice();
      }
    }
    if (merged.length >= 2) alignedSegs.push(merged);
  }
  if (!alignedSegs.length) return null;
  return alignedSegs.length === 1 ? alignedSegs[0] : alignedSegs;
}

async function ensureSnapRoadsForBounds(bounds, signal) {
  if (!bounds) return;
  const template = await getOfmTemplate();
  let z = Math.min(Math.max(map.getZoom(), 13), 14);
  let tiles = tilesForBounds(bounds, z);
  if (tiles.length > 28) {
    z = Math.max(12, z - 1);
    tiles = tilesForBounds(bounds, z);
  }
  tiles = tiles.slice(0, 28);
  const decoded = await Promise.all(
    tiles.map((tile) => decodeRoadTile(template, tile.z, tile.x, tile.y, signal)),
  );
  if (signal?.aborted) return;
  snapRoads = decoded.flat();
}

async function ensureSnapRoadsForPath(latlngs, signal) {
  const flat = Array.isArray(latlngs?.[0]?.[0]) ? latlngs.flat() : latlngs;
  if (!Array.isArray(flat) || flat.length < 2) return;
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const pt of flat) {
    const lat = Array.isArray(pt) ? pt[0] : pt?.lat;
    const lng = Array.isArray(pt) ? pt[1] : pt?.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  if (!(minLat <= maxLat) || !(minLng <= maxLng)) return;
  const bounds = L.latLngBounds([minLat, minLng], [maxLat, maxLng]).pad(0.03);
  await ensureSnapRoadsForBounds(bounds, signal);
}

function trailSegmentsOf(path, breakOpts = {}) {
  if (!Array.isArray(path) || !path.length) return [];
  if (Array.isArray(path[0]) && Array.isArray(path[0][0])) {
    return path.filter((seg) => Array.isArray(seg) && seg.length >= 2);
  }
  const limits = trailBreakLimits(breakOpts);
  const split = splitLatLngsByGaps(path, limits.gapM, breakOpts);
  return split.length ? split : path.length >= 2 ? [path] : [];
}

async function prepareRoadTrail(latlngs, signal, breakOpts = {}) {
  if (!Array.isArray(latlngs) || latlngs.length < 2) return latlngs || [];
  const coach = isCoachTrailOperator(breakOpts.operator) || !!breakOpts.coach;
  const staffs =
    !!breakOpts.staffs ||
    isStaffsTrailOperator(breakOpts.operator) ||
    isAltonLine(breakOpts.line);
  const actualRoute = Boolean(breakOpts.actualRoute);
  const plannedRoute = Boolean(breakOpts.plannedRoute);
  const key = `${trailPathHash(latlngs)}|${plannedRoute ? "planned" : actualRoute ? "actual" : coach ? "coach" : staffs ? "staffs" : "bus"}|v9`;
  if (trailAlignCache.has(key)) return trailAlignCache.get(key);
  if (plannedRoute) {
    const cleaned = Array.isArray(latlngs?.[0]?.[0])
      ? latlngs.map((seg) => dedupeNearTrailPoints(seg, 2)).filter((seg) => seg.length >= 2)
      : dedupeNearTrailPoints(latlngs, 2);
    const flat = Array.isArray(cleaned?.[0]?.[0]) ? cleaned.flat() : cleaned;
    // Bustimes sometimes returns only stop locations (no track points). Those
    // sparse stop-to-stop chords are fine for a timetable, but a live coach
    // can be tens of kilometres from the next vertex and the strict 350 m clip
    // then correctly hides the whole tail. Align sparse planned geometry to
    // the driving road first; the live clip still uses the real bus ping.
    const gaps = [];
    for (let i = 1; i < flat.length; i += 1) {
      gaps.push(haversineMeters(flat[i - 1][0], flat[i - 1][1], flat[i][0], flat[i][1]));
    }
    const averageGap = gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : 0;
    const sparsePlannedPath =
      (coach || isCoachTrailOperator(breakOpts.operator)) &&
      flat.length >= 2 &&
      (flat.length <= 24 || averageGap > 800);
    if (!sparsePlannedPath) {
      trailAlignCache.set(key, cleaned);
      return cleaned;
    }
    if (trailAlignPending.has(key)) return trailAlignPending.get(key);
    const pending = (async () => {
      try {
        const aligned = await stitchTrailViaOsrmRoutes(cleaned, signal, {
          ...breakOpts,
          plannedRoute: true,
          coach,
        });
        const valid = trailSegmentsOf(aligned, { ...breakOpts, plannedRoute: true });
        if (valid.length) return valid.length === 1 ? valid[0] : valid;
      } catch {
        /* A failed coach match must not turn back into an off-road chord. */
      }
      const fallback = coach ? [] : cleaned;
      trailAlignCache.set(key, fallback);
      return fallback;
    })();
    trailAlignPending.set(key, pending);
    try {
      const result = await pending;
      trailAlignCache.set(key, result);
      if (trailAlignCache.size > 48) {
        trailAlignCache.delete(trailAlignCache.keys().next().value);
      }
      return result;
    } finally {
      trailAlignPending.delete(key);
    }
  }
  if (trailAlignPending.has(key)) return trailAlignPending.get(key);
  const pending = (async () => {
    try {
      // Warm the local road tiles, but do not let a slow tile fetch block the
      // OSRM road match that keeps live tails visible.
      await Promise.race([
        ensureSnapRoadsForPath(latlngs, signal).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 900)),
      ]);
      const flat = Array.isArray(latlngs?.[0]?.[0]) ? latlngs.flat() : latlngs;
      let aligned = null;
      let segs = [];
      const alignOpts = { ...breakOpts, coach, staffs };
      try {
        if (actualRoute) {
          // Diverted services: match the recorded GPS sequence itself. Do not
          // replace a real diversion with a route inferred between sparse pings.
          const thinned = thinTrailPoints(flat, 55);
          aligned = await matchTrailViaOsrm(thinned.length >= 2 ? thinned : flat, signal, alignOpts);
          segs = trailSegmentsOf(aligned, alignOpts);
        } else if (coach) {
          // Flix / NATX: route-stitch first so sparse motorway AVL stays on roads.
          const thinned = thinTrailPoints(flat, 160);
          aligned = await stitchTrailViaOsrmRoutes(
            thinned.length >= 2 ? thinned : flat,
            signal,
            { ...alignOpts, coach: true },
          );
          segs = trailSegmentsOf(aligned, alignOpts);
          if (!segs.length) {
            aligned = await matchTrailViaOsrm(thinned.length >= 2 ? thinned : flat, signal, {
              ...alignOpts,
              coach: true,
            });
            segs = trailSegmentsOf(aligned, alignOpts);
          }
        } else if (staffs) {
          // Rural Staffs / AT / FPOT / D&G: sparse AVL often fails tight map-match —
          // stitch driving routes first so the trail sticks to roads, then match.
          const thinned = thinTrailPoints(flat, 140);
          aligned = await stitchTrailViaOsrmRoutes(
            thinned.length >= 2 ? thinned : flat,
            signal,
            alignOpts,
          );
          segs = trailSegmentsOf(aligned, alignOpts);
          if (!segs.length) {
            aligned = await matchTrailViaOsrm(thinned.length >= 2 ? thinned : flat, signal, alignOpts);
            segs = trailSegmentsOf(aligned, alignOpts);
          }
        } else {
          aligned = await matchTrailViaOsrm(latlngs, signal, alignOpts);
          segs = trailSegmentsOf(aligned, alignOpts);
          if (!segs.length) {
            aligned = await stitchTrailViaOsrmRoutes(latlngs, signal, alignOpts);
            segs = trailSegmentsOf(aligned, alignOpts);
          }
        }
      } catch {
        segs = [];
      }
      if (!segs.length) {
        // Local OFM snap is useful for ordinary bus/staff roads, but its
        // nearest-road bridge can pick the wrong motorway carriageway. Keep
        // failed coach alignment hidden until a validated road path exists.
        if (!coach && !plannedRoute) {
          segs = trailSegmentsOf(alignTrailToRoadsLocal(latlngs, alignOpts), alignOpts);
        }
      } else {
        segs = segs.map((seg) => dedupeNearTrailPoints(seg, 2)).filter((seg) => seg.length >= 2);
      }
      // Prefer empty over off-road chords (caller may keep GPS-immediate until this returns roads).
      if (!segs.length) return [];
      const result = segs.length === 1 ? segs[0] : segs;
      trailAlignCache.set(key, result);
      if (trailAlignCache.size > 48) {
        trailAlignCache.delete(trailAlignCache.keys().next().value);
      }
      return result;
    } catch {
      /* keep empty — caller keeps previous road path / deferred arrows */
    }
    return [];
  })();
  trailAlignPending.set(key, pending);
  try {
    return await pending;
  } finally {
    trailAlignPending.delete(key);
  }
}

async function ensureSnapRoads(signal) {
  if (map.getZoom() < MIN_ZOOM) {
    snapRoads = [];
    snapRoadsKey = "";
    snapRoadsAt = 0;
    return;
  }
  const bounds = map.getBounds().pad(0.06);
  const key = `${map.getZoom()}|${bounds.getNorth().toFixed(3)}|${bounds.getSouth().toFixed(3)}|${bounds.getEast().toFixed(3)}|${bounds.getWest().toFixed(3)}`;
  if (snapRoadsKey === key && snapRoadsAt && Date.now() - snapRoadsAt < 30_000) return;
  const template = await getOfmTemplate();
  let z = Math.min(Math.max(map.getZoom(), 13), 14);
  let tiles = tilesForBounds(bounds, z);
  if (tiles.length > 20) {
    z = Math.max(12, z - 1);
    tiles = tilesForBounds(bounds, z);
  }
  tiles = tiles.slice(0, 20);
  const decoded = await Promise.all(
    tiles.map((tile) => decodeRoadTile(template, tile.z, tile.x, tile.y, signal)),
  );
  if (signal?.aborted) return;
  snapRoads = decoded.flat();
  snapRoadsKey = key;
  snapRoadsAt = Date.now();
}

function minDistToRoad(p, latlngs) {
  let best = Infinity;
  for (let i = 0; i < latlngs.length - 1; i += 1) {
    const d = distPointToSegmentMeters(p, latlngs[i], latlngs[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

async function getOfmTemplate() {
  if (ofmTileTemplate) return ofmTileTemplate;
  const res = await fetch("/api/ofm/planet");
  if (!res.ok) throw new Error("Could not load road tiles");
  const json = await res.json();
  ofmTileTemplate = String(json.tiles?.[0] || "").replace(
    "https://tiles.openfreemap.org",
    "/api/ofm",
  );
  if (!ofmTileTemplate) throw new Error("Could not load road tiles");
  return ofmTileTemplate;
}

async function decodeRoadTile(template, z, x, y, signal) {
  const key = `${z}/${x}/${y}`;
  if (decodedTileCache.has(key)) return decodedTileCache.get(key);
  const url = template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const buf = await res.arrayBuffer();
  if (!buf.byteLength) return [];
  const tile = new VectorTile(new PbfReader(new Uint8Array(buf)));
  const roads = [];
  const layer = tile.layers.transportation;
  if (!layer) return roads;
  for (let i = 0; i < layer.length; i += 1) {
    const feature = layer.feature(i);
    const cls = feature.properties?.class;
    if (!SNAP_CLASSES.has(cls)) continue;
    const rings = geoJsonToLatLngs(feature.toGeoJSON(x, y, z));
    for (const latlngs of rings) {
      if (latlngs.length < 2) continue;
      roads.push({
        class: cls,
        ref: compactQuery(feature.properties?.ref || ""),
        limitMph: parseMaxspeedMph(feature.properties) ?? classLimitMph(cls),
        latlngs,
        bbox: roadBBox(latlngs),
      });
    }
  }
  const names = tile.layers.transportation_name;
  if (names) {
    for (let i = 0; i < names.length; i += 1) {
      const feature = names.feature(i);
      const ref = compactQuery(feature.properties?.ref || "");
      if (!ref) continue;
      const rings = geoJsonToLatLngs(feature.toGeoJSON(x, y, z));
      for (const latlngs of rings) {
        if (latlngs.length < 2) continue;
        roads.push({
          class: feature.properties?.class || "primary",
          ref,
          limitMph:
            parseMaxspeedMph(feature.properties) ??
            classLimitMph(feature.properties?.class || "primary"),
          latlngs,
          bbox: roadBBox(latlngs),
        });
      }
    }
  }
  if (decodedTileCache.size > 90) decodedTileCache.delete(decodedTileCache.keys().next().value);
  decodedTileCache.set(key, roads);
  return roads;
}

const announceEl = document.getElementById("announce-toggle");
if (announceEl) {
  announceEl.checked = announceOn;
  announceEl.addEventListener("change", () => {
    if (announceEl.checked && !requirePlus("announcements")) {
      announceEl.checked = false;
      return;
    }
    announceOn = announceEl.checked;
    localStorage.setItem("uk-bus-announce", announceOn ? "1" : "0");
    if (!announceOn) {
      clearSpeech();
      return;
    }
    const marker = openJourneyMarker();
    if (marker) followJourney(marker, true);
  });
}

const stopsToggleEl = document.getElementById("stops-toggle");
if (stopsToggleEl) {
  stopsToggleEl.checked = stopsOn;
  stopsToggleEl.addEventListener("change", () => {
    setStopsVisible(stopsToggleEl.checked);
    if (stopsToggleEl.checked && map.getZoom() < STOPS_MIN_ZOOM) {
      showMessage(`Zoom in to see bus stops (zoom ${STOPS_MIN_ZOOM}+)`);
    }
  });
}
if (stopsOn) scheduleMapStops();

const stopBoardToggleEl = document.getElementById("stop-board-toggle");
if (stopBoardToggleEl) {
  stopBoardToggleEl.checked = stopBoardOn;
  stopBoardToggleEl.addEventListener("change", () => {
    if (stopBoardToggleEl.checked && !requirePlus("stop-board")) {
      stopBoardToggleEl.checked = false;
      return;
    }
    setStopBoardEnabled(stopBoardToggleEl.checked);
    if (stopBoardToggleEl.checked && !stopsOn && stopsToggleEl) {
      stopsToggleEl.checked = true;
      setStopsVisible(true);
      if (map.getZoom() < STOPS_MIN_ZOOM) {
        showMessage(`Zoom in to see bus stops (zoom ${STOPS_MIN_ZOOM}+)`);
      }
    }
  });
}

document.getElementById("stop-board-close")?.addEventListener("click", () => {
  closeStopBoard();
});

document.addEventListener("click", (event) => {
  const btn = event.target.closest?.("[data-stop-board-enable]");
  if (!btn) return;
  event.preventDefault();
  if (!requirePlus("stop-board")) return;
  const popup = map._popup;
  const source = popup?.getSource?.() || popup?._source;
  const feature = source?.feature;
  setStopBoardEnabled(true);
  if (stopBoardToggleEl) stopBoardToggleEl.checked = true;
  if (!stopsOn && stopsToggleEl) {
    stopsToggleEl.checked = true;
    setStopsVisible(true);
  }
  if (feature) {
    source?.closePopup?.();
    openStopBoard(feature);
  }
});

const fleetPanelEl = document.getElementById("fleet-panel");
const fleetContentEl = document.getElementById("fleet-content");
const searchFormEl = document.getElementById("search-form");
const homeScreenEl = document.getElementById("home-screen");
const aboutScreenEl = document.getElementById("about-screen");
const moreBtnEl = document.getElementById("more-btn");
const topbarEl = document.querySelector(".topbar");
const topbarToolsEl = document.getElementById("topbar-tools");

function closeTopMenu() {
  if (!moreBtnEl || !topbarEl || !topbarToolsEl) return;
  moreBtnEl.setAttribute("aria-expanded", "false");
  topbarEl.classList.remove("is-more-open");
  topbarToolsEl.hidden = true;
}

function openTopMenu() {
  if (!moreBtnEl || !topbarEl || !topbarToolsEl) return;
  moreBtnEl.setAttribute("aria-expanded", "true");
  topbarEl.classList.add("is-more-open");
  topbarToolsEl.hidden = false;
}

function setAppTab(tab) {
  const next = tab === "fleet" ? "fleet" : tab === "about" ? "about" : tab === "home" ? "home" : "map";
  appTab = next;
  document.querySelectorAll(".menu-nav-btn, .app-tab").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.tab === next);
  });
  if (homeScreenEl) homeScreenEl.hidden = next !== "home";
  if (aboutScreenEl) aboutScreenEl.hidden = next !== "about";
  if (mapWrapEl) {
    mapWrapEl.hidden = next === "home" || next === "about";
    mapWrapEl.dataset.view = next === "fleet" ? "fleet" : "map";
  }
  if (fleetPanelEl) fleetPanelEl.hidden = next !== "fleet";
  if (searchFormEl) searchFormEl.hidden = next !== "map";
  if (next === "fleet") closeStopBoard();
  // Leaving History · Map via Home / Map / About tabs must restore live Staffs pins.
  if (next === "home" || next === "map" || next === "about") {
    exitHistoryMapMode({ reload: next === "map" });
  }
  if (next === "map") {
    requestAnimationFrame(() => {
      try {
        map.invalidateSize();
      } catch {
        /* ignore */
      }
    });
  }
  syncLiveSchedule();
  syncHomeLiveCountPolling();
  closeTopMenu();
}

moreBtnEl?.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = moreBtnEl.getAttribute("aria-expanded") === "true";
  if (open) closeTopMenu();
  else openTopMenu();
});

document.addEventListener("click", (event) => {
  if (!topbarEl?.classList.contains("is-more-open")) return;
  if (event.target.closest?.("#topbar-tools, #more-btn")) return;
  closeTopMenu();
});

document.querySelectorAll(".menu-nav-btn, .app-tab, .home-action[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => setAppTab(btn.dataset.tab));
});

document.querySelectorAll("[data-nav='home']").forEach((el) => {
  el.addEventListener("click", (event) => {
    event.preventDefault();
    setAppTab("home");
  });
});

document.getElementById("home-search-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const q = document.getElementById("home-query")?.value.trim() || "";
  const mainQuery = document.getElementById("query");
  if (mainQuery) mainQuery.value = q;
  setAppTab("map");
  if (q) {
    document.getElementById("search-form")?.requestSubmit?.();
  }
});

const HOME_NATIONS = [
  { id: "all", label: "All" },
  { id: "england", label: "England" },
  { id: "wales", label: "Wales" },
  { id: "scotland", label: "Scotland" },
  { id: "ni", label: "N. Ireland" },
  { id: "ireland", label: "Ireland" },
  { id: "iom", label: "Isle of Man" },
];

const HOME_AREAS = [
  { id: "gb", nation: "all", label: "Great Britain", lat: 54.2, lng: -2.5, zoom: 6 },
  { id: "england", nation: "england", label: "England", lat: 52.5, lng: -1.5, zoom: 7 },
  { id: "east-anglia", nation: "england", label: "East Anglia", lat: 52.45, lng: 0.9, zoom: 9 },
  { id: "east-midlands", nation: "england", label: "East Midlands", lat: 52.9, lng: -0.9, zoom: 9 },
  { id: "london", nation: "england", label: "London", lat: 51.507, lng: -0.128, zoom: 11 },
  { id: "north-east", nation: "england", label: "North East", lat: 54.9, lng: -1.6, zoom: 9 },
  { id: "north-west", nation: "england", label: "North West", lat: 53.75, lng: -2.6, zoom: 9 },
  { id: "south-east", nation: "england", label: "South East", lat: 51.25, lng: 0.2, zoom: 9 },
  { id: "south-west", nation: "england", label: "South West", lat: 50.9, lng: -3.5, zoom: 8 },
  { id: "west-midlands", nation: "england", label: "West Midlands", lat: 52.5, lng: -2.0, zoom: 9 },
  { id: "staffordshire", nation: "england", label: "Staffordshire", lat: 52.95, lng: -2.15, zoom: 10 },
  { id: "stoke", nation: "england", label: "Stoke-on-Trent", lat: 53.02, lng: -2.18, zoom: 12 },
  { id: "yorkshire", nation: "england", label: "Yorkshire", lat: 53.8, lng: -1.3, zoom: 9 },
  { id: "wales", nation: "wales", label: "Wales", lat: 52.4, lng: -3.8, zoom: 8 },
  { id: "scotland", nation: "scotland", label: "Scotland", lat: 56.5, lng: -4.2, zoom: 7 },
  { id: "ni", nation: "ni", label: "Northern Ireland", lat: 54.6, lng: -6.5, zoom: 9 },
  { id: "ireland", nation: "ireland", label: "Ireland", lat: 53.4, lng: -7.9, zoom: 7 },
  { id: "connacht", nation: "ireland", label: "Connacht", lat: 53.8, lng: -9.0, zoom: 9 },
  { id: "leinster", nation: "ireland", label: "Leinster", lat: 53.3, lng: -6.5, zoom: 9 },
  { id: "munster", nation: "ireland", label: "Munster", lat: 52.3, lng: -8.5, zoom: 9 },
  { id: "ulster", nation: "ireland", label: "Ulster", lat: 54.5, lng: -7.0, zoom: 9 },
  { id: "iom", nation: "iom", label: "Isle of Man", lat: 54.2, lng: -4.55, zoom: 10 },
];

const NATION_LABEL = Object.fromEntries(HOME_NATIONS.map((n) => [n.id, n.label]));
NATION_LABEL.england = "England";

let homeNationFilter = "all";

function openHomeArea(area) {
  if (!area) return;
  const lat = Number(area.lat);
  const lng = Number(area.lng);
  const zoom = Number(area.zoom) || 8;
  // Clear History · Map / tails before jumping regions — otherwise Staffs stays empty.
  exitHistoryMapMode({ reload: false });
  setAppTab("map");
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    requestAnimationFrame(() => {
      try {
        map.setView([lat, lng], zoom, { animate: true });
        map.invalidateSize();
      } catch {
        /* ignore */
      }
      loadBuses({ replace: true }).catch(() => {});
    });
  }
}

function renderHomeAreas() {
  const filtersEl = document.getElementById("home-nation-filters");
  const gridEl = document.getElementById("home-region-grid");
  if (!filtersEl || !gridEl) return;

  filtersEl.replaceChildren(
    ...HOME_NATIONS.map((nation) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `home-nation-chip${homeNationFilter === nation.id ? " is-on" : ""}`;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", homeNationFilter === nation.id ? "true" : "false");
      btn.dataset.nation = nation.id;
      btn.textContent = nation.label;
      btn.addEventListener("click", () => {
        homeNationFilter = nation.id;
        renderHomeAreas();
      });
      return btn;
    }),
  );

  const areas =
    homeNationFilter === "all"
      ? HOME_AREAS
      : HOME_AREAS.filter((area) => area.nation === homeNationFilter);

  gridEl.replaceChildren(
    ...areas.map((area) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "home-region-tile";
      btn.setAttribute("role", "listitem");
      btn.dataset.area = area.id;
      const nationName = NATION_LABEL[area.nation] || "";
      const showNation =
        homeNationFilter === "all" && nationName && nationName !== "All" && area.label !== nationName;
      btn.innerHTML = `<span>${area.label}</span>${
        showNation ? `<span class="home-region-tile-nation">${nationName}</span>` : ""
      }`;
      btn.addEventListener("click", () => openHomeArea(area));
      return btn;
    }),
  );
}

renderHomeAreas();

// Start on home.
setAppTab("home");

const fleetBrowser = fleetContentEl
  ? createFleetBrowser({
      root: fleetContentEl,
      onTrackVehicle: async ({ reg, fleet, id, lat, lng }) => {
        setAppTab("map");
        const query = reg || fleet;
        const focusLat = Number(lat);
        const focusLng = Number(lng);
        if (Number.isFinite(focusLat) && Number.isFinite(focusLng)) {
          showMessage("");
          map.setView([focusLat, focusLng], 16);
          if (id) pendingFocus = { kind: "bus", id };
          await loadBuses({ replace: true });
          revealPendingFocus();
          if (pendingFocus) {
            pendingFocus = null;
            const hit = query ? findOnMap(query) : null;
            if (hit) focusMarker(hit);
          }
          return;
        }
        if (!query) {
          showMessage("No registration to track");
          return;
        }
        document.getElementById("query").value = query;
        showMessage("Finding vehicle…");
        await searchVehicleRemote(query);
      },
      onPlayJourney: (opts) => {
        setAppTab("map");
        startRoutePlayback({
          ...opts,
          showTail: true,
          autoReplay: Boolean(opts?.autoReplay),
          recordedReplay: Boolean(opts?.recordedReplay),
          live: Boolean(opts?.live),
        });
      },
      onShowRouteTails: (opts) => {
        showFleetRouteTails(opts);
      },
      onUploadBusPhoto: async ({ file, reg, fleet, operator, uploaderName }) => {
        if (!requirePlus("bus-photo")) {
          throw new Error("Plus is required to submit bus photos");
        }
        return submitBusPhotoFile(file, { reg, fleet, operator, uploaderName });
      },
    })
  : null;

document.getElementById("fleet-search-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = document.getElementById("fleet-query")?.value.trim() || "";
  fleetBrowser?.search(query);
});

document.getElementById("fleet-route-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const line = document.getElementById("fleet-route-query")?.value.trim() || "";
  if (!line) return;
  setAppTab("fleet");
  fleetBrowser?.searchRoute(line);
});

followChipEl?.addEventListener("click", () => stopFollowBus());
playbackStopEl?.addEventListener("click", () => stopRoutePlayback("", { clearTail: true }));
playbackReplayEl?.addEventListener("click", () => {
  if (!gpsReplay) return;
  if (gpsReplay.playing) gpsReplayPause();
  else if (gpsReplay.pos >= gpsReplay.t1 - gpsReplay.t0) {
    gpsReplay.pos = 0;
    gpsReplay.hasStarted = false;
    gpsReplayStart();
  } else gpsReplayStart();
});
playbackSpeedEl?.addEventListener("click", () => {
  if (!gpsReplay) return;
  const i = GPS_REPLAY_SPEEDS.indexOf(gpsReplay.speed);
  gpsReplay.speed = GPS_REPLAY_SPEEDS[(i + 1) % GPS_REPLAY_SPEEDS.length];
  playbackSpeedEl.textContent = `×${gpsReplay.speed}`;
});
playbackScrubEl?.addEventListener("input", () => {
  if (!gpsReplay) return;
  setGpsReplayActive(true);
  gpsReplay.hasStarted = true;
  gpsReplayControls(true);
  const frac = Number(playbackScrubEl.value) / 1000;
  gpsReplay.pos = (gpsReplay.t1 - gpsReplay.t0) * Math.min(1, Math.max(0, frac));
  const t = gpsReplay.t0 + gpsReplay.pos;
  gpsReplaySetCursor(t);
});
journeyPanelCloseEl?.addEventListener("click", () => {
  if (playback) stopRoutePlayback("", { clearTail: true });
  else hideJourneyPanel();
});
journeyPanelTimetableToggleEl?.addEventListener("click", () => {
  setJourneyTimetableMinimized(!isJourneyTimetableMinimized());
});
syncJourneyTimetableMinimized();
document.getElementById("tail-close")?.addEventListener("click", () => stopRoutePlayback("", { clearTail: true }));
window.speechSynthesis?.addEventListener?.("voiceschanged", () => {});

document.getElementById("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = document.getElementById("query").value.trim();
  if (!query) return;
  showMessage("");

  const postcode = query.replace(/\s+/g, "").toUpperCase();
  const looksLikePostcode = /^[A-Z]{1,2}\d/.test(postcode) && /[0-9][A-Z]{2}$/.test(postcode);
  const asReg = looksLikeUkReg(query);

  try {
    // Registrations always search vehicles first (never geocode).
    if (asReg || (isVehicleQuery(query) && !looksLikePostcode)) {
      await searchVehicleRemote(query);
      return;
    }

    if (looksLikePostcode) {
      const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
      const data = await res.json();
      if (data.status !== 200) throw new Error(data.error || "Postcode not found");
      map.setView([data.result.latitude, data.result.longitude], 14);
      return;
    }

    const onMap = findOnMap(query);
    if (onMap && compactQuery(query).length <= 5) {
      focusMarker(onMap);
      return;
    }

    const url = new URL("/api/geocode", window.location.origin);
    url.searchParams.set("q", `${query}, United Kingdom`);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    const res = await fetch(url);
    const results = await res.json();
    if (results[0]) {
      map.setView([Number(results[0].lat), Number(results[0].lon)], 13);
      return;
    }
    if (onMap) {
      focusMarker(onMap);
      return;
    }
    await searchVehicleRemote(query);
  } catch (error) {
    showMessage(error.message);
  }
});

updateUkClock();
setInterval(updateUkClock, 1000);
syncHomeLiveCountPolling();

map.whenReady(() => {
  map.invalidateSize();
  syncLiveSchedule();
});

const youIcon = L.divIcon({
  className: "you-marker",
  html: '<span class="you-pulse"></span><span class="you-dot"></span>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

let youMarker = null;
let youCircle = null;
let watchId = null;
let followYou = false;
let locateButton = null;

function setYou(lat, lng, accuracy) {
  const latlng = L.latLng(lat, lng);
  const radius = Number.isFinite(accuracy) ? Math.max(accuracy, 12) : 30;
  if (!youMarker) {
    youMarker = L.marker(latlng, { icon: youIcon, zIndexOffset: 2000, interactive: true })
      .bindPopup("You are here")
      .addTo(map);
    youCircle = L.circle(latlng, {
      radius,
      color: "#2563eb",
      weight: 1,
      fillColor: "#3b82f6",
      fillOpacity: 0.12,
      interactive: false,
    }).addTo(map);
  } else {
    youMarker.setLatLng(latlng);
    youCircle.setLatLng(latlng);
    youCircle.setRadius(radius);
  }
  if (followYou) {
    map.setView(latlng, Math.max(map.getZoom(), 15), { animate: true });
  }
}

function startLiveLocation({ follow = true } = {}) {
  if (!navigator.geolocation) {
    showMessage("Location is not available in this browser");
    return;
  }
  if (follow) stopFollowBus();
  followYou = follow;
  locateButton?.classList.add("active");
  if (watchId != null) {
    if (youMarker && follow) map.setView(youMarker.getLatLng(), Math.max(map.getZoom(), 15));
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      showMessage("");
      setYou(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
    },
    (err) => {
      locateButton?.classList.remove("active");
      const messages = {
        1: "Location permission denied",
        2: "Location unavailable",
        3: "Location timed out",
      };
      showMessage(messages[err.code] || "Could not get your location");
    },
    { enableHighAccuracy: true, maximumAge: 4000, timeout: 12000 },
  );
}

const LocateControl = L.Control.extend({
  onAdd() {
    const wrap = L.DomUtil.create("div", "leaflet-bar");
    locateButton = L.DomUtil.create("a", "locate-btn", wrap);
    locateButton.href = "#";
    locateButton.title = "Live location";
    locateButton.setAttribute("role", "button");
    locateButton.setAttribute("aria-label", "Show my live location");
    locateButton.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2"/></svg>';
    L.DomEvent.disableClickPropagation(wrap);
    L.DomEvent.on(locateButton, "click", (event) => {
      L.DomEvent.preventDefault(event);
      startLiveLocation({ follow: true });
    });
    return wrap;
  },
});

new LocateControl({ position: "topleft" }).addTo(map);
map.on("dragstart", () => {
  followYou = false;
  if (!followPanning) stopFollowBus();
});

if (navigator.permissions?.query) {
  navigator.permissions
    .query({ name: "geolocation" })
    .then((status) => {
      if (status.state === "granted") startLiveLocation({ follow: false });
      status.addEventListener("change", () => {
        if (status.state === "granted") startLiveLocation({ follow: false });
      });
    })
    .catch(() => {});
}

window.addEventListener("resize", () => map.invalidateSize());

const DONATE_DISMISS_KEY = "uk-bus-donate-dismissed";
const DONATE_URL = String(import.meta.env.VITE_DONATE_URL || "").trim();

function donateHref(amount = "") {
  if (!DONATE_URL) return "#";
  const base = DONATE_URL.replace(/\/+$/, "");
  if (amount && /paypal\.me\//i.test(base)) return `${base}/${amount}`;
  return base;
}

function setupDonateBox() {
  const box = document.getElementById("donate-box");
  const link = document.getElementById("donate-link");
  const hint = document.getElementById("donate-hint");
  const closeBtn = document.getElementById("donate-close");
  if (!box || !link) return;

  if (isPlus() || localStorage.getItem(DONATE_DISMISS_KEY) === "1") {
    box.hidden = true;
    return;
  }

  const ready = Boolean(DONATE_URL);
  link.href = donateHref();
  link.classList.toggle("is-disabled", !ready);
  if (hint) hint.hidden = ready;

  document.querySelectorAll(".donate-amount").forEach((el) => {
    const amount = el.dataset.amount || "";
    el.href = donateHref(amount);
    el.classList.toggle("is-disabled", !ready);
  });

  closeBtn?.addEventListener("click", () => {
    box.hidden = true;
    localStorage.setItem(DONATE_DISMISS_KEY, "1");
  });
}

function applyPlusEntitlements(on) {
  const donate = document.getElementById("donate-box");
  if (on) {
    if (donate) donate.hidden = true;
    return;
  }
  announceOn = false;
  localStorage.setItem("uk-bus-announce", "0");
  if (announceEl) announceEl.checked = false;
  clearSpeech();
  if (stopBoardOn) setStopBoardEnabled(false);
  if (stopBoardToggleEl) stopBoardToggleEl.checked = false;
  if (historyDays > FREE_HISTORY_DAYS) {
    historyDays = FREE_HISTORY_DAYS;
    localStorage.setItem(HISTORY_DAYS_KEY, String(FREE_HISTORY_DAYS));
  }
  if (donate && localStorage.getItem(DONATE_DISMISS_KEY) !== "1") {
    donate.hidden = false;
  }
  const open = openJourneyMarker?.();
  if (open) refreshPopup(open, { force: true });
}

setupAuth({
  onChange: (user) => {
    syncPlusFromAccount(user);
  },
});
setupPlus({ onChange: applyPlusEntitlements });
setupDonateBox();
