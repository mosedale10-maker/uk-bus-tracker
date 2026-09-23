import express from "express";
import compression from "compression";
import { createProxyMiddleware } from "http-proxy-middleware";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleBodsOccupancy, handleBodsVehicles, fetchBodsVehiclesJson } from "./bods-occupancy.js";
import { handleDgAtTimetable } from "./dg-at-timetable.js";
import { handleFirstStopTimes } from "./first-departures.js";
import {
  initAuthStore,
  hasDatabase,
  createUser,
  authenticateUser,
  changePassword,
  userFromRequest,
  publicUser,
  signSession,
  sessionCookie,
  setUserPlus,
  grantPlusByEmail,
  cancelUserPlus,
  userHasPlus,
  recordPlusPurchase,
  markPlusPurchaseEmailed,
  listPlusUsers,
} from "./auth-store.mjs";
import { paypalConfigured, createPlusOrder, capturePlusOrder, plusAmount, plusCurrency } from "./paypal-plus.mjs";
import { sendPlusThankYouEmail } from "./mail.mjs";
import {
  initPhotoStore,
  photosEnabled,
  submitBusPhoto,
  getApprovedPhotoForReg,
  getPhotoImage,
  listPendingPhotos,
  listRecentPhotos,
  setPhotoStatus,
  deletePhoto,
  decodeDataUrlOrBase64,
  requireAdminSecret,
  compactRegKey,
} from "./photo-store.mjs";
import {
  initNoticeStore,
  noticesEnabled,
  listActiveNotices,
  listAllNotices,
  createControlRoomNotice,
  setNoticeActive,
  deleteNotice,
} from "./notice-store.mjs";
import { syncOperatorAlerts, startOperatorAlertPoller } from "./operator-alerts.mjs";
import {
  initTrailStore,
  trailsEnabled,
  appendTrailPoints,
  backfillTrailDirections,
  getTrailPoints,
  getTrailsForKeys,
  listTrailKeysForLines,
  listTrailKeysForOperators,
  listDeadRunSegments,
  startTrailPrunePoller,
  pruneOldTrailPoints,
  reclaimTrailDisk,
  TRAIL_KEEP_DAYS,
} from "./trail-store.mjs";
import { startTrailRecorder } from "./trail-recorder.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "dist");
const port = Number(process.env.PORT) || 4173;
const bodsKey = process.env.BODS_API_KEY || "";
const trailRemoteUrl = String(process.env.TRAIL_REMOTE_URL || "")
  .trim()
  .replace(/\/+$/, "");
const trailsOnPc = Boolean(trailRemoteUrl);
/** GPS trail store / recorder — needed for Map · actual coach/bus paths on roads. */
const GPS_TRAILS_ENABLED = true;
const vehiclesSource = bodsKey ? "bods" : "none";

function wipeGpsTrailFiles() {
  const dir = String(process.env.TRAIL_DATA_DIR || path.join(__dirname, "data", "trails")).trim();
  for (const name of ["trails.sqlite", "trails.sqlite-wal", "trails.sqlite-shm"]) {
    const file = path.join(dir, name);
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        console.log(`[trails] wiped ${file}`);
      }
    } catch (error) {
      console.warn(`[trails] wipe failed ${file}:`, error?.message || error);
    }
  }
}

// Outbound polls (bustimes/BODS/etc.) can reject with SocketError; don't take down the PC host.
process.on("unhandledRejection", (reason) => {
  const msg = reason?.cause?.message || reason?.message || String(reason);
  console.warn("[process] unhandledRejection:", msg);
});
// Fatal errors: log then exit so scripts/watch-pc-site.ps1 can restart cleanly.
process.on("uncaughtException", (error) => {
  console.error("[process] uncaughtException:", error?.message || error);
  console.error("[process] exiting so watchdog can restart");
  setTimeout(() => process.exit(1), 250).unref?.();
});

async function notifyPlusPurchase({
  user,
  amount,
  currency,
  orderId,
  provider = "paypal",
} = {}) {
  if (!user?.email || !orderId) return;
  try {
    const recorded = await recordPlusPurchase({
      userId: user.id,
      email: user.email,
      provider,
      externalId: orderId,
      amount: amount || plusAmount(),
      currency: currency || plusCurrency(),
      plusUntil: user.plus_until || user.plusUntil || null,
    });
    if (!recorded.shouldEmail) return;
    await sendPlusThankYouEmail({
      email: user.email,
      amount: amount || plusAmount(),
      currency: currency || plusCurrency(),
      orderId,
      provider,
      plusUntil: user.plus_until || user.plusUntil || null,
    });
    await markPlusPurchaseEmailed(provider, orderId);
  } catch (error) {
    console.error("[mail] Plus thank-you failed:", error?.message || error);
  }
}

const UA = "uk-bus-tracker/1.0 (hosted map app)";

function dgHeaders(proxyReq) {
  proxyReq.setHeader("identifier", "9865w159-a113-3mmg-as5k-7354d43sgd");
  proxyReq.setHeader("X-Requested-With", "XMLHttpRequest");
  proxyReq.setHeader("Origin", "https://www.dgbus.co.uk");
  proxyReq.setHeader("Referer", "https://www.dgbus.co.uk/");
  proxyReq.setHeader("Accept", "application/json");
}

/** Express strips the mount path; rebuild the upstream path from the remainder. */
function rewriteMount(destBase, { file = false } = {}) {
  return (incomingPath, req) => {
    const raw = req?.url || incomingPath || "";
    const original = req?.originalUrl || raw;
    const qIdx = raw.indexOf("?");
    const oqIdx = original.indexOf("?");
    const pathname = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const query =
      (qIdx >= 0 ? raw.slice(qIdx) : "") ||
      (oqIdx >= 0 ? original.slice(oqIdx) : "");
    if (file) return `${destBase}${query}`;

    const suffix = !pathname || pathname === "/" ? "" : pathname;
    // Keep a trailing slash on collection endpoints. Bustimes 301s `/api/vehicles` →
    // `/api/vehicles/`; following that relative redirect can re-enter this app and hit
    // the `/api/vehicles` → vehicles.json proxy instead of the REST API.
    const base = destBase.replace(/\/$/, "");
    const path = suffix ? `${base}${suffix}` : `${base}/`;
    const withSlash = path.endsWith("/") ? path : `${path}/`;
    return `${withSlash}${query}`;
  };
}

function proxy(options) {
  return createProxyMiddleware({
    changeOrigin: true,
    ...options,
  });
}

const app = express();
app.disable("x-powered-by");
// Skip gzip for auth (tiny) and large map JSON — zlib shares Node's UV threadpool
// with scrypt, so compressing many /api/vehicles responses was delaying login by seconds.
app.use(
  compression({
    threshold: 1024,
    filter(req, res) {
      const url = String(req.url || "");
      if (url.startsWith("/api/auth")) return false;
      if (url.startsWith("/api/vehicles") || url.startsWith("/api/stops-geo")) return false;
      return compression.filter(req, res);
    },
  }),
);

/** Railway public URL closes 25 Sep 2026, 15:00 UK (BST). PC / ukbustracker.co.uk stays up. */
const RAILWAY_CLOSE_AT = Date.parse("2026-09-25T15:00:00+01:00");
const NEW_SITE_URL = "https://ukbustracker.co.uk/";
const onRailway = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_SERVICE_ID,
);

function railwayAddressClosed() {
  return onRailway && Number.isFinite(RAILWAY_CLOSE_AT) && Date.now() >= RAILWAY_CLOSE_AT;
}

