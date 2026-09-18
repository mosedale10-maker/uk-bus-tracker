import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { createFleetBrowser } from "./fleet.js";
import "./style.css";

window.L = L;
await import("leaflet.markercluster");

const MIN_ZOOM = 10;
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

const cluster = L.markerClusterGroup({
  showCoverageOnHover: false,
  maxClusterRadius: 48,
  disableClusteringAtZoom: 13,
});
map.addLayer(cluster);
const staffLayer = L.layerGroup().addTo(map);
const stopsLayer = L.layerGroup();

const STOPS_KEY = "uk-bus-stops-on";
const STOPS_MIN_ZOOM = 14;
const STOPS_MAX = 700;
let stopsOn = localStorage.getItem(STOPS_KEY) === "1";
let stopsAbort = null;
let stopsLoadTimer = null;

const markers = new Map();
const staffMarkers = new Map();
const ALTON_LINES = new Set(["AT1", "AT2", "AT3"]);
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
const hint = document.createElement("div");
hint.className = "zoom-hint";
hint.hidden = true;
document.querySelector(".map-wrap").append(hint);

let inflight = null;
let timer = null;
let coastTimer = null;
let busesBusy = false;
let busesGen = 0;
const BUS_POLL_MS = 3500;
const STALE_PING_MS = 5 * 60 * 1000;

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
      done: Boolean(row.actual_departure_time || row.actual_arrival_time),
    };
  });
}

function cardStops(stops, lat, lng) {
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
    if (bestD < 2500) next = best;
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

function stopsBlock(stops, lat, lng) {
  const rows = cardStops(stops, lat, lng);
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
let historyDays = (() => {
  const n = Number(localStorage.getItem(HISTORY_DAYS_KEY));
  return HISTORY_DAY_OPTIONS.includes(n) ? n : 7;
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
    if (s.startsWith("dg-") || s.startsWith("staff-")) continue;
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
  if (key) recordVehicleTrail(key, lat, lng, heading, { ...meta, reg });
  const btId = marker?.extra?.btVehicle?.id;
  if (btId != null) recordVehicleTrail(String(btId), lat, lng, heading, { ...meta, reg });
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

function historyBlock(extra = {}) {
  const days = Number(extra.historyDays) || historyDays;
  const status = extra.historyStatus || "";
  const journeys = Array.isArray(extra.history) ? extra.history : [];
  const chips = HISTORY_DAY_OPTIONS.map(
    (n) =>
      `<button type="button" class="history-days-btn${n === days ? " is-on" : ""}" data-days="${n}">${n}d</button>`,
  ).join("");
  let body = "";
  if (status === "loading") body = `<div class="popup-meta">Loading history…</div>`;
  else if (status === "empty") body = `<div class="popup-meta">No tracked journeys in the last ${days} day${days === 1 ? "" : "s"}</div>`;
  else if (status === "unavailable") body = `<div class="popup-meta">History unavailable for this vehicle</div>`;
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
            const line = row.route_name || "?";
            const dest = row.destination || "Unknown";
            return `<div class="popup-history-row"><span class="history-time">${esc(formatHistoryTime(row.datetime))}</span><span class="history-line">${esc(line)}</span><span class="history-dest">${esc(dest)}</span>${
              row.trip_id || row.vehicle?.id || extra.trailKey
                ? `<button type="button" class="history-play-btn" data-trip-id="${esc(row.trip_id || "")}" data-journey-id="${esc(row.id || "")}" data-vehicle-id="${esc(row.vehicle?.id || extra.btVehicle?.id || "")}" data-trail-key="${esc(extra.trailKey || "")}" data-reg="${esc(extra.vehicle?.reg || extra.btVehicle?.reg || "")}" data-line="${esc(line)}" data-dest="${esc(dest)}" data-datetime="${esc(row.datetime || "")}" title="Show this route on the map">Map</button>`
                : `<span></span>`
            }</div>`;
          })
          .join("");
        return `<div class="popup-history-day"><div class="popup-history-day-label">${esc(formatHistoryDay(date))} · ${list.length}</div>${items}</div>`;
      })
      .join("");
  }
  return `
    <details class="popup-fold popup-history">
      <summary class="popup-fold-summary">
        <span>History · ${days}d</span>
        <span class="history-days">${chips}</span>
      </summary>
      <div class="popup-history-list">${body || `<div class="popup-meta">Open to load</div>`}</div>
    </details>
  `;
}

