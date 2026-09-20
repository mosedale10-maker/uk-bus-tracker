/**
 * First Bus live seat / wheelchair occupancy via TransportAPI —
 * the same feed the First Bus app uses for buses-on-a-map capacity.
 */

const UA = "uk-bus-tracker/1.0 (First Bus occupancy)";
const ATCO_RE = /^[A-Z0-9]{5,16}$/i;
const TAPI_HOST = "first.transportapi.com";
const LINE_RE = /^[A-Z0-9]{1,8}$/i;
const NOC_RE = /^[A-Z0-9]{2,8}$/i;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function flattenDepartures(payload) {
  const deps = payload?.departures;
  if (!deps) return [];
  if (Array.isArray(deps)) return deps;
  if (Array.isArray(deps.all)) return deps.all;
  const out = [];
  for (const value of Object.values(deps)) {
    if (Array.isArray(value)) out.push(...value);
    else if (value && typeof value === "object") out.push(value);
  }
  return out;
}

/** Map TransportAPI departure rows into the shape the map client already matches. */
export function normaliseFirstDepartures(payload) {
  const rows = flattenDepartures(payload);
  return rows.map((row) => {
    const occ = row?.status?.occupancy || row?.occupancy || null;
    return {
      ...row,
      ServiceNumber: row.line_name || row.line || row.ServiceNumber || "",
      Destination: row.direction || row.Destination || "",
      Due: row.best_departure_estimate || row.expected_departure_time || row.aimed_departure_time || row.Due || "",
      IsLive: row.expected_departure_time || row.expected ? "Y" : row.IsLive || "N",
      IsFG: "Y",
      occupancy: occ,
      Occupancy: occ,
    };
  });
}

function transportApiUrlFromNextBus(data, atco) {
  const raw = String(data?.id || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.hostname !== TAPI_HOST && url.hostname !== "transportapi.com") return "";
    if (!url.pathname.includes("/bus/stop_timetables/")) return "";
    url.protocol = "https:";
    url.hostname = TAPI_HOST;
    return url.toString();
  } catch {
    const match = raw.match(/app_id=([^&\s]+).*app_key=([^&\s]+)/i);
    if (!match || !atco) return "";
    return `https://${TAPI_HOST}/v3/uk/bus/stop_timetables/${encodeURIComponent(atco)}.json?app_id=${encodeURIComponent(match[1])}&app_key=${encodeURIComponent(match[2])}&group=false&limit=20&live=true`;
  }
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": UA,
      ...headers,
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

/** Pull First website credentials from a get-next-bus probe (same keys the site embeds). */
async function firstAppCredentials() {
  const probe = await fetchJson("https://www.firstbus.co.uk/api/get-next-bus?stop=3890D000102", {
    Origin: "https://www.firstbus.co.uk",
    Referer: "https://www.firstbus.co.uk/",
  });
  const id = String(probe.data?.id || "");
  const match = id.match(/app_id=([^&\s]+).*app_key=([^&\s]+)/i);
  if (!match) return null;
  return { appId: match[1], appKey: match[2] };
}

let credCache = { at: 0, creds: null };
async function getFirstCreds() {
  if (credCache.creds && Date.now() - credCache.at < 6 * 60 * 60_000) return credCache.creds;
  const creds = await firstAppCredentials();
  if (creds) credCache = { at: Date.now(), creds };
  return creds;
}

export async function fetchFirstStopOccupancy(atco) {
  const code = String(atco || "").trim();
  if (!ATCO_RE.test(code)) {
    return { ok: false, error: "bad_stop", times: [], departures: [] };
  }

  const next = await fetchJson(`https://www.firstbus.co.uk/api/get-next-bus?stop=${encodeURIComponent(code)}`, {
    Origin: "https://www.firstbus.co.uk",
    Referer: "https://www.firstbus.co.uk/",
  });

  let payload = next.data;
  const tapiUrl = transportApiUrlFromNextBus(payload, code);
  if (tapiUrl) {
    const live = await fetchJson(tapiUrl);
    if (live.ok && live.data) payload = live.data;
  }

  const times = normaliseFirstDepartures(payload || {});
  return {
    ok: true,
    atco: code,
    name: payload?.name || payload?.stop_name || "",
    times,
    departures: times,
    source: tapiUrl ? "first.transportapi.com" : "firstbus.co.uk",
  };
}

