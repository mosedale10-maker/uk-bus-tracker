import pg from "pg";

const raw = String(process.env.DATABASE_URL || "").trim();
const u = new URL(raw);
u.hostname = process.env.TUNNEL_HOST || "127.0.0.1";
u.port = process.env.TUNNEL_PORT || "15433";

const pool = new pg.Pool({ connectionString: u.toString(), ssl: false, max: 1 });
const client = await pool.connect();
try {
  for (const q of [
    "SELECT 1 AS ok",
    "DROP TABLE IF EXISTS vehicle_trail_points CASCADE",
    "DROP TABLE IF EXISTS trail_direction_migrations CASCADE",
    "VACUUM",
    "SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size",
    "SELECT COUNT(*)::int AS users FROM users",
  ]) {
    try {
      const r = await client.query(q);
      console.log("OK", q.slice(0, 60), r.rows?.[0] || r.command);
    } catch (e) {
      console.log("FAIL", q.slice(0, 60), e.message);
    }
  }
} finally {
  client.release();
  await pool.end();
}
