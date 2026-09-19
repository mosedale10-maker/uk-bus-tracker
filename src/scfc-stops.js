/** First Potteries BS1 / BS2 Stoke City FC matchday shuttles — stops, timetable, live ETAs. */
import scfcData from "./scfc-stops-data.json";

export const SCFC_LINES = ["BS1", "BS2", "B1", "B2"];

const UK_TZ = "Europe/London";

function normalizeStokeFcLine(line) {
  const code = String(line || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (code === "B1" || code === "BS1") return "BS1";
  if (code === "B2" || code === "BS2") return "BS2";
  return code || "";
}

function isStokeFcLine(line) {
  const code = normalizeStokeFcLine(line) || String(line || "").toUpperCase();
  return code === "BS1" || code === "BS2" || code === "B1" || code === "B2";
}

export function scfcStopsInBounds(bounds, { pad = 0.01 } = {}) {
  if (!bounds) return [];
  const south = bounds.getSouth() - pad;
  const north = bounds.getNorth() + pad;
  const west = bounds.getWest() - pad;
  const east = bounds.getEast() + pad;
  return (scfcData.stops || []).filter(
    (stop) =>
      Number.isFinite(stop.lat) &&
      Number.isFinite(stop.lng) &&
      stop.lat >= south &&
      stop.lat <= north &&
      stop.lng >= west &&
      stop.lng <= east,
  );
}

export function scfcStopByAtco(atco) {
  const id = String(atco || "");
  if (!id) return null;
  return (scfcData.stops || []).find((stop) => stop.atco === id) || null;
}

export function scfcRouteStops(line) {
  const code = normalizeStokeFcLine(line) || String(line || "").toUpperCase();
  return scfcData.routes?.[code] || [];
}

export function scfcTimetable(line) {
  const code = normalizeStokeFcLine(line) || String(line || "").toUpperCase();
  return scfcData.timetables?.[code] || null;
}

export function scfcFeatureFromStop(stop) {
  const lines = (stop.lines || []).map((l) => normalizeStokeFcLine(l) || String(l).toUpperCase());
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [stop.lng, stop.lat] },
    properties: {
      name: stop.name || stop.label,
      url: stop.atco ? `/stops/${stop.atco}` : "",
      services: lines,
      scfcShuttle: true,
      scfcLines: lines,
    },
    scfcStop: stop,
  };
}

