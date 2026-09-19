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
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
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

/** Convert a SIRI-VM activity into the bustimes-like vehicle shape the map uses. */
export function siriItemToBus(item) {
  if (!item || !Number.isFinite(item.lat) || !Number.isFinite(item.lng)) return null;
  const op = String(item.operator || "").trim();
  const ref = String(item.vehicleRef || "").trim();
  const id = `bods-${op || "op"}-${ref || `${item.lat.toFixed(5)}_${item.lng.toFixed(5)}`}`;
  const line = String(item.line || item.lineRef || "").trim();
  return {
    id,
    source: "bods",
    coordinates: [item.lng, item.lat],
    heading: item.bearing,
    datetime: item.recordedAt || new Date().toISOString(),
    destination: item.destination || "",
    origin: item.origin || "",
    delay: item.delaySec,
    journey_id: item.journeyRef || "",
    trip_id: "",
    service: {
      line_name: line || "?",
      operator: op ? { noc: op, name: op, id: op } : undefined,
    },
    operator: op ? { noc: op, name: op, id: op } : undefined,
    vehicle: {
      name: ref || "Bus",
      colour: "#2563eb",
    },
    bodsOccupancy: item.occupancyDetail || (item.occupancy ? { status: item.occupancy } : null),
    _bods: {
      vehicleRef: ref,
      operator: op,
      line,
      velocityMph: item.velocityMph,
    },
  };
}

const BBOX_RE = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;
const FEED_TTL_MS = 4500;
const feedCache = new Map();

async function bodsDatafeed(apiKey, bbox) {
  const cached = feedCache.get(bbox);
  if (cached && Date.now() - cached.at < FEED_TTL_MS) {
    return { response: { ok: true, status: 200 }, xml: cached.xml, fromCache: true };
  }
  const upstream = new URL("https://data.bus-data.dft.gov.uk/api/v1/datafeed/");
  upstream.searchParams.set("boundingBox", bbox);
  upstream.searchParams.set("api_key", apiKey);
  const response = await fetch(upstream, {
    headers: {
      Accept: "*/*",
      "User-Agent": "uk-bus-tracker/1.0 (local map app)",
    },
  });
  const xml = await response.text();
  if (response.ok) {
    feedCache.set(bbox, { at: Date.now(), xml });
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

async function loadBodsItems(apiKey, bbox) {
  const { response, xml } = await bodsDatafeed(apiKey, bbox);
  if (!response.ok) {
    return { ok: false, status: response.status, items: [] };
  }
  return { ok: true, status: 200, items: parseSiriVehicles(xml) };
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
  if (!BBOX_RE.test(bbox)) {
    json(res, 400, { items: [], error: "bad_bbox" });
    return;
  }
  try {
    const result = await loadBodsItems(apiKey, bbox);
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
  if (!BBOX_RE.test(bbox)) {
    json(res, 400, { vehicles: [], source: "bods", error: "bad_bbox" });
    return;
  }
  try {
    const result = await loadBodsItems(apiKey, bbox);
    if (!result.ok) {
      json(res, 502, { vehicles: [], source: "bods", error: `bods_${result.status}` });
      return;
    }
    const vehicles = [];
    for (const item of result.items) {
      const bus = siriItemToBus(item);
      if (bus) vehicles.push(bus);
    }
    json(res, 200, { vehicles, source: "bods", count: vehicles.length });
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
