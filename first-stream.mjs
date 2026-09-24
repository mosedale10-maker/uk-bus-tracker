/**
 * First Bus app websocket — continuous per-vehicle seat / wheelchair counts.
 *
 * Protocol (reverse-engineered from the First Bus Android app, decompiled with jadx):
 *   1. GET /bus/service/socketinfo -> { data: { url, accessToken } } — the accessToken is a
 *      TransportAPI Auth0 JWT issued for First's client; a `request` query param is ignored.
 *   2. Connect to `url` (wss://streaming.first.transportapi.com/) with
 *      `Authorization: Bearer <accessToken>` and permessage-deflate (the app requests both).
 *   3. On open send ONE JSON-RPC 2.0 request (ids MUST be strings — numeric ids make the
 *      gateway answer -32603; method is allow-listed, `configuration` is the only one found):
 *        { jsonrpc:"2.0", id:"…", method:"configuration",
 *          params:{ min_lat, min_lon, max_lat, max_lon, operator:"FPOT" } }
 *      Omitting service/direction subscribes to every FPOT route in the bbox; passing "" for
 *      them literal-matches nothing. The app acks with result:{} .
 *   4. The server then streams `method:"update"` notifications (~every 10s, changed members):
 *        { params:{ resource:{ member:[{
 *            line, dir, description, origin_atcocode, request_time,
 *            stops:[{ atcocode, time:"HH:MM", … }],          // this vehicle's trip pattern
 *            status:{ vehicle_id, occupancy:{ types:[{ name:"seated"|"wheelchair",
 *                                                      capacity, occupied }] },
 *                     recorded_at_time, location, … }
 *          }]}}}
 *
 * `status.occupancy.types` is exactly what the app renders ("%d seats available"), so rows
 * enriched here show the app's numbers even when the stop board's own occupancy is empty
 * (First only fills `occupancy.types` on the REST board when the bus is near that stop).
 *
 * Wiring: first-departures.js calls startFirstStream() lazily on the first
 * /api/first-stop-times request and merges streamOccupancyFor() into rows without readings.
 */
import WebSocket from "ws";
import { appKey, gatewayToken } from "./first-departures.js";

const BASE = "https://api.firstbus.co.uk/gofirst-transport/api";
// Covers Stoke-on-Trent, Newcastle u/L, Leek, Crewe, Blythe Bridge — every valid ATCO.
const BBOX = { min_lat: 52.85, min_lon: -2.55, max_lat: 53.2, max_lon: -1.7 };
const VEHICLE_TTL_MS = 150_000; // drop vehicles with no frame for 2.5 min (service ended)
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

/** vehicle_id -> { line, dir, description, stops, occupancy, vehicleId, recordedAt, lastSeen } */
const vehicles = new Map();
let ws = null;
let started = false;
let reconnectTimer = null;
let reconnectDelayMs = RECONNECT_MIN_MS;