app.use((req, res, next) => {
  if (!railwayAddressClosed()) return next();
  res.setHeader("Cache-Control", "no-store");
  return res.redirect(301, NEW_SITE_URL);
});

if (onRailway) {
  const ms = RAILWAY_CLOSE_AT - Date.now();
  if (ms > 0) {
    console.log(
      `[railway-close] address redirects to ${NEW_SITE_URL} after ${new Date(RAILWAY_CLOSE_AT).toISOString()} (${Math.round(ms / 3600000)}h)`,
    );
  } else {
    console.log(`[railway-close] address closed — all traffic redirects to ${NEW_SITE_URL}`);
  }
}

const maintenanceFlagPath = path.join(__dirname, "data", "maintenance.on");
let maintenanceCache = { at: 0, on: false };

function maintenanceEnabled() {
  const envOn = /^(1|true|yes|on)$/i.test(String(process.env.MAINTENANCE_MODE || "").trim());
  if (envOn) return true;
  const now = Date.now();
  if (now - maintenanceCache.at < 2000) return maintenanceCache.on;
  let on = false;
  try {
    on = fs.existsSync(maintenanceFlagPath);
  } catch {
    on = false;
  }
  maintenanceCache = { at: now, on };
  return on;
}

/** Owner preview: visiting ?preview=<key> (key stored in data/preview-key) sets a
 * browser cookie that bypasses maintenance mode so the owner can view the real
 * site during downtime. Everyone else still sees the 503 maintenance page. */
const PREVIEW_KEY_PATH = path.join(__dirname, "data", "preview-key");
let previewKeyCache = { at: 0, key: "" };

function readPreviewKey() {
  const now = Date.now();
  if (now - previewKeyCache.at < 10_000) return previewKeyCache.key;
  let key = "";
  try {
    key = fs.readFileSync(PREVIEW_KEY_PATH, "utf8").trim();
  } catch {
    key = "";
  }
  previewKeyCache = { at: now, key };
  return key;
}

function previewCookieValue(req) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)preview=([^;]+)/);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>UK Bus Tracker — Maintenance</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: "Segoe UI", system-ui, sans-serif;
      color: #0f172a;
      background:
        radial-gradient(1200px 600px at 10% -10%, #fde68a 0%, transparent 55%),
        radial-gradient(900px 500px at 100% 0%, #bfdbfe 0%, transparent 50%),
        #f1f5f9;
    }
    main {
      width: min(520px, 100%);
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 28px 26px 24px;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08);
      text-align: center;
    }
    .logo {
      width: 148px;
      height: 148px;
      object-fit: contain;
      border-radius: 50%;
      margin: 0 auto 14px;
      display: block;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
    }
    .brand {
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #64748b;
      font-weight: 700;
    }
    h1 {
      margin: 10px 0 12px;
      font-size: 1.65rem;
      line-height: 1.2;
    }
    p {
      margin: 0 0 12px;
      line-height: 1.55;
      color: #334155;
      text-align: left;
    }
    .hint {
      margin-top: 18px;
      font-size: 0.92rem;
      color: #64748b;
      text-align: center;
    }
    button {
      margin-top: 8px;
      appearance: none;
      border: 0;
      border-radius: 999px;
      background: #fbbf24;
      color: #111;
      font-weight: 800;
      font-size: 0.95rem;
      padding: 10px 16px;
      cursor: pointer;
    }
    button:hover { filter: brightness(0.97); }
  </style>
</head>
<body>
  <main>
    <img class="logo" src="/logos/ukbustracker-logo.jpg" width="148" height="148" alt="UK Bus Tracker logo" />
    <div class="brand">UK Bus Tracker</div>
    <h1>UK Bus Tracker is being updated</h1>
    <p>
      The live map is temporarily unavailable while we carry out maintenance.
      We’re working on the site now and expect to be back shortly.
    </p>
    <p class="hint">This page refreshes automatically. You can also try again now.</p>
    <button type="button" onclick="location.reload()">Try again</button>
  </main>
  <script>
    setTimeout(function () { location.reload(); }, 30000);
  </script>
</body>
</html>`;

app.use((req, res, next) => {
  const previewKey = readPreviewKey();
  if (previewKey) {
    const qs = String(req.url || "").split("?")[1] || "";
    const qPreview = new URLSearchParams(qs).get("preview") || "";
    if (qPreview && qPreview === previewKey) {
      res.setHeader(
        "Set-Cookie",
        `preview=${encodeURIComponent(previewKey)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
      );
      return next();
    }
    if (previewCookieValue(req) === previewKey) return next();
  }
  if (!maintenanceEnabled()) return next();
  const url = String(req.url || "");
  const pathOnly = url.split("?")[0] || "";
  // Keep watchdog + logo + live BODS feed working while the public UI is offline.
  if (pathOnly === "/api/health") return next();
  if (pathOnly === "/api/auth/config") return next();
  if (pathOnly === "/api/vehicles" || pathOnly.startsWith("/api/bods-")) return next();
  if (pathOnly.startsWith("/logos/")) return next();
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", "300");
  if (req.method === "GET" || req.method === "HEAD") {
    const accept = String(req.headers.accept || "");
    if (accept.includes("application/json") || pathOnly.startsWith("/api/")) {
      return res.status(503).json({
        ok: false,
        maintenance: true,
        error: "UK Bus Tracker is under maintenance. Please try again shortly.",
      });
    }
    return res.status(503).type("html").send(MAINTENANCE_HTML);
  }
  return res.status(503).json({
    ok: false,
    maintenance: true,
    error: "UK Bus Tracker is under maintenance. Please try again shortly.",
  });
});

if (maintenanceEnabled()) {
  console.log("[maintenance] mode ON — public site returns 503 until data/maintenance.on is removed (or MAINTENANCE_MODE unset)");
}

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    ts: Date.now(),
    maintenance: maintenanceEnabled(),
    vehiclesSource,
  });
});

app.get("/api/bods-occupancy", (req, res) => handleBodsOccupancy(req, res, bodsKey));
app.get("/api/dg-at-timetable", (req, res) => handleDgAtTimetable(req, res));
app.get("/api/bods-vehicles", (req, res) => handleBodsVehicles(req, res, bodsKey));
// Live First Bus seat / wheelchair counts (cached gateway proxy — see first-departures.js).
app.get("/api/first-stop-times", (req, res) => handleFirstStopTimes(req, res));

/** Whole-UK live vehicle count (BODS SIRI-VM), refreshed about every 30s. */
const UK_LIVE_BBOX = { xmin: -8.2, ymin: 49.8, xmax: 1.85, ymax: 60.9 };
let ukLiveCountCache = { at: 0, count: null };
let ukLiveCountInflight = null;

async function refreshUkLiveCountInBackground() {
  if (ukLiveCountInflight) return ukLiveCountInflight;
  ukLiveCountInflight = (async () => {
    if (!bodsKey) throw new Error("bods_api_key_missing");
    const qs = `?xmin=${UK_LIVE_BBOX.xmin}&ymin=${UK_LIVE_BBOX.ymin}&xmax=${UK_LIVE_BBOX.xmax}&ymax=${UK_LIVE_BBOX.ymax}`;
    const result = await fetchBodsVehiclesJson(qs, bodsKey);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`bods_${result.status}`);
    }
    const count = Number(result.count) || 0;
    ukLiveCountCache = { at: Date.now(), count };
    return ukLiveCountCache;
  })().finally(() => {
    ukLiveCountInflight = null;
  });
  return ukLiveCountInflight;
}

