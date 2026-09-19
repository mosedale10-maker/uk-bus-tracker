/** Staffordshire fleet browser (bustimes-backed). */

import { scfcTimetableHtml } from "./scfc-stops.js";

export const STAFFS_OPERATORS = [
  { name: "Aimee's", slug: "aimees", noc: "TXCO" },
  { name: "Albatross Coaches", slug: "albatross-coaches", noc: null, kind: "private-hire" },
  { name: "Arriva Derby", slug: "arriva-derby", noc: "ADER" },
  { name: "Arriva Midlands North", slug: "arriva-midlands-north", noc: "AMNO" },
  { name: "Ashbourne Community Transport", slug: "ashbourne-community-transport", noc: null },
  { name: "Banga Buses", slug: "banga-travel", noc: "BANG" },
  { name: "Bus Link", slug: "bus-link", noc: null },
  { name: "Carolean Coaches", slug: "carolean-coaches", noc: "CRLN", kind: "private-hire" },
  { name: "Chaserider", slug: "chaserider", noc: "CRDR" },
  {
    name: "Coastal Liner",
    slug: "coastal-liner",
    noc: null,
    kind: "private-hire",
    note: "Closed school contracts · no public live feed",
  },
  {
    name: "Copeland Coaches",
    slug: "copeland-coaches",
    noc: null,
    kind: "private-hire",
    website: "https://www.copelandstours.co.uk/",
    note: "Copelands Tours · coach hire & holidays · Meir, Stoke-on-Trent",
  },
  { name: "D & G Bus", slug: "d-g-coach-bus", noc: "DAGC" },
  { name: "Diamond Bus", slug: "diamond-bus", noc: "DIAM" },
  { name: "Diamond Bus East Midlands", slug: "midland-classic", noc: "MDCL" },
  { name: "Evolve Bus & Coach", slug: "evolve-bus-coach", noc: "EVOL", kind: "private-hire" },
  { name: "First Potteries", slug: "first-potteries", noc: "FPOT", note: "Includes BS1–BS2 Stoke City FC matchday shuttles" },
  { name: "Flexibus", slug: "flexibus", noc: null },
  { name: "FlixBus", slug: "flixbus", noc: "FLIX", note: "UK + Europe coaches · live on map" },
  { name: "High Peak", slug: "high-peak", noc: "HIPK" },
  { name: "Hotspur", slug: "hotspur", noc: "HOTS" },
  {
    name: "Leon's Holidays",
    slug: "leons-holidays",
    noc: null,
    kind: "private-hire",
    website: "https://www.leonsholidays.co.uk/",
    note: "Coach holidays & private hire · Stafford",
  },
  { name: "National Express", slug: "national-express", noc: "NATX" },
  { name: "National Express West Midlands", slug: "national-express-west-midlands", noc: "TNXB" },
  { name: "Scraggs", slug: "scraggs-taxis-and-coaches", noc: "SCRT", kind: "private-hire" },
  {
    name: "Sanders Coaches",
    slug: "sanders-coaches",
    noc: "SNDR",
    kind: "private-hire",
    website: "https://www.sanderscoaches.com/",
    note: "Norfolk bus & coach · live on map when tracked",
  },
  { name: "Select Bus Services", slug: "select-bus-services", noc: "SLBS" },
  { name: "South Staffs Coach Hire", slug: "la-travel-south-staffs-coach-hire", noc: "LATR", kind: "private-hire" },
  { name: "Stagecoach Midlands", slug: "stagecoach-northamptonshire", noc: null },
  {
    name: "Stanton's of Stoke",
    slug: "stantons-of-stoke",
    noc: "SOST",
    kind: "private-hire",
    alsoFleet: true,
    website: "https://www.stantonsofstoke.co.uk/",
    note: "Coach hire & local bus services · live on map when tracked",
  },
  { name: "trentbarton", slug: "trent-barton", noc: "TBTN" },
  { name: "Walsall Community Transport", slug: "walsall-community-transport", noc: "WACT" },
].sort((a, b) => a.name.localeCompare(b.name, "en-GB"));

/** Private-hire / coach operators that publish public AVL (fleet history + GPS tails). */
export const TRACKED_HIRE_NOCS = new Set(
  STAFFS_OPERATORS.filter((op) => op.kind === "private-hire" && op.noc).map((op) => op.noc),
);

export const AT_ROUTES = [
  {
    line: "AT1",
    name: "Alton Towers employee-only AT1",
    origin: "Fenton",
    destination: "Alton Towers",
    note: "Stops on map · timetable via D&G / line manager",
  },
  {
    line: "AT2",
    name: "Alton Towers employee-only AT2",
    origin: "Fenton",
    destination: "Alton Towers",
    note: "Via Bentilee, Longton, Meir, Cheadle",
  },
  {
    line: "AT3",
    name: "Alton Towers employee-only AT3",
    origin: "Bentilee",
    destination: "Alton Towers",
    note: "Via Longton, Meir, Cheadle",
  },
];

/** Registered Staffordshire school / college services with public AVL when running. */
export const STAFFS_SCHOOL_ROUTES = [
  { line: "9S", name: "Colwich – Hixon – Weston Road Academy", operator: "Select Bus", noc: "SLBS" },
  { line: "11A", name: "Stafford – Coton Fields – Beaconside", operator: "Select Bus", noc: "SLBS" },
  { line: "11S", name: "Colwich – Weston Road Academy", operator: "Select Bus", noc: "SLBS" },
  { line: "70A", name: "Featherstone – Cheslyn Hay Academy", operator: "Chaserider", noc: "CRDR" },
  { line: "71", name: "West Croft – Cheslyn Hay School", operator: "Select Bus", noc: "SLBS" },
  { line: "71A", name: "Wolverhampton – Cheslyn Hay High School", operator: "Select Bus", noc: "SLBS" },
  { line: "105", name: "Handsacre – Netherstowe School", operator: "South Staffs Coach Hire", noc: "LATR" },
  { line: "547", name: "Great Haywood – Weston Road School", operator: "Select Bus", noc: "SLBS" },
  { line: "766", name: "Whittington – King Edward VI School", operator: "Chaserider", noc: "CRDR" },
  { line: "803", name: "Pelsall – Rodbaston College", operator: "Select Bus", noc: "SLBS" },
  { line: "804", name: "Tamworth – Rodbaston College", operator: "Select Bus", noc: "SLBS" },
  { line: "812", name: "Coven – Wolgarston", operator: "Select Bus", noc: "SLBS" },
  { line: "817", name: "Hednesford – Rodbaston College", operator: "Select Bus", noc: "SLBS" },
  { line: "849", name: "Hixon – Weston Road", operator: "Select Bus", noc: "SLBS" },
  { line: "879", name: "Stafford – Penkridge – Rodbaston", operator: "Select Bus", noc: "SLBS" },
  { line: "880", name: "Wheaton Aston – Wolgarston High School", operator: "Select Bus", noc: "SLBS" },
  { line: "R3", name: "Fazeley – The Rawlett School", operator: "South Staffs Coach Hire", noc: "LATR" },
  { line: "R15", name: "Drayton Bassett – Rawlett School", operator: "South Staffs Coach Hire", noc: "LATR" },
  { line: "12A", name: "Alrewas – John Taylor School", operator: "South Staffs Coach Hire", noc: "LATR" },
  { line: "12B", name: "Fradley – John Taylor School", operator: "South Staffs Coach Hire", noc: "LATR" },
  { line: "14", name: "Newborough – John Taylor High School", operator: "South Staffs Coach Hire", noc: "LATR" },
].sort((a, b) => a.line.localeCompare(b.line, "en-GB", { numeric: true }));

export const SCHOOL_LINE_SET = new Set(STAFFS_SCHOOL_ROUTES.map((row) => row.line));

/** First Potteries matchday shuttles to bet365 Stadium (Stoke City FC). */
export const STOKE_FC_SHUTTLE_ROUTES = [
  {
    line: "BS1",
    aliases: ["B1"],
    name: "Stoke (Glebe Street) → bet365 Stadium",
    operator: "First Potteries",
    noc: "FPOT",
    note: "Matchday shuttle · every ~5 mins from 90 mins before kick-off",
  },
  {
    line: "BS2",
    aliases: ["B2"],
    name: "Hanley Bus Station → bet365 Stadium",
    operator: "First Potteries",
    noc: "FPOT",
    note: "Matchday shuttle from City Centre (Hanley)",
  },
];

export const STOKE_FC_LINE_SET = new Set(
  STOKE_FC_SHUTTLE_ROUTES.flatMap((row) => [row.line, ...(row.aliases || [])].map((l) => String(l).toUpperCase())),
);

const UK_TZ = "Europe/London";
const AT_LINE_SET = new Set(AT_ROUTES.map((row) => row.line));
const STAFFS_LIVE_BBOX = "xmin=-2.35&ymin=52.55&xmax=-1.7&ymax=53.15";

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"');
}

function ukDateKey(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: UK_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value instanceof Date ? value : new Date(value));
}

function formatLongDate(dateStr) {
  const dt = new Date(`${dateStr}T12:00:00`);
  return dt.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: UK_TZ,
  });
}

function formatShortTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: UK_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatJourneyTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: UK_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).replace(":", "");
}

