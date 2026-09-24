/**
 * Live First Bus departures + seat / wheelchair occupancy (First Bus app gateway).
 * GET /api/first-stop-times?stop=<atco>
 *
 * The gateway only fills `live-departures` — and therefore `occupancy.types`
 * (seated / wheelchair counts) — when called with `?live=true`. That flag is not
 * in their swagger; it comes from the mobile app's request builder.
 * Auth: Ocp-Apim-Subscription-Key (FIRST_APP_KEY) → 60-min JWT, cached here so
 * the server polls upstream (≈2 req/min/stop) instead of every browser.
 */
import fs from "node:fs";
import { startFirstStream, streamOccupancyFor } from "./first-stream.mjs";

const BASE = "https://api.firstbus.co.uk/gofirst-transport/api";
const TOKEN_TTL_MS = 50 * 60_000; // tokens are valid 60 min
const STOP_TTL_MS = 30_000; // per-stop cache
const ATCO_RE = /^[A-Za-z0-9]{4,32}$/;

let configuredKey = "";
let envFileKey = null; // memoised .env parse (server.mjs does not load dotenv)
let token = { at: 0, value: "" };
let tokenInflight = null;
const stopCache = new Map(); // atco -> { at, body }
const stopInflight = new Map(); // atco -> Promise<body>

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** Vite passes the key from loadEnv; the server falls back to process.env, then .env. */
export function firstStopTimesPlugin(key = "") {
  configuredKey = String(key || "").trim();
  return {
    name: "first-stop-times",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = String(req.url || "").split("?")[0];
        if (path === "/api/first-stop-times") return handleFirstStopTimes(req, res);
        return next();
      });
    },
  };
}

