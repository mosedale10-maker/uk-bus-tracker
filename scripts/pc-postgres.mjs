/** Start free local Postgres (embedded) for Plus/auth/photos/notices. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const databaseDir = path.join(root, "data", "pg");
const port = Number(process.env.PC_PG_PORT || 54329);
const user = "postgres";
const password = String(process.env.PC_PG_PASSWORD || "ukbus-local");
const database = "ukbus";

fs.mkdirSync(databaseDir, { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir,
  user,
  password,
  port,
  persistent: true,
});

const alreadyInit = fs.existsSync(path.join(databaseDir, "PG_VERSION"));
if (!alreadyInit) {
  console.log("[pc-pg] initialising cluster in", databaseDir);
  await pg.initialise();
}

console.log("[pc-pg] starting on port", port);
await pg.start();

try {
  await pg.createDatabase(database);
  console.log("[pc-pg] created database", database);
} catch (error) {
  const msg = String(error?.message || error);
  if (!/already exists/i.test(msg)) {
    console.warn("[pc-pg] createDatabase:", msg);
  }
}

const url = `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
const out = path.join(root, "data", "pc-database.url");
fs.writeFileSync(out, url, "utf8");
console.log("[pc-pg] DATABASE_URL written to data/pc-database.url");
console.log("[pc-pg] ready — leave this process running");

const stop = async () => {
  try {
    await pg.stop();
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Keep alive
await new Promise(() => {});
