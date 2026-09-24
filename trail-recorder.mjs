/** Continuously record live vehicle GPS into the 7-day trail store (no browser needed). */

import { appendTrailPoints, trailsEnabled, initTrailStore } from "./trail-store.mjs";

/** Staffordshire county bbox — xmax pushed east so Alton Towers (AT1–AT3) stays inside. */
const DEFAULT_BBOX = {
  xmin: -2.35,
  ymin: 52.55,
  xmax: -1.55,
  ymax: 53.15,
};

const AT_LINES = new Set(["AT1", "AT2", "AT3"]);
/** Canonical AT headsigns when NextStop omits destination.name. */
const AT_DEST_BY_LINE = {
  AT1: { out: "Alton Towers", in: "Fenton" },
  AT2: { out: "Alton Towers", in: "Fenton" },
  AT3: { out: "Alton Towers", in: "Bentilee" },
};
const SCFC_LINES = new Set(["B1", "B2", "BS1", "BS2"]);
/**
 * Nationwide coach operators — fetched by NOC (not limited to the Staffs bbox).
 * Local Staffs buses are also fetched by NOC so operator tags stay on trail points.
 */
const COACH_OPERATOR_NOCS = ["FLIX", "NATX"];
const STAFFS_OPERATOR_NOCS = ["FPOT", "DAGC", "SOST", "CRDR", "SLBS", "BANG", "HIPK", "TBTN", "DIAM", "MDCL"];
const POLL_MS = 15_000;
const COACH_POLL_MS = 45_000;
/** Nationwide operator feeds do not need the local 15-second cadence. */
const OPERATOR_POLL_MS = COACH_POLL_MS;
let lastOperatorPollAt = 0;
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
const LINE_GAP_NEW_RUN_MS = 25 * 60_000;
/** Coach intermediate stops (Hanley, airports, …) often sit 20–60+ minutes — keep A→B continuous. */
const COACH_LINE_GAP_NEW_RUN_MS = 90 * 60_000;
/** Different non-empty journey id only counts as a new trip after a real layover (not a stop dwell). */
const JOURNEY_ID_SWITCH_MS = 8 * 60_000;
/** Flix/NATX often mint a new journey id after an intermediate stop — do not split for that alone. */
const COACH_JOURNEY_ID_SWITCH_MS = 90 * 60_000;
/** Match the same anonymous coach across journey-id changes by last GPS (metres / ms). */
const COACH_STICKY_MATCH_M = 12_000;
const COACH_STICKY_MATCH_MS = 90 * 60_000;

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