/** Vite passes the key from loadEnv; the server falls back to process.env, then .env. */
export function appKey() {
  if (configuredKey) return configuredKey;
  const fromProcess = String(process.env.FIRST_APP_KEY || "").trim();
  if (fromProcess) return fromProcess;
  if (envFileKey === null) {
    envFileKey = "";
    try {
      const match = fs
        .readFileSync(new URL(".env", import.meta.url), "utf8")
        .match(/^\s*FIRST_APP_KEY\s*=\s*(.*?)\s*$/m);
      if (match) envFileKey = match[1].replace(/^["']|["']$/g, "");
    } catch {
      /* no .env */
    }
  }
  return envFileKey;
}

export async function gatewayToken(key) {
  if (token.value && Date.now() - token.at < TOKEN_TTL_MS) return token.value;
  if (tokenInflight) return tokenInflight;
  tokenInflight = (async () => {
    const res = await fetch(`${BASE}/authentication/token`, {
      headers: { "Ocp-Apim-Subscription-Key": key, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`first_token_${res.status}`);
    const data = await res.json().catch(() => null);
    const value = String(data?.accessToken || "");
    if (!value) throw new Error("first_token_empty");
    token = { at: Date.now(), value };
    return value;
  })().finally(() => {
    tokenInflight = null;
  });
  return tokenInflight;
}

/** Departures for one stop — the same call the First Bus app's board makes. */
async function loadStopTimes(atco) {
  const key = appKey();
  if (!key) throw new Error("first_app_key_missing");
  const jwt = await gatewayToken(key);
  const time = new Date().toISOString();
  const url = `${BASE}/bus/stop/${encodeURIComponent(atco)}/departure?live=true&time=${encodeURIComponent(time)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Ocp-Apim-Subscription-Key": key,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`first_departure_${res.status}`);
  const data = await res.json().catch(() => null);
  const attrs = data?.data?.attributes || {};
  const live = Array.isArray(attrs["live-departures"]) ? attrs["live-departures"] : [];
  const timetable = Array.isArray(attrs["timetable-departures"])
    ? attrs["timetable-departures"]
    : [];
  return {
    stop: atco,
    at: time,
    // Live rows carry `occupancy.types` (seated / wheelchair); timetable fills the rest.
    times: [...live, ...timetable],
  };
}

function cachedStop(atco) {
  const hit = stopCache.get(atco);
  if (hit && Date.now() - hit.at < STOP_TTL_MS) return Promise.resolve(hit.body);
  const pending = stopInflight.get(atco);
  if (pending) return pending;
  const job = loadStopTimes(atco)
    .then((body) => {
      stopCache.set(atco, { at: Date.now(), body });
      if (stopCache.size > 60) stopCache.delete(stopCache.keys().next().value);
      return body;
    })
    .finally(() => stopInflight.delete(atco));
  stopInflight.set(atco, job);
  return job;
}

/**
 * Fill rows the REST board left without a reading from the app's websocket stream
 * (first-stream.mjs): the stream carries per-vehicle occupancy continuously, while
 * `occupancy.types` only appears on a board row once its bus is near THAT stop.
 * Rows that already have a non-empty reading are untouched — the board's own value is
 * trip-exact for this stop. Matching is line + direction + this ATCO within ±20 min of
 * the row's scheduled time (same pinning idea as the client's matchFirstDeparture);
 * ambiguous candidates return nothing rather than another trip's counts.
 * Exported for tests.
 */
export function enrichTimesWithStream(times, atco) {
  if (!Array.isArray(times) || !times.length || !atco) return times;
  let touched = false;
  const out = times.map((row) => {
    if (!row || typeof row !== "object") return row;
    const existing = row.occupancy?.types;
    if (Array.isArray(existing) && existing.length) return row;
    const line = row.line || row.line_name || row.ServiceNumber || row["line-name"] || "";
    const dir = row.lineDirection || row["line-direction"] || row.dir || "";
    const scheduled = row.scheduledTime || row["departure-time"] || row.scheduled_time || "";
    const hit = streamOccupancyFor({ line, dir, atco, scheduled });
    if (!hit?.occupancy?.types?.length) return row;
    touched = true;
    return {
      ...row,
      occupancy: hit.occupancy,
      occupancy_source: "stream",
      stream: { vehicle_id: hit.vehicle_id, recorded_at_time: hit.recorded_at_time },
    };
  });
  return touched ? out : times;
}

const FIRST_NEARBY_CACHE_TTL_MS = 15_000;
const firstNearbyCache = new Map();
const firstNearbyInflight = new Map();

function firstDirection(value) {
  const d = String(value || "")
    .trim()
    .toLowerCase();
  if (/^(in|inbound)$/.test(d)) return "in";
  if (/^(out|outbound)$/.test(d)) return "out";
  return "";
}

function firstText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function firstRowMatches(row, { line = "", destination = "", direction = "" } = {}) {
  if (!row || typeof row !== "object") return false;
  const rowLine = String(row.line || row.line_name || row.ServiceNumber || row["line-name"] || "")
    .trim()
    .toUpperCase();
  if (line && rowLine !== String(line).trim().toUpperCase()) return false;
  const rowDirection = firstDirection(row.lineDirection || row["line-direction"] || row.direction);
  const wantDirection = firstDirection(direction);
  if (wantDirection && rowDirection && rowDirection !== wantDirection) return false;
  const operator = String(row.operator || row.operator_name || row.operatorName || "");
  if (operator && !/FPOT|First/i.test(operator)) return false;
  const actualDestination = firstText(row.direction || row.Destination || row.destination);
  const wantedDestination = firstText(destination);
  if (wantedDestination && actualDestination) {
    const matches =
      actualDestination === wantedDestination ||
      actualDestination.includes(wantedDestination) ||
      wantedDestination.includes(actualDestination) ||
      actualDestination.split(" ").some((word) => word.length >= 5 && wantedDestination.includes(word));
    if (!matches) return false;
  }
  return true;
}

function firstOccupancyFromRow(row) {
  const types = row?.occupancy?.types;
  if (!Array.isArray(types) || !types.length) return null;
  return {
    occupancy: row.occupancy,
    vehicle_id: String(row.vehicle_id || row.vehicleId || ""),
    recorded_at_time: String(row.recorded_at_time || row.scheduledTime || ""),
    description: String(row.direction || row.Destination || row.destination || ""),
  };
}

async function firstNearbyStops(lat, lng) {
  const key = appKey();
  if (!key || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const jwt = await gatewayToken(key);
  const url = `${BASE}/bus/stop/nearby?Lat=${encodeURIComponent(String(lat))}&Lng=${encodeURIComponent(String(lng))}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Ocp-Apim-Subscription-Key": key,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return Array.isArray(data?.["bus-data"]) ? data["bus-data"] : [];
}

/**
 * Find a live First departure near a bus when the websocket has not published
 * that vehicle yet. Nearby stop boards are only a fallback; rows still have to
 * match the card's line/direction/destination and contain app occupancy types.
 */
export async function firstOccupancyNearBus({ line = "", destination = "", direction = "", lat = null, lng = null } = {}) {
  if (!String(line || "").trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const cacheKey = [
    String(line).trim().toUpperCase(),
    firstText(destination).slice(0, 80),
    firstDirection(direction),
    Number(lat).toFixed(3),
    Number(lng).toFixed(3),
  ].join("|");
  const cached = firstNearbyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < FIRST_NEARBY_CACHE_TTL_MS) return cached.value;
  if (firstNearbyInflight.has(cacheKey)) return firstNearbyInflight.get(cacheKey);
  const job = (async () => {
    startFirstStream();
    const nearby = await firstNearbyStops(Number(lat), Number(lng));
    const candidates = nearby
      .map((row) => String(row?.["atco-code"] || row?.atco || row?.id || "").trim())
      .filter(Boolean)
      .slice(0, 8);
    const results = await Promise.allSettled(
      candidates.map(async (atco) => {
        const body = await loadStopTimes(atco);
        return enrichTimesWithStream(body.times, atco);
      }),
    );
    const matches = [];
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const row of result.value || []) {
        if (!firstRowMatches(row, { line, destination, direction })) continue;
        const hit = firstOccupancyFromRow(row);
        if (!hit) continue;
        const expected = Number(row.expectedTimeInMinutes);
        matches.push({ hit, expected: Number.isFinite(expected) ? Math.abs(expected) : 1e6 });
      }
    }
    matches.sort((a, b) => a.expected - b.expected);
    return matches[0]?.hit || null;
  })()
    .then((value) => {
      firstNearbyCache.set(cacheKey, { at: Date.now(), value });
      return value;
    })
    .finally(() => firstNearbyInflight.delete(cacheKey));
  firstNearbyInflight.set(cacheKey, job);
  return job;
}

export async function handleFirstStopTimes(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const stop = String(url.searchParams.get("stop") || url.searchParams.get("atco") || "").trim();
  if (!ATCO_RE.test(stop)) {
    json(res, 400, { ok: false, error: "bad_stop", times: [] });
    return;
  }
  try {
    // Connect the continuous vehicle stream while the stop board is loading;
    // the board can be slow, but the stream often already has this bus's seats.
    startFirstStream();
    const body = await cachedStop(stop);
    json(res, 200, { ok: true, ...body, times: enrichTimesWithStream(body.times, stop) });
  } catch (error) {
    const missingKey = String(error?.message || "").includes("first_app_key_missing");
    json(res, missingKey ? 503 : 502, {
      ok: false,
      error: missingKey ? "first_key_missing" : "first_upstream",
      times: [],
    });
  }
}