async function fetchUkLiveVehicleCount({ wait = true } = {}) {
  const now = Date.now();
  if (ukLiveCountCache.count != null && now - ukLiveCountCache.at < 30_000) {
    return ukLiveCountCache;
  }
  // Prefer returning a cached count instantly while a refresh runs in the background.
  if (ukLiveCountCache.count != null && !wait) {
    refreshUkLiveCountInBackground().catch(() => {});
    return ukLiveCountCache;
  }
  try {
    return await refreshUkLiveCountInBackground();
  } catch (error) {
    if (ukLiveCountCache.count != null) return ukLiveCountCache;
    throw error;
  }
}

app.get("/api/live-count", async (_req, res) => {
  try {
    // Never block the first paint on a full-UK vehicles.json download.
    const row =
      ukLiveCountCache.count != null
        ? await fetchUkLiveVehicleCount({ wait: false })
        : await fetchUkLiveVehicleCount({ wait: true });
    res.setHeader("Cache-Control", "public, max-age=15");
    res.json({ count: row.count, at: row.at, scope: "uk" });
  } catch (error) {
    if (ukLiveCountCache.count != null) {
      res.setHeader("Cache-Control", "public, max-age=15");
      res.json({
        count: ukLiveCountCache.count,
        at: ukLiveCountCache.at,
        scope: "uk",
        stale: true,
      });
      return;
    }
    res.status(502).json({ count: null, error: error.message || "live_count_failed", scope: "uk" });
  }
});

// Warm the live-count cache at boot so the first visitor is not blocked.
refreshUkLiveCountInBackground().catch((error) => {
  console.warn("[live-count] warm failed", error?.message || error);
});

/** Short in-memory cache for live vehicles.json (bbox + operator polls). */
const vehiclesJsonCache = new Map();
const vehiclesJsonInflight = new Map();
/** Fresh window — keep ≈ client BUS_POLL_MS (7s) so refresh hits memory, not upstream. */
const VEHICLES_JSON_TTL_MS = 5000;
const VEHICLES_OPERATOR_TTL_MS = 7_000;
/** Serve expired bodies while a background refresh runs (avoids stampede + empty map). */
const VEHICLES_STALE_MS = 60_000;

function vehiclesCacheTtl(url) {
  return /[?&]operator=/i.test(url) ? VEHICLES_OPERATOR_TTL_MS : VEHICLES_JSON_TTL_MS;
}

/** Round bbox params so nearby viewers share one upstream fetch.
 * Expand outward (floor min / ceil max) so rounding never drops edge vehicles.
 */
function quantizeVehiclesQuery(qs) {
  const raw = String(qs || "");
  const q = raw.startsWith("?") ? raw.slice(1) : raw;
  if (!q) return "?";
  const params = new URLSearchParams(q);
  for (const key of ["xmin", "ymin", "xmax", "ymax"]) {
    if (!params.has(key)) continue;
    const n = Number(params.get(key));
    if (!Number.isFinite(n)) continue;
    const expanded =
      key === "xmin" || key === "ymin" ? Math.floor(n * 100) / 100 : Math.ceil(n * 100) / 100;
    params.set(key, expanded.toFixed(2));
  }
  const out = params.toString();
  return out ? `?${out}` : "?";
}

function rememberVehiclesCache(cacheKey, now, body, source = "") {
  vehiclesJsonCache.set(cacheKey, { at: now, body, source: source || "" });
  if (vehiclesJsonCache.size <= 64) return;
  // Drop oldest by time, not insertion order.
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [k, v] of vehiclesJsonCache) {
    if (v.at < oldestAt) {
      oldestAt = v.at;
      oldestKey = k;
    }
  }
  if (oldestKey) vehiclesJsonCache.delete(oldestKey);
}

function vehiclesQueryFromReq(req) {
  // Prefer originalUrl — Express may strip the query from req.url in some versions.
  const raw = String(req.originalUrl || req.url || "");
  return raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
}

async function fetchVehiclesUpstream(cacheKey) {
  let pending = vehiclesJsonInflight.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const qs = String(cacheKey || "");
      const wantFlix = /[?&]operator=FLIX\b/i.test(qs);
      // FlixBus is not published on BODS SIRI-VM — live map positions come from bustimes
      // vehicles.json (history/Map tails still use our GPS store, not bustimes journeys).
      if (wantFlix) {
        try {
          const upstream = `https://bustimes.org/vehicles.json${qs === "?" ? "" : qs}`;
          const response = await fetch(upstream, {
            headers: {
              Accept: "application/json",
              "User-Agent": "uk-bus-tracker/1.0 (FlixBus live map)",
            },
          });
          const raw = await response.arrayBuffer();
          let body = Buffer.from(raw);
          if (response.ok) {
            try {
              const rows = JSON.parse(body.toString("utf8"));
              if (Array.isArray(rows)) {
                const tagged = rows.map((bus) => ({
                  ...bus,
                  _source: "bustimes-flix",
                  operator: {
                    ...(bus.operator && typeof bus.operator === "object" ? bus.operator : {}),
                    noc: "FLIX",
                    id: bus.operator?.id || "FLIX",
                    name: bus.operator?.name || "FlixBus",
                    slug: bus.operator?.slug || "flixbus",
                  },
                }));
                body = Buffer.from(JSON.stringify(tagged), "utf8");
              }
            } catch {
              /* keep upstream body */
            }
          }
          return {
            status: response.status,
            body,
            contentType: "application/json; charset=utf-8",
            source: "bustimes-flix",
          };
        } catch (error) {
          console.warn("[vehicles] FlixBus live fetch failed", error?.message || error);
          return {
            status: 502,
            body: Buffer.from(
              JSON.stringify({
                ok: false,
                error: error?.message || "flix_upstream_failed",
              }),
            ),
            contentType: "application/json; charset=utf-8",
            source: "bustimes-flix",
            error: error?.message || "flix_upstream_failed",
          };
        }
      }
      if (!bodsKey) {
        return {
          status: 503,
          body: Buffer.from(JSON.stringify([]), "utf8"),
          contentType: "application/json; charset=utf-8",
          source: "none",
        };
      }
      return fetchBodsVehiclesJson(cacheKey, bodsKey);
    })();
    vehiclesJsonInflight.set(cacheKey, pending);
    pending.finally(() => vehiclesJsonInflight.delete(cacheKey));
  }
  return pending;
}

function revalidateVehiclesInBackground(cacheKey) {
  if (vehiclesJsonInflight.has(cacheKey)) return;
  fetchVehiclesUpstream(cacheKey)
    .then((result) => {
      if (result.status >= 200 && result.status < 300) {
        rememberVehiclesCache(cacheKey, Date.now(), result.body, result.source || "");
      }
    })
    .catch(() => {});
}

