/** Emergency disk recovery — prune GPS trails and reclaim Postgres space. */
import pg from "pg";

const url = String(process.env.DATABASE_URL || "").trim();
if (!url) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const days = Math.max(1, Number(process.env.PRUNE_DAYS) || 2);
const truncate = process.env.TRUNCATE_TRAILS === "1";
const pool = new pg.Pool({
  connectionString: url,
  ssl:
    process.env.DATABASE_SSL === "1" || /rlwy\.net|railway\.app|proxy/i.test(url)
      ? { rejectUnauthorized: false }
      : url.includes("railway.internal")
        ? false
        : undefined,
  max: 1,
});

async function main() {
  const client = await pool.connect();
  try {
    const before = await client.query(`
      SELECT
        pg_size_pretty(pg_database_size(current_database())) AS db_size,
        (SELECT COUNT(*)::bigint FROM vehicle_trail_points) AS trail_rows
    `);
    console.log("[prune] before", before.rows[0]);

    if (truncate) {
      await client.query("TRUNCATE vehicle_trail_points");
      console.log(`[prune] truncated vehicle_trail_points (was ${before.rows[0]?.trail_rows} rows)`);
    } else {
      const del = await client.query(
        `DELETE FROM vehicle_trail_points
         WHERE t < NOW() - ($1::text || ' days')::interval`,
        [String(days)],
      );
      console.log(`[prune] deleted ${del.rowCount || 0} trail points older than ${days}d`);

      const capped = await client.query(`
        WITH ranked AS (
          SELECT id,
                 row_number() OVER (PARTITION BY trail_key ORDER BY t DESC) AS rn
          FROM vehicle_trail_points
        )
        DELETE FROM vehicle_trail_points p
        USING ranked r
        WHERE p.id = r.id AND r.rn > 4000
      `);
      console.log(`[prune] capped oversized keys removed=${capped.rowCount || 0}`);
    }

    console.log("[prune] running VACUUM (may take a minute)…");
    try {
      await client.query("VACUUM (ANALYZE) vehicle_trail_points");
    } catch (error) {
      console.warn("[prune] vacuum skipped", error?.message || error);
    }

    const after = await client.query(`
      SELECT
        pg_size_pretty(pg_database_size(current_database())) AS db_size,
        (SELECT COUNT(*)::bigint FROM vehicle_trail_points) AS trail_rows
    `);
    console.log("[prune] after", after.rows[0]);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[prune] failed", error?.message || error);
  process.exit(1);
});
