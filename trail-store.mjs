/** GPS trail storage on app disk (SQLite file) — Plus/auth stays on Postgres. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { hasDatabase } from "./auth-store.mjs";
import pg from "pg";

export const TRAIL_KEEP_DAYS = 5;
const MAX_BATCH = 250;
const MAX_POINTS_PER_KEY = 4_000;
const MAX_KEYS_PER_QUERY = 24;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(__dirname, "data", "trails");
const RECORDING_START_FILE = "recording-started-at";

let db = null;
let ready = null;
let lastPruneAt = 0;
let lastWalCheckpointAt = 0;
let lastWalWarnAt = 0;
let backend = "none";
let recordingStartedAt = 0;
const WAL_WARN_BYTES = 500 * 1024 * 1024; // 500MB — previously ballooned to ~244GB

function trailDataDir() {
  return String(process.env.TRAIL_DATA_DIR || DEFAULT_DIR).trim() || DEFAULT_DIR;
}

function recordingStartPath() {
  return path.join(trailDataDir(), RECORDING_START_FILE);
}

function loadRecordingStartedAt() {
  try {
    const value = Number(fs.readFileSync(recordingStartPath(), "utf8").trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function markRecordingStarted(at = Date.now()) {
  const value = Number(at);
  const safe = Number.isFinite(value) && value > 0 ? Math.round(value) : Date.now();
  const target = recordingStartPath();
  const temp = `${target}.tmp`;
  try {
    fs.writeFileSync(temp, `${safe}\n`, "utf8");
    fs.renameSync(temp, target);
  } catch (error) {
    console.warn("[trails] could not persist recording start marker:", error?.message || error);
  }
  recordingStartedAt = safe;
  return safe;
}

function dbSslOption() {
  const url = String(process.env.DATABASE_URL || "");
  if (process.env.DATABASE_SSL === "1") return { rejectUnauthorized: false };
  if (url.includes("railway.internal")) return false;
  if (/rlwy\.net|railway\.app|proxy/i.test(url)) return { rejectUnauthorized: false };
  return undefined;
}

function openSqlite(filePath) {
  // Prefer Node 22.5+ built-in sqlite (sync API).
  try {
    // Dynamic path so older Node still parses this file.
    const ns = "node:sqlite";
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require(ns);
    const database = new DatabaseSync(filePath);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA synchronous = NORMAL;");
    // Fail fast on corrupt files so callers can recover instead of silent disable.
    database.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return { database, kind: "node:sqlite" };
  } catch (error) {
    console.warn("[trails] node:sqlite open failed:", error?.message || error);
  }
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const database = new Database(filePath);
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    database.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return { database, kind: "better-sqlite3" };
  } catch (error) {
    console.warn("[trails] better-sqlite3 open failed:", error?.message || error);
    return null;
  }
}

function sqlExec(sql) {
  if (backend === "node:sqlite") db.exec(sql);
  else db.exec(sql);
}

function sqlRun(sql, params = []) {
  if (backend === "node:sqlite") {
    return db.prepare(sql).run(...params);
  }
  return db.prepare(sql).run(...params);
}

function sqlAll(sql, params = []) {
  if (backend === "node:sqlite") {
    return db.prepare(sql).all(...params);
  }
  return db.prepare(sql).all(...params);
}

function sqlGet(sql, params = []) {
  if (backend === "node:sqlite") {
    return db.prepare(sql).get(...params);
  }
  return db.prepare(sql).get(...params);
}

export async function initTrailStore() {
  if (ready) return ready;
  ready = (async () => {
    const dir = trailDataDir();
    fs.mkdirSync(dir, { recursive: true });
    recordingStartedAt = loadRecordingStartedAt();
    const filePath = path.join(dir, "trails.sqlite");
    const opened = openSqlite(filePath);
    if (!opened) {
      console.error(
        "[trails] SQLite unavailable (need Node >= 22.5 or better-sqlite3) — trails disabled",
      );
      return false;
    }
    db = opened.database;
    backend = opened.kind;
    sqlExec(`
      CREATE TABLE IF NOT EXISTS vehicle_trail_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trail_key TEXT NOT NULL,
        t INTEGER NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        heading REAL,
        journey_id TEXT NOT NULL DEFAULT '',
        trip_id TEXT NOT NULL DEFAULT '',
        line TEXT NOT NULL DEFAULT '',
        operator TEXT NOT NULL DEFAULT '',
        direction TEXT NOT NULL DEFAULT '',
        destination TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS vehicle_trail_points_key_t_idx
        ON vehicle_trail_points (trail_key, t DESC);
      CREATE INDEX IF NOT EXISTS vehicle_trail_points_t_idx
        ON vehicle_trail_points (t);
      CREATE INDEX IF NOT EXISTS vehicle_trail_points_line_t_idx
        ON vehicle_trail_points (line, t DESC);
      CREATE INDEX IF NOT EXISTS vehicle_trail_points_operator_t_idx
        ON vehicle_trail_points (operator, t DESC);
      CREATE TABLE IF NOT EXISTS trail_direction_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')),
        detail TEXT NOT NULL DEFAULT ''
      );
    `);
    try {
      sqlExec(`ALTER TABLE vehicle_trail_points ADD COLUMN destination TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column already exists */
    }
    console.log(`[trails] filesystem store ready (${backend}) path=${filePath}`);
    return true;
  })().catch((error) => {
    ready = null;
    db = null;
    backend = "none";
    throw error;
  });
  return ready;
}

