/** Run GPS trail store + recorder on this PC (SQLite under ./data/trails).
 * Railway proxies /api/trails* here via TRAIL_REMOTE_URL.
 */
import express from "express";
import {
  initTrailStore,
  trailsEnabled,
  appendTrailPoints,
  getTrailPoints,
  getTrailsForKeys,
  listTrailKeysForLines,
  listTrailKeysForOperators,
  startTrailPrunePoller,
  pruneOldTrailPoints,
  TRAIL_KEEP_DAYS,
} from "../trail-store.mjs";
import { startTrailRecorder } from "../trail-recorder.mjs";

const port = Number(process.env.TRAIL_PC_PORT || 8787);
const bodsKey = process.env.BODS_API_KEY || "";
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, trails: trailsEnabled(), days: TRAIL_KEEP_DAYS, host: "pc" });
});

app.get("/api/trails", async (req, res) => {
  try {
    await initTrailStore();
    if (!trailsEnabled()) {
      res.json({ ok: false, days: TRAIL_KEEP_DAYS, trails: {}, error: "no-store" });
      return;
    }
    const keys = String(req.query.keys || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    const days = Math.min(TRAIL_KEEP_DAYS, Math.max(1, Number(req.query.days) || TRAIL_KEEP_DAYS));
    const fromMs = Number(req.query.from) || 0;
    const toMs = Number(req.query.to) || 0;
    if (!keys.length) {
      const key = String(req.query.key || "").trim();
      if (!key) {
        res.status(400).json({ ok: false, error: "missing_keys" });
        return;
      }
      const points = await getTrailPoints(key, { fromMs, toMs, days });
      res.json({ ok: true, days: TRAIL_KEEP_DAYS, trails: { [key]: points } });
      return;
    }
    const trails = await getTrailsForKeys(keys, { fromMs, toMs, days });
    res.json({ ok: true, days: TRAIL_KEEP_DAYS, trails });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "trails_failed" });
  }
});

app.get("/api/trails/keys", async (req, res) => {
  try {
    await initTrailStore();
    if (!trailsEnabled()) {
      res.json({ ok: false, days: TRAIL_KEEP_DAYS, keys: [], error: "no-store" });
      return;
    }
    const lines = String(req.query.lines || "")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    const operators = String(req.query.operators || "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    if (!lines.length && !operators.length) {
      res.status(400).json({ ok: false, error: "missing_lines_or_operators" });
      return;
    }
    const days = Math.min(TRAIL_KEEP_DAYS, Math.max(1, Number(req.query.days) || TRAIL_KEEP_DAYS));
    const limit = Number(req.query.limit) || 40;
    const byLine = lines.length ? await listTrailKeysForLines(lines, { days, limit }) : [];
    const byOp = operators.length
      ? await listTrailKeysForOperators(operators, { days, limit })
      : [];
    const seen = new Set();
    const keys = [];
    for (const row of [...byOp, ...byLine]) {
      const key = String(row?.key || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(row);
      if (keys.length >= Math.min(80, Math.max(4, limit))) break;
    }
    res.json({ ok: true, days: TRAIL_KEEP_DAYS, keys });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "trail_keys_failed" });
  }
});

app.post("/api/trails/points", async (req, res) => {
  try {
    await initTrailStore();
    if (!trailsEnabled()) {
      res.json({ ok: false, error: "no-store" });
      return;
    }
    const body = req.body || {};
    const batches = Array.isArray(body.batches)
      ? body.batches
      : body.key
        ? [{ key: body.key, points: body.points }]
        : [];
    if (!batches.length) {
      res.status(400).json({ ok: false, error: "missing_points" });
      return;
    }
    let inserted = 0;
    for (const batch of batches.slice(0, 8)) {
      const result = await appendTrailPoints(batch.key, batch.points);
      if (result.ok) inserted += result.inserted || 0;
    }
    res.json({ ok: true, inserted, days: TRAIL_KEEP_DAYS });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "trail_write_failed" });
  }
});

await initTrailStore();
startTrailPrunePoller();
await pruneOldTrailPoints({ force: true }).catch(() => {});
startTrailRecorder({ bodsKey });

app.listen(port, "0.0.0.0", () => {
  console.log(`[trails-pc] listening on http://127.0.0.1:${port}`);
  console.log(`[trails-pc] data dir: ${process.env.TRAIL_DATA_DIR || "./data/trails"}`);
  console.log(`[trails-pc] keep Railway TRAIL_REMOTE_URL pointed at this host (via tunnel)`);
});