app.get("/api/vehicles", async (req, res, next) => {
  try {
    const cacheKey = quantizeVehiclesQuery(vehiclesQueryFromReq(req));
    const ttl = vehiclesCacheTtl(cacheKey);
    const hit = vehiclesJsonCache.get(cacheKey);
    const now = Date.now();
    res.setHeader("X-Vehicles-Source", hit?.source || vehiclesSource);
    if (hit && now - hit.at < ttl) {
      res.setHeader("Cache-Control", `public, max-age=${Math.max(1, Math.floor(ttl / 1000))}`);
      res.setHeader("X-Cache", "HIT");
      res.type("json").send(hit.body);
      return;
    }
    // Stale-while-revalidate: paint immediately from memory; refresh upstream off-path.
    if (hit && now - hit.at < VEHICLES_STALE_MS) {
      revalidateVehiclesInBackground(cacheKey);
      res.setHeader("Cache-Control", `public, max-age=${Math.max(1, Math.floor(ttl / 1000))}`);
      res.setHeader("X-Cache", "STALE");
      res.type("json").send(hit.body);
      return;
    }
    const result = await fetchVehiclesUpstream(cacheKey);
    if (result.source) res.setHeader("X-Vehicles-Source", result.source);
    if (result.status >= 200 && result.status < 300) {
      rememberVehiclesCache(cacheKey, Date.now(), result.body, result.source || "");
    } else if (hit) {
      // Upstream blip — keep last good body so refresh does not blank the map.
      revalidateVehiclesInBackground(cacheKey);
      res.setHeader("X-Vehicles-Source", hit.source || result.source || vehiclesSource);
      res.setHeader("Cache-Control", `public, max-age=${Math.max(1, Math.floor(ttl / 1000))}`);
      res.setHeader("X-Cache", "STALE-ERROR");
      res.type("json").send(hit.body);
      return;
    }
    res.status(result.status);
    res.setHeader("Cache-Control", `public, max-age=${Math.max(1, Math.floor(ttl / 1000))}`);
    res.setHeader("X-Cache", "MISS");
    if (result.contentType) res.setHeader("Content-Type", result.contentType);
    else res.type("json");
    res.send(result.body);
  } catch (error) {
    const cacheKey = quantizeVehiclesQuery(vehiclesQueryFromReq(req));
    const hit = vehiclesJsonCache.get(cacheKey);
    if (hit) {
      res.setHeader("X-Vehicles-Source", hit.source || vehiclesSource);
      res.setHeader("Cache-Control", "public, max-age=2");
      res.setHeader("X-Cache", "STALE-ERROR");
      res.type("json").send(hit.body);
      return;
    }
    next(error);
  }
});

/** Stop pins previously came from bustimes.org — disabled (BODS has no stop GeoJSON). */
app.get("/api/stops-geo", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.setHeader("X-Data-Source", "none");
  res.type("json").send(JSON.stringify({ type: "FeatureCollection", features: [] }));
});

/** Former bustimes.org REST proxies — return empty so the UI does not call bustimes. */
function stubBtList(_req, res) {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.setHeader("X-Data-Source", "none");
  res.status(200).json({ count: 0, next: null, previous: null, results: [] });
}

function stubBtGone(_req, res) {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.setHeader("X-Data-Source", "none");
  res.status(404).json({ detail: "Not available (bustimes.org is only used for tails / history)" });
}

function mountBtStub(path, handler) {
  app.use(path, (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    return handler(req, res);
  });
}

mountBtStub("/api/bt-services", stubBtList);
mountBtStub("/api/bt-operators", stubBtList);
mountBtStub("/api/bt-stops", stubBtGone);
mountBtStub("/api/stop-times", stubBtGone);

/** Bustimes trip geometry — Map · trail from timetable (no local GPS tails). */
app.use(
  "/api/bt-trips",
  proxy({
    target: "https://bustimes.org",
    pathRewrite: rewriteMount("/api/trips"),
    timeout: 20_000,
    proxyTimeout: 20_000,
  }),
);

/** Bustimes vehicle registry — journey history ids + staff/fleet paint lookup. */
app.use(
  "/api/bt-vehicles",
  proxy({
    target: "https://bustimes.org",
    pathRewrite: rewriteMount("/api/vehicles"),
    timeout: 20_000,
    proxyTimeout: 20_000,
  }),
);

/** Bustimes journey history (not live map positions). */
app.use(
  "/api/bt-vehiclejourneys",
  proxy({
    target: "https://bustimes.org",
    pathRewrite: rewriteMount("/api/vehiclejourneys"),
    timeout: 20_000,
    proxyTimeout: 20_000,
  }),
);

/** Bustimes livery CSS — 2D marker paint only (cached; upstream rate-limits floods). */
const liveryCssCache = new Map();
const liveryCssInflight = new Map();
const LIVERY_CSS_TTL_MS = 6 * 60 * 60 * 1000;

app.get("/api/bt-liveries/:id/", async (req, res, next) => {
  try {
    const id = String(req.params.id || "").replace(/\/+$/, "");
    if (!/^\d+$/.test(id)) {
      res.status(404).json({ detail: "Not found" });
      return;
    }
    const now = Date.now();
    const hit = liveryCssCache.get(id);
    if (hit && now - hit.at < LIVERY_CSS_TTL_MS) {
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("X-Cache", "HIT");
      res.type("json").send(hit.body);
      return;
    }
    let pending = liveryCssInflight.get(id);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(`https://bustimes.org/api/liveries/${id}/`, {
          headers: {
            Accept: "application/json",
            "User-Agent": "uk-bus-tracker/1.0 (marker livery css)",
          },
        });
        const body = Buffer.from(await response.arrayBuffer());
        return { status: response.status, body, contentType: response.headers.get("content-type") };
      })();
      liveryCssInflight.set(id, pending);
      pending.finally(() => liveryCssInflight.delete(id));
    }
    const result = await pending;
    if (result.status >= 200 && result.status < 300) {
      liveryCssCache.set(id, { at: Date.now(), body: result.body });
      if (liveryCssCache.size > 400) {
        liveryCssCache.delete(liveryCssCache.keys().next().value);
      }
    } else if (hit) {
      res.setHeader("Cache-Control", "public, max-age=60");
      res.setHeader("X-Cache", "STALE");
      res.type("json").send(hit.body);
      return;
    }
    res.status(result.status);
    res.setHeader("Cache-Control", "public, max-age=3600");
    if (result.contentType) res.setHeader("Content-Type", result.contentType);
    else res.type("json");
    res.send(result.body);
  } catch (error) {
    next(error);
  }
});

/** Bustimes vehicles.json for colour/livery ids only (positions stay BODS). */
const paintVehiclesCache = new Map();
const paintVehiclesInflight = new Map();
const PAINT_TTL_MS = 12_000;

app.get("/api/bt-paint", async (req, res, next) => {
  try {
    const raw = String(req.originalUrl || req.url || "");
    const qs = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
    const cacheKey = quantizeVehiclesQuery(qs);
    const now = Date.now();
    const hit = paintVehiclesCache.get(cacheKey);
    if (hit && now - hit.at < PAINT_TTL_MS) {
      res.setHeader("Cache-Control", "public, max-age=8");
      res.setHeader("X-Cache", "HIT");
      res.setHeader("X-Data-Source", "bustimes-paint");
      res.type("json").send(hit.body);
      return;
    }
    let pending = paintVehiclesInflight.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const upstream = `https://bustimes.org/vehicles.json${cacheKey === "?" ? "" : cacheKey}`;
        const response = await fetch(upstream, {
          headers: {
            Accept: "application/json",
            "User-Agent": "uk-bus-tracker/1.0 (marker livery paint only)",
          },
        });
        const body = Buffer.from(await response.arrayBuffer());
        return {
          status: response.status,
          body,
          contentType: response.headers.get("content-type"),
        };
      })();
      paintVehiclesInflight.set(cacheKey, pending);
      pending.finally(() => paintVehiclesInflight.delete(cacheKey));
    }
    const result = await pending;
    if (result.status >= 200 && result.status < 300) {
      paintVehiclesCache.set(cacheKey, { at: Date.now(), body: result.body });
      if (paintVehiclesCache.size > 48) {
        paintVehiclesCache.delete(paintVehiclesCache.keys().next().value);
      }
    } else if (hit) {
      res.setHeader("Cache-Control", "public, max-age=8");
      res.setHeader("X-Cache", "STALE");
      res.setHeader("X-Data-Source", "bustimes-paint");
      res.type("json").send(hit.body);
      return;
    }
    res.status(result.status);
    res.setHeader("Cache-Control", "public, max-age=8");
    res.setHeader("X-Data-Source", "bustimes-paint");
    if (result.contentType) res.setHeader("Content-Type", result.contentType);
    else res.type("json");
    res.send(result.body);
  } catch (error) {
    next(error);
  }
});

