/** GPS trail storage on app disk (SQLite file) — Plus/auth stays on Postgres. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { hasDatabase } from "./auth-store.mjs";
import pg from "pg";

export const TRAIL_KEEP_DAYS = 7;
const MAX_BATCH = 250;
const MAX_POINTS_PER_KEY = 4_000;
const MAX_KEYS_PER_QUERY = 12;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(__dirname, "data", "trails");

let db = null;
let ready = null;
let lastPruneAt = 0;
let backend = "none";

function trailDataDir() {
  return String(process.env.TRAIL_DATA_DIR || DEFAULT_DIR).trim() || DEFAULT_DIR;
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
    return { database, kind: "node:sqlite" };
  } catch {
    /* fall through */
  }
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const database = new Database(filePath);
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    return { database, kind: "better-sqlite3" };
  } catch {
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
        direction TEXT NOT NULL DEFAULT ''
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
  if (age > TRAIL_KEEP_DAYS * 86400000 || age < -5 * 60_000) return null;
  const heading = Number(raw?.heading);
  return {
    t: Math.round(t),
    lat,
    lng,
    heading: Number.isFinite(heading) ? heading : null,
    journeyId: String(raw?.journeyId || "").slice(0, 80),
    tripId: String(raw?.tripId || "").slice(0, 80),
    line: String(raw?.line || "").slice(0, 40),
    operator: String(raw?.operator || "")
      .trim()
      .toUpperCase()
      .slice(0, 16),
    direction: normalizeDirection(raw?.direction || raw?.directionRef),
  };
}

export async function pruneOldTrailPoints({ force = false, days = TRAIL_KEEP_DAYS } = {}) {
  await initTrailStore();
  if (!db) return 0;
  const now = Date.now();
  if (!force && now - lastPruneAt < 20 * 60_000) return 0;
  lastPruneAt = now;
  const keepDays = Math.min(TRAIL_KEEP_DAYS, Math.max(1, Number(days) || TRAIL_KEEP_DAYS));
  const cutoff = now - keepDays * 86400000;
  const result = sqlRun(`DELETE FROM vehicle_trail_points WHERE t < ?`, [cutoff]);
  const n = Number(result?.changes || 0);
  if (n) console.log(`[trails] pruned ${n} points older than ${keepDays}d`);
  try {
    sqlExec("VACUUM");
  } catch {
    /* ignore */
  }
  return n;
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
      try {
        await client.query("VACUUM");
      } catch (error) {
        console.warn("[trails] postgres vacuum skipped", error?.message || error);
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
      (trail_key, t, lat, lng, heading, journey_id, trip_id, line, operator, direction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  pruneOldTrailPoints().catch(() => {});
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
  };
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
    `SELECT t, lat, lng, heading, journey_id, trip_id, line, operator, direction
     FROM vehicle_trail_points
     WHERE ${where}
     ORDER BY t ASC
     LIMIT ?`,
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

export async function listTrailKeysForLines(
  lines,
  { days = TRAIL_KEEP_DAYS, limit = 40 } = {},
) {
  await initTrailStore();
  if (!db) return [];
  const codes = [
    ...new Set(
      (lines || [])
        .map((l) => String(l || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, 24);
  if (!codes.length) return [];
  const keepDays = Math.min(TRAIL_KEEP_DAYS, Math.max(1, Number(days) || TRAIL_KEEP_DAYS));
  const cutoff = Date.now() - keepDays * 86400000;
  const cap = Math.min(80, Math.max(4, Number(limit) || 40));
  const placeholders = codes.map(() => "?").join(",");
  const rows = sqlAll(
    `SELECT trail_key, MAX(line) AS line, MAX(operator) AS operator,
            COUNT(*) AS n, MAX(t) AS last_t
     FROM vehicle_trail_points
     WHERE UPPER(TRIM(line)) IN (${placeholders})
       AND t >= ?
     GROUP BY trail_key
     HAVING COUNT(*) >= 2
     ORDER BY MAX(t) DESC
     LIMIT ?`,
    [...codes, cutoff, cap],
  );
  return rows.map((row) => ({
    key: row.trail_key,
    line: row.line || "",
    operator: row.operator || "",
    points: Number(row.n) || 0,
    lastT: Number(row.last_t) || 0,
  }));
}

export async function listTrailKeysForOperators(
  operators,
  { days = TRAIL_KEEP_DAYS, limit = 40 } = {},
) {
  await initTrailStore();
  if (!db) return [];
  const codes = [
    ...new Set(
      (operators || [])
        .map((o) => String(o || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, 12);
  if (!codes.length) return [];
  const keepDays = Math.min(TRAIL_KEEP_DAYS, Math.max(1, Number(days) || TRAIL_KEEP_DAYS));
  const cutoff = Date.now() - keepDays * 86400000;
  const cap = Math.min(80, Math.max(4, Number(limit) || 40));
  const placeholders = codes.map(() => "?").join(",");
  const rows = sqlAll(
    `SELECT trail_key, MAX(line) AS line, MAX(operator) AS operator,
            COUNT(*) AS n, MAX(t) AS last_t
     FROM vehicle_trail_points
     WHERE UPPER(TRIM(operator)) IN (${placeholders})
       AND t >= ?
     GROUP BY trail_key
     HAVING COUNT(*) >= 2
     ORDER BY MAX(t) DESC
     LIMIT ?`,
    [...codes, cutoff, cap],
  );
  return rows.map((row) => ({
    key: row.trail_key,
    line: row.line || "",
    operator: row.operator || "",
    points: Number(row.n) || 0,
    lastT: Number(row.last_t) || 0,
  }));
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
