/** Continuously record live vehicle GPS into the 7-day trail store (no browser needed). */

import { appendTrailPoints, trailsEnabled, initTrailStore } from "./trail-store.mjs";

/** Staffordshire county bbox (matches fleet live map). */
const DEFAULT_BBOX = {
  xmin: -2.35,
  ymin: 52.55,
  xmax: -1.7,
  ymax: 53.15,
};

const AT_LINES = new Set(["AT1", "AT2", "AT3"]);
const SCFC_LINES = new Set(["B1", "B2", "BS1", "BS2"]);
/**
 * Nationwide coach operators — fetched by NOC (not limited to the Staffs bbox).
 * Local Staffs buses are covered by the bbox Bustimes/BODS poll instead.
 */
const COACH_OPERATOR_NOCS = ["FLIX", "NATX"];
const POLL_MS = 15_000;
const COACH_POLL_MS = 45_000;
const MIN_GAP_MS = 8_000;
const COACH_MIN_GAP_MS = 25_000;
const MIN_MOVE_M = 6;
const COACH_MIN_MOVE_M = 40;
const UA = "uk-bus-tracker/1.0 (+https://ukbustracker.up.railway.app; trail recorder)";
const DG_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json",
  identifier: "9865w159-a113-3mmg-as5k-7354d43sgd",
  "X-Requested-With": "XMLHttpRequest",
  Origin: "https://www.dgbus.co.uk",
  Referer: "https://www.dgbus.co.uk/",
};

const lastByKey = new Map();
/**
 * Sticky route identity per vehicle — keeps one continuous segment for a journey
 * A→B even when journey_id / trip_id blank out or flap mid-trip.
 */
const stickyRouteByVehicle = new Map();
let running = null;
let timer = null;

/** Same line with a gap longer than this starts a fresh run segment. */
const LINE_GAP_NEW_RUN_MS = 20 * 60_000;
/** Different non-empty journey id only counts as a new trip after this gap. */
const JOURNEY_ID_SWITCH_MS = 90_000;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