app.use(
  "/api/overpass",
  proxy({
    target: "https://overpass-api.de",
    pathRewrite: (_path, req) => {
      const full = req.originalUrl || "";
      const q = full.includes("?") ? full.slice(full.indexOf("?")) : "";
      return `/api/interpreter${q}`;
    },
    headers: { "User-Agent": UA },
  }),
);
app.use(
  "/api/overpass-alt",
  proxy({
    target: "https://overpass.kumi.systems",
    pathRewrite: (_path, req) => {
      const full = req.originalUrl || "";
      const q = full.includes("?") ? full.slice(full.indexOf("?")) : "";
      return `/api/interpreter${q}`;
    },
    headers: { "User-Agent": UA },
  }),
);
app.use(
  "/api/ofm",
  proxy({
    target: "https://tiles.openfreemap.org",
    pathRewrite: rewriteMount(""),
    headers: { "User-Agent": UA },
  }),
);
app.use(
  "/api/osrm-match",
  proxy({
    target: "https://router.project-osrm.org",
    // Express strips the mount (`/api/osrm-match`), leaving `/-1.2,51.5;…` — rewrite that.
    pathRewrite: (path) => {
      const rest = String(path || "").replace(/^\/api\/osrm-match/, "") || "/";
      return `/match/v1/driving${rest.startsWith("/") ? rest : `/${rest}`}`;
    },
    headers: { "User-Agent": UA },
  }),
);
app.use(
  "/api/osrm-route",
  proxy({
    target: "https://router.project-osrm.org",
    pathRewrite: (path) => {
      const rest = String(path || "").replace(/^\/api\/osrm-route/, "") || "/";
      return `/route/v1/driving${rest.startsWith("/") ? rest : `/${rest}`}`;
    },
    headers: { "User-Agent": UA },
  }),
);
app.use(
  "/api/first-next-bus",
  proxy({
    target: "https://www.firstbus.co.uk",
    pathRewrite: rewriteMount("/api/get-next-bus", { file: true }),
    headers: {
      "User-Agent": UA,
      Origin: "https://www.firstbus.co.uk",
      Referer: "https://www.firstbus.co.uk/",
      Accept: "application/json",
    },
  }),
);
app.use(
  "/api/geocode",
  proxy({
    target: "https://nominatim.openstreetmap.org",
    pathRewrite: rewriteMount("/search", { file: true }),
    headers: { "User-Agent": UA },
  }),
);
app.use(
  "/api/dg-vehicles",
  proxy({
    target: "https://api-v3.nextstopapp.co.uk",
    pathRewrite: rewriteMount("/api/v1/buses/realtime", { file: true }),
    on: { proxyReq: dgHeaders },
  }),
);
app.use(
  "/api/dg-services",
  proxy({
    target: "https://api-v3.nextstopapp.co.uk",
    pathRewrite: rewriteMount("/api/v1/region/526/services", { file: true }),
    on: { proxyReq: dgHeaders },
  }),
);
app.use(
  "/api/dg-vehicle",
  proxy({
    target: "https://api-v3.nextstopapp.co.uk",
    pathRewrite: rewriteMount("/api/v1/vehicle"),
    on: { proxyReq: dgHeaders },
  }),
);

app.get("/api/adsb", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const dist = Math.min(Math.max(Number(req.query.dist) || 60, 10), 100);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: "lat and lon required" });
    return;
  }
  try {
    const url = `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`;
    const upstream = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
    });
    const text = await upstream.text();
    res.status(upstream.status).type("application/json").send(text);
  } catch (error) {
    res.status(502).json({ error: error.message || "ADS-B upstream failed" });
  }
});

app.use(express.json({ limit: "8mb" }));

function requestOrigin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host) return "";
  return `${proto}://${host}`;
}

function sendAuthError(res, error) {
  const status = Number(error?.status) || 500;
  res.status(status).json({ error: error?.message || "Request failed" });
}

function adminOk(req, res) {
  try {
    requireAdminSecret(req);
    return true;
  } catch (error) {
    sendAuthError(res, error);
    return false;
  }
}

app.get("/api/bus-photos", async (req, res) => {
  try {
    await initPhotoStore();
    const reg = compactRegKey(req.query?.reg);
    if (!reg) {
      res.status(400).json({ error: "reg required" });
      return;
    }
    const photo = await getApprovedPhotoForReg(reg);
    res.json({ photo });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/bus-photos/:id/image", async (req, res) => {
  try {
    await initPhotoStore();
    const row = await getPhotoImage(req.params.id);
    if (!row?.image) {
      res.status(404).end();
      return;
    }
    // Pending images only for admin (secret); approved are public.
    if (row.status !== "approved") {
      try {
        requireAdminSecret(req);
      } catch {
        res.status(404).end();
        return;
      }
    }
    res.setHeader("Content-Type", row.mime || "image/jpeg");
    res.setHeader("Cache-Control", row.status === "approved" ? "public, max-age=86400" : "no-store");
    res.send(row.image);
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/bus-photos", async (req, res) => {
  try {
    await initPhotoStore();
    if (!photosEnabled()) {
      res.status(503).json({ error: "Photo uploads are not available yet" });
      return;
    }
    const user = await userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "Log in with your Plus account to submit a photo" });
      return;
    }
    if (!user.plus) {
      res.status(403).json({ error: "Plus is required to submit bus photos" });
      return;
    }
    const decoded = decodeDataUrlOrBase64(req.body?.image || req.body?.data);
    const photo = await submitBusPhoto({
      reg: req.body?.reg,
      fleet: req.body?.fleet,
      operator: req.body?.operator,
      mime: req.body?.mime || decoded.mime,
      buffer: decoded.buffer,
      user,
      note: req.body?.note,
      uploaderName: req.body?.uploaderName || req.body?.name || req.body?.credit,
    });
    res.status(201).json({
      ok: true,
      photo,
      message: "Thanks — your photo is waiting for owner approval before it appears on the bus card.",
    });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/bus-photos/admin/pending", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    await initPhotoStore();
    const photos = await listPendingPhotos();
    res.json({ photos });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/bus-photos/admin/list", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    await initPhotoStore();
    const photos = await listRecentPhotos({
      limit: req.query?.limit,
      status: req.query?.status,
    });
    res.json({ photos });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/bus-photos/admin/:id/approve", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    const photo = await setPhotoStatus(req.params.id, "approved");
    res.json({ ok: true, photo });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/bus-photos/admin/:id/reject", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    const photo = await setPhotoStatus(req.params.id, "rejected");
    res.json({ ok: true, photo });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.delete("/api/bus-photos/admin/:id", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    const result = await deletePhoto(req.params.id);
    res.json(result);
  } catch (error) {
    sendAuthError(res, error);
  }
});

let noticesListCache = { at: 0, body: null, kind: "", limit: "" };

