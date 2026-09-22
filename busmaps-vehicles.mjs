/**
 * BusMaps Pro → bustimes.org-shaped vehicle feed.
 * Docs: GET /v1/rawVehiclePositions (capi.busmaps.com:8443)
 */

const BUSMAPS_BASE = "https://capi.busmaps.com:8443/v1/rawVehiclePositions";
const UA = "uk-bus-tracker/1.0 (+https://ukbustracker.co.uk; busmaps)";

/** Approximate Great Britain + NI — used for operator= polls (BusMaps requires a bbox). */
export const BUSMAPS_UK_BBOX = {
  xmin: -8.2,
  ymin: 49.8,
  xmax: 1.85,
  ymax: 60.9,
};

export function busmapsApiKey() {
  return String(process.env.BUSMAPS_API_KEY || "").trim();
}

/** After Free-tier `endpoint_not_available`, pause BusMaps so we don't 403 every poll. */
let busmapsPlanBlockedUntil = 0;
let busmapsPlanBlockedLogged = false;

export function busmapsEnabled() {
  if (!busmapsApiKey()) return false;
  if (Date.now() < busmapsPlanBlockedUntil) return false;
  return true;
}

export function markBusmapsPlanBlocked(ms = 6 * 60 * 60 * 1000) {
  busmapsPlanBlockedUntil = Date.now() + Math.max(60_000, ms);
  if (!busmapsPlanBlockedLogged) {
    busmapsPlanBlockedLogged = true;
    console.warn(
      "[busmaps] live vehicle positions not on this plan (endpoint_not_available). Upgrade to BusMaps Pro, then restart. Falling back to bustimes.org for now.",
    );
  }
}

function capiKeyHeader(apiKey) {
  const raw = String(apiKey || "").trim();
  if (!raw) return "";
  return /^bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
}

/** Parse bustimes-style ?xmin=&ymin=&xmax=&ymax=&operator= into BusMaps params. */
export function parseVehiclesQuery(qs) {
  const raw = String(qs || "");
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
  const operator = String(params.get("operator") || "")
    .trim()
    .toUpperCase();
  const hasBbox =
    xmin != null && ymin != null && xmax != null && ymax != null && xmax > xmin && ymax > ymin;
  return {
    xmin: hasBbox ? xmin : null,
    ymin: hasBbox ? ymin : null,
    xmax: hasBbox ? xmax : null,
    ymax: hasBbox ? ymax : null,
    operator: operator || "",
    hasBbox,
  };
}

function boundingBoxParam({ xmin, ymin, xmax, ymax }) {
  // BusMaps: minLat,minLon,maxLat,maxLon
  return `${ymin},${xmin},${ymax},${xmax}`;
}

function stableNumericId(seed) {
  const s = String(seed || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0) || 1;
}

function nocFromVehicleId(vehicleId) {
  const id = String(vehicleId || "").trim();
  if (!id) return "";
  const m = id.match(/^([A-Za-z][A-Za-z0-9]{1,7})[-_]/);
  return m ? m[1].toUpperCase() : "";
}

function fleetLabel(vehicleId) {
  const id = String(vehicleId || "").trim();
  if (!id) return "";
  const m = id.match(/^[A-Za-z][A-Za-z0-9]{1,7}[-_](.+)$/);
  return m ? m[1].trim() : id;
}

/**
 * Map one BusMaps vehicle to the shape the map/fleet/trail code expects
 * (bustimes.org vehicles.json fields).
 */
