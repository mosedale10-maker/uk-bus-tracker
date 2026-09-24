/**
 * Bus stop locations on app disk (SQLite file).
 *
 * bustimes.org's /api/stops/ has NO spatial filter (bounding_box / lat+lon / radius /
 * area are all ignored), and the full GB catalogue is ~427k stops. So we bulk-import
 * once and answer map-view bbox queries locally with an index — no upstream load per pan.
 *
 * Serves GeoJSON shaped exactly like the old bustimes proxy so src/main.js needs no
 * changes: properties.url carries "/stops/<atco>" (the client's atco extractor), and
 * geometry.coordinates is [lng, lat].
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(__dirname, "data", "stops");

let db = null;
let ready = null;
let backend = "none";

function stopDataDir() {
  return String(process.env.STOP_DATA_DIR || DEFAULT_DIR).trim() || DEFAULT_DIR;
}

function openSqlite(filePath) {
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(filePath);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA synchronous = NORMAL;");
    database.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return { database, kind: "node:sqlite" };
  } catch (error) {
    console.warn("[stops] node:sqlite open failed:", error?.message || error);
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
    console.warn("[stops] better-sqlite3 open failed:", error?.message || error);
    return null;
  }
}

const sqlExec = (sql) => db.exec(sql);
const sqlAll = (sql, params = []) => db.prepare(sql).all(...params);
const sqlGet = (sql, params = []) => db.prepare(sql).get(...params);

export async function initStopStore() {
  if (ready) return ready;
  ready = (async () => {
    const dir = stopDataDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "stops.sqlite");
    const opened = openSqlite(filePath);
    if (!opened) {
      console.error("[stops] SQLite unavailable (need Node >= 22.5 or better-sqlite3) — stop pins disabled");
      return false;
    }
    db = opened.database;
    backend = opened.kind;
    sqlExec(`
      CREATE TABLE IF NOT EXISTS stops (
        atco TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        indicator TEXT NOT NULL DEFAULT '',
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        services TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS stops_lat_lng_idx ON stops (lat, lng);
    `);
    const count = sqlGet("SELECT COUNT(*) AS n FROM stops")?.n || 0;
    console.log(`[stops] store ready (${backend}) path=${filePath} stops=${count}`);
    return true;
  })().catch((error) => {
    ready = null;
    db = null;
    backend = "none";
    throw error;
  });
  return ready;
}

export function stopsEnabled() {
  return Boolean(db);
}

export function stopCount() {
  if (!db) return 0;
  return sqlGet("SELECT COUNT(*) AS n FROM stops")?.n || 0;
}

/** Insert/replace a batch inside a transaction. Rows: {atco,name,indicator,lat,lng,services} */
export function upsertStops(rows) {
  if (!db || !Array.isArray(rows) || !rows.length) return 0;
  const stmt = db.prepare(
    `INSERT INTO stops (atco, name, indicator, lat, lng, services)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(atco) DO UPDATE SET
       name = excluded.name,
       indicator = excluded.indicator,
       lat = excluded.lat,
       lng = excluded.lng,
       services = excluded.services`,
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      if (!r?.atco || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue;
      stmt.run(
        String(r.atco),
        String(r.name || ""),
        String(r.indicator || ""),
        Number(r.lat),
        Number(r.lng),
        String(r.services || ""),
      );
      n += 1;
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
  return n;
}

/** Remove stops that are no longer in the upstream catalogue. */
export function pruneStopsNotIn(activeAtcos) {
  if (!db || !activeAtcos?.size) return 0;
  const all = sqlAll("SELECT atco FROM stops").map((r) => String(r.atco));
  let removed = 0;
  db.exec("BEGIN");
  try {
    const del = db.prepare("DELETE FROM stops WHERE atco = ?");
    for (const atco of all) {
      if (!activeAtcos.has(atco)) {
        del.run(atco);
        removed += 1;
      }
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
  return removed;
}

/**
 * Stops inside a bbox as a GeoJSON FeatureCollection, matching the shape the client
 * expects. `limit` guards against pathological zoom-outs.
 */
export function stopsInBounds({ south, west, north, east, limit = 4000 } = {}) {
  const empty = { type: "FeatureCollection", features: [] };
  if (!db) return empty;
  const s = Number(south);
  const w = Number(west);
  const n = Number(north);
  const e = Number(east);
  if (![s, w, n, e].every(Number.isFinite)) return empty;
  // Guard against a wrapped/anti-meridian box.
  if (n < s || e < w) return empty;
  const rows = sqlAll(
    `SELECT atco, name, indicator, lat, lng, services
       FROM stops
      WHERE lat >= ? AND lat <= ? AND lng >= ? AND lng <= ?
      ORDER BY name
      LIMIT ?`,
    [s, n, w, e, Math.min(Number(limit) || 4000, 20000)],
  );
  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.lng, r.lat] },
      properties: {
        // Client extracts the atco from this URL path.
        url: `/stops/${r.atco}`,
        atco: r.atco,
        name: r.name || "",
        indicator: r.indicator || "",
        services: r.services ? r.services.split("|").filter(Boolean) : [],
      },
    })),
  };
}
