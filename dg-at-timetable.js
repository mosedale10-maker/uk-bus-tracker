/**
 * AT1–AT3 employee timetables from the D&G Bus / NextStop app feed
 * (same source as portal.dgbus.co.uk timetable boards).
 */

const UA = "uk-bus-tracker/1.0 (D&G AT timetable)";
const DG_HEADERS = {
  identifier: "9865w159-a113-3mmg-as5k-7354d43sgd",
  "X-Requested-With": "XMLHttpRequest",
  Origin: "https://www.dgbus.co.uk",
  Referer: "https://www.dgbus.co.uk/",
  Accept: "application/json",
  "User-Agent": UA,
};
const AT_LINES = new Set(["AT1", "AT2", "AT3"]);
const CACHE_TTL_MS = 15 * 60_000;

let cache = { at: 0, byLine: new Map() };

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function pad(n) {
  return String(Number(n) || 0).padStart(2, "0");
}

function clockFromSecs(secs) {
  const s = ((Number(secs) % 86400) + 86400) % 86400;
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}`;
}

function departureClock(dep) {
  const t = dep?.departureTime || {};
  if (!Number.isFinite(Number(t.hour)) || !Number.isFinite(Number(t.minute))) return "";
  return `${pad(t.hour)}:${pad(t.minute)}`;
}

function weekdayName(dateStr) {
  const day = String(dateStr || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
  })
    .format(new Date(`${day}T12:00:00`))
    .toLowerCase();
}

function stopLabel(stop) {
  if (!stop || typeof stop !== "object") return "";
  return String(stop.name || stop.commonName || stop.common_name || stop.atcoCode || stop.id || "").trim();
}

function buildStopTimes(dep, journey, stopMap) {
  const start = departureClock(dep);
  if (!start || !journey) return [];
  let secs =
    Number(dep.departureTime.hour) * 3600 +
    Number(dep.departureTime.minute) * 60 +
    (Number(dep.departureTime.second) || 0);
  const times = [];
  for (const it of journey.items || []) {
    const atco = String(it.from?.id || "").trim();
    const stop = stopMap.get(atco) || {};
    times.push({
      aimed_departure_time: clockFromSecs(secs),
      stop: {
        name: stopLabel(stop) || atco,
        atco_code: atco,
      },
    });
    const timing = Number(it.timing) || 0;
    const unit = String(it.timingUnit || "seconds").toLowerCase();
    secs += unit.startsWith("min") ? timing * 60 : timing;
    const wait = Number(it.waitTime) || 0;
    const waitUnit = String(it.waitTimeUnit || "seconds").toLowerCase();
    secs += waitUnit.startsWith("min") ? wait * 60 : wait;
  }
  return times;
}

async function loadAtServices() {
  if (cache.byLine.size && Date.now() - cache.at < CACHE_TTL_MS) return cache.byLine;
  const url =
    "https://api-v3.nextstopapp.co.uk/api/v1/region/526/services?includeJourneys=true";
  const res = await fetch(url, { headers: DG_HEADERS });
  if (!res.ok) throw new Error(`D&G services upstream ${res.status}`);
  const data = await res.json();
  const byLine = new Map();
  for (const wrap of data?.objects || []) {
    const service = wrap?.service || wrap;
    const line = String(service?.lineName || "").trim().toUpperCase();
    if (!AT_LINES.has(line)) continue;
    byLine.set(line, {
      service,
      journeys: Array.isArray(wrap.journeys) ? wrap.journeys : [],
      stops: Array.isArray(wrap.stops) ? wrap.stops : [],
    });
  }
  cache = { at: Date.now(), byLine };
  return byLine;
}

export function buildAtTimetableTrips(pack, { date = "", allDays = false } = {}) {
  if (!pack?.service) return [];
  const service = pack.service;
  const journeys = pack.journeys || [];
  const stopMap = new Map();
  for (const stop of pack.stops || []) {
    const id = String(stop.id || stop.atcoCode || stop.atco || "").trim();
    if (id) stopMap.set(id, stop);
  }
  const byJourney = new Map(journeys.map((j) => [String(j.id), j]));
  const weekday = allDays ? "" : weekdayName(date);
  const trips = [];
  for (const dep of service.departures || []) {
    const days = (dep.days || []).map((d) => String(d || "").toLowerCase());
    if (weekday && !days.includes(weekday)) continue;
    const start = departureClock(dep);
    if (!start) continue;
    const journey = byJourney.get(String(dep.journey));
    const headsign =
      String(dep.extensions?.destinationDisplay || service.destination || "Service").trim() ||
      "Service";
    const times = buildStopTimes(dep, journey, stopMap);
    trips.push({
      id: `at-${service.lineName}-${dep.id || `${start}-${dep.journey}`}`,
      start,
      headsign,
      times,
      days,
      journeyId: dep.journey || "",
      source: "D&G Bus",
    });
  }
  trips.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return trips;
}

export async function fetchAtTimetable({ line, date = "", allDays = false } = {}) {
  const code = String(line || "").trim().toUpperCase();
  if (!AT_LINES.has(code)) {
    return { ok: false, error: "bad_line", line: code, trips: [] };
  }
  const byLine = await loadAtServices();
  const pack = byLine.get(code);
  if (!pack) {
    return { ok: false, error: "not_found", line: code, trips: [] };
  }
  const trips = buildAtTimetableTrips(pack, { date, allDays });
  return {
    ok: true,
    line: code,
    date: date || null,
    allDays: Boolean(allDays),
    origin: pack.service.origin || "",
    destination: pack.service.destination || "",
    via: pack.service.via || [],
    pdf: pack.service.timetablePdf || "",
    trips,
    source: "D&G Bus app (NextStop)",
  };
}

export async function handleDgAtTimetable(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const line = url.searchParams.get("line") || url.searchParams.get("service") || "";
  const date = url.searchParams.get("date") || "";
  const allDays = /^(1|true|yes|all)$/i.test(url.searchParams.get("all") || "");
  try {
    const data = await fetchAtTimetable({ line, date, allDays });
    if (!data.ok && data.error === "bad_line") {
      json(res, 400, data);
      return;
    }
    json(res, 200, data);
  } catch {
    json(res, 502, { ok: false, error: "dg_upstream", trips: [] });
  }
}

export function dgAtTimetablePlugin() {
  return {
    name: "dg-at-timetable",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = String(req.url || "").split("?")[0];
        if (path === "/api/dg-at-timetable") return handleDgAtTimetable(req, res);
        return next();
      });
    },
  };
}
