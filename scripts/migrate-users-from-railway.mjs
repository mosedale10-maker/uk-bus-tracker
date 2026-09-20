/** Copy Plus users (+ purchases) from Railway Postgres into local PC Postgres. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const localUrl = String(
  process.env.DATABASE_URL ||
    fs.readFileSync(path.join(root, "data", "pc-database.url"), "utf8"),
).trim();

const remoteRaw = String(process.env.RAILWAY_DATABASE_URL || "").trim();
if (!remoteRaw) {
  console.error("RAILWAY_DATABASE_URL missing (use railway run / tunnel)");
  process.exit(1);
}

const remoteUrl = new URL(remoteRaw);
if (process.env.TUNNEL_HOST) {
  remoteUrl.hostname = process.env.TUNNEL_HOST;
  remoteUrl.port = process.env.TUNNEL_PORT || "15432";
}

const remote = new pg.Pool({
  connectionString: remoteUrl.toString(),
  ssl: /rlwy\.net|railway\.app/i.test(remoteRaw)
    ? { rejectUnauthorized: false }
    : false,
  max: 1,
});
const local = new pg.Pool({ connectionString: localUrl, max: 1 });

async function main() {
  const users = await remote.query(`
    SELECT id, email, password_hash, plus, plus_until, plus_cancelled, created_at, updated_at
    FROM users ORDER BY id
  `);
  let purchases = { rows: [] };
  try {
    purchases = await remote.query(`
      SELECT user_id, email, provider, external_id, amount, currency, plus_until, email_sent_at, created_at
      FROM plus_purchases ORDER BY id
    `);
  } catch {
    /* table may not exist */
  }

  console.log(`[migrate] remote users=${users.rows.length} purchases=${purchases.rows.length}`);

  // Ensure local schema exists via a quick connect (auth-store will also create).
  await local.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      plus BOOLEAN NOT NULL DEFAULT FALSE,
      plus_until TIMESTAMPTZ NULL,
      plus_cancelled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS plus_purchases (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      amount TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'GBP',
      plus_until TIMESTAMPTZ NULL,
      email_sent_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, external_id)
    );
  `);

  for (const u of users.rows) {
    await local.query(
      `INSERT INTO users (id, email, password_hash, plus, plus_until, plus_cancelled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         plus = EXCLUDED.plus,
         plus_until = EXCLUDED.plus_until,
         plus_cancelled = EXCLUDED.plus_cancelled,
         updated_at = EXCLUDED.updated_at`,
      [
        u.id,
        u.email,
        u.password_hash,
        u.plus,
        u.plus_until,
        u.plus_cancelled ?? false,
        u.created_at,
        u.updated_at,
      ],
    );
  }
  await local.query(
    `SELECT setval(pg_get_serial_sequence('users','id'), COALESCE((SELECT MAX(id) FROM users), 1))`,
  );

  for (const p of purchases.rows) {
    await local.query(
      `INSERT INTO plus_purchases
        (user_id, email, provider, external_id, amount, currency, plus_until, email_sent_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (provider, external_id) DO NOTHING`,
      [
        p.user_id,
        p.email || "",
        p.provider,
        p.external_id,
        p.amount || "",
        p.currency || "GBP",
        p.plus_until,
        p.email_sent_at,
        p.created_at,
      ],
    );
  }

  const count = await local.query(`SELECT COUNT(*)::int AS n FROM users`);
  console.log(`[migrate] local users now=${count.rows[0].n}`);
}

main()
  .catch((error) => {
    console.error("[migrate] failed", error?.message || error);
    process.exit(1);
  })
  .finally(async () => {
    await remote.end();
    await local.end();
  });
