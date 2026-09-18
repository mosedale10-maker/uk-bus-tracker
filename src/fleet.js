/** Staffordshire fleet browser (bustimes-backed). */

export const STAFFS_OPERATORS = [
  { name: "Aimee's", slug: "aimees", noc: "TXCO" },
  { name: "Arriva Derby", slug: "arriva-derby", noc: "ADER" },
  { name: "Arriva Midlands North", slug: "arriva-midlands-north", noc: "AMNO" },
  { name: "Banga Buses", slug: "banga-travel", noc: "BANG" },
  { name: "Carolean Coaches", slug: "carolean-coaches", noc: "CRLN" },
  { name: "D & G Bus", slug: "d-g-coach-bus", noc: "DAGC" },
  { name: "Diamond Bus", slug: "diamond-bus", noc: "DIAM" },
  { name: "Diamond Bus East Midlands", slug: "midland-classic", noc: "MDCL" },
  { name: "Evolve Bus & Coach", slug: "evolve-bus-coach", noc: "EVOL" },
  { name: "First Potteries", slug: "first-potteries", noc: "FPOT" },
  { name: "FlixBus", slug: "flixbus", noc: "FLIX" },
  { name: "High Peak", slug: "high-peak", noc: "HIPK" },
  { name: "Hotspur", slug: "hotspur", noc: "HOTS" },
  { name: "National Express", slug: "national-express", noc: "NATX" },
  { name: "National Express West Midlands", slug: "national-express-west-midlands", noc: "TNXB" },
  { name: "Scraggs", slug: "scraggs-taxis-and-coaches", noc: "SCRT" },
  { name: "Select Bus Services", slug: "select-bus-services", noc: "SLBS" },
  { name: "South Staffs Coach Hire", slug: "la-travel-south-staffs-coach-hire", noc: "LATR" },
  { name: "trentbarton", slug: "trent-barton", noc: "TBTN" },
  { name: "Walsall Community Transport", slug: "walsall-community-transport", noc: "WACT" },
  { name: "Albatross Coaches", slug: "albatross-coaches", noc: null },
  { name: "Ashbourne Community Transport", slug: "ashbourne-community-transport", noc: null },
  { name: "Bus Link", slug: "bus-link", noc: null },
  { name: "Chaserider", slug: "chaserider", noc: null },
  { name: "Flexibus", slug: "flexibus", noc: null },
  { name: "Stagecoach Midlands", slug: "stagecoach-northamptonshire", noc: null },
  { name: "Stanton's of Stoke", slug: "stantons-of-stoke", noc: "SOST" },
].sort((a, b) => a.name.localeCompare(b.name, "en-GB"));

export const AT_ROUTES = [
  { line: "AT1", name: "Alton Towers employee-only AT1", origin: "Fenton", destination: "Alton Towers" },
  { line: "AT2", name: "Alton Towers employee-only AT2", origin: "Fenton", destination: "Alton Towers" },
  { line: "AT3", name: "Alton Towers employee-only AT3", origin: "Bentilee", destination: "Alton Towers" },
];