let announceOn = localStorage.getItem("uk-bus-announce") === "1";
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
  return String(name || "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function delaySpeech(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "";
  const mins = Math.round(Number(seconds) / 60);
  if (mins === 0) return "This bus is on time.";
  if (mins > 0) return `This bus is ${mins} minute${mins === 1 ? "" : "s"} late.`;
  const early = Math.abs(mins);
  return `This bus is ${early} minute${early === 1 ? "" : "s"} early.`;
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

function speak(text, { force = false } = {}) {
  if (!announceOn || !text || !window.speechSynthesis) return;
  if (!force && text === lastSpokenText) return;
  if (!force && Date.now() - lastSpokenAt < 8000) return;
  clearSpeech();
  speakQueue = [text];
  pumpSpeech();
}

function nextStopState(marker) {
  const stops = marker.extra?.stops || [];
  if (!stops.length) return { stop: null, index: -1, dist: Infinity };
  const ll = marker.getLatLng();
  let idx = stops.findIndex((row) => !row.done);
  if (idx < 0) idx = Math.max(0, stops.length - 1);
  const from = lastStopIndex >= 0 ? lastStopIndex : Math.max(0, idx);
  if (Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) {
    let best = from;
    let bestD = Infinity;
    for (let i = from; i < stops.length; i += 1) {
      if (!Number.isFinite(stops[i].lat) || !Number.isFinite(stops[i].lng)) continue;
      const d = haversineMeters(ll.lat, ll.lng, stops[i].lat, stops[i].lng);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    idx = best;
  }
  const stop = stops[idx] || null;
  let dist = Infinity;
  if (stop && Number.isFinite(stop.lat) && Number.isFinite(stop.lng)) {
    dist = haversineMeters(ll.lat, ll.lng, stop.lat, stop.lng);
  }
  return { stop, index: idx, dist };
}

function journeyId(marker) {
  return marker.bus?.id || marker.staff?.vehicle?.ref || marker.staff?.vehicle?.vehicleUniqueId || "";
}

function announceJourney(marker, { intro = false } = {}) {
  if (!announceOn || !marker || marker !== announceFollow) return;
  if (marker.bus && isNotInService(marker.bus)) {
    if (intro && announceIntroId !== String(journeyId(marker))) {
      announceIntroId = String(journeyId(marker));
      speak("This bus is not in service.", { force: true });
    }
    return;
  }
  const { stop: next, index, dist } = nextStopState(marker);
  const stop = speakStopName(next?.name);
  const dest = speakStopName(marker.extra?.to || marker.bus?.destination || "");
  const line = marker.bus?.service?.line_name || marker.line || staffLineName(marker.staff);
  const delaySec = marker.extra?.delaySec ?? marker.bus?.delay;
  const id = String(journeyId(marker));
  if (intro && announceIntroId !== id) {
    announceIntroId = id;
    lastStopKey = stop;
    lastStopIndex = index;
    lastNextStopKey = "";
    const bits = [];
    if (line && dest) bits.push(`Route ${line} to ${dest}.`);
    else if (line) bits.push(`Route ${line}.`);
    const delay = delaySpeech(delaySec);
    if (delay) bits.push(delay);
    if (bits.length) speak(bits.join(" "), { force: true });
    return;
  }
  if (intro) return;
  if (index < lastStopIndex) return;
  if (index > lastStopIndex) {
    lastStopIndex = index;
    lastStopKey = stop;
    lastNextStopKey = "";
  } else {
    lastStopIndex = Math.max(lastStopIndex, index);
  }
  if (!stop || !Number.isFinite(dist)) return;
  if (dist <= 220 && lastNextStopKey !== stop) {
    lastNextStopKey = stop;
    speak(`The next stop is ${stop}.`, { force: true });
  }
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
const trailMem = new Map();
const trailPersistIds = new Set();
let trailPersistTimer = null;
let liveTrailLine = null;
let liveTrailKey = "";
/** Trails kept on the map after a route finishes (keyed by trail id / reg:…). */
const pinnedTrailKeys = new Set();
const pinnedTrailLines = new Map();

function regTrailKey(reg) {
  const plate = compactReg(reg);
  return plate ? `reg:${plate}` : "";
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

function pruneTrailPoints(points, days = historyDays) {
  if (!points?.length) return [];
  const cutoff = Date.now() - Math.max(1, days) * 86400000;
  let start = 0;
  while (start < points.length && points[start].t < cutoff) start += 1;
  const kept = start ? points.slice(start) : points;
  if (kept.length > TRAIL_MAX_POINTS) return kept.slice(kept.length - TRAIL_MAX_POINTS);
  return kept;
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

function trailKeysForVehicle({ vehicleId = "", trailKey = "", reg = "" } = {}) {
  const keys = [];
  const seen = new Set();
  for (const key of [trailKey, vehicleId, regTrailKey(reg)]) {
    if (!key) continue;
    const id = String(key);
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push(id);
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
  points.push({
    t: now,
    lat,
    lng,
    heading: Number.isFinite(heading) ? heading : null,
    journeyId: meta.journeyId != null ? String(meta.journeyId) : "",
    tripId: meta.tripId != null ? String(meta.tripId) : "",
  });
  if (points.length > TRAIL_MAX_POINTS + 200) {
    trailMem.set(id, points.slice(points.length - TRAIL_MAX_POINTS));
  }
  if (trailPersistIds.has(id)) scheduleTrailPersist();
  if (liveTrailKey === id || pinnedTrailKeys.has(id)) refreshPinnedTrailLine(id);
  // Also store under registration so the tail survives after the vehicle id drops.
  const plateKey = regTrailKey(meta.reg);
  if (plateKey && plateKey !== id) {
    recordVehicleTrail(plateKey, lat, lng, heading, { ...meta, reg: "" });
  }
}

function trackedPointsFor(key, { journeyId = "", tripId = "", fromMs = 0, toMs = 0 } = {}) {
  const points = trailMem.get(String(key)) || [];
  if (!points.length) return [];
  const jid = journeyId ? String(journeyId) : "";
  const tid = tripId ? String(tripId) : "";
  return points.filter((p) => {
    if (fromMs && p.t < fromMs) return false;
    if (toMs && p.t > toMs) return false;
    if (jid && p.journeyId && p.journeyId !== jid) return false;
    if (tid && p.tripId && p.tripId !== tid) return false;
    if (jid && !p.journeyId && tid && p.tripId && p.tripId !== tid) return false;
    return true;
  });
}

function trackedPathLatLngs(key, opts = {}) {
  return trackedPointsFor(key, opts).map((p) => [p.lat, p.lng]);
}

const TRAIL_CASING = {
  color: "#ffffff",
  weight: 10,
  opacity: 0.95,
  lineJoin: "round",
  lineCap: "round",
  interactive: false,
};
const TRAIL_STROKE = {
  color: "#000000",
  weight: 5,
  opacity: 1,
  lineJoin: "round",
  lineCap: "round",
  interactive: false,
};

function makeTrailPair(path, layer) {
  const casing = L.polyline(path, { ...TRAIL_CASING }).addTo(layer);
  const line = L.polyline(path, { ...TRAIL_STROKE }).addTo(layer);
  return { casing, line };
}

function setTrailPairPath(pair, path) {
  if (!pair) return;
  pair.casing.setLatLngs(path);
  pair.line.setLatLngs(path);
}

function removeTrailPair(pair, layer) {
  if (!pair) return;
  layer.removeLayer(pair.casing);
  layer.removeLayer(pair.line);
}

function bestTrackedPath(keys, opts = {}) {
  let best = [];
  for (const key of keys) {
    if (!key) continue;
    let path = trackedPathLatLngs(key, opts);
    if (path.length < 3 && (opts.fromMs || opts.toMs || opts.journeyId || opts.tripId)) {
      path = trackedPathLatLngs(key, opts.fromMs || opts.toMs ? { fromMs: opts.fromMs, toMs: opts.toMs } : {});
    }
    if (path.length > best.length) best = path;
  }
  return best;
}

function refreshPinnedTrailLine(key) {
  const id = String(key || "");
  if (!id) return;
  const path = trackedPathLatLngs(id);
  const existing = pinnedTrailLines.get(id);
  if (path.length < 2) {
    if (existing) {
      removeTrailPair(existing, liveTrailLayer);
      pinnedTrailLines.delete(id);
    }
    return;
  }
  if (!existing) {
    pinnedTrailLines.set(id, makeTrailPair(path, liveTrailLayer));
  } else {
    setTrailPairPath(existing, path);
  }
}

function refreshLiveTrailLine(key) {
  const path = trackedPathLatLngs(key);
  if (path.length < 2) {
    if (liveTrailLine) {
      removeTrailPair(liveTrailLine, liveTrailLayer);
      liveTrailLine = null;
    }
    return;
  }
  if (!liveTrailLine) {
    liveTrailLine = makeTrailPair(path, liveTrailLayer);
  } else {
    setTrailPairPath(liveTrailLine, path);
  }
}

function refreshAllPinnedTrails() {
  for (const key of pinnedTrailKeys) refreshPinnedTrailLine(key);
}

function pinVehicleTrail({ vehicleId = "", trailKey = "", reg = "" } = {}) {
  const keys = trailKeysForVehicle({ vehicleId, trailKey, reg });
  if (!keys.length) return;
  for (const key of keys) {
    pinnedTrailKeys.add(key);
    rememberTrailVehicle(key);
    refreshPinnedTrailLine(key);
  }
  updatePlaybackChrome();
}

function clearPinnedTrails() {
  for (const pair of pinnedTrailLines.values()) removeTrailPair(pair, liveTrailLayer);
  pinnedTrailLines.clear();
  pinnedTrailKeys.clear();
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
  const keys = trailKeysForVehicle({ vehicleId, trailKey, reg });
  for (const key of keys) rememberTrailVehicle(key);

  let fromMs = 0;
  let toMs = 0;
  if (datetime) {
    const start = new Date(datetime).getTime();
    if (Number.isFinite(start)) {
      fromMs = start - 5 * 60 * 1000;
      toMs = start + 4 * 60 * 60 * 1000;
    }
  }

  const trackOpts = { journeyId, tripId, fromMs, toMs };
  const tracked = bestTrackedPath(keys, trackOpts);
  const trip = tripId ? await tripEnds(tripId) : null;
  const usingTracked = showTail && tracked.length >= 3;
  const path = usingTracked ? tracked : trip?.path || [];
  if (path.length < 2 && !(showTail && tracked.length >= 2)) {
    showMessage(
      keys.length && showTail
        ? "Not enough tracked moves yet — keep watching the bus"
        : "No route shape for that trip",
    );
    return;
  }
  stopRoutePlayback("", { clearTail: true });
  if (showTail) {
    pinVehicleTrail({ vehicleId, trailKey, reg });
  } else {
    clearPinnedTrails();
    setLiveTrailFocus("");
  }

  const lineName = line || trip?.line || "Bus";
  const hasTimetable = !usingTracked && (trip?.path || []).length >= 2;
  const labelParts = [
    `${lineName}${dest || trip?.headsign ? ` → ${dest || trip.headsign}` : ""}`,
    showTail && (usingTracked || tracked.length >= 2)
      ? usingTracked
        ? "tracked path"
        : "timetable + tail"
      : hasTimetable
        ? "timetable"
        : "route",
  ];
  if (showTail && compactReg(reg)) labelParts.push(compactReg(reg));
  const label = labelParts.join(" · ");

  if (hasTimetable) {
    L.polyline(trip.path, {
      color: "#38bdf8",
      weight: 4,
      opacity: 0.85,
      lineJoin: "round",
    }).addTo(playbackLayer);
  }

  const drawPath = path.length >= 2 ? path : showTail ? tracked : [];
  const tailPath = showTail && tracked.length >= 2 ? tracked : usingTracked ? drawPath : [];
  if (showTail && tailPath.length >= 2) {
    makeTrailPair(tailPath, playbackLayer);
  } else if (drawPath.length >= 2 && !hasTimetable) {
    L.polyline(drawPath, {
      color: "#38bdf8",
      weight: 4,
      opacity: 0.92,
      lineJoin: "round",
    }).addTo(playbackLayer);
  }

  if (drawPath.length >= 2) {
    L.circleMarker(drawPath[0], {
      radius: 6,
      color: "#ffffff",
      weight: 2,
      fillColor: "#22c55e",
      fillOpacity: 1,
    })
      .addTo(playbackLayer)
      .bindTooltip("Start", { direction: "top", opacity: 0.9 });
    L.circleMarker(drawPath[drawPath.length - 1], {
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
    ...(hasTimetable ? trip.path : []),
    ...drawPath,
    ...(showTail ? tracked : []),
  ];
  if (boundsPath.length >= 2) {
    map.fitBounds(L.latLngBounds(boundsPath).pad(0.12), { maxZoom: 16, animate: true });
  }

  playback = {
    playKey,
    tripId,
    journeyId,
    vehicleId,
    trailKey,
    reg: compactReg(reg),
    path: drawPath,
    label,
    line: lineName,
    tracked: Boolean(showTail && (usingTracked || tracked.length >= 2)),
    showTail: Boolean(showTail),
  };
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

function playRouteButtonHtml(bus, extra = {}) {
  const tripId = bus?.trip_id || extra.tripId || "";
  const vehicleId = historyVehicleId(bus, extra) || (!String(bus?.id || "").startsWith("dg-") ? bus?.id : "") || "";
  const trailKey = extra.trailKey || "";
  const reg = extra.vehicle?.reg || bus?.vehicle?.reg || "";
  if (!tripId && !vehicleId && !trailKey && !compactReg(reg)) return "";
  if (String(bus?.id || "").startsWith("dg-") && !trailKey && !vehicleId && !compactReg(reg)) return "";
  const playKey = tripId || trailKey || vehicleId || regTrailKey(reg);
  const on = routeOverlayActive(playKey, { vehicleId, trailKey });
  return `<button type="button" class="play-route-btn${on ? " is-on" : ""}" data-trip-id="${esc(tripId)}" data-journey-id="${esc(bus?.journey_id || "")}" data-vehicle-id="${esc(vehicleId)}" data-trail-key="${esc(trailKey)}" data-reg="${esc(reg)}" data-line="${esc(bus?.service?.line_name || extra.line || "")}" data-dest="${esc(extra.to || bus?.destination || "")}" data-datetime="${esc(bus?.datetime || "")}">${on ? "Hide route" : "Show route"}</button>`;
}

function playStaffRouteButtonHtml(item, extra = {}) {
  const trailKey = extra.trailKey || staffTrailKey(item);
  const vehicleId = historyVehicleId(null, extra);
  const latest = Array.isArray(extra.history) && extra.history.length ? extra.history[0] : null;
  const tripId = latest?.trip_id || extra.tripId || "";
  const journeyId = latest?.id || "";
  const reg = extra.btVehicle?.reg || extra.vehicle?.reg || parseFleetReg(item?.vehicle?.ref).reg || "";
  if (!trailKey && !vehicleId && !tripId && !compactReg(reg)) return "";
  const playKey = tripId || trailKey || vehicleId || regTrailKey(reg);
  const on = routeOverlayActive(playKey, { vehicleId, trailKey });
  return `<button type="button" class="play-route-btn${on ? " is-on" : ""}" data-trip-id="${esc(tripId)}" data-journey-id="${esc(journeyId)}" data-vehicle-id="${esc(vehicleId)}" data-trail-key="${esc(trailKey)}" data-reg="${esc(reg)}" data-line="${esc(staffLineName(item) || extra.line || "")}" data-dest="${esc(extra.to || item.currentJourney?.destination?.name || "")}" data-datetime="${esc(latest?.datetime || item.recordedAtTime || "")}">${on ? "Hide route" : "Show route"}</button>`;
}

function followedMarker() {
  if (!followTarget) return null;
  if (followTarget.kind === "staff") return staffMarkers.get(followTarget.id) || null;
  return markers.get(followTarget.id) || markers.get(Number(followTarget.id)) || null;
}

function updateFollowChip() {
  if (!followChipEl) return;
  if (!followTarget) {
    followChipEl.hidden = true;
    followChipEl.textContent = "";
    return;
  }
  followChipEl.hidden = false;
  followChipEl.textContent = `Following ${followTarget.label} · Stop`;
}

function stopFollowBus(message = "") {
  const marker = followedMarker();
  followTarget = null;
  updateFollowChip();
  setLiveTrailFocus("");
  refreshPopup(marker, { force: true });
  if (message) showMessage(message);
}

function keepFollowedInView(marker, { force = false } = {}) {
  if (!followTarget || !marker || !isFollowingMarker(marker)) return;
  const ll = marker.getLatLng();
  const size = map.getSize();
  const point = map.latLngToContainerPoint(ll);
  const dx = point.x - size.x / 2;
  const dy = point.y - size.y / 2;
  const offCentre = !map.getBounds().pad(-0.2).contains(ll) || Math.hypot(dx, dy) > 70;
  if (!force && !offCentre) return;
  followPanning = true;
  if (force) map.setView(ll, Math.max(map.getZoom(), 16), { animate: true });
  else map.panTo(ll, { animate: true, duration: 0.35 });
  map.once("moveend", () => {
    followPanning = false;
  });
}

function startFollowBus(marker) {
  if (!marker) return;
  followYou = false;
  locateButton?.classList.remove("active");
  followTarget = {
    kind: followKindFor(marker),
    id: followIdFor(marker),
    label: followLabelFor(marker),
  };
  showMessage("");
  // Tails are Fleet-only — keep recording GPS, but don't draw on the map here.
  const trailKey = marker.bus?.id || (marker.staff ? `staff-${followIdFor(marker)}` : "");
  if (trailKey) rememberTrailVehicle(trailKey);
  setLiveTrailFocus("");
  keepFollowedInView(marker, { force: true });
  if (announceOn) followJourney(marker, true);
  updateFollowChip();
}

function toggleFollowBus(marker) {
  if (isFollowingMarker(marker)) stopFollowBus();
  else startFollowBus(marker);
}

document.addEventListener(
  "click",
  (event) => {
    const historyBtn = event.target.closest(".history-days-btn");
    if (historyBtn) {
      event.preventDefault();
      event.stopPropagation();
      const days = Number(historyBtn.dataset.days);
      if (!HISTORY_DAY_OPTIONS.includes(days)) return;
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
        dest: playBtn.dataset.dest || "",
        datetime: playBtn.dataset.datetime || "",
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
  const unique = [...new Set(ids.filter((id) => id != null && id !== ""))];
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
      liveryById.set(id, await liveryCache.get(id));
    }),
  );
}

const FLIX_GREEN = "#73d700";
const FLIX_LIVERY = {
  left_css: `linear-gradient(${FLIX_GREEN} 0 58%, #ff8500 58% 70%, ${FLIX_GREEN} 70%)`,
  stroke_colour: "#1a1a1a",
};

function isNisDestination(dest) {
  const t = String(dest || "").trim();
  if (!t) return false;
  return /^(not in service|nis|n\/?s|out of service|positioning|dead running|empty to)$/i.test(t)
    || /\b(not in service|out of service|dead running)\b/i.test(t);
}

function isNotInService(bus) {
  if (!bus) return false;
  if (bus.nis) return true;
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
  return isNisDestination(dest);
}

function nisStatus(bus) {
  const dest = String(bus.destination || "").trim();
  const moving = Number.isFinite(bus.speedMph) && bus.speedMph >= 3;
  if (/garage|depot/i.test(dest) && isNisDestination(dest)) {
    return moving ? "Finished — heading to garage" : "Finished at garage";
  }
  if (/position|dead|empty to|to start/i.test(dest)) {
    return "Heading to start the next trip";
  }
  if (moving) return "Off route — positioning / heading to start";
  return "Finished / not in service";
}

function isFlixBus(bus) {
  const name = String(bus?.vehicle?.name || "");
  const colour = String(bus?.vehicle?.colour || "").toLowerCase();
  const url = String(bus?.vehicle?.url || bus?.service?.url || "");
  return (
    bus?.vehicle?.livery === 1046 ||
    colour === FLIX_GREEN ||
    /flixbus/i.test(name) ||
    /flixbus/i.test(url)
  );
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
  const first = extra.firstOccupancy;
  if (first?.seats || first?.remaining != null) {
    const seats = first.seats ?? typicalSeatCount(bus, extra);
    if (seats == null) return null;
    return {
      seats,
      remaining: first.remaining,
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
  if (!info?.seats) return "";
  const seatLabel = info.typical ? `About ${info.seats} seats` : `${info.seats} seats`;
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
      leftLabel = "none left";
      cls = "is-full";
    } else {
      leftLabel = `${info.remaining} left`;
      cls = info.remaining <= 8 ? "is-low" : "is-ok";
    }
  }
  return `
    <div class="popup-seats ${cls}">${esc(`${seatLabel} · ${leftLabel}`)}</div>
  `;
}

function isFirstBus(bus, extra = {}) {
  const name = `${operatorName(bus, extra)} ${extra.vehicle?.operator?.name || extra.operator || ""}`;
  if (/\bflix/i.test(name)) return false;
  return /\bfirst\b/i.test(name);
}

function parseFirstOccupancy(row) {
  if (!row || typeof row !== "object") return null;
  const types = row.occupancy?.types || row.Occupancy?.types || [];
  const list = Array.isArray(types) ? types : [];
  const seated = list.find((item) => /seat/i.test(item?.name || "")) || {};
  const wheel = list.find((item) => /wheel/i.test(item?.name || "")) || {};
  const seats =
    asCount(seated.capacity, 8, 120) ||
    asCount(row.SeatsCapacity ?? row.seatCapacity ?? row.capacity, 8, 120);
  const occupied = asCount(seated.occupied ?? row.OccupiedSeats ?? row.occupied, 0, 120);
  const seatsLeft = asCount(
    row.SeatsAvailable ?? row.availableSeats ?? row.EmptySeats ?? row.seatsAvailable,
    0,
    120,
  );
  const remaining =
    seatsLeft != null ? seatsLeft : seats != null && occupied != null ? Math.max(0, seats - occupied) : null;
  if (seats == null && remaining == null) return null;
  const wheelchair = asCount(wheel.capacity ?? row.WheelchairCapacity ?? row.wheelchairCapacity, 0, 6);
  const wheelOcc = asCount(wheel.occupied, 0, 6);
  const wheelchairLeft =
    asCount(row.WheelchairSpaces ?? row.availableWheelchairs ?? row.wheelchairSpaces, 0, 6) ??
    (wheelchair != null && wheelOcc != null ? Math.max(0, wheelchair - wheelOcc) : null);
  return { seats, remaining, wheelchair, wheelchairLeft };
}

async function fetchFirstStopTimes(atco) {
  if (!atco) return null;
  const hit = firstStopCache.get(atco);
  if (hit && Date.now() - hit.at < 20000) return hit.data;
  try {
    const res = await fetch(`/api/first-next-bus?stop=${encodeURIComponent(atco)}`);
    const data = res.ok ? await res.json() : null;
    firstStopCache.set(atco, { at: Date.now(), data });
    if (firstStopCache.size > 80) firstStopCache.delete(firstStopCache.keys().next().value);
    return data;
  } catch {
    return null;
  }
}

function matchFirstDeparture(data, bus) {
  const times = data?.times || data?.departures || [];
  const rows = Array.isArray(times) ? times : Object.values(times).flat?.() || [];
  const line = String(bus.service?.line_name || "").toUpperCase();
  const dest = compactQuery(bus.destination || "");
  const matches = rows.filter(
    (row) => String(row.ServiceNumber || row.line || row.line_name || "").toUpperCase() === line,
  );
  const firstOnly = matches.filter((row) => !/^[nN]$/.test(String(row.IsFG ?? row.is_fg ?? "Y")));
  const pool = firstOnly.length ? firstOnly : matches;
  if (!pool.length) return null;
  if (dest) {
    const hit = pool.find((row) => compactQuery(row.Destination || row.direction || "").includes(dest.slice(0, 6)));
    if (hit) return hit;
  }
  return pool.find((row) => parseFirstOccupancy(row)) || pool[0];
}

async function firstOccupancyFor(bus, extra, lat, lng) {
  if (!isFirstBus(bus, extra)) return null;
  const stops = extra.stops || [];
  const upcoming = upcomingStops(stops, lat, lng);
  const atcos = [...upcoming, ...stops].map((stop) => stop.atco).filter(Boolean);
  for (const atco of atcos.slice(0, 4)) {
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

function isWhiteLivery(colour, livery = null) {
  if (isNearWhite(colour)) return true;
  const css = String(livery?.left_css || livery?.left || "");
  if (!css) return false;
  if (/\bwhite\b/i.test(css) && !/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i.test(css.replace(/#f{3,6}\b/gi, ""))) {
    return true;
  }
  const colours = css.match(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b|rgba?\([^)]+\)|\bwhite\b/gi) || [];
  if (!colours.length) return false;
  return colours.every((c) => c.toLowerCase() === "white" || isNearWhite(c));
}

function vehicleIcon(line, heading, colour = "#2563eb", livery = null, speedMph = null, opts = {}) {
  const nis = Boolean(opts.nis);
  const label = esc(String(line || (nis ? "NIS" : "?")).slice(0, 4));
  const rot = Number.isFinite(Number(heading)) ? Number(heading) : 0;
  const white = isWhiteLivery(colour, livery);
  const base = white ? "#ffffff" : colour || "#2563eb";
  const paint = white ? "#ffffff" : livery?.left_css ? `${livery.left_css}, ${base}` : base;
  const stroke = white ? "#111827" : livery?.stroke_colour || (nis ? "#94a3b8" : "#fff");
  const speed = Number.isFinite(speedMph)
    ? speedMph < 1.5
      ? "0 mph"
      : `${Math.round(speedMph)} mph`
    : "";
  const html = `
    <div class="bus-pin${nis ? " bus-pin-nis" : ""}${white ? " bus-pin-white" : ""}">
      <div class="bus-2d" style="transform:rotate(${rot}deg)">
        <span class="bus-wheel bus-wheel-fl"></span>
        <span class="bus-wheel bus-wheel-fr"></span>
        <span class="bus-wheel bus-wheel-rl"></span>
        <span class="bus-wheel bus-wheel-rr"></span>
        <div class="bus-shell" style="box-shadow:0 0 0 2px ${esc(stroke)}, 0 1px 3px rgba(0,0,0,.4)">
          <div class="bus-livery" style="background:${paint}"></div>
          <div class="bus-glass"></div>
          <div class="bus-number" style="transform:translate(-50%,-50%) rotate(${-rot}deg)">${label}</div>
        </div>
      </div>
      ${speed ? `<div class="bus-speed">${esc(speed)}</div>` : ""}
    </div>
  `;
  return L.divIcon({
    className: nis ? "bus-marker nis-marker" : "bus-marker",
    html,
    iconSize: [40, 66],
    iconAnchor: [20, 28],
    popupAnchor: [0, -22],
  });
}

function staffIcon(line, heading, livery = null, speedMph = null) {
  return vehicleIcon(line, heading, STAFF_COLOURS[line] || "#1f6b2d", livery, speedMph);
}

function busIcon(bus, headingOverride = null) {
  const nis = isNotInService(bus);
  const line = bus.service?.line_name || (nis ? "NIS" : "?");
  const heading = Number.isFinite(headingOverride)
    ? headingOverride
    : Number.isFinite(bus.heading)
      ? bus.heading
      : 0;
  if (nis) {
    const livery = liveryById.get(bus.vehicle?.livery) || null;
    return vehicleIcon(line, heading, "#64748b", livery, bus.speedMph, { nis: true });
  }
  if (isFlixBus(bus)) {
    return vehicleIcon(line, heading, FLIX_GREEN, FLIX_LIVERY, bus.speedMph);
  }
  const colour = bus.vehicle?.colour || "#2563eb";
  const livery = liveryById.get(bus.vehicle?.livery) || null;
  return vehicleIcon(line, heading, colour, livery, bus.speedMph);
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

function compactReg(reg) {
  return String(reg || "").replace(/\s+/g, "").toUpperCase();
}

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
  if (id != null && liveryById.has(id)) return liveryById.get(id);
  const left = vehicle.livery?.left_css || vehicle.livery?.left;
  if (!left) return null;
  return {
    left_css: left,
    white_text: true,
    stroke_colour: "#fff",
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

const POPUP_OPTS = { maxWidth: 320, minWidth: 240, autoPan: false, className: "bus-popup" };

function popupHtml(bus, extra = {}) {
  const nis = isNotInService(bus);
  const line = bus.service?.line_name || (nis ? "Not in service" : "Unknown line");
  const from = extra.from || bus.origin || "";
  const to = extra.to || bus.destination || "";
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
  const reg = detail.reg || "";
  const livery = detail.livery?.name || "";
  const idLine = [fleet && `#${fleet}`, reg].filter(Boolean).join(" · ") || liveName;
  const typeLine = [type, deck, fuel].filter(Boolean).join(" · ");
  const operator = operatorName(bus, extra);
  const [lng, lat] = bus.coordinates || [];
  const delaySec =
    extra.delaySec ??
    bus.delay ??
    inferDelaySeconds(extra.stops, lat, lng, bus.datetime);
  const delayText = nis ? "" : formatDelay(delaySec);
  const metaBits = [idLine, operator, typeLine, livery].filter(Boolean);

  return `
    <div class="popup-card">
      <div class="popup-top">
        <div class="popup-line">${esc(line)}</div>
        ${
          nis
            ? ""
            : `<div class="popup-delay ${delayClass(delaySec)}">${esc(delayText)}</div>`
        }
      </div>
      ${nis ? `<div class="popup-title popup-nis">${esc(nisStatus(bus))}</div>` : ""}
      ${nis ? (to ? `<div class="popup-meta">Shown as ${esc(to)}</div>` : "") : routeBlock(from, to)}
      ${seatsBlock(bus, extra)}
      <div class="popup-actions">
        ${followButtonHtml({ bus })}
        ${playRouteButtonHtml(bus, extra)}
      </div>
      ${nis ? "" : stopsBlock(extra.stops, lat, lng)}
      ${historyBlock(extra)}
      <div class="popup-details">
        <div>${esc(metaBits.join(" · "))}</div>
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

/** Rebuild open popup only when HTML changed; keep scroll + fold state. */
function refreshPopup(marker, { force = false } = {}) {
  if (!marker?.isPopupOpen()) return;
  const html = markerPopupHtml(marker);
  if (!html) return;
  if (!force && html === marker._lastPopupHtml) return;
  const root = marker.getPopup()?.getElement();
  const stopsEl = root?.querySelector(".popup-stops");
  const histEl = root?.querySelector(".popup-history-list");
  const scroll = stopsEl?.scrollTop ?? 0;
  const histScroll = histEl?.scrollTop ?? 0;
  const stopsOpen = root?.querySelector(".popup-stops-fold")?.open ?? false;
  const histOpen = root?.querySelector(".popup-history")?.open ?? false;
  marker._lastPopupHtml = html;
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
  if (marker.staff && !marker.extra.trailKey) marker.extra.trailKey = staffTrailKey(marker.staff);
  const vehicleId = historyVehicleId(marker.bus, marker.extra);
  if (!vehicleId) {
    marker.extra.history = [];
    marker.extra.historyStatus = "unavailable";
    refreshPopup(marker);
    return;
  }
  const cacheKey = `${vehicleId}:${days}`;
  if (force) historyCache.delete(cacheKey);
  marker.extra.historyStatus = "loading";
  refreshPopup(marker);
  const rows = await fetchVehicleHistory(vehicleId, days);
  if ((Number(marker.extra.historyDays) || historyDays) !== days) return;
  marker.extra.history = rows;
  marker.extra.historyStatus = rows.length ? "ready" : "empty";
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
    String(bus.id).startsWith("dg-") ? null : vehicleDetails(bus.id),
  ]);
  if (gen !== marker._enrichGen) return;
  if (ends) {
    marker.extra.from = ends.from;
    marker.extra.to = ends.to || bus.destination;
    marker.extra.stops = ends.stops || [];
    if (ends.operator) marker.extra.operator = ends.operator;
    marker.extra.delaySec =
      ends.delaySec ?? inferDelaySeconds(ends.stops, ll.lat, ll.lng, bus.datetime);
  }
  if (vehicle) marker.extra.vehicle = vehicle;
  refreshPopup(marker);
  loadHistoryIntoMarker(marker);
  const dgVehicle = String(bus.id).startsWith("dg-")
    ? await dgVehicleDetails(bus.vehicle?.name)
    : await dgVehicleFromBt(vehicle);
  if (gen !== marker._enrichGen) return;
  if (dgVehicle) marker.extra.dgVehicle = dgVehicle;
  marker.extra.seatsInfo = occupancyFromSources(bus, marker.extra);
  if (isFirstBus(bus, marker.extra)) {
    const first = await firstOccupancyFor(bus, marker.extra, ll.lat, ll.lng);
    if (gen !== marker._enrichGen) return;
    if (first) {
      marker.extra.firstOccupancy = first;
      marker.extra.seatsInfo = occupancyFromSources(bus, marker.extra);
    }
  }
  const bods = await bodsOccupancyFor(bus, marker.extra, ll.lat, ll.lng);
  if (gen !== marker._enrichGen) return;
  if (bods) {
    marker.extra.bodsOccupancy = bods;
    marker.extra.seatsInfo = occupancyFromSources(bus, marker.extra);
  }
  fetchLimitNear(ll.lat, ll.lng, marker.extra.limitMph).then((limit) => {
    if (gen !== marker._enrichGen) return;
    if (!Number.isFinite(limit)) return;
    marker.extra.limitMph = limit;
    refreshPopup(marker);
  });
  refreshPopup(marker);
  followJourney(marker, true);
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
      ${seatsBlock({ vehicle: extra.vehicle }, extra)}
      <div class="popup-actions">
        ${followButtonHtml({ staff: item })}
        ${playStaffRouteButtonHtml(item, popupExtra)}
      </div>
      ${historyBlock(popupExtra)}
      <div class="popup-details">
        <div>${esc([parsed.fleet && `#${parsed.fleet}`, parsed.reg, "D&G Bus", extra.liveryName, size].filter(Boolean).join(" · "))}</div>
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
        const iconKey = `${line}|${Math.round(snapped.heading || 0)}|${Math.round(item.speedMph || 0)}|${livery?.css || ""}`;
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
  const reg = existing?.extra?.vehicle?.reg || bus.vehicle?.reg || "";
  recordVehicleTrail(bus.id, snapped.lat, snapped.lng, snapped.heading, {
    journeyId: bus.journey_id,
    tripId: bus.trip_id,
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
    const iconKey = `${Math.round(snapped.heading || 0)}|${Math.round(bus.speedMph || 0)}|${bus.vehicle?.livery || ""}|${bus.service?.line_name || ""}`;
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
  if (zoom < MIN_ZOOM) {
    cluster.clearLayers();
    markers.clear();
    if (followTarget) stopFollowBus();
    hint.hidden = false;
    hint.textContent = "Zoom in to a town or city to load live buses";
    return;
  }
  hint.hidden = true;
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
    const response = await fetch(`/api/vehicles?${params}`, { signal });
    if (!response.ok) throw new Error(`Could not load vehicles (${response.status})`);
    const buses = await response.json();
    const live = [];
    const seenService = new Set();

    for (const bus of buses) {
      const [lng, lat] = bus.coordinates || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (isStalePing(bus.datetime)) continue;
      if (isNotInService(bus)) {
        dropServiceBus(bus.id);
        continue;
      }
      live.push(bus);
      bus.speedMph = updateMotion(`bus-${bus.id}`, lat, lng, bus.datetime);
      const snapped = liveWhere(bus);
      bus.limitMph = snapped.limitMph ?? nearestRoadLimit(snapped.lat, snapped.lng);
      seenService.add(bus.id);
      upsertLiveBus(bus, snapped);
    }

    for (const [id, marker] of markers) {
      if (!seenService.has(id) || isStalePing(marker.bus?.datetime)) {
        dropServiceBus(id);
        motion.delete(`bus-${id}`);
      }
    }
    revealPendingFocus();

    ensureLiveries(live.map((bus) => bus.vehicle?.livery))
      .then(() => {
        for (const bus of live) {
          const marker = markers.get(bus.id);
          if (!marker) continue;
          marker.setIcon(busIcon(marker.bus, Number(marker.bus?.heading)));
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
          const iconKey = `${Math.round(snapped.heading || 0)}|${Math.round(bus.speedMph || 0)}|${bus.vehicle?.livery || ""}|${bus.service?.line_name || ""}`;
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
          const iconKey = `${marker.line}|${Math.round(snapped.heading || 0)}|${Math.round(item.speedMph || 0)}|${marker.staffLivery?.css || ""}`;
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
      const when =
        row.expected_departure_time ||
        row.live_departure_time ||
        row.aimed_departure_time ||
        row.aimed_arrival_time ||
        "";
      return {
        line: row.service?.line_name || "?",
        dest: row.destination?.name || row.destination?.locality || "",
        when,
        ms: when ? new Date(when).getTime() : NaN,
      };
    })
    .filter((row) => Number.isFinite(row.ms) && row.ms >= now)
    .sort((a, b) => a.ms - b.ms)
    .slice(0, limit);
}

function stopDeparturesHtml(times, status = "") {
  if (status === "loading") {
    return `<div class="stop-popup-meta">Loading next buses…</div>`;
  }
  const upcoming = upcomingStopDepartures(times);
  if (!upcoming.length) {
    return `<div class="stop-popup-meta">No upcoming departures</div>`;
  }
  return `<div class="stop-popup-deps">${upcoming
    .map(
      (row) => `<div class="stop-popup-dep">
        <span class="stop-popup-line">${esc(row.line)}</span>
        <span class="stop-popup-dest" title="${esc(row.dest)}">${esc(row.dest || "—")}</span>
        <span class="stop-popup-time">${esc(formatStopClock(row.when))}</span>
      </div>`,
    )
    .join("")}</div>`;
}

function stopPopupHtml(feature, times = null, status = "") {
  const props = feature?.properties || {};
  const name = props.name || "Bus stop";
  const indicator = props.indicator || "";
  const services = Array.isArray(props.services) ? props.services.filter(Boolean) : [];
  return `
    <div class="stop-popup">
      <div class="stop-popup-name">${esc(name)}</div>
      ${indicator ? `<div class="stop-popup-meta">${esc(indicator)}</div>` : ""}
      ${services.length ? `<div class="stop-popup-services">${esc(services.join(" · "))}</div>` : ""}
      ${stopDeparturesHtml(times, status)}
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
    let count = 0;
    for (const feature of features) {
      if (count >= STOPS_MAX) break;
      const coords = feature?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (!bounds.contains([lat, lng])) continue;
      const marker = L.circleMarker([lat, lng], {
        radius: map.getZoom() >= 16 ? 5 : 4,
        color: "#0f172a",
        weight: 1,
        fillColor: "#38bdf8",
        fillOpacity: 0.9,
        className: "map-stop-marker",
      });
      marker.feature = feature;
      marker.bindPopup(() => stopPopupHtml(feature, null, "loading"), {
        maxWidth: 280,
        className: "bus-popup",
      });
      marker.on("popupopen", async () => {
        const atco = stopAtcoFromFeature(feature);
        if (!atco) {
          marker.setPopupContent(stopPopupHtml(feature, [], ""));
          return;
        }
        const times = await fetchStopTimes(atco);
        if (!marker.isPopupOpen()) return;
        marker.setPopupContent(stopPopupHtml(feature, times));
      });
      marker.addTo(stopsLayer);
      count += 1;
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    // Keep previous stops if a refresh fails.
  }
}

function setStopsVisible(on) {
  stopsOn = Boolean(on);
  localStorage.setItem(STOPS_KEY, stopsOn ? "1" : "0");
  scheduleMapStops();
}

function compactQuery(value) {
  return String(value || "").replace(/[\s._-]+/g, "").toUpperCase();
}

function isVehicleQuery(raw) {
  const t = raw.trim();
  if (/^(bus|coach|vehicle|fleet|reg|vrm)\b/i.test(t)) return true;
  const c = compactQuery(t);
  if (/^[A-Z]{2}\d{2}[A-Z]{3}$/.test(c)) return true;
  if (/^[A-Z]\d{1,3}[A-Z]{3}$/.test(c)) return true;
  if (/^\d{1,4}[A-Z]{3}$/.test(c)) return true;
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
  const q = compactQuery(query.replace(/^(bus|coach|vehicle|fleet|reg|vrm)\s+/i, ""));
  if (!q) return null;

  const staffExact = [...staffMarkers.values()].filter(
    (marker) => compactQuery(marker.line || staffLineName(marker.staff)) === q,
  );
  if (staffExact.length) return nearestMarker(staffExact);

  const lineExact = [...markers.values()].filter(
    (marker) => compactQuery(marker.bus?.service?.line_name) === q,
  );
  if (lineExact.length) return nearestMarker(lineExact);

  const identity = [];
  for (const marker of [...staffMarkers.values(), ...markers.values()]) {
    if (marker.staff) {
      const parsed = parseFleetReg(marker.staff.vehicle?.ref);
      if (compactQuery(parsed.reg) === q || compactQuery(parsed.fleet) === q) identity.push(marker);
      continue;
    }
    const name = compactQuery(marker.bus?.vehicle?.name);
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
  const open = () => marker.openPopup();
  if (cluster.hasLayer(marker) && typeof cluster.zoomToShowLayer === "function") {
    cluster.zoomToShowLayer(marker, open);
  } else {
    open();
  }
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
  const q = compactQuery(query.replace(/^(bus|coach|vehicle|fleet|reg|vrm)\s+/i, ""));
  const name = compactQuery(bus.vehicle?.name);
  const url = String(bus.vehicle?.url || "").toLowerCase();
  const line = compactQuery(bus.service?.line_name);
  if (vehicle?.slug && url.includes(String(vehicle.slug).toLowerCase())) return true;
  if (vehicle?.reg && name.includes(compactQuery(vehicle.reg))) return true;
  if (vehicle?.fleet_code && name.includes(compactQuery(vehicle.fleet_code))) return true;
  if (q && line === q) return true;
  return Boolean(q && q.length >= 5 && (name.includes(q) || url.includes(q.toLowerCase())));
}

async function searchVehicleRemote(query) {
  const q = query.replace(/^(bus|coach|vehicle|fleet|reg|vrm)\s+/i, "").trim();
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
  let vehicle = null;
  try {
    const res = await fetch(`/api/bt-vehicles/?search=${encodeURIComponent(compactQuery(q))}`);
    const data = await res.json();
    vehicle = data?.results?.[0] || null;
  } catch {
    vehicle = null;
  }
  showMessage("Finding vehicle…");
  const live = await getLiveIndex();
  const match = live.find((bus) => busMatchesQuery(bus, vehicle, q));
  if (!match?.coordinates) {
    showMessage(
      vehicle
        ? `${vehicle.reg || vehicle.fleet_code || "Vehicle"} is not tracking live`
        : "Vehicle not found",
    );
    return true;
  }
  showMessage("");
  pendingFocus = { kind: "bus", id: match.id };
  const [lng, lat] = match.coordinates;
  map.setView([lat, lng], 16);
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

function liveWhere(bus) {
  const [lng, lat] = bus.coordinates || [];
  const heading = Number(bus.heading);
  const speed = Number(bus.speedMph);
  const age = pingAgeMs(bus.datetime);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { lat, lng, heading, limitMph: null };
  let meters = 0;
  if (age >= 2000 && age <= 35000 && Number.isFinite(heading) && Number.isFinite(speed) && speed >= 4) {
    meters = Math.min(160, speed * 0.44704 * (age / 1000));
  }
  return keepOnRoad(bus, lat, lng, heading, meters);
}

function staffWhere(item) {
  const lat = Number(item.positioning?.latitude);
  const lng = Number(item.positioning?.longitude);
  const heading = Number(item.positioning?.bearing);
  const speed = Number(item.speedMph);
  const age = pingAgeMs(item.recordedAtTime);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { lat, lng, heading, limitMph: null };
  let meters = 0;
  if (age >= 2000 && age <= 35000 && Number.isFinite(heading) && Number.isFinite(speed) && speed >= 4) {
    meters = Math.min(160, speed * 0.44704 * (age / 1000));
  }
  return keepOnRoad(item, lat, lng, heading, meters);
}

function advanceLiveMarkers() {
  for (const marker of markers.values()) {
    const bus = marker.bus;
    if (!bus?.coordinates) continue;
    placeOnRoad(marker, liveWhere(bus));
  }
  for (const marker of staffMarkers.values()) {
    const item = marker.staff;
    if (!item?.positioning) continue;
    const snapped = staffWhere(item);
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
  if (marker.bus) {
    recordVehicleTrail(marker.bus.id, snapped.lat, snapped.lng, snapped.heading, {
      journeyId: marker.bus.journey_id,
      tripId: marker.bus.trip_id,
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

const mapWrapEl = document.querySelector(".map-wrap");
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
    })
  : null;

document.getElementById("fleet-search-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = document.getElementById("fleet-query")?.value.trim() || "";
  fleetBrowser?.search(query);
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

  try {
    if (isVehicleQuery(query) && !looksLikePostcode) {
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

  if (localStorage.getItem(DONATE_DISMISS_KEY) === "1") {
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

setupDonateBox();