export function trailsEnabled() {
  return Boolean(db);
}

function normalizeKey(key) {
  return String(key || "")
    .trim()
    .slice(0, 120);
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

function normalizePoint(raw) {
  const t = Number(raw?.t);
  const lat = Number(raw?.lat);
  const lng = Number(raw?.lng);
  if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const age = Date.now() - t;
  if (recordingStartedAt && t < recordingStartedAt) return null;
  if (age > TRAIL_KEEP_DAYS * 86400000 || age < -5 * 60_000) return null;
  const heading = Number(raw?.heading);
  return {
    t: Math.round(t),
    lat,
    lng,
    heading: Number.isFinite(heading) ? heading : null,
    journeyId: String(raw?.journeyId || "").slice(0, 80),
    tripId: String(raw?.tripId || "").slice(0, 80),
    line: String(raw?.line || "")
      .trim()
      .toUpperCase()
      .slice(0, 40),
    operator: String(raw?.operator || "")
      .trim()
      .toUpperCase()
      .slice(0, 16),
    direction: normalizeDirection(raw?.direction || raw?.directionRef),
    destination: String(raw?.destination || raw?.dest || "")
      .trim()
      .slice(0, 80),
  };
}

function walFilePath() {
  return path.join(trailDataDir(), "trails.sqlite-wal");
}

function warnIfWalLarge() {
  try {
    const st = fs.statSync(walFilePath());
    if (st.size < WAL_WARN_BYTES) return;
    const now = Date.now();
    if (now - lastWalWarnAt < 10 * 60_000) return;
    lastWalWarnAt = now;
    const mb = (st.size / (1024 * 1024)).toFixed(1);
    console.warn(
      `[trails] WAL file is ${mb}MB (>500MB) — checkpoint may be stuck; disk risk`,
    );
  } catch {
    /* no wal file yet */
  }
}

function checkpointWal({ force = false } = {}) {
  if (!db) return;
  const now = Date.now();
  // Truncate often — without this the .sqlite-wal can grow without bound on long-lived PC hosts.
  if (!force && now - lastWalCheckpointAt < 5 * 60_000) return;
  lastWalCheckpointAt = now;
  try {
    // PASSIVE returns immediately if writers/readers hold the WAL; TRUNCATE can stall the
    // whole Node process for many seconds on a busy PC host.
    const mode = force ? "TRUNCATE" : "PASSIVE";
    if (backend === "node:sqlite") {
      db.prepare(`PRAGMA wal_checkpoint(${mode})`).all();
    } else {
      db.pragma(`wal_checkpoint(${mode})`);
    }
  } catch (error) {
    console.warn("[trails] wal_checkpoint failed", error?.message || error);
  }
  warnIfWalLarge();
}

export async function pruneOldTrailPoints({ force = false, days = TRAIL_KEEP_DAYS, vacuum = false } = {}) {
  await initTrailStore();
  if (!db) return 0;
  const now = Date.now();
  if (!force && now - lastPruneAt < 20 * 60_000) return 0;
  lastPruneAt = now;
  const keepDays = Math.min(TRAIL_KEEP_DAYS, Math.max(1, Number(days) || TRAIL_KEEP_DAYS));
  const cutoff = now - keepDays * 86400000;
  // Yield so a large DELETE does not stall HTTP for seconds on the PC host.
  await new Promise((r) => setImmediate(r));
  const result = sqlRun(`DELETE FROM vehicle_trail_points WHERE t < ?`, [cutoff]);
  const n = Number(result?.changes || 0);
  if (n) console.log(`[trails] pruned ${n} points older than ${keepDays}d`);
  // Prefer PASSIVE after prune so HTTP stays responsive; hourly force truncate is enough.
  checkpointWal({ force: false });
  // VACUUM rewrites the whole DB synchronously and freezes the event loop —
  // never run it on the request/recorder path. Opt-in for rare admin/maintenance.
  if (vacuum) {
    await new Promise((r) => setImmediate(r));
    try {
      sqlExec("VACUUM");
    } catch {
      /* ignore */
    }
  }
  return n;
}

/**
 * Emergency/manual reset: remove every recorded GPS point while preserving the
 * schema and indexes. Callers should stop the recorder first, then restart it
 * so its in-memory throttle/sticky-route state starts empty.
 */
export async function clearAllTrailPoints() {
  await initTrailStore();
  if (!db) return { ok: false, reason: "no-store" };
  await new Promise((resolve) => setImmediate(resolve));
  let deleted = 0;
  const reset = () => {
    deleted = Number(sqlRun("DELETE FROM vehicle_trail_points")?.changes || 0);
    try {
      sqlRun("DELETE FROM sqlite_sequence WHERE name = ?", ["vehicle_trail_points"]);
    } catch {
      /* sqlite_sequence is optional */
    }
  };
  if (backend === "node:sqlite") {
    db.exec("BEGIN IMMEDIATE");
    try {
      reset();
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw error;
    }
  } else {
    db.transaction(reset)();
  }
  checkpointWal({ force: true });
  const startedAt = markRecordingStarted();
  console.log(`[trails] cleared ${deleted} recorded GPS points; fresh recording starts ${new Date(startedAt).toISOString()}`);
  return { ok: true, deleted, startedAt };
}

/** Drop old Postgres trail table so Plus login can use the small Railway DB volume. */
export async function reclaimTrailDisk({ truncate = true } = {}) {
  if (!hasDatabase()) {
    return { ok: true, skipped: true, reason: "trails-on-filesystem", postgres: "no-db" };
  }
  const clientPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: dbSslOption(),
    max: 1,
  });
  try {
    const client = await clientPool.connect();
    try {
      if (truncate) {
        try {
          await client.query("DROP TABLE IF EXISTS vehicle_trail_points CASCADE");
        } catch (error) {
          // Bare truncate if drop fails mid-way.
          try {
            await client.query("TRUNCATE vehicle_trail_points");
          } catch (err2) {
            return { ok: false, error: error?.message || err2?.message || String(error) };
          }
        }
      }
      try {
        await client.query("DROP TABLE IF EXISTS trail_direction_migrations CASCADE");
      } catch {
        /* ignore */
      }
      // Skip VACUUM when nothing large remains — full VACUUM stalls Plus/auth under load.
      let needsVacuum = false;
      try {
        const left = await client.query(`
          SELECT to_regclass('public.vehicle_trail_points') AS trails,
                 pg_database_size(current_database()) AS bytes
        `);
        const row = left.rows[0] || {};
        needsVacuum = Boolean(row.trails) || Number(row.bytes) > 40 * 1024 * 1024;
      } catch {
        needsVacuum = false;
      }
      if (needsVacuum) {
        try {
          await client.query("VACUUM");
        } catch (error) {
          console.warn("[trails] postgres vacuum skipped", error?.message || error);
        }
      }
      let after = { db_size: "unknown" };
      try {
        const r = await client.query(
          `SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`,
        );
        after = r.rows[0];
      } catch {
        /* ignore */
      }
      return {
        ok: true,
        truncated: true,
        droppedPostgresTrails: true,
        after,
        note: "Trails now live on app filesystem; Postgres kept for Plus/auth only",
      };
    } finally {
      client.release();
    }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    await clientPool.end();
  }
}

