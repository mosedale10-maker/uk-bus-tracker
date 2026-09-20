import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { createFleetBrowser, isSchoolBusLive, isStokeFcShuttleLive, isStokeFcLine, sameServiceLine, normalizeStokeFcLine, extractRouteFromVehicle, enrichJourneyRow, liveVehicleAsHistoryRow, mergeLiveHistoryRow, fetchAtHistoryFromTrails, mergeAtHistoryRows, isDivertedText, STAFFS_SCHOOL_ROUTES, STOKE_FC_SHUTTLE_ROUTES } from "./fleet.js";
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
import "./style.css";

window.L = L;

const MIN_ZOOM = 10;
const FLIX_MIN_ZOOM = 6;
const UK_TZ = "Europe/London";

const map = L.map("map", { zoomControl: true }).setView([54.2, -2.5], 6);

const streetsLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
});

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

L.control
  .layers(
    { Streets: streetsLayer, Satellite: satelliteLayer },
    {},
    { position: "topright", collapsed: false },
  )
  .addTo(map);

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
    from: "2026-09-24T19:00:00+01:00",
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
    iconSize: compact ? [36, 44] : [260, 150],
    iconAnchor: compact ? [18, 44] : [130, 150],
    popupAnchor: compact ? [0, -40] : [0, -140],
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
    // At street zoom, open the message so it is obvious.
    if (!compact) {
      marker.openPopup();
    }
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
const clockEl = document.getElementById("uk-clock");
const liveBusCountEl = document.getElementById("live-bus-count");
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
    const iconKey = `${zoomBand}|${marker.line}|${Math.round(heading)}|${Math.round(item.speedMph || 0)}|${liveryCss(marker.staffLivery) || ""}`;
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
let busesBusy = false;
let busesGen = 0;
const BUS_POLL_MS = 3500;
const STALE_PING_MS = 5 * 60 * 1000;
/** Only bridge short gaps between AVL polls — never keep driving once the feed stalls. */
const COAST_MIN_AGE_MS = 1500;
const COAST_MAX_AGE_MS = 6500;
const COAST_MAX_M = 36;

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

function isStalePing(iso) {
  return pingAgeMs(iso) > STALE_PING_MS;
}

