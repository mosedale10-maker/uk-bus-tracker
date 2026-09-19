/** Community bus photos — Plus uploads, owner approval required. */

import { hasDatabase, initAuthStore } from "./auth-store.mjs";
import pg from "pg";

let pool = null;
let ready = null;

function getPool() {
  return pool;
}

export async function initPhotoStore() {
  if (ready) return ready;
  ready = (async () => {
    await initAuthStore();
    if (!hasDatabase()) {
      console.warn("[photos] DATABASE_URL missing — bus photos disabled");
      return false;
    }
    // Reuse a dedicated pool so photo BYTEA traffic does not starve auth.
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
      CREATE TABLE IF NOT EXISTS bus_photos (
        id SERIAL PRIMARY KEY,
        reg TEXT NOT NULL,
        fleet TEXT NOT NULL DEFAULT '',
        operator TEXT NOT NULL DEFAULT '',
        mime TEXT NOT NULL DEFAULT 'image/jpeg',
        image BYTEA NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        uploader_id INTEGER NULL,
        uploader_email TEXT NOT NULL DEFAULT '',
        uploader_name TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ NULL
      );
      ALTER TABLE bus_photos ADD COLUMN IF NOT EXISTS uploader_name TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS bus_photos_reg_status_idx ON bus_photos (reg, status);
      CREATE INDEX IF NOT EXISTS bus_photos_status_created_idx ON bus_photos (status, created_at DESC);
    `);
    console.log("[photos] bus_photos table ready");
    return true;
  })();
  return ready;
}

export function photosEnabled() {
  return Boolean(getPool());
}

export function compactRegKey(reg) {
  return String(reg || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function publicPhoto(row) {
  if (!row) return null;
  return {
    id: row.id,
    reg: row.reg,
    fleet: row.fleet || "",
    operator: row.operator || "",
    mime: row.mime || "image/jpeg",
    status: row.status,
    uploaderEmail: row.uploader_email || "",
    uploaderName: row.uploader_name || "",
    note: row.note || "",
    createdAt: row.created_at || null,
    reviewedAt: row.reviewed_at || null,
    url: `/api/bus-photos/${row.id}/image`,
  };
}

export async function submitBusPhoto({
  reg,
  fleet = "",
  operator = "",
  mime = "image/jpeg",
  buffer,
  user,
  note = "",
  uploaderName = "",
} = {}) {
  await initPhotoStore();
  if (!pool) throw Object.assign(new Error("Photo uploads are not available yet"), { status: 503 });
  const key = compactRegKey(reg);
  if (key.length < 5) {
    throw Object.assign(new Error("A valid registration plate is required"), { status: 400 });
  }
  if (!user?.plus) {
    throw Object.assign(new Error("Plus is required to submit bus photos"), { status: 403 });
  }
  if (!Buffer.isBuffer(buffer) || buffer.length < 500) {
    throw Object.assign(new Error("Photo looks empty or too small"), { status: 400 });
  }
  if (buffer.length > 700_000) {
    throw Object.assign(new Error("Photo is too large (max about 700 KB)"), { status: 400 });
  }
  const type = String(mime || "image/jpeg").toLowerCase();
  if (!/^image\/(jpeg|jpg|png|webp)$/.test(type)) {
    throw Object.assign(new Error("Only JPEG, PNG or WebP photos are allowed"), { status: 400 });
  }

  // Pending photos stay queued for owner review — no per-user upload cap.

  const credit = String(uploaderName || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);

  const result = await pool.query(
    `INSERT INTO bus_photos (reg, fleet, operator, mime, image, status, uploader_id, uploader_email, uploader_name, note)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)
     RETURNING id, reg, fleet, operator, mime, status, uploader_email, uploader_name, note, created_at, reviewed_at`,
    [
      key,
      String(fleet || "").trim().slice(0, 40),
      String(operator || "").trim().slice(0, 80),
      type === "image/jpg" ? "image/jpeg" : type,
      buffer,
      user.id || null,
      String(user.email || "").trim().slice(0, 160),
      credit,
      String(note || "").trim().slice(0, 200),
    ],
  );
  return publicPhoto(result.rows[0]);
}

export async function getApprovedPhotoForReg(reg) {
  await initPhotoStore();
  if (!pool) return null;
  const key = compactRegKey(reg);
  if (!key) return null;
  const result = await pool.query(
    `SELECT id, reg, fleet, operator, mime, status, uploader_email, uploader_name, note, created_at, reviewed_at
     FROM bus_photos
     WHERE reg = $1 AND status = 'approved'
     ORDER BY reviewed_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [key],
  );
  return publicPhoto(result.rows[0]);
}