export async function appendTrailPoints(trailKey, points) {
  await initTrailStore();
  if (!db) return { ok: false, reason: "no-store" };
  const key = normalizeKey(trailKey);
  if (!key) return { ok: false, reason: "bad-key" };
  const list = (Array.isArray(points) ? points : [])
    .map(normalizePoint)
    .filter(Boolean)
    .slice(0, MAX_BATCH);
  if (!list.length) return { ok: true, inserted: 0 };

  const insert = db.prepare(`
    INSERT INTO vehicle_trail_points
      (trail_key, t, lat, lng, heading, journey_id, trip_id, line, operator, direction, destination)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  if (backend === "node:sqlite") {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const p of list) {
        insert.run(
          key,
          p.t,
          p.lat,
          p.lng,
          p.heading,
          p.journeyId,
          p.tripId,
          p.line,
          p.operator,
          p.direction,
          p.destination,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw error;
    }
  } else {
    const tx = db.transaction((rows) => {
      for (const p of rows) {
        insert.run(
          key,
          p.t,
          p.lat,
          p.lng,
          p.heading,
          p.journeyId,
          p.tripId,
          p.line,
          p.operator,
          p.direction,
          p.destination,
        );
      }
    });
    tx(list);
  }

  sqlRun(
    `DELETE FROM vehicle_trail_points
     WHERE id IN (
       SELECT id FROM vehicle_trail_points
       WHERE trail_key = ?
       ORDER BY t DESC
       LIMIT -1 OFFSET ?
     )`,
    [key, MAX_POINTS_PER_KEY],
  );

  // Do not prune/VACUUM here — that froze HTTP (HTML/API) for seconds on every batch.
  // Hourly poller handles retention; checkpoint is rate-limited inside checkpointWal.
  checkpointWal();
  return { ok: true, inserted: list.length };
}

function rowToPoint(row) {
  return {
    t: Number(row.t),
    lat: Number(row.lat),
    lng: Number(row.lng),
    heading: row.heading == null ? null : Number(row.heading),
    journeyId: row.journey_id || "",
    tripId: row.trip_id || "",
    line: row.line || "",
    operator: row.operator || "",
    direction: row.direction || "",
    destination: row.destination || "",
  };
}

export async function appendTrailPointsBatch(entries) {
  await initTrailStore();
  if (!db) return { ok: false, reason: "no-store" };
  const batches = [];
  for (const [rawKey, rawPoints] of entries || []) {
    const key = normalizeKey(rawKey);
    if (!key) continue;
    const list = (Array.isArray(rawPoints) ? rawPoints : [])
      .map(normalizePoint)
      .filter(Boolean)
      .slice(0, MAX_BATCH);
    if (list.length) batches.push({ key, list });
  }
  if (!batches.length) return { ok: true, inserted: 0 };

  const insert = db.prepare(`
    INSERT INTO vehicle_trail_points
      (trail_key, t, lat, lng, heading, journey_id, trip_id, line, operator, direction, destination)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const trim = db.prepare(`
    DELETE FROM vehicle_trail_points
     WHERE id IN (
       SELECT id FROM vehicle_trail_points
       WHERE trail_key = ?
       ORDER BY t DESC
       LIMIT -1 OFFSET ?
     )
  `);
  let inserted = 0;
  const write = () => {
    for (const { key, list } of batches) {
      for (const p of list) {
        insert.run(
          key,
          p.t,
          p.lat,
          p.lng,
          p.heading,
          p.journeyId,
          p.tripId,
          p.line,
          p.operator,
          p.direction,
          p.destination,
        );
        inserted += 1;
      }
      trim.run(key, MAX_POINTS_PER_KEY);
    }
  };

  if (backend === "node:sqlite") {
    db.exec("BEGIN IMMEDIATE");
    try {
      write();
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw error;
    }
  } else {
    db.transaction(write)();
  }
  checkpointWal();
  return { ok: true, inserted };
}

export async function getTrailPoints(
  trailKey,
  { fromMs = 0, toMs = 0, days = TRAIL_KEEP_DAYS, limit = MAX_POINTS_PER_KEY } = {},
) {
  await initTrailStore();
  if (!db) return [];
  const key = normalizeKey(trailKey);
  if (!key) return [];
  const keepDays = Math.min(TRAIL_KEEP_DAYS, Math.max(1, Number(days) || TRAIL_KEEP_DAYS));
  const cutoff = Date.now() - keepDays * 86400000;
  const params = [key, cutoff];
  let where = `trail_key = ? AND t >= ?`;
  if (fromMs) {
    params.push(Number(fromMs));
    where += ` AND t >= ?`;
  }
  if (toMs) {
    params.push(Number(toMs));
    where += ` AND t <= ?`;
  }
  params.push(Math.min(MAX_POINTS_PER_KEY, Math.max(50, Number(limit) || MAX_POINTS_PER_KEY)));
  const rows = sqlAll(
    `SELECT t, lat, lng, heading, journey_id, trip_id, line, operator, direction, destination
     FROM (
       SELECT t, lat, lng, heading, journey_id, trip_id, line, operator, direction, destination
       FROM vehicle_trail_points
       WHERE ${where}
       ORDER BY t DESC
       LIMIT ?
     ) AS recent
     ORDER BY t ASC`,
    params,
  );
  return rows.map(rowToPoint);
}

export async function getTrailsForKeys(keys, opts = {}) {
  const list = [...new Set((keys || []).map(normalizeKey).filter(Boolean))].slice(
    0,
    MAX_KEYS_PER_QUERY,
  );
  const out = {};
  await Promise.all(
    list.map(async (key) => {
      out[key] = await getTrailPoints(key, opts);
    }),
  );
  return out;
}

function recentTrailKeysByColumn(column, values, { days = TRAIL_KEEP_DAYS, limit = 40 } = {}) {
  const codes = [...new Set((values || []).map((v) => String(v || "").trim().toUpperCase()).filter(Boolean))].slice(0, 24);
  if (!codes.length) return [];
  const keepDays = Math.min(TRAIL_KEEP_DAYS, Math.max(1, Number(days) || TRAIL_KEEP_DAYS));
  const cutoff = Date.now() - keepDays * 86400000;
  const cap = Math.min(80, Math.max(4, Number(limit) || 40));
  // Walk bounded newest-first windows instead of grouping the whole seven-day
  // table. This keeps route/Fleet key lists fast even while old duplicate rows
  // are being retired.
  const chunkSize = Math.min(30_000, Math.max(4_000, cap * 300));
  const maxChunks = 10;
  const placeholders = codes.map(() => "?").join(",");
  const grouped = new Map();
  let cursor = Number.MAX_SAFE_INTEGER;
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    const rows = sqlAll(
      `SELECT trail_key, line, operator, t
       FROM vehicle_trail_points
       WHERE ${column} IN (${placeholders})
         AND t >= ?
         AND t < ?
       ORDER BY t DESC
       LIMIT ?`,
      [...codes, cutoff, cursor, chunkSize],
    );
    if (!rows.length) break;
    for (const row of rows) {
      const key = String(row.trail_key || "").trim();
      if (!key) continue;
      const current = grouped.get(key) || {
        key,
        line: row.line || "",
        operator: row.operator || "",
        points: 0,
        lastT: 0,
      };
      current.points += 1;
      current.lastT = Math.max(current.lastT, Number(row.t) || 0);
      if (!current.line) current.line = row.line || "";
      if (!current.operator) current.operator = row.operator || "";
      grouped.set(key, current);
    }
    const nextCursor = Number(rows[rows.length - 1]?.t) || 0;
    if (!nextCursor || nextCursor >= cursor) break;
    cursor = nextCursor;
    if (rows.length < chunkSize && grouped.size >= cap) break;
    if (grouped.size >= cap + 10) break;
  }
  return [...grouped.values()]
    .filter((row) => row.points >= 2)
    .sort((a, b) => b.lastT - a.lastT)
    .slice(0, cap);
}