function pruneStaleMarkers() {
  for (const [id, marker] of markers) {
    if (!isStalePing(marker.bus?.datetime)) continue;
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
  if (!liveBusCountEl) return;
  const n = ukLiveBusCount;
  if (n == null) {
    if (!liveBusCountEl.textContent) liveBusCountEl.textContent = "Counting UK buses…";
    return;
  }
  liveBusCountEl.textContent =
    n === 0
      ? "No buses tracked across the UK right now"
      : n === 1
        ? "1 bus currently tracked across the UK"
        : `${n.toLocaleString("en-GB")} buses currently tracked across the UK`;
}

function updateUkClock() {
  const now = new Date();
  clockEl.dateTime = now.toISOString();
  clockEl.textContent = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(now);
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

function mapTripStops(times) {
  return (times || []).map((row) => {
    const loc = row.stop?.location;
    const lng = Number(loc?.[0]);
    const lat = Number(loc?.[1]);
    const aimed = clockLabel(rowAimed(row));
    const expected = clockLabel(row.expected_departure_time || row.expected_arrival_time || row.expected);
    const actual = clockLabel(row.actual_departure_time || row.actual_arrival_time);
    return {
      name: row.stop?.name || row.stop?.common_name || row.name || "",
      atco: row.stop?.atco_code || row.stop?.atcocode || "",
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      aimed,
      expected,
      actual,
      live: actual || expected || aimed,
      delaySec: stopDelaySeconds(row),
      timingStatus: String(row.timing_status || "").toUpperCase(),
      done: Boolean(row.actual_departure_time || row.actual_arrival_time),
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

const HISTORY_DAY_OPTIONS = [1, 3, 7];
const HISTORY_DAYS_KEY = "uk-bus-history-days";
const FREE_HISTORY_DAYS = 1;
let historyDays = (() => {
  const n = Number(localStorage.getItem(HISTORY_DAYS_KEY));
  const picked = HISTORY_DAY_OPTIONS.includes(n) ? n : 7;
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
  const d = new Date();
  d.setDate(d.getDate() - (Math.max(1, days) - 1));
  return ukDateKey(d);
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
  for (const id of [extra.btVehicle?.id, bus?.id]) {
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
  const trailMeta = {
    ...meta,
    reg,
    line,
    journeyId: journeyId ? String(journeyId) : meta.journeyId || "",
    direction,
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

function isAltonLine(line) {
  return ALTON_LINES.has(String(line || "").trim().toUpperCase());
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
            const divertTag = row.diverted
              ? ` <span class="history-divert-tag" title="Diverted">div</span>`
              : "";
            const liveTag = row.live ? ` <span class="history-live-tag">live</span>` : "";
            return `<div class="popup-history-row"><span class="history-time">${esc(formatHistoryTime(row.datetime))}</span><span class="history-line">${esc(line)}${divertTag}${liveTag}</span><span class="history-dest">${esc(dest)}</span>${
              row.trip_id || row.vehicle?.id || extra.trailKey || row.live || row.atTrail || row.atLive
                ? `<button type="button" class="history-play-btn" data-trip-id="${esc(row.trip_id || "")}" data-journey-id="${esc(trailFilterJourneyId(row.journey_id || row.id || "", line))}" data-vehicle-id="${esc(row.vehicle?.id || extra.btVehicle?.id || "")}" data-trail-key="${esc(row.trailKey || extra.trailKey || "")}" data-reg="${esc(extra.vehicle?.reg || extra.btVehicle?.reg || "")}" data-line="${esc(line)}" data-direction="${esc(normalizeTrailDirection(row.direction || ""))}" data-dest="${esc(dest)}" data-datetime="${esc(row.datetime || "")}" title="Show this route on the map">Map</button>`
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

const playbackLayer = L.layerGroup().addTo(map);
const liveTrailLayer = L.layerGroup().addTo(map);
/** Active static route overlay (not animated playback). */
let playback = null;

const TRAIL_STORE_KEY = "uk-bus-trails-v1";
const TRAIL_MAX_POINTS = 8000;
const TRAIL_MAX_VEHICLES = 60;
/** Server + local GPS tails are always kept for this many days (independent of Plus history chips). */
const TRAIL_KEEP_DAYS = 7;
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
    if (!map.has(k)) map.set(k, p);
  }
  return pruneTrailPoints([...map.values()].sort((a, b) => a.t - b.t));
}

function queueTrailUpload(key, point) {
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
    batches.push({ key, points: points.splice(0, 200) });
  }
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

async function fetchServerTrails(keys, { fromMs = 0, toMs = 0, force = false } = {}) {
  const list = [...new Set((keys || []).map((k) => String(k || "").trim()).filter(Boolean))].slice(0, 8);
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
    const trails = data?.trails && typeof data.trails === "object" ? data.trails : {};
    for (const key of need) {
      trailServerFetched.set(key, now);
      const incoming = Array.isArray(trails[key]) ? trails[key] : [];
      if (!incoming.length) continue;
      const merged = mergeTrailPoints(trailMem.get(key) || [], incoming);
      trailMem.set(key, merged);
      trailPersistIds.add(key);
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
      } else {
        // No direction yet — undirected keys only (direction will be inferred/clipped later).
        push(`run:${primary}:${lineCode}:${day}`);
        if (ALTON_LINES.has(lineCode)) push(`at:${lineCode}:${primary}:${day}`);
      }
    }
  }
  return keys;
}

function recordVehicleTrail(key, lat, lng, heading, meta = {}) {
  if (!key || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const id = String(key);
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
  // Direction flip on the live vehicle key — don't draw a chord across the turnaround.
  if (
    last &&
    direction &&
    last.direction &&
    direction !== last.direction &&
    !meta._segmented
  ) {
    // Still record the point; segment keys below isolate in vs out.
  }
  points.push({
    t: now,
    lat,
    lng,
    heading: Number.isFinite(heading) ? heading : null,
    journeyId,
    tripId,
    line,
    direction,
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
    // Strict: when a direction is requested, never include the opposite leg (or undirected mix-ins).
    if (wantDir) {
      const pDir = normalizeTrailDirection(p.direction);
      if (pDir && pDir !== wantDir) return false;
      if (!pDir) return false;
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
    const journeyFlip = Boolean(prevJ && nextJ && prevJ !== nextJ);
    const tripFlip = Boolean(prevTrip && nextTrip && prevTrip !== nextTrip);
    // Direction flip always starts a new trip — even when the bus turns at the terminus.
    const dirFlip = Boolean(prevDir && nextDir && prevDir !== nextDir);
    const gap = Number.isFinite(dt) && dt > gapMs;

    let turnaround = false;
    if (!dirFlip && !journeyFlip && !tripFlip && !gap && cur.length >= 10) {
      const start = cur[0];
      const runDist = haversineMeters(start.lat, start.lng, prev.lat, prev.lng);
      const step = haversineMeters(prev.lat, prev.lng, next.lat, next.lng);
      const headFlip = trailHeadingDelta(prev.heading, next.heading) >= 135;
      // U-turn after a real outbound: reverse heading while barely moving.
      if (runDist >= 700 && headFlip && step < 140) turnaround = true;
    }

    if (journeyFlip || tripFlip || dirFlip || gap || turnaround) {
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
        (p.tripId && !prev.tripId)
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
function pinSeparateTripTails(segments, { baseKey = "bus", line = "", operator = "" } = {}) {
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
        operator: p.operator || operator || "",
      })),
    );
    pinnedTrailFilters.set(key, {
      line: String(line || "").trim(),
      direction: dir,
      fromMs: startT - 30_000,
      toMs: endT + 30_000,
      operator: String(operator || "").trim().toUpperCase(),
    });
    pinnedTrailKeys.add(key);
    refreshPinnedTrailLine(key);
    drawn.push(key);
  }
  return drawn;
}

const TRAIL_CASING = {
  color: "#ffffff",
  weight: 5,
  opacity: 0.55,
  lineJoin: "round",
  lineCap: "round",
  interactive: false,
};
const TRAIL_STROKE = {
  color: "#0f172a",
  weight: 2.25,
  opacity: 1,
  lineJoin: "round",
  lineCap: "round",
  interactive: false,
};

/** Break trails only on real GPS teleports — not normal sparse AVL pings (rural Staffs runs often skip 2–4 km). */
const TRAIL_BREAK_GAP_M = 4500;
const TRAIL_BREAK_HARD_M = 12000;
const TRAIL_BREAK_GAP_MS = 15 * 60_000;
const TRAIL_BREAK_SPEED_MPH = 100;
/** FlixBus / National Express motorway runs — sparse AVL; keep A→B continuous. */
const COACH_TRAIL_NOCS = new Set(["FLIX", "NATX"]);
const COACH_TRAIL_BREAK_GAP_M = 28000;
const COACH_TRAIL_BREAK_HARD_M = 95000;
const COACH_TRAIL_BREAK_GAP_MS = 45 * 60_000;
const COACH_TRAIL_BREAK_SPEED_MPH = 130;
const COACH_TRAIL_LIVE_MS = 14 * 60 * 60 * 1000;

function isCoachTrailOperator(operator) {
  return COACH_TRAIL_NOCS.has(String(operator || "").trim().toUpperCase());
}

function trailBreakLimits({ coach = false, operator = "" } = {}) {
  if (coach || isCoachTrailOperator(operator)) {
    return {
      gapM: COACH_TRAIL_BREAK_GAP_M,
      hardM: COACH_TRAIL_BREAK_HARD_M,
      gapMs: COACH_TRAIL_BREAK_GAP_MS,
      speedMph: COACH_TRAIL_BREAK_SPEED_MPH,
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
  if (!Array.isArray(gps) || gps.length < 2) return [];
  const out = [];
  for (const p of gps) {
    if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
      const t = Number(p[3] ?? p.t);
      out.push({
        lat: p[0],
        lng: p[1],
        heading: Number.isFinite(p[2]) ? p[2] : null,
        t: Number.isFinite(t) ? t : null,
        direction: normalizeTrailDirection(p[4] ?? p.direction),
      });
      continue;
    }
    const lat = Number(p?.lat);
    const lng = Number(p?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const heading = Number(p?.heading);
    const t = Number(p?.t);
    out.push({
      lat,
      lng,
      heading: Number.isFinite(heading) ? heading : null,
      t: Number.isFinite(t) ? t : null,
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
  return `${day} · ${time}`;
}

function trailArrowIcon(bearingDeg) {
  const rot = Number.isFinite(bearingDeg) ? bearingDeg : 0;
  const z = map.getZoom();
  const size = z < 13 ? 14 : z < 15 ? 18 : 22;
  const half = size / 2;
  return L.divIcon({
    className: "trail-arrow-icon",
    html: `<button type="button" class="trail-arrow-hit" aria-label="Show time at this point"><span class="trail-arrow-chevron" style="--trail-rot:${rot}deg" aria-hidden="true"></span></button>`,
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
  if (op) return { operator: op, coach: isCoachTrailOperator(op) };
  if (filter?.coach) return { coach: true, operator: op || "" };
  const pts = trailMem.get(String(key || "")) || [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const pOp = String(pts[i]?.operator || "").trim().toUpperCase();
    if (pOp) return { operator: pOp, coach: isCoachTrailOperator(pOp) };
  }
  // Live Flix / NATX markers: bus.id is the trail key but points may lack operator yet.
  const id = String(key || "");
  if (id) {
    for (const marker of markers.values()) {
      if (String(marker?.bus?.id) !== id) continue;
      if (isFlixBus(marker.bus) || isNationalExpress(marker.bus)) {
        const noc = trailOperatorForBus(marker.bus);
        return { operator: noc, coach: true };
      }
    }
  }
  return {};
}

function gpsTimeAtPathFraction(gpsPts, frac) {
  const pts = normalizeGpsTrailPoints(gpsPts);
  if (!pts.length) return null;
  if (pts.length === 1) return Number.isFinite(pts[0].t) ? pts[0].t : null;
  let total = 0;
  const edges = [];
  for (let i = 1; i < pts.length; i += 1) {
    const d = haversineMeters(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
    total += Math.max(d, 0);
    edges.push({ d: Math.max(d, 0), a: pts[i - 1], b: pts[i] });
  }
  if (!(total > 0)) {
    return Number.isFinite(pts[pts.length - 1].t) ? pts[pts.length - 1].t : pts[0].t;
  }
  let target = Math.max(0, Math.min(1, frac)) * total;
  for (const edge of edges) {
    if (target <= edge.d) {
      const t = edge.d > 0 ? target / edge.d : 0;
      return interpolateTrailTime(edge.a, edge.b, t);
    }
    target -= edge.d;
  }
  return Number.isFinite(pts[pts.length - 1].t) ? pts[pts.length - 1].t : null;
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
  const maxArrows = 480;
  const z = map.getZoom();
  // Fewer, smaller markers when zoomed out so the trail stays readable.
  const spacingMul = z < 12 ? 2.4 : z < 13 ? 1.85 : z < 14 ? 1.35 : z < 15 ? 1.1 : 1;
  const spacing =
    Math.max(
      28,
      Math.min(58, total / Math.max(24, Math.min(maxArrows, Math.ceil(total / 32)))),
    ) * spacingMul;
  let placed = 0;
  let covered = 0;
  const placeArrow = (lat, lng, bear, atMs) => {
    const when = formatTrailArrowTime(atMs);
    const marker = L.marker([lat, lng], {
      icon: trailArrowIcon(bear),
      interactive: true,
      keyboard: true,
      zIndexOffset: 250,
      title: when ? `Bus here at ${when}` : "Tracked position",
    });
    marker.bindPopup(
      when
        ? `<div class="trail-arrow-popup"><strong>Bus was here</strong><div class="trail-arrow-popup-time">${esc(when)}</div></div>`
        : `<div class="trail-arrow-popup"><strong>Tracked position</strong><div class="trail-arrow-popup-time">Time unknown for this point</div></div>`,
      { className: "trail-arrow-popup-wrap", maxWidth: 220, closeButton: true },
    );
    marker.on("click", (event) => {
      L.DomEvent.stopPropagation(event);
      marker.openPopup();
    });
    marker.addTo(layer);
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
        placeArrow(lat, lng, bear, gpsTimeAtPathFraction(gps, frac));
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
      placeArrow(last[0], last[1], endBear, gpsTimeAtPathFraction(gps, (covered + travelled) / total));
    }
    covered += travelled;
  }
  return arrows;
}

function makeTrailPair(path, layer, opts = {}) {
  const breakOpts = { operator: opts.operator || "", coach: !!opts.coach };
  const latlngs = asTrailLatLngs(path, breakOpts);
  const casing = L.polyline(latlngs, { ...TRAIL_CASING }).addTo(layer);
  const line = L.polyline(latlngs, { ...TRAIL_STROKE }).addTo(layer);
  const gps = opts.gpsPoints || opts.gpsPath || null;
  const arrows = opts.deferArrows
    ? []
    : buildTrailArrowsAlongRoad(path, layer, { gpsPoints: gps, breakOpts });
  return { casing, line, arrows, layer, gpsPoints: gps || null, breakOpts };
}

function setTrailPairPath(pair, path, opts = {}) {
  if (!pair) return;
  const breakOpts = {
    ...(pair.breakOpts || {}),
    ...(opts.operator || opts.coach ? { operator: opts.operator || "", coach: !!opts.coach } : {}),
  };
  if (opts.operator || opts.coach) pair.breakOpts = breakOpts;
  const latlngs = asTrailLatLngs(path, pair.breakOpts || breakOpts);
  pair.casing.setLatLngs(latlngs);
  pair.line.setLatLngs(latlngs);
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
    breakOpts: pair.breakOpts || breakOpts,
  });
}

function removeTrailPair(pair, layer) {
  if (!pair) return;
  clearTrailArrows(pair, layer || pair.layer);
  const target = layer || pair.layer;
  target?.removeLayer(pair.casing);
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

async function resolveTripIdForPlayback({ tripId = "", journeyId = "", vehicleId = "", line = "", datetime = "" } = {}) {
  if (tripId) return String(tripId);
  if (!vehicleId) return "";
  const rows = await fetchVehicleHistory(vehicleId, Math.max(historyDays, 7));
  if (!rows.length) return "";
  const wantJourney = journeyId ? String(journeyId) : "";
  const wantLine = String(line || "").trim();
  const targetMs = datetime ? new Date(datetime).getTime() : NaN;
  let best = null;
  for (const row of rows) {
    if (!row?.trip_id) continue;
    if (wantJourney && String(row.id) === wantJourney) return String(row.trip_id);
    if (wantLine && row.route_name && !sameServiceLine(row.route_name, wantLine)) continue;
    const rowMs = row.datetime ? new Date(row.datetime).getTime() : NaN;
    const dt =
      Number.isFinite(targetMs) && Number.isFinite(rowMs) ? Math.abs(rowMs - targetMs) : Number.POSITIVE_INFINITY;
    if (!best || dt < best.dt) best = { tripId: String(row.trip_id), dt };
  }
  return best?.tripId || "";
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
  const breakOpts = trailBreakOptsFromFilter(filter, id);
  const gpsPoints = trackedPointsFor(id, filter);
  const path = pathFromGpsPoints(gpsPoints);
  const existing = pinnedTrailLines.get(id);
  if (path.length < 2) {
    if (existing) {
      removeTrailPair(existing, liveTrailLayer);
      pinnedTrailLines.delete(id);
    }
    pinnedTrailAlignWanted.delete(id);
    return;
  }
  // Never paint raw GPS chords — only show the line after road matching.
  if (!existing) {
    pinnedTrailLines.set(
      id,
      makeTrailPair([], liveTrailLayer, { gpsPoints, deferArrows: true, ...breakOpts }),
    );
  } else {
    existing.gpsPoints = gpsPoints;
    existing.breakOpts = { ...(existing.breakOpts || {}), ...breakOpts };
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
      if (!pair || flattenTrailLatLngs(aligned).length < 2) continue;
      setTrailPairPath(pair, aligned, { gpsPoints: job.gpsPoints });
    }
  } finally {
    pinnedTrailAlignBusy.set(key, false);
    if (pinnedTrailKeys.has(key) && pinnedTrailAlignWanted.has(key)) runPinnedTrailAlign(key);
  }
}

function refreshLiveTrailLine(key) {
  const breakOpts = trailBreakOptsFromFilter({}, key);
  const gpsPoints = trackedPointsFor(key);
  const path = pathFromGpsPoints(gpsPoints);
  if (path.length < 2) {
    if (liveTrailLine) {
      removeTrailPair(liveTrailLine, liveTrailLayer);
      liveTrailLine = null;
    }
    liveTrailAlignWanted = null;
    return;
  }
  if (!liveTrailLine) {
    // Empty until road match finishes — avoids chords through buildings.
    liveTrailLine = makeTrailPair([], liveTrailLayer, { gpsPoints, deferArrows: true, ...breakOpts });
  } else {
    liveTrailLine.gpsPoints = gpsPoints;
    liveTrailLine.breakOpts = { ...(liveTrailLine.breakOpts || {}), ...breakOpts };
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
      if (flattenTrailLatLngs(aligned).length < 2) continue;
      setTrailPairPath(liveTrailLine, aligned, { gpsPoints: job.gpsPoints });
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

function trailTimeWindow(datetime) {
  if (!datetime) return { fromMs: 0, toMs: 0 };
  const start = new Date(datetime).getTime();
  if (!Number.isFinite(start)) return { fromMs: 0, toMs: 0 };
  return {
    fromMs: start - 30 * 60 * 1000,
    // One there OR back run — not a full day of both directions.
    toMs: start + 5 * 60 * 60 * 1000,
  };
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
} = {}) {
  const code = String(line || "").trim();
  const opCode = String(operator || "").trim().toUpperCase();
  const forceSingle = isSingleVehicleRouteOperator(opCode) || isSingleVehicleRouteLine(code);
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
  if (forceSingle) {
    if (vehicleId || trailKey || reg || journeyId || tripId) {
      targets = single.length ? single : targets.slice(0, 1);
    } else if (targets.length !== 1) {
      showMessage("Open a bus and press Map — only that vehicle’s route is shown on the map");
      return;
    }
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
    const window = trailTimeWindow(vWhen);
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

  // Line-wide server lookup only when not a single-vehicle operator (those must pick a bus).
  if (!keys.size && code && !forceSingle) {
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

  if (!keys.size) {
    showMessage(
      forceSingle
        ? `No GPS tail for this bus yet — leave it open on the map or wait for the server recorder`
        : `No GPS tails for ${label} yet`,
    );
    return;
  }

  await fetchServerTrailsChunked([...keys], { force: true });

  clearPinnedTrails();
  multiTailActiveGroup = { id: `route:${code || "one"}`, label };
  const drawn = [];
  const seenSeg = new Set();

  // One tail polyline per trip — never glue Hanley→Newcastle with Newcastle→Hanley.
  for (const v of targets) {
    const vLine = String(v.line || v.route_name || code || "").trim();
    const vWhen = v.datetime || v.recordedAtTime || v.trackedAt || datetime || "";
    const window = trailTimeWindow(vWhen);
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
    const gps = collectTrailGpsForKeys(vKeys.length ? vKeys : [...keys], {
      line: vLine || code,
      fromMs: window.fromMs,
      toMs: window.toMs,
    });
    const segments = segmentTrailIntoTrips(gps);
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

  // Line-wide fallback: segment whatever keys we found for the route.
  if (!drawn.length && keys.size) {
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
    multiTailActiveGroup = {
      id: `route:${code || "one"}`,
      label: `${label}${drawn.length > 1 ? ` · ${drawn.length} trips` : ""}`,
    };
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

async function fetchTrailKeysForGroup(group, { days = TRAIL_KEEP_DAYS } = {}) {
  if (!group) return [];
  try {
    const params = new URLSearchParams({
      days: String(days),
      limit: "40",
    });
    if (group.operators?.length) params.set("operators", group.operators.join(","));
    if (group.lines?.length) params.set("lines", group.lines.join(","));
    const res = await fetch(`/api/trails/keys?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.keys)
      ? data.keys.map((row) => String(row?.key || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

async function fetchServerTrailsChunked(keys, opts = {}) {
  const list = [...new Set((keys || []).map((k) => String(k || "").trim()).filter(Boolean))];
  for (let i = 0; i < list.length; i += 8) {
    await fetchServerTrails(list.slice(i, i + 8), opts);
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
  live = false,
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
      ? Date.now() - (coachLive ? COACH_TRAIL_LIVE_MS : 4 * 60 * 60 * 1000)
      : window.fromMs,
    toMs: followLive ? 0 : window.toMs,
    live: followLive,
    follow: followLive,
  };
  multiTailActiveGroup = null;
  for (const key of keys) {
    if (
      filter.line ||
      filter.journeyId ||
      filter.tripId ||
      filter.direction ||
      filter.operator ||
      filter.fromMs ||
      filter.live
    ) {
      pinnedTrailFilters.set(String(key), filter);
    } else {
      pinnedTrailFilters.delete(String(key));
    }
    pinnedTrailKeys.add(key);
    rememberTrailVehicle(key);
    refreshPinnedTrailLine(key);
  }
  const primary = String(trailKey || vehicleId || keys[0] || "").trim();
  if (followLive && primary) setLiveTrailFocus(primary);
  updatePlaybackChrome();
}

function clearPinnedTrails() {
  for (const pair of pinnedTrailLines.values()) removeTrailPair(pair, liveTrailLayer);
  pinnedTrailLines.clear();
  pinnedTrailKeys.clear();
  pinnedTrailFilters.clear();
  multiTailActiveGroup = null;
  updatePlaybackChrome();
}

function setLiveTrailFocus(key) {
  liveTrailKey = key ? String(key) : "";
  if (!liveTrailKey) {
    if (liveTrailLine) {
      removeTrailPair(liveTrailLine, liveTrailLayer);
      liveTrailLine = null;
    }
    return;
  }
  rememberTrailVehicle(liveTrailKey);
  refreshLiveTrailLine(liveTrailKey);
}

loadTrailStore();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushTrailStore();
    flushTrailUpload().catch(() => {});
  }
});
window.addEventListener("pagehide", () => {
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

function stopRoutePlayback(message = "", { clearTail = false } = {}) {
  clearPlaybackLayers();
  playback = null;
  if (clearTail) {
    clearPinnedTrails();
    setLiveTrailFocus("");
  }
  updatePlaybackChrome();
  if (message) showMessage(message);
  const open = openJourneyMarker();
  if (open) refreshPopup(open, { force: true });
}

function routeOverlayActive(playKey, { vehicleId = "", trailKey = "" } = {}) {
  if (!playback?.playKey) return false;
  return (
    String(playback.playKey) === String(playKey) ||
    (vehicleId && String(playback.vehicleId) === String(vehicleId)) ||
    (trailKey && String(playback.trailKey || "") === String(trailKey))
  );
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
} = {}) {
  const playKey = tripId || journeyId || trailKey || vehicleId || regTrailKey(reg);
  if (!playKey) {
    showMessage("No route to show");
    return;
  }
  if (routeOverlayActive(playKey, { vehicleId, trailKey })) {
    stopRoutePlayback("", { clearTail: true });
    return;
  }
  showMessage("Loading route…");
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

  let fromMs = 0;
  let toMs = 0;
  let aroundMs = 0;
  if (datetime) {
    const start = new Date(datetime).getTime();
    if (Number.isFinite(start)) {
      aroundMs = start;
      // One outbound or inbound run — not the whole day there-and-back.
      fromMs = start - 30 * 60 * 1000;
      toMs = start + 5 * 60 * 60 * 1000;
    }
  }

  const resolvedTripId = await resolveTripIdForPlayback({
    tripId,
    journeyId: safeJourneyId,
    vehicleId,
    line,
    datetime,
  });
  // Prefer journey/trip segment keys first so Map shows this route only, not the whole day.
  if (resolvedTripId) {
    const tripSeg = `trip:${resolvedTripId}`;
    if (!keys.includes(tripSeg)) keys.unshift(tripSeg);
  }
  if (safeJourneyId) {
    const jnySeg = `jny:${safeJourneyId}`;
    if (!keys.includes(jnySeg)) keys.unshift(jnySeg);
  }
  await fetchServerTrails(keys, {
    fromMs: fromMs ? fromMs - 30 * 60_000 : 0,
    toMs: toMs ? toMs + 30 * 60_000 : 0,
    force: true,
  });

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
      await fetchServerTrails(keys, {
        fromMs: fromMs ? fromMs - 30 * 60_000 : 0,
        toMs: toMs ? toMs + 30 * 60_000 : 0,
        force: true,
      });
    }
  }

  // Load the full window without forcing one direction — we split trips below.
  const coachGapMs = isCoachTrailOperator(operator) ? COACH_TRAIL_BREAK_GAP_MS : 18 * 60_000;
  const trackOpts = {
    journeyId: "",
    tripId: "",
    fromMs,
    toMs,
    line,
    direction: "",
  };
  const allGps = collectTrailGpsForKeys(keys, trackOpts);
  const tripSegments = segmentTrailIntoTrips(allGps, { gapMs: coachGapMs });

  // Playback highlight: the one trip matching journey/trip/direction/time — not the whole there-and-back.
  let trackedGps = [];
  if (resolvedTripId || safeJourneyId || safeDirection || aroundMs) {
    const wantTrip = String(resolvedTripId || tripId || "").trim();
    const wantJny = String(safeJourneyId || "").trim();
    const match = tripSegments.find((seg) => {
      if (wantTrip && seg.some((p) => String(p.tripId || "") === wantTrip)) return true;
      if (wantJny && seg.some((p) => String(p.journeyId || "") === wantJny)) return true;
      return false;
    });
    if (match) trackedGps = match;
    else {
      trackedGps = clipPointsToSingleDirectionRun(allGps, {
        direction: safeDirection,
        aroundMs: aroundMs || (allGps[0] ? Number(allGps[0].t) : 0),
      });
    }
  } else if (tripSegments.length) {
    trackedGps = tripSegments[0];
  }
  if (trackedGps.length < 2 && allGps.length >= 2) {
    trackedGps = clipPointsToSingleDirectionRun(allGps, {
      direction: safeDirection,
      aroundMs: aroundMs || Number(allGps[0].t) || 0,
    });
  }

  let tracked = pathFromGpsPoints(trackedGps);
  const trip = resolvedTripId ? await tripEnds(resolvedTripId) : tripId ? await tripEnds(tripId) : null;
  const tripPath = Array.isArray(trip?.path) ? trip.path : [];
  const coachOp = isCoachTrailOperator(operator);
  // Always prefer the GPS trail the bus actually drove when we have one —
  // except coaches: sparse AVL often only covers a stub of a long motorway route.
  let usingTracked = tracked.length >= 2;
  if (coachOp && tripPath.length >= 2 && tracked.length >= 2) {
    const gpsLen = pathLengthMeters(tracked);
    const tripLen = pathLengthMeters(tripPath);
    const gpsSegs = splitLatLngsByGaps(tracked, undefined, { operator, coach: true });
    const fragmented = gpsSegs.length >= 4 && gpsLen < tripLen * 0.55;
    const stub = tripLen > 25000 && gpsLen < tripLen * 0.4;
    if (fragmented || stub) usingTracked = false;
  }
  let path = usingTracked ? tracked : tripPath.length >= 2 ? tripPath : tracked.length >= 2 ? tracked : [];
  if (path.length < 2 && tripSegments.some((s) => s.length >= 2)) {
    trackedGps = tripSegments.reduce((best, run) => (run.length > best.length ? run : best), tripSegments[0]);
    tracked = pathFromGpsPoints(trackedGps);
    path = tracked;
    usingTracked = path.length >= 2;
  }
  if (path.length < 2) {
    const hasAnyTrail = keys.some((key) => (trailMem.get(String(key)) || []).length > 0);
    showMessage(
      hasAnyTrail
        ? "Not enough of that journey tracked yet — leave the bus open on the map a little longer, then try Map again"
        : "No route shape yet — open the live bus on the map first so we can record its path, or try again when a timetable is available",
    );
    return;
  }
  showMessage("Matching trail to roads…");
  const roadPath = usingTracked ? await prepareRoadTrail(path, undefined, { operator }) : path;
  const hasRoad = flattenTrailLatLngs(roadPath).length >= 2;
  stopRoutePlayback("", { clearTail: true });

  // Pin tails: a specific Map row → that trip only; otherwise every trip separately.
  const baseKey = trailKey || vehicleId || regTrailKey(reg) || playKey;
  const wantTrip = String(resolvedTripId || tripId || "").trim();
  const wantJny = String(safeJourneyId || "").trim();
  let segmentsToPin = tripSegments;
  if (wantTrip || wantJny || safeDirection) {
    if (trackedGps.length >= 2) {
      segmentsToPin = [trackedGps];
    } else {
      const matched = tripSegments.filter((seg) => {
        if (wantTrip && seg.some((p) => String(p.tripId || "") === wantTrip)) return true;
        if (wantJny && seg.some((p) => String(p.journeyId || "") === wantJny)) return true;
        if (safeDirection) {
          const d = inferTrailDirection(seg) || normalizeTrailDirection(seg.find((p) => p.direction)?.direction);
          return d === safeDirection;
        }
        return false;
      });
      if (matched.length) segmentsToPin = matched;
    }
  }
  const pinnedSegs =
    segmentsToPin.length >= 1
      ? pinSeparateTripTails(segmentsToPin, { baseKey, line, operator })
      : [];
  if (!pinnedSegs.length && (showTail || usingTracked)) {
    // Fallback: single filtered pin if segmentation found nothing usable.
    pinVehicleTrail({
      vehicleId,
      trailKey,
      reg,
      journeyId: safeJourneyId,
      tripId: resolvedTripId || tripId,
      line,
      operator,
      direction: safeDirection,
      datetime,
    });
  } else if (pinnedSegs.length) {
    multiTailActiveGroup = {
      id: `play:${baseKey}`,
      label:
        pinnedSegs.length > 1
          ? `${line || "Bus"}${dest ? ` → ${dest}` : ""} · ${pinnedSegs.length} trips`
          : `${line || "Bus"}${dest ? ` → ${dest}` : ""}`,
    };
  } else {
    clearPinnedTrails();
    setLiveTrailFocus("");
  }

  // Keep a live-growing tail + arrows for this bus (including AT1–AT3 staff keys).
  const liveKey = String(trailKey || vehicleId || "").trim();
  if (liveKey && (showTail || usingTracked)) {
    rememberTrailVehicle(liveKey);
    const liveFilter = {
      line: String(line || "").trim(),
      direction: safeDirection,
      operator: String(operator || "").trim().toUpperCase(),
      fromMs: fromMs || Date.now() - (isCoachTrailOperator(operator) ? COACH_TRAIL_LIVE_MS : 4 * 60 * 60 * 1000),
      toMs: 0,
      live: true,
      follow: true,
    };
    pinnedTrailFilters.set(liveKey, liveFilter);
    pinnedTrailKeys.add(liveKey);
    setLiveTrailFocus(liveKey);
    refreshPinnedTrailLine(liveKey);
  }

  const lineName = line || trip?.line || "Bus";
  const hasTimetable = !usingTracked && tripPath.length >= 2;
  const labelParts = [
    `${lineName}${dest || trip?.headsign ? ` → ${dest || trip.headsign}` : ""}`,
    usingTracked
      ? pinnedSegs.length > 1
        ? `tracked · ${pinnedSegs.length} trips`
        : "tracked path · roads"
      : hasTimetable
        ? "timetable"
        : "route",
  ];
  if ((showTail || usingTracked) && compactReg(reg)) labelParts.push(compactReg(reg));
  const label = labelParts.join(" · ");

  if (hasTimetable) {
    L.polyline(tripPath, {
      color: "#38bdf8",
      weight: 4,
      opacity: 0.85,
      lineJoin: "round",
    }).addTo(playbackLayer);
  }

  const coachBreak = { operator, coach: isCoachTrailOperator(operator) };
  const drawPath = hasRoad ? roadPath : path;
  const drawFlat = flattenTrailLatLngs(drawPath);
  const tailPath = usingTracked
    ? drawPath
    : tracked.length >= 2
      ? await prepareRoadTrail(tracked, undefined, coachBreak)
      : [];
  const tailHasRoad = flattenTrailLatLngs(tailPath).length >= 2;
  if ((showTail || usingTracked) && flattenTrailLatLngs(tailPath).length >= 2) {
    makeTrailPair(tailPath, playbackLayer, {
      gpsPoints: trackedGps.length >= 2 ? trackedGps : path,
      deferArrows: usingTracked && !hasRoad && !tailHasRoad,
      ...coachBreak,
    });
  } else if (drawFlat.length >= 2 && !hasTimetable) {
    L.polyline(asTrailLatLngs(drawPath, coachBreak), {
      color: "#0f172a",
      weight: 2.25,
      opacity: 1,
      lineJoin: "round",
    }).addTo(playbackLayer);
  }

  if (drawFlat.length >= 2) {
    L.circleMarker(drawFlat[0], {
      radius: 6,
      color: "#ffffff",
      weight: 2,
      fillColor: "#22c55e",
      fillOpacity: 1,
    })
      .addTo(playbackLayer)
      .bindTooltip("Start", { direction: "top", opacity: 0.9 });
    L.circleMarker(drawFlat[drawFlat.length - 1], {
      radius: 6,
      color: "#ffffff",
      weight: 2,
      fillColor: "#ef4444",
      fillOpacity: 1,
    })
      .addTo(playbackLayer)
      .bindTooltip("End", { direction: "top", opacity: 0.9 });
  }

  const boundsPath = [
    ...(hasTimetable ? tripPath : []),
    ...drawFlat,
    ...flattenTrailLatLngs(tracked),
  ];
  if (boundsPath.length >= 2) {
    map.fitBounds(L.latLngBounds(boundsPath).pad(0.12), { maxZoom: 16, animate: true });
  }

  playback = {
    playKey,
    tripId: resolvedTripId || tripId,
    journeyId,
    vehicleId,
    trailKey,
    reg: compactReg(reg),
    path: drawPath,
    label,
    line: lineName,
    tracked: Boolean(usingTracked || tracked.length >= 2),
    showTail: Boolean(showTail || usingTracked),
  };
  applyHistoryLineFilterToMarkers({ vehicleId, trailKey, reg, line });
  messageEl.hidden = true;
  updatePlaybackChrome();
  const open = openJourneyMarker();
  if (open) refreshPopup(open, { force: true });
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
      await fleetBrowser.showVehicle(id);
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
  const vehicleId = historyVehicleId(bus, extra) || (!String(bus?.id || "").startsWith("dg-") ? bus?.id : "") || "";
  const trailKey = extra.trailKey || "";
  const reg = extra.vehicle?.reg || bus?.vehicle?.reg || "";
  if (!tripId && !vehicleId && !trailKey && !compactReg(reg)) return "";
  if (String(bus?.id || "").startsWith("dg-") && !trailKey && !vehicleId && !compactReg(reg)) return "";
  const playKey = tripId || trailKey || vehicleId || regTrailKey(reg);
  const on = routeOverlayActive(playKey, { vehicleId, trailKey });
  const direction = normalizeTrailDirection(
    extra.direction ||
      bus?.direction ||
      bus?.directionRef ||
      bus?.currentJourney?.directionRef ||
      "",
  );
  return `<button type="button" class="play-route-btn${on ? " is-on" : ""}" data-trip-id="${esc(tripId)}" data-journey-id="${esc(bus?.journey_id || "")}" data-vehicle-id="${esc(vehicleId)}" data-trail-key="${esc(trailKey)}" data-reg="${esc(reg)}" data-line="${esc(bus?.service?.line_name || extra.line || "")}" data-operator="${esc(trailOperatorForBus(bus) || extra.operator || "")}" data-direction="${esc(direction)}" data-dest="${esc(extra.to || bus?.destination || "")}" data-datetime="${esc(bus?.datetime || "")}">${on ? "Hide route" : "Show route"}</button>`;
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
  return `<button type="button" class="play-route-btn${on ? " is-on" : ""}" data-trip-id="${esc(tripId)}" data-journey-id="${esc(journeyId)}" data-vehicle-id="${esc(vehicleId)}" data-trail-key="${esc(trailKey)}" data-reg="${esc(reg)}" data-line="${esc(line)}" data-direction="${esc(direction)}" data-dest="${esc(extra.to || item.currentJourney?.destination?.name || "")}" data-datetime="${esc(latest?.datetime || item.recordedAtTime || "")}">${on ? "Hide route" : "Show route"}</button>`;
}

function followedMarker() {
  if (!followTarget) return null;
  if (followTarget.kind === "staff") return staffMarkers.get(followTarget.id) || null;
  return markers.get(followTarget.id) || markers.get(Number(followTarget.id)) || null;
}

/** Same live seat wording as the First Potteries bus card, for the top follow chip. */
function followSeatsChipText(marker) {
  if (!marker?.bus && !marker?.extra) return "";
  const bus = marker.bus || {};
  const extra = marker.extra || {};
  if (!(isFirstPotteriesBus(bus, extra) || isFirstBus(bus, extra))) return "";
  const info = extra.seatsInfo || occupancyFromSources(bus, extra);
  if (!info) return "";
  if (info.remaining != null) {
    if (info.remaining <= 0) return "full · none left";
    return `${info.remaining} seats left`;
  }
  if (info.band === "standing") return "standing room only";
  if (info.band === "few") return "few seats left";
  if (info.band === "seats") return "seats available";
  return "";
}

/** Same early / late wording as the bus card delay line. */
function followDelayChipText(marker) {
  if (!marker?.bus) return "";
  const bus = marker.bus;
  if (isNotInService(bus)) return "";
  const extra = marker.extra || {};
  const [lng, lat] = bus.coordinates || [];
  const delaySec =
    extra.delaySec ?? bus.delay ?? inferDelaySeconds(extra.stops, lat, lng, bus.datetime);
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
  const seats = followSeatsChipText(marker);
  const delay = followDelayChipText(marker);
  const parts = [`Following ${followTarget.label}`];
  if (delay) parts.push(delay);
  if (seats) parts.push(seats);
  if (since) parts.push(`since ${since}`);
  parts.push("Stop");
  followChipEl.textContent = parts.join(" · ");
}

let followSeatsTimer = null;

function stopFollowSeatsPolling() {
  if (followSeatsTimer) {
    clearInterval(followSeatsTimer);
    followSeatsTimer = null;
  }
}

/** Keep First Potteries seat counts fresh on the follow chip (even if the card is closed). */
function ensureFollowSeatsPolling(marker) {
  stopFollowSeatsPolling();
  if (!marker?.bus) return;
  const bus = marker.bus;
  const extra = marker.extra || {};
  if (!(isFirstPotteriesBus(bus, extra) || isFirstBus(bus, extra))) return;

  const refreshSeats = async ({ force = false } = {}) => {
    if (!isFollowingMarker(marker)) {
      stopFollowSeatsPolling();
      return;
    }
    const here = marker.getLatLng?.();
    if (!here) return;
    const next = await firstOccupancyFor(marker.bus || bus, marker.extra || extra, here.lat, here.lng, {
      force,
    });
    if (!isFollowingMarker(marker)) return;
    if (next) {
      const prev = marker.extra?.firstOccupancy;
      marker.extra = marker.extra || {};
      marker.extra.firstOccupancy = next;
      marker.extra.seatsInfo = occupancyFromSources(marker.bus || bus, marker.extra);
      if (
        !prev ||
        prev.remaining !== next.remaining ||
        prev.occupied !== next.occupied ||
        prev.seats !== next.seats
      ) {
        refreshPopup(marker, { force: true });
      }
    }
    updateFollowChip();
  };

  refreshSeats({ force: true });
  followSeatsTimer = setInterval(() => refreshSeats({ force: true }), 10000);
}

function stopFollowBus(message = "") {
  const marker = followedMarker();
  const trailKey = liveTrailKeyForMarker(marker);
  stopFollowSeatsPolling();
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
  // Keep a live tail + arrows growing with the bus (including AT1–AT3).
  const trailKey = liveTrailKeyForMarker(marker);
  if (trailKey) {
    rememberTrailVehicle(trailKey);
    setLiveTrailFocus(trailKey);
  }
  keepFollowedInView(marker, { force: true });
  if (announceOn) followJourney(marker, true);
  updateFollowChip();
  ensureFollowSeatsPolling(marker);
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
      });
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

function openJourneyMarker() {
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
  AT1: "#6b21a8",
  AT2: "#0f766e",
  AT3: "#1f6b2d",
};

const liveryCache = new Map();
const liveryById = new Map();
const btRegCache = new Map();

async function ensureLiveries(ids) {
  const unique = [
    ...new Set(
      ids
        .map((id) => {
          if (id == null || id === "") return "";
          if (typeof id === "object") return String(id.id ?? "");
          return String(id);
        })
        .filter(Boolean),
    ),
  ];
  await Promise.all(
    unique.map(async (id) => {
      if (liveryById.has(id)) return;
      if (!liveryCache.has(id)) {
        liveryCache.set(
          id,
          fetch(`/api/bt-liveries/${encodeURIComponent(id)}/`)
            .then((res) => (res.ok ? res.json() : null))
            .catch(() => null),
        );
      }
      const row = await liveryCache.get(id);
      liveryById.set(id, row);
    }),
  );
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

function getLivery(id) {
  const key = liveryIdOf(id);
  if (!key) return null;
  return liveryById.get(key) || null;
}

const FLIX_GREEN = "#73d700";
const FLIX_LIVERY = {
  left_css: `linear-gradient(${FLIX_GREEN} 0 58%, #ff8500 58% 70%, ${FLIX_GREEN} 70%)`,
  stroke_colour: "#1a1a1a",
};

function isNisDestination(dest) {
  const t = String(dest || "").trim();
  if (!t) return false;
  return /^(not in service|nis|n\/?s|out of service|oos|positioning|dead running|empty to)$/i.test(t)
    || /\b(not in service|out of service|dead running)\b/i.test(t);
}

/** Garage / depot destination text (First Potteries & D&G often keep a line number). */
function isDepotRunDestination(dest) {
  const t = String(dest || "").trim();
  if (!t) return false;
  if (isNisDestination(t)) return true;
  return /^(garage|depot|to\s+(?:the\s+)?(?:garage|depot)|out\s*of\s*service|oos)$/i.test(t)
    || /\b(?:to\s+)?(?:the\s+)?(?:garage|depot)\b|\bout\s*of\s*service\b|\boos\b/i.test(t);
}

function operatorHaystack(bus, extra = {}) {
  return [
    bus?.operator?.noc,
    bus?.operator?.id,
    bus?.operator?.name,
    bus?.operator?.slug,
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
 * First / D&G / Stanton's / Scraggs deadhead to their yard:
 * destination says garage/depot/NIS, or no line while heading into the yard,
 * or pulling into the yard off a passenger destination.
 */
function isStokeDepotBound(bus, extra = {}) {
  if (!bus || !ownStokeDepot(bus, extra)) return false;
  if (isDepotRunDestination(bus.destination)) return true;
  const line = String(bus.service?.line_name || "").trim();
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
  if (/adderley|mossfield|park\s*farm|endon|parkhall|scragg/i.test(dest) && dist <= 2500) return true;
  return false;
}

function isNotInService(bus) {
  if (!bus) return false;
  if (bus.nis || bus.depotOos) return true;
  if (isStokeDepotBound(bus)) return true;
  const line = String(bus.service?.line_name || "").trim();
  if (!line) return true;
  return isNisDestination(bus.destination);
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
  const depotBound = bus.depotOos || isStokeDepotBound(bus);
  if (depotBound || (/garage|depot/i.test(dest) && (isNisDestination(dest) || isDepotRunDestination(dest)))) {
    return moving ? "Out of service — heading to depot" : "Out of service at depot";
  }
  if (/position|dead|empty to|to start/i.test(dest)) {
    return "Heading to start the next trip";
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
  return (
    bus?.vehicle?.livery === 1046 ||
    colour === FLIX_GREEN.toLowerCase() ||
    colour === "#73d700" ||
    /flixbus/i.test(name) ||
    /flixbus/i.test(url) ||
    /^flix$/i.test(op)
  );
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

async function fetchFlixBuses(signal) {
  try {
    const res = await fetch("/api/vehicles?operator=FLIX", { signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data.filter(isFlixBus) : [];
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return [];
  }
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

function formatSpeedLine(speedMph, limitMph) {
  const speed = formatSpeed(speedMph);
  if (!Number.isFinite(limitMph)) return speed;
  return `${speed} · limit ${Math.round(limitMph)}`;
}

function speedBlock(speedMph, limitMph) {
  const over =
    Number.isFinite(speedMph) && Number.isFinite(limitMph) && speedMph > limitMph + 2.5;
  return `<div class="popup-speed${over ? " is-over" : ""}">${esc(formatSpeedLine(speedMph, limitMph))}</div>`;
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
  if (type.name || /single/.test(name)) return 41;
  return null;
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

  // First Potteries without a live reading — don't show a stuck typical "41 seats".
  if (isFirstBus(bus, extra) && remaining == null && !band) return null;

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
  const info = extra.seatsInfo || occupancyFromSources(bus, extra);
  if (!info) return "";
  if (!info?.seats && info?.remaining == null && !info?.band) return "";
  // Lead with seats left when we have a live First / counted reading.
  if (info.remaining != null && info.seats) {
    let cls = "is-ok";
    let leftLabel = `${info.remaining} left`;
    if (info.remaining <= 0) {
      leftLabel = "full · none left";
      cls = "is-full";
    } else if (info.remaining <= 8) {
      cls = "is-low";
    }
    const extras = [];
    if (info.wheelchairLeft != null) {
      extras.push(info.wheelchairLeft > 0 ? "wheelchair space free" : "wheelchair space taken");
    }
    if (info.source === "First Bus") extras.push("First Bus live");
    return `
      <div class="popup-seats ${cls}">
        <div class="popup-seats-main">${esc(`${info.remaining} seats left`)}</div>
        ${extras.length ? `<div class="popup-seats-extra">${esc(extras.join(" · "))}</div>` : ""}
      </div>
    `;
  }
  const seatLabel = info.seats
    ? info.typical
      ? `About ${info.seats} seats`
      : `${info.seats} seats`
    : "Seats";
  let leftLabel = "occupancy unknown";
  let cls = "is-unknown";
  if (info.band === "standing") {
    leftLabel = "standing room only";
    cls = "is-full";
  } else if (info.band === "few" && info.remaining == null) {
    leftLabel = "few seats left";
    cls = "is-low";
  } else if (info.band === "seats" && info.remaining == null) {
    leftLabel = "seats available";
    cls = "is-ok";
  } else if (info.remaining != null) {
    if (info.remaining <= 0) {
      leftLabel = "full · none left";
      cls = "is-full";
    } else {
      leftLabel = `${info.remaining} left`;
      cls = info.remaining <= 8 ? "is-low" : "is-ok";
    }
  }
  const extras = [];
  if (info.wheelchairLeft != null) {
    extras.push(
      info.wheelchairLeft > 0
        ? `wheelchair space free`
        : `wheelchair space taken`,
    );
  } else if (info.wheelchair != null && info.wheelchair > 0) {
    extras.push(`${info.wheelchair} wheelchair`);
  }
  if (info.source === "First Bus") extras.push("First Bus live");
  return `
    <div class="popup-seats ${cls}">
      <div class="popup-seats-main">${esc(`${seatLabel} · ${leftLabel}`)}</div>
      ${extras.length ? `<div class="popup-seats-extra">${esc(extras.join(" · "))}</div>` : ""}
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

const firstVehicleCache = new Map();

async function fetchFirstServiceVehicles(line, operator = "FPOT", { force = false } = {}) {
  const code = String(line || "").trim().toUpperCase();
  const noc = String(operator || "FPOT").trim().toUpperCase() || "FPOT";
  if (!code) return [];
  const cacheKey = `${noc}:${code}`;
  const hit = firstVehicleCache.get(cacheKey);
  if (!force && hit && Date.now() - hit.at < 8000) return hit.vehicles;
  try {
    const res = await fetch(
      `/api/first-vehicles?operator=${encodeURIComponent(noc)}&service=${encodeURIComponent(code)}&_=${Date.now()}`,
    );
    const data = res.ok ? await res.json() : null;
    const vehicles = Array.isArray(data?.vehicles) ? data.vehicles : [];
    firstVehicleCache.set(cacheKey, { at: Date.now(), vehicles });
    if (firstVehicleCache.size > 40) firstVehicleCache.delete(firstVehicleCache.keys().next().value);
    return vehicles;
  } catch {
    return hit?.vehicles || [];
  }
}

function fleetNumberFromBus(bus = {}, extra = {}) {
  const raws = [
    extra.vehicle?.fleet_code,
    extra.vehicle?.fleet_number,
    extra.btVehicle?.fleet_code,
    bus.vehicle?.fleet_code,
    bus.vehicle?.fleet_number,
    bus.vehicle?.name,
    extra.vehicle?.name,
  ];
  for (const raw of raws) {
    const text = String(raw || "").trim();
    if (!text) continue;
    // "63362 - SM65 WMF" / "63362"
    const head = text.match(/^(\d{4,6})\b/);
    if (head) return head[1];
    const only = compactQuery(text);
    if (/^\d{4,6}$/.test(only)) return only;
  }
  return "";
}

function matchFirstLiveVehicle(vehicles, bus, extra, lat, lng) {
  const list = Array.isArray(vehicles) ? vehicles.filter((row) => parseFirstOccupancy(row)) : [];
  if (!list.length) return null;
  const line = String(bus?.service?.line_name || extra?.line || "")
    .trim()
    .toUpperCase();
  const fleet = fleetNumberFromBus(bus, extra);

  // 1) Exact fleet match (same bus as First Bus app) — required for correct seat counts.
  if (fleet) {
    const fleetHits = list.filter((row) => String(row.fleet || "") === fleet);
    if (fleetHits.length === 1) return fleetHits[0];
    if (fleetHits.length > 1 && Number.isFinite(lat) && Number.isFinite(lng)) {
      let best = null;
      for (const row of fleetHits) {
        if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
        const d = haversineMeters(lat, lng, row.lat, row.lng);
        if (!best || d < best.d) best = { row, d };
      }
      if (best) return best.row;
      return fleetHits[0];
    }
    if (fleetHits.length) return fleetHits[0];
    // Fleet known but not in First feed yet — do not invent seats from another bus.
    return null;
  }

  // 2) No fleet on the map bus: only accept a uniquely nearest live First vehicle.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const nearby = [];
  for (const row of list) {
    if (line && row.line && String(row.line).toUpperCase() !== line) continue;
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
    const d = haversineMeters(lat, lng, row.lat, row.lng);
    if (d <= 120) nearby.push({ row, d });
  }
  nearby.sort((a, b) => a.d - b.d);
  if (!nearby.length) return null;
  // Ambiguous if a second First bus is also close.
  if (nearby.length >= 2 && nearby[1].d - nearby[0].d < 60) return null;
  return nearby[0].row;
}

async function fetchFirstStopTimes(atco) {
  if (!atco) return null;
  const hit = firstStopCache.get(atco);
  if (hit && Date.now() - hit.at < 20000) return hit.data;
  try {
    // Prefer TransportAPI-backed endpoint (includes live seat / wheelchair counts).
    let res = await fetch(`/api/first-stop-times?stop=${encodeURIComponent(atco)}`);
    let data = res.ok ? await res.json() : null;
    if (!data?.times?.length) {
      const fallback = await fetch(`/api/first-next-bus?stop=${encodeURIComponent(atco)}`);
      if (fallback.ok) data = await fallback.json();
    }
    firstStopCache.set(atco, { at: Date.now(), data });
    if (firstStopCache.size > 80) firstStopCache.delete(firstStopCache.keys().next().value);
    return data;
  } catch {
    return null;
  }
}

function matchFirstDeparture(data, bus) {
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
  const withOcc = pool.filter((row) => parseFirstOccupancy(row));
  if (dest) {
    const destPool = (withOcc.length ? withOcc : pool).filter((row) =>
      compactQuery(row.Destination || row.direction || "").includes(dest.slice(0, 6)),
    );
    if (destPool.length) return destPool.find((row) => parseFirstOccupancy(row)) || destPool[0];
  }
  return withOcc[0] || pool.find((row) => parseFirstOccupancy(row)) || pool[0];
}

async function firstOccupancyFor(bus, extra, lat, lng, { force = false } = {}) {
  if (!isFirstBus(bus, extra)) return null;
  const line = String(bus?.service?.line_name || extra?.line || "").trim();
  const nocRaw = String(
    bus?.operator?.noc ||
      bus?.operator?.id ||
      extra?.vehicle?.operator?.noc ||
      extra?.operator ||
      "FPOT",
  )
    .trim()
    .toUpperCase();
  // Potteries (and other First Bus) live seats use the First Group FPOT/… NOC on TransportAPI.
  const noc = /FIRST|FPOT|FBRI|FSYO|FSCE|FGHL|FHUD|FWYO|FGLA|FCYM|FESX|FWAR|FMAN/i.test(
    `${nocRaw} ${operatorName(bus, extra)}`,
  )
    ? /FPOT|Potteries/i.test(`${nocRaw} ${operatorName(bus, extra)}`)
      ? "FPOT"
      : nocRaw.startsWith("F") && nocRaw.length <= 4
        ? nocRaw
        : "FPOT"
    : "FPOT";

  // Primary: live buses-on-a-map feed (same as First Bus app seat counts).
  if (line) {
    const vehicles = await fetchFirstServiceVehicles(line, noc, { force });
    const hit = matchFirstLiveVehicle(vehicles, bus, extra, lat, lng);
    const fromLive = parseFirstOccupancy(hit);
    if (fromLive) {
      fromLive.fleet = hit?.fleet || fleetNumberFromBus(bus, extra) || "";
      fromLive.vehicleId = hit?.vehicleId || "";
      return fromLive;
    }
    // Fleet known but First feed has no matching bus — don't steal another bus's seats.
    if (fleetNumberFromBus(bus, extra)) return null;
  }

  // Fallback only when we cannot identify the fleet yet (rare).
  const stops = extra.stops || [];
  const upcoming = upcomingStops(stops, lat, lng);
  const atcos = [...upcoming, ...stops].map((stop) => stop.atco).filter(Boolean);
  for (const atco of atcos.slice(0, 8)) {
    const data = await fetchFirstStopTimes(atco);
    const occ = parseFirstOccupancy(matchFirstDeparture(data, bus));
    if (occ) return occ;
  }
  return null;
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
    const compact = compactQuery(text);
    if (/^\d{4,7}$/.test(compact)) tokens.add(compact);
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

function bodsIdentityTokens(item = {}) {
  return identityTokens(item.vehicleRef);
}

function tokensOverlap(a, b) {
  if (!a?.size || !b?.size) return false;
  for (const token of a) {
    if (token.length >= 4 && b.has(token)) return true;
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
  const opT = compactQuery(
    bt.operator?.noc || bt.operator?.id || bt.service?.operator?.noc || bt.operator,
  );
  const ref = compactQuery(bods._bods?.vehicleRef || bods.vehicle?.name);
  const reg = compactReg(bods._bods?.vehicleRef || bods.vehicle?.name || "");
  const btTokens = busIdentityTokens(bt);
  let score = 0;
  if (ref && (btTokens.has(ref) || compactQuery(bt.vehicle?.name) === ref)) score += 45;
  if (reg && btTokens.has(reg)) score += 45;
  if (
    tokensOverlap(
      identityTokens(bods._bods?.vehicleRef, bods.vehicle?.name, bods.vehicle?.reg),
      btTokens,
    )
  ) {
    score += 40;
  }
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
  const feedSpeed = Number(bods.speedMph ?? bods._bods?.velocityMph);
  return {
    ...bt,
    id: bt.id,
    coordinates: bods.coordinates,
    heading: Number.isFinite(bods.heading) ? bods.heading : bt.heading,
    datetime: bods.datetime || bt.datetime,
    delay: bods.delay ?? bt.delay,
    destination: bt.destination || bods.destination,
    origin: bt.origin || bods.origin,
    speedMph: Number.isFinite(feedSpeed) ? feedSpeed : undefined,
    feedSpeedMph: Number.isFinite(feedSpeed) ? feedSpeed : undefined,
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
    bodsOccupancy: bods.bodsOccupancy || bt.bodsOccupancy,
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
  if (cls === "motorway") return 70;
  if (cls === "trunk") return 60;
  if (cls === "primary") return 40;
  if (cls === "secondary" || cls === "tertiary" || cls === "unclassified") return 30;
  if (cls === "residential" || cls === "busway" || cls === "service" || cls === "minor") return 30;
  if (cls === "living_street") return 20;
  return null;
}

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

async function fetchLimitNear(lat, lng, fallback) {
  const key = limitCacheKey(lat, lng);
  if (speedLimitCache.has(key)) return speedLimitCache.get(key);
  const pending = (async () => {
    const query = `[out:json][timeout:8];way(around:45,${lat.toFixed(5)},${lng.toFixed(5)})["highway"];out tags center;`;
    try {
      const json = await fetchOverpassJson(query, 8000);
      let best = null;
      let bestD = Infinity;
      for (const el of json.elements || []) {
        const elat = Number(el.center?.lat ?? el.lat);
        const elng = Number(el.center?.lon ?? el.lon);
        if (!Number.isFinite(elat) || !Number.isFinite(elng)) continue;
        const limit = parseMaxspeedMph(el.tags) ?? classLimitMph(el.tags?.highway);
        if (limit == null) continue;
        const d = haversineMeters(lat, lng, elat, elng);
        if (d < bestD) {
          bestD = d;
          best = limit;
        }
      }
      if (best != null) return best;
    } catch {
      // Fall back to the snapped road class.
    }
    if (Number.isFinite(fallback)) return fallback;
    return nearestRoadLimit(lat, lng);
  })();
  speedLimitCache.set(key, pending);
  const result = await pending;
  if (!Number.isFinite(result)) speedLimitCache.delete(key);
  if (speedLimitCache.size > 400) speedLimitCache.delete(speedLimitCache.keys().next().value);
  return result;
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
  return vehicleIcon(line, heading, STAFF_COLOURS[line] || "#1f6b2d", livery, speedMph);
}

function busIconKey(bus, heading = null, speedMph = null) {
  const livId = liveryIdOf(bus);
  const liv = getLivery(livId);
  const h = Number.isFinite(heading) ? heading : Number(bus?.heading) || 0;
  const speed = Number.isFinite(speedMph) ? speedMph : Number(bus?.speedMph) || 0;
  const zoomBand = map.getZoom() >= 15 ? "close" : "mid";
  return [
    zoomBand,
    Math.round(h),
    Math.round(speed),
    livId,
    liveryCss(liv) || bus?.vehicle?.colour || "",
    bus?.service?.line_name || "",
  ].join("|");
}

function busIcon(bus, headingOverride = null) {
  const nis = isNotInService(bus);
  const school = !nis && isSchoolBusLive(bus);
  const scfc = !nis && !school && isStokeFcShuttleLive(bus);
  const line = bus.service?.line_name || (nis ? "NIS" : "?");
  const heading = Number.isFinite(headingOverride)
    ? headingOverride
    : Number.isFinite(bus.heading)
      ? bus.heading
      : 0;
  const livId = liveryIdOf(bus);
  if (nis) {
    const livery = getLivery(livId);
    return vehicleIcon(line, heading, "#64748b", livery, bus.speedMph, { nis: true });
  }
  if (isFlixBus(bus)) {
    return vehicleIcon(line, heading, FLIX_GREEN, FLIX_LIVERY, bus.speedMph);
  }
  const colour = scfc ? bus.vehicle?.colour || "#e03c31" : bus.vehicle?.colour || "#2563eb";
  const livery = getLivery(livId);
  return vehicleIcon(line, heading, colour, livery, bus.speedMph, { school, scfc });
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

function liveryFromBtVehicle(vehicle) {
  if (!vehicle) return null;
  const id = vehicle.livery?.id;
  if (id != null) {
    const cached = getLivery(id);
    if (cached) return cached;
  }
  const left = vehicle.livery?.left_css || vehicle.livery?.left;
  if (!left) return null;
  return {
    left_css: left,
    right_css: vehicle.livery?.right_css || vehicle.livery?.right || left,
    white_text: true,
    stroke_colour: vehicle.livery?.stroke_colour || "#111827",
  };
}

async function staffLivery(item) {
  const parsed = parseFleetReg(item.vehicle?.ref);
  const vehicle = await bustimesVehicleByReg(parsed.reg, { fleet: parsed.fleet, operator: "DAGC" });
  const id = vehicle?.livery?.id;
  if (id != null) await ensureLiveries([id]);
  return liveryFromBtVehicle(vehicle);
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

async function tripEnds(tripId) {
  if (!tripId) return null;
  const fresh = tripCache.has(tripId) && Date.now() - (tripCacheAt.get(tripId) || 0) < 25000;
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
          return {
            from,
            to,
            stops,
            operator,
            delaySec: tripDelaySeconds(times),
            path: tripPathFromTimes(times),
            line: trip?.service?.line_name || "",
            headsign: trip?.headsign || to,
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

function popupHtml(bus, extra = {}) {
  const nis = isNotInService(bus);
  const school = !nis && isSchoolBusLive(bus);
  const scfc = !nis && !school && isStokeFcShuttleLive(bus);
  const line =
    extractRouteFromVehicle(bus) ||
    bus.service?.line_name ||
    (nis ? "Not in service" : "Unknown line");
  const from = extra.from || bus.origin || "";
  const to = extra.to || bus.destination || "";
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
  const delaySec =
    extra.delaySec ??
    bus.delay ??
    inferDelaySeconds(extra.stops, lat, lng, bus.datetime);
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
    <div class="popup-card">
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
      ${
        !nis && (isFirstPotteriesBus(bus, extra) || isFirstBus(bus, extra))
          ? seatsBlock(bus, extra)
          : ""
      }
      <div class="popup-actions">
        ${followButtonHtml({ bus })}
        ${playRouteButtonHtml(bus, extra)}
      </div>
      ${photoBlock(extra, { reg: photoReg, fleet, operator })}
      ${nis ? "" : stopsBlock(extra.stops, lat, lng, stickyNext)}
      ${historyBlock(historyExtra)}
      <div class="popup-details">
        <div>${metaBits.join(" · ")}</div>
        <div class="popup-details-live ${Number.isFinite(bus.speedMph) && Number.isFinite(extra.limitMph ?? bus.limitMph) && bus.speedMph > (extra.limitMph ?? bus.limitMph) + 2.5 ? "is-over" : ""}">${esc(formatSpeedLine(bus.speedMph, extra.limitMph ?? bus.limitMph))} · ${esc(timeAgo(bus.datetime))}</div>
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
    .replace(/class="popup-details-live[^"]*"[^<]*<\/div>/g, 'class="popup-details-live"></div>')
    .replace(/class="popup-seats[^"]*"[\s\S]*?<\/div>\s*<\/div>/g, 'class="popup-seats"></div>')
    .replace(/class="follow-bus-btn[^"]*"[^<]*/g, 'class="follow-bus-btn"')
    .replace(/ class="popup-stop[^"]*"/g, ' class="popup-stop"')
    .replace(/<span class="popup-fold-hint">[^<]*<\/span>/g, "")
    .replace(/<p class="popup-photo-note">[^<]*<\/p>/g, "")
    .replace(/\d+s ago|just now|\d+m ago/g, "AGE")
    .replace(/Stopped|\d+ mph/g, "SPEED")
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
  const root = marker.getPopup()?.getElement()?.querySelector(".popup-card");
  if (!root) return false;
  rememberNextStop(marker);

  if (marker.bus) {
    const bus = marker.bus;
    const extra = marker.extra || {};
    const nis = isNotInService(bus);
    const [lng, lat] = bus.coordinates || [];
    const delaySec =
      extra.delaySec ?? bus.delay ?? inferDelaySeconds(extra.stops, lat, lng, bus.datetime);
    const delayEl = root.querySelector(".popup-delay");
    if (delayEl && !nis) {
      delayEl.textContent = formatDelay(delaySec);
      delayEl.className = `popup-delay ${delayClass(delaySec)}`.trim();
    }
    if (isFollowingMarker(marker)) updateFollowChip();
    // Keep First Bus seat counts in sync without rebuilding the whole card.
    if (!nis && (isFirstPotteriesBus(bus, extra) || isFirstBus(bus, extra))) {
      const seatsHtml = seatsBlock(bus, extra).trim();
      let seatsEl = root.querySelector(".popup-seats");
      if (seatsHtml) {
        const wrap = document.createElement("div");
        wrap.innerHTML = seatsHtml;
        const next = wrap.firstElementChild;
        if (seatsEl && next) {
          seatsEl.className = next.className;
          seatsEl.innerHTML = next.innerHTML;
        } else if (next) {
          const actions = root.querySelector(".popup-actions");
          if (actions) actions.insertAdjacentElement("beforebegin", next);
          else root.insertAdjacentElement("afterbegin", next);
        }
      } else if (seatsEl) {
        seatsEl.remove();
      }
      if (isFollowingMarker(marker)) updateFollowChip();
    }
    const liveEl = root.querySelector(".popup-details-live");
    if (liveEl) {
      const limit = extra.limitMph ?? bus.limitMph;
      const over =
        Number.isFinite(bus.speedMph) &&
        Number.isFinite(limit) &&
        bus.speedMph > limit + 2.5;
      liveEl.textContent = `${formatSpeedLine(bus.speedMph, limit)} · ${timeAgo(bus.datetime)}`;
      liveEl.classList.toggle("is-over", over);
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
      liveEl.textContent = `${formatSpeedLine(item.speedMph, extra.limitMph ?? item.limitMph)} · ${recorded}`;
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

/** Rebuild open popup only when HTML structure changed; keep scroll + fold state. */
function refreshPopup(marker, { force = false } = {}) {
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
  const vehicleId = historyVehicleId(marker.bus, marker.extra);
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
  if (!vehicleId && !wantAtTrails) {
    marker.extra.history = [];
    marker.extra.historyStatus = "unavailable";
    refreshPopup(marker);
    return;
  }
  const cacheKey = `${vehicleId || trailKey || "at"}:${atLine || ""}:${days}`;
  if (force) historyCache.delete(cacheKey);
  marker.extra.historyStatus = "loading";
  refreshPopup(marker);
  let rowsRaw = vehicleId ? await fetchVehicleHistory(vehicleId, days) : [];
  if ((Number(marker.extra.historyDays) || historyDays) !== days) return;
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
  if ((Number(marker.extra.historyDays) || historyDays) !== days) return;
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
  const visible = filterHistoryByLine(enriched, marker.extra.historyLineFilter || lineFilter, {
    keepStokeFc,
  });
  marker.extra.historyStatus = enriched.length ? (visible.length ? "ready" : "ready") : "empty";
  refreshPopup(marker);
}

async function enrichBustimes(event) {
  const marker = event.target;
  const bus = marker.bus;
  if (!bus) return;
  const gen = (marker._enrichGen = (marker._enrichGen || 0) + 1);
  marker.extra ||= {};
  marker.extra.historyDays ||= historyDays;
  rememberTrailVehicle(bus.id);
  const ll = marker.getLatLng();
  marker.extra.limitMph = bus.limitMph ?? nearestRoadLimit(ll.lat, ll.lng);
  const [ends, vehicle] = await Promise.all([
    tripEnds(bus.trip_id || bus.journey_id),
    isLikelyBustimesVehicleId(bus, bus.btId || bus.id)
      ? vehicleDetails(bus.btId || bus.id)
      : null,
  ]);
  if (gen !== marker._enrichGen) return;
  if (ends) {
    marker.extra.from = ends.from;
    marker.extra.to = ends.to || bus.destination;
    marker.extra.stops = ends.stops || [];
    marker.extra._nextStopIdx = undefined;
    if (ends.operator) marker.extra.operator = ends.operator;
    marker.extra.delaySec =
      ends.delaySec ?? inferDelaySeconds(ends.stops, ll.lat, ll.lng, bus.datetime);
  }
  if (vehicle) marker.extra.vehicle = vehicle;
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
  loadHistoryIntoMarker(marker);
  const dgVehicle = String(bus.id).startsWith("dg-")
    ? await dgVehicleDetails(bus.vehicle?.name)
    : await dgVehicleFromBt(vehicle);
  if (gen !== marker._enrichGen) return;
  if (dgVehicle) marker.extra.dgVehicle = dgVehicle;
  marker.extra.seatsInfo = occupancyFromSources(bus, marker.extra);
  if (isFirstBus(bus, marker.extra)) {
    if (!marker._firstSeatsCloseBound) {
      marker._firstSeatsCloseBound = true;
      marker.on("popupclose", () => {
        if (marker._firstSeatsTimer) {
          clearInterval(marker._firstSeatsTimer);
          marker._firstSeatsTimer = null;
        }
      });
    }
    const first = await firstOccupancyFor(bus, marker.extra, ll.lat, ll.lng, { force: true });
    if (gen !== marker._enrichGen) return;
    if (first) {
      marker.extra.firstOccupancy = first;
      marker.extra.seatsInfo = occupancyFromSources(bus, marker.extra);
      if (isFollowingMarker(marker)) updateFollowChip();
    }
    // Keep seat counts fresh while the card is open (match First app ~live updates).
    if (marker._firstSeatsTimer) clearInterval(marker._firstSeatsTimer);
    marker._firstSeatsTimer = setInterval(async () => {
      if (!marker.isPopupOpen?.()) {
        clearInterval(marker._firstSeatsTimer);
        marker._firstSeatsTimer = null;
        return;
      }
      const here = marker.getLatLng?.() || ll;
      const next = await firstOccupancyFor(marker.bus || bus, marker.extra, here.lat, here.lng, {
        force: true,
      });
      if (!next) return;
      const prev = marker.extra.firstOccupancy;
      if (
        prev &&
        prev.remaining === next.remaining &&
        prev.occupied === next.occupied &&
        prev.seats === next.seats
      ) {
        return;
      }
      marker.extra.firstOccupancy = next;
      marker.extra.seatsInfo = occupancyFromSources(marker.bus || bus, marker.extra);
      refreshPopup(marker, { force: true });
      if (isFollowingMarker(marker)) updateFollowChip();
    }, 10000);
  }
  const bods = await bodsOccupancyFor(bus, marker.extra, ll.lat, ll.lng);
  if (gen !== marker._enrichGen) return;
  // Never let BODS band data replace a live First seat reading.
  if (bods && !(marker.extra.firstOccupancy?.remaining != null || marker.extra.firstOccupancy?.occupied != null)) {
    marker.extra.bodsOccupancy = bods;
    marker.extra.seatsInfo = occupancyFromSources(bus, marker.extra);
  } else if (bods) {
    marker.extra.bodsOccupancy = bods;
  }
  fetchLimitNear(ll.lat, ll.lng, marker.extra.limitMph).then((limit) => {
    if (gen !== marker._enrichGen) return;
    if (!Number.isFinite(limit)) return;
    marker.extra.limitMph = limit;
    refreshPopup(marker);
  });
  refreshPopup(marker);
  if (isFollowingMarker(marker)) updateFollowChip();
  followJourney(marker, true);
  loadPhotoIntoMarker(marker);
}

function staffPopup(item, extra = {}) {
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

  return `
    <div class="popup-card">
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
      ${historyBlock(popupExtra)}
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
        <div class="popup-details-live">${esc(formatSpeedLine(item.speedMph, extra.limitMph ?? item.limitMph))} · ${esc(recorded)}</div>
      </div>
    </div>
  `;
}

async function enrichStaff(event) {
  const marker = event.target;
  const item = marker.staff;
  if (!item) return;
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
  marker.extra.seatsInfo = occupancyFromSources({ vehicle }, marker.extra);
  refreshPopup(marker);
  const parsed = parseFleetReg(item.vehicle?.ref);
  const bods = await bodsOccupancyFor(
    { vehicle, service: { line_name: line } },
    marker.extra,
    ll.lat,
    ll.lng,
  );
  if (gen !== marker._enrichGen) return;
  if (bods) {
    marker.extra.bodsOccupancy = bods;
    marker.extra.seatsInfo = occupancyFromSources({ vehicle }, marker.extra);
  }
  let btVehicle = await bustimesVehicleByReg(parsed.reg, { fleet: parsed.fleet, operator: "DAGC" });
  if (!btVehicle && (parsed.reg || parsed.fleet)) {
    btVehicle = await bustimesVehicleByReg(parsed.reg, { fleet: parsed.fleet });
  }
  if (gen !== marker._enrichGen) return;
  if (btVehicle) marker.extra.btVehicle = btVehicle;
  marker.extra.liveryName = btVehicle?.livery?.name || marker.extra.liveryName || "";
  loadHistoryIntoMarker(marker);
  fetchLimitNear(ll.lat, ll.lng, marker.extra.limitMph).then((limit) => {
    if (gen !== marker._enrichGen) return;
    if (!Number.isFinite(limit)) return;
    marker.extra.limitMph = limit;
    refreshPopup(marker);
  });
  refreshPopup(marker);
  followJourney(marker, true);
  loadPhotoIntoMarker(marker);
}

async function loadAltonTowers() {
  try {
    const response = await fetch(
      "/api/dg-vehicles?regionId=526&showBusesNotInService=true",
    );
    if (!response.ok) throw new Error(`Alton Towers feed ${response.status}`);
    const data = await response.json();
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
      seen.add(id);
      const line = staffLineName(item);
      const heading = Number(item.positioning?.bearing);
      item.speedMph = updateMotion(`staff-${id}`, lat, lng, item.recordedAtTime);
      const snapped = staffWhere(item);
      item.limitMph = snapped.limitMph ?? nearestRoadLimit(snapped.lat, snapped.lng);
      const existing = staffMarkers.get(id);
      recordStaffTrail(existing || { staff: item, extra: {} }, snapped.lat, snapped.lng, snapped.heading, {
        t: item.recordedAtTime ? new Date(item.recordedAtTime).getTime() || Date.now() : Date.now(),
      });
      const livery = existing?.staffLivery || null;
      if (existing) {
        existing.staff = item;
        existing.line = line;
        moveMarkerTo(existing, snapped.lat, snapped.lng);
        const iconKey = `${line}|${Math.round(snapped.heading || 0)}|${Math.round(item.speedMph || 0)}|${liveryCss(livery) || ""}`;
        if (existing._iconKey !== iconKey) {
          existing._iconKey = iconKey;
          existing.setIcon(staffIcon(line, snapped.heading, livery, item.speedMph));
        }
        refreshPopup(existing);
        if (existing === announceFollow) announceJourney(existing);
        keepFollowedInView(existing);
      } else {
        const marker = L.marker([snapped.lat, snapped.lng], {
          icon: staffIcon(line, snapped.heading, livery, item.speedMph),
          zIndexOffset: 1500,
        });
        marker.staff = item;
        marker.line = line;
        marker.extra = { trailKey: staffTrailKey(item), historyDays };
        marker.bindPopup(() => staffPopup(marker.staff, marker.extra), POPUP_OPTS);
        marker.on("popupopen", enrichStaff);
        staffLayer.addLayer(marker);
        staffMarkers.set(id, marker);
      }
      staffLivery(item).then((next) => {
        const marker = staffMarkers.get(id);
        if (!marker) return;
        marker.staffLivery = next;
        const snap = staffWhere(marker.staff);
        marker.setIcon(staffIcon(marker.line, snap.heading, next, marker.staff?.speedMph));
      });
    }

    for (const [id, marker] of staffMarkers) {
      if (!seen.has(id)) {
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
  }
}

function dropServiceBus(id) {
  const marker = markers.get(id);
  if (!marker) return;
  if (announceFollow === marker) announceFollow = null;
  if (isFollowingMarker(marker)) stopFollowBus("Lost live position for that bus");
  cluster.removeLayer(marker);
  markers.delete(id);
}

function upsertLiveBus(bus, snapped) {
  const existing = markers.get(bus.id);
  const reg =
    busRegistration(bus, existing?.extra || {}) ||
    existing?.extra?.vehicle?.reg ||
    bus.vehicle?.reg ||
    "";
  recordVehicleTrail(bus.id, snapped.lat, snapped.lng, snapped.heading, {
    journeyId: bus.journey_id,
    tripId: bus.trip_id,
    line: bus.service?.line_name || "",
    operator: trailOperatorForBus(bus),
    t: bus.datetime ? new Date(bus.datetime).getTime() || Date.now() : Date.now(),
    reg,
  });
  if (existing) {
    existing.bus = bus;
    if (bus.bodsOccupancy) {
      existing.extra ||= {};
      existing.extra.bodsOccupancy = bus.bodsOccupancy;
    }
    moveMarkerTo(existing, snapped.lat, snapped.lng);
    const iconKey = busIconKey(bus, snapped.heading, bus.speedMph);
    if (existing._iconKey !== iconKey) {
      existing._iconKey = iconKey;
      existing.setIcon(busIcon(bus, snapped.heading));
    }
    refreshPopup(existing);
    if (existing === announceFollow) announceJourney(existing);
    keepFollowedInView(existing);
    return existing;
  }
  const marker = L.marker([snapped.lat, snapped.lng], { icon: busIcon(bus, snapped.heading) });
  marker.bus = bus;
  marker.extra = bus.bodsOccupancy ? { bodsOccupancy: bus.bodsOccupancy } : {};
  marker.bindPopup(() => popupHtml(marker.bus, marker.extra), POPUP_OPTS);
  marker.on("popupopen", enrichBustimes);
  cluster.addLayer(marker);
  markers.set(bus.id, marker);
  return marker;
}

async function loadBuses({ replace = false } = {}) {
  const zoom = map.getZoom();
  const showLocal = zoom >= MIN_ZOOM;
  const showCoach = zoom >= FLIX_MIN_ZOOM;

  if (!showLocal && !showCoach) {
    cluster.clearLayers();
    markers.clear();
    if (followTarget) stopFollowBus();
    hint.hidden = false;
    hint.textContent = "Search a place or zoom in to a town to see live buses";
    return;
  }

  if (!showLocal && showCoach) {
    hint.hidden = false;
    hint.textContent = "FlixBus & National Express nationwide · zoom in further for local buses";
  } else {
    hint.hidden = true;
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

  try {
    showMessage("");
    const [localRes, flixBuses, natxBuses, bodsLive] = await Promise.all([
      showLocal ? fetch(`/api/vehicles?${params}`, { signal }) : Promise.resolve(null),
      showCoach ? fetchFlixBuses(signal) : Promise.resolve([]),
      showCoach ? fetchNatxBuses(signal) : Promise.resolve([]),
      showLocal ? fetchBodsVehicles(params, signal) : Promise.resolve({ vehicles: [], ok: false }),
    ]);
    let localBuses = [];
    if (localRes) {
      if (!localRes.ok) throw new Error(`Could not load vehicles (${localRes.status})`);
      const data = await localRes.json();
      localBuses = Array.isArray(data) ? data : [];
    }
    if (bodsLive?.ok) attachFeedSpeedFromBods(localBuses, bodsLive.vehicles);

    const byId = new Map();
    for (const bus of localBuses) {
      if (!showLocal && !isFlixBus(bus) && !isNationalExpress(bus)) continue;
      byId.set(bus.id, bus);
    }
    for (const bus of flixBuses) {
      byId.set(bus.id, bus);
    }
    for (const bus of natxBuses) {
      byId.set(bus.id, bus);
    }

    const live = [];
    const seenService = new Set();

    for (const bus of byId.values()) {
      const [lng, lat] = bus.coordinates || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (isStalePing(bus.datetime)) continue;
      const coach = isFlixBus(bus) || isNationalExpress(bus);
      if (!showLocal && !coach) continue;
      if (!showCoach && coach) continue;
      if (isNotInService(bus)) {
        dropServiceBus(bus.id);
        continue;
      }
      live.push(bus);
      bus.speedMph = resolveBusSpeedMph(`bus-${bus.id}`, bus, lat, lng, bus.datetime);
      const snapped = liveWhere(bus);
      bus.limitMph = snapped.limitMph ?? nearestRoadLimit(snapped.lat, snapped.lng);
      seenService.add(bus.id);
      upsertLiveBus(bus, snapped);
    }

    for (const [id, marker] of markers) {
      const coach = isFlixBus(marker.bus) || isNationalExpress(marker.bus);
      const keep = seenService.has(id) && !isStalePing(marker.bus?.datetime);
      const allowed = (showLocal || coach) && (showCoach || !coach);
      if (!keep || !allowed) {
        dropServiceBus(id);
        motion.delete(`bus-${id}`);
      }
    }
    revealPendingFocus();

    ensureLiveries(live.map((bus) => liveryIdOf(bus)))
      .then(() => {
        for (const bus of live) {
          const marker = markers.get(bus.id);
          if (!marker) continue;
          const heading = Number(marker.bus?.heading);
          const iconKey = busIconKey(marker.bus, heading, marker.bus?.speedMph);
          marker._iconKey = iconKey;
          marker.setIcon(busIcon(marker.bus, heading));
        }
      })
      .catch(() => {});

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
          moveMarkerTo(marker, snapped.lat, snapped.lng);
          const iconKey = busIconKey(bus, snapped.heading, bus.speedMph);
          if (marker._iconKey !== iconKey) {
            marker._iconKey = iconKey;
            marker.setIcon(busIcon(bus, snapped.heading));
          }
          keepFollowedInView(marker);
        }
        for (const marker of staffMarkers.values()) {
          const item = marker.staff;
          if (!item?.positioning) continue;
          const snapped = staffWhere(item);
          moveMarkerTo(marker, snapped.lat, snapped.lng);
          const iconKey = `${marker.line}|${Math.round(snapped.heading || 0)}|${Math.round(item.speedMph || 0)}|${liveryCss(marker.staffLivery) || ""}`;
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
    showMessage(error.message);
  } finally {
    if (gen === busesGen) busesBusy = false;
  }
}

function schedule() {
  clearInterval(timer);
  clearInterval(coastTimer);
  loadBuses({ replace: true });
  loadAltonTowers();
  timer = setInterval(() => {
    pruneStaleMarkers();
    loadBuses();
    loadAltonTowers();
  }, BUS_POLL_MS);
  coastTimer = setInterval(advanceLiveMarkers, 1000);
}

map.on("moveend", () => {
  // Follow pans must not thrash vehicle reloads — that rebuilds the open bus card.
  if (followPanning || followTarget) {
    return;
  }
  clearTimeout(map._loadTimer);
  map._loadTimer = setTimeout(() => {
    loadBuses({ replace: true });
  }, 120);
  scheduleMapStops();
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
    const busReg = extractRegFromText(marker.bus?.vehicle?.name);
    const detailReg = compactQuery(marker.extra?.vehicle?.reg || marker.extra?.btVehicle?.reg);
    if (wantReg) {
      if (busReg === wantReg || detailReg === wantReg || (name && name.includes(wantReg))) {
        identity.push(marker);
      }
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
const motion = new Map();

function roadsForSnap() {
  if (!decodedTileCache.size) return snapRoads;
  const roads = [];
  for (const tile of decodedTileCache.values()) roads.push(...tile);
  return roads.length ? roads : snapRoads;
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

/** Prefer GPS velocity from BODS SIRI-VM when the operator sends it; else estimate from pings. */
function feedSpeedMph(bus) {
  const v = Number(bus?.feedSpeedMph ?? bus?._bods?.velocityMph);
  if (!Number.isFinite(v) || v < 0 || v > 90) return null;
  return v;
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
    for (const bods of bodsList) {
      const feed = Number(bods.speedMph ?? bods._bods?.velocityMph);
      if (!Number.isFinite(feed)) continue;
      const score = liveBusMatchScore(bods, bt);
      if (score > bestScore) {
        best = bods;
        bestScore = score;
      }
    }
    if (!best || bestScore < 18) continue;
    const feed = Number(best.speedMph ?? best._bods?.velocityMph);
    if (!Number.isFinite(feed) || feed < 0 || feed > 90) continue;
    bt.feedSpeedMph = feed;
    bt._bods = { ...(bt._bods || {}), ...(best._bods || {}), velocityMph: feed };
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
    recordStaffTrail(marker, snapped.lat, snapped.lng, snapped.heading);
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
  if (marker.bus && !snapped.stalled) {
    recordVehicleTrail(marker.bus.id, snapped.lat, snapped.lng, snapped.heading, {
      journeyId: marker.bus.journey_id,
      tripId: marker.bus.trip_id,
      line: marker.bus.service?.line_name || marker.extra?.line || "",
      operator: trailOperatorForBus(marker.bus),
      reg: busRegistration(marker.bus, marker.extra || {}),
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
  const a = flat[0];
  const b = flat[flat.length - 1];
  return `${flat.length}:${Number(a[0]).toFixed(5)},${Number(a[1]).toFixed(5)}:${Number(b[0]).toFixed(5)},${Number(b[1]).toFixed(5)}`;
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
      const hit = snapHit(cur[0], cur[1], heading, 280) || snapHit(cur[0], cur[1], heading, 420);
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
        for (const p of along.slice(1)) {
          if (haversineMeters(out[out.length - 1][0], out[out.length - 1][1], p[0], p[1]) >= 2) out.push(p);
        }
      } else {
        const bridge = bridgeTrailRoads(prevHit, hit);
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

async function osrmRoadBridge(a, b, signal) {
  if (!a || !b) return null;
  const coords = `${Number(a[1]).toFixed(5)},${Number(a[0]).toFixed(5)};${Number(b[1]).toFixed(5)},${Number(b[0]).toFixed(5)}`;
  try {
    const routeRes = await fetch(
      `/api/osrm-route/${coords}?overview=full&geometries=geojson`,
      { signal },
    );
    if (routeRes.ok) {
      const data = await routeRes.json();
      const part = osrmCoordsFromLngLat(data?.routes?.[0]?.geometry?.coordinates);
      if (part) return part;
    }
  } catch {
    /* try match fallback */
  }
  // Public OSRM rejects large radiuses (TooBig) — keep match snap tight.
  for (const radius of [35, 25]) {
    try {
      const res = await fetch(
        `/api/osrm-match/${coords}?overview=full&geometries=geojson&gaps=ignore&radiuses=${radius};${radius}`,
        { signal },
      );
      if (!res.ok) continue;
      const data = await res.json();
      const part = osrmCoordsFromLngLat(data?.matchings?.[0]?.geometry?.coordinates);
      if (part) return part;
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
  const inputSegs = splitLatLngsByGaps(latlngs, limits.gapM, breakOpts);
  const sourceSegs = inputSegs.length ? inputSegs : [latlngs];
  const alignedSegs = [];
  // Coaches: wider sample spacing so long motorway legs stay fast + on-road.
  const thinGap = coach ? 180 : 28;
  const bridgeBatch = coach ? 8 : 4;
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
          osrmRoadBridge(a, b, signal).then((part) => {
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
  const res = await fetch(
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
        const bridge = await osrmRoadBridge(prev, next, signal);
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
  const key = `${trailPathHash(latlngs)}|${coach ? "coach" : "bus"}|v5`;
  if (trailAlignCache.has(key)) return trailAlignCache.get(key);
  if (trailAlignPending.has(key)) return trailAlignPending.get(key);
  const pending = (async () => {
    try {
      await ensureSnapRoadsForPath(latlngs, signal);
      const flat = Array.isArray(latlngs?.[0]?.[0]) ? latlngs.flat() : latlngs;
      let aligned = null;
      let segs = [];
      try {
        if (coach) {
          // Flix / NATX: route-stitch first so sparse motorway AVL stays on roads.
          const thinned = thinTrailPoints(flat, 160);
          aligned = await stitchTrailViaOsrmRoutes(
            thinned.length >= 2 ? thinned : flat,
            signal,
            { ...breakOpts, coach: true },
          );
          segs = trailSegmentsOf(aligned, breakOpts);
          if (!segs.length) {
            aligned = await matchTrailViaOsrm(thinned.length >= 2 ? thinned : flat, signal, {
              ...breakOpts,
              coach: true,
            });
            segs = trailSegmentsOf(aligned, breakOpts);
          }
        } else {
          aligned = await matchTrailViaOsrm(latlngs, signal, breakOpts);
          segs = trailSegmentsOf(aligned, breakOpts);
          if (!segs.length) {
            aligned = await stitchTrailViaOsrmRoutes(latlngs, signal, breakOpts);
            segs = trailSegmentsOf(aligned, breakOpts);
          }
        }
      } catch {
        segs = [];
      }
      if (!segs.length) {
        // Local OFM snap — still roads, never raw GPS chords.
        segs = trailSegmentsOf(alignTrailToRoadsLocal(latlngs, breakOpts), breakOpts);
      } else {
        segs = segs.map((seg) => dedupeNearTrailPoints(seg, 2)).filter((seg) => seg.length >= 2);
      }
      // Coaches: never paint raw GPS (cuts across fields/buildings). Prefer empty over off-road.
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
    return;
  }
  const template = await getOfmTemplate();
  const bounds = map.getBounds().pad(0.06);
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
}

function minDistToRoad(p, latlngs) {
  let best = Infinity;
  for (let i = 0; i < latlngs.length - 1; i += 1) {
    const d = distPointToSegmentMeters(p, latlngs[i], latlngs[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

function combinedSignal(parent, ms) {
  if (typeof AbortSignal.timeout === "function" && typeof AbortSignal.any === "function") {
    return AbortSignal.any([parent, AbortSignal.timeout(ms)]);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const abort = () => {
    clearTimeout(timer);
    ctrl.abort();
  };
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return ctrl.signal;
}

async function fetchOverpassJson(query, ms = 8000) {
  const ctrl = new AbortController();
  const endpoints = [
    "/api/overpass",
    "/api/overpass-alt",
    `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
    `https://overpass.osm.ch/api/interpreter?data=${encodeURIComponent(query)}`,
  ];
  const attempts = endpoints.map(async (url) => {
    const res = await fetch(
      url.startsWith("/") ? `${url}?data=${encodeURIComponent(query)}` : url,
      { signal: combinedSignal(ctrl.signal, ms) },
    );
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    return res.json();
  });
  return new Promise((resolve, reject) => {
    let pending = attempts.length;
    for (const attempt of attempts) {
      attempt.then(
        (json) => {
          if (!pending) return;
          pending = 0;
          ctrl.abort();
          resolve(json);
        },
        () => {
          pending -= 1;
          if (!pending) reject(new Error("Overpass failed"));
        },
      );
    }
  });
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

function setAppTab(tab) {
  const next = tab === "fleet" ? "fleet" : "map";
  document.querySelectorAll(".app-tab").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.tab === next);
  });
  if (mapWrapEl) mapWrapEl.dataset.view = next;
  if (fleetPanelEl) fleetPanelEl.hidden = next !== "fleet";
  if (searchFormEl) searchFormEl.hidden = next === "fleet";
  if (next === "fleet") closeStopBoard();
  if (next === "map") {
    requestAnimationFrame(() => map.invalidateSize());
  }
}

document.querySelectorAll(".app-tab").forEach((btn) => {
  btn.addEventListener("click", () => setAppTab(btn.dataset.tab));
});

const fleetBrowser = fleetContentEl
  ? createFleetBrowser({
      root: fleetContentEl,
      onTrackVehicle: async ({ reg, fleet }) => {
        setAppTab("map");
        const query = reg || fleet;
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
        startRoutePlayback({ ...opts, showTail: true });
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
refreshUkLiveBusCount({ force: true }).then(() => updateLiveBusCount());
setInterval(() => {
  refreshUkLiveBusCount().then(() => updateLiveBusCount());
}, 30_000);
refreshUkLiveBusCount({ force: true }).then(() => updateLiveBusCount());
setInterval(() => {
  refreshUkLiveBusCount().then(() => updateLiveBusCount());
}, 30_000);

map.whenReady(() => {
  map.invalidateSize();
  schedule();
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