function normaliseLiveVehicle(row) {
  const coords = row?.status?.location?.coordinates;
  const lng = Number(coords?.[0]);
  const lat = Number(coords?.[1]);
  const occ = row?.status?.occupancy || null;
  const vehicleId = String(row.status?.vehicle_id || "");
  // First app ids look like: FPOT-outbound-2026-09-20-1718-63364-25
  const fleetMatch =
    vehicleId.match(/-(\d{4,6})-(?:\d{1,4}|[A-Z0-9]{1,6})$/i) ||
    vehicleId.match(/(?:^|-)(\d{4,6})(?:-|$)/);
  return {
    operator: row.operator || "",
    line: row.line_name || row.line || "",
    direction: row.dir || "",
    description: row.description || "",
    vehicleId,
    fleet: fleetMatch ? fleetMatch[1] : "",
    bearing: Number(row.status?.bearing),
    recordedAt: row.status?.recorded_at_time || row.request_time || "",
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    occupancy: occ,
    Occupancy: occ,
  };
}

/**
 * Live First Bus vehicles on a line (buses-on-a-map), including seat occupancy.
 * Matches what the First Bus app shows for capacity.
 */
export async function fetchFirstServiceVehicles({
  operator = "FPOT",
  service = "",
  directions = ["outbound", "inbound"],
} = {}) {
  const noc = String(operator || "FPOT").trim().toUpperCase();
  const line = String(service || "").trim().toUpperCase();
  if (!NOC_RE.test(noc) || !LINE_RE.test(line)) {
    return { ok: false, error: "bad_params", vehicles: [] };
  }
  const creds = await getFirstCreds();
  if (!creds) return { ok: false, error: "no_creds", vehicles: [] };

  const dirs = (Array.isArray(directions) ? directions : [directions])
    .map((d) => String(d || "").toLowerCase())
    .filter((d) => d === "inbound" || d === "outbound");
  const want = dirs.length ? dirs : ["outbound", "inbound"];

  const batches = await Promise.all(
    want.map(async (direction) => {
      const url = new URL(`https://${TAPI_HOST}/v3/uk/bus/service_timetables.json`);
      url.searchParams.set("app_id", creds.appId);
      url.searchParams.set("app_key", creds.appKey);
      url.searchParams.set("operator", noc);
      url.searchParams.set("service", line);
      url.searchParams.set("direction", direction);
      url.searchParams.set("live", "true");
      url.searchParams.set("active", "true");
      url.searchParams.set("source_config", "first_siri_vm");
      const live = await fetchJson(url.toString());
      const members = Array.isArray(live.data?.member) ? live.data.member : [];
      return members.map(normaliseLiveVehicle);
    }),
  );

  const vehicles = batches.flat().filter((v) => v.lat != null && v.lng != null);
  // First returns duplicate timetable members for the same bus — keep one per fleet.
  const byFleet = new Map();
  for (const v of vehicles) {
    const key = v.fleet || `${v.lat.toFixed(5)},${v.lng.toFixed(5)}`;
    const prev = byFleet.get(key);
    if (!prev) {
      byFleet.set(key, v);
      continue;
    }
    const prevOcc = Array.isArray(prev.occupancy?.types) ? prev.occupancy.types.length : 0;
    const nextOcc = Array.isArray(v.occupancy?.types) ? v.occupancy.types.length : 0;
    const prevT = Date.parse(prev.recordedAt || "") || 0;
    const nextT = Date.parse(v.recordedAt || "") || 0;
    if (nextOcc > prevOcc || (nextOcc === prevOcc && nextT >= prevT)) byFleet.set(key, v);
  }
  return {
    ok: true,
    operator: noc,
    service: line,
    vehicles: [...byFleet.values()],
    source: "first.transportapi.com/service_timetables",
  };
}

export async function handleFirstStopTimes(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const stop = url.searchParams.get("stop") || "";
  try {
    const data = await fetchFirstStopOccupancy(stop);
    if (!data.ok && data.error === "bad_stop") {
      json(res, 400, { times: [], error: "bad_stop" });
      return;
    }
    json(res, 200, data);
  } catch {
    json(res, 502, { times: [], error: "first_upstream" });
  }
}

export async function handleFirstVehicles(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const operator = url.searchParams.get("operator") || "FPOT";
  const service = url.searchParams.get("service") || url.searchParams.get("line") || "";
  const direction = url.searchParams.get("direction") || "";
  try {
    const data = await fetchFirstServiceVehicles({
      operator,
      service,
      directions: direction ? [direction] : ["outbound", "inbound"],
    });
    if (!data.ok && data.error === "bad_params") {
      json(res, 400, { vehicles: [], error: "bad_params" });
      return;
    }
    json(res, 200, data);
  } catch {
    json(res, 502, { vehicles: [], error: "first_upstream" });
  }
}

/** Vite middleware so local dev matches production. */
export function firstOccupancyPlugin() {
  return {
    name: "first-occupancy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = String(req.url || "").split("?")[0];
        if (path === "/api/first-stop-times") return handleFirstStopTimes(req, res);
        if (path === "/api/first-vehicles") return handleFirstVehicles(req, res);
        return next();
      });
    },
  };
}
