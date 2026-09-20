/** Stoke-on-Trent control-room notices + operator service alerts. */

import { hasDatabase, initAuthStore } from "./auth-store.mjs";
import pg from "pg";

let pool = null;
let ready = null;

function getPool() {
  return pool;
}

export async function initNoticeStore() {
  if (ready) return ready;
  ready = (async () => {
    await initAuthStore();
    if (!hasDatabase()) {
      console.warn("[notices] DATABASE_URL missing — control-room notices disabled");
      return false;
    }
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.DATABASE_SSL === "1"
          ? { rejectUnauthorized: false }
          : process.env.DATABASE_URL?.includes("railway.internal")
            ? false
            : undefined,
      max: 3,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS service_notices (
        id SERIAL PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'control_room',
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        operator TEXT NOT NULL DEFAULT '',
        routes TEXT NOT NULL DEFAULT '',
        area TEXT NOT NULL DEFAULT 'Stoke-on-Trent',
        source_url TEXT NOT NULL DEFAULT '',
        external_key TEXT NOT NULL DEFAULT '',
        speak BOOLEAN NOT NULL DEFAULT TRUE,
        priority INTEGER NOT NULL DEFAULT 50,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        starts_at TIMESTAMPTZ NULL,
        ends_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS service_notices_external_key_uidx
        ON service_notices (external_key)
        WHERE external_key <> '';
      CREATE INDEX IF NOT EXISTS service_notices_active_updated_idx
        ON service_notices (active, updated_at DESC);
      CREATE INDEX IF NOT EXISTS service_notices_kind_active_idx
        ON service_notices (kind, active);
    `);
    console.log("[notices] service_notices table ready");
    return true;
  })();
  return ready;
}

export function noticesEnabled() {
  return Boolean(getPool());
}

function publicNotice(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind || "control_room",
    title: row.title || "",
    body: row.body || "",
    operator: row.operator || "",
    routes: row.routes || "",
    area: row.area || "Stoke-on-Trent",
    sourceUrl: row.source_url || "",
    speak: Boolean(row.speak),
    priority: Number(row.priority) || 50,
    active: Boolean(row.active),
    startsAt: row.starts_at || null,
    endsAt: row.ends_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function isCurrentlyActive(row, now = Date.now()) {
  if (!row?.active) return false;
  const start = row.starts_at ? new Date(row.starts_at).getTime() : 0;
  const end = row.ends_at ? new Date(row.ends_at).getTime() : Infinity;
  if (Number.isFinite(start) && now < start) return false;
  if (Number.isFinite(end) && now > end) return false;
  return true;
}

export async function listActiveNotices({ kind = "", limit = 40 } = {}) {
  await initNoticeStore();
  if (!pool) return [];
  const params = [Math.min(100, Math.max(1, Number(limit) || 40))];
  let where = "WHERE active = TRUE";
  if (kind === "control_room" || kind === "operator") {
    params.push(kind);
    where += ` AND kind = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT id, kind, title, body, operator, routes, area, source_url, speak, priority,
            active, starts_at, ends_at, created_at, updated_at
     FROM service_notices
     ${where}
     ORDER BY priority DESC, updated_at DESC
     LIMIT $1`,
    params,
  );
  return result.rows.map(publicNotice).filter((row) => isCurrentlyActive(row));
}

export async function listAllNotices({ limit = 60, kind = "" } = {}) {
  await initNoticeStore();
  if (!pool) return [];
  const params = [Math.min(150, Math.max(1, Number(limit) || 60))];
  let where = "";
  if (kind === "control_room" || kind === "operator") {
    params.push(kind);
    where = `WHERE kind = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT id, kind, title, body, operator, routes, area, source_url, speak, priority,
            active, starts_at, ends_at, created_at, updated_at
     FROM service_notices
     ${where}
     ORDER BY updated_at DESC
     LIMIT $1`,
    params,
  );
  return result.rows.map(publicNotice);
}

export async function createControlRoomNotice({
  title,
  body = "",
  operator = "",
  routes = "",
  area = "Stoke-on-Trent",
  speak = true,
  priority = 80,
  startsAt = null,
  endsAt = null,
} = {}) {
  await initNoticeStore();
  if (!pool) throw Object.assign(new Error("Notices unavailable"), { status: 503 });
  const cleanTitle = String(title || "").trim().slice(0, 160);
  if (!cleanTitle) throw Object.assign(new Error("Title is required"), { status: 400 });
  const result = await pool.query(
    `INSERT INTO service_notices
      (kind, title, body, operator, routes, area, speak, priority, active, starts_at, ends_at, updated_at)
     VALUES ('control_room', $1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9, NOW())
     RETURNING id, kind, title, body, operator, routes, area, source_url, speak, priority,
               active, starts_at, ends_at, created_at, updated_at`,
    [
      cleanTitle,
      String(body || "").trim().slice(0, 1200),
      String(operator || "").trim().slice(0, 80),
      String(routes || "").trim().slice(0, 120),
      String(area || "Stoke-on-Trent").trim().slice(0, 80) || "Stoke-on-Trent",
      Boolean(speak),
      Math.min(100, Math.max(0, Number(priority) || 80)),
      startsAt || null,
      endsAt || null,
    ],
  );
  return publicNotice(result.rows[0]);
}

export async function setNoticeActive(id, active) {
  await initNoticeStore();
  if (!pool) throw Object.assign(new Error("Notices unavailable"), { status: 503 });
  const result = await pool.query(
    `UPDATE service_notices
     SET active = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, kind, title, body, operator, routes, area, source_url, speak, priority,
               active, starts_at, ends_at, created_at, updated_at`,
    [Number(id), Boolean(active)],
  );
  if (!result.rows[0]) throw Object.assign(new Error("Notice not found"), { status: 404 });
  return publicNotice(result.rows[0]);
}

export async function deleteNotice(id) {
  await initNoticeStore();
  if (!pool) throw Object.assign(new Error("Notices unavailable"), { status: 503 });
  const result = await pool.query(`DELETE FROM service_notices WHERE id = $1 RETURNING id`, [
    Number(id),
  ]);
  if (!result.rows[0]) throw Object.assign(new Error("Notice not found"), { status: 404 });
  return { ok: true, id: Number(id) };
}

/** Upsert an ingested operator alert by stable external_key. */
export async function upsertOperatorNotice({
  externalKey,
  title,
  body = "",
  operator = "",
  routes = "",
  area = "Stoke-on-Trent",
  sourceUrl = "",
  priority = 40,
  endsAt = null,
} = {}) {
  await initNoticeStore();
  if (!pool) return null;
  const key = String(externalKey || "").trim().slice(0, 200);
  const cleanTitle = String(title || "").trim().slice(0, 160);
  if (!key || !cleanTitle) return null;
  const result = await pool.query(
    `INSERT INTO service_notices
      (kind, title, body, operator, routes, area, source_url, external_key, speak, priority,
       active, ends_at, updated_at)
     VALUES ('operator', $1, $2, $3, $4, $5, $6, $7, FALSE, $8, TRUE, $9, NOW())
     ON CONFLICT (external_key) WHERE external_key <> ''
     DO UPDATE SET
       title = EXCLUDED.title,
       body = EXCLUDED.body,
       operator = EXCLUDED.operator,
       routes = EXCLUDED.routes,
       area = EXCLUDED.area,
       source_url = EXCLUDED.source_url,
       priority = EXCLUDED.priority,
       active = TRUE,
       ends_at = EXCLUDED.ends_at,
       updated_at = NOW()
     RETURNING id, kind, title, body, operator, routes, area, source_url, speak, priority,
               active, starts_at, ends_at, created_at, updated_at`,
    [
      cleanTitle,
      String(body || "").trim().slice(0, 1200),
      String(operator || "").trim().slice(0, 80),
      String(routes || "").trim().slice(0, 120),
      String(area || "Stoke-on-Trent").trim().slice(0, 80) || "Stoke-on-Trent",
      String(sourceUrl || "").trim().slice(0, 400),
      key,
      Math.min(100, Math.max(0, Number(priority) || 40)),
      endsAt || null,
    ],
  );
  return publicNotice(result.rows[0]);
}

/** Deactivate operator notices whose external_key prefix is not in the keep set. */
export async function deactivateMissingOperatorNotices(prefix, keepKeys = []) {
  await initNoticeStore();
  if (!pool) return 0;
  const keep = (keepKeys || []).map(String).filter(Boolean);
  if (!prefix) return 0;
  if (!keep.length) {
    const result = await pool.query(
      `UPDATE service_notices
       SET active = FALSE, updated_at = NOW()
       WHERE kind = 'operator' AND active = TRUE AND external_key LIKE $1
       RETURNING id`,
      [`${prefix}%`],
    );
    return result.rowCount || 0;
  }
  const result = await pool.query(
    `UPDATE service_notices
     SET active = FALSE, updated_at = NOW()
     WHERE kind = 'operator'
       AND active = TRUE
       AND external_key LIKE $1
       AND NOT (external_key = ANY($2::text[]))
     RETURNING id`,
    [`${prefix}%`, keep],
  );
  return result.rowCount || 0;
}

export { requireAdminSecret } from "./photo-store.mjs";