export async function getPhotoImage(id) {
  await initPhotoStore();
  if (!pool) return null;
  const result = await pool.query(
    `SELECT id, mime, image, status FROM bus_photos WHERE id = $1`,
    [Number(id)],
  );
  return result.rows[0] || null;
}

export async function listPendingPhotos({ limit = 50 } = {}) {
  await initPhotoStore();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, reg, fleet, operator, mime, status, uploader_email, uploader_name, note, created_at, reviewed_at
     FROM bus_photos
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1`,
    [Math.min(100, Math.max(1, Number(limit) || 50))],
  );
  return result.rows.map(publicPhoto);
}

export async function listRecentPhotos({ limit = 40, status = "" } = {}) {
  await initPhotoStore();
  if (!pool) return [];
  const params = [Math.min(100, Math.max(1, Number(limit) || 40))];
  let where = "";
  if (status === "pending" || status === "approved" || status === "rejected") {
    where = "WHERE status = $2";
    params.push(status);
  }
  const result = await pool.query(
    `SELECT id, reg, fleet, operator, mime, status, uploader_email, uploader_name, note, created_at, reviewed_at
     FROM bus_photos
     ${where}
     ORDER BY created_at DESC
     LIMIT $1`,
    params,
  );
  return result.rows.map(publicPhoto);
}

export async function setPhotoStatus(id, status) {
  await initPhotoStore();
  if (!pool) throw Object.assign(new Error("Photos unavailable"), { status: 503 });
  const next = String(status || "").toLowerCase();
  if (next !== "approved" && next !== "rejected" && next !== "pending") {
    throw Object.assign(new Error("Invalid status"), { status: 400 });
  }
  const result = await pool.query(
    `UPDATE bus_photos
     SET status = $2,
         reviewed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE NOW() END
     WHERE id = $1
     RETURNING id, reg, fleet, operator, mime, status, uploader_email, uploader_name, note, created_at, reviewed_at`,
    [Number(id), next],
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error("Photo not found"), { status: 404 });
  }
  // Only one approved photo per registration — demote older approvals.
  if (next === "approved") {
    await pool.query(
      `UPDATE bus_photos
       SET status = 'rejected', reviewed_at = NOW()
       WHERE reg = $1 AND status = 'approved' AND id <> $2`,
      [result.rows[0].reg, result.rows[0].id],
    );
  }
  return publicPhoto(result.rows[0]);
}

export async function deletePhoto(id) {
  await initPhotoStore();
  if (!pool) throw Object.assign(new Error("Photos unavailable"), { status: 503 });
  const result = await pool.query(`DELETE FROM bus_photos WHERE id = $1 RETURNING id`, [Number(id)]);
  if (!result.rows[0]) throw Object.assign(new Error("Photo not found"), { status: 404 });
  return { ok: true, id: Number(id) };
}

export function decodeDataUrlOrBase64(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (match) {
    return { mime: match[1].toLowerCase(), buffer: Buffer.from(match[2], "base64") };
  }
  // Plain base64
  if (!/^[A-Za-z0-9+/=\s]+$/.test(text) || text.length < 100) {
    throw Object.assign(new Error("Invalid image data"), { status: 400 });
  }
  return { mime: "image/jpeg", buffer: Buffer.from(text.replace(/\s+/g, ""), "base64") };
}

export function requireAdminSecret(req) {
  const secret = String(process.env.AUTH_SECRET || "").trim();
  const auth = String(req.headers.authorization || "");
  const headerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const queryToken = String(req.query?.secret || "").trim();
  const token = headerToken || queryToken;
  if (!secret || !token || token !== secret) {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  }
}
