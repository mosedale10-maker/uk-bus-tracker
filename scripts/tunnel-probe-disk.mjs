/** Probe which queries work on a full Postgres volume. */
import pg from "pg";

const raw = String(process.env.DATABASE_URL || "").trim();
const u = new URL(raw);
u.hostname = process.env.TUNNEL_HOST || "127.0.0.1";
u.port = process.env.TUNNEL_PORT || "15432";

const pool = new pg.Pool({ connectionString: u.toString(), ssl: false, max: 1 });
const client = await pool.connect();

async function tryQ(label, sql) {
  try {
    const r = await client.query(sql);
    console.log("OK", label, r.rows?.[0] || r.command || r.rowCount);
  } catch (e) {
    console.log("FAIL", label, e.message);
  }
}

await tryQ("select1", "SELECT 1 AS n");
await tryQ("version", "SELECT version()");
await tryQ("drop_index", "DROP INDEX IF EXISTS vehicle_trail_points_line_t_idx");
await tryQ("drop_index2", "DROP INDEX IF EXISTS vehicle_trail_points_operator_t_idx");
await tryQ("drop_index3", "DROP INDEX IF EXISTS vehicle_trail_points_t_idx");
await tryQ("truncate", "TRUNCATE vehicle_trail_points");

client.release();
await pool.end();