function compactQuery(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function stripVehiclePrefix(raw) {
  return String(raw || "")
    .replace(/^(bus|coach|vehicle|fleet|reg|vrm)\s+/i, "")
    .trim();
}

function looksLikeUkReg(raw) {
  const c = compactQuery(stripVehiclePrefix(raw));
  if (c.length < 5 || c.length > 8) return false;
  if (/^[A-Z]{2}\d{2}[A-Z]{3}$/.test(c)) return true;
  if (/^[A-Z]\d{1,3}[A-Z]{3}$/.test(c)) return true;
  if (/^\d{1,4}[A-Z]{3}$/.test(c)) return true;
  if (/^[A-Z]{1,3}\d{1,4}$/.test(c)) return true;
  return false;
}

function isStaffsVehicle(vehicle) {
  const nocSet = new Set(STAFFS_OPERATORS.map((op) => op.noc).filter(Boolean));
  const slugSet = new Set(STAFFS_OPERATORS.map((op) => op.slug));
  const noc = vehicle?.operator?.id;
  const slug = vehicle?.operator?.slug;
  return Boolean((noc && nocSet.has(noc)) || (slug && slugSet.has(slug)));
}

function parseDgRef(ref) {
  if (!ref) return { fleet: "", reg: "" };
  const cleaned = String(ref).replace(/[_-]+/g, " ").trim();
  const plate = cleaned.match(/[A-Z]{2}\d{2}\s*[A-Z]{3}/i);
  const parts = cleaned.split(/\s+/);
  return {
    fleet: parts[0] || "",
    reg: plate ? plate[0].replace(/\s+/g, " ").toUpperCase() : parts.slice(1).join(" "),
  };
}

function plateHtml(reg) {
  const text = String(reg || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return `<span class="fleet-plate">${esc(text)}</span>`;
}

function formatTrackedDate(value) {
  if (!value) return "";
  const key =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : ukDateKey(value);
  if (!key || key === "Invalid Date") return "";
  const today = ukDateKey();
  if (key === today) return "Today";
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === ukDateKey(yesterday)) return "Yesterday";
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return new Date(`${key}T12:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: UK_TZ,
  });
}

function lastTrackedHtml(info) {
  const label = formatTrackedDate(info?.trackedAt || info?.date);
  if (!label) return "";
  return `<span class="fleet-last-tracked" title="Last tracked">${esc(label)}</span>`;
}

function lastRouteHtml(info) {
  if (!info?.route && !info?.dest) return "";
  const route = info.route ? String(info.route) : "";
  const dest = info.dest ? String(info.dest) : "";
  const divert =
    info.diverted || isDivertedText(dest, route)
      ? ` <span class="fleet-divert-tag" title="Diverted">div</span>`
      : "";
  const cls = info.at ? " fleet-last-route-at" : info.scfc ? " fleet-last-route-scfc" : info.school ? " fleet-last-route-school" : "";
  if (route && !info.noLink) {
    const destBit = dest ? ` · ${esc(dest)}` : "";
    return `<span class="fleet-last-route fleet-route-link${cls}" role="link" tabindex="0" data-action="open-route-line" data-line="${esc(route)}" title="Buses on route ${esc(route)}"><span class="fleet-route">${esc(route)}</span>${divert}${destBit}</span>`;
  }
  const label = [route, dest].filter(Boolean).join(" · ");
  return `<span class="fleet-last-route${cls}" title="Last route">${esc(label)}${divert}</span>`;
}

function routeNumberBtn(line, { className = "" } = {}) {
  const code = String(line || "").trim();
  if (!code) return `<span class="fleet-route">—</span>`;
  return `<button type="button" class="fleet-route fleet-route-btn${className ? ` ${className}` : ""}" data-action="open-route-line" data-line="${esc(code)}" title="Show buses on route ${esc(code)}">${esc(code)}</button>`;
}

function vehicleMainHtml(v) {
  return `<span class="fleet-list-main">${esc(v.fleet_code || v.fleet_number || "—")} ${plateHtml(v.reg)}${lastTrackedHtml(v.lastRoute)}${lastRouteHtml(v.lastRoute)}</span>`;
}

const lastRouteCache = new Map();
let atLiveCache = { at: 0, byReg: new Map(), byFleet: new Map(), byLine: new Map(), meta: new Map() };

async function ensureAtLive(maxAgeMs = 20000) {
  if (Date.now() - atLiveCache.at < maxAgeMs && atLiveCache.meta.size) return atLiveCache;
  const byReg = new Map();
  const byFleet = new Map();
  const byLine = new Map(AT_ROUTES.map((row) => [row.line, []]));
  const meta = new Map(AT_ROUTES.map((row) => [row.line, { ...row, live: 0 }]));
  try {
    const [vehiclesRes, servicesRes] = await Promise.all([
      fetch("/api/dg-vehicles?regionId=526&showBusesNotInService=true"),
      fetch("/api/dg-services"),
    ]);
    if (servicesRes.ok) {
      const services = await servicesRes.json();
      for (const row of services.objects || []) {
        const service = row.service || row;
        const line = String(service.lineName || "").toUpperCase();
        if (!AT_LINE_SET.has(line)) continue;
        meta.set(line, {
          line,
          name: `Alton Towers employee-only ${line}`,
          origin: service.origin || meta.get(line)?.origin || "",
          destination: service.destination || meta.get(line)?.destination || "",
          via: Array.isArray(service.via) ? service.via : [],
          live: 0,
        });
      }
    }
    if (vehiclesRes.ok) {
      const data = await vehiclesRes.json();
      for (const item of data.items || []) {
        const line = String(item.currentJourney?.publishedLineName || "").toUpperCase();
        if (!AT_LINE_SET.has(line)) continue;
        const parsed = parseDgRef(item.vehicle?.ref);
        const dest =
          item.currentJourney?.destination?.name ||
          meta.get(line)?.destination ||
          "Alton Towers";
        const entry = {
          line,
          dest,
          fleet: parsed.fleet,
          reg: compactQuery(parsed.reg),
          regLabel: parsed.reg,
          ref: item.vehicle?.ref || "",
          recordedAtTime: item.recordedAtTime || "",
          direction: item.currentJourney?.directionRef || "",
          item,
        };
        if (entry.reg) byReg.set(entry.reg, entry);
        if (entry.fleet) byFleet.set(compactQuery(entry.fleet), entry);
        byLine.get(line)?.push(entry);
        const info = meta.get(line);
        if (info) info.live = (info.live || 0) + 1;
      }
    }
  } catch {
    // Keep previous cache if refresh fails.
    if (atLiveCache.meta.size) return atLiveCache;
  }
  atLiveCache = { at: Date.now(), byReg, byFleet, byLine, meta };
  return atLiveCache;
}

let schoolLiveCache = { at: 0, byLine: new Map(), meta: new Map(), vehicles: [] };
let matchdayLiveCache = { at: 0, byLine: new Map(), meta: new Map(), vehicles: [] };

function schoolRouteMeta(line) {
  return STAFFS_SCHOOL_ROUTES.find((row) => row.line === line) || { line };
}

export function isSchoolServiceLine(line) {
  return SCHOOL_LINE_SET.has(String(line || "").toUpperCase());
}

export function isSchoolBusLive(bus = {}) {
  const line = String(bus.service?.line_name || "").toUpperCase();
  if (SCHOOL_LINE_SET.has(line)) return true;
  const hay = `${bus.destination || ""} ${bus.service?.url || ""}`;
  return /school|college|academy|wolgarston|rodbaston|rawlett|john taylor|netherstowe|king edward/i.test(hay);
}

export function normalizeStokeFcLine(line) {
  const code = String(line || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code === "B1" || code === "BS1") return "BS1";
  if (code === "B2" || code === "BS2") return "BS2";
  return String(line || "").toUpperCase();
}

/** Compact keys for a Stoke City FC shuttle line (B1 ↔ BS1, etc.). */
export function stokeFcLineKeys(line) {
  const code = normalizeStokeFcLine(line);
  const meta = STOKE_FC_SHUTTLE_ROUTES.find(
    (row) =>
      row.line === code ||
      (row.aliases || []).some((a) => normalizeStokeFcLine(a) === code),
  );
  if (!meta) {
    const compact = String(line || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    return compact ? [compact] : [];
  }
  return [meta.line, ...(meta.aliases || [])].map((l) =>
    String(l)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, ""),
  );
}

export function isStokeFcLine(line) {
  const code = normalizeStokeFcLine(line);
  return STOKE_FC_LINE_SET.has(code) || STOKE_FC_LINE_SET.has(String(line || "").toUpperCase());
}

export function sameServiceLine(a, b) {
  const left = String(a || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const right = String(b || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!left || !right) return false;
  if (left === right) return true;
  const leftKeys = new Set(stokeFcLineKeys(left));
  if (leftKeys.size > 1 && leftKeys.has(right)) return true;
  const rightKeys = new Set(stokeFcLineKeys(right));
  if (rightKeys.size > 1 && rightKeys.has(left)) return true;
  for (const key of leftKeys) {
    if (rightKeys.has(key)) return true;
  }
  return false;
}

/** True when destination / notes say the bus is diverted. */
export function isDivertedText(...parts) {
  const hay = parts.filter(Boolean).join(" ");
  return /\bdiv(?:ert(?:ed|sion)?|)\b|\bvia\s+diversion\b|\bon\s+diversion\b/i.test(hay);
}

/**
 * Best route code from a live vehicle or history row.
 * Prefers published line, then tokens in destination (useful when diverted).
 */
export function extractRouteFromVehicle(source = {}) {
  const bus = source.bus || source;
  const direct = String(
    bus.service?.line_name ||
      bus.route_name ||
      source.route_name ||
      source.line ||
      "",
  ).trim();
  if (direct && !/^div/i.test(direct)) return direct;
  const hay = [
    bus.destination,
    source.destination,
    bus.vehicle?.name,
    source.vehicle?.name,
    bus.block,
    source.notes,
  ]
    .filter(Boolean)
    .join(" ");
  // "Diverted 23 Hanley", "23 Diverted", "Route 101 via …"
  const patterns = [
    /\b(?:route|svc|service|line)\s*([A-Z]{0,2}\d{1,3}[A-Z]?)\b/i,
    /\bdiv(?:ert(?:ed|sion)?)[:\s-]+([A-Z]{0,2}\d{1,3}[A-Z]?)\b/i,
    /\b([A-Z]{0,2}\d{1,3}[A-Z]?)\s*(?:div(?:ert(?:ed|sion)?|))\b/i,
    /\b([A-Z]{1,2}\d{1,3}[A-Z]?|\d{1,3}[A-Z]?)\b/,
  ];
  for (const re of patterns) {
    const m = hay.match(re);
    if (!m?.[1]) continue;
    const code = String(m[1]).toUpperCase();
    if (/^div/i.test(code)) continue;
    if (direct && sameServiceLine(direct, code)) return direct;
    return m[1];
  }
  return direct || "";
}

/** Normalise a journey/history row; fill route from vehicle when diverted or missing. */
export function enrichJourneyRow(row = {}, liveSource = null) {
  const rowDest = String(row.destination || "").trim();
  const liveDest = String(liveSource?.destination || "").trim();
  const divertedSelf =
    Boolean(row.diverted) || isDivertedText(rowDest, row.notes, row.route_name);
  const useLive = Boolean(row.live) || divertedSelf;
  const dest = rowDest || (useLive ? liveDest : "") || "";
  const diverted =
    divertedSelf || (useLive && isDivertedText(dest, liveDest)) || isDivertedText(dest);
  const fromRow = String(row.route_name || "").trim();
  const fromDest = extractRouteFromVehicle({
    destination: dest || rowDest,
    route_name: fromRow,
    notes: row.notes,
  });
  const fromLive = liveSource ? extractRouteFromVehicle(liveSource) : "";
  let route = fromRow && !/^div/i.test(fromRow) ? fromRow : "";
  if (!route) route = fromDest || "";
  // Only borrow the live AVL line for diverted / live rows — not every blank past journey.
  if (!route && (diverted || row.live) && fromLive) route = fromLive;
  if (!route) route = fromRow;
  return {
    ...row,
    route_name: route || row.route_name || "",
    destination: dest || row.destination || "",
    diverted,
    extracted_route: fromDest || (diverted || row.live ? fromLive : "") || "",
  };
}

/** Merge a live AVL row into journey history (keeps diverted extract on the bus card). */
export function mergeLiveHistoryRow(journeys, liveRow) {
  const list = Array.isArray(journeys) ? [...journeys] : [];
  if (!liveRow) return list;
  const liveMs = new Date(liveRow.datetime).getTime();
  let matchedIdx = -1;
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (liveRow.trip_id && row.trip_id && String(row.trip_id) === String(liveRow.trip_id)) {
      matchedIdx = i;
      break;
    }
    if (
      (liveRow.journey_id || liveRow.id) &&
      row.id &&
      String(row.id) === String(liveRow.journey_id || liveRow.id)
    ) {
      matchedIdx = i;
      break;
    }
    const rowMs = new Date(row.datetime).getTime();
    if (
      Number.isFinite(liveMs) &&
      Number.isFinite(rowMs) &&
      Math.abs(rowMs - liveMs) < 20 * 60_000 &&
      (sameServiceLine(row.route_name, liveRow.route_name) ||
        sameServiceLine(row.extracted_route, liveRow.route_name) ||
        row.diverted ||
        liveRow.diverted)
    ) {
      matchedIdx = i;
      break;
    }
  }
  if (matchedIdx >= 0) {
    const row = list[matchedIdx];
    const merged = {
      ...row,
      route_name: liveRow.route_name || row.route_name || row.extracted_route || "",
      destination: liveRow.destination || row.destination || "",
      diverted: Boolean(row.diverted || liveRow.diverted),
      extracted_route: liveRow.extracted_route || row.extracted_route || "",
      live: true,
      trip_id: row.trip_id || liveRow.trip_id || "",
      trailKey: liveRow.trailKey || row.trailKey || "",
    };
    list.splice(matchedIdx, 1);
    list.unshift(merged);
    return list;
  }
  list.unshift(liveRow);
  return list;
}

/** Build a synthetic history row from the live AVL vehicle (covers current diversion). */
export function liveVehicleAsHistoryRow(bus, { trailKey = "" } = {}) {
  if (!bus) return null;
  const route = extractRouteFromVehicle(bus);
  const dest = String(bus.destination || "").trim();
  if (!route && !dest) return null;
  const when = bus.datetime ? new Date(bus.datetime) : new Date();
  const ms = when.getTime();
  if (!Number.isFinite(ms)) return null;
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
  return enrichJourneyRow(
    {
      id: `live-${bus.journey_id || bus.trip_id || bus.id || "now"}`,
      datetime: bus.datetime || when.toISOString(),
      date,
      route_name: route,
      destination: dest || (isDivertedText(dest) ? "Diverted" : ""),
      trip_id: bus.trip_id || "",
      vehicle: { id: bus.btId || bus.id },
      diverted: isDivertedText(dest),
      live: true,
      trailKey,
    },
    bus,
  );
}

export function isStokeFcShuttleLive(bus = {}) {
  if (!bus) return false;
  const line = normalizeStokeFcLine(bus.service?.line_name);
  if (STOKE_FC_LINE_SET.has(line) || STOKE_FC_LINE_SET.has(String(bus.service?.line_name || "").toUpperCase())) {
    return true;
  }
  const hay = `${bus.destination || ""} ${bus.origin || ""} ${bus.service?.url || ""}`;
  if (!/bet365|stoke city|scfc|britannia stadium|football shuttle/i.test(hay)) return false;
  const op = `${bus.operator?.noc || ""} ${bus.operator?.id || ""} ${bus.operator?.name || ""} ${bus.service?.operator?.name || ""} ${bus.service?.url || ""}`;
  return /FPOT|First Potteries|first-potteries/i.test(op);
}

export function stokeFcRouteMeta(line) {
  const code = normalizeStokeFcLine(line);
  return (
    STOKE_FC_SHUTTLE_ROUTES.find(
      (row) => row.line === code || (row.aliases || []).map((a) => String(a).toUpperCase()).includes(code),
    ) || { line: code || "BS1" }
  );
}

function parseLiveVehicleName(name) {
  const text = String(name || "").trim();
  const m = text.match(/^(\d+)\s*-\s*([A-Z0-9 ]+)$/i) || text.match(/^([A-Z0-9]+)\s+([A-Z]{1,3}\d{1,2}\s*[A-Z]{3})$/i);
  if (m) return { fleet: m[1].trim(), reg: m[2].replace(/\s+/g, " ").trim() };
  const plate = text.match(/\b([A-Z]{1,3}\d{1,2}\s*[A-Z]{3})\b/i);
  return { fleet: "", reg: plate ? plate[1].replace(/\s+/g, " ").trim() : text };
}

async function ensureSchoolLive(maxAgeMs = 15000) {
  const schoolFresh = Date.now() - schoolLiveCache.at < maxAgeMs && schoolLiveCache.meta.size;
  const matchFresh = Date.now() - matchdayLiveCache.at < maxAgeMs && matchdayLiveCache.meta.size;
  if (schoolFresh && matchFresh) return schoolLiveCache;

  const byLine = new Map(STAFFS_SCHOOL_ROUTES.map((row) => [row.line, []]));
  const meta = new Map(STAFFS_SCHOOL_ROUTES.map((row) => [row.line, { ...row, live: 0 }]));
  const vehicles = [];
  const matchByLine = new Map(STOKE_FC_SHUTTLE_ROUTES.map((row) => [row.line, []]));
  const matchMeta = new Map(STOKE_FC_SHUTTLE_ROUTES.map((row) => [row.line, { ...row, live: 0 }]));
  const matchVehicles = [];

  try {
    const res = await fetch(`/api/vehicles?${STAFFS_LIVE_BBOX}`);
    if (!res.ok) throw new Error(`Staffs live feed ${res.status}`);
    const rows = await res.json();
    for (const bus of Array.isArray(rows) ? rows : []) {
      const rawLine = String(bus.service?.line_name || "").toUpperCase();
      const parsed = parseLiveVehicleName(bus.vehicle?.name);

      if (isStokeFcShuttleLive(bus)) {
        const line = normalizeStokeFcLine(rawLine) || "BS1";
        const dest = bus.destination || stokeFcRouteMeta(line).name || "bet365 Stadium";
        const entry = {
          line,
          dest,
          fleet: parsed.fleet,
          reg: compactQuery(parsed.reg),
          regLabel: parsed.reg,
          btId: bus.id != null ? String(bus.id) : "",
          recordedAtTime: bus.datetime || "",
          bus,
          operator: stokeFcRouteMeta(line).operator || "First Potteries",
        };
        matchVehicles.push(entry);
        if (!matchByLine.has(line)) matchByLine.set(line, []);
        matchByLine.get(line).push(entry);
        if (!matchMeta.has(line)) {
          matchMeta.set(line, {
            line,
            name: dest,
            operator: entry.operator,
            noc: "FPOT",
            live: 0,
          });
        }
        const info = matchMeta.get(line);
        if (info) info.live = (info.live || 0) + 1;
      }

      if (!isSchoolBusLive(bus) && !SCHOOL_LINE_SET.has(rawLine)) continue;
      const line = rawLine;
      if (!line) continue;
      const dest = bus.destination || schoolRouteMeta(line).name || "";
      const entry = {
        line,
        dest,
        fleet: parsed.fleet,
        reg: compactQuery(parsed.reg),
        regLabel: parsed.reg,
        btId: bus.id != null ? String(bus.id) : "",
        recordedAtTime: bus.datetime || "",
        bus,
        operator: schoolRouteMeta(line).operator || "",
      };
      vehicles.push(entry);
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(entry);
      if (!meta.has(line)) {
        meta.set(line, {
          line,
          name: dest || line,
          operator: entry.operator || "School service",
          noc: "",
          live: 0,
        });
      }
      const info = meta.get(line);
      if (info) info.live = (info.live || 0) + 1;
    }
  } catch {
    if (schoolLiveCache.meta.size) {
      matchdayLiveCache = matchdayLiveCache.meta.size
        ? matchdayLiveCache
        : { at: Date.now(), byLine: matchByLine, meta: matchMeta, vehicles: matchVehicles };
      return schoolLiveCache;
    }
  }
  schoolLiveCache = { at: Date.now(), byLine, meta, vehicles };
  matchdayLiveCache = { at: Date.now(), byLine: matchByLine, meta: matchMeta, vehicles: matchVehicles };
  return schoolLiveCache;
}

async function ensureMatchdayLive(maxAgeMs = 15000) {
  await ensureSchoolLive(maxAgeMs);
  return matchdayLiveCache;
}

function matchAtLive(vehicle) {
  if (!vehicle) return null;
  const reg = compactQuery(vehicle.reg);
  const fleet = compactQuery(vehicle.fleet_code || vehicle.fleet_number);
  return (reg && atLiveCache.byReg.get(reg)) || (fleet && atLiveCache.byFleet.get(fleet)) || null;
}

async function fetchLastRoute(vehicleOrId) {
  const vehicle = typeof vehicleOrId === "object" && vehicleOrId ? vehicleOrId : null;
  const key = String(vehicle?.id ?? vehicleOrId ?? "");
  if (!key) return null;
  if (lastRouteCache.has(key)) return lastRouteCache.get(key);
  const promise = (async () => {
    await ensureAtLive();
    const at = matchAtLive(vehicle);
    if (at) {
      return {
        route: at.line,
        dest: at.dest,
        live: true,
        at: true,
        trackedAt: at.recordedAtTime || new Date().toISOString(),
      };
    }
    try {
      const liveRes = await fetch(`/api/vehicles?id=${encodeURIComponent(key)}`);
      if (liveRes.ok) {
        const live = await liveRes.json();
        const rows = Array.isArray(live) ? live : [];
        const row = rows.find((item) => String(item.id) === key) || rows[0];
        if (row && (row.service?.line_name || row.destination || row.datetime)) {
          const route = extractRouteFromVehicle(row) || row.service?.line_name || "";
          return {
            route,
            dest: row.destination || "",
            live: true,
            diverted: isDivertedText(row.destination, row.service?.line_name),
            trackedAt: row.datetime || new Date().toISOString(),
          };
        }
      }
    } catch {
      // Fall through to journey history.
    }
    try {
      const data = await fetchJson(
        `/api/bt-vehiclejourneys/?vehicle=${encodeURIComponent(key)}&limit=1`,
      );
      const row = data.results?.[0];
      if (row) {
        const enriched = enrichJourneyRow(row);
        return {
          route: enriched.route_name || row.route_name || "",
          dest: enriched.destination || row.destination || "",
          live: false,
          diverted: enriched.diverted,
          trackedAt: row.datetime || "",
          date: row.date || "",
        };
      }
    } catch {
      // Ignore.
    }
    return null;
  })();
  lastRouteCache.set(key, promise);
  return promise;
}

async function attachLastRoutes(vehicles, onProgress) {
  await ensureAtLive();
  const list = (vehicles || []).filter((v) => v?.id && !v.lastRoute);
  const chunk = 6;
  for (let i = 0; i < list.length; i += chunk) {
    await Promise.all(
      list.slice(i, i + chunk).map(async (vehicle) => {
        // Drop cache if AT assignment may apply (D&G).
        if (vehicle.operator?.id === "DAGC" || vehicle.operator?.slug === "d-g-coach-bus") {
          lastRouteCache.delete(String(vehicle.id));
        }
        vehicle.lastRoute = await fetchLastRoute(vehicle);
      }),
    );
    onProgress?.();
  }
}

async function resolveAtVehicleId(entry) {
  if (!entry) return null;
  if (entry.btId) return entry.btId;
  const params = new URLSearchParams({
    operator: "DAGC",
    withdrawn: "false",
    limit: "8",
  });
  if (entry.regLabel) params.set("search", entry.regLabel);
  else if (entry.fleet) params.set("search", entry.fleet);
  else return null;
  try {
    const data = await fetchJson(`/api/bt-vehicles/?${params}`);
    const wantReg = compactQuery(entry.regLabel || entry.reg);
    const wantFleet = compactQuery(entry.fleet);
    let best = null;
    let bestScore = -1;
    for (const vehicle of data.results || []) {
      let score = 0;
      if (wantReg && compactQuery(vehicle.reg) === wantReg) score += 10;
      if (wantFleet && compactQuery(vehicle.fleet_code || vehicle.fleet_number) === wantFleet) score += 8;
      if (score > bestScore) {
        bestScore = score;
        best = vehicle;
      }
    }
    if (best) {
      entry.btId = best.id;
      entry.btVehicle = best;
      return best.id;
    }
  } catch {
    // Ignore.
  }
  return null;
}

function liverySwatch(livery) {
  const colour = livery?.left || livery?.right || "#64748b";
  return `<span class="fleet-livery-swatch" style="background:${esc(colour)}" title="${esc(livery?.name || "")}"></span>`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

function fleetNumberKey(vehicle) {
  return String(vehicle?.fleet_code || vehicle?.fleet_number || "").trim();
}

function compareFleetNumbers(a, b) {
  const left = fleetNumberKey(a);
  const right = fleetNumberKey(b);
  if (!left && right) return 1;
  if (left && !right) return -1;
  const byNumber = left.localeCompare(right, "en-GB", { numeric: true, sensitivity: "base" });
  if (byNumber) return byNumber;
  return String(a?.reg || "").localeCompare(String(b?.reg || ""), "en-GB", { sensitivity: "base" });
}

async function fetchOperatorVehicles(noc, { search = "", offset = 0, limit = 100 } = {}) {
  if (!noc) return { count: 0, results: [], next: null };
  const params = new URLSearchParams({
    operator: noc,
    withdrawn: "false",
    limit: String(limit),
    offset: String(offset),
  });
  if (search) params.set("search", search);
  return fetchJson(`/api/bt-vehicles/?${params}`);
}

/** Load the full active fleet for an operator, sorted by fleet number. */
async function fetchAllOperatorVehicles(noc, { search = "" } = {}) {
  if (!noc) return { count: 0, results: [] };
  const results = [];
  const seen = new Set();
  let offset = 0;
  let total = Infinity;
  const pageSize = 100;
  for (let page = 0; page < 40 && offset < total; page += 1) {
    const data = await fetchOperatorVehicles(noc, { search, offset, limit: pageSize });
    total = Number(data.count);
    if (!Number.isFinite(total)) total = results.length;
    const batch = Array.isArray(data.results) ? data.results : [];
    if (!batch.length) break;
    for (const vehicle of batch) {
      const id = String(vehicle?.id ?? "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      results.push(vehicle);
    }
    offset += batch.length;
    if (!data.next || batch.length < pageSize) break;
  }
  results.sort(compareFleetNumbers);
  return { count: Number.isFinite(total) ? total : results.length, results };
}

async function fetchVehicle(id) {
  return fetchJson(`/api/bt-vehicles/${encodeURIComponent(id)}/`);
}

async function fetchVehicleJourneys(vehicleId, date) {
  const params = new URLSearchParams({ vehicle: String(vehicleId) });
  if (date) params.set("date", date);
  const rows = [];
  let url = `/api/bt-vehiclejourneys/?${params}`;
  for (let page = 0; page < 20 && url; page += 1) {
    const data = await fetchJson(url);
    const batch = Array.isArray(data.results) ? data.results : [];
    for (const row of batch) {
      if (date && row.date && row.date !== date) {
        if (row.date < date) {
          url = null;
          break;
        }
        continue;
      }
      rows.push(row);
    }
    if (!url || !data.next) break;
    url = String(data.next).replace(
      /^https?:\/\/bustimes\.org\/api\/vehiclejourneys/,
      "/api/bt-vehiclejourneys",
    );
  }
  return rows;
}

function sameLineCode(a, b) {
  return sameServiceLine(a, b);
}

/** Places that mean a Staffordshire local corridor (not just WM region). */
const STAFFS_PLACE_RE =
  /\b(hanley|stafford|stoke(?:-on-trent|-upon-trent)?|newcastle(?:[- ]under[- ]lyme)?|leek|uttoxeter|cannock|lichfield|tamworth|burton(?:[- ]upon[- ]trent)?|stone|cheadle|biddulph|kidsgrove|trentham|fenton|longton|burslem|tunstall|meir|blurton|eccleshall|penkridge|hednesford|rugeley|burntwood|alrewas|barton[- ]under[- ]needwood|norton[- ]in[- ]the[- ]moores?|endons?|werrington|cheddleton|ipstones|waterhouses)\b/i;

/** Other cities that share common route numbers — never mix these into Staffs route lists. */
const OTHER_CITY_RE =
  /\b(birmingham|manchester|liverpool|leeds|sheffield|nottingham|leicester|coventry|wolverhampton|walsall|dudley|west\s*bromwich|jewellery\s*quarter|handsworth|winson\s*green|london|cardiff|edinburgh|glasgow|middlesbrough|plymouth|wythenshawe|maidstone|gillingham)\b/i;

function serviceHasStaffsOperator(service, staffsNocs) {
  return (service?.operator || []).some((noc) => staffsNocs.has(noc));
}

/** True only for corridors that are clearly Staffordshire (e.g. Hanley–Stafford), not Birmingham 101. */
function isStaffsLocalService(service) {
  const hay = String(service?.description || "").trim();
  if (!hay) return false;
  if (!STAFFS_PLACE_RE.test(hay)) return false;
  if (OTHER_CITY_RE.test(hay)) return false;
  return true;
}

function isStaffsLocalDestination(dest) {
  const hay = String(dest || "").trim();
  if (!hay) return true;
  if (OTHER_CITY_RE.test(hay) && !STAFFS_PLACE_RE.test(hay)) return false;
  return true;
}

/**
 * Services for a line number, scoped to Staffordshire corridors only
 * (same number in Birmingham / other cities is excluded).
 */
async function searchServicesByLine(line, { preferOperatorNoc = "" } = {}) {
  const want = String(line || "").trim();
  if (!want) return [];
  const data = await fetchJson(`/api/bt-services/?search=${encodeURIComponent(want)}&limit=50`);
  const staffsNocs = new Set(STAFFS_OPERATORS.map((op) => op.noc).filter(Boolean));
  const matches = (data.results || []).filter((service) => sameLineCode(service.line_name, want));
  // Always require a Staffordshire place in the service description.
  let local = matches.filter((service) => isStaffsLocalService(service));

  const preferNoc = String(preferOperatorNoc || "").trim().toUpperCase();
  if (preferNoc) {
    const preferred = local.filter((service) =>
      (service.operator || []).some((noc) => String(noc).toUpperCase() === preferNoc),
    );
    if (preferred.length) local = preferred;
  }

  const staffsLocal = local.filter((service) => serviceHasStaffsOperator(service, staffsNocs));
  const picked = staffsLocal.length ? staffsLocal : local;
  return picked.sort((a, b) =>
    String(a.description || "").localeCompare(String(b.description || ""), "en-GB"),
  );
}

async function fetchServiceJourneyVehicles(serviceId, date, { maxPages = 10 } = {}) {
  const byId = new Map();
  let url = `/api/bt-vehiclejourneys/?service=${encodeURIComponent(serviceId)}&date=${encodeURIComponent(date)}&limit=100`;
  for (let page = 0; page < maxPages && url; page += 1) {
    const data = await fetchJson(url);
    for (const row of data.results || []) {
      if (date && row.date && row.date !== date) continue;
      const vehicle = row.vehicle;
      if (!vehicle?.id) continue;
      const prev = byId.get(vehicle.id);
      if (!prev || String(row.datetime || "") > String(prev.datetime || "")) {
        byId.set(vehicle.id, {
          id: vehicle.id,
          fleet_code: vehicle.fleet_code || vehicle.fleet_number || "",
          reg: vehicle.reg || "",
          slug: vehicle.slug || "",
          route_name: row.route_name || "",
          destination: row.destination || "",
          datetime: row.datetime || "",
          trip_id: row.trip_id || "",
          journey_id: row.id || "",
          service_id: serviceId,
        });
      }
    }
    if (!data.next) break;
    url = String(data.next).replace(
      /^https?:\/\/bustimes\.org\/api\/vehiclejourneys/,
      "/api/bt-vehiclejourneys",
    );
  }
  return [...byId.values()].sort((a, b) => String(b.datetime || "").localeCompare(String(a.datetime || "")));
}

async function fetchLineJourneyVehicles(services, date, { maxServices = 12 } = {}) {
  const pick = [...(services || [])].slice(0, maxServices);
  const batches = await Promise.all(
    pick.map((service) =>
      fetchServiceJourneyVehicles(service.id, date).catch(() => []),
    ),
  );
  const byId = new Map();
  for (const batch of batches) {
    for (const entry of batch) {
      if (!isStaffsLocalDestination(entry.destination)) continue;
      const prev = byId.get(entry.id);
      if (!prev || String(entry.datetime || "") > String(prev.datetime || "")) {
        byId.set(entry.id, entry);
      }
    }
  }
  return [...byId.values()].sort((a, b) => String(b.datetime || "").localeCompare(String(a.datetime || "")));
}

async function fetchLiveServiceVehicles(serviceId) {
  try {
    const res = await fetch(`/api/vehicles?service=${encodeURIComponent(serviceId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function searchStaffsVehicles(query, limit = 40) {
  const raw = stripVehiclePrefix(query);
  const q = compactQuery(raw);
  if (q.length < 2) return [];
  const plate = looksLikeUkReg(raw) ? q : "";

  const fetchVehicles = async (params) => {
    const data = await fetchJson(`/api/bt-vehicles/?${params}`);
    return data.results || [];
  };

  // Exact registration lookup (UK-wide) — same idea as the map search bar.
  if (plate) {
    const byReg = await fetchVehicles(
      new URLSearchParams({
        reg: plate,
        withdrawn: "false",
        limit: String(limit),
      }),
    );
    const exact = byReg.filter((vehicle) => compactQuery(vehicle.reg) === plate);
    const pool = exact.length
      ? exact
      : byReg.filter((vehicle) => {
          const reg = compactQuery(vehicle.reg);
          const prev = compactQuery(vehicle.previous_reg);
          return reg.includes(plate) || prev === plate || prev.includes(plate);
        });
    if (pool.length) {
      return pool.sort((a, b) => Number(isStaffsVehicle(b)) - Number(isStaffsVehicle(a)));
    }
  }

  const params = new URLSearchParams({
    search: plate || raw,
    withdrawn: "false",
    limit: String(Math.max(limit, 60)),
  });
  if (plate) params.set("reg", plate);
  const results = await fetchVehicles(params);

  if (plate) {
    const matches = results.filter((vehicle) => {
      const reg = compactQuery(vehicle.reg);
      const prev = compactQuery(vehicle.previous_reg);
      return reg === plate || prev === plate || reg.includes(plate) || prev.includes(plate);
    });
    if (matches.length) {
      return matches.sort((a, b) => Number(isStaffsVehicle(b)) - Number(isStaffsVehicle(a)));
    }
  }

  // Text / fleet / company searches stay Staffordshire-scoped.
  return results.filter(isStaffsVehicle).slice(0, limit);
}

export function createFleetBrowser({
  root,
  onTrackVehicle,
  onPlayJourney,
  onUploadBusPhoto,
} = {}) {
  if (!root) throw new Error("Fleet root missing");

  const state = {
    view: "home", // home | operator | vehicle | at-route | school-route | matchday-route | route
    tab: "fleet", // fleet | private-hire
    query: "",
    operator: null,
    vehicles: [],
    vehicleCount: 0,
    vehicleOffset: 0,
    vehicle: null,
    journeys: [],
    allJourneys: [],
    /** When set, vehicle journey history is limited to this route number. */
    lineFilter: "",
    date: ukDateKey(),
    loading: false,
    error: "",
    atLine: "",
    atVehicles: [],
    atMeta: null,
    schoolLine: "",
    schoolVehicles: [],
    schoolMeta: null,
    matchdayLine: "",
    matchdayVehicles: [],
    matchdayMeta: null,
    routeLine: "",
    routeServices: [],
    routeService: null,
    routeVehicles: [],
    routeLiveCount: 0,
    photo: null,
    photoPending: false,
    photoStatus: "",
    photoLoading: false,
  };

  let fleetPhotoInput = null;

  function sameServiceLine(a, b) {
    return sameLineCode(a, b);
  }

  function filterJourneysByLine(rows, line) {
    const list = Array.isArray(rows) ? rows : [];
    if (!line) return list;
    return list.filter(
      (row) =>
        sameServiceLine(row.route_name, line) ||
        sameServiceLine(row.extracted_route, line) ||
        (row.diverted && sameServiceLine(extractRouteFromVehicle(row), line)),
    );
  }

  function compactRegKey(reg) {
    return String(reg || "").replace(/[\s._-]+/g, "").toUpperCase();
  }

  function renderVehiclePhoto(v) {
    const reg = compactRegKey(v?.reg);
    if (!reg) {
      return `<section class="fleet-photo">
        <p class="fleet-muted fleet-section-note">Add a registration on this vehicle to upload a photo.</p>
      </section>`;
    }
    const img = state.photo?.url
      ? `<img class="fleet-bus-photo" src="${esc(state.photo.url)}" alt="Photo of ${esc(reg)}" loading="lazy" />`
      : "";
    const credit = state.photo?.uploaderName
      ? `<p class="fleet-photo-credit">Photo by ${esc(state.photo.uploaderName)}</p>`
      : "";
    const note = state.photoLoading
      ? `<p class="fleet-photo-note">Loading photo…</p>`
      : state.photoPending
        ? `<p class="fleet-photo-note">Photo submitted — waiting for owner approval. You can upload more anytime.</p>`
        : state.photoStatus
          ? `<p class="fleet-photo-note">${esc(state.photoStatus)}</p>`
          : `<p class="fleet-photo-note">Upload a photo for this bus even when it is not running on the map (Plus · needs owner approval).</p>`;
    const btnLabel = state.photoPending
      ? "Add another photo"
      : state.photo
        ? "Replace photo"
        : "Add photo";
    const savedName = (() => {
      try {
        return String(localStorage.getItem("uk-bus-photo-uploader-name") || "").trim().slice(0, 60);
      } catch {
        return "";
      }
    })();
    return `<section class="fleet-photo" aria-label="Bus photo">
      ${img}
      ${credit}
      ${note}
      <label class="fleet-photo-name-label"><span class="sr-only">Your name</span><input type="text" class="fleet-photo-name" maxlength="60" placeholder="Your name (optional)" value="${esc(savedName)}" autocomplete="nickname" enterkeyhint="done" /></label>
      <button type="button" class="fleet-photo-btn" data-action="upload-photo" data-reg="${esc(reg)}" data-fleet="${esc(v.fleet_code || "")}" data-operator="${esc(v.operator?.name || "")}">${esc(btnLabel)}</button>
    </section>`;
  }

  async function loadVehiclePhoto(vehicle) {
    const reg = compactRegKey(vehicle?.reg);
    state.photo = null;
    state.photoPending = false;
    state.photoStatus = "";
    if (!reg) {
      state.photoLoading = false;
      return;
    }
    state.photoLoading = true;
    try {
      const res = await fetch(`/api/bus-photos?reg=${encodeURIComponent(reg)}`);
      const data = res.ok ? await res.json() : null;
      if (compactRegKey(state.vehicle?.reg) !== reg) return;
      state.photo = data?.photo || null;
    } catch {
      if (compactRegKey(state.vehicle?.reg) === reg) state.photo = null;
    } finally {
      if (compactRegKey(state.vehicle?.reg) === reg) state.photoLoading = false;
      if (state.view === "vehicle") render();
    }
  }

  function ensureFleetPhotoInput() {
    if (fleetPhotoInput) return fleetPhotoInput;
    fleetPhotoInput = document.createElement("input");
    fleetPhotoInput.type = "file";
    fleetPhotoInput.accept = "image/jpeg,image/png,image/webp,image/*";
    fleetPhotoInput.hidden = true;
    fleetPhotoInput.addEventListener("change", async () => {
      const file = fleetPhotoInput.files?.[0];
      fleetPhotoInput.value = "";
      if (!file || !onUploadBusPhoto) return;
      const v = state.vehicle;
      const reg = compactRegKey(v?.reg || fleetPhotoInput.dataset.reg || "");
      if (!reg) {
        state.photoStatus = "This bus needs a registration plate before a photo can be added.";
        render();
        return;
      }
      state.photoStatus = "Uploading photo…";
      state.photoPending = false;
      render();
      try {
        const uploaderName = String(fleetPhotoInput.dataset.uploaderName || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 60);
        try {
          if (uploaderName) localStorage.setItem("uk-bus-photo-uploader-name", uploaderName);
        } catch {
          // Ignore.
        }
        await onUploadBusPhoto({
          file,
          reg,
          fleet: v?.fleet_code || fleetPhotoInput.dataset.fleet || "",
          operator: v?.operator?.name || fleetPhotoInput.dataset.operator || "",
          uploaderName,
        });
        if (compactRegKey(state.vehicle?.reg) !== reg) return;
        state.photoPending = true;
        state.photoStatus = "";
        render();
      } catch (error) {
        if (compactRegKey(state.vehicle?.reg) !== reg) return;
        state.photoPending = false;
        state.photoStatus = error?.message || "Could not upload photo";
        render();
      }
    });
    document.body.appendChild(fleetPhotoInput);
    return fleetPhotoInput;
  }

  function beginFleetPhotoUpload(btn) {
    if (!onUploadBusPhoto) {
      state.photoStatus = "Photo upload is not available right now.";
      render();
      return;
    }
    const input = ensureFleetPhotoInput();
    const nameField = btn.closest(".fleet-photo")?.querySelector(".fleet-photo-name");
    const uploaderName = String(nameField?.value || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 60);
    input.dataset.reg = btn.dataset.reg || "";
    input.dataset.fleet = btn.dataset.fleet || "";
    input.dataset.operator = btn.dataset.operator || "";
    input.dataset.uploaderName = uploaderName;
    try {
      if (uploaderName) localStorage.setItem("uk-bus-photo-uploader-name", uploaderName);
    } catch {
      // Ignore.
    }
    input.click();
  }

  function operatorNameFromNoc(noc) {
    const hit = STAFFS_OPERATORS.find((op) => op.noc === noc);
    return hit?.name || noc || "";
  }

  function serviceOperatorLabel(service) {
    const nocs = Array.isArray(service?.operator) ? service.operator : [];
    if (!nocs.length) return "";
    return nocs.map((noc) => operatorNameFromNoc(noc) || noc).join(", ");
  }

  function homeCrumbLabel() {
    return state.tab === "private-hire" ? "Private hire" : "Companies & vehicles";
  }

  function syncFleetTabUi() {
    const panel = root.closest("#fleet-panel");
    if (!panel) return;
    panel.dataset.fleetTab = state.tab;
    panel.querySelectorAll(".fleet-bottom-tab").forEach((btn) => {
      btn.classList.toggle("is-on", btn.dataset.fleetTab === state.tab);
    });
    const input = panel.querySelector("#fleet-query");
    if (input) {
      input.placeholder =
        state.tab === "private-hire"
          ? "Search private hire or reg"
          : "Search companies, vehicles or reg";
    }
  }

  function setLoading(on, error = "") {
    state.loading = on;
    state.error = error;
    render();
  }

  function crumb(parts) {
    return `<nav class="fleet-crumbs">${parts
      .map((part, i) => {
        if (part.action) {
          return `<button type="button" class="fleet-crumb-link" data-action="${esc(part.action)}" data-arg="${esc(part.arg || "")}" data-line="${esc(part.line || "")}">${esc(part.label)}</button>`;
        }
        return `<span class="${i === parts.length - 1 ? "fleet-crumb-here" : ""}">${esc(part.label)}</span>`;
      })
      .join('<span class="fleet-crumb-sep">›</span>')}</nav>`;
  }

  function backTarget() {
    if (state.view === "vehicle") {
      if (state.routeService?.id) {
        return { action: "open-route-service", arg: String(state.routeService.id) };
      }
      if (state.schoolLine) {
        return { action: "open-school-route", line: state.schoolLine };
      }
      if (state.matchdayLine) {
        return { action: "open-matchday-route", line: state.matchdayLine };
      }
      if (state.atLine) {
        return { action: "open-at-route", line: state.atLine };
      }
      if (state.operator?.slug) {
        return { action: "open-operator", arg: state.operator.slug };
      }
      return { action: "home" };
    }
    if (state.view === "route") {
      if (state.routeService && state.routeServices.length > 1) {
        return { action: "open-route-line", line: state.routeLine };
      }
      return { action: "home" };
    }
    if (state.view === "school-route" || state.view === "matchday-route" || state.view === "at-route" || state.view === "operator") {
      return { action: "home" };
    }
    if (state.view === "home" && state.query) {
      return { action: "home" };
    }
    return null;
  }

  function goBack() {
    const target = backTarget();
    if (!target) return;
    if (target.action === "open-school-route") return showSchoolRoute(target.line);
    if (target.action === "open-matchday-route") return showMatchdayRoute(target.line);
    if (target.action === "open-at-route") return showAtRoute(target.line);
    if (target.action === "open-operator") return showOperator(target.arg);
    if (target.action === "open-route-service") return showRouteService(target.arg);
    if (target.action === "open-route-line") return showRouteLine(target.line);
    return showHome("");
  }

  function fleetNav(parts) {
    const canBack = Boolean(backTarget());
    const back = canBack
      ? `<button type="button" class="fleet-back-btn" data-action="back" aria-label="Go back">← Back</button>`
      : "";
    return `<div class="fleet-nav">${back}${crumb(parts)}</div>`;
  }

  function operatorsMatching(query) {
    const q = compactQuery(query);
    if (!q) return STAFFS_OPERATORS;
    return STAFFS_OPERATORS.filter((op) => {
      const hay = compactQuery(
        `${op.name} ${op.slug} ${op.noc || ""} ${op.note || ""} ${op.kind || ""} private hire coach`,
      );
      return hay.includes(q);
    });
  }

  function isPrivateHire(op) {
    return op.kind === "private-hire";
  }

  function privateHireOperators(list) {
    return list.filter(isPrivateHire);
  }

  function fleetCompanies(list) {
    return list.filter((op) => !isPrivateHire(op) || op.alsoFleet);
  }

  function operatorSubline(op) {
    if (isPrivateHire(op)) {
      return op.note || (op.noc ? `Private hire / coach · NOC ${op.noc}` : "Private hire / coach travel");
    }
    return op.noc ? `NOC ${op.noc}` : "Fleet list unavailable";
  }

  function renderPrivateHireHome(vehicleHits = []) {
    const hire = privateHireOperators(operatorsMatching(state.query));
    const regSearch = looksLikeUkReg(state.query);
    return `
      ${fleetNav([{ label: "Staffordshire" }, { label: "Private hire" }])}
      <h1 class="fleet-title">Private hire &amp; coach travel</h1>
      <p class="fleet-lead">Coach and private hire firms in Staffordshire. Live map tracking only appears if they publish vehicle locations.${regSearch ? " Registration search covers the whole UK." : ""}</p>
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${
        state.query
          ? `<section class="fleet-section">
              <h2 class="fleet-section-title">${regSearch ? "Registration" : "Vehicles"} matching “${esc(state.query)}”</h2>
              ${
                state.loading
                  ? `<p class="fleet-muted">Searching…</p>`
                  : vehicleHits.length
                    ? `<ul class="fleet-list">${vehicleHits
                        .map(
                          (v) => `<li>
                            <button type="button" class="fleet-list-btn" data-action="open-vehicle" data-id="${esc(v.id)}">
                              ${vehicleMainHtml(v)}
                              <span class="fleet-list-sub">${esc(v.operator?.name || "")} · ${esc(v.vehicle_type?.name || "Unknown type")}</span>
                            </button>
                          </li>`,
                        )
                        .join("")}</ul>`
                    : `<p class="fleet-muted">${regSearch ? "No vehicles matched that registration." : "No matching vehicles."}</p>`
              }
            </section>`
          : ""
      }
      <section class="fleet-section">
        <h2 class="fleet-section-title">Companies · ${hire.length}</h2>
        <ul class="fleet-list">
          ${hire
            .map(
              (op) => `<li>
                <button type="button" class="fleet-list-btn" data-action="open-operator" data-slug="${esc(op.slug)}">
                  <span class="fleet-list-main">${esc(decodeHtml(op.name))}</span>
                  <span class="fleet-list-sub">${esc(operatorSubline(op))}</span>
                </button>
              </li>`,
            )
            .join("")}
        </ul>
      </section>
    `;
  }

  function renderHome(vehicleHits = []) {
    if (state.tab === "private-hire") return renderPrivateHireHome(vehicleHits);
    const ops = fleetCompanies(operatorsMatching(state.query));
    const q = compactQuery(state.query);
    const regSearch = looksLikeUkReg(state.query);
    const atRoutes = AT_ROUTES.filter((row) => {
      if (!q) return true;
      const meta = atLiveCache.meta.get(row.line) || row;
      return compactQuery(`${row.line} ${meta.name} ${meta.origin} ${meta.destination} alton`).includes(q);
    });
    const schoolRoutes = STAFFS_SCHOOL_ROUTES.filter((row) => {
      if (!q) return true;
      const meta = schoolLiveCache.meta.get(row.line) || row;
      return compactQuery(
        `${row.line} ${row.name} ${row.operator} ${meta.name || ""} school college academy`,
      ).includes(q);
    });
    const matchdayRoutes = STOKE_FC_SHUTTLE_ROUTES.filter((row) => {
      if (!q) return true;
      const meta = matchdayLiveCache.meta.get(row.line) || row;
      return compactQuery(
        `${row.line} ${row.name} ${row.operator} ${meta.name || ""} stoke city fc bet365 shuttle matchday potteries`,
      ).includes(q);
    });
    return `
      ${fleetNav([{ label: "Staffordshire" }, { label: homeCrumbLabel() }])}
      <h1 class="fleet-title">Staffordshire fleet</h1>
      <p class="fleet-lead">${regSearch ? "Registration search covers buses across the UK." : "Search bus companies and vehicles operating in Staffordshire."}</p>
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${
        state.query
          ? `<section class="fleet-section">
              <h2 class="fleet-section-title">${regSearch ? "Registration" : "Vehicles"} matching “${esc(state.query)}”</h2>
              ${
                state.loading
                  ? `<p class="fleet-muted">Searching…</p>`
                  : vehicleHits.length
                    ? `<ul class="fleet-list">${vehicleHits
                        .map(
                          (v) => `<li>
                            <button type="button" class="fleet-list-btn" data-action="open-vehicle" data-id="${esc(v.id)}">
                              ${vehicleMainHtml(v)}
                              <span class="fleet-list-sub">${esc(v.operator?.name || "")} · ${esc(v.vehicle_type?.name || "Unknown type")}</span>
                            </button>
                          </li>`,
                        )
                        .join("")}</ul>`
                    : `<p class="fleet-muted">${regSearch ? "No vehicles matched that registration." : "No Staffordshire vehicles matched."}</p>`
              }
            </section>`
          : ""
      }
      <section class="fleet-section">
        <h2 class="fleet-section-title">Look up a route</h2>
        <p class="fleet-muted fleet-section-note">Type a route number above (e.g. 23) or press a route number on a bus card / history row. Only Staffordshire services for that number are listed — not the same route number in other cities.</p>
      </section>
      <section class="fleet-section">
        <h2 class="fleet-section-title">Companies · ${ops.length}</h2>
        <ul class="fleet-list">
          ${ops
            .map(
              (op) => `<li>
                <button type="button" class="fleet-list-btn" data-action="open-operator" data-slug="${esc(op.slug)}">
                  <span class="fleet-list-main">${esc(decodeHtml(op.name))}</span>
                  <span class="fleet-list-sub">${esc(operatorSubline(op))}</span>
                </button>
              </li>`,
            )
            .join("")}
        </ul>
      </section>
      <section class="fleet-section">
        <h2 class="fleet-section-title">School &amp; college buses · ${schoolRoutes.length}</h2>
        <p class="fleet-muted fleet-section-note">Registered Staffordshire school services. Live on the map at school run times when operators publish AVL. Closed-door council contracts without a public feed are not trackable.</p>
        <ul class="fleet-list">
          ${schoolRoutes
            .map((row) => {
              const meta = schoolLiveCache.meta.get(row.line) || row;
              const live = meta.live || schoolLiveCache.byLine.get(row.line)?.length || 0;
              return `<li>
                <button type="button" class="fleet-list-btn" data-action="open-school-route" data-line="${esc(row.line)}">
                  <span class="fleet-list-main"><span class="fleet-route fleet-route-school">${esc(row.line)}</span> ${esc(row.name)}</span>
                  <span class="fleet-list-sub">${live ? `${live} live now · ${esc(row.operator)}` : `${esc(row.operator)} · school / college service`}</span>
                </button>
              </li>`;
            })
            .join("")}
        </ul>
      </section>
      <section class="fleet-section">
        <h2 class="fleet-section-title">Stoke City FC shuttles · ${matchdayRoutes.length}</h2>
        <p class="fleet-muted fleet-section-note">First Potteries BS1–BS2 matchday shuttles to bet365 Stadium. Live on the map when buses are running (usually from 90 minutes before kick-off).</p>
        <ul class="fleet-list">
          ${matchdayRoutes
            .map((row) => {
              const meta = matchdayLiveCache.meta.get(row.line) || row;
              const live = meta.live || matchdayLiveCache.byLine.get(row.line)?.length || 0;
              return `<li>
                <button type="button" class="fleet-list-btn" data-action="open-matchday-route" data-line="${esc(row.line)}">
                  <span class="fleet-list-main"><span class="fleet-route fleet-route-scfc">${esc(row.line)}</span> ${esc(row.name)}</span>
                  <span class="fleet-list-sub">${live ? `${live} live now · ${esc(row.operator)}` : `${esc(row.operator)} · matchday shuttle`}</span>
                </button>
              </li>`;
            })
            .join("")}
        </ul>
      </section>
      <section class="fleet-section">
        <h2 class="fleet-section-title">Alton Towers employee-only routes</h2>
        <ul class="fleet-list">
          ${atRoutes
            .map((row) => {
              const meta = atLiveCache.meta.get(row.line) || row;
              const live = meta.live || atLiveCache.byLine.get(row.line)?.length || 0;
              return `<li>
                <button type="button" class="fleet-list-btn" data-action="open-at-route" data-line="${esc(row.line)}">
                  <span class="fleet-list-main"><span class="fleet-route">${esc(row.line)}</span> ${esc(meta.origin || row.origin)} → ${esc(meta.destination || row.destination)}</span>
                  <span class="fleet-list-sub">${live ? `${live} live now · D&G Bus` : "D&G Bus employee-only service"}</span>
                </button>
              </li>`;
            })
            .join("")}
        </ul>
      </section>
    `;
  }

  function renderSchoolRoute() {
    const line = state.schoolLine;
    const meta = state.schoolMeta || schoolRouteMeta(line);
    return `
      ${fleetNav([
        { label: "Staffordshire", action: "home" },
        { label: homeCrumbLabel(), action: "home" },
        { label: "School & college buses" },
        { label: line },
      ])}
      <h1 class="fleet-title"><span class="fleet-route fleet-route-school">${esc(line)}</span> ${esc(meta.name || line)}</h1>
      <p class="fleet-lead">${esc(meta.operator || "School service")}${meta.noc ? ` · NOC ${esc(meta.noc)}` : ""}</p>
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${
        state.loading
          ? `<p class="fleet-muted">Loading live school buses…</p>`
          : state.schoolVehicles.length
            ? `<ul class="fleet-list">${state.schoolVehicles
                .map((entry) => {
                  const id = entry.btId || "";
                  return `<li class="fleet-list-row">
                    <button type="button" class="fleet-list-btn" data-action="${id ? "open-vehicle" : "track-at"}" data-id="${esc(id)}" data-reg="${esc(entry.regLabel)}" data-fleet="${esc(entry.fleet)}" data-line="${esc(entry.line || line)}">
                      <span class="fleet-list-main">${esc(entry.fleet || "—")} ${plateHtml(entry.regLabel)}${lastTrackedHtml({ trackedAt: entry.recordedAtTime })}<span class="fleet-last-route fleet-last-route-school">${esc(entry.line)} · ${esc(entry.dest)}</span></span>
                      <span class="fleet-list-sub">School / college service${entry.operator ? ` · ${esc(entry.operator)}` : ""}</span>
                    </button>
                    <button type="button" class="fleet-link-btn fleet-list-map" data-action="play-journey" data-trip-id="" data-journey-id="" data-vehicle-id="${esc(id)}" data-trail-key="${esc(id)}" data-reg="${esc(entry.regLabel)}" data-line="${esc(entry.line)}" data-dest="${esc(entry.dest)}" data-datetime="${esc(entry.recordedAtTime || "")}">Map</button>
                  </li>`;
                })
                .join("")}</ul>`
            : `<p class="fleet-muted">No buses currently tracked on ${esc(line)}. School services usually appear around morning and afternoon run times.</p>`
      }
    `;
  }

  function renderMatchdayRoute() {
    const line = state.matchdayLine || "BS1";
    const meta = state.matchdayMeta || stokeFcRouteMeta(line);
    const ttHtml = scfcTimetableHtml(line, { esc });
    return `
      ${fleetNav([
        { label: "Staffordshire", action: "home" },
        { label: homeCrumbLabel(), action: "home" },
        { label: "Stoke City FC shuttles", action: "home" },
        { label: line },
      ])}
      <h1 class="fleet-title"><span class="fleet-route fleet-route-scfc">${esc(line)}</span> Stoke City FC shuttle</h1>
      <p class="fleet-lead">${esc(meta.name || "")}${meta.note ? ` · ${esc(meta.note)}` : ""}</p>
      <p class="fleet-muted fleet-section-note">${esc(meta.operator || "First Potteries")}${meta.noc ? ` · NOC ${esc(meta.noc)}` : ""} · Glebe Street &amp; Hanley to bet365 Stadium</p>
      ${ttHtml}
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${
        state.loading
          ? `<p class="fleet-muted">Loading matchday shuttles…</p>`
          : state.matchdayVehicles.length
            ? `<ul class="fleet-list">${state.matchdayVehicles
                .map((entry) => {
                  const id = entry.btId || "";
                  return `<li class="fleet-list-row">
                    <button type="button" class="fleet-list-btn" data-action="${id ? "open-vehicle" : "track-at"}" data-id="${esc(id)}" data-reg="${esc(entry.regLabel)}" data-fleet="${esc(entry.fleet)}" data-line="${esc(entry.line || line)}">
                      <span class="fleet-list-main">${esc(entry.fleet || "—")} ${plateHtml(entry.regLabel)}${lastTrackedHtml({ trackedAt: entry.recordedAtTime })}<span class="fleet-last-route fleet-last-route-scfc">${esc(entry.line)} · ${esc(entry.dest)}</span></span>
                      <span class="fleet-list-sub">Stoke City FC shuttle${entry.operator ? ` · ${esc(entry.operator)}` : ""}</span>
                    </button>
                    <button type="button" class="fleet-link-btn fleet-list-map" data-action="play-journey" data-trip-id="" data-journey-id="" data-vehicle-id="${esc(id)}" data-trail-key="${esc(id)}" data-reg="${esc(entry.regLabel)}" data-line="${esc(entry.line)}" data-dest="${esc(entry.dest)}" data-datetime="${esc(entry.recordedAtTime || "")}">Map</button>
                  </li>`;
                })
                .join("")}</ul>`
            : `<p class="fleet-muted">No ${esc(line)} shuttles tracked right now. They usually appear from about 90 minutes before Stoke City home kick-off.</p>`
      }
    `;
  }

  function renderAtRoute() {
    const line = state.atLine;
    const meta = state.atMeta || AT_ROUTES.find((row) => row.line === line) || { line };
    return `
      ${fleetNav([
        { label: "Staffordshire", action: "home" },
        { label: homeCrumbLabel(), action: "home" },
        { label: "Alton Towers employee-only" },
        { label: line },
      ])}
      <h1 class="fleet-title"><span class="fleet-route">${esc(line)}</span> ${esc(meta.name || line)}</h1>
      <p class="fleet-lead">${esc(meta.origin || "")} → ${esc(meta.destination || "Alton Towers")}${meta.via?.length ? ` · via ${esc(meta.via.join(", "))}` : ""}</p>
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${
        state.loading
          ? `<p class="fleet-muted">Loading live AT buses…</p>`
          : state.atVehicles.length
            ? `<ul class="fleet-list">${state.atVehicles
                .map((entry) => {
                  const id = entry.btId || "";
                  const trailKey = entry.ref ? `staff-${entry.ref}` : "";
                  return `<li class="fleet-list-row">
                    <button type="button" class="fleet-list-btn" data-action="${id ? "open-vehicle" : "track-at"}" data-id="${esc(id)}" data-reg="${esc(entry.regLabel)}" data-fleet="${esc(entry.fleet)}" data-ref="${esc(entry.ref)}" data-line="${esc(entry.line || line)}">
                      <span class="fleet-list-main">${esc(entry.fleet || "—")} ${plateHtml(entry.regLabel)}${lastTrackedHtml({ trackedAt: entry.recordedAtTime })}<span class="fleet-last-route fleet-last-route-at">${esc(entry.line)} · ${esc(entry.dest)}</span></span>
                      <span class="fleet-list-sub">${entry.direction ? esc(entry.direction) + " · " : ""}D&G Bus employee-only</span>
                    </button>
                    <button type="button" class="fleet-link-btn fleet-list-map" data-action="play-journey" data-trip-id="" data-journey-id="" data-vehicle-id="${esc(id)}" data-trail-key="${esc(trailKey)}" data-reg="${esc(entry.regLabel)}" data-line="${esc(entry.line)}" data-dest="${esc(entry.dest)}" data-datetime="${esc(entry.recordedAtTime || "")}">Map</button>
                  </li>`;
                })
                .join("")}</ul>`
            : `<p class="fleet-muted">No buses currently tracked on ${esc(line)}.</p>`
      }
    `;
  }

  function renderRoute() {
    const line = state.routeLine || "Route";
    const service = state.routeService;
    const dates = [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(ukDateKey(d));
    }

    const busListHtml = state.loading
      ? `<p class="fleet-muted">Loading buses…</p>`
      : state.routeVehicles.length
        ? `<ul class="fleet-list">${state.routeVehicles
            .map((entry) => {
              const trailKey = entry.id || "";
              const lineCode = entry.route_name || service?.line_name || line;
              return `<li class="fleet-list-row">
                <button type="button" class="fleet-list-btn" data-action="open-vehicle" data-id="${esc(entry.id)}" data-line="${esc(lineCode)}">
                  <span class="fleet-list-main">${esc(entry.fleet_code || "—")} ${plateHtml(entry.reg)}${lastTrackedHtml({ trackedAt: entry.datetime })}${lastRouteHtml({ route: lineCode, dest: entry.destination, noLink: true })}</span>
                  <span class="fleet-list-sub">${esc(entry.destination || "No destination")} · ${esc(formatShortTime(entry.datetime) || "")}</span>
                </button>
                ${
                  entry.trip_id || entry.journey_id
                    ? `<button type="button" class="fleet-link-btn fleet-list-map" data-action="play-journey" data-trip-id="${esc(entry.trip_id || "")}" data-journey-id="${esc(entry.journey_id || "")}" data-vehicle-id="${esc(entry.id)}" data-trail-key="${esc(trailKey)}" data-reg="${esc(entry.reg)}" data-line="${esc(lineCode)}" data-dest="${esc(entry.destination || "")}" data-datetime="${esc(entry.datetime || "")}">Map</button>`
                    : ""
                }
              </li>`;
            })
            .join("")}</ul>`
        : `<p class="fleet-muted">No buses recorded on route ${esc(line)} for ${esc(formatLongDate(state.date))}.</p>`;

    if (!service) {
      return `
        ${fleetNav([
          { label: "Staffordshire", action: "home" },
          { label: homeCrumbLabel(), action: "home" },
          { label: `Route ${line}` },
        ])}
        <h1 class="fleet-title">Route ${routeNumberBtn(line)}</h1>
        <p class="fleet-lead">Staffordshire buses that have run route <strong>${esc(line)}</strong></p>
        <label class="fleet-date-label">
          <span class="sr-only">Date</span>
          <select id="fleet-route-date" class="fleet-date">
            ${dates
              .map((key) => `<option value="${esc(key)}" ${key === state.date ? "selected" : ""}>${esc(formatLongDate(key))}</option>`)
              .join("")}
          </select>
        </label>
        ${
          state.routeLiveCount
            ? `<p class="fleet-muted">${state.routeLiveCount} live on the map right now</p>`
            : ""
        }
        ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
        <section class="fleet-section">
          <h2 class="fleet-section-title">Buses · ${state.loading ? "…" : state.routeVehicles.length}</h2>
          ${busListHtml}
        </section>
        ${
          state.routeServices.length > 1
            ? `<section class="fleet-section">
                <h2 class="fleet-section-title">Services · ${state.routeServices.length}</h2>
                <p class="fleet-muted fleet-section-note">Filter to one operator / corridor if needed.</p>
                <ul class="fleet-list">${state.routeServices
                  .map((row) => {
                    const ops = serviceOperatorLabel(row);
                    return `<li>
                      <button type="button" class="fleet-list-btn" data-action="open-route-service" data-arg="${esc(row.id)}">
                        <span class="fleet-list-main"><span class="fleet-route">${esc(row.line_name || line)}</span> ${esc(row.description || "")}</span>
                        <span class="fleet-list-sub">${esc(ops || "Operator unknown")}${row.region_id ? ` · ${esc(row.region_id)}` : ""}</span>
                      </button>
                    </li>`;
                  })
                  .join("")}</ul>
              </section>`
            : ""
        }
      `;
    }

    const ops = serviceOperatorLabel(service);
    return `
      ${fleetNav([
        { label: "Staffordshire", action: "home" },
        { label: homeCrumbLabel(), action: "home" },
        { label: `Route ${line}`, action: "open-route-line", line },
        { label: service.description || service.line_name || line },
      ])}
      <h1 class="fleet-title">${routeNumberBtn(service.line_name || line)} ${esc(service.description || "")}</h1>
      <p class="fleet-lead">${esc(ops || "Service")} · buses that ran this route</p>
      <label class="fleet-date-label">
        <span class="sr-only">Date</span>
        <select id="fleet-route-date" class="fleet-date">
          ${dates
            .map((key) => `<option value="${esc(key)}" ${key === state.date ? "selected" : ""}>${esc(formatLongDate(key))}</option>`)
            .join("")}
        </select>
      </label>
      ${
        state.routeLiveCount
          ? `<p class="fleet-muted">${state.routeLiveCount} live on the map right now</p>`
          : ""
      }
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${busListHtml}
    `;
  }

  function renderOperator() {
    const op = state.operator;
    if (!op) return renderHome();
    return `
      ${fleetNav([
        { label: "Staffordshire", action: "home" },
        { label: homeCrumbLabel(), action: "home" },
        { label: decodeHtml(op.name) },
        { label: "Vehicles" },
      ])}
      <h1 class="fleet-title">${esc(decodeHtml(op.name))}</h1>
      <p class="fleet-lead">${
        isPrivateHire(op)
          ? esc(op.note || "Private hire / coach travel")
          : op.noc
            ? `Operator code ${esc(op.noc)} · ${state.vehicleCount} vehicles`
            : "No vehicle list available for this operator yet."
      }</p>
      ${
        isPrivateHire(op) && op.noc
          ? `<p class="fleet-muted fleet-section-note">Live coaches and buses appear on the map when this operator’s public feed is tracking them.</p>`
          : ""
      }
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${
        !op.noc
          ? `<div class="fleet-private-note">
              <p class="fleet-muted">${
                isPrivateHire(op)
                  ? "This operator does not publish a public live vehicle feed, so coaches will not appear on the map unless that changes."
                  : "Try searching the registration or fleet number above."
              }</p>
              ${
                op.website
                  ? `<p><a class="fleet-ext-link" href="${esc(op.website)}" target="_blank" rel="noopener noreferrer">Visit ${esc(decodeHtml(op.name))} website</a></p>`
                  : ""
              }
            </div>`
          : `${
              op.website
                ? `<p><a class="fleet-ext-link" href="${esc(op.website)}" target="_blank" rel="noopener noreferrer">Visit ${esc(decodeHtml(op.name))} website</a></p>`
                : ""
            }
            ${
              state.loading && !state.vehicles.length
                ? `<p class="fleet-muted">Loading fleet…</p>`
                : state.vehicles.length
                  ? `<ul class="fleet-list">${state.vehicles
                      .map(
                        (v) => `<li>
                          <button type="button" class="fleet-list-btn" data-action="open-vehicle" data-id="${esc(v.id)}">
                            ${vehicleMainHtml(v)}
                            <span class="fleet-list-sub">${esc(v.vehicle_type?.name || "Unknown type")}${v.livery?.name ? ` · ${esc(v.livery.name)}` : ""}</span>
                          </button>
                        </li>`,
                      )
                      .join("")}</ul>`
                  : `<p class="fleet-muted">No active vehicles found for this operator.</p>`
            }`
      }
    `;
  }

  function renderVehicle() {
    const v = state.vehicle;
    if (!v) return renderHome();
    const opName = v.operator?.name || "Operator";
    const opSlug = v.operator?.slug || "";
    const type = [
      v.vehicle_type?.name,
      v.vehicle_type?.double_decker ? "Double decker" : v.vehicle_type ? "Single decker" : "",
      v.vehicle_type?.fuel,
    ]
      .filter(Boolean)
      .join(" · ");
    const vehicleCrumbs = state.routeService
      ? [
          { label: "Staffordshire", action: "home" },
          { label: homeCrumbLabel(), action: "home" },
          { label: `Route ${state.routeLine || state.routeService.line_name}`, action: "open-route-line", line: state.routeLine || state.routeService.line_name },
          {
            label: state.routeService.description || state.routeService.line_name || "Service",
            action: "open-route-service",
            arg: String(state.routeService.id),
          },
          { label: v.fleet_code || v.reg || "Vehicle" },
        ]
      : state.schoolLine
      ? [
          { label: "Staffordshire", action: "home" },
          { label: homeCrumbLabel(), action: "home" },
          { label: "School & college buses", action: "home" },
          { label: state.schoolLine, action: "open-school-route", line: state.schoolLine },
          { label: v.fleet_code || v.reg || "Vehicle" },
        ]
      : state.matchdayLine
        ? [
            { label: "Staffordshire", action: "home" },
            { label: homeCrumbLabel(), action: "home" },
            { label: "Stoke City FC shuttles", action: "home" },
            { label: state.matchdayLine, action: "open-matchday-route", line: state.matchdayLine },
            { label: v.fleet_code || v.reg || "Vehicle" },
          ]
      : state.atLine
        ? [
            { label: "Staffordshire", action: "home" },
            { label: homeCrumbLabel(), action: "home" },
            { label: "Alton Towers", action: "home" },
            { label: state.atLine, action: "open-at-route", line: state.atLine },
            { label: v.fleet_code || v.reg || "Vehicle" },
          ]
        : [
            { label: "Staffordshire", action: "home" },
            { label: homeCrumbLabel(), action: "home" },
            { label: opName, action: "open-operator", arg: opSlug },
            { label: "Vehicles", action: "open-operator", arg: opSlug },
            { label: v.fleet_code || v.reg || "Vehicle" },
          ];
    return `
      ${fleetNav(vehicleCrumbs)}
      <h1 class="fleet-title fleet-vehicle-title">
        <span>${esc(v.fleet_code || v.fleet_number || "")}</span>
        ${plateHtml(v.reg)}
        ${lastTrackedHtml(
          v.lastRoute ||
            (state.journeys?.[0]
              ? { trackedAt: state.journeys[0].datetime, date: state.journeys[0].date }
              : null),
        )}
        ${lastRouteHtml(
          v.lastRoute ||
            (state.journeys?.[0]
              ? { route: state.journeys[0].route_name, dest: state.journeys[0].destination }
              : null),
        )}
      </h1>
      <div class="fleet-meta-grid">
        <div><span class="fleet-meta-label">Livery</span>${v.livery ? liverySwatch(v.livery) : `<span class="fleet-muted">—</span>`}</div>
        <div><span class="fleet-meta-label">Branding</span><span>${esc(v.branding || "—")}</span></div>
        <div><span class="fleet-meta-label">Type</span><span>${esc(type || "—")}</span></div>
        <div><span class="fleet-meta-label">Previous reg</span><span>${esc(v.previous_reg || "—")}</span></div>
      </div>
      <div class="fleet-actions">
        <button type="button" class="fleet-track-btn" data-action="track-vehicle" data-id="${esc(v.id)}" data-reg="${esc(v.reg || "")}" data-fleet="${esc(v.fleet_code || "")}">Track this bus</button>
      </div>
      ${renderVehiclePhoto(v)}
      <label class="fleet-date">
        <span class="sr-only">Date</span>
        <select id="fleet-date">${Array.from({ length: 14 }, (_, i) => {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const key = ukDateKey(d);
          return `<option value="${esc(key)}" ${key === state.date ? "selected" : ""}>${esc(formatLongDate(key))}</option>`;
        }).join("")}</select>
      </label>
      ${
        state.lineFilter
          ? `<p class="fleet-lead">Showing route <span class="fleet-route">${esc(state.lineFilter)}</span> only</p>`
          : ""
      }
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${
        state.loading
          ? `<p class="fleet-muted">Loading journeys…</p>`
          : state.journeys.length
            ? `<table class="fleet-table">
                <thead><tr><th>Route</th><th>Trip</th><th>To</th><th></th></tr></thead>
                <tbody>
                  ${state.journeys
                    .map((row) => {
                      const time = formatJourneyTime(row.datetime);
                      const line =
                        (row.route_name && !/^div/i.test(String(row.route_name))
                          ? row.route_name
                          : "") ||
                        row.extracted_route ||
                        row.route_name ||
                        "";
                      return `<tr>
                        <td>${routeNumberBtn(line, { className: row.atLive ? "fleet-route-at" : "" })}${row.atLive || row.live ? ` <span class="fleet-live-tag">live</span>` : ""}${row.diverted ? ` <span class="fleet-divert-tag">div</span>` : ""}</td>
                        <td class="fleet-trip"><span>${esc(time)}</span><span class="fleet-trip-alt">${esc(time)}</span></td>
                        <td>${esc(row.destination || "—")}${row.diverted ? ` <span class="fleet-muted">(diverted)</span>` : ""}</td>
                        <td class="fleet-row-actions">
                          ${
                            (() => {
                              const trailKey = row.trailKey || String(v.id || "");
                              if (!row.trip_id && !trailKey) return "";
                              return `<button type="button" class="fleet-link-btn" data-action="play-journey" data-trip-id="${esc(row.trip_id || "")}" data-journey-id="${esc(row.id || "")}" data-vehicle-id="${esc(v.id)}" data-trail-key="${esc(trailKey)}" data-reg="${esc(v.reg || "")}" data-line="${esc(line)}" data-dest="${esc(row.destination || "")}" data-datetime="${esc(row.datetime || "")}">Map</button>`;
                            })()
                          }
                        </td>
                      </tr>`;
                    })
                    .join("")}
                </tbody>
              </table>`
            : `<p class="fleet-muted">${
                state.lineFilter
                  ? `No ${esc(state.lineFilter)} journeys recorded for this date.`
                  : "No journeys recorded for this date."
              }</p>`
      }
    `;
  }

  function render() {
    syncFleetTabUi();
    if (state.view === "vehicle") root.innerHTML = renderVehicle();
    else if (state.view === "operator") root.innerHTML = renderOperator();
    else if (state.view === "route") root.innerHTML = renderRoute();
    else if (state.view === "at-route") root.innerHTML = renderAtRoute();
    else if (state.view === "school-route") root.innerHTML = renderSchoolRoute();
    else if (state.view === "matchday-route") root.innerHTML = renderMatchdayRoute();
    else root.innerHTML = renderHome(state.vehicleHits || []);
  }

  function setTab(tab) {
    const next = tab === "private-hire" ? "private-hire" : "fleet";
    if (state.tab === next && state.view === "home") {
      syncFleetTabUi();
      return;
    }
    state.tab = next;
    const panel = root.closest("#fleet-panel");
    const input = panel?.querySelector("#fleet-query");
    if (input) input.value = "";
    return showHome("");
  }

  async function showHome(query = state.query) {
    state.view = "home";
    state.query = query;
    state.operator = null;
    state.vehicle = null;
    state.lineFilter = "";
    state.atLine = "";
    state.atVehicles = [];
    state.atMeta = null;
    state.schoolLine = "";
    state.schoolVehicles = [];
    state.schoolMeta = null;
    state.matchdayLine = "";
    state.matchdayVehicles = [];
    state.matchdayMeta = null;
    state.routeLine = "";
    state.routeServices = [];
    state.routeService = null;
    state.routeVehicles = [];
    state.routeLiveCount = 0;
    state.journeys = [];
    state.allJourneys = [];
    state.vehicleHits = [];
    if (state.tab === "fleet") {
      await Promise.all([
        ensureAtLive().catch(() => {}),
        ensureSchoolLive().catch(() => {}),
      ]);
    }
    if (compactQuery(query).length >= 2) {
      setLoading(true);
      try {
        state.vehicleHits = await searchStaffsVehicles(query);
        setLoading(false);
        attachLastRoutes(state.vehicleHits, () => {
          if (state.view === "home") render();
        });
      } catch (error) {
        setLoading(false, error.message || "Search failed");
      }
      return;
    }
    render();
  }

  async function showRouteLine(line, date = state.date) {
    const code = String(line || "").trim();
    if (!code) return;
    // School / matchday / AT shortcuts stay on their dedicated views.
    const upper = code.toUpperCase();
    if (AT_LINE_SET.has(upper)) return showAtRoute(upper);
    if (SCHOOL_LINE_SET.has(upper)) return showSchoolRoute(upper);
    if (STOKE_FC_LINE_SET.has(upper) || STOKE_FC_LINE_SET.has(normalizeStokeFcLine(upper))) {
      return showMatchdayRoute(normalizeStokeFcLine(upper) || upper);
    }
    state.tab = "fleet";
    state.view = "route";
    state.routeLine = code;
    state.routeService = null;
    state.routeVehicles = [];
    state.routeLiveCount = 0;
    state.routeServices = [];
    state.date = date || ukDateKey();
    const preferOperatorNoc =
      state._routePreferNoc ||
      state.vehicle?.operator?.noc ||
      state.vehicle?.operator?.id ||
      "";
    state._routePreferNoc = "";
    state.vehicle = null;
    state.operator = null;
    state.atLine = "";
    state.schoolLine = "";
    state.matchdayLine = "";
    state.lineFilter = code;
    setLoading(true);
    try {
      const services = await searchServicesByLine(code, { preferOperatorNoc });
      state.routeServices = services;
      if (!services.length) {
        state.routeVehicles = [];
        state.routeLiveCount = 0;
        setLoading(false, `No Staffordshire services found for route ${code}`);
        return;
      }
      const [vehicles, liveBatches] = await Promise.all([
        fetchLineJourneyVehicles(services, state.date),
        Promise.all(services.slice(0, 8).map((row) => fetchLiveServiceVehicles(row.id).catch(() => []))),
      ]);
      state.routeVehicles = vehicles;
      const liveIds = new Set();
      for (const batch of liveBatches) {
        for (const bus of batch) {
          if (bus?.id != null) liveIds.add(String(bus.id));
        }
      }
      state.routeLiveCount = liveIds.size;
      setLoading(false);
    } catch (error) {
      state.routeServices = [];
      state.routeVehicles = [];
      state.routeLiveCount = 0;
      setLoading(false, error.message || "Could not find that route");
    }
  }

  async function showRouteService(serviceId, date = state.date) {
    const id = String(serviceId || "").trim();
    if (!id) return;
    state.tab = "fleet";
    state.view = "route";
    state.date = date || ukDateKey();
    state.vehicle = null;
    setLoading(true);
    try {
      let service = state.routeServices.find((row) => String(row.id) === id) || state.routeService;
      if (!service || String(service.id) !== id) {
        service = await fetchJson(`/api/bt-services/${encodeURIComponent(id)}/`);
      }
      if (!state.routeServices.some((row) => String(row.id) === id)) {
        state.routeServices = [service, ...state.routeServices];
      }
      state.routeService = service;
      state.routeLine = service.line_name || state.routeLine;
      state.lineFilter = state.routeLine;
      const [vehicles, live] = await Promise.all([
        fetchServiceJourneyVehicles(id, state.date),
        fetchLiveServiceVehicles(id),
      ]);
      state.routeVehicles = vehicles;
      state.routeLiveCount = live.length;
      setLoading(false);
    } catch (error) {
      state.routeVehicles = [];
      state.routeLiveCount = 0;
      setLoading(false, error.message || "Could not load route buses");
    }
  }

  async function showAtRoute(line) {
    const code = String(line || "").toUpperCase();
    if (!AT_LINE_SET.has(code)) return showHome();
    state.view = "at-route";
    state.atLine = code;
    state.lineFilter = "";
    state.vehicle = null;
    state.operator = null;
    state.schoolLine = "";
    state.schoolVehicles = [];
    state.matchdayLine = "";
    state.matchdayVehicles = [];
    state.journeys = [];
    state.allJourneys = [];
    setLoading(true);
    try {
      const cache = await ensureAtLive(0);
      state.atMeta = cache.meta.get(code) || AT_ROUTES.find((row) => row.line === code) || { line: code };
      const entries = [...(cache.byLine.get(code) || [])];
      await Promise.all(entries.map((entry) => resolveAtVehicleId(entry)));
      state.atVehicles = entries;
      setLoading(false);
    } catch (error) {
      setLoading(false, error.message || "Could not load AT route");
    }
  }

  async function showSchoolRoute(line) {
    const code = String(line || "").toUpperCase();
    if (!SCHOOL_LINE_SET.has(code)) return showHome();
    state.view = "school-route";
    state.schoolLine = code;
    state.matchdayLine = "";
    state.matchdayVehicles = [];
    state.lineFilter = "";
    state.tab = "fleet";
    state.vehicle = null;
    state.operator = null;
    state.atLine = "";
    state.atVehicles = [];
    state.journeys = [];
    state.allJourneys = [];
    setLoading(true);
    try {
      const cache = await ensureSchoolLive(0);
      state.schoolMeta = cache.meta.get(code) || schoolRouteMeta(code);
      state.schoolVehicles = [...(cache.byLine.get(code) || [])];
      setLoading(false);
    } catch (error) {
      setLoading(false, error.message || "Could not load school route");
    }
  }

  async function showMatchdayRoute(line) {
    const code = normalizeStokeFcLine(line) || "BS1";
    if (!STOKE_FC_LINE_SET.has(code) && !STOKE_FC_SHUTTLE_ROUTES.some((row) => row.line === code)) {
      return showHome();
    }
    state.view = "matchday-route";
    state.matchdayLine = code;
    state.schoolLine = "";
    state.schoolVehicles = [];
    state.lineFilter = "";
    state.tab = "fleet";
    state.vehicle = null;
    state.operator = null;
    state.atLine = "";
    state.atVehicles = [];
    state.journeys = [];
    state.allJourneys = [];
    setLoading(true);
    try {
      const cache = await ensureMatchdayLive(0);
      state.matchdayMeta = cache.meta.get(code) || stokeFcRouteMeta(code);
      state.matchdayVehicles = [...(cache.byLine.get(code) || [])];
      setLoading(false);
    } catch (error) {
      setLoading(false, error.message || "Could not load matchday shuttle");
    }
  }

  async function showOperator(slug, { reset = true } = {}) {
    const op = STAFFS_OPERATORS.find((row) => row.slug === slug);
    if (!op) return showHome();
    if (isPrivateHire(op) && !op.alsoFleet) state.tab = "private-hire";
    else if (!isPrivateHire(op)) state.tab = "fleet";
    state.view = "operator";
    state.operator = op;
    state.vehicle = null;
    state.lineFilter = "";
    state.schoolLine = "";
    state.atLine = "";
    state.journeys = [];
    state.allJourneys = [];
    if (reset) {
      state.vehicles = [];
      state.vehicleOffset = 0;
      state.vehicleCount = 0;
    }
    if (!op.noc) {
      render();
      return;
    }
    setLoading(true);
    try {
      const data = await fetchAllOperatorVehicles(op.noc, { search: state.query });
      const batch = data.results || [];
      state.vehicles = batch;
      state.vehicleCount = data.count || batch.length;
      state.vehicleOffset = batch.length;
      setLoading(false);
      attachLastRoutes(batch, () => {
        if (state.view === "operator") render();
      });
    } catch (error) {
      setLoading(false, error.message || "Could not load vehicles");
    }
  }

  async function showVehicle(id, date = state.date, opts = {}) {
    const hasLineOpt = Object.prototype.hasOwnProperty.call(opts, "line");
    if (hasLineOpt) {
      state.lineFilter = String(opts.line || "").trim();
    } else if (String(state.vehicle?.id) !== String(id)) {
      state.lineFilter = state.schoolLine || state.matchdayLine || state.atLine || "";
    }
    state.photo = null;
    state.photoPending = false;
    state.photoStatus = "";
    state.photoLoading = true;
    setLoading(true);
    try {
      const vehicle = await fetchVehicle(id);
      lastRouteCache.delete(String(vehicle.id));
      vehicle.lastRoute = await fetchLastRoute(vehicle);
      state.view = "vehicle";
      state.vehicle = vehicle;
      state.date = date;
      state.operator =
        STAFFS_OPERATORS.find((op) => op.slug === vehicle.operator?.slug || op.noc === vehicle.operator?.id) ||
        {
          name: vehicle.operator?.name || "Operator",
          slug: vehicle.operator?.slug || "",
          noc: vehicle.operator?.id || null,
        };
      let liveBus = null;
      try {
        const liveRes = await fetch(`/api/vehicles?id=${encodeURIComponent(vehicle.id)}`);
        if (liveRes.ok) {
          const live = await liveRes.json();
          const rows = Array.isArray(live) ? live : [];
          liveBus =
            rows.find((item) => String(item.id) === String(vehicle.id)) || rows[0] || null;
        }
      } catch {
        // Live AVL optional — history still loads from journeys.
      }
      let journeys = (await fetchVehicleJourneys(vehicle.id, date)).map((row) =>
        enrichJourneyRow(row, liveBus),
      );
      if (liveBus && date === ukDateKey()) {
        const liveRow = liveVehicleAsHistoryRow(liveBus, {
          trailKey: String(vehicle.id || ""),
        });
        if (liveRow) {
          journeys = mergeLiveHistoryRow(journeys, liveRow);
          if (liveRow.diverted || !vehicle.lastRoute?.route) {
            vehicle.lastRoute = {
              route: liveRow.route_name || extractRouteFromVehicle(liveBus) || "",
              dest: liveBus.destination || liveRow.destination || "",
              live: true,
              diverted: liveRow.diverted,
              trackedAt: liveBus.datetime || new Date().toISOString(),
            };
          }
        }
      }
      const at = matchAtLive(vehicle);
      if (at && date === ukDateKey()) {
        const trailKey = at.ref ? `staff-${at.ref}` : "";
        const tripMatch = journeys.find(
          (row) => String(row.route_name || "").toUpperCase() === at.line && row.trip_id,
        );
        let found = false;
        journeys = journeys.map((row) => {
          if (String(row.route_name || "").toUpperCase() !== at.line) return row;
          found = true;
          return {
            ...row,
            atLive: true,
            trailKey: trailKey || row.trailKey || "",
            trip_id: row.trip_id || tripMatch?.trip_id || null,
          };
        });
        if (!found) {
          journeys = [
            {
              id: `at-live-${at.line}`,
              route_name: at.line,
              destination: at.dest,
              datetime: at.recordedAtTime || new Date().toISOString(),
              trip_id: tripMatch?.trip_id || null,
              trailKey,
              atLive: true,
            },
            ...journeys,
          ];
        }
        vehicle.lastRoute = {
          route: at.line,
          dest: at.dest,
          live: true,
          at: true,
          trackedAt: at.recordedAtTime || new Date().toISOString(),
        };
      } else if (!vehicle.lastRoute && journeys[0]) {
        vehicle.lastRoute = {
          route: journeys[0].route_name || "",
          dest: journeys[0].destination || "",
          trackedAt: journeys[0].datetime || "",
          date: journeys[0].date || "",
        };
      } else if (vehicle.lastRoute && !vehicle.lastRoute.trackedAt && journeys[0]) {
        vehicle.lastRoute = {
          ...vehicle.lastRoute,
          trackedAt: journeys[0].datetime || vehicle.lastRoute.trackedAt || "",
          date: journeys[0].date || vehicle.lastRoute.date || "",
        };
      }
      // Allow Map on finished journeys via tracked GPS even without a trip shape.
      journeys = journeys.map((row) => ({
        ...row,
        trailKey: row.trailKey || (at?.ref ? `staff-${at.ref}` : "") || String(vehicle.id || ""),
      }));
      state.allJourneys = journeys;
      state.journeys = filterJourneysByLine(journeys, state.lineFilter);
      setLoading(false);
      loadVehiclePhoto(vehicle);
    } catch (error) {
      setLoading(false, error.message || "Could not load vehicle");
    }
  }

  root.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn || !root.contains(btn)) return;
    const action = btn.dataset.action;
    if (action === "open-route-line") {
      event.preventDefault();
      event.stopPropagation();
      const noc = state.vehicle?.operator?.noc || state.vehicle?.operator?.id || "";
      if (noc) state._routePreferNoc = noc;
      showRouteLine(btn.dataset.line || state.routeLine);
      return;
    }
    if (action === "upload-photo") {
      event.preventDefault();
      event.stopPropagation();
      beginFleetPhotoUpload(btn);
      return;
    }
    if (action === "home") showHome("");
    if (action === "back") goBack();
    if (action === "open-operator") showOperator(btn.dataset.arg || btn.dataset.slug);
    if (action === "open-at-route") showAtRoute(btn.dataset.line);
    if (action === "open-school-route") showSchoolRoute(btn.dataset.line);
    if (action === "open-matchday-route") showMatchdayRoute(btn.dataset.line);
    if (action === "open-route-service") showRouteService(btn.dataset.arg);
    if (action === "open-vehicle") {
      showVehicle(btn.dataset.id, state.date, { line: btn.dataset.line || state.routeLine || "" });
    }
    if (action === "more-vehicles" && state.operator) showOperator(state.operator.slug, { reset: false });
    if (action === "track-vehicle" || action === "track-at") {
      onTrackVehicle?.({
        id: btn.dataset.id,
        reg: btn.dataset.reg,
        fleet: btn.dataset.fleet,
        ref: btn.dataset.ref,
        line: btn.dataset.line,
      });
    }
    if (action === "play-journey") {
      const line = String(btn.dataset.line || "").trim();
      if (line && state.view === "vehicle") {
        state.lineFilter = line;
        state.journeys = filterJourneysByLine(state.allJourneys || [], line);
        render();
      }
      onPlayJourney?.({
        tripId: btn.dataset.tripId,
        journeyId: btn.dataset.journeyId,
        vehicleId: btn.dataset.vehicleId,
        trailKey: btn.dataset.trailKey,
        reg: btn.dataset.reg,
        line: btn.dataset.line,
        dest: btn.dataset.dest,
        datetime: btn.dataset.datetime,
      });
    }
  });

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const link = event.target.closest?.("[data-action='open-route-line']");
    if (!link || !root.contains(link)) return;
    event.preventDefault();
    showRouteLine(link.dataset.line || state.routeLine);
  });

  root.addEventListener("change", (event) => {
    if (event.target.id === "fleet-date" && state.vehicle) {
      showVehicle(state.vehicle.id, event.target.value);
      return;
    }
    if (event.target.id === "fleet-route-date") {
      if (state.routeService) showRouteService(state.routeService.id, event.target.value);
      else if (state.routeLine) showRouteLine(state.routeLine, event.target.value);
    }
  });

  const panel = root.closest("#fleet-panel");
  panel?.querySelectorAll(".fleet-bottom-tab").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.fleetTab));
  });

  showHome("");

  return {
    showHome,
    showOperator,
    showVehicle,
    showAtRoute,
    showSchoolRoute,
    showMatchdayRoute,
    showRouteLine,
    showRouteService,
    setTab,
    search(query) {
      return showHome(query);
    },
    searchRoute(line) {
      return showRouteLine(line);
    },
    getState: () => ({ ...state }),
  };
}