function shouldKeep(key, lat, lng, t, { coach = false, at = false } = {}) {
  const prev = lastByKey.get(key);
  if (!prev) return true;
  const dt = t - prev.t;
  const minGap = coach ? COACH_MIN_GAP_MS : at ? 5_000 : MIN_GAP_MS;
  const minMove = coach ? COACH_MIN_MOVE_M : at ? 3 : MIN_MOVE_M;
  if (dt < minGap) return false;
  // Keep a sample at least every ~20s (local) / ~90s (coach) so stop-start still builds a trail.
  // AT employee AVL is sparse — force a keep every 15s even when barely moving.
  if (dt >= (coach ? 90_000 : at ? 15_000 : 20_000)) return true;
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

/** UK calendar day for segment keys (matches client ukDateKey / fleet replay). */
function ukDateKey(ms = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function atDestinationFor(line, direction = "", fallback = "") {
  const code = String(line || "").trim().toUpperCase();
  const dir = normalizeDirection(direction);
  const meta = AT_DEST_BY_LINE[code];
  if (!meta) return String(fallback || "").trim();
  if (dir === "in") return meta.in;
  if (dir === "out") return meta.out;
  return String(fallback || meta.out || "").trim();
}

function pointFromBus(bus) {
  const [lng, lat] = bus?.coordinates || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const t = bus.datetime ? new Date(bus.datetime).getTime() : Date.now();
  if (!Number.isFinite(t)) return null;
  const heading = Number(bus.heading);
  const line = String(bus.service?.line_name || bus._bods?.line || "").trim();
  const tripId = String(bus.trip_id || "").trim();
  const operator = String(
    bus._trailOperator || bus.operator?.noc || bus.operator?.id || bus._bods?.operator || "",
  )
    .trim()
    .toUpperCase();
  const isCoach = COACH_OPERATOR_NOCS.includes(operator);
  // Flix AVL often uses the journey id as bus.id with a blank journey_id field.
  let journeyId = String(bus.journey_id || bus._bods?.journeyRef || "").trim();
  if (
    !journeyId &&
    isCoach &&
    operator === "FLIX" &&
    bus.id != null &&
    bus.id !== "" &&
    !bus.vehicle?.id
  ) {
    journeyId = String(bus.id).trim();
  }
  const direction = normalizeDirection(
    bus._direction || bus.direction || bus.directionRef || bus._bods?.directionRef || "",
  );
  let destination = String(bus.destination || "").trim();
  if (!destination && AT_LINES.has(String(line || "").trim().toUpperCase())) {
    destination = atDestinationFor(line, direction);
  }
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
    destination,
  };
}

function keysForBus(bus, point = null) {
  // Store one canonical vehicle key per physical sample. Journey/trip metadata
  // remains on each point, so replay grouping does not need duplicate jny/trip/run
  // rows. AT1–AT3 keep their directed segment key because Fleet uses it to list
  // individual staff-bus journeys.
  const keys = [];
  const sticky = String(point?._stickyPrimary || "").trim();
  const namePlate = String(bus?.vehicle?.name || "")
    .toUpperCase()
    .match(/\b([A-Z]{2}\d{2}\s*[A-Z]{3})\b/) ||
    String(bus?.vehicle?.name || "")
      .toUpperCase()
      .match(/\b([A-Z]\d{1,3}\s*[A-Z]{3})\b/);
  const reg = compactReg(
    bus?.vehicle?.reg || (namePlate ? namePlate[1] : "") || bus?._bods?.vehicleRef || "",
  );
  const hasPlate = /^[A-Z]{1,2}\d{1,2}[A-Z]{3}$/.test(reg) || /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(reg);
  const busId = String(bus?.id ?? "").trim();
  const operator = String(point?.operator || bus?._trailOperator || bus?.operator?.noc || bus?._bods?.operator || "")
    .trim()
    .toUpperCase();
  const line = String(point?.line || bus?.service?.line_name || bus?._bods?.line || "")
    .trim()
    .toUpperCase();
  const direction = normalizeDirection(point?.direction || bus?._direction || "");
  const t = Number.isFinite(point?.t) ? point.t : Date.now();
  const runDay = String(point?._runDay || "").trim() || ukDateKey(t);
  const primary = sticky || (hasPlate ? `reg:${reg}` : busId);
  if (primary) keys.push(primary);

  // Anonymous coaches use the sticky coach key; plate-backed vehicles use reg:*
  // as their canonical key so Fleet can find them without guessing BODS refs.
  if (COACH_OPERATOR_NOCS.includes(operator) && !hasPlate && !primary.startsWith("coach:")) {
    const seed = String(point?.journeyId || bus?.journey_id || busId || reg || `${point?.lat},${point?.lng}`).trim();
    if (seed) keys.push(`coach:${seed}`);
  }

  if (AT_LINES.has(line) && primary) {
    keys.push(
      direction
        ? `at:${line}:${direction}:${primary}:${runDay}`
        : `at:${line}:${primary}:${runDay}`,
    );
  }

  return [...new Set(keys.filter(Boolean))];
}

/**
 * Hold journey/line identity steady for the whole trip (including dwells at intermediate stops).
 * Only open a new segment when the line changes, direction flips (in↔out), a long gap passes,
 * or a new journey id sticks after a real layover — not when the headsign/next-stop text flaps.
 * Coaches (Flix/NATX): much longer dwell / journey-id tolerance so Hanley-style stops stay one run.
 */
function stabilizeRoutePoint(primary, point, { coach = false } = {}) {
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
  const rawDest = String(point.destination || "").trim();
  // Dwells at intermediate stops often change "destination"/headsign for 1–3 minutes —
  // never treat that alone as a new run while line + direction stay the same.
  const gapLimit = coach ? COACH_LINE_GAP_NEW_RUN_MS : LINE_GAP_NEW_RUN_MS;
  const journeySwitchMs = coach ? COACH_JOURNEY_ID_SWITCH_MS : JOURNEY_ID_SWITCH_MS;
  const longGap = Boolean(prev && Number.isFinite(gap) && gap > gapLimit);
  // Journey-id flap at a stop is common; coaches get a new id after many intermediate stops.
  const journeySwitched = Boolean(
    prev?.journeyId &&
      rawJourney &&
      rawJourney !== prev.journeyId &&
      Number.isFinite(gap) &&
      gap > journeySwitchMs,
  );

  if (!prev || lineChanged || directionChanged || longGap || journeySwitched) {
    const next = {
      line: line || prev?.line || "",
      journeyId: rawJourney,
      tripId: rawTrip,
      direction: direction || (directionChanged ? direction : prev?.direction) || "",
      destination: rawDest || prev?.destination || "",
      runDay: ukDateKey(point.t),
      since: point.t,
      lastT: point.t,
      lastLat: point.lat,
      lastLng: point.lng,
      operator: String(point.operator || "").trim().toUpperCase(),
      coach: Boolean(coach),
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
        destination: next.destination || point.destination || "",
        _runDay: next.runDay,
        _stickyPrimary: primary,
      },
      isNewSegment: Boolean(prev),
      stickyPrimary: primary,
    };
  }

  // Same stint — fill blanks, ignore flapping / empty journey ids.
  // Keep the first final destination for the run; still adopt a clearer headsign if we had none.
  // Coaches: keep the original journey id for the continuous A→B key; still note the latest id.
  if (rawJourney && !prev.journeyId) prev.journeyId = rawJourney;
  if (rawTrip && !prev.tripId) prev.tripId = rawTrip;
  if (line && !prev.line) prev.line = line;
  if (direction && !prev.direction) prev.direction = direction;
  if (rawDest && !prev.destination) prev.destination = rawDest;
  if (coach && rawJourney) prev.latestJourneyId = rawJourney;
  prev.lastT = point.t;
  prev.lastLat = point.lat;
  prev.lastLng = point.lng;
  stickyRouteByVehicle.set(primary, prev);
  return {
    point: {
      ...point,
      line: prev.line || line,
      // Prefer the sticky journey id so jny:/run: keys stay continuous through intermediate stops.
      journeyId: prev.journeyId || rawJourney,
      tripId: prev.tripId || rawTrip,
      direction: prev.direction || direction,
      destination: prev.destination || rawDest || point.destination || "",
      _runDay: prev.runDay,
      _stickyPrimary: primary,
      _latestJourneyId: prev.latestJourneyId || rawJourney || "",
    },
    isNewSegment: false,
    stickyPrimary: primary,
  };
}