export async function listTrailKeysForLines(
  lines,
  { days = TRAIL_KEEP_DAYS, limit = 40 } = {},
) {
  await initTrailStore();
  if (!db) return [];
  return recentTrailKeysByColumn("line", lines, { days, limit });
}

export async function listTrailKeysForOperators(
  operators,
  { days = TRAIL_KEEP_DAYS, limit = 40 } = {},
) {
  await initTrailStore();
  if (!db) return [];
  return recentTrailKeysByColumn("operator", operators, { days, limit });
}

const DEAD_RUN_OPS = new Set(["FPOT", "DAGC"]);
const DEAD_RUN_GAP_MS = 20 * 60_000;

function isDeadRunLineSql(line) {
  const raw = String(line || "")
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!raw) return false;
  if (raw === "DR" || raw === "DEADRUN" || raw === "DEAD RUN") return true;
  return /\bDEAD\s*RUN\b/.test(raw);
}

function isBaseVehicleTrailKey(key) {
  const k = String(key || "").trim();
  if (!k) return false;
  if (
    k.startsWith("jny:") ||
    k.startsWith("trip:") ||
    k.startsWith("run:") ||
    k.startsWith("at:")
  ) {
    return false;
  }
  return true;
}

function ukDateKeyFromMs(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function identityFromDeadRunTrailKey(key, operator = "") {
  const raw = String(key || "").trim();
  const op = String(operator || "")
    .trim()
    .toUpperCase();
  if (raw.startsWith("reg:")) {
    const reg = raw.slice(4).replace(/\s+/g, "").toUpperCase();
    const regLabel = reg.replace(/([A-Z]{2}\d{2})([A-Z]{3})/i, "$1 $2");
    return { trailKey: raw, vehicleId: "", fleet: "", reg, regLabel };
  }
  if (/^\d+$/.test(raw)) {
    return { trailKey: raw, vehicleId: raw, fleet: "", reg: "", regLabel: "" };
  }
  const bods = raw.match(/^bods-([A-Z0-9]+)-(.+)$/i);
  if (bods) {
    let body = String(bods[2] || "")
      .replace(/_/g, " ")
      .trim();
    const plate = body.match(/\b([A-Z]{1,3}\d{1,2}\s*[A-Z]{3})\b/i);
    if (plate) {
      const regLabel = plate[1].replace(/\s+/g, " ").toUpperCase();
      const reg = regLabel.replace(/\s+/g, "");
      return { trailKey: raw, vehicleId: "", fleet: "", reg, regLabel };
    }
    const fleetOnly = body.match(/^(\d{1,5})$/);
    if (fleetOnly) {
      return {
        trailKey: raw,
        vehicleId: "",
        fleet: fleetOnly[1],
        reg: "",
        regLabel: "",
      };
    }
    return {
      trailKey: raw,
      vehicleId: "",
      fleet: "",
      reg: "",
      regLabel: body || "",
    };
  }
  if (raw.startsWith("staff-")) {
    const ref = raw.slice("staff-".length);
    const plate = ref.match(/\b([A-Z]{1,3}\d{1,2}\s*[A-Z]{3})\b/i);
    if (plate) {
      const regLabel = plate[1].replace(/\s+/g, " ").toUpperCase();
      return {
        trailKey: raw,
        vehicleId: "",
        fleet: "",
        reg: regLabel.replace(/\s+/g, ""),
        regLabel,
      };
    }
    return { trailKey: raw, vehicleId: "", fleet: ref, reg: "", regLabel: "" };
  }
  return {
    trailKey: raw,
    vehicleId: "",
    fleet: "",
    reg: "",
    regLabel: op ? "" : raw.slice(0, 24),
  };
}

function operatorDisplayName(op) {
  if (op === "FPOT") return "First Potteries";
  if (op === "DAGC") return "D & G Bus";
  return op || "Operator";
}

/**
 * Continuous Ticketer dead-run segments (FPOT / DAGC) from the keep window.
 * One row per gap/journey-split stint on a base vehicle trail key.
 */
export async function listDeadRunSegments({
  days = TRAIL_KEEP_DAYS,
  limit = 60,
  operators = ["FPOT", "DAGC"],
} = {}) {
  await initTrailStore();
  if (!db) return [];
  const keepDays = Math.min(TRAIL_KEEP_DAYS, Math.max(1, Number(days) || TRAIL_KEEP_DAYS));
  const cutoff = Date.now() - keepDays * 86400000;
  const cap = Math.min(120, Math.max(4, Number(limit) || 60));
  const ops = [
    ...new Set(
      (operators || [])
        .map((o) => String(o || "").trim().toUpperCase())
        .filter((o) => DEAD_RUN_OPS.has(o)),
    ),
  ];
  if (!ops.length) return [];
  const placeholders = ops.map(() => "?").join(",");
  // Broad pull then filter in JS — Ticketer uses Dead_Run / DEAD_RUN / DR.
  const rows = sqlAll(
    `SELECT trail_key, t, journey_id, line, operator, destination
     FROM vehicle_trail_points
     WHERE t >= ?
       AND operator IN (${placeholders})
       AND (
         line IN ('DEADRUN', 'DR', 'DEAD RUN')
         OR line LIKE '%DEAD%RUN%'
       )
     ORDER BY trail_key ASC, t ASC`,
    [cutoff, ...ops],
  );
  const byKey = new Map();
  for (const row of rows) {
    const key = String(row.trail_key || "").trim();
    if (!isBaseVehicleTrailKey(key)) continue;
    if (!isDeadRunLineSql(row.line)) continue;
    const list = byKey.get(key) || [];
    list.push(row);
    byKey.set(key, list);
  }
  const segments = [];
  for (const [key, pts] of byKey) {
    let cur = null;
    for (const p of pts) {
      const t = Number(p.t);
      if (!Number.isFinite(t)) continue;
      const op = String(p.operator || "")
        .trim()
        .toUpperCase();
      const jid = String(p.journey_id || "").trim();
      const dest = String(p.destination || "").trim();
      const gap = cur ? t - cur.lastT : Infinity;
      const journeyChanged = Boolean(cur?.journeyId && jid && cur.journeyId !== jid);
      if (!cur || journeyChanged || gap > DEAD_RUN_GAP_MS) {
        if (cur && cur.n >= 2) segments.push(cur);
        cur = {
          trailKey: key,
          operator: op,
          journeyId: jid,
          dest: dest || "",
          startT: t,
          lastT: t,
          n: 1,
        };
      } else {
        cur.lastT = t;
        cur.n += 1;
        if (jid && !cur.journeyId) cur.journeyId = jid;
        if (dest) cur.dest = dest;
        if (op && !cur.operator) cur.operator = op;
      }
    }
    if (cur && cur.n >= 2) segments.push(cur);
  }
  segments.sort((a, b) => b.startT - a.startT);
  const seen = new Set();
  const out = [];
  for (const seg of segments) {
    if (out.length >= cap) break;
    const id = `dr-${seg.trailKey}-${seg.startT}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const ident = identityFromDeadRunTrailKey(seg.trailKey, seg.operator);
    const destRaw = String(seg.dest || "").trim();
    const dest =
      destRaw && !/^dead\s*run$/i.test(destRaw.replace(/[_-]+/g, " "))
        ? destRaw
        : "Dead run";
    out.push({
      id,
      trailKey: ident.trailKey || seg.trailKey,
      vehicleId: ident.vehicleId || "",
      operator: seg.operator,
      operatorName: operatorDisplayName(seg.operator),
      fleet: ident.fleet || "",
      reg: ident.reg || "",
      regLabel: ident.regLabel || "",
      line: "DEAD_RUN",
      dest,
      journeyId: seg.journeyId || "",
      datetime: new Date(seg.startT).toISOString(),
      endDatetime: new Date(seg.lastT).toISOString(),
      date: ukDateKeyFromMs(seg.startT),
      points: seg.n,
      startT: seg.startT,
      lastT: seg.lastT,
    });
  }
  return out;
}

export function startTrailPrunePoller(intervalMs = 60 * 60_000) {
  const run = () => {
    pruneOldTrailPoints({ force: true }).catch((error) => {
      console.warn("[trails] prune failed", error?.message || error);
    });
  };
  setTimeout(run, 30_000);
  setInterval(run, intervalMs);
}

/** Direction split was a one-shot Postgres migration — no-op on filesystem store. */
export async function backfillTrailDirections() {
  await initTrailStore();
  if (!db) return { ok: false, reason: "no-store" };
  const existing = sqlGet(`SELECT id FROM trail_direction_migrations WHERE id = ?`, [
    "fs-store-v1",
  ]);
  if (existing) return { ok: true, skipped: true, reason: "already-applied" };
  sqlRun(`INSERT OR IGNORE INTO trail_direction_migrations (id, detail) VALUES (?, ?)`, [
    "fs-store-v1",
    "trails on app filesystem",
  ]);
  return { ok: true, skipped: true, reason: "filesystem-backend" };
}