async function socketCreds() {
  const key = appKey();
  if (!key) throw new Error("first_app_key_missing");
  const jwt = await gatewayToken(key);
  const res = await fetch(`${BASE}/bus/service/socketinfo`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Ocp-Apim-Subscription-Key": key,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`first_socketinfo_${res.status}`);
  const data = (await res.json().catch(() => null))?.data || {};
  const url = String(data.url || "");
  const accessToken = String(data.accessToken || "");
  if (!url || !accessToken) throw new Error("first_socketinfo_empty");
  return { url, accessToken };
}

/**
 * One trip is often announced under two vehicle_id encodings — the pattern form
 * `FPOT-inbound-0001-01-01-1914-63115-11` and the dated form
 * `FPOT-inbound-2026-09-23-1914-63115-11` (same HHMM + run number = same run). Collapse
 * them to one map entry so a duplicated trip never counts as two candidate vehicles.
 * Ids that don't match the shape key on themselves.
 */
function tripKey(vehicleId) {
  const m = /^([^-]+)-([^-]+)-(\d{4})-(\d{2})-(\d{2})-(\d{4})-(\d+)-(.+)$/.exec(vehicleId);
  if (!m) return vehicleId;
  return `${m[1]}|${m[2]}|${m[6]}|${m[7]}|${m[8]}`;
}

/** Apply one `update` notification (exported for tests). Ignores non-update frames. */
export function ingestFrame(text) {
  let frame;
  try {
    frame = JSON.parse(String(text));
  } catch {
    return;
  }
  const members = frame?.params?.resource?.member;
  if (frame?.method !== "update" || !Array.isArray(members)) return;
  const now = Date.now();
  for (const m of members) {
    const id = m?.status?.vehicle_id;
    if (!id || !m?.status?.occupancy?.types?.length) continue;
    vehicles.set(tripKey(id), {
      line: String(m.line_name || m.line || ""),
      dir: String(m.dir || ""),
      description: String(m.description || ""),
      stops: Array.isArray(m.stops) ? m.stops : [],
      occupancy: m.status.occupancy, // { types:[{name,capacity,occupied}] } — app-exact
      vehicleId: id,
      location: m.location || m.status?.location || null,
      recordedAt: String(m.status.recorded_at_time || ""),
      lastSeen: now,
    });
  }
}

function prune() {
  const cutoff = Date.now() - VEHICLE_TTL_MS;
  for (const [id, v] of vehicles) {
    if (v.lastSeen < cutoff) vehicles.delete(id);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log("[first-stream] reconnecting in", reconnectDelayMs, "ms (vehicles:", vehicles.size, ")");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
}

async function connect() {
  console.log("[first-stream] connecting...");
  let creds;
  try {
    creds = await socketCreds();
    console.log("[first-stream] socketinfo ok");
  } catch (e) {
    console.error("[first-stream] socketinfo failed:", e.message);
    scheduleReconnect();
    return;
  }
  let sock;
  try {
    sock = new WebSocket(creds.url, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      perMessageDeflate: true,
    });
  } catch (e) {
    console.error("[first-stream] ws create failed:", e.message);
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.on("open", () => {
    if (ws !== sock) return;
    console.log("[first-stream] open, sending configuration");
    reconnectDelayMs = RECONNECT_MIN_MS;
    try { sock.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "ukbustracker-configuration",
        method: "configuration",
        params: BBOX ? { ...BBOX, operator: "FPOT" } : {},
      }),
    ); } catch (e) { console.error("[first-stream] send failed:", e.message); }
  });
  sock.on("message", (data, isBinary) => {
    if (ws !== sock || isBinary) return;
    ingestFrame(String(data));
  });
  sock.on("error", (e) => {
    console.error("[first-stream] ws error:", e.message || e);
  });
  sock.on("close", (code) => {
    if (ws === sock) ws = null;
    console.error("[first-stream] close", code, "(vehicles:", vehicles.size, ")");
    scheduleReconnect();
  });
}

/** Idempotent lazy start — called on the first /api/first-stop-times request. Never throws. */
export function startFirstStream() {
  if (started) return;
  started = true;
  connect().catch(() => {});
}

const LONDON_HM_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
});

function toLondonMinutes(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  if (s.includes("T")) {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return null;
    const parts = {};
    for (const p of LONDON_HM_FMT.formatToParts(new Date(t))) {
      if (p.type !== "literal") parts[p.type] = p.value;
    }
    return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  }
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  return m ? (Number(m[1]) % 24) * 60 + Number(m[2]) : null;
}