app.get("/api/notices", async (req, res) => {
  try {
    await initNoticeStore();
    const kind = String(req.query?.kind || "");
    const limit = String(req.query?.limit || "");
    const now = Date.now();
    if (
      noticesListCache.body &&
      noticesListCache.kind === kind &&
      noticesListCache.limit === limit &&
      now - noticesListCache.at < 45_000
    ) {
      res.setHeader("Cache-Control", "public, max-age=30");
      res.json(noticesListCache.body);
      return;
    }
    const notices = await listActiveNotices({
      kind: req.query?.kind,
      limit: req.query?.limit,
    });
    const body = { notices, enabled: noticesEnabled() };
    noticesListCache = { at: now, body, kind, limit };
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json(body);
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/notices/admin/list", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    await initNoticeStore();
    const notices = await listAllNotices({
      kind: req.query?.kind,
      limit: req.query?.limit,
    });
    res.json({ notices, enabled: noticesEnabled() });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/notices/admin", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    await initNoticeStore();
    if (!noticesEnabled()) {
      res.status(503).json({ error: "Notices are not available yet" });
      return;
    }
    const notice = await createControlRoomNotice({
      title: req.body?.title,
      body: req.body?.body,
      operator: req.body?.operator,
      routes: req.body?.routes,
      area: req.body?.area,
      speak: req.body?.speak !== false,
      priority: req.body?.priority,
      startsAt: req.body?.startsAt || null,
      endsAt: req.body?.endsAt || null,
    });
    res.status(201).json({ ok: true, notice });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/notices/admin/:id/activate", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    const notice = await setNoticeActive(req.params.id, true);
    res.json({ ok: true, notice });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/notices/admin/:id/deactivate", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    const notice = await setNoticeActive(req.params.id, false);
    res.json({ ok: true, notice });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.delete("/api/notices/admin/:id", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    const result = await deleteNotice(req.params.id);
    res.json(result);
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/notices/admin/sync-operators", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    const result = await syncOperatorAlerts({ force: true });
    res.json(result);
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.use("/api/trails", (req, res, next) => {
  if (GPS_TRAILS_ENABLED) return next();
  res.setHeader("Cache-Control", "no-store");
  const pathOnly = String(req.path || "").split("?")[0];
  if (req.method === "POST" && (pathOnly === "/points" || pathOnly === "/admin/reclaim")) {
    if (pathOnly === "/admin/reclaim") wipeGpsTrailFiles();
    return res.json({
      ok: true,
      inserted: 0,
      wiped: pathOnly === "/admin/reclaim",
      days: TRAIL_KEEP_DAYS,
      disabled: true,
      note: "GPS tails removed — history is bustimes.org journeys only",
    });
  }
  if (pathOnly === "/keys" || pathOnly.endsWith("/keys")) {
    return res.json({
      ok: true,
      days: TRAIL_KEEP_DAYS,
      keys: [],
      disabled: true,
      note: "GPS tails removed — history is bustimes.org journeys only",
    });
  }
  if (pathOnly === "/dead-runs" || pathOnly.endsWith("/dead-runs")) {
    return res.json({ ok: true, days: TRAIL_KEEP_DAYS, segments: [], disabled: true });
  }
  return res.json({
    ok: true,
    days: TRAIL_KEEP_DAYS,
    trails: {},
    disabled: true,
    note: "GPS tails removed — history is bustimes.org journeys only",
  });
});

app.get("/api/trails", async (req, res) => {
  if (trailsOnPc) {
    try {
      const url = new URL("/api/trails", `${trailRemoteUrl}/`);
      for (const [k, v] of Object.entries(req.query || {})) {
        if (v == null) continue;
        url.searchParams.set(k, String(v));
      }
      const upstream = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const body = await upstream.text();
      res.status(upstream.status).type("json").send(body);
    } catch (error) {
      res.status(502).json({
        ok: false,
        days: TRAIL_KEEP_DAYS,
        trails: {},
        error: error?.message || "pc_trails_unreachable",
      });
    }
    return;
  }
  try {
    await initTrailStore();
    if (!trailsEnabled()) {
      res.json({ ok: false, days: TRAIL_KEEP_DAYS, trails: {}, error: "no-store" });
      return;
    }
    const keys = String(req.query.keys || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    const days = Math.min(TRAIL_KEEP_DAYS, Math.max(1, Number(req.query.days) || TRAIL_KEEP_DAYS));
    const fromMs = Number(req.query.from) || 0;
    const toMs = Number(req.query.to) || 0;
    if (!keys.length) {
      const key = String(req.query.key || "").trim();
      if (!key) {
        res.status(400).json({ ok: false, error: "missing_keys" });
        return;
      }
      const points = await getTrailPoints(key, { fromMs, toMs, days });
      res.json({ ok: true, days: TRAIL_KEEP_DAYS, trails: { [key]: points } });
      return;
    }
    const trails = await getTrailsForKeys(keys, { fromMs, toMs, days });
    res.json({ ok: true, days: TRAIL_KEEP_DAYS, trails });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "trails_failed" });
  }
});

app.get("/api/trails/keys", async (req, res) => {
  if (trailsOnPc) {
    try {
      const url = new URL("/api/trails/keys", `${trailRemoteUrl}/`);
      for (const [k, v] of Object.entries(req.query || {})) {
        if (v == null) continue;
        url.searchParams.set(k, String(v));
      }
      const upstream = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const body = await upstream.text();
      res.status(upstream.status).type("json").send(body);
    } catch (error) {
      res.status(502).json({
        ok: false,
        days: TRAIL_KEEP_DAYS,
        keys: [],
        error: error?.message || "pc_trails_unreachable",
      });
    }
    return;
  }
  try {
    await initTrailStore();
    if (!trailsEnabled()) {
      res.json({ ok: false, days: TRAIL_KEEP_DAYS, keys: [], error: "no-store" });
      return;
    }
    const lines = String(req.query.lines || "")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    const operators = String(req.query.operators || "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    if (!lines.length && !operators.length) {
      res.status(400).json({ ok: false, error: "missing_lines_or_operators" });
      return;
    }
    const days = Math.min(TRAIL_KEEP_DAYS, Math.max(1, Number(req.query.days) || TRAIL_KEEP_DAYS));
    const limit = Number(req.query.limit) || 40;
    const byLine = lines.length ? await listTrailKeysForLines(lines, { days, limit }) : [];
    const byOp = operators.length
      ? await listTrailKeysForOperators(operators, { days, limit })
      : [];
    const seen = new Set();
    const keys = [];
    for (const row of [...byOp, ...byLine]) {
      const key = String(row?.key || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(row);
      if (keys.length >= Math.min(80, Math.max(4, limit))) break;
    }
    res.json({ ok: true, days: TRAIL_KEEP_DAYS, keys });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "trail_keys_failed" });
  }
});

/** Historical Ticketer dead runs (FPOT / DAGC) from GPS trail keep window. */
app.get("/api/trails/dead-runs", async (req, res) => {
  if (trailsOnPc) {
    try {
      const url = new URL("/api/trails/dead-runs", `${trailRemoteUrl}/`);
      for (const [k, v] of Object.entries(req.query || {})) {
        if (v == null) continue;
        url.searchParams.set(k, String(v));
      }
      const upstream = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const body = await upstream.text();
      res.status(upstream.status).type("json").send(body);
    } catch (error) {
      res.status(502).json({
        ok: false,
        days: TRAIL_KEEP_DAYS,
        segments: [],
        error: error?.message || "pc_trails_unreachable",
      });
    }
    return;
  }
  try {
    await initTrailStore();
    if (!trailsEnabled()) {
      res.json({ ok: false, days: TRAIL_KEEP_DAYS, segments: [], error: "no-store" });
      return;
    }
    const days = Math.min(TRAIL_KEEP_DAYS, Math.max(1, Number(req.query.days) || TRAIL_KEEP_DAYS));
    const limit = Number(req.query.limit) || 60;
    const operators = String(req.query.operators || "FPOT,DAGC")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const segments = await listDeadRunSegments({ days, limit, operators });
    res.json({ ok: true, days: TRAIL_KEEP_DAYS, segments });
  } catch (error) {
    res.status(500).json({ ok: false, segments: [], error: error.message || "dead_runs_failed" });
  }
});

app.post("/api/trails/points", async (req, res) => {
  // Ignore anonymous browser uploads — the trail-recorder writes once for everyone.
  // Keeps SQLite / disk from melting when many viewers are online.
  if (!trailsOnPc && !req.get("x-trail-recorder")) {
    res.json({ ok: true, inserted: 0, days: TRAIL_KEEP_DAYS, ignored: true });
    return;
  }
  if (trailsOnPc) {
    try {
      const upstream = await fetch(new URL("/api/trails/points", `${trailRemoteUrl}/`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body || {}),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await upstream.text();
      res.status(upstream.status).type("json").send(body);
    } catch (error) {
      res.status(502).json({ ok: false, error: error?.message || "pc_trails_unreachable" });
    }
    return;
  }
  try {
    await initTrailStore();
    if (!trailsEnabled()) {
      res.json({ ok: false, error: "no-store" });
      return;
    }
    const body = req.body || {};
    const batches = Array.isArray(body.batches)
      ? body.batches
      : body.key
        ? [{ key: body.key, points: body.points }]
        : [];
    if (!batches.length) {
      res.status(400).json({ ok: false, error: "missing_points" });
      return;
    }
    let inserted = 0;
    for (const batch of batches.slice(0, 8)) {
      const result = await appendTrailPoints(batch.key, batch.points);
      if (result.ok) inserted += result.inserted || 0;
    }
    res.json({ ok: true, inserted, days: TRAIL_KEEP_DAYS });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "trail_write_failed" });
  }
});

app.get("/api/auth/config", (_req, res) => {
  res.json({ accounts: hasDatabase() });
});

app.get("/api/auth/me", async (req, res) => {
  try {
    await initAuthStore();
    const user = await userFromRequest(req);
    res.json({ user: publicUser(user) });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/auth/signup", async (req, res) => {
  try {
    const user = await createUser(req.body?.email, req.body?.password);
    const token = signSession(user);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const user = await authenticateUser(req.body?.email, req.body?.password);
    const token = signSession(user);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.json({ user: publicUser(user) });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", sessionCookie("", { clear: true }));
  res.json({ ok: true });
});

app.post("/api/auth/change-password", async (req, res) => {
  try {
    await initAuthStore();
    const user = await userFromRequest(req);
    if (!user?.id) {
      res.status(401).json({ error: "Log in to change your password" });
      return;
    }
    await changePassword(user.id, req.body?.currentPassword, req.body?.newPassword);
    res.json({ ok: true });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/auth/admin/grant-plus", async (req, res) => {
  try {
    const secret = String(process.env.AUTH_SECRET || "").trim();
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!secret || !token || token !== secret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const email = String(req.body?.email || "").trim();
    const months = Math.max(1, Number(req.body?.months) || 1);
    if (!email) {
      res.status(400).json({ error: "email required" });
      return;
    }
    const user = await grantPlusByEmail(email, { months });
    res.json({ ok: true, user: publicUser(user) });
  } catch (error) {
    sendAuthError(res, error);
  }
});

/** Emergency: free Postgres disk so Plus login / accounts can init again. */
app.post("/api/trails/admin/reclaim", async (req, res) => {
  try {
    const secret = String(process.env.AUTH_SECRET || "").trim();
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!secret || !token || token !== secret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const truncate = req.body?.truncate !== false;
    const result = await reclaimTrailDisk({ truncate });
    // Re-init auth after space is freed.
    try {
      await initAuthStore();
      result.authOk = true;
    } catch (error) {
      result.authInit = error?.message || String(error);
      result.authOk = false;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

/** Send thank-you / proof-of-purchase emails to current Plus members (owner only). */
app.post("/api/plus/admin/send-receipts", async (req, res) => {
  try {
    const secret = String(process.env.AUTH_SECRET || "").trim();
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!secret || !token || token !== secret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    await initAuthStore();
    const onlyEmail = String(req.body?.email || "").trim().toLowerCase();
    const users = await listPlusUsers();
    const targets = onlyEmail ? users.filter((u) => String(u.email || "").toLowerCase() === onlyEmail) : users;
    const results = [];
    for (const user of targets) {
      const orderId = `backfill-${user.id}-${Date.now()}`;
      try {
        const recorded = await recordPlusPurchase({
          userId: user.id,
          email: user.email,
          provider: "admin",
          externalId: orderId,
          amount: plusAmount(),
          currency: plusCurrency(),
          plusUntil: user.plus_until || null,
        });
        if (!recorded.shouldEmail) {
          results.push({ email: user.email, status: "skipped" });
          continue;
        }
        const sent = await sendPlusThankYouEmail({
          email: user.email,
          amount: plusAmount(),
          currency: plusCurrency(),
          orderId,
          provider: "admin",
          plusUntil: user.plus_until || null,
        });
        await markPlusPurchaseEmailed("admin", orderId);
        results.push({ email: user.email, status: sent?.skipped ? "skipped" : "sent", receipt: sent?.receipt || null });
      } catch (error) {
        results.push({ email: user.email, status: "error", error: error?.message || "send failed" });
      }
    }
    res.json({
      ok: true,
      count: targets.length,
      sent: results.filter((r) => r.status === "sent").length,
      results,
    });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/plus/cancel", async (req, res) => {
  try {
    await initAuthStore();
    const user = await userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "Log in to cancel Plus on your account." });
      return;
    }
    const updated = await cancelUserPlus(user.id);
    res.setHeader("Set-Cookie", sessionCookie(signSession(updated)));
    const until = updated?.plus_until ? new Date(updated.plus_until) : null;
    const keepsAccess = Boolean(until && until.getTime() > Date.now() && userHasPlus(updated));
    res.json({
      ok: true,
      user: publicUser(updated),
      keepsAccess,
      message: keepsAccess
        ? `Plus cancelled. You keep access until ${until.toLocaleDateString("en-GB", {
            timeZone: "Europe/London",
            day: "numeric",
            month: "short",
            year: "numeric",
          })} — it will not renew after that.`
        : "Plus cancelled on your account. You can subscribe again any time.",
    });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/plus/config", (_req, res) => {
  res.json({
    configured: Boolean(
      paypalConfigured() ||
        (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
    ),
    paypal: paypalConfigured(),
    price: process.env.PLUS_PRICE_LABEL || `£${plusAmount()}/month`,
    amount: plusAmount(),
    currency: plusCurrency(),
    accounts: hasDatabase(),
  });
});

app.post("/api/plus/checkout", async (req, res) => {
  try {
    const user = await userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "Create an account and log in before paying for Plus." });
      return;
    }
    if (user.plus) {
      res.json({ alreadyPlus: true, user: publicUser(user) });
      return;
    }

    const origin = requestOrigin(req) || "https://ukbustracker.up.railway.app";

    if (paypalConfigured()) {
      const order = await createPlusOrder({
        userId: user.id,
        email: user.email,
        origin,
      });
      res.json({ url: order.url, orderId: order.id, paypal: true });
      return;
    }

    const secret = String(process.env.STRIPE_SECRET_KEY || "").trim();
    const price = String(process.env.STRIPE_PRICE_ID || "").trim();
    if (secret && price) {
      const body = new URLSearchParams({
        mode: "subscription",
        "line_items[0][price]": price,
        "line_items[0][quantity]": "1",
        client_reference_id: String(user.id),
        customer_email: user.email,
        success_url: `${origin}/?plus=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?plus=cancel`,
        allow_promotion_codes: "true",
      });
      const upstream = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      const data = await upstream.json();
      if (!upstream.ok || !data.url) {
        res.status(502).json({ error: data?.error?.message || "Stripe checkout failed" });
        return;
      }
      res.json({ url: data.url, id: data.id });
      return;
    }

    res.status(503).json({
      error:
        "Plus payments need PayPal API keys (PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET). paypal.me links cannot confirm payment automatically.",
    });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/plus/paypal/return", async (req, res) => {
  const origin = requestOrigin(req) || "https://ukbustracker.up.railway.app";
  const orderId = String(req.query.token || req.query.order_id || "").trim();
  try {
    if (!paypalConfigured()) {
      res.redirect(302, `${origin}/?plus=error&reason=paypal_not_configured`);
      return;
    }
    const paid = await capturePlusOrder(orderId);
    const updated = await setUserPlus(paid.userId, true);
    if (!updated) {
      res.redirect(302, `${origin}/?plus=error&reason=account_missing`);
      return;
    }
    const sessionUser = await userFromRequest(req);
    if (sessionUser && Number(sessionUser.id) === Number(updated.id)) {
      res.setHeader("Set-Cookie", sessionCookie(signSession(updated)));
    }
    // Fire-and-forget so the buyer still lands on success if email is slow.
    void notifyPlusPurchase({
      user: updated,
      amount: paid.amount,
      currency: paid.currency,
      orderId: paid.orderId,
      provider: "paypal",
    });
    res.redirect(302, `${origin}/?plus=success`);
  } catch (error) {
    const reason = encodeURIComponent(error?.message || "payment_failed");
    res.redirect(302, `${origin}/?plus=error&reason=${reason}`);
  }
});

app.get("/api/plus/paypal/cancel", (req, res) => {
  const origin = requestOrigin(req) || "https://ukbustracker.up.railway.app";
  res.redirect(302, `${origin}/?plus=cancel`);
});

app.get("/api/plus/verify", async (req, res) => {
  const sessionId = String(req.query.session_id || "").trim();
  const secret = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!sessionId) {
    res.status(400).json({ ok: false, error: "session_id required" });
    return;
  }
  if (!secret) {
    res.status(503).json({ ok: false, error: "Stripe verify is not configured" });
    return;
  }
  try {
    const upstream = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(502).json({ ok: false, error: data?.error?.message || "Verify failed" });
      return;
    }
    const paid = data.payment_status === "paid" || data.status === "complete";
    if (!paid) {
      res.json({ ok: false, status: data.status, payment_status: data.payment_status });
      return;
    }
    const refId = Number(data.client_reference_id || 0);
    let user = null;
    if (Number.isFinite(refId) && refId > 0) {
      user = await setUserPlus(refId, true);
    } else {
      const sessionUser = await userFromRequest(req);
      if (sessionUser) user = await setUserPlus(sessionUser.id, true);
    }
    if (!user) {
      res.status(401).json({
        ok: false,
        error: "Payment received but no account was linked. Log in and contact support.",
      });
      return;
    }
    res.setHeader("Set-Cookie", sessionCookie(signSession(user)));
    void notifyPlusPurchase({
      user,
      amount: data.amount_total != null ? (Number(data.amount_total) / 100).toFixed(2) : plusAmount(),
      currency: String(data.currency || plusCurrency()).toUpperCase(),
      orderId: sessionId,
      provider: "stripe",
    });
    res.json({ ok: true, user: publicUser(user) });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message || "Verify failed" });
  }
});

initPhotoStore().catch((error) => {
  console.error("[photos] init failed", error?.message || error);
});
initNoticeStore()
  .then((ok) => {
    if (ok) startOperatorAlertPoller();
  })
  .catch((error) => {
    console.error("[notices] init failed", error?.message || error);
  });

async function bootTrailStack() {
  // Auth first so login works even while trail reclaim runs.
  let authOk = false;
  try {
    authOk = await initAuthStore();
    if (authOk) console.log("[auth] users table ready");
  } catch (error) {
    console.error("[auth] init failed", error?.message || error);
  }

  // Keep Postgres free for Plus/auth only — do not block boot/login on DROP/VACUUM.
  try {
    const reclaim = await reclaimTrailDisk({ truncate: true });
    if (reclaim?.ok && reclaim?.droppedPostgresTrails) {
      console.log(
        `[trails] dropped Postgres trail tables (auth-only DB) size=${reclaim.after?.db_size || "?"}`,
      );
    } else if (reclaim && !reclaim.ok) {
      console.warn("[trails] Postgres trail drop failed", reclaim.error || reclaim);
    }
  } catch (error) {
    console.warn("[trails] Postgres trail drop failed", error?.message || error);
  }

  if (trailsOnPc) {
    console.log(`[trails] using PC store via TRAIL_REMOTE_URL=${trailRemoteUrl}`);
    try {
      const health = await fetch(new URL("/health", `${trailRemoteUrl}/`), {
        signal: AbortSignal.timeout(8_000),
      });
      const body = await health.json().catch(() => ({}));
      console.log(`[trails] PC host health=${health.status}`, body);
    } catch (error) {
      console.warn(
        "[trails] PC host unreachable — tails/replay offline until scripts/trail-pc-host.mjs (+ tunnel) is running:",
        error?.message || error,
      );
    }
  } else if (GPS_TRAILS_ENABLED) {
    try {
      const ok = await initTrailStore();
      if (!ok) {
        console.warn("[trails] local store unavailable");
      } else {
        startTrailPrunePoller();
        // Do not await prune/VACUUM on boot — it blocked HTTP for a long time on large DBs.
        pruneOldTrailPoints({ force: true }).catch((error) => {
          console.warn("[trails] startup prune failed", error?.message || error);
        });
        startTrailRecorder({ bodsKey });
        console.log("[trails] GPS recorder on — actual paths for Map · trail / diversions");
      }
    } catch (error) {
      console.error("[trails] init failed", error?.message || error);
    }
  } else {
    wipeGpsTrailFiles();
    console.log("[trails] GPS tails disabled — not recording; history files wiped");
  }

  if (!authOk) {
    console.error("[auth] Plus login still unavailable");
  }
}

bootTrailStack().catch((error) => {
  console.error("[boot] trail stack failed", error?.message || error);
});

app.use(
  express.static(distDir, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache");
        return;
      }
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return;
      }
      res.setHeader("Cache-Control", "public, max-age=86400");
    },
  }),
);
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(distDir, "index.html"), (err) => {
    if (err) next(err);
  });
});

// Keep the process alive on client-abort errors (Express "Request aborted")
// so a single disconnected browser request cannot restart the whole server.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", String(reason));
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`UK Bus Tracker listening on http://0.0.0.0:${port}`);
  console.log(
    `[vehicles] live source=${vehiclesSource}${
      vehiclesSource === "bods"
        ? " (BODS SIRI-VM — bustimes paint/history; GPS tails for diversions)"
        : " (set BODS_API_KEY)"
    }`,
  );
  // Warm a mid-England bbox so the first map poll often hits memory (SWR after that).
  const warmKey = quantizeVehiclesQuery("?xmin=-2.50&ymin=52.50&xmax=-1.50&ymax=53.20");
  revalidateVehiclesInBackground(warmKey);
});
// Many http-proxy-middleware mounts each attach a close listener.
server.setMaxListeners(32);