function haversineMeters(aLat, aLng, bLat, bLng) {
  const toRad = (d) => (d * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

function ukParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: get("weekday"),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

/** London-local Date for Y-M-D + HH:MM. */
function ukLocalDate(year, month, day, hour, minute) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(guess);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  const asUkMin = get("hour") * 60 + get("minute");
  const wantMin = hour * 60 + minute;
  return new Date(guess.getTime() + (wantMin - asUkMin) * 60_000);
}

function candidateKickOffs(now = new Date()) {
  const p = ukParts(now);
  const weekend = p.weekday === "Sat" || p.weekday === "Sun";
  const kos = [];
  if (weekend) {
    kos.push(ukLocalDate(p.year, p.month, p.day, 12, 30));
    kos.push(ukLocalDate(p.year, p.month, p.day, 15, 0));
  }
  kos.push(ukLocalDate(p.year, p.month, p.day, 19, 45));
  if (p.hour >= 22) {
    const t = new Date(now.getTime() + 24 * 3600_000);
    const tp = ukParts(t);
    kos.push(ukLocalDate(tp.year, tp.month, tp.day, 12, 30));
    kos.push(ukLocalDate(tp.year, tp.month, tp.day, 15, 0));
  }
  return kos;
}

function offsetsForLeg(leg) {
  if (!leg) return [];
  if (Array.isArray(leg.offsetsMin) && leg.offsetsMin.length) return [...leg.offsetsMin];
  if (leg.pattern?.startsWith("every_5") || Number.isFinite(leg.intervalMin)) {
    const start = Number(leg.startOffsetMin);
    const end = Number(leg.endOffsetMin);
    const step = Number(leg.intervalMin) || 5;
    if (!Number.isFinite(start) || !Number.isFinite(end) || step <= 0) return [];
    const out = [];
    for (let m = start; m <= end; m += step) out.push(m);
    return out;
  }
  return [];
}

function stopIsOrigin(stop, line) {
  const code = normalizeStokeFcLine(line) || String(line || "").toUpperCase();
  const route = scfcData.routes?.[code] || [];
  const origin = route.find((s) => s.role === "origin");
  if (!origin) return false;
  return origin.atco === stop.atco || (stop.label && origin.label === stop.label);
}

function stopIsStadium(stop) {
  return /bet365|stadium/i.test(`${stop.name || ""} ${stop.label || ""}`);
}

/**
 * Scheduled matchday departures for a stop (relative to typical kick-offs).
 */
export function scfcScheduledDeparturesForStop(stop, { limit = 6, now = Date.now() } = {}) {
  if (!stop) return [];
  const lines = [
    ...new Set(
      (stop.lines || []).map((l) => normalizeStokeFcLine(l) || String(l).toUpperCase()),
    ),
  ].filter((l) => l === "BS1" || l === "BS2");
  if (!lines.length) return [];
  const rows = [];
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  for (const line of lines) {
    const tt = scfcTimetable(line);
    if (!tt) continue;
    const atOrigin = stopIsOrigin(stop, line);
    const atStadium = stopIsStadium(stop);
    const legs = [];
    if (atOrigin && tt.outbound) legs.push({ leg: tt.outbound, dest: tt.outbound.to || "bet365 Stadium" });
    if (atStadium && tt.inbound) legs.push({ leg: tt.inbound, dest: tt.inbound.to || "City centre" });
    if (!legs.length && atStadium && tt.outbound) {
      for (const ko of candidateKickOffs(new Date(nowMs))) {
        for (const off of offsetsForLeg(tt.outbound)) {
          const when = new Date(ko.getTime() + (off + 18) * 60_000);
          const ms = when.getTime();
          if (ms < nowMs - 60_000 || ms > nowMs + 4 * 3600_000) continue;
          rows.push({
            line,
            dest: "bet365 Stadium",
            when: when.toISOString(),
            ms,
            live: false,
            liveEst: false,
            scfcShuttle: true,
            scheduled: true,
          });
        }
      }
      continue;
    }
    for (const { leg, dest } of legs) {
      for (const ko of candidateKickOffs(new Date(nowMs))) {
        for (const off of offsetsForLeg(leg)) {
          const when = new Date(ko.getTime() + off * 60_000);
          const ms = when.getTime();
          if (ms < nowMs - 60_000 || ms > nowMs + 4 * 3600_000) continue;
          rows.push({
            line,
            dest,
            when: when.toISOString(),
            ms,
            live: false,
            liveEst: false,
            scfcShuttle: true,
            scheduled: true,
          });
        }
      }
    }
  }
  return rows.sort((a, b) => a.ms - b.ms).slice(0, limit);
}

/**
 * Live ETAs from SCFC vehicles on the map near a stop.
 * @param {object} stop
 * @param {Iterable} busMarkers markers with .bus / getLatLng
 */
export function scfcLiveDeparturesForStop(stop, busMarkers, { limit = 6 } = {}) {
  if (!stop || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) return [];
  const lines = new Set(
    (stop.lines || [])
      .map((l) => normalizeStokeFcLine(l) || String(l).toUpperCase())
      .filter(Boolean),
  );
  const now = Date.now();
  const rows = [];
  for (const marker of busMarkers || []) {
    const bus = marker.bus;
    if (!bus) continue;
    const rawLine = bus.service?.line_name || marker.line || "";
    const line = normalizeStokeFcLine(rawLine) || String(rawLine).toUpperCase();
    const serves =
      lines.has(line) ||
      lines.has(String(rawLine).toUpperCase()) ||
      (isStokeFcLine(rawLine) && [...lines].some((l) => l === "BS1" || l === "BS2" || l === "B1" || l === "B2"));
    if (!serves) continue;
    const ll = marker.getLatLng?.() || marker;
    const lat = Number(ll.lat);
    const lng = Number(ll.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const dist = haversineMeters(stop.lat, stop.lng, lat, lng);
    if (dist > 14000) continue;
    const speedMph = Number(bus.speedMph);
    const speedMs = Number.isFinite(speedMph) && speedMph > 2 ? (speedMph * 1609.34) / 3600 : 7;
    const etaSec = dist / Math.max(3, speedMs);
    const dest = bus.destination || bus.trip_destination || marker.extra?.to || "bet365 Stadium";
    const showLine = normalizeStokeFcLine(rawLine) || line || "BS1";
    const when = new Date(now + etaSec * 1000).toISOString();
    rows.push({
      line: showLine,
      dest,
      when,
      ms: now + etaSec * 1000,
      live: true,
      liveEst: true,
      scfcShuttle: true,
      distanceM: Math.round(dist),
    });
  }
  return rows.sort((a, b) => a.ms - b.ms).slice(0, limit);
}

export function scfcTimetableHtml(line, { esc } = {}) {
  const escape =
    esc ||
    ((value) =>
      String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;"));
  const code = normalizeStokeFcLine(line) || String(line || "").toUpperCase();
  const tt = scfcTimetable(code);
  if (!tt) return "";
  const stops = scfcRouteStops(code);
  const stopList = stops.length
    ? `<ol class="fleet-tt-stops">${stops
        .map((s) => `<li><span class="fleet-tt-stop-name">${escape(s.label || s.name)}</span></li>`)
        .join("")}</ol>`
    : "";
  const examples = (tt.examples || [])
    .map((ex) => {
      const out = (ex.outbound || []).map((t) => escape(t)).join(" · ");
      const inn = (ex.inbound || []).map((t) => escape(t)).join(" · ");
      return `<div class="fleet-tt-example">
        <div class="fleet-tt-ko">Kick-off ${escape(ex.kickOff)}</div>
        <div class="fleet-tt-row"><span class="fleet-tt-label">To stadium</span><span>${out}</span></div>
        <div class="fleet-tt-row"><span class="fleet-tt-label">Return</span><span>${inn}</span></div>
      </div>`;
    })
    .join("");
  return `
    <section class="fleet-tt">
      <h2 class="fleet-section-title">Matchday timetable</h2>
      <p class="fleet-muted fleet-section-note">${escape(tt.summary || "")}</p>
      ${stopList}
      ${examples}
      <p class="fleet-muted fleet-tt-footnote">Times relative to kick-off · First Potteries matchday shuttle · not valid with day tickets</p>
    </section>
  `;
}

export { scfcData };