function minutesApart(a, b) {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

/**
 * Live occupancy for ONE departure of ONE line at ONE stop.
 * Same line (+ direction when known), and the vehicle's trip pattern must contain this
 * ATCO within ±20 min of the row's scheduled time on the London wall clock — nearest
 * wins. A candidate only answers without times when it is the SINGLE vehicle serving
 * this stop (row time and/or its own stop time unusable). Anything time-mismatched or
 * ambiguous returns null: better no reading than another trip's counts.
 * Returns { occupancy, vehicle_id, recorded_at_time, description } or null.
 */
export function streamOccupancyFor({ line, dir = "", atco, scheduled = "" }) {
  prune();
  const want = String(line || "").trim().toUpperCase();
  if (!want || !atco) return null;
  const scheduledMin = toLondonMinutes(scheduled);
  const inWindow = [];
  const timeless = []; // serves this stop, but one side of the time comparison is unusable
  for (const v of vehicles.values()) {
    if ((v.line || "").toUpperCase() !== want || !v.occupancy) continue;
    if (dir && v.dir && v.dir !== dir) continue;
    let best = null;
    let servesAtco = false;
    let stopTimeUnknown = false;
    for (const s of v.stops) {
      if (s?.atcocode !== atco) continue;
      servesAtco = true;
      const stopMin = toLondonMinutes(s.time);
      if (stopMin == null || scheduledMin == null) {
        stopTimeUnknown = true;
        continue;
      }
      const d = minutesApart(stopMin, scheduledMin);
      if (best == null || d < best) best = d;
    }
    if (!servesAtco) continue;
    if (best != null && best <= 20) inWindow.push({ v, d: best });
    else if (best == null && stopTimeUnknown) timeless.push(v);
  }
  if (inWindow.length) {
    inWindow.sort((a, b) => a.d - b.d);
    return occupancyPayload(inWindow[0].v);
  }
  if (timeless.length === 1) return occupancyPayload(timeless[0]);
  return null;
}

function streamDirection(value) {
  const d = String(value || "")
    .trim()
    .toLowerCase();
  if (/^(in|inbound|outward)$/.test(d)) return "in";
  if (/^(out|outbound)$/.test(d)) return "out";
  return "";
}

function streamText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function streamLocation(location) {
  if (Array.isArray(location)) {
    const lat = Number(location[1]);
    const lng = Number(location[0]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  const lat = Number(location?.lat ?? location?.latitude);
  const lng = Number(location?.lng ?? location?.lon ?? location?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function streamDistance(a, b) {
  if (!a || !b) return Infinity;
  const lat1 = Number(a.lat);
  const lng1 = Number(a.lng);
  const lat2 = Number(b.lat);
  const lng2 = Number(b.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Infinity;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(x)));
}

/**
 * Match the current websocket vehicle to a live map card. This is intentionally
 * conservative: a line/destination match is used only when it identifies one
 * vehicle, or when the card's live position is close to one candidate.
 */
export function streamOccupancyForBus({
  line = "",
  dir = "",
  description = "",
  vehicle = "",
  lat = null,
  lng = null,
} = {}) {
  prune();
  const wantLine = String(line || "").trim().toUpperCase();
  if (!wantLine) return null;
  let candidates = [...vehicles.values()].filter(
    (v) => String(v.line || "").trim().toUpperCase() === wantLine,
  );
  const wantDir = streamDirection(dir);
  if (wantDir) {
    const sameDir = candidates.filter((v) => !v.dir || streamDirection(v.dir) === wantDir);
    if (!sameDir.length) return null;
    candidates = sameDir;
  }

  const wantVehicle = streamText(vehicle);
  if (wantVehicle) {
    const sameVehicle = candidates.filter((v) => {
      const id = streamText(v.vehicleId);
      const desc = streamText(v.description);
      return id.includes(wantVehicle) || desc.includes(wantVehicle);
    });
    if (sameVehicle.length) candidates = sameVehicle;
  }

  const wantDescription = streamText(description);
  if (wantDescription) {
    const sameDescription = candidates.filter((v) => {
      const actual = streamText(v.description);
      return actual && (actual === wantDescription || actual.includes(wantDescription) || wantDescription.includes(actual));
    });
    if (sameDescription.length) candidates = sameDescription;
  }

  if (candidates.length === 1) return occupancyPayload(candidates[0]);
  const hasHere =
    lat !== null &&
    lat !== undefined &&
    lng !== null &&
    lng !== undefined &&
    Number.isFinite(Number(lat)) &&
    Number.isFinite(Number(lng));
  const here = hasHere ? { lat: Number(lat), lng: Number(lng) } : null;
  if (!here || candidates.length < 2) return null;
  const ranked = candidates
    .map((v) => ({ v, distance: streamDistance(here, streamLocation(v.location)) }))
    .sort((a, b) => a.distance - b.distance);
  const nearest = ranked[0];
  if (!nearest || nearest.distance > 2500) return null;
  const close = ranked.filter((row) => row.distance <= nearest.distance + 500);
  return close.length === 1 ? occupancyPayload(nearest.v) : null;
}

function occupancyPayload(v) {
  return {
    occupancy: v.occupancy,
    vehicle_id: v.vehicleId,
    recorded_at_time: v.recordedAt,
    description: v.description,
  };
}