export function mapBusmapsVehicleToBustimes(v) {
  if (!v || typeof v !== "object") return null;
  const lat = Number(v.lat);
  const lon = Number(v.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const vehicleId = String(v.vehicleId || "").trim();
  const routeShort = String(v.routeShortName || "").trim();
  const headsign = String(v.tripHeadsign || "").trim();
  const tripId = String(v.tripId || "").trim();
  const routeId = String(v.routeId || "").trim();
  const bearing = v.bearing == null || v.bearing === "" ? null : Number(v.bearing);
  const noc = nocFromVehicleId(vehicleId);
  const fleet = fleetLabel(vehicleId);
  const slug = vehicleId
    ? vehicleId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    : "";

  return {
    id: stableNumericId(vehicleId || `${lat},${lon},${tripId}`),
    journey_id: tripId || undefined,
    coordinates: [lon, lat],
    heading: Number.isFinite(bearing) ? bearing : null,
    datetime: v.timestamp || null,
    destination: headsign || undefined,
    trip_id: tripId || undefined,
    service_id: routeId || undefined,
    service: {
      line_name: routeShort || "?",
      ...(routeShort
        ? {
            url: `/services/${encodeURIComponent(
              String(v.urlRouteShortName || routeShort).toLowerCase(),
            )}`,
          }
        : {}),
    },
    vehicle: {
      name: fleet || vehicleId || "Bus",
      ...(slug ? { url: `/vehicles/${slug}` } : {}),
    },
    ...(noc
      ? {
          operator: { noc, id: noc, name: noc },
        }
      : {}),
    // Extras for debugging / merge — ignored by most UI paths.
    _source: "busmaps",
    _busmaps: {
      vehicleId: vehicleId || null,
      positionType: v.positionType || null,
      ageSeconds: v.ageSeconds ?? null,
      routeId: routeId || null,
      countryIso: v.countryIso || null,
      routeLongName: v.routeLongName || null,
      routeColor: v.routeColor || null,
    },
  };
}

export async function fetchBusmapsRawPositions(bbox, { apiKey = busmapsApiKey(), lang = "en" } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("busmaps_api_key_missing");
  if (!bbox || !Number.isFinite(bbox.xmin)) throw new Error("busmaps_bbox_required");

  const url = new URL(BUSMAPS_BASE);
  url.searchParams.set("boundingBox", boundingBoxParam(bbox));
  if (lang) url.searchParams.set("lang", lang);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": UA,
      "capi-key": capiKeyHeader(key),
      "capi-host": "busmaps.com",
    },
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const detail =
      (json && (json.message || json.error || json.detail)) ||
      text.slice(0, 200) ||
      response.statusText;
    if (response.status === 403 && /endpoint_not_available/i.test(String(detail))) {
      markBusmapsPlanBlocked();
    }
    const err = new Error(`busmaps_${response.status}:${detail}`);
    err.status = response.status;
    throw err;
  }

  const vehicles = Array.isArray(json?.vehicles) ? json.vehicles : [];
  return { vehicles, meta: json, status: response.status };
}

function matchesOperator(bus, noc) {
  const want = String(noc || "").trim().toUpperCase();
  if (!want) return true;
  const fromOp = String(bus?.operator?.noc || bus?.operator?.id || "")
    .trim()
    .toUpperCase();
  if (fromOp && fromOp === want) return true;
  const vid = String(bus?._busmaps?.vehicleId || "").toUpperCase();
  if (vid.startsWith(`${want}-`) || vid.startsWith(`${want}_`)) return true;
  // Soft match: vehicle id starts with NOC (e.g. FPOT123)
  if (vid.startsWith(want) && vid.length > want.length) {
    const next = vid.charAt(want.length);
    if (!/[A-Z]/.test(next)) return true;
  }
  return false;
}

/**
 * Fetch vehicles for a bustimes-compatible query string and return a JSON Buffer
 * (array of mapped vehicles) plus HTTP-ish status.
 */
export async function fetchBusmapsVehiclesJson(cacheKey, { apiKey = busmapsApiKey() } = {}) {
  const parsed = parseVehiclesQuery(cacheKey);
  const bbox = parsed.hasBbox
    ? {
        xmin: parsed.xmin,
        ymin: parsed.ymin,
        xmax: parsed.xmax,
        ymax: parsed.ymax,
      }
    : { ...BUSMAPS_UK_BBOX };

  const { vehicles } = await fetchBusmapsRawPositions(bbox, { apiKey });
  let mapped = vehicles.map(mapBusmapsVehicleToBustimes).filter(Boolean);
  if (parsed.operator) {
    mapped = mapped.filter((b) => matchesOperator(b, parsed.operator));
  }
  const body = Buffer.from(JSON.stringify(mapped), "utf8");
  return {
    status: 200,
    body,
    contentType: "application/json; charset=utf-8",
    count: mapped.length,
    source: "busmaps",
  };
}