function compactReg(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function shouldKeep(key, lat, lng, t, { coach = false } = {}) {
  const prev = lastByKey.get(key);
  if (!prev) return true;
  const dt = t - prev.t;
  const minGap = coach ? COACH_MIN_GAP_MS : MIN_GAP_MS;
  const minMove = coach ? COACH_MIN_MOVE_M : MIN_MOVE_M;
  if (dt < minGap) return false;
  // Keep a sample at least every ~20s (local) / ~90s (coach) so stop-start still builds a trail.
  if (dt >= (coach ? 90_000 : 20_000)) return true;
  const moved = haversineMeters(prev.lat, prev.lng, lat, lng);
  if (moved < minMove) return false;
  return true;
}

function remember(key, lat, lng, t) {
  lastByKey.set(key, { lat, lng, t });
  if (lastByKey.size > 8_000) {
    const drop = lastByKey.keys().next().value;
    lastByKey.delete(drop);
  }
}

function normalizeDirection(raw) {
  const d = String(raw || "")
    .trim()
    .toLowerCase();
  if (!d) return "";
  if (/^(in|inbound|i|1)$/.test(d)) return "in";
  if (/^(out|outbound|o|0)$/.test(d)) return "out";
  return "";
}

function pointFromBus(bus) {
  const [lng, lat] = bus?.coordinates || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const t = bus.datetime ? new Date(bus.datetime).getTime() : Date.now();
  if (!Number.isFinite(t)) return null;
  const heading = Number(bus.heading);
  const line = String(bus.service?.line_name || bus._bods?.line || "").trim();
  const journeyId = String(bus.journey_id || bus._bods?.journeyRef || "").trim();
  const tripId = String(bus.trip_id || "").trim();
  const operator = String(
    bus._trailOperator || bus.operator?.noc || bus.operator?.id || bus._bods?.operator || "",
  )
    .trim()
    .toUpperCase();
  const direction = normalizeDirection(
    bus._direction || bus.direction || bus.directionRef || bus._bods?.directionRef || "",
  );
  return {
    t,
    lat,
    lng,
    heading: Number.isFinite(heading) ? heading : null,
    journeyId,
    tripId,
    line,
    operator,
    direction,
  };
}

function keysForBus(bus, point = null) {
  const keys = [];
  if (bus?.id != null && bus.id !== "") keys.push(String(bus.id));
  const namePlate = String(bus?.vehicle?.name || "")
    .toUpperCase()
    .match(/\b([A-Z]{2}\d{2}\s*[A-Z]{3})\b/) ||
    String(bus?.vehicle?.name || "")
      .toUpperCase()
      .match(/\b([A-Z]\d{1,3}\s*[A-Z]{3})\b/);
  const reg = compactReg(
    bus?.vehicle?.reg || (namePlate ? namePlate[1] : "") || bus?.vehicle?.name || bus?._bods?.vehicleRef || "",
  );
  if (/^[A-Z]{1,2}\d{1,2}[A-Z]{3}$/.test(reg) || /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(reg)) {
    keys.push(`reg:${reg}`);
  }
  const ref = String(bus?._bods?.vehicleRef || "").trim();
  const op = String(bus?._bods?.operator || bus?.operator?.noc || "").trim();
  if (ref && op) keys.push(`bods-${op}-${ref}`);
  else if (ref) keys.push(`bods-${ref}`);

  // Per-journey / per-route segment keys — one continuous key for the whole A→B stint.
  // Direction (in/out) keeps the return trip on a separate key from the outbound.
  const journeyId = String(point?.journeyId || bus?.journey_id || bus?._bods?.journeyRef || "").trim();
  const tripId = String(point?.tripId || bus?.trip_id || "").trim();
  const line = String(point?.line || bus?.service?.line_name || bus?._bods?.line || "")
    .trim()
    .toUpperCase();
  const direction = normalizeDirection(point?.direction || bus?._direction || "");
  const t = Number.isFinite(point?.t) ? point.t : Date.now();
  const runDay =
    String(point?._runDay || "").trim() || new Date(t).toISOString().slice(0, 10);
  const primary = keys[0] || (reg ? `reg:${reg}` : "");
  if (journeyId) keys.push(`jny:${journeyId}`);
  if (tripId) keys.push(`trip:${tripId}`);
  if (line && primary) {
    if (direction) {
      keys.push(`run:${primary}:${line}:${direction}:${runDay}`);
      if (AT_LINES.has(line)) keys.push(`at:${line}:${direction}:${primary}:${runDay}`);
    } else {
      // Legacy undirected keys (older clients / unknown direction).
      keys.push(`run:${primary}:${line}:${runDay}`);
      if (AT_LINES.has(line)) keys.push(`at:${line}:${primary}:${runDay}`);
    }
  }

  return [...new Set(keys.filter(Boolean))];
}

/**
 * Hold journey/line identity steady for the whole trip. Only open a new segment when
 * the line changes, direction flips (in↔out), a long gap passes, or a new journey id sticks.
 */
function stabilizeRoutePoint(primary, point) {
  if (!primary || !point) return { point, isNewSegment: false };
  const line = String(point.line || "").trim().toUpperCase();
  const rawJourney = String(point.journeyId || "").trim();
  const rawTrip = String(point.tripId || "").trim();
  const direction = normalizeDirection(point.direction);
  const prev = stickyRouteByVehicle.get(primary);
  const gap = prev?.lastT ? point.t - prev.lastT : Infinity;
  const lineChanged = Boolean(prev?.line && line && prev.line !== line);
  const directionChanged = Boolean(
    prev?.direction && direction && prev.direction !== direction,
  );
  const longGap = Boolean(prev && Number.isFinite(gap) && gap > LINE_GAP_NEW_RUN_MS);
  const journeySwitched = Boolean(
    prev?.journeyId &&
      rawJourney &&
      rawJourney !== prev.journeyId &&
      Number.isFinite(gap) &&
      gap > JOURNEY_ID_SWITCH_MS,
  );

  if (!prev || lineChanged || directionChanged || longGap || journeySwitched) {
    const next = {
      line: line || prev?.line || "",
      journeyId: rawJourney,
      tripId: rawTrip,
      direction: direction || (directionChanged ? direction : prev?.direction) || "",
      runDay: new Date(point.t).toISOString().slice(0, 10),
      since: point.t,
      lastT: point.t,
    };
    // Fresh run when direction flips — always stamp the new direction.
    if (directionChanged) next.direction = direction;
    stickyRouteByVehicle.set(primary, next);
    if (stickyRouteByVehicle.size > 8_000) {
      const drop = stickyRouteByVehicle.keys().next().value;
      stickyRouteByVehicle.delete(drop);
    }
    return {
      point: {
        ...point,
        line: next.line,
        journeyId: next.journeyId,
        tripId: next.tripId,
        direction: next.direction,
        _runDay: next.runDay,
      },
      isNewSegment: Boolean(prev),
    };
  }

  // Same stint — fill blanks, ignore flapping / empty journey ids.
  if (rawJourney && !prev.journeyId) prev.journeyId = rawJourney;
  if (rawTrip && !prev.tripId) prev.tripId = rawTrip;
  if (line && !prev.line) prev.line = line;
  if (direction && !prev.direction) prev.direction = direction;
  prev.lastT = point.t;
  stickyRouteByVehicle.set(primary, prev);
  return {
    point: {
      ...point,
      line: prev.line || line,
      journeyId: prev.journeyId || rawJourney,
      tripId: prev.tripId || rawTrip,
      direction: prev.direction || direction,
      _runDay: prev.runDay,
    },
    isNewSegment: false,
  };
}

function normalizeScfcLine(line) {
  const code = String(line || "").trim().toUpperCase();
  if (code === "B1" || code === "BS1") return "BS1";
  if (code === "B2" || code === "BS2") return "BS2";
  return "";
}

function isScfcBus(bus) {
  if (!bus) return false;
  const raw = String(bus.service?.line_name || bus._bods?.line || "").trim();
  if (normalizeScfcLine(raw) || SCFC_LINES.has(raw.toUpperCase())) return true;
  const hay = `${bus.destination || ""} ${bus.origin || ""} ${bus.service?.url || ""}`;
  if (!/bet365|stoke city|scfc|britannia stadium|football shuttle/i.test(hay)) return false;
  const op = `${bus.operator?.noc || ""} ${bus.operator?.name || ""} ${bus.service?.operator?.name || ""} ${bus._bods?.operator || ""}`;
  return /FPOT|First Potteries|first-potteries/i.test(op);
}

/** Force BS1/BS2 on the point so /api/trails/keys?lines=… can find matchday tails. */
function withCanonicalScfcLine(bus) {
  if (!isScfcBus(bus)) return bus;
  const line = normalizeScfcLine(bus.service?.line_name || bus._bods?.line) || "BS1";
  return {
    ...bus,
    service: { ...(bus.service || {}), line_name: line },
  };
}

function pickScfcBuses(buses) {
  return (buses || []).filter(isScfcBus).map(withCanonicalScfcLine);
}

async function fetchBustimesVehicles(bbox) {
  const url = new URL("https://bustimes.org/vehicles.json");
  url.searchParams.set("xmin", String(bbox.xmin));
  url.searchParams.set("ymin", String(bbox.ymin));
  url.searchParams.set("xmax", String(bbox.xmax));
  url.searchParams.set("ymax", String(bbox.ymax));
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`bustimes ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchOperatorVehicles(noc) {
  const url = new URL("https://bustimes.org/vehicles.json");
  url.searchParams.set("operator", String(noc || "").trim().toUpperCase());
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${noc} ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function tagOperator(buses, noc) {
  const code = String(noc || "").trim().toUpperCase();
  return (buses || []).map((bus) => ({
    ...bus,
    _trailOperator: code,
    operator: { ...(bus.operator || {}), noc: code, id: bus.operator?.id || code },
  }));
}

async function fetchBodsVehicles(bbox, apiKey) {
  if (!apiKey) return [];
  const { parseSiriVehicles, siriItemToBus } = await import("./bods-occupancy.js");
  const box = `${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}`;
  const url = new URL("https://data.bus-data.dft.gov.uk/api/v1/datafeed/");
  url.searchParams.set("boundingBox", box);
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/xml", "x-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`bods ${res.status}`);
  const xml = await res.text();
  return (parseSiriVehicles(xml) || []).map(siriItemToBus).filter(Boolean);
}

/** D&G / NextStop realtime — Alton Towers staff AT1–AT3 (always recorded). */
async function fetchDgAtVehicles() {
  const url = new URL("https://api-v3.nextstopapp.co.uk/api/v1/buses/realtime");
  url.searchParams.set("regionId", "526");
  url.searchParams.set("showBusesNotInService", "true");
  const res = await fetch(url, { headers: DG_HEADERS });
  if (!res.ok) throw new Error(`dg ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  const out = [];
  for (const item of items) {
    const line = String(item?.currentJourney?.publishedLineName || "").trim().toUpperCase();
    if (!AT_LINES.has(line)) continue;
    const lat = Number(item?.positioning?.latitude);
    const lng = Number(item?.positioning?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const ref = String(item?.vehicle?.ref || item?.vehicle?.vehicleUniqueId || "").trim();
    if (!ref) continue;
    const t = item?.recordedAtTime ? new Date(item.recordedAtTime).getTime() : Date.now();
    if (!Number.isFinite(t)) continue;
    const heading = Number(item?.positioning?.bearing);
    const reg = compactReg(ref);
    const journeyId = String(item?.currentJourney?.id || item?.currentJourney?.journeyId || "").trim();
    const direction = String(item?.currentJourney?.directionRef || "").trim();
    const bus = {
      id: `staff-${ref}`,
      coordinates: [lng, lat],
      datetime: new Date(t).toISOString(),
      heading: Number.isFinite(heading) ? heading : null,
      journey_id: journeyId,
      trip_id: "",
      destination: String(item?.currentJourney?.destination?.name || "").trim(),
      service: { line_name: line },
      vehicle: { reg: /^[A-Z]{1,2}\d{1,2}[A-Z]{3}$/.test(reg) ? reg : "", name: ref },
      _trailOperator: "DAGC",
      _direction: direction,
      operator: { noc: "DAGC", id: "DAGC", name: "D & G Bus" },
    };
    out.push(bus);
  }
  return out;
}

function pickAtBuses(buses) {
  return (buses || []).filter((bus) =>
    AT_LINES.has(String(bus?.service?.line_name || bus?._bods?.line || "").trim().toUpperCase()),
  );
}

function withCanonicalAtLine(bus) {
  const line = String(bus?.service?.line_name || bus?._bods?.line || "")
    .trim()
    .toUpperCase();
  if (!AT_LINES.has(line)) return bus;
  return {
    ...bus,
    _trailOperator: bus._trailOperator || "DAGC",
    service: { ...(bus.service || {}), line_name: line },
    operator: {
      ...(bus.operator || {}),
      noc: bus.operator?.noc || "DAGC",
      id: bus.operator?.id || "DAGC",
    },
  };
}

async function recordBuses(buses, { coach = false } = {}) {
  let written = 0;
  const byKey = new Map();
  for (const bus of buses) {
    const rawPoint = pointFromBus(bus);
    if (!rawPoint) continue;
    const baseKeysPreview = keysForBus(bus, rawPoint).filter(
      (key) =>
        !String(key).startsWith("jny:") &&
        !String(key).startsWith("trip:") &&
        !String(key).startsWith("run:") &&
        !String(key).startsWith("at:"),
    );
    const primary = baseKeysPreview[0] || "";
    const { point, isNewSegment } = stabilizeRoutePoint(primary, rawPoint);
    const allKeys = keysForBus(bus, point);
    if (isNewSegment) {
      // New A→B stint only — clear throttle so the first point of the new run is kept.
      // Do not clear on journey_id blankouts mid-trip.
      for (const key of allKeys) lastByKey.delete(key);
    }
    for (const key of allKeys) {
      if (!shouldKeep(key, point.lat, point.lng, point.t, { coach })) continue;
      remember(key, point.lat, point.lng, point.t);
      const list = byKey.get(key) || [];
      list.push(point);
      byKey.set(key, list);
    }
  }
  for (const [key, points] of byKey) {
    const result = await appendTrailPoints(key, points);
    if (result.ok) written += result.inserted || 0;
  }
  return written;
}

async function recordCoachOperators() {
  let written = 0;
  const counts = {};
  const errors = [];
  for (let i = 0; i < COACH_OPERATOR_NOCS.length; i += 4) {
    const chunk = COACH_OPERATOR_NOCS.slice(i, i + 4);
    const rows = await Promise.all(
      chunk.map(async (noc) => {
        try {
          const buses = tagOperator(await fetchOperatorVehicles(noc), noc);
          return { noc, buses };
        } catch (error) {
          return { noc, error };
        }
      }),
    );
    for (const row of rows) {
      if (row.error) {
        errors.push(`${row.noc}: ${row.error.message || row.error}`);
        continue;
      }
      counts[row.noc] = row.buses.length;
      if (row.buses.length) written += await recordBuses(row.buses, { coach: true });
    }
  }
  return { written, counts, errors };
}

async function pollOnce({ bbox, bodsKey }) {
  await initTrailStore();
  if (!trailsEnabled()) return { ok: false, reason: "no-db" };
  const result = {
    ok: true,
    bustimes: 0,
    bods: 0,
    dg: 0,
    at: 0,
    operators: {},
    scfc: 0,
    written: 0,
    errors: [],
  };
  const scfcPool = [];
  const atPool = [];

  try {
    const buses = await fetchBustimesVehicles(bbox);
    result.bustimes = buses.length;
    result.written += await recordBuses(buses);
    scfcPool.push(...buses);
    atPool.push(...buses);
  } catch (error) {
    result.errors.push(`bustimes: ${error.message || error}`);
  }
  if (bodsKey) {
    try {
      const buses = await fetchBodsVehicles(bbox, bodsKey);
      result.bods = buses.length;
      result.written += await recordBuses(buses);
      scfcPool.push(...buses);
      atPool.push(...buses);
    } catch (error) {
      result.errors.push(`bods: ${error.message || error}`);
    }
  }
  try {
    const buses = await fetchDgAtVehicles();
    result.dg = buses.length;
    result.written += await recordBuses(buses);
    atPool.push(...buses);
  } catch (error) {
    result.errors.push(`dg: ${error.message || error}`);
  }

  try {
    const ops = await recordCoachOperators();
    result.operators = ops.counts;
    result.written += ops.written;
    if (ops.errors.length) result.errors.push(...ops.errors);
  } catch (error) {
    result.errors.push(`operators: ${error.message || error}`);
  }

  // Dedicated AT1–AT3 pass — canonical line tags; sticky route keeps each A→B stint continuous.
  try {
    const at = pickAtBuses(atPool).map(withCanonicalAtLine);
    result.at = at.length;
    if (at.length) result.written += await recordBuses(at);
  } catch (error) {
    result.errors.push(`at: ${error.message || error}`);
  }

  // Dedicated B1/B2 pass with canonical BS1/BS2 line tags for multi-tail lookup.
  try {
    const scfc = pickScfcBuses(scfcPool);
    result.scfc = scfc.length;
    if (scfc.length) result.written += await recordBuses(scfc);
  } catch (error) {
    result.errors.push(`scfc: ${error.message || error}`);
  }

  return result;
}

export function startTrailRecorder({
  intervalMs = POLL_MS,
  bbox = DEFAULT_BBOX,
  bodsKey = process.env.BODS_API_KEY || "",
} = {}) {
  if (timer) return;
  const run = () => {
    if (running) return;
    running = pollOnce({ bbox, bodsKey })
      .then((result) => {
        if (result.written || result.errors?.length) {
          const opBits = Object.entries(result.operators || {})
            .filter(([, n]) => n > 0)
            .map(([noc, n]) => `${noc}:${n}`)
            .join(",");
          console.log(
            `[trails] record bt=${result.bustimes || 0} bods=${result.bods || 0} dg=${result.dg || 0} at=${result.at || 0} scfc=${result.scfc || 0}` +
              (opBits ? ` ops=${opBits}` : "") +
              ` wrote=${result.written || 0}` +
              (result.errors?.length ? ` errors=${result.errors.join("; ")}` : ""),
          );
        }
      })
      .catch((error) => {
        console.warn("[trails] record failed", error?.message || error);
      })
      .finally(() => {
        running = null;
      });
  };
  setTimeout(run, 12_000);
  timer = setInterval(run, intervalMs);
  console.log(
    `[trails] recorder started every ${Math.round(intervalMs / 1000)}s bbox=${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}`,
  );
}