const UK_TZ = "Europe/London";
const AT_LINE_SET = new Set(AT_ROUTES.map((row) => row.line));

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
  const label = [info.route, info.dest].filter(Boolean).join(" · ");
  const cls = info.at ? " fleet-last-route-at" : "";
  return `<span class="fleet-last-route${cls}" title="Last route">${esc(label)}</span>`;
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
          return {
            route: row.service?.line_name || "",
            dest: row.destination || "",
            live: true,
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
        return {
          route: row.route_name || "",
          dest: row.destination || "",
          live: false,
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

async function fetchOperatorVehicles(noc, { search = "", offset = 0, limit = 40 } = {}) {
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

async function searchStaffsVehicles(query, limit = 40) {
  const q = compactQuery(query);
  if (q.length < 2) return [];
  const data = await fetchJson(
    `/api/bt-vehicles/?search=${encodeURIComponent(query)}&withdrawn=false&limit=${limit}`,
  );
  const nocSet = new Set(STAFFS_OPERATORS.map((op) => op.noc).filter(Boolean));
  const slugSet = new Set(STAFFS_OPERATORS.map((op) => op.slug));
  return (data.results || []).filter((vehicle) => {
    const noc = vehicle.operator?.id;
    const slug = vehicle.operator?.slug;
    return (noc && nocSet.has(noc)) || (slug && slugSet.has(slug));
  });
}

export function createFleetBrowser({
  root,
  onTrackVehicle,
  onPlayJourney,
} = {}) {
  if (!root) throw new Error("Fleet root missing");

  const state = {
    view: "home", // home | operator | vehicle | at-route
    query: "",
    operator: null,
    vehicles: [],
    vehicleCount: 0,
    vehicleOffset: 0,
    vehicle: null,
    journeys: [],
    date: ukDateKey(),
    loading: false,
    error: "",
    atLine: "",
    atVehicles: [],
    atMeta: null,
  };

  function setLoading(on, error = "") {
    state.loading = on;
    state.error = error;
    render();
  }

  function crumb(parts) {
    return `<nav class="fleet-crumbs">${parts
      .map((part, i) => {
        if (part.action) {
          return `<button type="button" class="fleet-crumb-link" data-action="${esc(part.action)}" data-arg="${esc(part.arg || "")}">${esc(part.label)}</button>`;
        }
        return `<span class="${i === parts.length - 1 ? "fleet-crumb-here" : ""}">${esc(part.label)}</span>`;
      })
      .join('<span class="fleet-crumb-sep">›</span>')}</nav>`;
  }

  function operatorsMatching(query) {
    const q = compactQuery(query);
    if (!q) return STAFFS_OPERATORS;
    return STAFFS_OPERATORS.filter((op) => {
      const hay = compactQuery(`${op.name} ${op.slug} ${op.noc || ""}`);
      return hay.includes(q);
    });
  }

  function renderHome(vehicleHits = []) {
    const ops = operatorsMatching(state.query);
    const q = compactQuery(state.query);
    const atRoutes = AT_ROUTES.filter((row) => {
      if (!q) return true;
      const meta = atLiveCache.meta.get(row.line) || row;
      return compactQuery(`${row.line} ${meta.name} ${meta.origin} ${meta.destination} alton`).includes(q);
    });
    return `
      ${crumb([{ label: "Staffordshire" }, { label: "Companies & vehicles" }])}
      <h1 class="fleet-title">Staffordshire fleet</h1>
      <p class="fleet-lead">Search bus companies and vehicles operating in Staffordshire.</p>
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${
        state.query
          ? `<section class="fleet-section">
              <h2 class="fleet-section-title">Vehicles matching “${esc(state.query)}”</h2>
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
                    : `<p class="fleet-muted">No Staffordshire vehicles matched.</p>`
              }
            </section>`
          : ""
      }
      <section class="fleet-section">
        <h2 class="fleet-section-title">Companies · ${ops.length}</h2>
        <ul class="fleet-list">
          ${ops
            .map(
              (op) => `<li>
                <button type="button" class="fleet-list-btn" data-action="open-operator" data-slug="${esc(op.slug)}">
                  <span class="fleet-list-main">${esc(decodeHtml(op.name))}</span>
                  <span class="fleet-list-sub">${op.noc ? `NOC ${esc(op.noc)}` : "Fleet list unavailable"}</span>
                </button>
              </li>`,
            )
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

  function renderAtRoute() {
    const line = state.atLine;
    const meta = state.atMeta || AT_ROUTES.find((row) => row.line === line) || { line };
    return `
      ${crumb([
        { label: "Staffordshire", action: "home" },
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
                    <button type="button" class="fleet-list-btn" data-action="${id ? "open-vehicle" : "track-at"}" data-id="${esc(id)}" data-reg="${esc(entry.regLabel)}" data-fleet="${esc(entry.fleet)}" data-ref="${esc(entry.ref)}">
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

  function renderOperator() {
    const op = state.operator;
    if (!op) return renderHome();
    return `
      ${crumb([
        { label: "Staffordshire", action: "home" },
        { label: decodeHtml(op.name) },
        { label: "Vehicles" },
      ])}
      <h1 class="fleet-title">${esc(decodeHtml(op.name))}</h1>
      <p class="fleet-lead">${op.noc ? `Operator code ${esc(op.noc)} · ${state.vehicleCount} vehicles` : "No vehicle list available for this operator yet."}</p>
      ${state.error ? `<p class="fleet-error">${esc(state.error)}</p>` : ""}
      ${
        !op.noc
          ? `<p class="fleet-muted">Try searching the registration or fleet number above.</p>`
          : state.loading && !state.vehicles.length
            ? `<p class="fleet-muted">Loading fleet…</p>`
            : `<ul class="fleet-list">${state.vehicles
                .map(
                  (v) => `<li>
                    <button type="button" class="fleet-list-btn" data-action="open-vehicle" data-id="${esc(v.id)}">
                      ${vehicleMainHtml(v)}
                      <span class="fleet-list-sub">${esc(v.vehicle_type?.name || "Unknown type")}${v.livery?.name ? ` · ${esc(v.livery.name)}` : ""}</span>
                    </button>
                  </li>`,
                )
                .join("")}</ul>
              ${
                state.vehicleOffset + state.vehicles.length < state.vehicleCount
                  ? `<button type="button" class="fleet-more" data-action="more-vehicles">Load more</button>`
                  : ""
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
    return `
      ${crumb([
        { label: "Staffordshire", action: "home" },
        { label: opName, action: "open-operator", arg: opSlug },
        { label: "Vehicles", action: "open-operator", arg: opSlug },
        { label: v.fleet_code || v.reg || "Vehicle" },
      ])}
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
        state.loading
          ? `<p class="fleet-muted">Loading journeys…</p>`
          : state.journeys.length
            ? `<table class="fleet-table">
                <thead><tr><th>Route</th><th>Trip</th><th>To</th><th></th></tr></thead>
                <tbody>
                  ${state.journeys
                    .map((row) => {
                      const time = formatJourneyTime(row.datetime);
                      return `<tr>
                        <td><span class="fleet-route${row.atLive ? " fleet-route-at" : ""}">${esc(row.route_name || "—")}</span>${row.atLive ? ` <span class="fleet-live-tag">live</span>` : ""}</td>
                        <td class="fleet-trip"><span>${esc(time)}</span><span class="fleet-trip-alt">${esc(time)}</span></td>
                        <td>${esc(row.destination || "—")}</td>
                        <td class="fleet-row-actions">
                          ${
                            (() => {
                              const trailKey = row.trailKey || String(v.id || "");
                              if (!row.trip_id && !trailKey) return "";
                              return `<button type="button" class="fleet-link-btn" data-action="play-journey" data-trip-id="${esc(row.trip_id || "")}" data-journey-id="${esc(row.id || "")}" data-vehicle-id="${esc(v.id)}" data-trail-key="${esc(trailKey)}" data-reg="${esc(v.reg || "")}" data-line="${esc(row.route_name || "")}" data-dest="${esc(row.destination || "")}" data-datetime="${esc(row.datetime || "")}">Map</button>`;
                            })()
                          }
                        </td>
                      </tr>`;
                    })
                    .join("")}
                </tbody>
              </table>`
            : `<p class="fleet-muted">No journeys recorded for this date.</p>`
      }
    `;
  }

  function render() {
    if (state.view === "vehicle") root.innerHTML = renderVehicle();
    else if (state.view === "operator") root.innerHTML = renderOperator();
    else if (state.view === "at-route") root.innerHTML = renderAtRoute();
    else root.innerHTML = renderHome(state.vehicleHits || []);
  }

  async function showHome(query = state.query) {
    state.view = "home";
    state.query = query;
    state.operator = null;
    state.vehicle = null;
    state.atLine = "";
    state.atVehicles = [];
    state.atMeta = null;
    state.journeys = [];
    state.vehicleHits = [];
    await ensureAtLive().catch(() => {});
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

  async function showAtRoute(line) {
    const code = String(line || "").toUpperCase();
    if (!AT_LINE_SET.has(code)) return showHome();
    state.view = "at-route";
    state.atLine = code;
    state.vehicle = null;
    state.operator = null;
    state.journeys = [];
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

  async function showOperator(slug, { reset = true } = {}) {
    const op = STAFFS_OPERATORS.find((row) => row.slug === slug);
    if (!op) return showHome();
    state.view = "operator";
    state.operator = op;
    state.vehicle = null;
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
      const data = await fetchOperatorVehicles(op.noc, {
        search: state.query,
        offset: state.vehicleOffset,
      });
      const batch = data.results || [];
      state.vehicles = reset ? batch : [...state.vehicles, ...batch];
      state.vehicleCount = data.count || state.vehicles.length;
      state.vehicleOffset = state.vehicles.length;
      setLoading(false);
      attachLastRoutes(batch, () => {
        if (state.view === "operator") render();
      });
    } catch (error) {
      setLoading(false, error.message || "Could not load vehicles");
    }
  }

  async function showVehicle(id, date = state.date) {
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
      let journeys = await fetchVehicleJourneys(vehicle.id, date);
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
      state.journeys = journeys;
      setLoading(false);
    } catch (error) {
      setLoading(false, error.message || "Could not load vehicle");
    }
  }

  root.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "home") showHome("");
    if (action === "open-operator") showOperator(btn.dataset.arg || btn.dataset.slug);
    if (action === "open-at-route") showAtRoute(btn.dataset.line);
    if (action === "open-vehicle") showVehicle(btn.dataset.id);
    if (action === "more-vehicles" && state.operator) showOperator(state.operator.slug, { reset: false });
    if (action === "track-vehicle" || action === "track-at") {
      onTrackVehicle?.({
        id: btn.dataset.id,
        reg: btn.dataset.reg,
        fleet: btn.dataset.fleet,
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
        dest: btn.dataset.dest,
        datetime: btn.dataset.datetime,
      });
    }
  });

  root.addEventListener("change", (event) => {
    if (event.target.id !== "fleet-date" || !state.vehicle) return;
    showVehicle(state.vehicle.id, event.target.value);
  });

  showHome("");

  return {
    showHome,
    showOperator,
    showVehicle,
    showAtRoute,
    search(query) {
      return showHome(query);
    },
    getState: () => ({ ...state }),
  };
}
