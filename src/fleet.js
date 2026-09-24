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
  { name: "D & G Bus", slug: "d-g-coach-bus", noc: "DAGC", note: "Includes AT1–AT3 Alton Towers staff · Ticketer OOS / dead runs" },
  { name: "Diamond Bus", slug: "diamond-bus", noc: "DIAM" },
  { name: "Diamond Bus East Midlands", slug: "midland-classic", noc: "MDCL" },
  { name: "Evolve Bus & Coach", slug: "evolve-bus-coach", noc: "EVOL", kind: "private-hire" },
  { name: "First Potteries", slug: "first-potteries", noc: "FPOT", note: "Includes BS1–BS2 matchday shuttles · Ticketer OOS / dead runs" },
  { name: "Flexibus", slug: "flexibus", noc: null },
  { name: "FlixBus", slug: "flixbus", noc: "FLIX", note: "UK + Europe coaches · live map + GPS history" },
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
  { name: "National Express", slug: "national-express", noc: "NATX", note: "Coach routes · timetables & live map" },
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

/** Operators where Map shows only that one bus + route (server-recorded tails). */
const SINGLE_VEHICLE_ROUTE_NOCS = new Set(["FLIX", "NATX", "DAGC", "FPOT", "SOST"]);

/** Operators that show a full route catalogue + timetable in fleet. */
const ROUTE_CATALOGUE_NOCS = new Set(["DAGC", "FPOT", "SOST", "FLIX", "NATX"]);

function isSingleVehicleRouteOperator(noc) {
  return SINGLE_VEHICLE_ROUTE_NOCS.has(String(noc || "").trim().toUpperCase());
}

