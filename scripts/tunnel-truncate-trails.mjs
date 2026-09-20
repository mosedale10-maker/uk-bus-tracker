/** Connect via local railway tunnel (127.0.0.1) and truncate trails. */
import pg from "pg";

const raw = String(process.env.DATABASE_URL || "").trim();
if (!raw) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const u = new URL(raw);
u.hostname = process.env.TUNNEL_HOST || "127.0.0.1";
u.port = process.env.TUNNEL_PORT || "15432";
const url = u.toString();

const pool = new pg.Pool({
  connectionString: url,
  ssl: false,
  max: 1,
});

async function main() {
  const client = await pool.connect();
  try {
    console.log("[prune] connected via tunnel, truncating vehicle_trail_points…");
    await client.query("TRUNCATE vehicle_trail_points");
    console.log("[prune] truncated");
    try {
      await client.query("VACUUM (ANALYZE) vehicle_trail_points");
      console.log("[prune] vacuum ok");
    } catch (error) {
      console.warn("[prune] vacuum skipped", error?.message || error);
    }
    try {
      const after = await client.query(`
        SELECT
          pg_size_pretty(pg_database_size(current_database())) AS db_size,
          (SELECT COUNT(*)::bigint FROM vehicle_trail_points) AS trail_rows
      `);
      console.log("[prune] after", after.rows[0]);
    } catch (error) {
      console.warn("[prune] size check skipped", error?.message || error);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[prune] failed", error?.message || error);
  process.exit(1);
});