/** Stable trail primary for coaches — survive Flix journey-id changes after Hanley-style stops. */
function coachStickyPrimary(bus, point) {
  const namePlate =
    String(bus?.vehicle?.name || "")
      .toUpperCase()
      .match(/\b([A-Z]{2}\d{2}\s*[A-Z]{3})\b/) ||
    String(bus?.vehicle?.name || "")
      .toUpperCase()
      .match(/\b([A-Z]\d{1,3}\s*[A-Z]{3})\b/);
  const reg = compactReg(
    bus?.vehicle?.reg || (namePlate ? namePlate[1] : "") || bus?.vehicle?.name || bus?._bods?.vehicleRef || "",
  );
  if (/^[A-Z]{1,2}\d{1,2}[A-Z]{3}$/.test(reg) || /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(reg)) {
    return `reg:${reg}`;
  }
  const line = String(point?.line || "").trim().toUpperCase();
  const op = String(point?.operator || "").trim().toUpperCase();
  let best = null;
  for (const [key, prev] of stickyRouteByVehicle.entries()) {
    if (!prev?.coach) continue;
    if (!String(key).startsWith("coach:")) continue;
    if (prev.line && line && prev.line !== line) continue;
    if (prev.operator && op && prev.operator !== op) continue;
    const gap = Number(point.t) - Number(prev.lastT || 0);
    if (!Number.isFinite(gap) || gap < 0 || gap > COACH_STICKY_MATCH_MS) continue;
    if (!Number.isFinite(prev.lastLat) || !Number.isFinite(prev.lastLng)) continue;
    const dist = haversineMeters(prev.lastLat, prev.lastLng, point.lat, point.lng);
    if (dist > COACH_STICKY_MATCH_M) continue;
    if (!best || dist < best.dist || (dist === best.dist && gap < best.gap)) {
      best = { key, dist, gap };
    }
  }
  if (best) return best.key;
  const seed = String(point?.journeyId || bus?.journey_id || bus?.id || "").trim() || `${point.lat},${point.lng}`;
  return `coach:${seed}`;
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

async function bustimesVehiclesUrl(searchParams) {
  // Bustimes.org live AVL — used only to record tails / journey history GPS.
  const upstream = new URL("https://bustimes.org/vehicles.json");
  for (const [k, v] of Object.entries(searchParams)) {
    if (v == null || v === "") continue;
    upstream.searchParams.set(k, String(v));
  }
  const res = await fetch(upstream, {
    headers: {
      "User-Agent": "uk-bus-tracker/1.0 (trail recorder)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`bustimes vehicles ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchBustimesVehicles(bbox) {
  return bustimesVehiclesUrl({
    xmin: bbox.xmin,
    ymin: bbox.ymin,
    xmax: bbox.xmax,
    ymax: bbox.ymax,
  });
}

async function fetchOperatorVehicles(noc) {
  return bustimesVehiclesUrl({
    operator: String(noc || "").trim().toUpperCase(),
  });
}

function tagOperator(buses, noc) {
  const code = String(noc || "").trim().toUpperCase();
  return (buses || []).map((bus) => ({
    ...bus,
    _trailOperator: code,
    operator: { ...(bus.operator || {}), noc: code, id: bus.operator?.id || code },
  }));
}

async function fetchBodsVehicles(bbox, apiKey, { operatorRef = "" } = {}) {
  if (!apiKey) return [];
  const { parseSiriVehicles, siriItemToBus } = await import("./bods-occupancy.js");
  const url = new URL("https://data.bus-data.dft.gov.uk/api/v1/datafeed/");
  if (bbox && Number.isFinite(bbox.xmin)) {
    url.searchParams.set(
      "boundingBox",
      `${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}`,
    );
  }
  if (operatorRef) url.searchParams.set("operatorRef", String(operatorRef).toUpperCase());
  url.searchParams.set("api_key", apiKey);
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*" },
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
    const destName = String(item?.currentJourney?.destination?.name || "").trim();
    const bus = {
      id: `staff-${ref}`,
      coordinates: [lng, lat],
      datetime: new Date(t).toISOString(),
      heading: Number.isFinite(heading) ? heading : null,
      journey_id: journeyId,
      trip_id: "",
      destination: destName || atDestinationFor(line, direction),
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
        !String(key).startsWith("at:") &&
        !String(key).startsWith("coach:"),
    );
    let primary = baseKeysPreview[0] || "";
    if (coach) {
      primary = coachStickyPrimary(bus, rawPoint) || primary;
    }
    if (!primary) primary = String(bus?.id || rawPoint.journeyId || "").trim();
    const { point, isNewSegment } = stabilizeRoutePoint(primary, rawPoint, { coach });
    const allKeys = keysForBus(bus, point);
    const isAt = AT_LINES.has(String(point.line || "").trim().toUpperCase());
    if (isNewSegment) {
      // New A→B stint only — clear throttle so the first point of the new run is kept.
      // Do not clear on journey_id blankouts mid-trip.
      for (const key of allKeys) lastByKey.delete(key);
    }
    for (const key of allKeys) {
      if (!shouldKeep(key, point.lat, point.lng, point.t, { coach, at: isAt })) continue;
      remember(key, point.lat, point.lng, point.t);
      const list = byKey.get(key) || [];
      list.push(point);
      byKey.set(key, list);
    }
  }
  let n = 0;
  for (const [key, points] of byKey) {
    const result = await appendTrailPoints(key, points);
    if (result.ok) written += result.inserted || 0;
    // Yield every few keys so map/API HTTP is not frozen during Staffs trail writes.
    n += 1;
    if (n % 4 === 0) await new Promise((r) => setImmediate(r));
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

async function recordStaffsOperators() {
  let written = 0;
  const counts = {};
  const errors = [];
  for (let i = 0; i < STAFFS_OPERATOR_NOCS.length; i += 4) {
    const chunk = STAFFS_OPERATOR_NOCS.slice(i, i + 4);
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
      if (row.buses.length) written += await recordBuses(row.buses, { coach: false });
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
  const operatorPollDue = Date.now() - lastOperatorPollAt >= OPERATOR_POLL_MS;
  if (operatorPollDue) lastOperatorPollAt = Date.now();

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
    // Operator-wide FPOT / DAGC (Ticketer) so OOS / finished trips outside the Staffs bbox still record.
    try {
      const fpot = await fetchBodsVehicles(null, bodsKey, { operatorRef: "FPOT" });
      result.bodsFpot = fpot.length;
      if (fpot.length) {
        result.written += await recordBuses(fpot);
        scfcPool.push(...fpot);
      }
    } catch (error) {
      result.errors.push(`bods-fpot: ${error.message || error}`);
    }
    try {
      const dagc = await fetchBodsVehicles(null, bodsKey, { operatorRef: "DAGC" });
      result.bodsDagc = dagc.length;
      if (dagc.length) {
        result.written += await recordBuses(dagc);
        atPool.push(...dagc);
      }
    } catch (error) {
      result.errors.push(`bods-dagc: ${error.message || error}`);
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

  if (operatorPollDue) {
    try {
      const ops = await recordCoachOperators();
      result.operators = ops.counts;
      result.written += ops.written;
      if (ops.errors.length) result.errors.push(...ops.errors);
    } catch (error) {
      result.errors.push(`operators: ${error.message || error}`);
    }

    // Tag Staffs locals by NOC so trails keep FPOT/DAGC/… even when bbox AVL omits operator.
    try {
      const staffs = await recordStaffsOperators();
      result.operators = { ...(result.operators || {}), ...(staffs.counts || {}) };
      result.written += staffs.written || 0;
      if (staffs.errors?.length) result.errors.push(...staffs.errors);
    } catch (error) {
      result.errors.push(`staffs-ops: ${error.message || error}`);
    }
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
            `[trails] record bt=${result.bustimes || 0} bods=${result.bods || 0} fpot=${result.bodsFpot || 0} dg=${result.dg || 0} at=${result.at || 0} scfc=${result.scfc || 0}` +
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
  // First poll delayed so cold refresh paints before Staffs trail writes contend for the event loop.
  setTimeout(run, 20_000);
  timer = setInterval(run, intervalMs);
  console.log(
    `[trails] recorder started every ${Math.round(intervalMs / 1000)}s bbox=${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}`,
  );
}