function isRouteCatalogueOperator(noc) {
  return ROUTE_CATALOGUE_NOCS.has(String(noc || "").trim().toUpperCase());
}

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
    note: "Via Stoke, Hanley · D&G timetable",
  },
  {
    line: "AT2",
    name: "Alton Towers employee-only AT2",
    origin: "Fenton",
    destination: "Alton Towers",
    note: "Via Bentilee, Longton, Meir, Cheadle · D&G timetable",
  },
  {
    line: "AT3",
    name: "Alton Towers employee-only AT3",
    origin: "Bentilee",
    destination: "Alton Towers",
    note: "Via Longton, Meir, Cheadle · D&G timetable",
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

export const SCHOOL_LINE_SET = new Set(
  STAFFS_SCHOOL_ROUTES.map((row) => String(row.line || "").toUpperCase()),
);

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
const STAFFS_LIVE_BBOX = "xmin=-2.35&ymin=52.55&xmax=-1.55&ymax=53.15";

/** BODS / Ticketer AVL text cleanup (Adderley_Green__First_Bus_Depot → spaces). */
function normalizeAvlText(value) {
  return String(value || "")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function avlToken(value) {
  return normalizeAvlText(value)
    .replace(/[-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDeadRunLine(line) {
  const t = avlToken(line);
  if (!t) return false;
  if (/^(dead\s*run|deadrun|oos|nis|n\/?s|not\s*in\s*service|out\s*of\s*service|positioning)$/i.test(t)) {
    return true;
  }
  return /\bdead\s*run\b/i.test(t);
}

function ticketMachineLooksOos(code) {
  const t = avlToken(code);
  if (!t) return false;
  if (/^dr$/i.test(t)) return true;
  return isDeadRunLine(t);
}

function isTicketerDeadRunBus(bus) {
  if (!bus) return false;
  if (bus.deadRun) return true;
  if (isDeadRunLine(bus.service?.line_name)) return true;
  if (ticketMachineLooksOos(bus._bods?.ticketMachineServiceCode)) return true;
  if (isDeadRunLine(bus._bods?.line) || isDeadRunLine(bus._bods?.lineRef)) return true;
  return /\bdead\s*run(?:ning)?\b/i.test(avlToken(bus.destination));
}

/** Non-empty line that is not an explicit dead-run / OOS marker (e.g. 11B, 25, BS1). */
function isPassengerServiceLine(line) {
  const t = avlToken(line);
  if (!t || t === "?") return false;
  return !isDeadRunLine(t);
}

function isNisDestinationText(dest) {
  const t = avlToken(dest);
  if (!t) return false;
  return (
    /^(not in service|nis|n\/?s|out of service|oos|positioning|dead running|dead run|empty to|to garage|to depot)$/i.test(t) ||
    /\b(not in service|out of service|dead\s*run(?:ning)?|empty to)\b/i.test(t)
  );
}

/**
 * Garage / depot / yard destination (trip purpose = to depot).
 * Does NOT match bare place names like "Adderley Green" on passenger routes.
 */
function isDepotRunDestinationText(dest) {
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
 * True depot OOS: dest says depot AND no active passenger service
 * (empty/dead line, or aimed arrival already well past).
 */
function isDepotOosForService(bus, { finishedTrip = false } = {}) {
  if (!isDepotRunDestinationText(bus?.destination)) return false;
  if (finishedTrip || bus?.tripFinished) return true;
  return !isPassengerServiceLine(bus?.service?.line_name || "");
}

function isFpotFinishedTripBus(bus) {
  if (!bus || !isFpotOperatorBus(bus)) return false;
  if (bus.tripFinished) return true;
  const aimRaw = bus._bods?.destinationAimedArrival || bus.destinationAimedArrival || "";
  const aimMs = Date.parse(aimRaw);
  const recMs = Date.parse(bus.datetime || "");
  if (!Number.isFinite(aimMs) || !Number.isFinite(recMs)) return false;
  return recMs - aimMs > 10 * 60 * 1000;
}

function isDgFinishedTripBus(bus) {
  if (!bus || !isDgOperatorBus(bus)) return false;
  if (bus.tripFinished) return true;
  const aimRaw = bus._bods?.destinationAimedArrival || bus.destinationAimedArrival || "";
  const aimMs = Date.parse(aimRaw);
  const recMs = Date.parse(bus.datetime || "");
  if (!Number.isFinite(aimMs) || !Number.isFinite(recMs)) return false;
  return recMs - aimMs > 10 * 60 * 1000;
}

function isTicketerFinishedTripBus(bus) {
  return isFpotFinishedTripBus(bus) || isDgFinishedTripBus(bus);
}

function isFpotOperatorBus(bus) {
  const hay = [
    bus?.operator?.noc,
    bus?.operator?.id,
    bus?.operator?.name,
    bus?.service?.operator?.noc,
    bus?.service?.operator?.name,
    bus?.vehicle?.operator?.noc,
    bus?._bods?.operator,
  ]
    .filter(Boolean)
    .join(" ");
  return /FPOT|First Potteries|first-potteries/i.test(hay);
}

function isDgOperatorBus(bus) {
  if (bus?.nisSource === "dg") return true;
  const hay = [
    bus?.operator?.noc,
    bus?.operator?.id,
    bus?.operator?.name,
    bus?.service?.operator?.noc,
    bus?.service?.operator?.name,
    bus?.vehicle?.operator?.noc,
    bus?._bods?.operator,
  ]
    .filter(Boolean)
    .join(" ");
  return /DAGC|D\s*&\s*G|D and G|d-g-coach|dgbus/i.test(hay);
}

/** First Potteries / D&G out-of-service / dead run / depot / finished trip from Ticketer→BODS / bustimes. */
function isOperatorOutOfServiceBus(bus) {
  if (!bus) return false;
  if (!(isFpotOperatorBus(bus) || isDgOperatorBus(bus))) return false;
  const line = String(bus.service?.line_name || "").trim();
  const finished = Boolean(bus.tripFinished) || isTicketerFinishedTripBus(bus);
  if (finished) return true;
  if (isTicketerDeadRunBus(bus) || !line || line === "?" || isDeadRunLine(line)) return true;
  if (isNisDestinationText(bus.destination)) return true;
  if (isDepotOosForService(bus, { finishedTrip: finished })) return true;
  // Ignore stale bus.nis / depotOos on an active passenger service past the depot.
  return false;
}

function isFpotOutOfServiceBus(bus) {
  return isFpotOperatorBus(bus) && isOperatorOutOfServiceBus(bus);
}

function isDgOutOfServiceBus(bus) {
  return isDgOperatorBus(bus) && isOperatorOutOfServiceBus(bus);
}

function ticketerOosStatusLabel(bus) {
  const dest = normalizeAvlText(bus?.destination || "");
  const moving = Number.isFinite(bus?.speedMph) && bus.speedMph >= 3;
  const finished = Boolean(bus?.tripFinished) || isTicketerFinishedTripBus(bus);
  if (
    isDepotOosForService(bus, { finishedTrip: finished }) ||
    (/depot|garage|yard/i.test(dest) && !isPassengerServiceLine(bus?.service?.line_name))
  ) {
    return moving ? "Out of service — heading to depot" : "Out of service at depot";
  }
  if (isTicketerDeadRunBus(bus)) return "Dead run";
  if (finished) {
    return moving ? "Finished — positioning" : "Finished / not in service";
  }
  if (moving) return "Out of service — positioning";
  return "Out of service";
}

function fpotOosStatusLabel(bus) {
  return ticketerOosStatusLabel(bus);
}

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

/** Fleet day picker keys. "Today" also keeps yesterday so overnight services (e.g. 25) still list after midnight. */
function fleetDayKeys(date = ukDateKey()) {
  const want = String(date || ukDateKey()).trim();
  const today = ukDateKey();
  if (!want || want !== today) return want ? [want] : [today];
  const [y, m, d] = today.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return [today, utc.toISOString().slice(0, 10)];
}

function rowMatchesFleetDay(rowDate, date) {
  if (!date) return true;
  if (!rowDate) return true;
  return fleetDayKeys(date).includes(String(rowDate));
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

function formatTrackedTime(value) {
  if (!value || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: UK_TZ,
  });
}

function formatTrackedWhen(info) {
  const raw = info?.trackedAt || info?.date || "";
  if (!raw) return "";
  const day = formatTrackedDate(raw);
  const time = formatTrackedTime(info?.trackedAt || "");
  if (day && time) return `${day} · ${time}`;
  return time || day;
}

/** Full "Wed 23 Sep 2026, 14:32" for the tooltip on the boxed date/time chip. */
function formatTrackedFull(info) {
  const raw = info?.trackedAt || "";
  if (!raw) return "";
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: UK_TZ,
  });
}

function lastTrackedHtml(info) {
  const label = formatTrackedWhen(info);
  if (!label) return "";
  const full = formatTrackedFull(info);
  const tip = full ? ` title="Last seen ${esc(full)}"` : ' title="Last tracked"';
  return `<span class="fleet-last-tracked"${tip}><span class="fleet-last-tracked-day">${esc(formatTrackedDate(info?.trackedAt || info?.date || ""))}</span> <span class="fleet-last-tracked-time">${esc(formatTrackedTime(info?.trackedAt || ""))}</span></span>`;
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
  return `<span class="fleet-list-main">${esc(v.fleet_code || v.fleet_number || "—")} ${plateHtml(v.reg)}${lastRouteHtml(v.lastRoute)}${lastTrackedHtml(v.lastRoute)}</span>`;
}

const lastRouteCache = new Map();
let atLiveCache = { at: 0, byReg: new Map(), byFleet: new Map(), byLine: new Map(), meta: new Map() };
let atLiveInflight = null;
/** Live AVL rows from the Staffs bbox poll, keyed by bustimes vehicle id. */
let staffsLiveById = new Map();
const operatorLiveCache = new Map();
const operatorVehiclesCache = new Map();

async function ensureAtLive(maxAgeMs = 20000) {
  if (Date.now() - atLiveCache.at < maxAgeMs && atLiveCache.meta.size) return atLiveCache;
  if (atLiveInflight) return atLiveInflight;
  atLiveInflight = refreshAtLive().finally(() => {
    atLiveInflight = null;
  });
  return atLiveInflight;
}

async function refreshAtLive() {
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
/** First Potteries Ticketer/BODS out-of-service / depot transfers. */
let fpotOosLiveCache = { at: 0, vehicles: [] };
let fpotOosLiveInflight = null;
/** D&G Ticketer/BODS / NextStop out-of-service / depot transfers. */
let dgOosLiveCache = { at: 0, vehicles: [] };
let dgOosLiveInflight = null;
/** Historical Ticketer dead runs from /api/trails/dead-runs (keep window). */
let deadRunsHistoryCache = { at: 0, segments: [], loading: false };
let deadRunsHistoryInflight = null;

function schoolRouteMeta(line) {
  const code = String(line || "").toUpperCase();
  return STAFFS_SCHOOL_ROUTES.find((row) => String(row.line).toUpperCase() === code) || { line: code };
}

export function isSchoolServiceLine(line) {
  return SCHOOL_LINE_SET.has(String(line || "").toUpperCase());
}

/** True only for registered Staffordshire school / college services (not other UK school buses). */
export function isSchoolBusLive(bus = {}) {
  const line = String(bus.service?.line_name || "").toUpperCase();
  if (!SCHOOL_LINE_SET.has(line)) return false;
  const meta = schoolRouteMeta(line);
  const op = String(bus?.operator?.noc || bus?.operator?.id || "").toUpperCase();
  // Same line number elsewhere (e.g. public 14 / 71) — require the Staffs school operator when known.
  if (meta.noc && op && op !== String(meta.noc).toUpperCase()) return false;
  return true;
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
  // National Express style codes: "007" and "7" are the same route.
  if (/^\d+$/.test(left) && /^\d+$/.test(right) && Number(left) === Number(right)) return true;
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
    direction: directionFromJourneyRow(row) || directionFromJourneyRow(liveSource || {}),
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
    const rowDest = String(row.destination || "").trim().toLowerCase().replace(/\s+/g, " ");
    const liveDest = String(liveRow.destination || "").trim().toLowerCase().replace(/\s+/g, " ");
    const rowDir = normalizeFleetDirection(row.direction);
    const liveDir = normalizeFleetDirection(liveRow.direction);
    const destinationCompatible = !rowDest || !liveDest || rowDest === liveDest;
    const directionCompatible = !rowDir || !liveDir || rowDir === liveDir;
    if (
      Number.isFinite(liveMs) &&
      Number.isFinite(rowMs) &&
      Math.abs(rowMs - liveMs) < 45 * 60_000 &&
      destinationCompatible &&
      directionCompatible &&
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
      direction: row.direction || liveRow.direction || "",
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
      direction:
        bus.direction ||
        bus.directionRef ||
        bus.currentJourney?.directionRef ||
        "",
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

let schoolLiveInflight = null;

async function ensureSchoolLive(maxAgeMs = 15000) {
  const schoolFresh = Date.now() - schoolLiveCache.at < maxAgeMs && schoolLiveCache.meta.size;
  const matchFresh = Date.now() - matchdayLiveCache.at < maxAgeMs && matchdayLiveCache.meta.size;
  if (schoolFresh && matchFresh) return schoolLiveCache;
  if (schoolLiveInflight) return schoolLiveInflight;
  schoolLiveInflight = refreshSchoolLive().finally(() => {
    schoolLiveInflight = null;
  });
  return schoolLiveInflight;
}

async function refreshSchoolLive() {
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
      if (bus?.id != null) staffsLiveById.set(String(bus.id), bus);
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
          direction: directionFromJourneyRow(bus),
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

      if (!SCHOOL_LINE_SET.has(rawLine)) continue;
      const metaRow = schoolRouteMeta(rawLine);
      const op = String(bus?.operator?.noc || bus?.operator?.id || "").toUpperCase();
      if (metaRow.noc && op && op !== String(metaRow.noc).toUpperCase()) continue;
      const line = metaRow.line || rawLine;
      const dest = bus.destination || metaRow.name || "";
      const entry = {
        line,
        dest,
        fleet: parsed.fleet,
        reg: compactQuery(parsed.reg),
        regLabel: parsed.reg,
        btId: bus.id != null ? String(bus.id) : "",
        recordedAtTime: bus.datetime || "",
        direction: directionFromJourneyRow(bus),
        bus,
        operator: metaRow.operator || "",
      };
      vehicles.push(entry);
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(entry);
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

async function ensureFpotOosLive(maxAgeMs = 15000) {
  if (Date.now() - fpotOosLiveCache.at < maxAgeMs && fpotOosLiveCache.at) {
    return fpotOosLiveCache;
  }
  if (fpotOosLiveInflight) return fpotOosLiveInflight;
  fpotOosLiveInflight = refreshFpotOosLive().finally(() => {
    fpotOosLiveInflight = null;
  });
  return fpotOosLiveInflight;
}

async function ensureDgOosLive(maxAgeMs = 15000) {
  if (Date.now() - dgOosLiveCache.at < maxAgeMs && dgOosLiveCache.at) {
    return dgOosLiveCache;
  }
  if (dgOosLiveInflight) return dgOosLiveInflight;
  dgOosLiveInflight = refreshDgOosLive().finally(() => {
    dgOosLiveInflight = null;
  });
  return dgOosLiveInflight;
}

async function ensureDeadRunsHistory(maxAgeMs = 60_000) {
  if (Date.now() - deadRunsHistoryCache.at < maxAgeMs && deadRunsHistoryCache.at) {
    return deadRunsHistoryCache;
  }
  if (deadRunsHistoryInflight) return deadRunsHistoryInflight;
  deadRunsHistoryInflight = (async () => {
    deadRunsHistoryCache = { ...deadRunsHistoryCache, loading: true };
    try {
      const res = await fetch("/api/trails/dead-runs?days=7&limit=60");
      if (!res.ok) throw new Error(`dead-runs ${res.status}`);
      const data = await res.json();
      const segments = Array.isArray(data?.segments) ? data.segments : [];
      deadRunsHistoryCache = { at: Date.now(), segments, loading: false };
    } catch {
      deadRunsHistoryCache = {
        at: deadRunsHistoryCache.at || Date.now(),
        segments: deadRunsHistoryCache.segments || [],
        loading: false,
      };
    }
    return deadRunsHistoryCache;
  })().finally(() => {
    deadRunsHistoryInflight = null;
  });
  return deadRunsHistoryInflight;
}

function pushTicketerOosRow(byKey, bus, source, { opLabel, opPrefix }) {
  if (!isOperatorOutOfServiceBus(bus)) return;
  const [lng, lat] = bus.coordinates || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  // Match map: drop when GPS has not progressed for 5 minutes.
  const STALE_MS = 5 * 60 * 1000;
  const at = Date.parse(bus.datetime || "");
  if (Number.isFinite(at) && Date.now() - at > STALE_MS) return;
  const parsed = parseLiveVehicleName(bus.vehicle?.name);
  const prefixRe = new RegExp(`^${opPrefix}-`, "i");
  const reg =
    compactQuery(bus.vehicle?.reg || parsed.reg) ||
    compactQuery(String(bus._bods?.vehicleRef || "").replace(prefixRe, "").replace(/_/g, ""));
  const fleet = parsed.fleet || "";
  const key = reg || fleet || String(bus.id || `${lat},${lng}`);
  const prev = byKey.get(key);
  const preferBods = source === "bods" || !prev;
  if (prev && !preferBods) return;
  byKey.set(key, {
    id: bus.id != null ? String(bus.id) : key,
    btId: bus.source === "bustimes" || Number.isFinite(Number(bus.id)) ? String(bus.id) : "",
    line: String(bus.service?.line_name || "").trim(),
    dest: normalizeAvlText(bus.destination) || (isTicketerDeadRunBus(bus) ? "Dead run" : "Out of service"),
    status: ticketerOosStatusLabel(bus),
    deadRun: isTicketerDeadRunBus(bus),
    fleet,
    reg,
    regLabel: bus.vehicle?.reg || parsed.reg || reg,
    recordedAtTime: bus.datetime || "",
    lat,
    lng,
    bus,
    source: source || bus.trackSource || bus.source || "",
    operator: opLabel,
  });
}

async function refreshFpotOosLive() {
  const byKey = new Map();
  const pushBus = (bus, source) => {
    if (!isFpotOutOfServiceBus(bus)) return;
    pushTicketerOosRow(byKey, bus, source, { opLabel: "First Potteries", opPrefix: "FPOT" });
  };

  try {
    const [btRes, bodsRes] = await Promise.all([
      fetch("/api/vehicles?operator=FPOT"),
      // Operator-wide Ticketer feed (no Staffs bbox) so Crewe / Stafford / etc. OOS appear.
      fetch("/api/bods-vehicles?operator=FPOT"),
    ]);
    if (btRes.ok) {
      const rows = await btRes.json();
      for (const bus of Array.isArray(rows) ? rows : []) {
        if (bus?.id != null) staffsLiveById.set(String(bus.id), bus);
        pushBus(bus, "bustimes");
      }
    }
    if (bodsRes.ok) {
      const data = await bodsRes.json();
      for (const bus of Array.isArray(data?.vehicles) ? data.vehicles : []) {
        pushBus(bus, "bods");
      }
    }
  } catch {
    if (fpotOosLiveCache.vehicles.length) return fpotOosLiveCache;
  }

  const vehicles = [...byKey.values()].sort((a, b) =>
    String(a.regLabel || a.fleet || "").localeCompare(String(b.regLabel || b.fleet || ""), "en-GB"),
  );
  fpotOosLiveCache = { at: Date.now(), vehicles };
  return fpotOosLiveCache;
}

/** Convert NextStop realtime item → bustimes-like bus for OOS detection. */
function dgNextStopItemToBus(item) {
  if (!item) return null;
  const lat = Number(item.positioning?.latitude);
  const lng = Number(item.positioning?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const ref = String(item.vehicle?.ref || item.vehicle?.vehicleUniqueId || "").trim();
  if (!ref) return null;
  const line = String(item.currentJourney?.publishedLineName || "").trim();
  const tm = String(item.currentJourney?.ticketMachineServiceCode || "").trim();
  const dest =
    item.currentJourney?.destination?.name ||
    item.currentJourney?.destinationRef ||
    "";
  const deadRun =
    isDeadRunLine(line) ||
    ticketMachineLooksOos(tm) ||
    /\bdead\s*run(?:ning)?\b/i.test(avlToken(dest));
  const inService = item.inService !== false && Boolean(item.currentJourney) && Boolean(line) && !deadRun;
  const parsed = typeof parseDgRef === "function" ? parseDgRef(ref) : parseLiveVehicleName(ref);
  const nis =
    deadRun ||
    !inService ||
    isNisDestinationText(dest) ||
    isDepotRunDestinationText(dest) ||
    !line;
  if (!nis) return null;
  return {
    id: `dg-oos-${ref}`,
    source: "dg",
    coordinates: [lng, lat],
    heading: Number(item.positioning?.bearing),
    datetime: item.recordedAtTime || new Date().toISOString(),
    destination: normalizeAvlText(dest) || (deadRun ? "Dead run" : "Out of service"),
    nis: true,
    deadRun: deadRun || undefined,
    nisSource: "dg",
    service: { line_name: deadRun ? "DEAD_RUN" : line },
    operator: { noc: "DAGC", id: "DAGC", name: "D & G Bus" },
    vehicle: {
      name: ref,
      reg: parsed?.reg || "",
      colour: "#e85d04",
    },
    _bods: tm
      ? { operator: "DAGC", ticketMachineServiceCode: tm, line }
      : { operator: "DAGC", line },
  };
}

async function refreshDgOosLive() {
  const byKey = new Map();
  const pushBus = (bus, source) => {
    if (!isDgOutOfServiceBus(bus)) return;
    pushTicketerOosRow(byKey, bus, source, { opLabel: "D & G Bus", opPrefix: "DAGC" });
  };

  try {
    const [btRes, bodsRes, dgRes] = await Promise.all([
      fetch("/api/vehicles?operator=DAGC"),
      // Operator-wide Ticketer feed (no Staffs bbox) so Crewe / Mid-Cheshire OOS appear.
      fetch("/api/bods-vehicles?operator=DAGC"),
      fetch("/api/dg-vehicles?regionId=526&showBusesNotInService=true"),
    ]);
    if (btRes.ok) {
      const rows = await btRes.json();
      for (const bus of Array.isArray(rows) ? rows : []) {
        if (bus?.id != null) staffsLiveById.set(String(bus.id), bus);
        pushBus(bus, "bustimes");
      }
    }
    if (bodsRes.ok) {
      const data = await bodsRes.json();
      for (const bus of Array.isArray(data?.vehicles) ? data.vehicles : []) {
        pushBus(bus, "bods");
      }
    }
    if (dgRes.ok) {
      const data = await dgRes.json();
      for (const item of Array.isArray(data?.items) ? data.items : []) {
        const bus = dgNextStopItemToBus(item);
        if (bus) pushBus(bus, "dg");
      }
    }
  } catch {
    if (dgOosLiveCache.vehicles.length) return dgOosLiveCache;
  }

  const vehicles = [...byKey.values()].sort((a, b) =>
    String(a.regLabel || a.fleet || "").localeCompare(String(b.regLabel || b.fleet || ""), "en-GB"),
  );
  dgOosLiveCache = { at: Date.now(), vehicles };
  return dgOosLiveCache;
}

function matchAtLive(vehicle) {
  if (!vehicle) return null;
  const reg = compactQuery(vehicle.reg);
  const fleet = compactQuery(vehicle.fleet_code || vehicle.fleet_number);
  return (reg && atLiveCache.byReg.get(reg)) || (fleet && atLiveCache.byFleet.get(fleet)) || null;
}

function lastRouteFromLiveBus(row, extra = {}) {
  if (!row || !(row.service?.line_name || row.destination || row.datetime)) return null;
  return {
    route: extractRouteFromVehicle(row) || row.service?.line_name || "",
    dest: row.destination || "",
    live: true,
    diverted: isDivertedText(row.destination, row.service?.line_name),
    trackedAt: row.datetime || new Date().toISOString(),
    direction: directionFromJourneyRow(row),
    ...extra,
  };
}

async function fetchOperatorLiveMap(noc) {
  const code = String(noc || "").trim().toUpperCase();
  if (!code) return new Map();
  const hit = operatorLiveCache.get(code);
  if (hit?.byId && Date.now() - hit.at < 20000) return hit.byId;
  if (hit?.inflight) return hit.inflight;
  const inflight = (async () => {
    const byId = new Map();
    try {
      const res = await fetch(`/api/vehicles?operator=${encodeURIComponent(code)}`);
      if (res.ok) {
        const rows = await res.json();
        for (const row of Array.isArray(rows) ? rows : []) {
          if (row?.id != null) byId.set(String(row.id), row);
        }
      }
    } catch {
      /* empty map */
    }
    operatorLiveCache.set(code, { at: Date.now(), byId });
    return byId;
  })();
  operatorLiveCache.set(code, { at: hit?.at || 0, byId: hit?.byId || new Map(), inflight });
  try {
    return await inflight;
  } finally {
    const cur = operatorLiveCache.get(code);
    if (cur) delete cur.inflight;
  }
}

function applyLiveLastRoutes(vehicles, liveById) {
  let changed = false;
  for (const vehicle of vehicles || []) {
    const key = String(vehicle?.id || "");
    if (!key) continue;
    const at = matchAtLive(vehicle);
    if (at) {
      vehicle.lastRoute = {
        route: at.line,
        dest: at.dest,
        live: true,
        at: true,
        trackedAt: at.recordedAtTime || new Date().toISOString(),
        direction: normalizeFleetDirection(at.direction || at.directionRef || ""),
      };
      lastRouteCache.set(key, Promise.resolve(vehicle.lastRoute));
      changed = true;
      continue;
    }
    if (vehicle.lastRoute?.live) continue;
    const live = liveById?.get(key) || staffsLiveById.get(key);
    const info = lastRouteFromLiveBus(live);
    if (!info) continue;
    vehicle.lastRoute = info;
    lastRouteCache.set(key, Promise.resolve(info));
    changed = true;
  }
  return changed;
}

async function fetchLastRoute(vehicleOrId, { skipLive = false, allowHistory = true } = {}) {
  const vehicle = typeof vehicleOrId === "object" && vehicleOrId ? vehicleOrId : null;
  const key = String(vehicle?.id ?? vehicleOrId ?? "");
  if (!key) return null;
  if (lastRouteCache.has(key)) return lastRouteCache.get(key);
  const promise = (async () => {
    if (atLiveCache.meta.size) {
      const at = matchAtLive(vehicle);
      if (at) {
        return {
          route: at.line,
          dest: at.dest,
          live: true,
          at: true,
          trackedAt: at.recordedAtTime || new Date().toISOString(),
          direction: normalizeFleetDirection(at.direction || at.directionRef || ""),
        };
      }
    }
    const cachedLive = staffsLiveById.get(key);
    const fromCache = lastRouteFromLiveBus(cachedLive);
    if (fromCache) return fromCache;
    if (!skipLive) {
      try {
        const liveRes = await fetch(`/api/vehicles?id=${encodeURIComponent(key)}`);
        if (liveRes.ok) {
          const live = await liveRes.json();
          const rows = Array.isArray(live) ? live : [];
          const row = rows.find((item) => String(item.id) === key) || rows[0];
          const info = lastRouteFromLiveBus(row);
          if (info) return info;
        }
      } catch {
        // Fall through to journey history.
      }
    }
    if (!allowHistory) return null;
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
          direction: enriched.direction || directionFromJourneyRow(row),
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

async function attachLastRoutes(vehicles, onProgress, { operatorNoc = "", fetchHistory = false, historyLimit = 8 } = {}) {
  const list = vehicles || [];
  const noc = String(operatorNoc || "").trim().toUpperCase();
  const [liveById] = await Promise.all([
    noc ? fetchOperatorLiveMap(noc).catch(() => new Map()) : Promise.resolve(staffsLiveById),
    atLiveCache.meta.size ? Promise.resolve(atLiveCache) : ensureAtLive().catch(() => atLiveCache),
  ]);
  if (applyLiveLastRoutes(list, liveById)) onProgress?.();
  if (!fetchHistory) return;
  const missing = list.filter((v) => v?.id && !v.lastRoute).slice(0, historyLimit);
  const chunk = 8;
  for (let i = 0; i < missing.length; i += chunk) {
    await Promise.all(
      missing.slice(i, i + chunk).map(async (vehicle) => {
        vehicle.lastRoute = await fetchLastRoute(vehicle, { skipLive: true, allowHistory: true });
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

function atDestForLine(line) {
  const code = String(line || "").trim().toUpperCase();
  const meta = AT_ROUTES.find((row) => row.line === code);
  return meta?.destination || "Alton Towers";
}

/** Bustimes-style "To" label for an AT run (outbound → Towers, inbound → origin). */
function atTripDestination(line, direction = "", fallback = "") {
  const code = String(line || "").trim().toUpperCase();
  const meta = AT_ROUTES.find((row) => row.line === code) || {};
  const d = normalizeFleetDirection(direction);
  if (d === "in") return meta.origin || fallback || "Inbound";
  if (d === "out") return meta.destination || fallback || "Alton Towers";
  if (fallback) return fallback;
  return meta.destination || "Alton Towers";
}

function dayKeysForTrail(ms = Date.now()) {
  const d = new Date(ms);
  const utc = d.toISOString().slice(0, 10);
  const uk = ukDateKey(d);
  return utc === uk ? [utc] : [utc, uk];
}

function atTrailSegmentKeys(baseKey, line, { days = 7, date = "" } = {}) {
  const primary = String(baseKey || "").trim();
  const code = String(line || "").trim().toUpperCase();
  if (!primary || !AT_LINE_SET.has(code)) return [];
  const keys = [];
  const pushDay = (day) => {
    if (!day) return;
    // Directed keys (inbound / outbound kept separate).
    for (const dir of ["out", "in"]) {
      keys.push(`at:${code}:${dir}:${primary}:${day}`);
      keys.push(`run:${primary}:${code}:${dir}:${day}`);
    }
    // Legacy undirected keys (older recordings).
    keys.push(`at:${code}:${primary}:${day}`);
    keys.push(`run:${primary}:${code}:${day}`);
  };
  if (date) {
    pushDay(String(date).trim());
    return keys;
  }
  for (let i = 0; i < days; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    for (const day of dayKeysForTrail(d.getTime())) pushDay(day);
  }
  return keys;
}

function trailKeyFromSegmentKey(key) {
  const raw = String(key || "");
  if (raw.startsWith("staff-") || /^\d+$/.test(raw) || raw.startsWith("reg:")) return raw;
  // at:AT2:out:staff-xxx:2026-09-20  or  at:AT2:staff-xxx:2026-09-20
  const atDir = raw.match(/^at:[^:]+:(?:in|out):(.+):\d{4}-\d{2}-\d{2}$/i);
  if (atDir) return atDir[1];
  const at = raw.match(/^at:[^:]+:(.+):\d{4}-\d{2}-\d{2}$/);
  if (at) return at[1];
  // run:staff-xxx:AT2:out:2026-09-20  or  run:staff-xxx:AT2:2026-09-20
  const runDir = raw.match(/^run:(.+):[^:]+:(?:in|out):\d{4}-\d{2}-\d{2}$/i);
  if (runDir) return runDir[1];
  const run = raw.match(/^run:(.+):[^:]+:\d{4}-\d{2}-\d{2}$/);
  if (run) return run[1];
  return raw;
}

function identityFromTrailKey(key) {
  const base = trailKeyFromSegmentKey(key);
  if (base.startsWith("staff-")) {
    const ref = base.slice("staff-".length);
    const parsed = parseDgRef(ref);
    return {
      trailKey: base,
      ref,
      fleet: parsed.fleet,
      reg: compactQuery(parsed.reg),
      regLabel: parsed.reg,
      btId: "",
    };
  }
  if (base.startsWith("reg:")) {
    const reg = base.slice(4);
    return {
      trailKey: base,
      ref: "",
      fleet: "",
      reg: compactQuery(reg),
      regLabel: reg.replace(/([A-Z]{2}\d{2})([A-Z]{3})/i, "$1 $2"),
      btId: "",
    };
  }
  if (/^\d+$/.test(base)) {
    return { trailKey: base, ref: "", fleet: "", reg: "", regLabel: "", btId: base };
  }
  return { trailKey: base, ref: "", fleet: "", reg: "", regLabel: "", btId: "" };
}

function formatAtDirection(dir) {
  const d = normalizeFleetDirection(dir);
  if (d === "in") return "Inbound";
  if (d === "out") return "Outbound";
  return "";
}

/** Store / Map attribute form: in | out | "". */
function normalizeFleetDirection(raw) {
  const d = String(raw || "")
    .trim()
    .toLowerCase();
  if (!d) return "";
  if (/^(in|inbound|i|1)$/.test(d)) return "in";
  if (/^(out|outbound|o|0)$/.test(d)) return "out";
  if (raw === true || raw === 1) return "out";
  if (raw === false || raw === 0) return "in";
  return "";
}

function directionFromJourneyRow(row = {}) {
  return normalizeFleetDirection(
    row.direction ||
      row.direction_id ||
      row.directionRef ||
      (row.outbound === true || row.Outbound === true
        ? "out"
        : row.outbound === false || row.Outbound === false
          ? "in"
          : ""),
  );
}

/** Shared Map button attrs so every fleet replay stays inbound/outbound separate. */
function fleetMapDataAttrs({
  tripId = "",
  journeyId = "",
  vehicleId = "",
  trailKey = "",
  reg = "",
  line = "",
  operator = "",
  direction = "",
  dest = "",
  datetime = "",
  diverted = false,
} = {}) {
  return `data-trip-id="${esc(tripId || "")}" data-journey-id="${esc(journeyId || "")}" data-vehicle-id="${esc(vehicleId || "")}" data-trail-key="${esc(trailKey || "")}" data-reg="${esc(reg || "")}" data-line="${esc(line || "")}" data-operator="${esc(operator || "")}" data-direction="${esc(normalizeFleetDirection(direction))}" data-dest="${esc(dest || "")}" data-datetime="${esc(datetime || "")}" data-diverted="${diverted ? "1" : "0"}"`;
}

/**
 * Vehicles that ran AT1/AT2/AT3 on a given day (from trail store + live D&G),
 * each with journey segments so Map can replay.
 */
async function fetchAtVehiclesForDay(line, date = ukDateKey()) {
  const code = String(line || "").trim().toUpperCase();
  const wantDate = String(date || ukDateKey()).trim();
  if (!AT_LINE_SET.has(code)) return [];

  const baseKeys = new Set();
  try {
    const res = await fetch(
      `/api/trails/keys?lines=${encodeURIComponent(code)}&days=2&limit=60`,
    );
    if (res.ok) {
      const data = await res.json();
      for (const row of Array.isArray(data?.keys) ? data.keys : []) {
        const key = String(row?.key || "").trim();
        if (!key) continue;
        const base = trailKeyFromSegmentKey(key);
        if (base.startsWith("staff-") || base.startsWith("reg:") || /^\d+$/.test(base)) {
          baseKeys.add(base);
        }
      }
    }
  } catch {
    /* trails optional */
  }

  const liveCache = await ensureAtLive(12_000);
  const liveEntries = [...(liveCache.byLine.get(code) || [])];
  for (const entry of liveEntries) {
    if (entry.ref) baseKeys.add(`staff-${entry.ref}`);
    await resolveAtVehicleId(entry);
    if (entry.btId) baseKeys.add(String(entry.btId));
    if (entry.reg) baseKeys.add(`reg:${entry.reg}`);
  }

  const byVehicle = new Map();
  const mergeLive = (id, entry) => {
    const cur = byVehicle.get(id) || {
      id,
      trailKey: "",
      btId: "",
      ref: "",
      fleet: "",
      reg: "",
      regLabel: "",
      live: false,
      dest: atDestForLine(code),
      journeys: [],
      lastAt: "",
    };
    if (entry.ref) cur.ref = entry.ref;
    if (entry.btId) cur.btId = String(entry.btId);
    if (entry.fleet) cur.fleet = entry.fleet;
    if (entry.reg) cur.reg = entry.reg;
    if (entry.regLabel) cur.regLabel = entry.regLabel;
    if (entry.trailKey) cur.trailKey = entry.trailKey;
    if (entry.dest) cur.dest = entry.dest;
    if (entry.direction) cur.direction = normalizeFleetDirection(entry.direction);
    if (entry.live) cur.live = true;
    if (entry.recordedAtTime && (!cur.lastAt || entry.recordedAtTime > cur.lastAt)) {
      cur.lastAt = entry.recordedAtTime;
    }
    byVehicle.set(id, cur);
    return cur;
  };

  for (const entry of liveEntries) {
    const id =
      (entry.btId && String(entry.btId)) ||
      (entry.ref && `staff-${entry.ref}`) ||
      (entry.reg && `reg:${entry.reg}`) ||
      "";
    if (!id) continue;
    mergeLive(id, {
      ...entry,
      trailKey: entry.ref ? `staff-${entry.ref}` : entry.btId ? String(entry.btId) : `reg:${entry.reg}`,
      live: true,
    });
  }

  const bases = [...baseKeys].slice(0, 28);
  for (const base of bases) {
    const ident = identityFromTrailKey(base);
    const liveHit = liveEntries.find(
      (e) =>
        (e.ref && `staff-${e.ref}` === base) ||
        (e.btId && String(e.btId) === base) ||
        (e.reg && `reg:${e.reg}` === base),
    );
    const id =
      (liveHit?.btId && String(liveHit.btId)) ||
      ident.btId ||
      (ident.ref && `staff-${ident.ref}`) ||
      (ident.reg && `reg:${ident.reg}`) ||
      base;

    const journeys = await fetchAtHistoryFromTrails({
      trailKeys: [base, ...(liveHit?.btId ? [String(liveHit.btId)] : [])],
      line: code,
      date: wantDate,
      days: 1,
    });

    if (!journeys.length && !liveHit) continue;

    const cur = mergeLive(id, {
      trailKey: base,
      btId: liveHit?.btId || ident.btId,
      ref: liveHit?.ref || ident.ref,
      fleet: liveHit?.fleet || ident.fleet,
      reg: liveHit?.reg || ident.reg,
      regLabel: liveHit?.regLabel || ident.regLabel,
      dest: liveHit?.dest || atDestForLine(code),
      live: Boolean(liveHit),
      recordedAtTime: liveHit?.recordedAtTime || journeys[0]?.datetime || "",
    });

    const seenJ = new Set(cur.journeys.map((j) => j.id));
    for (const row of journeys) {
      if (seenJ.has(row.id)) continue;
      seenJ.add(row.id);
      cur.journeys.push({
        ...row,
        trailKey: row.trailKey || base,
      });
    }
    cur.journeys.sort((a, b) => String(b.datetime || "").localeCompare(String(a.datetime || "")));
    if (cur.journeys[0]?.datetime) cur.lastAt = cur.journeys[0].datetime;
  }

  const list = [...byVehicle.values()].filter(
    (v) => v.live || (Array.isArray(v.journeys) && v.journeys.length),
  );
  list.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return String(b.lastAt || "").localeCompare(String(a.lastAt || ""));
  });
  return list;
}

/**
 * Build AT1–AT3 journey history from the server GPS trail store.
 * Bustimes often has no AT employee journeys, so trail segments are the source of truth.
 */
export async function fetchAtHistoryFromTrails({
  trailKeys = [],
  line = "",
  date = "",
  days = 7,
} = {}) {
  const wantLine = String(line || "").trim().toUpperCase();
  const wantDate = String(date || "").trim();
  const keepDays = Math.min(7, Math.max(1, Number(days) || 7));
  const bases = [...new Set((trailKeys || []).map((k) => String(k || "").trim()).filter(Boolean))];
  if (!bases.length) return [];
  const primary = bases.find((k) => k.startsWith("staff-")) || bases[0];
  const lines =
    wantLine && AT_LINE_SET.has(wantLine) ? [wantLine] : AT_ROUTES.map((row) => row.line);
  const keys = [];
  // The recorder may key an AT vehicle by its staff reference, BODS id, or reg.
  // Build directed segment keys for each identity rather than assuming one alias.
  for (const base of [primary, ...bases.filter((base) => base !== primary)].slice(0, 3)) {
    if (!base || keys.includes(base)) continue;
    keys.push(base);
    if (keys.length >= 10) continue;
    for (const atLine of lines) {
      const segs = atTrailSegmentKeys(base, atLine, {
        days: wantDate ? 1 : Math.min(keepDays, 2),
        date: wantDate,
      });
      for (const key of segs) {
        if (String(key).startsWith("run:")) continue;
        keys.push(key);
        if (keys.length >= 12) break;
      }
      if (keys.length >= 12) break;
    }
  }
  const unique = [...new Set(keys.filter(Boolean))].slice(0, 12);
  if (!unique.length) return [];
  try {
    const params = new URLSearchParams({
      keys: unique.join(","),
      days: String(keepDays),
      limit: "2500",
    });
    const res = await fetch(`/api/trails?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    if (data?.disabled) return [];
    const trails = data?.trails || {};
    const segments = [];
    for (const key of unique) {
      const pts = Array.isArray(trails[key]) ? trails[key] : [];
      let cur = null;
      for (const p of pts) {
        const t = Number(p.t);
        if (!Number.isFinite(t)) continue;
        const day = ukDateKey(t);
        if (wantDate && day !== wantDate) {
          if (cur && cur.n >= 2) segments.push(cur);
          cur = null;
          continue;
        }
        const pl = String(p.line || "").trim().toUpperCase();
        if (wantLine && pl && pl !== wantLine) {
          if (cur && cur.n >= 2) segments.push(cur);
          cur = null;
          continue;
        }
        if (!wantLine && pl && !AT_LINE_SET.has(pl)) {
          if (cur && cur.n >= 2) segments.push(cur);
          cur = null;
          continue;
        }
        const jid = String(p.journeyId || p.journey_id || "").trim();
        const dir = String(p.direction || "")
          .trim()
          .toLowerCase()
          .replace(/^inbound$/, "in")
          .replace(/^outbound$/, "out");
        const gap = cur ? t - cur.lastT : Infinity;
        const lineChanged = Boolean(cur?.line && pl && cur.line !== pl);
        const journeyChanged = Boolean(
          cur?.journeyId && jid && cur.journeyId !== jid && gap > 8 * 60_000,
        );
        const directionChanged = Boolean(cur?.direction && dir && cur.direction !== dir);
        if (!cur || lineChanged || journeyChanged || directionChanged || gap > 25 * 60_000) {
          if (cur && cur.n >= 2) segments.push(cur);
          cur = {
            journeyId: jid,
            line: pl || wantLine || "",
            direction: dir || "",
            date: day,
            startT: t,
            lastT: t,
            n: 1,
            trailKey: trailKeyFromSegmentKey(key),
            rawKey: key,
          };
        } else {
          cur.lastT = t;
          cur.n += 1;
          if (jid && !cur.journeyId) cur.journeyId = jid;
          if (pl && !cur.line) cur.line = pl;
          if (dir && !cur.direction) cur.direction = dir;
        }
      }
      if (cur && cur.n >= 2) segments.push(cur);
    }
    const seen = new Set();
    const rows = [];
    for (const seg of segments) {
      const lineCode = seg.line || wantLine || "";
      if (wantLine && lineCode && lineCode !== wantLine) continue;
      if (!lineCode || !AT_LINE_SET.has(lineCode)) continue;
      const id = seg.journeyId
        ? `at-jny-${seg.journeyId}`
        : `at-trail-${seg.trailKey || seg.rawKey}-${seg.direction || "x"}-${seg.startT}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        datetime: new Date(seg.startT).toISOString(),
        date: seg.date,
        route_name: lineCode,
        destination: atTripDestination(lineCode, seg.direction || "", atDestForLine(lineCode)),
        trip_id: null,
        journey_id: seg.journeyId || "",
        direction: seg.direction || "",
        trailKey: seg.trailKey || seg.rawKey,
        atTrail: true,
      });
    }
    rows.sort((a, b) => String(b.datetime || "").localeCompare(String(a.datetime || "")));
    return rows;
  } catch {
    return [];
  }
}

export function mergeAtHistoryRows(journeys, atRows) {
  const list = Array.isArray(journeys) ? [...journeys] : [];
  const extra = Array.isArray(atRows) ? atRows : [];
  if (!extra.length) return list;
  const seen = new Set(
    list.map((row) => String(row.id || `${row.datetime}|${row.route_name}`)),
  );
  for (const row of extra) {
    const key = String(row.id || `${row.datetime}|${row.route_name}`);
    if (seen.has(key)) continue;
    // Skip if a bustimes row already covers this AT journey closely.
    const rowMs = new Date(row.datetime).getTime();
    const dup = list.some((existing) => {
      if (!sameServiceLine(existing.route_name, row.route_name)) return false;
      const existingMs = new Date(existing.datetime).getTime();
      const existingDest = String(existing.destination || "").trim().toLowerCase().replace(/\s+/g, " ");
      const rowDest = String(row.destination || "").trim().toLowerCase().replace(/\s+/g, " ");
      const existingDir = normalizeFleetDirection(existing.direction);
      const rowDir = normalizeFleetDirection(row.direction);
      return (
        Number.isFinite(rowMs) &&
        Number.isFinite(existingMs) &&
        Math.abs(existingMs - rowMs) < 25 * 60_000 &&
        (!existingDest || !rowDest || existingDest === rowDest) &&
        (!existingDir || !rowDir || existingDir === rowDir)
      );
    });
    if (dup) continue;
    seen.add(key);
    list.push(row);
  }
  return list.sort((a, b) => String(b.datetime || "").localeCompare(String(a.datetime || "")));
}

/**
 * FlixBus / National Express history from GPS trail store.
 * Live AVL often hides vehicle ids, so journey-segmented trails are the source of truth.
 */
export async function fetchCoachHistoryFromTrails({
  trailKeys = [],
  line = "",
  days = 7,
  operator = "",
  busMode = false,
} = {}) {
  const wantLine = String(line || "").trim().toUpperCase();
  const wantOp = String(operator || "").trim().toUpperCase();
  const keepDays = Math.min(7, Math.max(1, Number(days) || 7));
  const bases = [...new Set((trailKeys || []).map((k) => String(k || "").trim()).filter(Boolean))];
  if (!bases.length) return [];
  const keys = [];
  for (const base of bases) {
    keys.push(base);
    if (/^\d+$/.test(base)) keys.push(`jny:${base}`);
    else if (base.startsWith("jny:")) keys.push(base.slice(4));
  }
  const unique = [...new Set(keys.filter(Boolean))].slice(0, 24);
  try {
    const params = new URLSearchParams({
      keys: unique.join(","),
      days: String(keepDays),
      limit: "2500",
    });
    const res = await fetch(`/api/trails?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    if (data?.disabled) return [];
    const trails = data?.trails || {};
    const segments = [];
    // Coaches: intermediate stops (Hanley, airports, service areas) often sit 20–60+ minutes.
    // Local buses (busMode): services stop every few minutes — a 20+ min gap means a new run.
    const coachGapMs = busMode ? 22 * 60_000 : 90 * 60_000;
    const journeyFlipMs = busMode ? 12 * 60_000 : 90 * 60_000;
    for (const key of unique) {
      const pts = Array.isArray(trails[key]) ? trails[key] : [];
      let cur = null;
      for (const p of pts) {
        const t = Number(p.t);
        if (!Number.isFinite(t)) continue;
        const day = ukDateKey(t);
        const pl = String(p.line || "").trim().toUpperCase();
        const pop = String(p.operator || "").trim().toUpperCase();
        if (wantOp && pop && pop !== wantOp) {
          if (cur && cur.n >= 2) segments.push(cur);
          cur = null;
          continue;
        }
        if (wantLine && pl && !sameServiceLine(pl, wantLine)) {
          if (cur && cur.n >= 2) segments.push(cur);
          cur = null;
          continue;
        }
        const jid = String(p.journeyId || p.journey_id || "").trim();
        const tid = String(p.tripId || p.trip_id || "").trim();
        const destRaw = String(p.destination || "").trim();
        const dest = destRaw.toLowerCase().replace(/\s+/g, " ").slice(0, 80);
        const dir = String(p.direction || "")
          .trim()
          .toLowerCase()
          .replace(/^inbound$/, "in")
          .replace(/^outbound$/, "out");
        const gap = cur ? t - cur.lastT : Infinity;
        const lineChanged = Boolean(cur?.line && pl && cur.line !== pl);
        const journeyChanged = Boolean(cur?.journeyId && jid && cur.journeyId !== jid);
        const tripChanged = Boolean(cur?.tripId && tid && cur.tripId !== tid);
        const sameJourney = Boolean(cur?.journeyId && jid && cur.journeyId === jid);
        const sameTrip = Boolean(cur?.tripId && tid && cur.tripId === tid);
        const directionChanged = Boolean(cur?.direction && dir && cur.direction !== dir);
        // Intermediate stop / next-stop headsign changes must not split a continuous A→B run.
        // A real local-bus turnaround normally changes the destination and journey/trip ID
        // within a minute or two; keep that boundary so Hanley→Newcastle and Newcastle→Hanley
        // remain separate saved routes.
        const rawDestChanged = Boolean(
          cur?.destination &&
            dest &&
            cur.destination !== dest &&
            !sameJourney &&
            !sameTrip &&
            !directionChanged,
        );
        const terminalTurn = Boolean(busMode && cur && cur.n >= 8 && rawDestChanged && gap >= 60_000);
        const destChanged = rawDestChanged && (gap >= journeyFlipMs || terminalTurn);
        const idBoundary =
          (journeyChanged || tripChanged) &&
          (lineChanged || directionChanged || (rawDestChanged && gap >= 60_000) || gap > journeyFlipMs);
        const hardBoundary = Boolean(
          lineChanged ||
            directionChanged ||
            terminalTurn ||
            (rawDestChanged && gap >= 60_000 && (journeyChanged || tripChanged)),
        );
        const shouldSplit =
          !cur ||
          lineChanged ||
          idBoundary ||
          (!(sameJourney || sameTrip) && (directionChanged || destChanged || gap > coachGapMs));
        if (shouldSplit) {
          if (cur && cur.n >= 2) {
            cur.hardBoundary = hardBoundary;
            segments.push(cur);
          }
          cur = {
            journeyId: jid,
            tripId: tid,
            line: pl || wantLine || "",
            direction: dir || "",
            destination: dest || "",
            destLabel: destRaw || "",
            date: day,
            startT: t,
            lastT: t,
            n: 1,
            trailKey: key.startsWith("jny:")
              ? key.slice(4)
              : key.startsWith("coach:") || key.startsWith("reg:")
                ? key
                : key,
            rawKey: key,
            operator: pop || wantOp || "",
            hardBoundary: false,
          };
        } else {
          cur.lastT = t;
          cur.n += 1;
          if (jid && !cur.journeyId) cur.journeyId = jid;
          if (tid && !cur.tripId) cur.tripId = tid;
          if (pl && !cur.line) cur.line = pl;
          if (dir && !cur.direction) cur.direction = dir;
          // Prefer the later / final destination on a continuous coach run.
          if (destRaw) {
            cur.destination = dest;
            cur.destLabel = destRaw;
          }
          if (pop && !cur.operator) cur.operator = pop;
        }
      }
      if (cur && cur.n >= 2) segments.push(cur);
    }
    // Merge consecutive same-line coach segments split only by an intermediate stop / new journey id.
    segments.sort((a, b) => a.startT - b.startT);
    const merged = [];
    for (const seg of segments) {
      const prev = merged[merged.length - 1];
      const gap = prev ? seg.startT - prev.lastT : Infinity;
      const sameLine =
        prev &&
        prev.line &&
        seg.line &&
        sameServiceLine(prev.line, seg.line) &&
        (!prev.operator || !seg.operator || prev.operator === seg.operator);
      if (
        prev &&
        sameLine &&
        !prev.hardBoundary &&
        !seg.hardBoundary &&
        Number.isFinite(gap) &&
        gap >= 0 &&
        gap <= coachGapMs
      ) {
        prev.lastT = Math.max(prev.lastT, seg.lastT);
        prev.n += seg.n;
        if (seg.destLabel) {
          prev.destination = seg.destination;
          prev.destLabel = seg.destLabel;
        }
        if (seg.journeyId && !prev.journeyId) prev.journeyId = seg.journeyId;
        if (seg.trailKey && String(seg.trailKey).startsWith("coach:")) prev.trailKey = seg.trailKey;
        continue;
      }
      merged.push({ ...seg });
    }
    const seen = new Set();
    const rows = [];
    for (const seg of merged) {
      const lineCode = seg.line || wantLine || "";
      if (wantLine && lineCode && !sameServiceLine(lineCode, wantLine)) continue;
      if (wantOp && seg.operator && seg.operator !== wantOp) continue;
      const id = seg.journeyId
        ? String(seg.journeyId)
        : `coach-trail-${seg.trailKey || seg.rawKey}-${seg.startT}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        datetime: new Date(seg.startT).toISOString(),
        date: seg.date,
        route_name: lineCode || "?",
        destination: seg.destLabel || "",
        trip_id: seg.tripId || "",
        journey_id: seg.journeyId || "",
        direction: seg.direction || "",
        trailKey: String(seg.trailKey || "").startsWith("coach:") || String(seg.trailKey || "").startsWith("reg:")
          ? seg.trailKey
          : seg.journeyId
            ? `jny:${seg.journeyId}`
            : seg.trailKey || seg.rawKey,
        coachTrail: !busMode,
        trailRun: busMode,
        operator: seg.operator ? { noc: seg.operator, id: seg.operator } : wantOp ? { noc: wantOp, id: wantOp } : null,
      });
    }
    rows.sort((a, b) => String(b.datetime || "").localeCompare(String(a.datetime || "")));
    return rows;
  } catch {
    return [];
  }
}

const FLEET_REPLAY_DAYS = 5;
const vehicleReplayCache = new Map();
const vehicleReplayInflight = new Map();

/** Trail-store keys used to find a vehicle's recent GPS runs. */
function vehicleReplayTrailKeys(vehicle = {}) {
  const id = String(vehicle.id || "").trim();
  const reg = compactQuery(vehicle.reg);
  const noc = String(vehicle.operator?.noc || vehicle.operator?.id || "").trim().toUpperCase();
  const keys = [
    id,
    /^\d+$/.test(id) ? `jny:${id}` : "",
    reg ? `reg:${reg}` : "",
    ["FLIX", "NATX"].includes(noc) && id && !id.startsWith("coach:") ? `coach:${id}` : "",
  ];
  // First/BODS recorders commonly use a normalised BODS vehicle key as well as reg:.
  if (noc && /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(reg)) {
    const bodsKey = `bods-${noc}-${noc}-${reg.slice(0, 4)}_${reg.slice(4)}`;
    keys.push(bodsKey, bodsKey.replace("_", ""));
  }
  return [...new Set(keys.filter(Boolean))].slice(0, 12);
}

/** Build replay rows from the seven-day GPS trail store for one Fleet vehicle. */
async function fetchVehicleReplayRuns(vehicle = {}, { days = FLEET_REPLAY_DAYS } = {}) {
  const trailKeys = vehicleReplayTrailKeys(vehicle);
  if (!trailKeys.length) return [];
  const noc = String(vehicle.operator?.noc || vehicle.operator?.id || "").trim().toUpperCase();
  const keepDays = Math.min(FLEET_REPLAY_DAYS, Math.max(1, Number(days) || FLEET_REPLAY_DAYS));
  const busMode = !["FLIX", "NATX"].includes(noc);
  const rows = await fetchCoachHistoryFromTrails({
    trailKeys,
    line: "",
    days: keepDays,
    operator: noc,
    busMode,
  });
  const cutoff = Date.now() - keepDays * 86_400_000;
  const seen = new Set();
  return rows
    .filter((row) => {
      const when = Date.parse(row.datetime || "");
      return !Number.isFinite(when) || when >= cutoff;
    })
    .map((row, index) => ({
      ...row,
      id: `replay-${row.id || `${row.trailKey || trailKeys[0]}-${row.datetime || index}`}`,
      replayTrailKey: String(row.trailKey || trailKeys[0] || ""),
      vehicleId: String(vehicle.id || ""),
      reg: vehicle.reg || row.reg || "",
      operator: row.operator || (noc ? { noc, id: noc } : null),
    }))
    .filter((row) => {
      const key = `${row.datetime || ""}|${row.route_name || ""}|${row.replayTrailKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(b.datetime || "").localeCompare(String(a.datetime || "")))
    .slice(0, 80);
}

async function cachedVehicleReplayRuns(vehicle = {}) {
  const trailKeys = vehicleReplayTrailKeys(vehicle);
  const cacheKey = trailKeys.join("|");
  if (!cacheKey) return [];
  const hit = vehicleReplayCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 60_000) return hit.rows;
  if (vehicleReplayInflight.has(cacheKey)) return vehicleReplayInflight.get(cacheKey);
  const promise = fetchVehicleReplayRuns(vehicle)
    .then((rows) => {
      vehicleReplayCache.set(cacheKey, { at: Date.now(), rows });
      return rows;
    })
    .finally(() => vehicleReplayInflight.delete(cacheKey));
  vehicleReplayInflight.set(cacheKey, promise);
  return promise;
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

/** Rewrite absolute bustimes.org API URLs to our /api/bt-* proxies. */
function toLocalBtApiUrl(url) {
  if (!url) return "";
  const raw = String(url);
  if (raw.startsWith("/api/bt-")) return raw;
  if (raw.startsWith("/api/services")) return `/api/bt-services${raw.slice("/api/services".length)}`;
  if (raw.startsWith("/api/trips")) return `/api/bt-trips${raw.slice("/api/trips".length)}`;
  try {
    const u = new URL(raw, "https://bustimes.org");
    if (!/bustimes\.org$/i.test(u.hostname)) return raw;
    if (u.pathname.startsWith("/api/services")) {
      return `/api/bt-services${u.pathname.slice("/api/services".length)}${u.search}`;
    }
    if (u.pathname.startsWith("/api/trips")) {
      return `/api/bt-trips${u.pathname.slice("/api/trips".length)}${u.search}`;
    }
  } catch {
    /* keep */
  }
  return raw;
}

function compareLineNames(a, b) {
  return String(a || "").localeCompare(String(b || ""), "en-GB", {
    numeric: true,
    sensitivity: "base",
  });
}

const operatorServicesCache = new Map();
const timetableTripsCache = new Map();
const timetableTripsInflight = new Map();
const tripDetailCache = new Map();

function rememberCache(map, key, value, max = 400) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return value;
}

async function fetchAllOperatorServices(noc) {
  const code = String(noc || "").trim().toUpperCase();
  if (!code) return [];
  if (operatorServicesCache.has(code)) return operatorServicesCache.get(code);
  const promise = (async () => {
    const pageSize = 100;
    const first = await fetchJson(
      `/api/bt-services/?operator=${encodeURIComponent(code)}&limit=${pageSize}`,
    );
    const out = [...(first.results || [])];
    const total = Number(first.count);
    const offsets = [];
    if (Number.isFinite(total) && total > pageSize) {
      for (let offset = pageSize; offset < Math.min(total, 400); offset += pageSize) {
        offsets.push(offset);
      }
    } else if (first.next) {
      let next = toLocalBtApiUrl(first.next);
      while (next && out.length < 400) {
        const data = await fetchJson(next);
        out.push(...(data.results || []));
        next = data.next ? toLocalBtApiUrl(data.next) : null;
      }
    }
    if (offsets.length) {
      const pages = await Promise.all(
        offsets.map((offset) =>
          fetchJson(
            `/api/bt-services/?operator=${encodeURIComponent(code)}&limit=${pageSize}&offset=${offset}`,
          ).catch(() => ({ results: [] })),
        ),
      );
      for (const data of pages) out.push(...(data.results || []));
    }
    const seen = new Set();
    const unique = [];
    for (const row of out) {
      const id = String(row?.id ?? "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      unique.push(row);
    }
    unique.sort((a, b) => {
      const byLine = compareLineNames(a.line_name, b.line_name);
      if (byLine) return byLine;
      return String(a.description || "").localeCompare(String(b.description || ""), "en-GB");
    });
    return unique;
  })();
  operatorServicesCache.set(code, promise);
  try {
    return await promise;
  } catch (error) {
    operatorServicesCache.delete(code);
    throw error;
  }
}

function formatTripClock(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const m = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!m) return raw.slice(0, 5);
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
}

/** AT1–AT3 full stop-by-stop timetable from the D&G Bus app feed. */
async function fetchAtTimetableTrips(line, date, { allDays = true } = {}) {
  const code = String(line || "").trim().toUpperCase();
  if (!AT_LINE_SET.has(code)) return [];
  const params = new URLSearchParams({ line: code });
  if (allDays) params.set("all", "1");
  else if (date) params.set("date", String(date));
  const data = await fetchJson(`/api/dg-at-timetable?${params}`);
  return Array.isArray(data?.trips) ? data.trips : [];
}

function atDayPatternLabel(days = []) {
  const set = new Set((days || []).map((d) => String(d || "").toLowerCase()));
  if (!set.size) return "Timetable";
  const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday"];
  if (weekdays.every((d) => set.has(d)) && ![...set].some((d) => !weekdays.includes(d))) {
    return "Monday–Friday";
  }
  if (set.size === 1 && set.has("saturday")) return "Saturday";
  if (set.size === 1 && set.has("sunday")) return "Sunday";
  if (set.size === 1 && set.has("friday")) return "Friday only";
  return [...set]
    .map((d) => d.charAt(0).toUpperCase() + d.slice(1))
    .join(", ");
}

function groupAtTimetableTrips(trips) {
  const byPattern = new Map();
  for (const trip of trips || []) {
    const pattern = atDayPatternLabel(trip.days);
    const head = String(trip.headsign || trip.destination || "Service").trim() || "Service";
    const key = `${pattern}||${head}`;
    const list = byPattern.get(key) || { pattern, head, rows: [] };
    list.rows.push(trip);
    byPattern.set(key, list);
  }
  const order = ["Monday–Friday", "Friday only", "Saturday", "Sunday"];
  return [...byPattern.values()].sort((a, b) => {
    const ai = order.indexOf(a.pattern);
    const bi = order.indexOf(b.pattern);
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return a.head.localeCompare(b.head, "en-GB");
  });
}

function renderAtTimetableHtml(trips, { line = "", loading = false, error = "" } = {}) {
  if (loading && !(trips || []).length) {
    return `<section class="fleet-tt" aria-busy="true">
      <h2 class="fleet-section-title">Timetable${line ? ` · ${esc(line)}` : ""}</h2>
      <p class="fleet-muted">Loading D&amp;G Bus timetable…</p>
    </section>`;
  }
  if (error && !(trips || []).length) {
    return `<section class="fleet-tt">
      <h2 class="fleet-section-title">Timetable${line ? ` · ${esc(line)}` : ""}</h2>
      <p class="fleet-error">${esc(error)}</p>
    </section>`;
  }
  const groups = groupAtTimetableTrips(trips);
  if (!groups.length) {
    return `<section class="fleet-tt">
      <h2 class="fleet-section-title">Timetable${line ? ` · ${esc(line)}` : ""}</h2>
      <p class="fleet-muted">No D&amp;G timetable journeys found for ${esc(line || "this route")}.</p>
    </section>`;
  }
  const bodies = groups
    .map(({ pattern, head, rows }) => {
      const sorted = [...rows].sort((a, b) => String(a.start).localeCompare(String(b.start)));
      const times = sorted
        .map((trip) => formatTripClock(trip.start))
        .filter(Boolean)
        .map((t) => `<span class="fleet-tt-time">${esc(t)}</span>`)
        .join("");
      const table = renderStopByStopTable(sorted);
      return `<div class="fleet-tt-direction">
        <h3 class="fleet-tt-head">${esc(pattern)} · to ${esc(head)}</h3>
        <div class="fleet-tt-times">${times}</div>
        <p class="fleet-muted fleet-tt-count">${sorted.length} departure${sorted.length === 1 ? "" : "s"}</p>
        ${
          table
            ? `<h4 class="fleet-tt-subhead">Stop-by-stop</h4>${table}`
            : `<p class="fleet-muted">Stop times unavailable for these journeys.</p>`
        }
      </div>`;
    })
    .join("");
  return `<section class="fleet-tt">
    <h2 class="fleet-section-title">Timetable${line ? ` · ${esc(line)}` : ""}</h2>
    <p class="fleet-muted fleet-section-note">Full D&amp;G Bus app timetable (employee-only)</p>
    ${bodies}
  </section>`;
}

function sortTimetableTrips(trips) {
  return [...(trips || [])].sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));
}

async function fetchServiceTimetableTrips(serviceId, date, { onPage } = {}) {
  const id = String(serviceId || "").trim();
  const day = String(date || ukDateKey()).trim();
  if (!id || !day) return [];
  const cacheKey = `${id}|${day}`;
  const cached = timetableTripsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 8 * 60_000) {
    onPage?.(cached.trips);
    return cached.trips;
  }
  if (timetableTripsInflight.has(cacheKey)) {
    const pending = timetableTripsInflight.get(cacheKey);
    const trips = await pending;
    onPage?.(trips);
    return trips;
  }
  const promise = (async () => {
    const pageSize = 100;
    const first = await fetchJson(
      `/api/bt-trips/?service=${encodeURIComponent(id)}&date=${encodeURIComponent(day)}&limit=${pageSize}`,
    );
    const seen = new Set();
    const out = [];
    const absorb = (batch) => {
      for (const trip of batch || []) {
        const key = String(trip?.id ?? `${trip?.start || ""}|${trip?.headsign || ""}`);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trip);
      }
    };
    absorb(first.results);
    onPage?.(sortTimetableTrips(out));
    const total = Number(first.count);
    const offsets = [];
    if (Number.isFinite(total) && total > pageSize) {
      for (let offset = pageSize; offset < Math.min(total, 250); offset += pageSize) {
        offsets.push(offset);
      }
    } else if (first.next) {
      let next = toLocalBtApiUrl(first.next);
      while (next && out.length < 250) {
        const data = await fetchJson(next);
        absorb(data.results);
        onPage?.(sortTimetableTrips(out));
        next = data.next ? toLocalBtApiUrl(data.next) : null;
      }
    }
    if (offsets.length) {
      const pages = await Promise.all(
        offsets.map((offset) =>
          fetchJson(
            `/api/bt-trips/?service=${encodeURIComponent(id)}&date=${encodeURIComponent(day)}&limit=${pageSize}&offset=${offset}`,
          ).catch(() => ({ results: [] })),
        ),
      );
      for (const data of pages) absorb(data.results);
    }
    const sorted = sortTimetableTrips(out);
    rememberCache(timetableTripsCache, cacheKey, { at: Date.now(), trips: sorted }, 80);
    return sorted;
  })();
  timetableTripsInflight.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    timetableTripsCache.delete(cacheKey);
    throw error;
  } finally {
    timetableTripsInflight.delete(cacheKey);
  }
}

async function fetchTripWithStops(tripId) {
  const id = String(tripId || "").trim();
  if (!id) return null;
  if (tripDetailCache.has(id)) return tripDetailCache.get(id);
  const pending = fetchJson(`/api/bt-trips/${encodeURIComponent(id)}/`)
    .then((row) => {
      rememberCache(tripDetailCache, id, Promise.resolve(row), 600);
      return row;
    })
    .catch((error) => {
      tripDetailCache.delete(id);
      throw error;
    });
  tripDetailCache.set(id, pending);
  return pending;
}

function tripStartMs(trip, dateKey) {
  const clock = formatTripClock(trip?.start);
  if (!clock) return NaN;
  const t = Date.parse(`${dateKey || ukDateKey()}T${clock}:00`);
  return Number.isFinite(t) ? t : NaN;
}

/** Prefer journeys around now, plus a few from the start of the day. */
function selectTripIdsForStops(trips, { perDirection = 8, aroundMs = Date.now() } = {}) {
  const wantIds = new Set();
  for (const [, rows] of groupTimetableTrips(trips)) {
    const sorted = [...rows].filter((trip) => trip?.id != null);
    if (!sorted.length) continue;
    const n = Math.min(perDirection, sorted.length);
    let best = 0;
    let gap = Infinity;
    sorted.forEach((trip, index) => {
      const ms = tripStartMs(trip);
      if (!Number.isFinite(ms)) return;
      const g = Math.abs(ms - aroundMs);
      if (g < gap) {
        gap = g;
        best = index;
      }
    });
    const start = Math.max(0, Math.min(best - Math.floor(n / 3), sorted.length - n));
    for (const trip of sorted.slice(start, start + n)) wantIds.add(String(trip.id));
    for (const trip of sorted.slice(0, Math.min(3, n))) wantIds.add(String(trip.id));
  }
  return [...wantIds];
}

function mergeTripDetails(list, detailById) {
  return (list || []).map((trip) => {
    const hit = detailById.get(String(trip.id));
    if (!hit) return trip;
    if (Array.isArray(trip.times) && trip.times.length && !Array.isArray(hit.times)) return trip;
    return { ...trip, ...hit };
  });
}

/** Load stop-by-stop times for timetable journeys (capped per direction). */
async function enrichTripsWithStopTimes(
  trips,
  { perDirection = 10, concurrency = 10, onChunk } = {},
) {
  const list = Array.isArray(trips) ? trips : [];
  if (!list.length) return list;
  const ids = selectTripIdsForStops(list, { perDirection }).filter((id) => {
    const existing = list.find((trip) => String(trip.id) === id);
    return !(Array.isArray(existing?.times) && existing.times.length);
  });
  if (!ids.length) return list;
  const detailById = new Map();
  for (const trip of list) {
    if (trip?.id != null && Array.isArray(trip.times) && trip.times.length) {
      detailById.set(String(trip.id), trip);
    }
  }
  for (let i = 0; i < ids.length; i += concurrency) {
    const chunk = ids.slice(i, i + concurrency);
    const rows = await Promise.all(
      chunk.map(async (id) => {
        try {
          return await fetchTripWithStops(id);
        } catch {
          return null;
        }
      }),
    );
    for (const row of rows) {
      if (row?.id != null) detailById.set(String(row.id), row);
    }
    onChunk?.(mergeTripDetails(list, detailById));
  }
  return mergeTripDetails(list, detailById);
}

function groupTimetableTrips(trips) {
  const byHead = new Map();
  for (const trip of trips || []) {
    const head = String(trip.headsign || trip.destination || "Service").trim() || "Service";
    const list = byHead.get(head) || [];
    list.push(trip);
    byHead.set(head, list);
  }
  return [...byHead.entries()].sort((a, b) => a[0].localeCompare(b[0], "en-GB"));
}

function tripStopClock(row) {
  return formatTripClock(row?.aimed_departure_time || row?.aimed_arrival_time || "");
}

function stopKeyOf(row) {
  return String(row?.stop?.atco_code || row?.stop?.name || "").trim();
}

function buildStopOrder(trips) {
  const order = [];
  const seen = new Set();
  for (const trip of trips || []) {
    for (const row of trip.times || []) {
      const key = stopKeyOf(row);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      order.push({
        key,
        name: String(row.stop?.name || key).trim(),
      });
    }
  }
  return order;
}

function renderStopByStopTable(trips) {
  const withTimes = (trips || []).filter((trip) => Array.isArray(trip.times) && trip.times.length);
  if (!withTimes.length) return "";
  const stops = buildStopOrder(withTimes);
  if (!stops.length) return "";
  const head = withTimes
    .map((trip) => `<th scope="col">${esc(formatTripClock(trip.start) || "—")}</th>`)
    .join("");
  const body = stops
    .map((stop) => {
      const cells = withTimes
        .map((trip) => {
          const hit = (trip.times || []).find((row) => stopKeyOf(row) === stop.key);
          const clock = hit ? tripStopClock(hit) : "";
          return `<td>${clock ? esc(clock) : "·"}</td>`;
        })
        .join("");
      return `<tr><th scope="row">${esc(stop.name)}</th>${cells}</tr>`;
    })
    .join("");
  return `<div class="fleet-tt-scroll" tabindex="0">
    <table class="fleet-tt-table">
      <thead><tr><th scope="col">Stop</th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function renderServiceTimetableHtml(trips, { date = "", line = "", loading = false, error = "" } = {}) {
  if (loading && !(trips || []).length) {
    return `<section class="fleet-tt" aria-busy="true">
      <h2 class="fleet-section-title">Timetable</h2>
      <p class="fleet-muted">Loading timetable…</p>
    </section>`;
  }
  if (error && !(trips || []).length) {
    return `<section class="fleet-tt">
      <h2 class="fleet-section-title">Timetable</h2>
      <p class="fleet-error">${esc(error)}</p>
    </section>`;
  }
  const groups = groupTimetableTrips(trips);
  if (!groups.length) {
    return `<section class="fleet-tt">
      <h2 class="fleet-section-title">Timetable</h2>
      <p class="fleet-muted">No timetable journeys found for ${esc(formatLongDate(date) || "this date")}.</p>
    </section>`;
  }
  const bodies = groups
    .map(([head, rows]) => {
      const times = rows
        .map((trip) => formatTripClock(trip.start))
        .filter(Boolean)
        .map((t) => `<span class="fleet-tt-time">${esc(t)}</span>`)
        .join("");
      const table = renderStopByStopTable(rows);
      return `<div class="fleet-tt-direction">
        <h3 class="fleet-tt-head">To ${esc(head)}</h3>
        <div class="fleet-tt-times">${times}</div>
        <p class="fleet-muted fleet-tt-count">${rows.length} departure${rows.length === 1 ? "" : "s"}</p>
        ${
          table
            ? `<h4 class="fleet-tt-subhead">Stop-by-stop</h4>${table}`
            : loading
              ? `<p class="fleet-muted">Loading stop times…</p>`
              : `<p class="fleet-muted">Stop times unavailable for these journeys.</p>`
        }
      </div>`;
    })
    .join("");
  return `<section class="fleet-tt">
    <h2 class="fleet-section-title">Timetable${line ? ` · ${esc(line)}` : ""}</h2>
    <p class="fleet-muted fleet-section-note">Scheduled stop times for ${esc(formatLongDate(date) || date)}</p>
    ${bodies}
  </section>`;
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

/** Load the active fleet for an operator, sorted by fleet number. */
async function fetchAllOperatorVehicles(noc, { search = "", onPage } = {}) {
  if (!noc) return { count: 0, results: [] };
  const cacheKey = `${String(noc).toUpperCase()}|${search}`;
  const cached = operatorVehiclesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 90_000) {
    onPage?.(cached.data.results, cached.data.count, true);
    return cached.data;
  }

  const results = [];
  const seen = new Set();
  const pageSize = 100;
  const absorb = (batch) => {
    for (const vehicle of batch || []) {
      const id = String(vehicle?.id ?? "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      results.push(vehicle);
    }
  };

  const first = await fetchOperatorVehicles(noc, { search, offset: 0, limit: pageSize });
  let total = Number(first.count);
  absorb(first.results);
  if (!Number.isFinite(total)) total = results.length;
  const notify = (done) => {
    onPage?.(
      results.slice().sort(compareFleetNumbers),
      Number.isFinite(total) ? total : results.length,
      done,
    );
  };
  notify(!first.next);

  const offsets = [];
  if (first.next && Number.isFinite(Number(first.count)) && Number(first.count) > pageSize) {
    for (let offset = pageSize; offset < Math.min(Number(first.count), 2500); offset += pageSize) {
      offsets.push(offset);
    }
  } else if (first.next) {
    let offset = results.length;
    for (let page = 1; page < 12 && first.next; page += 1) {
      const data = await fetchOperatorVehicles(noc, { search, offset, limit: pageSize });
      const batch = Array.isArray(data.results) ? data.results : [];
      if (!batch.length) break;
      absorb(batch);
      offset += batch.length;
      onPage?.(results.slice().sort(compareFleetNumbers), Number.isFinite(Number(data.count)) ? Number(data.count) : results.length, !data.next);
      if (!data.next || batch.length < pageSize) break;
    }
  }

  const conc = 3;
  for (let i = 0; i < offsets.length; i += conc) {
    const pages = await Promise.all(
      offsets.slice(i, i + conc).map((offset) => fetchOperatorVehicles(noc, { search, offset, limit: pageSize })),
    );
    for (const data of pages) absorb(data.results);
    onPage?.(results.slice().sort(compareFleetNumbers), total, i + conc >= offsets.length);
  }

  results.sort(compareFleetNumbers);
  const out = { count: Number.isFinite(total) ? total : results.length, results };
  operatorVehiclesCache.set(cacheKey, { at: Date.now(), data: out });
  return out;
}

const vehicleDetailCache = new Map();
const vehicleJourneysCache = new Map();
const liveVehicleLookupInflight = new Map();

async function fetchVehicle(id) {
  const key = String(id || "");
  if (!key) throw new Error("Vehicle id missing");
  if (!vehicleDetailCache.has(key)) {
    vehicleDetailCache.set(
      key,
      fetchJson(`/api/bt-vehicles/${encodeURIComponent(key)}/`).catch((err) => {
        vehicleDetailCache.delete(key);
        throw err;
      }),
    );
  }
  return vehicleDetailCache.get(key);
}

async function fetchLiveVehicleById(id) {
  const key = String(id || "");
  if (!key) return null;
  const cached = staffsLiveById.get(key);
  if (cached) return cached;
  for (const hit of operatorLiveCache.values()) {
    const row = hit?.byId?.get(key);
    if (row) return row;
  }
  if (liveVehicleLookupInflight.has(key)) return liveVehicleLookupInflight.get(key);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1400);
  const promise = (async () => {
    try {
      // This endpoint can take several seconds on a cold BODS cache. It is optional
      // enrichment for the fleet page, so never hold the vehicle shell hostage to it.
      const liveRes = await fetch(`/api/vehicles?id=${encodeURIComponent(key)}`, {
        signal: controller.signal,
      });
      if (!liveRes.ok) return null;
      const live = await liveRes.json();
      const rows = Array.isArray(live) ? live : [];
      return rows.find((item) => String(item.id) === key) || rows[0] || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => liveVehicleLookupInflight.delete(key));
  liveVehicleLookupInflight.set(key, promise);
  return promise;
}

async function fetchVehicleJourneys(vehicleId, date, { onPage } = {}) {
  const dayKeys = date ? fleetDayKeys(date) : [];
  const cacheKey = `${vehicleId}|${dayKeys.join(",") || date || ""}`;
  if (vehicleJourneysCache.has(cacheKey)) {
    return vehicleJourneysCache.get(cacheKey).then((rows) => {
      onPage?.(rows, { done: true, page: 0 });
      return rows;
    });
  }
  const promise = (async () => {
    const params = new URLSearchParams({ vehicle: String(vehicleId) });
    // When "today" also includes yesterday, omit bustimes ?date= so overnight rows are returned.
    if (date && dayKeys.length === 1) params.set("date", dayKeys[0]);
    const rows = [];
    const oldest = dayKeys.length ? dayKeys[dayKeys.length - 1] : "";
    let url = `/api/bt-vehiclejourneys/?${params}`;
    for (let page = 0; page < (date ? 6 : 6) && url; page += 1) {
      const data = await fetchJson(url);
      const batch = Array.isArray(data.results) ? data.results : [];
      for (const row of batch) {
        if (date && row.date && !rowMatchesFleetDay(row.date, date)) {
          if (oldest && row.date < oldest) {
            url = null;
            break;
          }
          continue;
        }
        rows.push(row);
      }
      const hasMore = Boolean(url && data.next);
      onPage?.(rows.slice(), { done: !hasMore, page });
      if (!hasMore) break;
      url = String(data.next).replace(
        /^https?:\/\/bustimes\.org\/api\/vehiclejourneys/,
        "/api/bt-vehiclejourneys",
      );
    }
    return rows;
  })().catch((err) => {
    vehicleJourneysCache.delete(cacheKey);
    throw err;
  });
  vehicleJourneysCache.set(cacheKey, promise);
  return promise;
}

function journeyLineCode(row = {}) {
  const enriched = row.extracted_route != null || row.diverted != null ? row : enrichJourneyRow(row);
  const line = String(
    (enriched.route_name && !/^div/i.test(String(enriched.route_name)) ? enriched.route_name : "") ||
      enriched.extracted_route ||
      enriched.route_name ||
      "",
  ).trim();
  if (!line || /^div/i.test(line)) return "";
  return line;
}

const vehicleRouteSummaryCache = new Map();

function summarizeRoutesFromJourneys(rows) {
  const byLine = new Map();
  for (const raw of rows || []) {
    const row = raw.extracted_route != null || raw.diverted != null ? raw : enrichJourneyRow(raw);
    const line = journeyLineCode(row);
    if (!line) continue;
    const key = line.toUpperCase();
    const cur = byLine.get(key) || { line, trips: 0, lastAt: "", dest: "" };
    cur.trips += 1;
    const when = String(row.datetime || row.date || "");
    if (when && when > String(cur.lastAt || "")) {
      cur.lastAt = when;
      cur.dest = row.destination || cur.dest;
    } else if (!cur.dest && row.destination) {
      cur.dest = row.destination;
    }
    byLine.set(key, cur);
  }
  return [...byLine.values()].sort((a, b) => compareLineNames(a.line, b.line));
}

/** Unique route numbers a vehicle has run (recent bustimes history). */
async function fetchVehicleRouteSummary(vehicleId) {
  const key = String(vehicleId || "");
  if (!key) return [];
  if (vehicleRouteSummaryCache.has(key)) return vehicleRouteSummaryCache.get(key);
  const promise = (async () => {
    const rows = [];
    let url = `/api/bt-vehiclejourneys/?vehicle=${encodeURIComponent(key)}&limit=100`;
    for (let page = 0; page < 1 && url; page += 1) {
      const data = await fetchJson(url);
      const batch = Array.isArray(data.results) ? data.results : [];
      rows.push(...batch);
      if (!data.next) break;
      url = String(data.next).replace(
        /^https?:\/\/bustimes\.org\/api\/vehiclejourneys/,
        "/api/bt-vehiclejourneys",
      );
    }
    return summarizeRoutesFromJourneys(rows);
  })().catch((err) => {
    vehicleRouteSummaryCache.delete(key);
    throw err;
  });
  vehicleRouteSummaryCache.set(key, promise);
  return promise;
}

const SAVED_VEHICLES_KEY = "uk-bus-fleet-saved-vehicles";

function loadSavedVehicles() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_VEHICLES_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .map((row) => ({
        id: String(row?.id || ""),
        reg: String(row?.reg || "").trim(),
        fleet: String(row?.fleet || "").trim(),
        operatorName: String(row?.operatorName || "").trim(),
        routes: Array.isArray(row?.routes) ? row.routes : [],
        routesAt: Number(row?.routesAt) || 0,
      }))
      .filter((row) => row.id || row.reg)
      .slice(0, 40);
  } catch {
    return [];
  }
}

function persistSavedVehicles(list) {
  try {
    localStorage.setItem(SAVED_VEHICLES_KEY, JSON.stringify((list || []).slice(0, 40)));
  } catch {
    /* ignore quota */
  }
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

async function fetchServiceJourneyVehicles(serviceId, date, { maxPages = 3, includeAnonymous = false } = {}) {
  // One row per trip (bustimes Vehicles tab) — do not collapse to latest per bus.
  const trips = [];
  const absorbPage = (data) => {
    for (const row of data.results || []) {
      if (date && row.date && !rowMatchesFleetDay(row.date, date)) continue;
      const vehicle = row.vehicle;
      if (!vehicle?.id) {
        if (!includeAnonymous) continue;
        trips.push({
          id: "",
          fleet_code: "",
          reg: "",
          slug: "",
          route_name: row.route_name || "",
          destination: row.destination || "",
          datetime: row.datetime || "",
          trip_id: row.trip_id || "",
          journey_id: row.id || "",
          trailKey: row.id != null ? String(row.id) : "",
          service_id: serviceId,
          direction: directionFromJourneyRow(row),
          operator: null,
          anonymous: true,
        });
        continue;
      }
      trips.push({
        id: vehicle.id,
        fleet_code: vehicle.fleet_code || vehicle.fleet_number || "",
        reg: vehicle.reg || "",
        slug: vehicle.slug || "",
        route_name: row.route_name || "",
        destination: row.destination || "",
        datetime: row.datetime || "",
        trip_id: row.trip_id || "",
        journey_id: row.id || "",
        trailKey: String(vehicle.id),
        service_id: serviceId,
        direction: directionFromJourneyRow(row),
        operator: vehicle.operator || null,
      });
    }
  };
  const pageSize = 100;
  const dayKeys = date ? fleetDayKeys(date) : [""];
  for (const day of dayKeys) {
    const dateParam = day ? `&date=${encodeURIComponent(day)}` : "";
    const firstUrl = `/api/bt-vehiclejourneys/?service=${encodeURIComponent(serviceId)}${dateParam}&limit=${pageSize}`;
    const first = await fetchJson(firstUrl);
    absorbPage(first);
    const total = Number(first.count);
    const offsets = [];
    if (first.next && Number.isFinite(total) && total > pageSize) {
      for (let page = 1, offset = pageSize; page < maxPages && offset < total; page += 1, offset += pageSize) {
        offsets.push(offset);
      }
    } else if (first.next && maxPages > 1) {
      let url = String(first.next).replace(
        /^https?:\/\/bustimes\.org\/api\/vehiclejourneys/,
        "/api/bt-vehiclejourneys",
      );
      for (let page = 1; page < maxPages && url; page += 1) {
        const data = await fetchJson(url);
        absorbPage(data);
        if (!data.next) break;
        url = String(data.next).replace(
          /^https?:\/\/bustimes\.org\/api\/vehiclejourneys/,
          "/api/bt-vehiclejourneys",
        );
      }
    }
    if (offsets.length) {
      const pages = await Promise.all(
        offsets.map((offset) =>
          fetchJson(
            `/api/bt-vehiclejourneys/?service=${encodeURIComponent(serviceId)}${dateParam}&limit=${pageSize}&offset=${offset}`,
          ).catch(() => ({ results: [] })),
        ),
      );
      for (const data of pages) absorbPage(data);
    }
  }
  return trips.sort((a, b) => String(a.datetime || "").localeCompare(String(b.datetime || "")));
}

function serviceOperatorNoc(service) {
  const op = Array.isArray(service?.operator) ? service.operator[0] : service?.operator;
  return String(op || "")
    .trim()
    .toUpperCase();
}

function plateFromLiveVehicleName(name) {
  const text = String(name || "").toUpperCase();
  const match =
    text.match(/\b([A-Z]{2}\d{2}\s*[A-Z]{3})\b/) || text.match(/\b([A-Z]\d{1,3}\s*[A-Z]{3})\b/);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

function liveBusToRouteVehicle(bus, service = null) {
  const noc = serviceOperatorNoc(service);
  const plate =
    String(bus?.vehicle?.reg || "").trim() || plateFromLiveVehicleName(bus?.vehicle?.name || "");
  const journeyId = String(bus?.journey_id || bus?.id || "").trim();
  return {
    id: bus?.vehicle?.id || "",
    fleet_code: bus?.vehicle?.fleet_code || "",
    reg: plate,
    slug: "",
    live: true,
    route_name: bus?.service?.line_name || service?.line_name || "",
    destination: bus?.destination || "",
    datetime: bus?.datetime || "",
    trip_id: bus?.trip_id || "",
    journey_id: journeyId,
    trailKey: String(bus?.id || journeyId || ""),
    service_id: bus?.service_id || service?.id || "",
    direction: directionFromJourneyRow(bus),
    operator: noc ? { id: noc, noc } : null,
    label: plate || "Live coach",
  };
}

/** Merge live AVL coaches onto journey rows (Flix/NATX hide vehicle ids on journeys). */
function mergeRouteVehiclesWithLive(trips, liveBuses, service = null) {
  const out = (Array.isArray(trips) ? trips : []).map((row) => ({ ...row }));
  const byJourney = new Map();
  const byTrip = new Map();
  for (const row of out) {
    const j = String(row.journey_id || "").trim();
    const t = String(row.trip_id || "").trim();
    if (j) byJourney.set(j, row);
    if (t) byTrip.set(t, row);
  }
  for (const bus of Array.isArray(liveBuses) ? liveBuses : []) {
    const jny = String(bus?.journey_id || bus?.id || "").trim();
    const trip = String(bus?.trip_id || "").trim();
    const hit = (jny && byJourney.get(jny)) || (trip && byTrip.get(trip)) || null;
    if (hit) {
      hit.live = true;
      hit.trailKey = String(bus.id || hit.trailKey || hit.journey_id || "");
      hit.datetime = bus.datetime || hit.datetime;
      hit.destination = bus.destination || hit.destination;
      const plate =
        String(bus?.vehicle?.reg || "").trim() || plateFromLiveVehicleName(bus?.vehicle?.name || "");
      if (plate && !hit.reg) hit.reg = plate;
      if (bus?.vehicle?.id && !hit.id) hit.id = bus.vehicle.id;
      hit.label = hit.reg || hit.label || "Live coach";
      continue;
    }
    const entry = liveBusToRouteVehicle(bus, service);
    out.push(entry);
    if (entry.journey_id) byJourney.set(String(entry.journey_id), entry);
    if (entry.trip_id) byTrip.set(String(entry.trip_id), entry);
  }
  return out.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return String(a.datetime || "").localeCompare(String(b.datetime || ""));
  });
}

async function fetchLineJourneyVehicles(services, date, { maxServices = 8 } = {}) {
  const pick = [...(services || [])].slice(0, maxServices);
  const batches = await Promise.all(
    pick.map((service) =>
      fetchServiceJourneyVehicles(service.id, date, { maxPages: 3 }).catch(() => []),
    ),
  );
  const trips = [];
  const seen = new Set();
  for (const batch of batches) {
    for (const entry of batch) {
      if (!isStaffsLocalDestination(entry.destination)) continue;
      const key = `${entry.id}|${entry.journey_id || entry.trip_id || entry.datetime}|${entry.destination || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      trips.push(entry);
    }
  }
  return trips.sort((a, b) => String(a.datetime || "").localeCompare(String(b.datetime || "")));
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
  onShowRouteTails,
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
    atDayVehicles: [],
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
    routeTimetable: [],
    routeTimetableLoading: false,
    routeTimetableError: "",
    operatorRoutes: [],
    operatorRoutesLoading: false,
    savedVehicles: loadSavedVehicles(),
    savedBusy: false,
    savedError: "",
    vehicleRoutes: [],
    vehicleRoutesLoading: false,
    replayRuns: [],
    replayRunsLoading: false,
    replayRunsError: "",
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
    // Exact route only (AT1 ≠ AT2 ≠ AT3), same as school / matchday / service lines.
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
        ? `<p class="fleet-photo-note">${
            state.photoPendingName
              ? `Photo by ${esc(state.photoPendingName)} submitted — waiting for owner approval. You can upload more anytime.`
              : "Photo submitted — waiting for owner approval. You can upload more anytime."
          }</p>`
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
    const keepPending = Boolean(state.photoPending);
    const keepPendingName = state.photoPendingName || "";
    state.photo = null;
    if (!keepPending) {
      state.photoPending = false;
      state.photoPendingName = "";
      state.photoStatus = "";
    }
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
      if (keepPending) {
        state.photoPending = true;
        state.photoPendingName = keepPendingName;
      }
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
        state.photoPendingName = uploaderName;
        state.photoStatus = "";
        render();
      } catch (error) {
        if (compactRegKey(state.vehicle?.reg) !== reg) return;
        state.photoPending = false;
        state.photoPendingName = "";
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

  function renderRouteNumberChips(routes, { loading = false, emptyLabel = "No routes yet", openLine = false } = {}) {
    if (loading) return `<div class="fleet-route-chips is-loading"><span class="fleet-muted">Loading routes…</span></div>`;
    const list = Array.isArray(routes) ? routes : [];
    if (!list.length) return `<div class="fleet-route-chips"><span class="fleet-muted">${esc(emptyLabel)}</span></div>`;
    return `<div class="fleet-route-chips" role="list">${list
      .map((row) => {
        const at = Boolean(row._at) || AT_LINE_SET.has(String(row.line_name || row.line || "").toUpperCase());
        const school = SCHOOL_LINE_SET.has(String(row.line_name || row.line || "").toUpperCase());
        const scfc = STOKE_FC_LINE_SET.has(String(row.line_name || row.line || "").toUpperCase());
        const line = row.line_name || row.line || "?";
        const trips = Number(row.trips) || 0;
        const title = row.description
          ? `${line} · ${row.description}`
          : trips
            ? `${line} · ${trips} trip${trips === 1 ? "" : "s"}${row.dest ? ` · ${row.dest}` : ""}`
            : line;
        const useLine = openLine || !row.id || String(row.id).startsWith("at:");
        const action = at && !openLine && row.id
          ? "open-at-route"
          : useLine
            ? "open-route-line"
            : "open-route-service";
        const extra = [
          at ? " is-at" : "",
          school ? " is-school" : "",
          scfc ? " is-scfc" : "",
        ].join("");
        return `<button type="button" class="fleet-route-chip${extra}" role="listitem" title="${esc(title)}" data-action="${action}" data-arg="${esc(row.id || "")}" data-line="${esc(line)}">${esc(line)}</button>`;
      })
      .join("")}</div>`;
  }

  function isSavedVehicle(vehicle) {
    const id = String(vehicle?.id || "");
    const reg = compactQuery(vehicle?.reg);
    return state.savedVehicles.some(
      (row) => (id && row.id === id) || (reg && compactQuery(row.reg) === reg),
    );
  }

  function persistSavedState() {
    persistSavedVehicles(state.savedVehicles);
  }

  function compareRouteSummaryRows(a, b) {
    const aTime = Date.parse(a?.lastAt || "");
    const bTime = Date.parse(b?.lastAt || "");
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
      return bTime - aTime;
    }
    if (Number.isFinite(aTime) && !Number.isFinite(bTime)) return -1;
    if (!Number.isFinite(aTime) && Number.isFinite(bTime)) return 1;
    return compareLineNames(a?.line, b?.line);
  }

  /** Union two route-summary lists (keyed by line) so a save is additive. */
  function mergeRouteSummary(a, b) {
    const map = new Map();
    for (const row of [...(a || []), ...(b || [])]) {
      if (!row?.line) continue;
      const key = String(row.line).toUpperCase();
      const cur = map.get(key) || { line: row.line, trips: 0, lastAt: "", dest: "" };
      cur.trips = Math.max(Number(cur.trips) || 0, Number(row.trips) || 0);
      if (String(row.lastAt || "") > String(cur.lastAt || "")) {
        cur.lastAt = row.lastAt;
        cur.dest = row.dest || cur.dest;
      } else if (!cur.dest && row.dest) {
        cur.dest = row.dest;
      }
      map.set(key, cur);
    }
    return [...map.values()].sort(compareRouteSummaryRows);
  }

  function upsertSavedVehicle(vehicle, routes = null) {
    if (!vehicle?.id && !vehicle?.reg) return;
    const id = String(vehicle.id || "");
    const reg = String(vehicle.reg || "").trim();
    const idx = state.savedVehicles.findIndex(
      (row) => (id && row.id === id) || (reg && compactQuery(row.reg) === compactQuery(reg)),
    );
    // Merge rather than replace: AT1–AT3 / BS1–BS2 only exist in GPS trails, so a
    // later bustimes-only save must not wipe routes another source already found.
    const existingRoutes = idx >= 0 && Array.isArray(state.savedVehicles[idx].routes)
      ? state.savedVehicles[idx].routes
      : [];
    const next = {
      id,
      reg,
      fleet: String(vehicle.fleet_code || vehicle.fleet_number || vehicle.fleet || "").trim(),
      operatorName: String(vehicle.operator?.name || vehicle.operatorName || "").trim(),
      routes: Array.isArray(routes) ? mergeRouteSummary(existingRoutes, routes) : existingRoutes,
      routesAt: Array.isArray(routes) ? Date.now() : idx >= 0 ? state.savedVehicles[idx].routesAt : 0,
    };
    if (idx >= 0) state.savedVehicles[idx] = { ...state.savedVehicles[idx], ...next };
    else state.savedVehicles.unshift(next);
    persistSavedState();
  }

  function removeSavedVehicle(id, reg = "") {
    const wantId = String(id || "");
    const wantReg = compactQuery(reg);
    state.savedVehicles = state.savedVehicles.filter(
      (row) => !((wantId && row.id === wantId) || (wantReg && compactQuery(row.reg) === wantReg)),
    );
    persistSavedState();
  }

  function renderSavedVehicles() {
    const list = state.savedVehicles;
    return `<section class="fleet-section fleet-saved">
      <h2 class="fleet-section-title">Your vehicles${list.length ? ` · ${list.length}` : ""}</h2>
      <p class="fleet-muted fleet-section-note">Add a registration to keep a bus here. Route numbers (27, 27A, …) come from its recorded journeys. Replay history is kept for the last 7 days.</p>
      <form id="fleet-add-vehicle-form" class="fleet-add-vehicle">
        <label class="sr-only" for="fleet-add-vehicle-query">Vehicle registration</label>
        <input id="fleet-add-vehicle-query" type="search" placeholder="Vehicle reg e.g. YX23 ABC" autocomplete="off" />
        <button type="submit"${state.savedBusy ? " disabled" : ""}>${state.savedBusy ? "Adding…" : "Add"}</button>
      </form>
      ${state.savedError ? `<p class="fleet-error">${esc(state.savedError)}</p>` : ""}
      ${
        list.length
          ? `<ul class="fleet-list fleet-saved-list">${list
              .map((row) => {
                const routes = Array.isArray(row.routes) ? row.routes : [];
                // Most recent recorded journey → route number + dest + when, beside the reg.
                const latest = routes.reduce((best, r) => {
                  if (!r?.lastAt) return best;
                  if (!best || String(r.lastAt) > String(best.lastAt)) return r;
                  return best;
                }, null);
                const lastRoute = latest
                  ? { route: latest.line, dest: latest.dest, trackedAt: latest.lastAt }
                  : null;
                const replayWhen = lastRoute?.trackedAt || latest?.lastAt || "";
                const replayBtn = row.id && replayWhen
                  ? `<button type="button" class="fleet-link-btn fleet-list-replay" data-action="play-journey" data-replay="1" data-replay-recorded="1" ${fleetMapDataAttrs({
                      vehicleId: row.id,
                      trailKey: row.id || `reg:${compactQuery(row.reg)}`,
                      reg: row.reg || "",
                      line: lastRoute?.route || latest?.line || "",
                      operator: row.operatorName || "",
                      dest: lastRoute?.dest || latest?.dest || "",
                      datetime: replayWhen,
                    })}>▶ Replay</button>`
                  : "";
                return `<li class="fleet-saved-card">
                  <div class="fleet-saved-head">
                    <button type="button" class="fleet-list-btn" data-action="open-vehicle" data-id="${esc(row.id)}">
                      <span class="fleet-list-main">${esc(row.fleet || "—")} ${plateHtml(row.reg)}${lastRouteHtml(lastRoute)}${lastTrackedHtml(lastRoute)}</span>
                      <span class="fleet-list-sub">${esc(row.operatorName || "Saved bus")}${routes.length ? ` · ${routes.length} route${routes.length === 1 ? "" : "s"}` : ""}</span>
                    </button>
                    <div class="fleet-saved-actions">${replayBtn}<button type="button" class="fleet-saved-remove" data-action="remove-saved-vehicle" data-id="${esc(row.id)}" data-reg="${esc(row.reg)}" title="Remove ${esc(row.reg || "vehicle")}" aria-label="Remove ${esc(row.reg || "vehicle")}">Remove</button></div>
                  </div>
                  ${renderRouteNumberChips(routes, {
                    loading: state.savedBusy && !routes.length,
                    emptyLabel: "No recorded routes yet.",
                    openLine: true,
                  })}
                </li>`;
              })
              .join("")}</ul>`
          : `<p class="fleet-muted">No saved vehicles yet.</p>`
      }
    </section>`;
  }

  function renderOperatorRouteColumn(op) {
    if (!isRouteCatalogueOperator(op?.noc)) return "";
    if (state.operatorRoutesLoading && !state.operatorRoutes.length) {
      return `<section class="fleet-section fleet-op-routes">
        <h2 class="fleet-section-title">Routes</h2>
        ${renderRouteNumberChips([], { loading: true })}
      </section>`;
    }
    const routes = state.operatorRoutes || [];
    return `<section class="fleet-section fleet-op-routes">
      <h2 class="fleet-section-title">Routes · ${routes.length || "…"}</h2>
      <p class="fleet-muted fleet-section-note">Route numbers for ${esc(decodeHtml(op.name))} · open one for timetable and buses</p>
      ${renderRouteNumberChips(routes, { emptyLabel: "No public routes listed yet." })}
    </section>`;
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
    const fpotOosVehicles = (() => {
      const list = fpotOosLiveCache.vehicles || [];
      if (!q) return list;
      return list.filter((row) =>
        compactQuery(
          `${row.regLabel || ""} ${row.fleet || ""} ${row.dest || ""} ${row.status || ""} first potteries oos out of service dead run`,
        ).includes(q),
      );
    })();
    const dgOosVehicles = (() => {
      const list = dgOosLiveCache.vehicles || [];
      if (!q) return list;
      return list.filter((row) =>
        compactQuery(
          `${row.regLabel || ""} ${row.fleet || ""} ${row.dest || ""} ${row.status || ""} d&g dg dagc oos out of service dead run`,
        ).includes(q),
      );
    })();
    const deadRunSegments = (() => {
      const list = deadRunsHistoryCache.segments || [];
      if (!q) return list;
      return list.filter((row) =>
        compactQuery(
          `${row.operatorName || ""} ${row.operator || ""} ${row.regLabel || ""} ${row.fleet || ""} ${row.dest || ""} dead run ticket machine fpot dagc first potteries`,
        ).includes(q),
      );
    })();
    return `
      ${fleetNav([{ label: "Staffordshire" }, { label: homeCrumbLabel() }])}
      <h1 class="fleet-title">Staffordshire fleet</h1>
      <p class="fleet-lead">${regSearch ? "Registration search covers buses across the UK." : "Search bus companies and vehicles operating in Staffordshire."}</p>
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${renderSavedVehicles()}
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
        <h2 class="fleet-section-title">First Potteries · out of service${fpotOosVehicles.length ? ` · ${fpotOosVehicles.length}` : ""}</h2>
        <p class="fleet-muted fleet-section-note">Dead runs, depot transfers, finished trips and not-in-service buses from First Potteries Ticketer AVL (via BODS). Live while GPS is fresh (drops after 5 minutes with no update). Any depot / yard destination — not only Adderley Green.</p>
        ${
          fpotOosVehicles.length
            ? `<ul class="fleet-list">${fpotOosVehicles
                        .map((row) => {
                  const label = [row.fleet, row.regLabel].filter(Boolean).join(" · ") || "Bus";
                  const lineBit = row.deadRun || isDeadRunLine(row.line) ? "DR" : row.line && isPassengerServiceLine(row.line) ? row.line : "NIS";
                  return `<li>
                    <div class="fleet-list-row fleet-oos-row">
                      <button type="button" class="fleet-list-btn" data-action="track-vehicle" data-id="${esc(row.id)}" data-reg="${esc(row.regLabel || row.reg || "")}" data-fleet="${esc(row.fleet || "")}" data-lat="${esc(row.lat)}" data-lng="${esc(row.lng)}">
                        <span class="fleet-list-main"><span class="fleet-route fleet-route-nis">${esc(lineBit)}</span> ${esc(label)}</span>
                        <span class="fleet-list-sub">${esc(row.status)}${row.dest ? ` · ${esc(row.dest)}` : ""}</span>
                      </button>
                      <button type="button" class="fleet-track-btn" data-action="track-vehicle" data-id="${esc(row.id)}" data-reg="${esc(row.regLabel || row.reg || "")}" data-fleet="${esc(row.fleet || "")}" data-lat="${esc(row.lat)}" data-lng="${esc(row.lng)}">Map</button>
                    </div>
                  </li>`;
                })
                .join("")}</ul>`
            : `<p class="fleet-muted">No First Potteries out-of-service buses tracking right now.</p>`
        }
      </section>
      <section class="fleet-section">
        <h2 class="fleet-section-title">D &amp; G · out of service${dgOosVehicles.length ? ` · ${dgOosVehicles.length}` : ""}</h2>
        <p class="fleet-muted fleet-section-note">Dead runs, depot transfers, finished trips and not-in-service buses from D&amp;G Ticketer AVL (via BODS) and NextStop. Live while GPS is fresh (drops after 5 minutes with no update). Garage / depot / yard destinations — passenger services past Mossfield or Adelaide stay in service.</p>
        ${
          dgOosVehicles.length
            ? `<ul class="fleet-list">${dgOosVehicles
                        .map((row) => {
                  const label = [row.fleet, row.regLabel].filter(Boolean).join(" · ") || "Bus";
                  const lineBit = row.deadRun || isDeadRunLine(row.line) ? "DR" : row.line && isPassengerServiceLine(row.line) ? row.line : "NIS";
                  return `<li>
                    <div class="fleet-list-row fleet-oos-row">
                      <button type="button" class="fleet-list-btn" data-action="track-vehicle" data-id="${esc(row.id)}" data-reg="${esc(row.regLabel || row.reg || "")}" data-fleet="${esc(row.fleet || "")}" data-lat="${esc(row.lat)}" data-lng="${esc(row.lng)}">
                        <span class="fleet-list-main"><span class="fleet-route fleet-route-nis">${esc(lineBit)}</span> ${esc(label)}</span>
                        <span class="fleet-list-sub">${esc(row.status)}${row.dest ? ` · ${esc(row.dest)}` : ""}</span>
                      </button>
                      <button type="button" class="fleet-track-btn" data-action="track-vehicle" data-id="${esc(row.id)}" data-reg="${esc(row.regLabel || row.reg || "")}" data-fleet="${esc(row.fleet || "")}" data-lat="${esc(row.lat)}" data-lng="${esc(row.lng)}">Map</button>
                    </div>
                  </li>`;
                })
                .join("")}</ul>`
            : `<p class="fleet-muted">No D&amp;G out-of-service buses tracking right now.</p>`
        }
      </section>
      <section class="fleet-section">
        <h2 class="fleet-section-title">Ticket machine · dead runs${deadRunSegments.length ? ` · ${deadRunSegments.length}` : ""}</h2>
        <p class="fleet-muted fleet-section-note">Recorded First Potteries and D&amp;G Ticketer dead runs from GPS trails (last 7 days). One row per continuous dead-run stint — separate from the live out-of-service lists above.</p>
        ${
          deadRunsHistoryCache.loading && !deadRunsHistoryCache.at
            ? `<p class="fleet-muted">Loading recorded dead runs…</p>`
            : deadRunSegments.length
              ? `<ul class="fleet-list">${deadRunSegments
                  .map((row) => {
                    const label =
                      [row.fleet, row.regLabel].filter(Boolean).join(" · ") ||
                      row.regLabel ||
                      "Bus";
                    const when = formatTrackedWhen({ trackedAt: row.datetime });
                    const op =
                      row.operatorName ||
                      (row.operator === "FPOT"
                        ? "First Potteries"
                        : row.operator === "DAGC"
                          ? "D & G Bus"
                          : row.operator || "");
                    const mapAttrs = fleetMapDataAttrs({
                      vehicleId: row.vehicleId || "",
                      trailKey: row.trailKey || "",
                      reg: row.regLabel || row.reg || "",
                      line: "DEAD_RUN",
                      operator: row.operator || "",
                      dest: row.dest || "Dead run",
                      datetime: row.datetime || "",
                      journeyId: row.journeyId || "",
                    });
                    return `<li>
                      <div class="fleet-list-row fleet-oos-row">
                        <button type="button" class="fleet-list-btn" data-action="play-journey" ${mapAttrs}>
                          <span class="fleet-list-main"><span class="fleet-route fleet-route-nis">DR</span> ${esc(label)}</span>
                          <span class="fleet-list-sub">${esc(op)} · ${esc(row.dest || "Dead run")}${when ? ` · ${esc(when)}` : ""}</span>
                        </button>
                        <button type="button" class="fleet-track-btn" data-action="play-journey" ${mapAttrs}>Map</button>
                      </div>
                    </li>`;
                  })
                  .join("")}</ul>`
              : `<p class="fleet-muted">No dead runs recorded yet</p>`
        }
      </section>
      <section class="fleet-section">
        <h2 class="fleet-section-title">School &amp; college buses · ${schoolRoutes.length}</h2>
        <p class="fleet-muted fleet-section-note">Staffordshire school &amp; college services only (registered local routes). Other UK school buses are not listed here. Live on the map at run times when operators publish AVL.</p>
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
            .map((row, idx) => {
              const meta = matchdayLiveCache.meta.get(row.line) || row;
              const live = meta.live || matchdayLiveCache.byLine.get(row.line)?.length || 0;
              return `<li>
                <button type="button" class="fleet-list-btn" data-action="open-matchday-route" data-line="${esc(row.line)}">
                  <span class="fleet-list-main"><span class="fleet-route fleet-route-scfc">${esc(row.line)}</span><span class="fleet-service-num">${idx + 1}</span> ${esc(row.name)}</span>
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
            .map((row, idx) => {
              const meta = atLiveCache.meta.get(row.line) || row;
              const live = meta.live || atLiveCache.byLine.get(row.line)?.length || 0;
              return `<li>
                <button type="button" class="fleet-list-btn" data-action="open-at-route" data-line="${esc(row.line)}">
                  <span class="fleet-list-main"><span class="fleet-route">${esc(row.line)}</span><span class="fleet-service-num">${idx + 1}</span> ${esc(meta.origin || row.origin)} → ${esc(meta.destination || row.destination)}</span>
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
      <p class="fleet-actions">
        <button type="button" class="fleet-link-btn" data-action="show-route-tails" data-line="${esc(line)}" data-operator="${esc(meta.noc || "")}">Map · tails</button>
      </p>
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
                      <span class="fleet-list-main">${esc(entry.fleet || "—")} ${plateHtml(entry.regLabel)}<span class="fleet-last-route fleet-last-route-school">${esc(entry.line)} · ${esc(entry.dest)}</span>${lastTrackedHtml({ trackedAt: entry.recordedAtTime })}</span>
                      <span class="fleet-list-sub">School / college service${entry.operator ? ` · ${esc(entry.operator)}` : ""}</span>
                    </button>
                    <button type="button" class="fleet-link-btn fleet-list-map" data-action="play-journey" ${fleetMapDataAttrs({
                      vehicleId: id,
                      trailKey: id,
                      reg: entry.regLabel,
                      line: entry.line,
                      direction: entry.direction,
                      dest: entry.dest,
                      datetime: entry.recordedAtTime || "",
                    })}>Map</button>
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
      <p class="fleet-actions">
        <button type="button" class="fleet-link-btn" data-action="show-route-tails" data-line="${esc(line)}" data-operator="FPOT">Map · tails</button>
      </p>
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
                      <span class="fleet-list-main">${esc(entry.fleet || "—")} ${plateHtml(entry.regLabel)}<span class="fleet-last-route fleet-last-route-scfc">${esc(entry.line)} · ${esc(entry.dest)}</span>${lastTrackedHtml({ trackedAt: entry.recordedAtTime })}</span>
                      <span class="fleet-list-sub">Stoke City FC shuttle${entry.operator ? ` · ${esc(entry.operator)}` : ""}</span>
                    </button>
                    <button type="button" class="fleet-link-btn fleet-list-map" data-action="play-journey" ${fleetMapDataAttrs({
                      vehicleId: id,
                      trailKey: id,
                      reg: entry.regLabel,
                      line: entry.line,
                      direction: entry.direction,
                      dest: entry.dest,
                      datetime: entry.recordedAtTime || "",
                    })}>Map</button>
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
    const dates = [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(ukDateKey(d));
    }
    const dayList = state.atDayVehicles || [];
    const liveNow = dayList.filter((v) => v.live);

    // Bustimes Vehicles tab: one row per trip (not one card per bus).
    const tripRows = [];
    for (const vehicle of dayList) {
      const runs = Array.isArray(vehicle.journeys) ? vehicle.journeys : [];
      const trailKey =
        vehicle.trailKey || (vehicle.ref ? `staff-${vehicle.ref}` : vehicle.btId || "");
      if (!runs.length) {
        if (!vehicle.live) continue;
        tripRows.push({
          fleet: vehicle.fleet || "—",
          reg: vehicle.regLabel || vehicle.reg || "",
          btId: vehicle.btId || "",
          ref: vehicle.ref || "",
          trailKey,
          datetime: vehicle.lastAt || "",
          destination: atTripDestination(line, vehicle.direction, vehicle.dest || atDestForLine(line)),
          direction: vehicle.direction || "",
          trip_id: "",
          journey_id: "",
          live: true,
        });
        continue;
      }
      for (const row of runs) {
        tripRows.push({
          fleet: vehicle.fleet || "—",
          reg: vehicle.regLabel || vehicle.reg || "",
          btId: vehicle.btId || "",
          ref: vehicle.ref || "",
          trailKey: row.trailKey || trailKey,
          datetime: row.datetime || "",
          destination: atTripDestination(
            line,
            row.direction || vehicle.direction,
            row.destination || vehicle.dest || atDestForLine(line),
          ),
          direction: row.direction || vehicle.direction || "",
          trip_id: row.trip_id || "",
          journey_id:
            row.journey_id ||
            (String(row.id || "").startsWith("at-trail-") || String(row.id || "").startsWith("at-live-")
              ? ""
              : row.id) ||
            "",
          live: Boolean(row.atLive || vehicle.live),
        });
      }
    }
    tripRows.sort((a, b) => String(a.datetime || "").localeCompare(String(b.datetime || "")));
    const uniqueBuses = new Set(
      tripRows.map((row) => String(row.btId || row.ref || row.reg || "")).filter(Boolean),
    );

    const timetableHtml = renderAtTimetableHtml(state.routeTimetable, {
      line,
      loading: state.routeTimetableLoading,
      error: state.routeTimetableError,
    });

    const tripTableHtml = state.loading
      ? `<p class="fleet-muted">Loading AT buses for ${esc(formatLongDate(state.date))}…</p>`
      : tripRows.length
        ? `<table class="fleet-table fleet-route-trips">
            <thead><tr><th>Vehicle</th><th>Trip</th><th>To</th><th></th></tr></thead>
            <tbody>
              ${tripRows
                .map((entry) => {
                  const time = formatJourneyTime(entry.datetime);
                  const openAction = entry.btId ? "open-vehicle" : "track-at";
                  return `<tr>
                    <td>
                      <button type="button" class="fleet-table-vehicle" data-action="${openAction}" data-id="${esc(entry.btId)}" data-reg="${esc(entry.reg)}" data-fleet="${esc(entry.fleet)}" data-ref="${esc(entry.ref)}" data-line="${esc(line)}">
                        <span class="fleet-table-fleet">${esc(entry.fleet)}</span>
                        ${plateHtml(entry.reg)}
                        ${entry.live ? ` <span class="fleet-live-tag">live</span>` : ""}
                      </button>
                    </td>
                    <td class="fleet-trip"><span>${esc(time)}</span><span class="fleet-trip-alt">${esc(time)}</span></td>
                    <td>${esc(entry.destination || "—")}${
                      formatAtDirection(entry.direction)
                        ? ` <span class="fleet-muted">(${esc(formatAtDirection(entry.direction))})</span>`
                        : ""
                    }</td>
                    <td class="fleet-row-actions">
                      <button type="button" class="fleet-link-btn" data-action="play-journey" ${fleetMapDataAttrs({
                        tripId: entry.trip_id || "",
                        journeyId: entry.journey_id || "",
                        vehicleId: entry.btId || "",
                        trailKey: entry.trailKey || "",
                        reg: entry.reg || "",
                        line,
                        operator: "DAGC",
                        direction: entry.direction || "",
                        dest: entry.destination || "",
                        datetime: entry.datetime || "",
                      })}>Map</button>
                    </td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>`
        : `<p class="fleet-muted">No vehicles recorded on ${esc(line)} for ${esc(formatLongDate(state.date))} yet. Trails appear once buses have been tracked on the map.</p>`;

    return `
      ${fleetNav([
        { label: "Staffordshire", action: "home" },
        { label: homeCrumbLabel(), action: "home" },
        { label: "Alton Towers employee-only" },
        { label: line },
      ])}
      <h1 class="fleet-title"><span class="fleet-route">${esc(line)}</span> ${esc(meta.name || line)}</h1>
      <p class="fleet-lead">${esc(meta.origin || "")} → ${esc(meta.destination || "Alton Towers")}${meta.via?.length ? ` · via ${esc(meta.via.join(", "))}` : ""}</p>
      <p class="fleet-muted fleet-section-note">Full D&amp;G Bus app timetable below · tracked trips listed separately — press <strong>Map</strong> on a row to replay that run only.</p>
      <label class="fleet-date-label">
        <span class="sr-only">Date</span>
        <select id="fleet-at-date" class="fleet-date">
          ${dates
            .map((key) => `<option value="${esc(key)}" ${key === state.date ? "selected" : ""}>${esc(formatLongDate(key))}</option>`)
            .join("")}
        </select>
      </label>
      ${
        liveNow.length
          ? `<p class="fleet-muted">${liveNow.length} live on ${esc(line)} right now</p>`
          : ""
      }
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${timetableHtml}
      <section class="fleet-section">
        <h2 class="fleet-section-title">Vehicles · ${state.loading ? "…" : tripRows.length}${
          !state.loading && uniqueBuses.size
            ? ` <span class="fleet-muted">(${uniqueBuses.size} buses)</span>`
            : ""
        }</h2>
        ${tripTableHtml}
      </section>
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

    const uniqueBuses = new Set(
      (state.routeVehicles || [])
        .map((row) => String(row.id || row.trailKey || row.journey_id || ""))
        .filter(Boolean),
    );
    const busListHtml = state.loading
      ? `<p class="fleet-muted">Loading buses…</p>`
      : state.routeVehicles.length
        ? `<table class="fleet-table fleet-route-trips">
            <thead><tr><th>Vehicle</th><th>Trip</th><th>To</th><th></th></tr></thead>
            <tbody>
              ${state.routeVehicles
                .map((entry) => {
                  const trailKey = entry.trailKey || entry.id || entry.journey_id || "";
                  const lineCode = entry.route_name || service?.line_name || line;
                  const time = formatJourneyTime(entry.datetime);
                  const fleet =
                    entry.fleet_code ||
                    (entry.live ? "Live" : entry.anonymous ? "—" : "—");
                  const vehicleCell = entry.id
                    ? `<button type="button" class="fleet-table-vehicle" data-action="open-vehicle" data-id="${esc(entry.id)}" data-line="${esc(lineCode)}">
                        <span class="fleet-table-fleet">${esc(fleet)}</span>
                        ${plateHtml(entry.reg)}
                        ${entry.live ? `<span class="fleet-live-tag">live</span>` : ""}
                      </button>`
                    : `<div class="fleet-table-vehicle is-static">
                        <span class="fleet-table-fleet">${esc(entry.label || fleet)}</span>
                        ${entry.reg ? plateHtml(entry.reg) : entry.live ? `<span class="fleet-muted">on map</span>` : ""}
                        ${entry.live ? `<span class="fleet-live-tag">live</span>` : ""}
                      </div>`;
                  return `<tr class="${entry.live ? "is-live" : ""}">
                    <td>${vehicleCell}</td>
                    <td class="fleet-trip"><span>${esc(time)}</span><span class="fleet-trip-alt">${esc(time)}</span></td>
                    <td>${esc(entry.destination || "—")}</td>
                    <td class="fleet-row-actions">
                      ${
                        entry.id || entry.trip_id || entry.journey_id || trailKey
                          ? `<button type="button" class="fleet-link-btn" data-action="play-journey" ${fleetMapDataAttrs({
                              tripId: entry.trip_id || "",
                              journeyId: entry.journey_id || "",
                              vehicleId: entry.id,
                              trailKey,
                              reg: entry.reg,
                              line: lineCode,
                              operator:
                                entry.operator?.id ||
                                entry.operator?.noc ||
                                (Array.isArray(service?.operator) && service.operator[0]) ||
                                state._routePreferNoc ||
                                "",
                              direction: entry.direction || "",
                              dest: entry.destination || "",
                              datetime: entry.datetime || "",
                            })}>Map</button>`
                          : ""
                      }
                    </td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>`
        : `<p class="fleet-muted">No buses recorded on route ${esc(line)} for ${esc(formatLongDate(state.date))}.</p>`;

    if (!service) {
      return `
        ${fleetNav([
          { label: "Staffordshire", action: "home" },
          { label: homeCrumbLabel(), action: "home" },
          { label: `Route ${line}` },
        ])}
        <h1 class="fleet-title">Route ${routeNumberBtn(line)}</h1>
        <p class="fleet-lead">Staffordshire buses that have run route <strong>${esc(line)}</strong> — each trip listed separately</p>
        <p class="fleet-actions">
          <button type="button" class="fleet-link-btn" data-action="show-route-tails" data-line="${esc(line)}" data-operator="FPOT">Map · tails</button>
        </p>
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
          <h2 class="fleet-section-title">Vehicles · ${state.loading ? "…" : state.routeVehicles.length}${
            !state.loading && uniqueBuses.size
              ? ` <span class="fleet-muted">(${uniqueBuses.size} buses)</span>`
              : ""
          }</h2>
          ${busListHtml}
        </section>
        ${
          state.routeServices.length > 1
            ? `<section class="fleet-section">
                <h2 class="fleet-section-title">Services · ${state.routeServices.length}</h2>
                <p class="fleet-muted fleet-section-note">Filter to one operator / corridor if needed.</p>
                <ul class="fleet-list">${state.routeServices
                  .map((row, idx) => {
                    const ops = serviceOperatorLabel(row);
                    return `<li>
                      <button type="button" class="fleet-list-btn" data-action="open-route-service" data-arg="${esc(row.id)}">
                        <span class="fleet-list-main"><span class="fleet-route">${esc(row.line_name || line)}</span><span class="fleet-service-num">${idx + 1}</span> ${esc(row.description || "")}</span>
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
    const timetableHtml = renderServiceTimetableHtml(state.routeTimetable, {
      date: state.date,
      line: service.line_name || line,
      loading: state.routeTimetableLoading,
      error: state.routeTimetableError,
    });
    const opCrumb =
      state.operator?.slug && isRouteCatalogueOperator(state.operator.noc)
        ? [
            { label: decodeHtml(state.operator.name), action: "open-operator", arg: state.operator.slug },
          ]
        : [];
    return `
      ${fleetNav([
        { label: "Staffordshire", action: "home" },
        { label: homeCrumbLabel(), action: "home" },
        ...opCrumb,
        { label: `Route ${line}`, action: "open-route-line", line },
        { label: service.description || service.line_name || line },
      ])}
      <h1 class="fleet-title">${routeNumberBtn(service.line_name || line)} ${esc(service.description || "")}</h1>
      <p class="fleet-lead">${esc(ops || "Service")} · ${
        ["FLIX", "NATX"].includes(String((Array.isArray(service?.operator) && service.operator[0]) || state._routePreferNoc || "").toUpperCase())
          ? "live coaches on this route, plus today’s trips"
          : "each trip listed separately (Vehicle · Trip · To · Map)"
      }</p>
      <p class="fleet-actions">
        <button type="button" class="fleet-link-btn" data-action="show-route-tails" data-line="${esc(service.line_name || line)}" data-operator="${esc((Array.isArray(service?.operator) && service.operator[0]) || state._routePreferNoc || "")}">Map · tails</button>
      </p>
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
      ${timetableHtml}
      <section class="fleet-section">
        <h2 class="fleet-section-title">Vehicles · ${state.loading ? "…" : state.routeVehicles.length}${
          !state.loading && uniqueBuses.size
            ? ` <span class="fleet-muted">(${uniqueBuses.size} buses)</span>`
            : ""
        }</h2>
        ${busListHtml}
      </section>
    `;
  }

  function renderOperator() {
    const op = state.operator;
    if (!op) return renderHome();
    const showRoutes = isRouteCatalogueOperator(op.noc);
    const vehiclesHtml = !op.noc
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
      : `<section class="fleet-section fleet-op-vehicles">
          <h2 class="fleet-section-title">Vehicles · ${state.loading && !state.vehicles.length ? "…" : state.vehicles.length || state.vehicleCount || 0}</h2>
          ${
            state.loading && !state.vehicles.length
              ? `<p class="fleet-muted">Loading fleet…</p>`
              : state.vehicles.length
                ? `<ul class="fleet-list">${state.vehicles
                    .map((v) => {
                      const route = v.lastRoute?.route || "";
                      const dest = v.lastRoute?.dest || "";
                      const when = v.lastRoute?.trackedAt || "";
                      const mapBtn = isSingleVehicleRouteOperator(op.noc)
                        ? `<button type="button" class="fleet-link-btn fleet-list-map" data-action="play-journey" ${fleetMapDataAttrs({
                            vehicleId: v.id,
                            trailKey: v.id,
                            reg: v.reg || "",
                            line: route,
                            operator: op.noc || "",
                            direction: v.lastRoute?.direction || "",
                            dest,
                            datetime: when,
                          })}>Map</button>`
                        : "";
                      const replayBtn = (v.id || v.reg) && when
                        ? `<button type="button" class="fleet-link-btn fleet-list-replay" data-action="play-journey" data-replay="1" data-replay-recorded="1" ${fleetMapDataAttrs({
                            vehicleId: v.id || "",
                            trailKey: v.id || `reg:${compactQuery(v.reg)}`,
                            reg: v.reg || "",
                            line: route,
                            operator: op.noc || "",
                            direction: v.lastRoute?.direction || "",
                            dest,
                            datetime: when,
                          })}>▶ Replay</button>`
                        : "";
                      return `<li class="fleet-list-row">
                        <button type="button" class="fleet-list-btn" data-action="open-vehicle" data-id="${esc(v.id)}" data-line="${esc(route)}">
                          ${vehicleMainHtml(v)}
                          <span class="fleet-list-sub">${esc(v.vehicle_type?.name || "Unknown type")}${v.livery?.name ? ` · ${esc(v.livery.name)}` : ""}</span>
                        </button>
                        ${replayBtn}${mapBtn}
                      </li>`;
                    })
                    .join("")}</ul>`
                : `<p class="fleet-muted">No active vehicles found for this operator.</p>`
          }
        </section>`;
    return `
      ${fleetNav([
        { label: "Staffordshire", action: "home" },
        { label: homeCrumbLabel(), action: "home" },
        { label: decodeHtml(op.name) },
        { label: showRoutes ? "Routes & vehicles" : "Vehicles" },
      ])}
      <h1 class="fleet-title">${esc(decodeHtml(op.name))}</h1>
      <p class="fleet-lead">${
        isPrivateHire(op)
          ? esc(op.note || "Private hire / coach travel")
          : op.noc
            ? `Operator code ${esc(op.noc)} · ${state.vehicleCount} vehicles${
                showRoutes && state.operatorRoutes.length
                  ? ` · ${state.operatorRoutes.length} routes`
                  : ""
              }`
            : "No vehicle list available for this operator yet."
      }</p>
      ${
        isSingleVehicleRouteOperator(op.noc)
          ? `<p class="fleet-muted fleet-section-note">Open a route for a Vehicle · Trip · To · Map list (each trip separate). Press <strong>Map</strong> on a bus for that vehicle only.</p>`
          : ""
      }
      ${
        String(op.noc || "").toUpperCase() === "DAGC"
          ? `<p class="fleet-muted fleet-section-note">Public routes and AT1–AT3 employee services list every trip separately.</p>`
          : ["FLIX", "NATX", "FPOT"].includes(String(op.noc || "").toUpperCase())
            ? `<p class="fleet-muted fleet-section-note">Routes and timetables list every trip separately (Vehicle · Trip · To · Map).</p>`
            : ""
      }
      ${
        isPrivateHire(op) && op.noc
          ? `<p class="fleet-muted fleet-section-note">Live coaches and buses appear on the map when this operator’s public feed is tracking them.</p>`
          : ""
      }
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${
        op.website && op.noc
          ? `<p><a class="fleet-ext-link" href="${esc(op.website)}" target="_blank" rel="noopener noreferrer">Visit ${esc(decodeHtml(op.name))} website</a></p>`
          : ""
      }
      ${
        showRoutes
          ? `<div class="fleet-op-split">${vehiclesHtml}${renderOperatorRouteColumn(op)}</div>`
          : vehiclesHtml
      }
    `;
  }

  function renderVehicleReplayRuns(v) {
    const runs = Array.isArray(state.replayRuns) ? state.replayRuns : [];
    const count = runs.length;
    const groups = new Map();
    for (const row of runs) {
      const rawLine = String(row.route_name || "").trim().toUpperCase();
      const key = rawLine && rawLine !== "?" ? rawLine : "OTHER";
      const group = groups.get(key) || { key, rows: [], latestMs: 0 };
      group.rows.push(row);
      const whenMs = Date.parse(row.datetime || "");
      if (Number.isFinite(whenMs)) group.latestMs = Math.max(group.latestMs, whenMs);
      groups.set(key, group);
    }
    const orderedGroups = [...groups.values()]
      .map((group) => ({
        ...group,
        rows: group.rows.sort((a, b) => String(b.datetime || "").localeCompare(String(a.datetime || ""))),
      }))
      .sort((a, b) => b.latestMs - a.latestMs || compareLineNames(a.key, b.key));

    const renderReplayRow = (row) => {
      const line = row.route_name && row.route_name !== "?" ? row.route_name : "GPS run";
      const when = formatTrackedWhen({ trackedAt: row.datetime, date: row.date });
      const direction = normalizeFleetDirection(row.direction);
      const directionLabel = direction === "in" ? "Inbound" : direction === "out" ? "Outbound" : "";
      const destination = row.destination || "Recorded GPS route";
      const replayAttrs = fleetMapDataAttrs({
        tripId: row.trip_id || row.tripId || "",
        journeyId: row.journey_id || row.journeyId || "",
        vehicleId: v.id || row.vehicleId || "",
        trailKey: row.replayTrailKey || row.trailKey || v.id || "",
        reg: v.reg || row.reg || "",
        line: row.route_name && row.route_name !== "?" ? row.route_name : "",
        operator: v.operator?.noc || v.operator?.id || "",
        direction: row.direction || "",
        dest: row.destination || "",
        datetime: row.datetime || "",
      });
      return `<li class="fleet-list-row fleet-replay-row">
        <div class="fleet-list-btn fleet-replay-info">
          <span class="fleet-list-main"><span class="fleet-route">${esc(line)}</span>${when ? `<span class="fleet-last-tracked">${esc(when)}</span>` : ""}</span>
          <span class="fleet-list-sub">${esc(destination)}${directionLabel ? ` · ${esc(directionLabel)}` : ""}</span>
        </div>
        <button type="button" class="fleet-link-btn fleet-list-replay" data-action="play-journey" data-replay="1" data-replay-recorded="1" ${replayAttrs}>▶ Replay</button>
      </li>`;
    };

    const body = state.replayRunsLoading && !count
      ? `<p class="fleet-muted">Loading recorded GPS replays…</p>`
      : state.replayRunsError
        ? `<p class="fleet-error">${esc(state.replayRunsError)}</p>`
        : count
          ? `<ul class="fleet-list fleet-replay-list">${orderedGroups
              .map((group) => {
                const latest = group.rows[0];
                const latestWhen = formatTrackedWhen({ trackedAt: latest?.datetime, date: latest?.date });
                const label = group.key === "OTHER" ? "Other GPS" : group.key;
                return `<li class="fleet-replay-group-header">
                  <span class="fleet-list-main"><span class="fleet-route">${esc(label)}</span></span>
                  <span class="fleet-list-sub">${group.rows.length} replay${group.rows.length === 1 ? "" : "s"}${latestWhen ? ` · latest ${esc(latestWhen)}` : ""}</span>
                </li>${group.rows.map(renderReplayRow).join("")}`;
              })
              .join("")}</ul>`
          : `<p class="fleet-muted">No GPS replay recorded for this bus in the last 7 days.</p>`;
    return `<section class="fleet-section fleet-vehicle-replays">
      <h2 class="fleet-section-title">Replay · last 7 days${count ? ` · ${count}` : ""}</h2>
      <p class="fleet-muted fleet-section-note">Grouped by route, with the newest replay for each route first. Replay uses the roads and positions actually recorded; older runs are removed after 7 days.</p>
      ${state.replayRunsLoading && count ? `<p class="fleet-muted">Refreshing recorded replays…</p>` : ""}
      ${body}
    </section>`;
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
        ${lastRouteHtml(
          v.lastRoute ||
            (state.journeys?.[0]
              ? { route: state.journeys[0].route_name, dest: state.journeys[0].destination }
              : null),
        )}
        ${lastTrackedHtml(
          v.lastRoute ||
            (state.journeys?.[0]
              ? { trackedAt: state.journeys[0].datetime, date: state.journeys[0].date }
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
        ${
          isSavedVehicle(v)
            ? `<button type="button" class="fleet-link-btn" data-action="remove-saved-vehicle" data-id="${esc(v.id)}" data-reg="${esc(v.reg || "")}">Remove from your vehicles</button>`
            : `<button type="button" class="fleet-link-btn" data-action="save-vehicle" data-id="${esc(v.id)}" data-reg="${esc(v.reg || "")}">Save this bus</button>`
        }
        ${
          isSingleVehicleRouteOperator(v.operator?.id || v.operator?.noc || state.operator?.noc)
            ? (() => {
                const route =
                  state.lineFilter ||
                  v.lastRoute?.route ||
                  state.journeys?.[0]?.route_name ||
                  "";
                const dest = v.lastRoute?.dest || state.journeys?.[0]?.destination || "";
                const when =
                  v.lastRoute?.trackedAt || state.journeys?.[0]?.datetime || "";
                const tripId = state.journeys?.[0]?.trip_id || "";
                const journeyId = state.journeys?.[0]?.id || "";
                const direction =
                  state.journeys?.[0]?.direction || v.lastRoute?.direction || "";
                return `<button type="button" class="fleet-link-btn" data-action="show-route-tails" data-line="${esc(route)}" data-operator="${esc(v.operator?.id || v.operator?.noc || state.operator?.noc || "")}" data-vehicle-id="${esc(v.id)}" data-trail-key="${esc(v.id)}" data-reg="${esc(v.reg || "")}" data-dest="${esc(dest)}" data-datetime="${esc(when)}" data-trip-id="${esc(tripId)}" data-journey-id="${esc(journeyId)}" data-direction="${esc(normalizeFleetDirection(direction))}">Map · this bus</button>`;
              })()
            : ""
        }
      </div>
      ${renderVehiclePhoto(v)}
      <section class="fleet-section fleet-vehicle-routes">
        <h2 class="fleet-section-title">Routes this bus has run${
          !state.vehicleRoutesLoading && state.vehicleRoutes.length ? ` · ${state.vehicleRoutes.length}` : ""
        }</h2>
        <p class="fleet-muted fleet-section-note">Unique service numbers from recent recorded journeys (27, 27A, …). Press a number to open that route.</p>
        ${renderRouteNumberChips(state.vehicleRoutes, {
          loading: state.vehicleRoutesLoading,
          emptyLabel: "No routes recorded yet for this bus.",
          openLine: true,
        })}
      </section>
      <label class="fleet-date">
        <span class="sr-only">Date</span>
        <select id="fleet-date">${Array.from({ length: 14 }, (_, i) => {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const key = ukDateKey(d);
          return `<option value="${esc(key)}" ${key === state.date ? "selected" : ""}>${esc(formatLongDate(key))}</option>`;
        }).join("")}</select>
      </label>
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${
        state.loading && !state.journeys.length
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
                        <td>${routeNumberBtn(line, { className: row.atLive || row.atTrail || row.coachTrail ? "fleet-route-at" : "" })}${row.atLive || row.live ? ` <span class="fleet-live-tag">live</span>` : ""}${row.diverted ? ` <span class="fleet-divert-tag">div</span>` : ""}</td>
                        <td class="fleet-trip"><span>${esc(time)}</span><span class="fleet-trip-alt">${esc(time)}</span></td>
                        <td>${esc(row.destination || "—")}${row.diverted ? ` <span class="fleet-muted">(diverted)</span>` : ""}</td>
                        <td class="fleet-row-actions">
                          ${
                            (() => {
                              const trailKey = row.trailKey || String(v.id || "");
                              if (!row.trip_id && !trailKey) return "";
                              return `<button type="button" class="fleet-link-btn" data-action="play-journey" ${fleetMapDataAttrs({
                                tripId: row.trip_id || "",
                                journeyId:
                                  row.journey_id ||
                                  (String(row.id || "").startsWith("at-") || String(row.id || "").startsWith("live-")
                                    ? ""
                                    : row.id) ||
                                  "",
                                vehicleId: v.id,
                                trailKey,
                                reg: v.reg || "",
                                line,
                                operator: v.operator?.id || v.operator?.noc || "",
                                direction: row.direction || "",
                                dest: row.destination || "",
                                datetime: row.datetime || "",
                                diverted: Boolean(row.diverted),
                              })}>Map</button>`;
                            })()
                          }
                        </td>
                      </tr>`;
                    })
                    .join("")}
                </tbody>
              </table>${state.loading ? `<p class="fleet-muted fleet-journeys-loading">Loading more journeys…</p>` : ""}`
            : `<p class="fleet-muted">No journeys recorded for this date.</p>`
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

  async function showHome(query = state.query, { fetchLive = true } = {}) {
    state.view = "home";
    state.query = query;
    state.operator = null;
    state.vehicle = null;
    state.lineFilter = "";
    state.atLine = "";
    state.atVehicles = [];
    state.atDayVehicles = [];
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
    state.vehicleRoutes = [];
    state.vehicleRoutesLoading = false;
    state.replayRuns = [];
    state.replayRunsLoading = false;
    state.replayRunsError = "";
    if (compactQuery(query).length >= 2) {
      setLoading(true);
      try {
        state.vehicleHits = await searchStaffsVehicles(query);
        setLoading(false);
        attachLastRoutes(
          state.vehicleHits,
          () => {
            if (state.view === "home") render();
          },
          { fetchHistory: true, historyLimit: 8 },
        );
      } catch (error) {
        setLoading(false, error.message || "Search failed");
      }
      if (fetchLive && state.tab === "fleet") void refreshFleetHomeLive();
      return;
    }
    render();
    if (fetchLive && state.tab === "fleet") void refreshFleetHomeLive();
  }

  async function refreshFleetHomeLive() {
    await Promise.all([
      ensureAtLive().catch(() => {}),
      ensureSchoolLive().catch(() => {}),
      ensureFpotOosLive().catch(() => {}),
      ensureDgOosLive().catch(() => {}),
      ensureDeadRunsHistory().catch(() => {}),
    ]);
    if (state.view === "home") render();
    void refreshSavedVehicleSummaries();
  }

  function unionRouteLines(existing, rows) {
    const map = new Map(
      (existing || [])
        .filter((row) => row?.line)
        .map((row) => [String(row.line).toUpperCase(), { ...row }]),
    );
    for (const row of rows || []) {
      const line = journeyLineCode(row);
      if (!line) continue;
      const key = line.toUpperCase();
      if (!map.has(key)) {
        map.set(key, {
          line,
          trips: 1,
          lastAt: row.datetime || row.date || "",
          dest: row.destination || "",
        });
      } else {
        const current = map.get(key);
        const rowWhen = row.datetime || row.date || "";
        if (String(rowWhen) > String(current.lastAt || "")) {
          current.lastAt = rowWhen;
          current.dest = row.destination || current.dest || "";
        }
      }
    }
    return [...map.values()].sort(compareRouteSummaryRows);
  }

  async function loadVehicleReplayRuns(vehicle, token = vehicleLoadToken) {
    const id = String(vehicle?.id || "").trim();
    const reg = String(vehicle?.reg || "").trim();
    if (!id && !reg) {
      state.replayRuns = [];
      state.replayRunsLoading = false;
      state.replayRunsError = "This vehicle has no replay identity yet.";
      return;
    }
    state.replayRunsLoading = true;
    state.replayRunsError = "";
    if (state.view === "vehicle" && String(state.vehicle?.id) === id) render();
    try {
      const rows = await cachedVehicleReplayRuns(vehicle);
      if (token !== vehicleLoadToken || String(state.vehicle?.id) !== id) return;
      state.replayRuns = Array.isArray(rows) ? rows : [];
    } catch (error) {
      if (token !== vehicleLoadToken || String(state.vehicle?.id) !== id) return;
      state.replayRuns = [];
      state.replayRunsError = error?.message || "Could not load recorded replays";
    } finally {
      if (token === vehicleLoadToken && String(state.vehicle?.id) === id) {
        state.replayRunsLoading = false;
        if (state.view === "vehicle") render();
      }
    }
  }

  async function loadVehicleRouteSummary(vehicle) {
    const id = String(vehicle?.id || "");
    if (!id) {
      state.vehicleRoutes = [];
      state.vehicleRoutesLoading = false;
      return;
    }
    const saved = state.savedVehicles.find((row) => row.id === id);
    if (saved?.routes?.length && !state.vehicleRoutes.length) {
      state.vehicleRoutes = saved.routes;
    }
    if (!state.vehicleRoutes.length) state.vehicleRoutesLoading = true;
    try {
      const routes = await fetchVehicleRouteSummary(id);
      if (String(state.vehicle?.id) !== id) return;
      const merged = unionRouteLines(routes, state.allJourneys);
      state.vehicleRoutes = merged;
      state.vehicleRoutesLoading = false;
      if (isSavedVehicle(vehicle)) upsertSavedVehicle(vehicle, merged);
      render();
    } catch {
      if (String(state.vehicle?.id) === id) {
        state.vehicleRoutesLoading = false;
        render();
      }
    }
  }

  async function refreshSavedVehicleSummaries() {
    const staleMs = 6 * 60 * 60 * 1000;
    for (const item of state.savedVehicles) {
      if (!item.id) continue;
      if (item.routes?.length && Date.now() - (item.routesAt || 0) < staleMs) continue;
      try {
        const routes = await fetchVehicleRouteSummary(item.id);
        item.routes = routes;
        item.routesAt = Date.now();
        persistSavedState();
        if (state.view === "home") render();
      } catch {
        /* keep cached routes */
      }
    }
  }

  async function addSavedVehicleByQuery(raw) {
    const query = String(raw || "").trim();
    if (!query) return;
    state.tab = "fleet";
    state.savedError = "";
    state.savedBusy = true;
    if (state.view === "home") render();
    try {
      const hits = await searchStaffsVehicles(query);
      const plate = looksLikeUkReg(query) ? compactQuery(query) : "";
      const exact = plate ? hits.filter((v) => compactQuery(v.reg) === plate) : [];
      const pool = exact.length ? exact : hits;
      if (!pool.length) {
        state.savedBusy = false;
        state.savedError = `No vehicle matched “${query}”.`;
        return showHome(query);
      }
      if (pool.length > 1) {
        state.savedBusy = false;
        state.savedError = "Several matches — open the bus you want, then press Save this bus.";
        return showHome(query);
      }
      const vehicle = pool[0];
      upsertSavedVehicle(vehicle);
      state.savedBusy = false;
      const panel = root.closest("#fleet-panel");
      const toolbar = panel?.querySelector("#fleet-vehicle-query");
      if (toolbar) toolbar.value = "";
      await showHome("", { fetchLive: false });
      const routes = await fetchVehicleRouteSummary(vehicle.id);
      upsertSavedVehicle(vehicle, routes);
      if (state.view === "home") render();
    } catch (error) {
      state.savedBusy = false;
      state.savedError = error.message || "Could not add that vehicle";
      if (state.view === "home") render();
    }
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
    state.routeTimetable = [];
    state.routeTimetableLoading = false;
    state.routeTimetableError = "";
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
      if (services.length === 1) {
        return showRouteService(String(services[0].id), state.date);
      }
      const primaryId = String(services[0]?.id || "");
      if (primaryId) {
        fetchServiceTimetableTrips(primaryId, state.date).catch(() => {});
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
    state.routeTimetable = [];
    state.routeTimetableError = "";
    state.routeTimetableLoading = true;
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
      // Prefer this operator when opening related line pages / crumbs (FlixBus, NATX, …).
      const noc = serviceOperatorNoc(service);
      if (noc) {
        state._routePreferNoc = noc;
        const op =
          STAFFS_OPERATORS.find((row) => String(row.noc || "").toUpperCase() === noc) || null;
        if (op) state.operator = op;
      }
      const coach = ["FLIX", "NATX"].includes(noc);
      const stillThisService = () =>
        state.view === "route" && String(state.routeService?.id) === id;
      const applyTimetable = (trips, { loading = false, error = "" } = {}) => {
        if (!stillThisService()) return;
        state.routeTimetable = trips;
        state.routeTimetableLoading = loading;
        if (error) state.routeTimetableError = error;
        render();
      };
      const fillStopTimes = (trips) => {
        if (!trips.length || !stillThisService()) return;
        enrichTripsWithStopTimes(trips, {
          perDirection: 8,
          concurrency: 10,
          onChunk: (partial) => applyTimetable(partial, { loading: true }),
        })
          .then((enriched) => applyTimetable(enriched, { loading: false }))
          .catch((error) =>
            applyTimetable(trips, {
              loading: false,
              error: error.message || "Could not load stop times",
            }),
          );
      };
      let stopTimesStarted = false;
      fetchServiceTimetableTrips(id, state.date, {
        onPage(trips) {
          applyTimetable(trips, { loading: true });
          if (!stopTimesStarted) {
            stopTimesStarted = true;
            fillStopTimes(trips);
          }
        },
      })
        .then((trips) => {
          if (!stillThisService()) return;
          state.routeTimetable = trips;
          if (!trips.length) {
            state.routeTimetableLoading = false;
            render();
            return;
          }
          fillStopTimes(trips);
        })
        .catch((error) => {
          applyTimetable([], {
            loading: false,
            error: error.message || "Could not load timetable",
          });
        });
      const [vehicles, live] = await Promise.all([
        fetchServiceJourneyVehicles(id, state.date, { includeAnonymous: coach }),
        fetchLiveServiceVehicles(id),
      ]);
      if (!stillThisService()) return;
      state.routeVehicles = coach ? mergeRouteVehiclesWithLive(vehicles, live, service) : vehicles;
      state.routeLiveCount = live.length;
      setLoading(false);
    } catch (error) {
      state.routeVehicles = [];
      state.routeLiveCount = 0;
      state.routeTimetable = [];
      state.routeTimetableLoading = false;
      state.routeTimetableError = error.message || "Could not load route";
      setLoading(false, error.message || "Could not load route buses");
    }
  }

  async function showAtRoute(line, date = state.date) {
    const code = String(line || "").toUpperCase();
    if (!AT_LINE_SET.has(code)) return showHome();
    state.view = "at-route";
    state.atLine = code;
    state.date = date || ukDateKey();
    state.lineFilter = "";
    state.vehicle = null;
    state.operator = null;
    state.schoolLine = "";
    state.schoolVehicles = [];
    state.matchdayLine = "";
    state.matchdayVehicles = [];
    state.journeys = [];
    state.allJourneys = [];
    state.atDayVehicles = [];
    state.routeTimetable = [];
    state.routeTimetableError = "";
    state.routeTimetableLoading = true;
    setLoading(true);
    try {
      const cache = await ensureAtLive(0);
      state.atMeta = cache.meta.get(code) || AT_ROUTES.find((row) => row.line === code) || { line: code };
      const liveEntries = [...(cache.byLine.get(code) || [])];
      fetchAtTimetableTrips(code, state.date)
        .then((trips) => {
          if (state.view !== "at-route" || String(state.atLine || "").toUpperCase() !== code) return;
          state.routeTimetable = trips;
          state.routeTimetableLoading = false;
          render();
        })
        .catch((error) => {
          if (state.view !== "at-route" || String(state.atLine || "").toUpperCase() !== code) return;
          state.routeTimetable = [];
          state.routeTimetableLoading = false;
          state.routeTimetableError = error.message || "Could not load timetable";
          render();
        });
      const [, dayVehicles] = await Promise.all([
        Promise.all(liveEntries.map((entry) => resolveAtVehicleId(entry))),
        fetchAtVehiclesForDay(code, state.date),
      ]);
      state.atVehicles = liveEntries;
      state.atDayVehicles = dayVehicles;
      setLoading(false);
    } catch (error) {
      state.routeTimetable = [];
      state.routeTimetableLoading = false;
      state.routeTimetableError = error.message || "Could not load timetable";
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
      state.operatorRoutes = [];
    }
    state.operatorRoutesLoading = false;
    if (!op.noc) {
      render();
      return;
    }
    setLoading(true);
    const wantRoutes = isRouteCatalogueOperator(op.noc);
    if (wantRoutes) state.operatorRoutesLoading = true;
    void fetchOperatorLiveMap(op.noc).catch(() => {});
    const opSlug = op.slug;
    let liveAttached = false;
    const bumpLive = (rows) => {
      attachLastRoutes(
        rows,
        () => {
          if (state.view === "operator" && state.operator?.slug === opSlug) render();
        },
        { operatorNoc: op.noc, fetchHistory: false },
      );
    };
    if (wantRoutes) {
      fetchAllOperatorServices(op.noc)
        .catch(() => [])
        .then((routes) => {
          if (state.operator?.slug !== opSlug || state.view !== "operator") return;
          const list = [...routes];
          if (String(op.noc).toUpperCase() === "DAGC") {
            for (const at of AT_ROUTES) {
              if (!list.some((row) => sameLineCode(row.line_name, at.line))) {
                list.unshift({
                  id: `at:${at.line}`,
                  line_name: at.line,
                  description: `${at.name} · ${at.origin || ""} → ${at.destination || "Alton Towers"}`,
                  _at: true,
                });
              }
            }
            list.sort((a, b) => {
              const aAt = Boolean(a._at);
              const bAt = Boolean(b._at);
              if (aAt !== bAt) return aAt ? -1 : 1;
              return compareLineNames(a.line_name, b.line_name);
            });
          }
          state.operatorRoutes = list;
          state.operatorRoutesLoading = false;
          render();
          const day = ukDateKey();
          for (const row of list.slice(0, 8)) {
            const sid = String(row.id || "");
            if (!sid || sid.startsWith("at:")) continue;
            fetchServiceTimetableTrips(sid, day).catch(() => {});
          }
          if (String(op.noc).toUpperCase() === "DAGC") {
            for (const at of AT_ROUTES) fetchAtTimetableTrips(at.line).catch(() => {});
          }
        });
    }
    try {
      const data = await fetchAllOperatorVehicles(op.noc, {
        search: state.query,
        onPage(results, count, done) {
          if (state.operator?.slug !== opSlug || state.view !== "operator") return;
          state.vehicles = results;
          state.vehicleCount = count || results.length;
          state.vehicleOffset = results.length;
          state.loading = false;
          state.error = "";
          render();
          if (!liveAttached || done) {
            liveAttached = true;
            bumpLive(results);
          }
        },
      });
      const batch = data.results || [];
      state.vehicles = batch;
      state.vehicleCount = data.count || batch.length;
      state.vehicleOffset = batch.length;
      setLoading(false);
      bumpLive(batch);
    } catch (error) {
      state.operatorRoutesLoading = false;
      setLoading(false, error.message || "Could not load vehicles");
    }
  }

  let vehicleLoadToken = 0;

  function resolveOperatorFromVehicle(vehicle, seed = null) {
    return (
      STAFFS_OPERATORS.find(
        (op) =>
          op.slug === vehicle?.operator?.slug ||
          op.noc === vehicle?.operator?.id ||
          op.slug === seed?.operator?.slug ||
          op.noc === seed?.operator?.id ||
          op.noc === seed?.operator?.noc,
      ) || {
        name: vehicle?.operator?.name || seed?.operator?.name || "Operator",
        slug: vehicle?.operator?.slug || seed?.operator?.slug || "",
        noc: vehicle?.operator?.id || seed?.operator?.noc || seed?.operator?.id || null,
      }
    );
  }

  function buildSeedVehicle(id, seed = {}) {
    const fleetCode = seed.fleet || seed.fleet_code || "";
    const plate = seed.reg || "";
    const line = seed.line || seed.lastRoute?.route || "";
    return {
      id: id || seed.id || "",
      reg: plate,
      fleet_code: fleetCode,
      fleet_number: fleetCode,
      branding: seed.branding || "",
      previous_reg: seed.previous_reg || "",
      livery: seed.livery || null,
      vehicle_type: seed.vehicle_type || null,
      operator:
        seed.operator ||
        (seed.operatorName
          ? { name: seed.operatorName, slug: seed.operatorSlug || "", id: seed.operatorNoc || null }
          : { name: "Operator", slug: "", id: null }),
      lastRoute:
        seed.lastRoute ||
        (line
          ? {
              route: line,
              dest: seed.dest || "",
              live: true,
              trackedAt: seed.trackedAt || new Date().toISOString(),
            }
          : null),
      _seed: true,
    };
  }

  /** Immediate fleet vehicle shell from map popup data — does not wait on bustimes. */
  function showVehiclePending(seed = {}) {
    const token = ++vehicleLoadToken;
    state.photo = null;
    state.photoPending = false;
    state.photoStatus = "";
    state.photoLoading = Boolean(seed.reg);
    state.view = "vehicle";
    state.vehicle = buildSeedVehicle(seed.id || "", seed);
    state.operator = resolveOperatorFromVehicle(state.vehicle, seed);
    state.date = state.date || ukDateKey();
    state.journeys = [];
    state.allJourneys = [];
    state.loading = true;
    state.error = "";
    render();
    if (seed.reg) loadVehiclePhoto(state.vehicle);
    return token;
  }

  function applyJourneysToState(vehicle, journeys, lineFilter, { loading = false } = {}) {
    state.allJourneys = journeys;
    state.journeys = filterJourneysByLine(journeys, lineFilter);
    state.vehicle = vehicle;
    state.loading = Boolean(loading);
    state.error = "";
    // Always union: AT1–AT3 exist only in GPS trails, so a bus whose whole route history
    // is AT work starts with an empty list and must still pick its routes up here.
    state.vehicleRoutes = unionRouteLines(state.vehicleRoutes, journeys);
    render();
  }

  async function mergeAtHistoryDeferred({
    token,
    vehicle,
    date,
    at,
    lineFilter,
    journeys,
  }) {
    const atLineFilter = AT_LINE_SET.has(String(lineFilter || "").toUpperCase())
      ? String(lineFilter).toUpperCase()
      : "";
    const isDg =
      String(vehicle.operator?.id || vehicle.operator?.noc || "").toUpperCase() === "DAGC" ||
      /d-g-coach|D\s*&\s*G/i.test(`${vehicle.operator?.slug || ""} ${vehicle.operator?.name || ""}`);
    // AT1–AT3 have no bustimes service, so they only ever come from GPS trails. Do not
    // require the bus to still be live (`at`): once it finishes the route the live match
    // goes null and these routes would vanish from "Routes this bus has run".
    const lastLine = String(vehicle.lastRoute?.line || "").toUpperCase();
    const hasAtSignal =
      atLineFilter || at || isDg || AT_LINE_SET.has(lastLine) || /d-g-coach|D\s*&\s*G/i.test(String(vehicle.operatorName || ""));
    if (!hasAtSignal) return;
    const regKey = compactQuery(vehicle.reg);
    const trailKeys = [
      at?.ref ? `staff-${at.ref}` : "",
      String(vehicle.id || ""),
      regKey && /^[A-Z0-9]+$/.test(regKey) ? `reg:${regKey}` : "",
    ].filter(Boolean);
    try {
      const atRows = await fetchAtHistoryFromTrails({
        trailKeys,
        line: atLineFilter || "",
        date,
        days: 7,
      });
      if (token !== vehicleLoadToken || String(state.vehicle?.id) !== String(vehicle.id)) return;
      const defaultTrail =
        (at?.ref ? `staff-${at.ref}` : "") || String(vehicle.id || "");
      const base = Array.isArray(state.allJourneys) && state.allJourneys.length ? state.allJourneys : journeys;
      const merged = mergeAtHistoryRows(base, atRows).map((row) => ({
        ...row,
        trailKey: row.trailKey || defaultTrail,
      }));
      applyJourneysToState(vehicle, merged, state.lineFilter);
      // Cache AT routes on saved vehicles so they are still listed after a reload,
      // even though they exist only in GPS trails and never in bustimes.
      if (state.vehicleRoutes.length && isSavedVehicle(vehicle)) {
        upsertSavedVehicle(vehicle, state.vehicleRoutes);
      }
    } catch {
      // AT trail history is optional enrichment.
    }
  }

  /** FlixBus vehicle day view — GPS trail store only (no bustimes.org journeys). */
  async function mergeFlixHistoryDeferred({ token, vehicle, date, lineFilter, journeys }) {
    const noc = String(vehicle.operator?.noc || vehicle.operator?.id || "").toUpperCase();
    const isFlix =
      noc === "FLIX" ||
      /flix/i.test(`${vehicle.operator?.slug || ""} ${vehicle.operator?.name || ""}`);
    if (!isFlix) return;
    try {
      const coachRows = await cachedVehicleReplayRuns({
        ...vehicle,
        operator: vehicle.operator || { noc: "FLIX", id: "FLIX" },
      });
      if (token !== vehicleLoadToken || String(state.vehicle?.id) !== String(vehicle.id)) return;
      const filtered = date
        ? coachRows.filter((row) => !row.date || row.date === date)
        : coachRows;
      const base = Array.isArray(state.allJourneys) && state.allJourneys.length ? state.allJourneys : journeys;
      const merged = mergeAtHistoryRows(base, filtered).map((row) => ({
        ...row,
        trailKey: row.trailKey || String(vehicle.id || ""),
      }));
      applyJourneysToState(vehicle, merged, state.lineFilter);
    } catch {
      // Flix GPS history optional.
    }
  }

  /**
   * First Potteries / Staffordshire locals: merge GPS-trail run history into the
   * bustimes day view (dead runs, positioning legs and journeys bustimes lacks).
   * Mirrors the map popup's isStaffsBusTrail merge.
   */
  async function mergeStaffsHistoryDeferred({ token, vehicle, date, lineFilter, journeys }) {
    const noc = String(
      vehicle.operator?.noc || vehicle.operator?.id || state.operator?.noc || "",
    ).toUpperCase();
    const staffsNocs = new Set(STAFFS_OPERATORS.map((op) => op.noc).filter(Boolean));
    // BS1–BS2 shuttles are First Potteries but often surface from GPS trails with no
    // operator block, so also trigger on a shuttle line seen anywhere for this bus.
    const lineSignal = String(vehicle.lastRoute?.line || lineFilter || "").toUpperCase();
    const isShuttle = STOKE_FC_LINE_SET.has(lineSignal);
    const isStaffs = staffsNocs.has(noc) || isShuttle;
    if (!isStaffs) return;
    const regKey = compactQuery(vehicle.reg);
    const idKey = String(vehicle.id || "").trim();
    if (!idKey && !regKey) return;
    try {
      const coachRows = await cachedVehicleReplayRuns({
        ...vehicle,
        operator: vehicle.operator || { noc, id: noc },
      });
      if (token !== vehicleLoadToken || String(state.vehicle?.id) !== String(vehicle.id)) return;
      const filtered = date
        ? coachRows.filter((row) => !row.date || row.date === date)
        : coachRows;
      // "Routes this bus has run" should keep every route from the whole 7-day window,
      // not just the day on screen — otherwise a finished BS1/BS2 run drops off the list.
      state.vehicleRoutes = unionRouteLines(state.vehicleRoutes, coachRows);
      if (!filtered.length) {
        if (state.vehicleRoutes.length) {
          state.vehicleRoutesLoading = false;
          render();
        }
        return;
      }
      const base = Array.isArray(state.allJourneys) && state.allJourneys.length ? state.allJourneys : journeys;
      const merged = mergeAtHistoryRows(base, filtered).map((row) => ({
        ...row,
        trailKey: row.trailKey || idKey || `reg:${regKey}`,
      }));
      applyJourneysToState(vehicle, merged, state.lineFilter);
      // Persist so saved vehicles keep their shuttle routes across reloads.
      if (state.vehicleRoutes.length && isSavedVehicle(vehicle)) {
        upsertSavedVehicle(vehicle, state.vehicleRoutes);
      }
    } catch {
      // Staffs GPS history optional.
    }
  }

  async function showVehicle(id, date = state.date, opts = {}) {
    // Vehicle day view always lists every route for that day (no per-line chips).
    state.lineFilter = "";
    const knownVehicle = !opts.seed
      ? [
          ...(state.vehicles || []),
          ...(state.vehicleHits || []),
          ...(state.routeVehicles || []),
          ...(state.atVehicles || []),
          ...(state.schoolVehicles || []),
          ...(state.matchdayVehicles || []),
          ...(state.savedVehicles || []),
        ].find(
          (row) => String(row?.id || "") === String(id),
        )
      : null;
    // Fleet/operator lists already contain most metadata. Use it for the first
    // paint instead of showing a blank vehicle while the detail request runs.
    const seed = opts.seed || knownVehicle || null;
    const token = ++vehicleLoadToken;
    state.photo = null;
    state.photoPending = false;
    state.photoStatus = "";
    state.photoLoading = true;
    state.date = date;
    state.error = "";
    if (String(state.vehicle?.id) !== String(id)) {
      state.vehicleRoutes = [];
      state.vehicleRoutesLoading = true;
      state.replayRuns = [];
      state.replayRunsLoading = false;
      state.replayRunsError = "";
    }

    // First paint: shell from map/live seed (or keep prior vehicle if same id) before network.
    if (seed || String(state.vehicle?.id) === String(id)) {
      state.view = "vehicle";
      if (seed) {
        const prior =
          state.vehicle && String(state.vehicle.id) === String(id) && !state.vehicle._seed
            ? state.vehicle
            : null;
        state.vehicle = {
          ...(prior || {}),
          ...buildSeedVehicle(id, seed),
          id,
          // Prefer real prior meta when we already have a full record for this id.
          ...(prior
            ? {
                livery: prior.livery || seed.livery || null,
                vehicle_type: prior.vehicle_type || seed.vehicle_type || null,
                branding: prior.branding || seed.branding || "",
                previous_reg: prior.previous_reg || seed.previous_reg || "",
                operator: prior.operator || seed.operator || null,
              }
            : {}),
        };
        state.operator = resolveOperatorFromVehicle(state.vehicle, seed);
      }
      state.journeys = [];
      state.allJourneys = [];
      state.loading = true;
      render();
    } else {
      // Fleet list / date change — still paint a minimal card shell immediately.
      state.view = "vehicle";
      state.vehicle = {
        id,
        reg: "",
        fleet_code: "",
        operator: state.operator || { name: "Operator", slug: "", id: null },
        lastRoute: null,
        _seed: true,
      };
      state.journeys = [];
      state.allJourneys = [];
      state.loading = true;
      state.error = "";
      render();
    }

    // Start the independent history/route requests before the detail request
    // finishes. The first page can render immediately; later pages enrich it.
    let progressiveLiveBus = null;
    const detailPromise = fetchVehicle(id);
    const livePromise = fetchLiveVehicleById(id).then((row) => {
      progressiveLiveBus = row;
      return row;
    });
    const seedLooksFlix = Boolean(
      seed &&
        (/flix/i.test(`${seed.operator?.name || seed.operator || seed.operatorName || ""}`) ||
          String(seed.operator?.noc || seed.operator?.id || "").toUpperCase() === "FLIX"),
    );
    const showProgressiveJourneys = (partial) => {
      if (token !== vehicleLoadToken || state.view !== "vehicle") return;
      if (String(state.vehicle?.id) !== String(id) || !partial?.length) return;
      const current = state.vehicle || buildSeedVehicle(id, seed || {});
      const rows = partial.map((row) => enrichJourneyRow(row, progressiveLiveBus));
      applyJourneysToState(current, rows, state.lineFilter, { loading: true });
    };
    const journeysPromise = seedLooksFlix
      ? Promise.resolve([])
      : fetchVehicleJourneys(id, date, { onPage: showProgressiveJourneys }).catch(() => []);
    const routeSummaryPromise = state.vehicle?.id
      ? loadVehicleRouteSummary(state.vehicle)
      : Promise.resolve();
    void routeSummaryPromise.catch(() => {});

    try {
      // Vehicle detail + live AVL in parallel (skip serial lastRoute / duplicate live fetch).
      let vehicle = null;
      let liveBus = null;
      try {
        [vehicle, liveBus] = await Promise.all([detailPromise, livePromise]);
      } catch (detailError) {
        liveBus = await livePromise.catch(() => null);
        const flixSeed =
          seed ||
          (liveBus &&
          (/flix/i.test(
            `${liveBus.operator?.name || ""} ${liveBus.operator?.noc || liveBus.operator?.id || ""} ${liveBus.vehicle?.name || ""}`,
          ) ||
            String(liveBus.operator?.noc || liveBus.operator?.id || liveBus._bods?.operator || "")
              .toUpperCase() === "FLIX")
            ? {
                id,
                line: liveBus.service?.line_name || "",
                dest: liveBus.destination || "",
                reg: liveBus.vehicle?.reg || "",
                operator: {
                  name: "FlixBus",
                  slug: "flixbus",
                  noc: "FLIX",
                  id: "FLIX",
                },
                trackedAt: liveBus.datetime || "",
              }
            : null);
        if (!flixSeed) throw detailError;
        vehicle = buildSeedVehicle(id, flixSeed);
        vehicle.operator = {
          name: "FlixBus",
          slug: "flixbus",
          noc: "FLIX",
          id: "FLIX",
        };
      }
      if (token !== vehicleLoadToken) return;

      lastRouteCache.delete(String(vehicle.id));
      if (liveBus && (liveBus.service?.line_name || liveBus.destination || liveBus.datetime)) {
        vehicle.lastRoute = {
          route: extractRouteFromVehicle(liveBus) || liveBus.service?.line_name || "",
          dest: liveBus.destination || "",
          live: true,
          diverted: isDivertedText(liveBus.destination, liveBus.service?.line_name),
          trackedAt: liveBus.datetime || new Date().toISOString(),
          direction: directionFromJourneyRow(liveBus),
        };
      } else if (seed?.lastRoute || seed?.line) {
        vehicle.lastRoute =
          seed.lastRoute ||
          {
            route: seed.line || "",
            dest: seed.dest || "",
            live: true,
            trackedAt: seed.trackedAt || "",
          };
      }

      // Ensure Flix operator meta even when bustimes vehicle record is missing.
      if (
        seedLooksFlix ||
        String(liveBus?.operator?.noc || liveBus?._bods?.operator || "").toUpperCase() === "FLIX"
      ) {
        vehicle.operator = {
          ...(vehicle.operator || {}),
          name: "FlixBus",
          slug: "flixbus",
          noc: "FLIX",
          id: vehicle.operator?.id || "FLIX",
        };
      }

      state.view = "vehicle";
      state.vehicle = vehicle;
      state.operator = resolveOperatorFromVehicle(vehicle, seed) || state.operator;
      state.loading = true;
      render(); // Shell with full bustimes meta; journeys still loading
      loadVehiclePhoto(vehicle);

      // Warm lastRoute cache in background when live AVL missed (do not block paint).
      if (!vehicle.lastRoute) {
        fetchLastRoute(vehicle)
          .then((route) => {
            if (token !== vehicleLoadToken || !route) return;
            if (String(state.vehicle?.id) !== String(vehicle.id)) return;
            if (state.vehicle.lastRoute) return;
            state.vehicle.lastRoute = route;
            render();
          })
          .catch(() => {});
      }

      let journeys = [];
      const vehicleNoc = String(vehicle.operator?.noc || vehicle.operator?.id || "").toUpperCase();
      const isFlixVehicle =
        vehicleNoc === "FLIX" ||
        /flix/i.test(`${vehicle.operator?.slug || ""} ${vehicle.operator?.name || ""}`) ||
        seedLooksFlix;
      if (!isFlixVehicle) {
        journeys = (await journeysPromise).map((row) => enrichJourneyRow(row, liveBus));
      }
      if (token !== vehicleLoadToken) return;

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
              direction: liveRow.direction || directionFromJourneyRow(liveBus),
            };
          }
        }
      }

      // AT live match is cheap if cache warm; do not await a cold ensureAtLive here.
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
            direction:
              row.direction ||
              normalizeFleetDirection(at.direction || at.directionRef || "") ||
              "",
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
              direction: normalizeFleetDirection(at.direction || at.directionRef || ""),
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
          direction: normalizeFleetDirection(at.direction || at.directionRef || ""),
        };
      } else if (!vehicle.lastRoute && journeys[0]) {
        vehicle.lastRoute = {
          route: journeys[0].route_name || "",
          dest: journeys[0].destination || "",
          trackedAt: journeys[0].datetime || "",
          date: journeys[0].date || "",
          direction: journeys[0].direction || "",
        };
      } else if (vehicle.lastRoute && !vehicle.lastRoute.trackedAt && journeys[0]) {
        vehicle.lastRoute = {
          ...vehicle.lastRoute,
          trackedAt: journeys[0].datetime || vehicle.lastRoute.trackedAt || "",
          date: journeys[0].date || vehicle.lastRoute.date || "",
          direction: vehicle.lastRoute.direction || journeys[0].direction || "",
        };
      }

      const defaultTrail = (at?.ref ? `staff-${at.ref}` : "") || String(vehicle.id || "");
      journeys = journeys.map((row) => ({
        ...row,
        trailKey: row.trailKey || defaultTrail,
      }));

      // Paint today's bustimes journeys immediately — do not wait on 7-day AT trails.
      applyJourneysToState(vehicle, journeys, state.lineFilter);
      void loadVehicleRouteSummary(vehicle);

      void mergeAtHistoryDeferred({
        token,
        vehicle,
        date,
        at,
        lineFilter: state.lineFilter,
        journeys,
      });

      void mergeFlixHistoryDeferred({
        token,
        vehicle,
        date,
        lineFilter: state.lineFilter,
        journeys,
      });

      void mergeStaffsHistoryDeferred({
        token,
        vehicle,
        date,
        lineFilter: state.lineFilter,
        journeys,
      });

      // If AT cache was cold, refresh in background and re-merge live AT row when ready.
      if (!at) {
        const isDg =
          String(vehicle.operator?.id || vehicle.operator?.noc || "").toUpperCase() === "DAGC" ||
          /d-g-coach|D\s*&\s*G/i.test(`${vehicle.operator?.slug || ""} ${vehicle.operator?.name || ""}`);
        if (isDg) {
          ensureAtLive()
            .then(() => {
              if (token !== vehicleLoadToken) return;
              const lateAt = matchAtLive(vehicle);
              if (!lateAt || date !== ukDateKey()) return;
              void mergeAtHistoryDeferred({
                token,
                vehicle,
                date,
                at: lateAt,
                lineFilter: state.lineFilter,
                journeys: state.allJourneys || journeys,
              });
              if (String(state.vehicle?.id) === String(vehicle.id)) {
                state.vehicle.lastRoute = {
                  route: lateAt.line,
                  dest: lateAt.dest,
                  live: true,
                  at: true,
                  trackedAt: lateAt.recordedAtTime || new Date().toISOString(),
                  direction: normalizeFleetDirection(lateAt.direction || lateAt.directionRef || ""),
                };
                render();
              }
            })
            .catch(() => {});
        }
      }
    } catch (error) {
      if (token !== vehicleLoadToken) return;
      const msg = String(error?.message || "");
      if (/Request failed \(404\)/i.test(msg)) {
        setLoading(false, "Vehicle not found — open FlixBus or National Express from the Fleet list");
        return;
      }
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
      const line = btn.dataset.line || state.routeLine;
      showRouteLine(line);
      return;
    }
    if (action === "show-route-tails") {
      event.preventDefault();
      event.stopPropagation();
      const line = btn.dataset.line || state.routeLine || state.atLine || state.schoolLine || state.matchdayLine || "";
      const operator =
        btn.dataset.operator || state.vehicle?.operator?.id || state.operator?.noc || "";
      const oneId = btn.dataset.vehicleId || "";
      const oneTrail = btn.dataset.trailKey || "";
      const oneReg = btn.dataset.reg || "";
      // Flix / NATX / D&G / First Potteries / Stanton's / AT1–AT3: prefer one bus when known.
      const forceSingle =
        isSingleVehicleRouteOperator(operator) || AT_LINE_SET.has(String(line || "").toUpperCase());
      const dedupeRouteVehicles = (rows) => {
        const byBus = new Map();
        for (const row of rows || []) {
          if (!sameServiceLine(row.route_name || row.line || line, line)) continue;
          const id = String(row.id || row.btId || row.vehicleId || "");
          if (!id || byBus.has(id)) continue;
          byBus.set(id, row);
        }
        return [...byBus.values()];
      };
      let vehicles = [];
      if (!(oneId || oneTrail || oneReg || (forceSingle && state.vehicle?.id))) {
        vehicles = state.routeVehicles?.length
          ? dedupeRouteVehicles(state.routeVehicles)
          : state.atVehicles?.length
            ? state.atVehicles.filter((v) => sameServiceLine(v.line || line, line))
            : state.schoolVehicles?.length
              ? state.schoolVehicles.filter((v) => sameServiceLine(v.line || line, line))
              : dedupeRouteVehicles(state.matchdayVehicles || []);
      }
      onShowRouteTails?.({
        line,
        operator,
        vehicles,
        vehicleId: oneId || (forceSingle && state.vehicle?.id ? String(state.vehicle.id) : ""),
        trailKey: oneTrail || (forceSingle && state.vehicle?.id ? String(state.vehicle.id) : ""),
        reg: oneReg || (forceSingle ? state.vehicle?.reg || "" : ""),
        journeyId: btn.dataset.journeyId || "",
        tripId: btn.dataset.tripId || "",
        datetime: btn.dataset.datetime || "",
        direction: btn.dataset.direction || "",
      });
      return;
    }
    if (action === "upload-photo") {
      event.preventDefault();
      event.stopPropagation();
      beginFleetPhotoUpload(btn);
      return;
    }
    if (action === "save-vehicle") {
      event.preventDefault();
      event.stopPropagation();
      const vehicle =
        state.vehicle && String(state.vehicle.id) === String(btn.dataset.id || state.vehicle.id)
          ? state.vehicle
          : { id: btn.dataset.id, reg: btn.dataset.reg, fleet: btn.dataset.fleet };
      upsertSavedVehicle(vehicle, state.vehicleRoutes.length ? state.vehicleRoutes : null);
      if (!state.vehicleRoutes.length && vehicle.id) void loadVehicleRouteSummary(vehicle);
      else render();
      return;
    }
    if (action === "remove-saved-vehicle") {
      event.preventDefault();
      event.stopPropagation();
      removeSavedVehicle(btn.dataset.id, btn.dataset.reg);
      render();
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
      showVehicle(btn.dataset.id, state.date);
    }
    if (action === "more-vehicles" && state.operator) showOperator(state.operator.slug, { reset: false });
    if (action === "track-vehicle" || action === "track-at") {
      onTrackVehicle?.({
        id: btn.dataset.id,
        reg: btn.dataset.reg,
        fleet: btn.dataset.fleet,
        ref: btn.dataset.ref,
        line: btn.dataset.line,
        lat: btn.dataset.lat,
        lng: btn.dataset.lng,
      });
    }
    if (action === "play-journey") {
      onPlayJourney?.({
        tripId: btn.dataset.tripId,
        journeyId: btn.dataset.journeyId,
        vehicleId: btn.dataset.vehicleId,
        trailKey: btn.dataset.trailKey,
        reg: btn.dataset.reg,
        line: btn.dataset.line,
        operator: btn.dataset.operator,
        direction: btn.dataset.direction,
        dest: btn.dataset.dest,
        datetime: btn.dataset.datetime,
        diverted: btn.dataset.diverted === "1",
        autoReplay: btn.dataset.replay === "1",
        recordedReplay: btn.dataset.replayRecorded === "1",
      });
    }
  });

  root.addEventListener("submit", (event) => {
    const form = event.target.closest?.("#fleet-add-vehicle-form");
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const query = form.querySelector("#fleet-add-vehicle-query")?.value.trim() || "";
    addSavedVehicleByQuery(query);
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
      return;
    }
    if (event.target.id === "fleet-at-date" && state.atLine) {
      showAtRoute(state.atLine, event.target.value);
    }
  });

  const panel = root.closest("#fleet-panel");
  panel?.querySelectorAll(".fleet-bottom-tab").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.fleetTab));
  });

  // Lightweight first paint — no AT/school live network until Fleet is opened.
  showHome("", { fetchLive: false });

  return {
    showHome,
    showOperator,
    showVehicle,
    showVehiclePending,
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
    addVehicleReg(query) {
      return addSavedVehicleByQuery(query);
    },
    /** Call when Fleet panel becomes visible so live AT/school cards can load. */
    wake() {
      if (state.view !== "home") return Promise.resolve();
      const atFresh = Date.now() - atLiveCache.at < 20000 && atLiveCache.meta.size;
      const schoolFresh = Date.now() - schoolLiveCache.at < 15000 && schoolLiveCache.meta.size;
      const oosFresh = Date.now() - fpotOosLiveCache.at < 15000 && fpotOosLiveCache.at > 0;
      const dgOosFresh = Date.now() - dgOosLiveCache.at < 15000 && dgOosLiveCache.at > 0;
      const deadRunsFresh =
        Date.now() - deadRunsHistoryCache.at < 60_000 && deadRunsHistoryCache.at > 0;
      if (atFresh && schoolFresh && oosFresh && dgOosFresh && deadRunsFresh) {
        void refreshSavedVehicleSummaries();
        return Promise.resolve();
      }
      return refreshFleetHomeLive();
    },
    getState: () => ({ ...state }),
  };
}
