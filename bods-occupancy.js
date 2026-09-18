function xmlTag(xml, name) {
  const match = String(xml || "").match(
    new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`, "i"),
  );
  return match ? match[1].trim() : "";
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

export function parseSiriVehicles(xml) {
  const items = [];
  const parts = String(xml || "").split(/<VehicleActivity[\s>]/i).slice(1);
  for (const part of parts) {
    const lat = Number(xmlTag(part, "Latitude"));
    const lng = Number(xmlTag(part, "Longitude"));
    const bearing = Number(xmlTag(part, "Bearing"));
    items.push({
      occupancy:
        xmlTag(part, "Occupancy") ||
        xmlTag(part, "OccupancyStatus") ||
        xmlTag(part, "VehicleOccupancy"),
      vehicleRef: xmlTag(part, "VehicleRef"),
      line: xmlTag(part, "PublishedLineName") || xmlTag(part, "LineRef"),
      operator: xmlTag(part, "OperatorRef"),
      destination: xmlTag(part, "DestinationName") || xmlTag(part, "DestinationRef"),
      origin: xmlTag(part, "OriginName") || xmlTag(part, "OriginRef"),
      direction: xmlTag(part, "DirectionRef"),
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

const BBOX_RE = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;

async function bodsDatafeed(apiKey, bbox) {
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
  return { response, xml };
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
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
  const bbox = url.searchParams.get("bbox") || "";
  if (!BBOX_RE.test(bbox)) {
    json(res, 400, { items: [], error: "bad_bbox" });
    return;
  }
  try {
    const { response, xml } = await bodsDatafeed(apiKey, bbox);
    if (!response.ok) {
      json(res, 502, { items: [], error: `bods_${response.status}` });
      return;
    }
    json(res, 200, { items: parseSiriVehicles(xml) });
  } catch {
    json(res, 502, { items: [], error: "bods_fetch" });
  }
}

export function bodsOccupancyPlugin(apiKey) {
  return {
    name: "bods-occupancy",
    configureServer(server) {
      server.middlewares.use("/api/bods-occupancy", (req, res) =>
        handleBodsOccupancy(req, res, apiKey),
      );
    },
  };
}
