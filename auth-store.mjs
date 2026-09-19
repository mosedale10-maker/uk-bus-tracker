/** User accounts + Plus entitlement (Postgres). */

import crypto from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const scryptAsync = promisify(crypto.scrypt);
const COOKIE = "uk_bus_session";
const TOKEN_DAYS = 90;

let pool = null;
let ready = null;

function authSecret() {
  return String(process.env.AUTH_SECRET || "dev-only-change-me").trim();
}

export function hasDatabase() {
  return Boolean(String(process.env.DATABASE_URL || "").trim());
}

export async function initAuthStore() {
  if (ready) return ready;
  ready = (async () => {
    if (!hasDatabase()) {
      console.warn("[auth] DATABASE_URL missing — accounts disabled");
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
      max: 5,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        plus BOOLEAN NOT NULL DEFAULT FALSE,
        plus_until TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS plus_until TIMESTAMPTZ NULL;
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS plus_cancelled BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    console.log("[auth] users table ready");
    return true;
  })();
  return ready;
}

export function userHasPlus(row) {
  if (!row) return false;
  if (row.plus_until) {
    const until = new Date(row.plus_until).getTime();
    // Prepaid time still counts even after cancel (no further months).
    return Number.isFinite(until) && until > Date.now();
  }
  if (!row.plus) return false;
  return !row.plus_cancelled;
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(String(password), salt, 64);
  return `scrypt$${salt.toString("base64")}$${Buffer.from(derived).toString("base64")}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "base64");
  const expected = Buffer.from(parts[2], "base64");
  const derived = await scryptAsync(String(password), salt, 64);
  const actual = Buffer.from(derived);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

export function signSession(user) {
  const payload = {
    sub: user.id,
    email: user.email,
    plus: userHasPlus(user),
    exp: Date.now() + TOKEN_DAYS * 24 * 60 * 60 * 1000,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", authSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export function readSessionToken(token) {
  const raw = String(token || "");
  const i = raw.lastIndexOf(".");
  if (i <= 0) return null;
  const body = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expect = b64url(crypto.createHmac("sha256", authSecret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8"));
    if (!payload?.sub || !payload?.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const header = String(req.headers.cookie || "");
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(val);
  }
  return out;
}

export function sessionCookie(token, { clear = false } = {}) {
  if (clear) {
    return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  }
  const maxAge = TOKEN_DAYS * 24 * 60 * 60;
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    plus: userHasPlus(row),
    plusUntil: row.plus_until || null,
    plusCancelled: Boolean(row.plus_cancelled),
  };
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    plus: userHasPlus(row),
    plus_until: row.plus_until || null,
    plus_cancelled: Boolean(row.plus_cancelled),
  };
}

export async function createUser(email, password) {
  await initAuthStore();
  if (!pool) throw Object.assign(new Error("Accounts are not available yet"), { status: 503 });
  const normalized = normalizeEmail(email);
  if (!validEmail(normalized)) {
    throw Object.assign(new Error("Enter a valid email address"), { status: 400 });
  }
  if (String(password || "").length < 8) {
    throw Object.assign(new Error("Password must be at least 8 characters"), { status: 400 });
  }
  const passwordHash = await hashPassword(password);
  try {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       RETURNING id, email, plus, plus_until, plus_cancelled`,
      [normalized, passwordHash],
    );
    return mapUserRow(result.rows[0]);
  } catch (error) {
    if (error?.code === "23505") {
      throw Object.assign(new Error("An account with that email already exists"), { status: 409 });
    }
    throw error;
  }
}

export async function authenticateUser(email, password) {
  await initAuthStore();
  if (!pool) throw Object.assign(new Error("Accounts are not available yet"), { status: 503 });
  const normalized = normalizeEmail(email);
  const result = await pool.query(
    `SELECT id, email, plus, plus_until, plus_cancelled, password_hash FROM users WHERE email = $1`,
    [normalized],
  );
  const row = result.rows[0];
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    throw Object.assign(new Error("Email or password is incorrect"), { status: 401 });
  }
  return mapUserRow(row);
}

export async function getUserById(id) {
  await initAuthStore();
  if (!pool || !id) return null;
  const result = await pool.query(
    `SELECT id, email, plus, plus_until, plus_cancelled FROM users WHERE id = $1`,
    [id],
  );
  return mapUserRow(result.rows[0]);
}

export async function setUserPlus(id, plus = true, { months = 1 } = {}) {
  await initAuthStore();
  if (!pool || !id) return null;
  if (!plus) {
    const result = await pool.query(
      `UPDATE users SET plus = FALSE, plus_until = NULL, plus_cancelled = TRUE, updated_at = NOW() WHERE id = $1
       RETURNING id, email, plus, plus_until, plus_cancelled`,
      [id],
    );
    return mapUserRow(result.rows[0]);
  }
  const monthsN = Math.max(1, Number(months) || 1);
  const result = await pool.query(
    `UPDATE users SET
       plus = TRUE,
       plus_cancelled = FALSE,
       plus_until = CASE
         WHEN plus_until IS NOT NULL AND plus_until > NOW()
           THEN plus_until + ($2::text || ' months')::interval
         ELSE NOW() + ($2::text || ' months')::interval
       END,
       updated_at = NOW()
     WHERE id = $1
     RETURNING id, email, plus, plus_until, plus_cancelled`,
    [id, String(monthsN)],
  );
  return mapUserRow(result.rows[0]);
}

/** Stop Plus renewals. Keeps prepaid time until plus_until when still in date. */
export async function cancelUserPlus(id) {
  await initAuthStore();
  if (!pool || !id) {
    throw Object.assign(new Error("Accounts are not available yet"), { status: 503 });
  }
  const current = await getUserById(id);
  if (!current) {
    throw Object.assign(new Error("Not signed in"), { status: 401 });
  }
  if (!userHasPlus(current) && !current.plus) {
    throw Object.assign(new Error("This account does not have Plus"), { status: 400 });
  }

  const untilMs = current.plus_until ? new Date(current.plus_until).getTime() : 0;
  if (Number.isFinite(untilMs) && untilMs > Date.now()) {
    const result = await pool.query(
      `UPDATE users SET plus_cancelled = TRUE, updated_at = NOW() WHERE id = $1
       RETURNING id, email, plus, plus_until, plus_cancelled`,
      [id],
    );
    return mapUserRow(result.rows[0]);
  }

  const result = await pool.query(
    `UPDATE users SET plus = FALSE, plus_until = NULL, plus_cancelled = TRUE, updated_at = NOW() WHERE id = $1
     RETURNING id, email, plus, plus_until, plus_cancelled`,
    [id],
  );
  return mapUserRow(result.rows[0]);
}

export async function grantPlusByEmail(email, { months = 1 } = {}) {
  await initAuthStore();
  if (!pool) throw Object.assign(new Error("Accounts are not available yet"), { status: 503 });
  const normalized = normalizeEmail(email);
  const found = await pool.query(`SELECT id FROM users WHERE email = $1`, [normalized]);
  if (!found.rows[0]) {
    throw Object.assign(new Error(`No account found for ${normalized}`), { status: 404 });
  }
  return setUserPlus(found.rows[0].id, true, { months });
}

export async function userFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE] || "";
  const payload = readSessionToken(token);
  if (!payload?.sub) return null;
  const user = await getUserById(payload.sub);
  return user;
}

export { COOKIE };
