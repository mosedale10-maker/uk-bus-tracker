function xmlTag(xml, name) {
  const match = String(xml || "").match(
    new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`, "i"),
  );
  return match ? match[1].trim() : "";
}

function xmlNumber(xml, ...names) {
  for (const name of names) {
    const raw = xmlTag(xml, name);
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseSiriDelay(raw) {
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && Math.abs(asNumber) < 86400) return asNumber;
  const text = String(raw).trim();
  const match = text.match(/^(-)?P(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return null;
  const hours = Number(match[2] || 0);
  const mins = Number(match[3] || 0);
  const secs = Number(match[4] || 0);
  const total = hours * 3600 + mins * 60 + secs;
  if (!total) return 0;
  return match[1] ? -total : total;
}

function parseVelocityMph(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;
  // SIRI Velocity is commonly m/s; some Ticketer feeds send km/h.
  if (n <= 55) return n * 2.23694;
  if (n <= 140) return n * 0.621371;
  return null;
}

function parseOccupancyPayload(part) {
  const status =
    xmlTag(part, "Occupancy") ||
    xmlTag(part, "OccupancyStatus") ||
    xmlTag(part, "VehicleOccupancy") ||
    "";
  const passengers = xmlNumber(
    part,
    "OnboardCount",
    "NumberOfPassengers",
    "PassengerCount",
    "OccupiedSeats",
  );
  const percentage = xmlNumber(part, "Percentage", "OccupancyPercentage", "occupancy_percentage");
  if (!status && passengers == null && percentage == null) return null;
  return {
    status: status || null,
    passengers: Number.isFinite(passengers) ? Math.round(passengers) : null,
    percentage: Number.isFinite(percentage) ? percentage : null,
  };
}

export function parseSiriVehicles(xml) {
  const items = [];
  const parts = String(xml || "").split(/<VehicleActivity[\s>]/i).slice(1);
  for (const part of parts) {
    const lat = Number(xmlTag(part, "Latitude"));
    const lng = Number(xmlTag(part, "Longitude"));
    const bearing = Number(xmlTag(part, "Bearing"));
    const occupancy = parseOccupancyPayload(part);
    const vehicleRef = xmlTag(part, "VehicleRef");
    const operator = xmlTag(part, "OperatorRef");
    const journeyRef =
      xmlTag(part, "VehicleJourneyRef") ||
      xmlTag(part, "DatedVehicleJourneyRef") ||
      "";
    items.push({
      occupancy: occupancy?.status || null,
      occupancyDetail: occupancy,
      vehicleRef,
      line: xmlTag(part, "PublishedLineName") || xmlTag(part, "LineRef"),
      lineRef: xmlTag(part, "LineRef"),
      operator,
      destination: xmlTag(part, "DestinationName") || xmlTag(part, "DestinationRef"),
      origin: xmlTag(part, "OriginName") || xmlTag(part, "OriginRef"),
      direction: xmlTag(part, "DirectionRef"),
      journeyRef,
      recordedAt: xmlTag(part, "RecordedAtTime"),
      destinationAimedArrival: xmlTag(part, "DestinationAimedArrivalTime"),
      originAimedDeparture: xmlTag(part, "OriginAimedDepartureTime"),
      ticketMachineServiceCode: xmlTag(part, "TicketMachineServiceCode"),
      delaySec: parseSiriDelay(xmlTag(part, "Delay")),
      bearing: Number.isFinite(bearing) ? bearing : null,
      velocityMph: parseVelocityMph(xmlTag(part, "Velocity")),
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
    });
  }
  return items;
}

export function parseSiriOccupancy(xml) {
  return parseSiriVehicles(xml);
}

/** BODS / Ticketer often use underscores in place names (Adderley_Green__First_Bus_Depot). */
export function normalizeAvlText(value) {
  return String(value || "")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Prefer a readable plate from refs like FPOT-SK63_KGE / FPOT-YX66_WBV. */
function vehicleLabelFromRef(ref, operator) {
  const raw = String(ref || "").trim();
  if (!raw) return "Bus";
  let body = raw;
  const op = String(operator || "").trim();
  if (op && body.toUpperCase().startsWith(`${op.toUpperCase()}-`)) {
    body = body.slice(op.length + 1);
  }
  body = normalizeAvlText(body);
  const plate = body.match(/\b([A-Z]{1,3}\d{1,2}\s*[A-Z]{3})\b/i);
  if (plate) {
    const reg = plate[1].replace(/\s+/g, " ").toUpperCase();
    return reg;
  }
  return body || raw;
}

function operatorBrandColour(op) {
  const code = String(op || "").trim().toUpperCase();
  const map = {
    FPOT: "#d5137e",
    DAGC: "#00a651",
    FLIX: "#73d700",
    NATX: "#003087",
    SCCM: "#e30613",
    SCCO: "#e30613",
    SCMN: "#e30613",
    ARCT: "#71c5e8",
    ARBB: "#71c5e8",
    GNEL: "#e30613",
    FBRI: "#e87722",
    FSYO: "#e87722",
    TNXB: "#e30613",
    TCM: "#ff8200",
    TFGM: "#ff8200",
  };
  if (map[code]) return map[code];
  if (/^F[A-Z]{2,}$/.test(code) && code !== "FLIX") return "#e87722";
  if (/^SC/.test(code)) return "#e30613";
  if (/^AR/.test(code)) return "#71c5e8";
  return "#2563eb";
}

/** Normalize Ticketer AVL tokens (Dead_Run / Dead-Run → "dead run"). */
function avlToken(value) {
  return normalizeAvlText(value)
    .replace(/[-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dead-run / OOS line refs used by Ticketer on BODS (Dead_Run, DEAD_RUN, …). */
export function isDeadRunLineText(line) {
  const t = avlToken(line);
  if (!t) return false;
  if (
    /^(dead\s*run|deadrun|oos|nis|n\/?s|not\s*in\s*service|out\s*of\s*service|positioning)$/i.test(t)
  ) {
    return true;
  }
  // e.g. "FPOT Dead Run", "Dead Run 1"
  return /\bdead\s*run\b/i.test(t);
}

/** Non-empty line that is not an explicit dead-run / OOS marker (e.g. 11B, 25, BS1). */
export function isPassengerServiceLine(line) {
  const t = avlToken(line);
  if (!t || t === "?") return false;
  return !isDeadRunLineText(t);
}

/** Explicit not-in-service destination text. */
export function isNisDestinationText(dest) {
  const t = avlToken(dest);
  if (!t) return false;
  return (
    /^(not in service|nis|n\/?s|out of service|oos|positioning|dead running|dead run|empty to|to garage|to depot)$/i.test(
      t,
    ) || /\b(not in service|out of service|dead\s*run(?:ning)?|empty to)\b/i.test(t)
  );
}

/**
 * Garage / depot / yard destination (trip purpose = to depot).
 * Does NOT match bare place names like "Adderley Green" on passenger routes —
 * only explicit garage/depot/yard wording (e.g. "Adderley Green First Bus Depot").
 */
export function isDepotRunDestinationText(dest) {
  const t = normalizeAvlText(dest);
  if (!t) return false;
  if (isNisDestinationText(t)) return true;
  return (
    /^(garage|depot|to\s+(?:the\s+)?(?:garage|depot)|out\s*of\s*service|oos)$/i.test(t) ||
    /\b(?:to\s+)?(?:the\s+)?(?:garage|depot)\b|\bout\s*of\s*service\b|\boos\b/i.test(t) ||
    /\b(?:bus\s*)?(?:garage|depot|yard)\b/i.test(t) ||
    /\bfirst\s*bus\s*depot\b/i.test(t)
  );
}

/**
 * True depot / garage OOS: destination says depot AND there is no active passenger
 * service (empty/dead line, or aimed arrival already well past). A real line like
 * 11B with a future/near aimed arrival stays in service even if dest text mentions depot.
 */
export function isDepotOosForService({ destination, line, finishedTrip = false } = {}) {
  if (!isDepotRunDestinationText(destination)) return false;
  if (finishedTrip) return true;
  return !isPassengerServiceLine(line);
}

/** Minutes past DestinationAimedArrivalTime at the last GPS ping → trip finished / layover. */
export const FPOT_FINISHED_GRACE_MS = 10 * 60 * 1000;

export function isFinishedTripByAimedArrival(item, { graceMs = FPOT_FINISHED_GRACE_MS } = {}) {
  const aimMs = Date.parse(item?.destinationAimedArrival || "");
  const recMs = Date.parse(item?.recordedAt || "");
  if (!Number.isFinite(aimMs) || !Number.isFinite(recMs)) return false;
  return recMs - aimMs > graceMs;
}

function ticketMachineLooksOos(code) {
  const t = avlToken(code);
  if (!t) return false;
  // Ticketer sometimes uses a bare "DR" service code for dead runs.
  if (/^dr$/i.test(t)) return true;
  return isDeadRunLineText(t);
}

/** Convert a SIRI-VM activity into the bustimes-like vehicle shape the map uses. */
export function siriItemToBus(item) {
  if (!item || !Number.isFinite(item.lat) || !Number.isFinite(item.lng)) return null;
  const op = String(item.operator || "").trim().toUpperCase();
  const ref = String(item.vehicleRef || "").trim();
  const id = `bods-${op || "op"}-${ref || `${item.lat.toFixed(5)}_${item.lng.toFixed(5)}`}`;
  const published = normalizeAvlText(item.line || "");
  const lineRef = normalizeAvlText(item.lineRef || "");
  const lineRaw = published || lineRef;
  const tmCode = normalizeAvlText(item.ticketMachineServiceCode || "");
  const destination = normalizeAvlText(item.destination || "");
  const direction = String(item.direction || "").trim();
  // Dead run even when DestinationName is empty — Ticketer often only sets line / TM code.
  const deadRun =
    isDeadRunLineText(published) ||
    isDeadRunLineText(lineRef) ||
    isDeadRunLineText(lineRaw) ||
    ticketMachineLooksOos(tmCode) ||
    (isNisDestinationText(destination) && /\bdead\s*run/i.test(avlToken(destination)));
  const line = deadRun ? "DEAD_RUN" : lineRaw;
  const origin = normalizeAvlText(item.origin || "");
  const vehicleName = vehicleLabelFromRef(ref, op);
  const nisDest = isNisDestinationText(destination);
  // Ticketer operators: finished trip when GPS is >10 min past aimed arrival.
  const ticketerOosOp = op === "FPOT" || op === "DAGC";
  const finishedTrip = ticketerOosOp && isFinishedTripByAimedArrival(item);
  const emptyLine = !line;
  // Depot dest + passenger line (e.g. 11B) is only OOS once the trip is finished /
  // dead / empty — never solely because GPS is near a depot / yard.
  const depotOos = isDepotOosForService({ destination, line, finishedTrip });
  const nis = deadRun || nisDest || emptyLine || finishedTrip || depotOos;
  const operatorName =
    op === "FPOT" ? "First Potteries" : op === "DAGC" ? "D & G Bus" : op;
  return {
    id,
    source: "bods",
    coordinates: [item.lng, item.lat],
    heading: item.bearing,
    datetime: item.recordedAt || new Date().toISOString(),
    destination,
    direction: direction || undefined,
    directionRef: direction || undefined,
    origin,
    ...(Number.isFinite(item.delaySec) ? { delay: item.delaySec } : {}),
    journey_id: item.journeyRef || "",
    trip_id: "",
    speedMph: Number.isFinite(item.velocityMph) ? item.velocityMph : undefined,
    nis: nis || undefined,
    deadRun: deadRun || undefined,
    depotOos: depotOos || undefined,
    tripFinished: finishedTrip || undefined,
    nisSource: nis && ticketerOosOp ? "bods-ticketer" : undefined,
    service: {
      // Keep empty when SIRI omits a line — "?" would hide true not-in-service.
      line_name: line,
      operator: op ? { noc: op, name: operatorName || op, id: op } : undefined,
    },
    operator: op
      ? {
          noc: op,
          name: operatorName,
          id: op,
        }
      : undefined,
    vehicle: {
      name: vehicleName,
      reg: /^[A-Z]{1,3}\d{1,2}\s*[A-Z]{3}$/i.test(vehicleName) ? vehicleName : "",
      // D&G / Ticketer often publish fleet number only (e.g. "119") — needed for bustimes history lookup.
      fleet_code: /^\d{1,5}[A-Z]?$/i.test(vehicleName) ? vehicleName : undefined,
      colour: operatorBrandColour(op),
      livery: op ? `op:${op}` : undefined,
    },
    bodsOccupancy: item.occupancyDetail || (item.occupancy ? { status: item.occupancy } : null),
    _bods: {
      vehicleRef: ref,
      operator: op,
      line: lineRaw,
      lineRef: lineRef || undefined,
      directionRef: direction || undefined,
      ticketMachineServiceCode: tmCode || undefined,
      destinationAimedArrival: item.destinationAimedArrival || undefined,
      // Omit when missing — JSON null was becoming Number(null)→0 → "Stopped" on cards.
      ...(Number.isFinite(item.velocityMph) ? { velocityMph: item.velocityMph } : {}),
    },
  };
}

const BBOX_RE = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;
const OPERATOR_RE = /^[A-Z0-9]{2,8}(,[A-Z0-9]{2,8})*$/i;
const FEED_TTL_MS = 5000;
const STALE_TICKETER_PING_MS = 5 * 60 * 1000;

/** Do not publish old Ticketer passenger pings as live map vehicles. */
function isStaleTicketerBus(bus) {
  const op = String(bus?.operator?.noc || bus?._bods?.operator || "").trim().toUpperCase();
  if (op !== "DAGC" && op !== "FPOT") return false;
  const recordedMs = Date.parse(bus?.datetime || "");
  return Number.isFinite(recordedMs) && Date.now() - recordedMs > STALE_TICKETER_PING_MS;
}

/** Cap the upstream wait — wide Staffs boxes can take 6–15s, which stalls the map. */
const BODS_FEED_TIMEOUT_MS = 8000;
const feedCache = new Map();
const parsedFeedCache = new Map();
const parsedFeedInflight = new Map();
const PARSED_FEED_CACHE_MAX = 32;

function feedCacheKey({ bbox = "", operatorRef = "" } = {}) {
  return `${operatorRef || "*"}|${bbox || "*"}`;
}

async function bodsDatafeed(apiKey, { bbox = "", operatorRef = "" } = {}) {
  if (!bbox && !operatorRef) {
    return { response: { ok: false, status: 400 }, xml: "", fromCache: false };
  }
  const key = feedCacheKey({ bbox, operatorRef });
  const cached = feedCache.get(key);
  if (cached && Date.now() - cached.at < FEED_TTL_MS) {
    return { response: { ok: true, status: 200 }, xml: cached.xml, fromCache: true };
  }
  const upstream = new URL("https://data.bus-data.dft.gov.uk/api/v1/datafeed/");
  if (bbox) upstream.searchParams.set("boundingBox", bbox);
  if (operatorRef) upstream.searchParams.set("operatorRef", operatorRef);
  upstream.searchParams.set("api_key", apiKey);
  const response = await fetch(upstream, {
    headers: {
      Accept: "*/*",
      "User-Agent": "uk-bus-tracker/1.0 (local map app)",
    },
    // BODS can take 6–15s on wide bounding boxes. Without this the map request
    // hangs for the full upstream wait instead of falling back to the last good body.
    signal: AbortSignal.timeout(BODS_FEED_TIMEOUT_MS),
  });
  const xml = await response.text();
  if (response.ok) {
    feedCache.set(key, { at: Date.now(), xml });
    if (feedCache.size > 40) {
      const oldest = [...feedCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) feedCache.delete(oldest[0]);
    }
  }
  return { response, xml, fromCache: false };
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function bboxFromQuery(url) {
  const direct = url.searchParams.get("bbox") || "";
  if (BBOX_RE.test(direct)) return direct;
  const xmin = url.searchParams.get("xmin");
  const ymin = url.searchParams.get("ymin");
  const xmax = url.searchParams.get("xmax");
  const ymax = url.searchParams.get("ymax");
  if ([xmin, ymin, xmax, ymax].every((v) => v != null && v !== "" && Number.isFinite(Number(v)))) {
    return `${xmin},${ymin},${xmax},${ymax}`;
  }
  return "";
}

function operatorFromQuery(url) {
  const raw =
    url.searchParams.get("operatorRef") ||
    url.searchParams.get("operator") ||
    url.searchParams.get("noc") ||
    "";
  const cleaned = String(raw)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!cleaned || !OPERATOR_RE.test(cleaned)) return "";
  return cleaned;
}

async function loadBodsItems(apiKey, { bbox = "", operatorRef = "" } = {}) {
  const key = feedCacheKey({ bbox, operatorRef });
  const cached = parsedFeedCache.get(key);
  if (cached && Date.now() - cached.at < FEED_TTL_MS) {
    return { ok: true, status: 200, items: cached.items, fromCache: true };
  }
  const alreadyInflight = parsedFeedInflight.get(key);
  if (alreadyInflight) return alreadyInflight;

  const job = (async () => {
    const { response, xml } = await bodsDatafeed(apiKey, { bbox, operatorRef });
    if (!response.ok) {
      return { ok: false, status: response.status, items: [] };
    }
    const result = { ok: true, status: 200, items: parseSiriVehicles(xml) };
    parsedFeedCache.set(key, { at: Date.now(), items: result.items });
    if (parsedFeedCache.size > PARSED_FEED_CACHE_MAX) {
      const oldest = [...parsedFeedCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) parsedFeedCache.delete(oldest[0]);
    }
    return result;
  })().finally(() => parsedFeedInflight.delete(key));
  parsedFeedInflight.set(key, job);
  return job;
}

/** Approximate GB bbox when only operator=/id= is requested. */
const BODS_UK_BBOX = "-8.2,49.8,1.85,60.9";

function parseVehiclesCacheKey(cacheKey) {
  const raw = String(cacheKey || "");
  const q = raw.startsWith("?") ? raw.slice(1) : raw;
  const params = new URLSearchParams(q);
  const num = (k) => {
    const n = Number(params.get(k));
    return Number.isFinite(n) ? n : null;
  };
  const xmin = num("xmin");
  const ymin = num("ymin");
  const xmax = num("xmax");
  const ymax = num("ymax");
  const hasBbox =
    xmin != null && ymin != null && xmax != null && ymax != null && xmax > xmin && ymax > ymin;
  const operator = String(params.get("operator") || params.get("operatorRef") || params.get("noc") || "")
    .trim()
    .toUpperCase();
  const id = String(params.get("id") || "").trim();
  const service = String(params.get("service") || params.get("line") || "")
    .trim()
    .toUpperCase();
  return {
    bbox: hasBbox ? `${xmin},${ymin},${xmax},${ymax}` : "",
    operator: OPERATOR_RE.test(operator) ? operator : "",
    id,
    service,
  };
}

function operatorFromVehicleId(id) {
  const raw = String(id || "").trim();
  const m = raw.match(/^bods-([A-Z0-9]{2,8})-/i);
  return m ? m[1].toUpperCase() : "";
}

function matchesVehicleId(bus, want) {
  const w = String(want || "").trim();
  if (!w) return true;
  if (String(bus?.id) === w) return true;
  const ref = String(bus?._bods?.vehicleRef || "").trim();
  if (ref && (ref === w || ref.toUpperCase() === w.toUpperCase())) return true;
  const name = String(bus?.vehicle?.name || "").trim();
  if (name && name.toUpperCase() === w.toUpperCase()) return true;
  return false;
}

function matchesServiceLine(bus, want) {
  const w = String(want || "").trim().toUpperCase();
  if (!w) return true;
  const line = String(bus?.service?.line_name || bus?._bods?.line || "").trim().toUpperCase();
  return line === w || line.replace(/\s+/g, "") === w.replace(/\s+/g, "");
}

/**
 * BODS SIRI-VM → bustimes-shaped JSON array for /api/vehicles.
 * Query: ?xmin=&ymin=&xmax=&ymax= and/or operator= / id= / service=
 */
export async function fetchBodsVehiclesJson(cacheKey, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) {
    return {
      status: 503,
      body: Buffer.from(JSON.stringify([]), "utf8"),
      contentType: "application/json; charset=utf-8",
      source: "bods",
      error: "missing_key",
      count: 0,
    };
  }

  const parsed = parseVehiclesCacheKey(cacheKey);
  let bbox = parsed.bbox;
  let operatorRef = parsed.operator;

  if (!bbox && !operatorRef && parsed.id) {
    operatorRef = operatorFromVehicleId(parsed.id);
  }
  if (!bbox && !operatorRef) {
    // id=/service= alone — scan UK (cached). Prefer operator when known.
    bbox = BODS_UK_BBOX;
  }

  const result = await loadBodsItems(key, { bbox, operatorRef });
  if (!result.ok) {
    return {
      status: result.status >= 400 ? result.status : 502,
      body: Buffer.from(JSON.stringify([]), "utf8"),
      contentType: "application/json; charset=utf-8",
      source: "bods",
      count: 0,
    };
  }

  let buses = [];
  for (const item of result.items) {
    const bus = siriItemToBus(item);
    if (bus && !isStaleTicketerBus(bus)) buses.push(bus);
  }
  if (parsed.id) buses = buses.filter((b) => matchesVehicleId(b, parsed.id));
  if (parsed.service) buses = buses.filter((b) => matchesServiceLine(b, parsed.service));

  const body = Buffer.from(JSON.stringify(buses), "utf8");
  return {
    status: 200,
    body,
    contentType: "application/json; charset=utf-8",
    source: "bods",
    count: buses.length,
  };
}

export async function handleBodsOccupancy(req, res, apiKey) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end();
    return;
  }
  if (!apiKey) {
    json(res, 200, { items: [], error: "missing_key" });
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const bbox = bboxFromQuery(url);
  const operatorRef = operatorFromQuery(url);
  if (!BBOX_RE.test(bbox) && !operatorRef) {
    json(res, 400, { items: [], error: "bad_bbox" });
    return;
  }
  try {
    const result = await loadBodsItems(apiKey, { bbox, operatorRef });
    if (!result.ok) {
      json(res, 502, { items: [], error: `bods_${result.status}` });
      return;
    }
    json(res, 200, { items: result.items });
  } catch {
    json(res, 502, { items: [], error: "bods_fetch" });
  }
}

export async function handleBodsVehicles(req, res, apiKey) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end();
    return;
  }
  if (!apiKey) {
    json(res, 200, { vehicles: [], source: "bods", error: "missing_key" });
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const bbox = bboxFromQuery(url);
  const operatorRef = operatorFromQuery(url);
  if (!BBOX_RE.test(bbox) && !operatorRef) {
    json(res, 400, { vehicles: [], source: "bods", error: "bad_bbox" });
    return;
  }
  try {
    const result = await loadBodsItems(apiKey, { bbox, operatorRef });
    if (!result.ok) {
      json(res, 502, { vehicles: [], source: "bods", error: `bods_${result.status}` });
      return;
    }
    const vehicles = [];
    for (const item of result.items) {
      const bus = siriItemToBus(item);
      if (bus && !isStaleTicketerBus(bus)) vehicles.push(bus);
    }
    json(res, 200, {
      vehicles,
      source: "bods",
      count: vehicles.length,
      operatorRef: operatorRef || undefined,
      bbox: bbox || undefined,
    });
  } catch {
    json(res, 502, { vehicles: [], source: "bods", error: "bods_fetch" });
  }
}

export function bodsOccupancyPlugin(apiKey) {
  return {
    name: "bods-occupancy",
    configureServer(server) {
      server.middlewares.use("/api/bods-occupancy", (req, res) =>
        handleBodsOccupancy(req, res, apiKey),
      );
      server.middlewares.use("/api/bods-vehicles", (req, res) =>
        handleBodsVehicles(req, res, apiKey),
      );
    },
  };
}
