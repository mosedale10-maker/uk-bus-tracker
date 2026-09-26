/**
 * National Highways camera snapshots for coaches.
 *
 * When a tracked coach (National Express, FlixBus) passes a National Highways
 * camera, the picture from that camera at that moment is the only independent
 * look at the vehicle we will ever get: our own data stops at the last GPS fix,
 * and on a motorway there are no stops to give a fresh one. This module watches
 * live coach positions, and when one comes within camera range it grabs that
 * camera's current image and keeps it with the bus card.
 *
 * Deliberate limits:
 *  - We do not try to identify the vehicle in the picture. Nothing here claims
 *    the coach in frame is the coach we tracked; it is the camera nearest the
 *    tracked position at the time, with the distance recorded, so the card can
 *    say honestly how close it was.
 *  - One capture per coach per CAPTURE_INTERVAL_MS, so a coach sitting at a
 *    camera does not hammer someone else's public service.
 *  - Images are Crown copyright, National Highways. Every copy carries the
 *    attribution string and expires; nothing is archived long term.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";

const CAMERA_IMAGE_BASE =
  "https://public.highwaystrafficcameras.co.uk/cctvpublicaccess/images/";
const ATTRIBUTION = "Camera imagery © National Highways (Crown copyright)";

/**
 * How close a coach must be to a camera before we photograph it.
 *
 * Cut from 250m to 120m deliberately. At 250m a coach is roughly 50px long in a
 * 720x576 frame among dense motorway traffic, and the detector found a coach in
 * none of the 20 M6 captures taken at that range - volume without information.
 * At 120m a coach is big enough to be recognised, which is what makes "coach
 * detected" on the card worth something. Fewer photographs, each one worth
 * having. Applies to every road, not just the M6: the limit is about how big a
 * coach is in the picture, not about which road it is on.
 */
const NEAR_M = 120;
/** Closer than this and the close-up is worth trusting. */
const CLOSE_M = 150;
/**
 * Two frames this far apart. The camera publishes a new picture roughly every
 * 30 seconds, so anything shorter compares a frame with itself: in stopped or
 * slow traffic nothing appears to move and every shot gets thrown out as "no
 * motion". Thirty seconds is also long enough for a coach at 60mph to cover
 * 500m, which is what makes the movement check work at all.
 */
const FRAME_GAP_MS = 0;
/** Ignore a coach that is clearly driving away from the camera. */
const RECEDING_M = 30;
/** Never re-capture the same coach more often than this. */
const CAPTURE_INTERVAL_MS = 5 * 60 * 1000;
/** Snapshots older than this are deleted rather than shown. */
const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Coaches are polled for live positions on this cadence. */
const POLL_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const PRUNE_EVERY = 40;

const COACH_OPERATORS = ["NATX", "FLIX"];

/**
 * FlixBus is not in the BODS feed at all - it arrives on our own bustimes proxy
 * as `bustimes-flix`, and those vehicles carry no registration, only a journey
 * id. So a coach here is keyed by id, and the card is labelled with the service
 * and destination instead of a plate.
 */
const FLIX_FEED_URL = `http://127.0.0.1:${process.env.PORT || 4173}/api/vehicles?operator=FLIX`;

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

let cameras = [];
let cameraReady = false;
/** reg -> { reg, cameraId, road, desc, lat, lon, distanceM, takenAt } */
const snapshots = new Map();
/** reg -> { cameraId, distanceM, at } from the previous poll, to spot a coach
 *  driving away from the camera rather than towards or past it. */
const lastSeen = new Map();
/** cameraId -> when we next try it, after it served an "unavailable" card. */
const deadCameras = new Map();
/** How long a camera that is offline is left alone. */
const CAMERA_RETRY_MS = 30 * 60 * 1000;
let dataDir = "";
let lastPruneAt = 0;
let cycles = 0;
let captureBusy = false;
let stopTimer = null;

function compactReg(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
}

/** Read the committed camera list once; it only changes on a deliberate refresh. */
export function loadCameraLocations(url) {
  if (cameraReady) return cameras.length;
  const target = url || new URL("./camera-locations.generated.json", import.meta.url);
  const raw = JSON.parse(readFileSync(target, "utf8"));
  cameras = (raw.cameras || []).map((c) => ({
    id: String(c.id),
    road: String(c.road || ""),
    desc: String(c.desc || ""),
    lat: Number(c.lat),
    lon: Number(c.lon),
  }));
  cameraReady = true;
  return cameras.length;
}

export function cameraCount() {
  return cameras.length;
}

/** Closest cameras to a point, nearest first. 2,823 entries is cheap to scan. */
export function nearestCameras(lat, lon, radiusM = NEAR_M, limit = 3) {
  if (!cameraReady) loadCameraLocations();
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const out = [];
  for (const cam of cameras) {
    const d = haversineM(lat, lon, cam.lat, cam.lon);
    if (d <= radiusM) out.push({ ...cam, distanceM: Math.round(d) });
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out.slice(0, limit);
}

function snapshotDir() {
  return join(dataDir, "camera-snapshots");
}

function regFile(reg, ext) {
  // compactReg leaves only [A-Z0-9], so this cannot escape the directory.
  return join(snapshotDir(), `${reg}.${ext}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pull the current image for a camera, or null if it will not serve one. */
async function fetchFrame(camId, takenAt) {
  const res = await fetch(`${CAMERA_IMAGE_BASE}${camId}.jpg?sid=${takenAt}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "image/jpeg,image/*" },
  });
  if (!res.ok) throw new Error(`camera ${camId} -> ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error(`camera ${camId} not an image`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error("camera image size");
  /*
   * Some cameras serve a "CAMERA UNAVAILABLE" placeholder - a small pale-blue
   * card with a red cross - instead of a view. Storing one of those produced
   * frames with a single detected "object" and no coach, every time, and the
   * FlixBus captures were almost all placeholders. Real frames are 720x576.
   */
  const meta = await sharp(buf).metadata().catch(() => null);
  const w = meta?.width || 0;
  const h = meta?.height || 0;
  if (w < 640 || h < 480) {
    const err = new Error(`camera ${camId} unavailable (${w}x${h})`);
    err.unavailable = true;
    throw err;
  }
  return buf;
}

function pruneOldSnapshots(now) {
  if (now - lastPruneAt < PRUNE_EVERY * POLL_MS) return;
  lastPruneAt = now;
  let names = [];
  try {
    names = readdirSync(snapshotDir());
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(snapshotDir(), name);
    const age = now - (snapshots.get(name.replace(/\.(jpg|json)$/, ""))?.takenAt || 0);
    if (age > SNAPSHOT_MAX_AGE_MS) {
      try {
        unlinkSync(full);
      } catch {
        /* already gone */
      }
    }
  }
  for (const [reg, snap] of snapshots) {
    if (now - snap.takenAt > SNAPSHOT_MAX_AGE_MS) {
      snapshots.delete(reg);
      for (const ext of ["jpg", "json"]) {
        try {
          unlinkSync(regFile(reg, ext));
        } catch {
          /* already gone */
        }
      }
    }
  }
}

/** The stored snapshot for a registration, or null if there isn't a fresh one. */
export function cameraSnapshotFor(reg, now = Date.now()) {
  const key = compactReg(reg);
  if (!key) return null;
  const snap = snapshots.get(key);
  if (!snap) return null;
  if (now - snap.takenAt > SNAPSHOT_MAX_AGE_MS) return null;
  return snap;
}

/**
 * Grab the camera's current frame.
 *
 * This used to take two frames 30s apart so a motion diff could show that a
 * vehicle had moved. Real detection replaced that test, and keeping the pair
 * cost 30 seconds of sleep per capture - long enough that a poll with dozens of
 * coaches in range never got past the first of them, so the FlixBus coaches at
 * the end of the list were never photographed at all.
 */
async function capture(reg, cam, takenAt, vehicle = {}) {
  const first = await fetchFrame(cam.id, takenAt);
  mkdirSync(snapshotDir(), { recursive: true });
  const noc = String(
    vehicle?.operator?.noc || vehicle?.service?.operator?.noc || vehicle?.operator?.id || "",
  )
    .trim()
    .toUpperCase();
  const snap = {
    reg,
    // FlixBus vehicles arrive from bustimes with no plate, only a journey id, so
    // the key is an id and the card is labelled with the service instead.
    plate: coachRegOf(vehicle) || "",
    label: coachLabelOf(vehicle, reg),
    // Which operator this coach belongs to. The camera frames themselves are
    // operator-agnostic - the detector only finds "a bus" - so without this the
    // card cannot say whether it photographed a FlixBus or National Express one.
    operator: noc,
    operatorLabel: noc === "FLIX" ? "FlixBus" : noc === "NATX" ? "National Express" : noc,
    cameraId: cam.id,
    road: cam.road,
    desc: cam.desc,
    lat: cam.lat,
    lon: cam.lon,
    distanceM: cam.distanceM,
    takenAt,
    frameGapMs: FRAME_GAP_MS,
    // How near the coach was when the frames were taken. Inside CLOSE_M the
    // coach is filling a gantry shot; beyond it we only know it was on the road
    // somewhere near the camera.
    confidence: cam.distanceM <= CLOSE_M ? "close" : "near",
    // Nothing here identifies the vehicle, and the card must not imply it does.
    identified: false,
    attribution: ATTRIBUTION,
  };
  writeFileSync(regFile(reg, "jpg"), first);
  try {
    // Clear any second frame left over from when we captured pairs.
    unlinkSync(regFile(reg, "b.jpg"));
  } catch {
    /* there was none */
  }
  writeFileSync(regFile(reg, "json"), JSON.stringify(snap));
  snapshots.set(reg, snap);
  return snap;
}

/**
 * Ask the Python verifier whether a coach is actually in the frames.
 *
 * Detection deliberately does not live here: reproducing the model's expected
 * input by hand in JavaScript produced either nothing at all or a flood of false
 * positives across four attempts, because the letterbox and normalisation
 * details are easy to get subtly wrong. The verifier runs ultralytics' own
 * predict(), which knows its own preprocessing, and writes verdicts back into the
 * sidecars.
 *
 * All the keys from one poll go in a single call. Loading the model costs a few
 * seconds, so doing it per capture made a poll with 90 coaches in range take
 * nine minutes - long enough that the FlixBus coaches at the end of the list
 * were never reached at all.
 */
function verifyBatch(keys) {
  if (!keys.length) return Promise.resolve(false);
  return new Promise((resolve) => {
    const script = join(import.meta.dirname || ".", "scripts", "verify-coaches.py");
    const python = process.env.CAMERA_VERIFY_PY || "/opt/ukb-venv/bin/python";
    let child;
    try {
      child = spawn(python, [script, "--keys", keys.join(",")], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 600_000,
      });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(true));
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(false);
    }, 620_000);
  });
}

/** Reuse an existing snapshot's timer so a restart cannot re-capture instantly. */
function seedTimersFromDisk() {
  let names = [];
  try {
    names = readdirSync(snapshotDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const reg = name.replace(/\.json$/, "");
    try {
      const snap = JSON.parse(readFileSync(join(snapshotDir(), name), "utf8"));
      if (snap?.reg === reg && Number.isFinite(snap.takenAt)) snapshots.set(reg, snap);
    } catch {
      /* ignore a half-written sidecar */
    }
  }
}

function coachRegOf(vehicle) {
  return (
    compactReg(vehicle?.vehicle?.reg) ||
    compactReg(vehicle?._bods?.vehicleRef) ||
    // bustimes-flix sets vehicle.name to the brand, not a plate, so never use it.
    ""
  );
}

/** Stable key for a coach: the plate when we have one, else the journey id. */
function coachKeyOf(vehicle) {
  const reg = coachRegOf(vehicle);
  if (reg) return reg;
  const id = String(vehicle?.id ?? vehicle?.journey_id ?? "")
    .trim()
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 16);
  return id ? `F${id}` : "";
}

/** Something a person can read on the card when there is no plate. */
function coachLabelOf(vehicle, key) {
  const op = String(vehicle?.operator?.noc || vehicle?.service?.operator?.noc || "").toUpperCase();
  const brand = op === "FLIX" ? "FlixBus" : op === "NATX" ? "National Express" : op || "Coach";
  const line = String(vehicle?.service?.line_name || "").trim();
  const dest = String(vehicle?.destination || "").trim();
  const bits = [brand, line, dest].filter(Boolean).join(" ");
  return bits || key;
}

async function fetchFlixVehicles() {
  const res = await fetch(FLIX_FEED_URL, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function pollCoaches(bodsKey, fetchVehicles) {
  const now = Date.now();
  pruneOldSnapshots(now);
  if (captureBusy || !cameras.length) return;

  let vehicles = [];
  for (const op of COACH_OPERATORS) {
    try {
      // FlixBus is not in BODS at all; it arrives via our bustimes proxy.
      if (op === "FLIX") {
        const flix = await fetchFlixVehicles();
        if (flix.length) vehicles.push(...flix);
        continue;
      }
      const out = await fetchVehicles(`operator=${op}`, bodsKey);
      const list = JSON.parse(out.body.toString("utf8"));
      if (Array.isArray(list)) vehicles.push(...list);
    } catch (err) {
      // Swallowing this is how a whole operator silently stopped being watched.
      console.warn(`[camera] ${op} feed failed: ${err.message}`);
    }
  }
  if (!vehicles.length) return;
  const flixCount = vehicles.filter((v) =>
    String(v?.operator?.noc || "").toUpperCase() === "FLIX",
  ).length;

  captureBusy = true;
  const captured = [];
  try {
    if (process.env.CAMERA_DEBUG) {
      console.log(
        `[camera] poll: ${vehicles.length} coaches (${flixCount} FlixBus), ` +
          `in range ${vehicles.filter((v) => Array.isArray(v?.coordinates) && nearestCameras(Number(v.coordinates[1]), Number(v.coordinates[0]), NEAR_M, 1).length).length}`,
      );
    }
    for (const vehicle of vehicles) {
      const coords = vehicle?.coordinates;
      const lat = Number(coords?.[1]);
      const lon = Number(coords?.[0]);
      const isFlix = String(vehicle?.operator?.noc || "").toUpperCase() === "FLIX";
      const trace = (why) => {
        if (isFlix && process.env.CAMERA_DEBUG) {
          console.log(`[camera] flix ${coachKeyOf(vehicle) || "nokey"}: ${why}`);
        }
      };
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        trace("no position");
        continue;
      }
      const reg = coachKeyOf(vehicle);
      if (!reg) {
        trace("no usable key");
        continue;
      }
      const near = nearestCameras(lat, lon, NEAR_M, 1);
      if (!near.length) {
        lastSeen.delete(reg);
        trace("no camera within range");
        continue;
      }
      const cam = near[0];
      // A camera that served an "unavailable" card recently is skipped for a
      // while, so we do not keep fetching a dead feed for every coach near it.
      const deadUntil = deadCameras.get(cam.id) || 0;
      if (deadUntil > now) {
        trace(`camera ${cam.id} offline`);
        continue;
      }
      const prev = lastSeen.get(reg);
      lastSeen.set(reg, { cameraId: cam.id, distanceM: cam.distanceM, at: now });
      // A coach pulling away from the camera is already out of shot, so there is
      // nothing to see. Approaching, running alongside or stopped in a queue are
      // exactly the cases worth keeping.
      if (prev && prev.cameraId === cam.id && cam.distanceM > prev.distanceM + RECEDING_M) {
        trace(`receding from ${cam.road} ${cam.desc} (${prev.distanceM}m -> ${cam.distanceM}m)`);
        continue;
      }
      const existing = snapshots.get(reg);
      if (existing && now - existing.takenAt < CAPTURE_INTERVAL_MS) {
        trace(`on cooldown, captured ${Math.round((now - existing.takenAt) / 1000)}s ago`);
        continue;
      }
      try {
        await capture(reg, cam, now, vehicle);
        captured.push({ reg, cam });
      } catch (err) {
        if (err?.unavailable) {
          // This camera is offline. Remember it so we stop asking every poll.
          deadCameras.set(cam.id, Date.now() + CAMERA_RETRY_MS);
          if (process.env.CAMERA_DEBUG) {
            console.log(`[camera] ${cam.road} ${cam.desc} (${cam.id}) offline, skipping`);
          }
          continue;
        }
        console.warn(`[camera] ${reg} capture failed: ${err.message}`);
      }
    }

    // One model load for everything captured this poll, then report.
    if (captured.length) {
      const ran = await verifyBatch(captured.map((c) => c.reg));
      for (const { reg, cam } of captured) {
        let fresh = null;
        try {
          fresh = JSON.parse(readFileSync(regFile(reg, "json"), "utf8"));
        } catch {
          fresh = null;
        }
        if (fresh) snapshots.set(reg, fresh);
        if (fresh?.busDetected) {
          console.log(
            `[camera] COACH SEEN ${fresh.label || reg} (${fresh.plate || reg}) at ${cam.road} ${cam.desc} ` +
              `(${cam.distanceM}m) confidence ${fresh.busConfidence}`,
          );
        } else if (ran) {
          console.log(
            `[camera] ${fresh?.label || reg} near ${cam.road} ${cam.desc} (${cam.distanceM}m) - no coach in view`,
          );
        } else {
          console.warn(`[camera] verifier unavailable for ${captured.length} captures`);
        }
      }
    }
  } finally {
    captureBusy = false;
  }
}

/**
 * Start watching. `fetchVehicles` is the BODS vehicles fetcher, injected so this
 * module does not need to know how the feed is cached or authenticated.
 */
export function startCameraWatcher({ bodsKey, fetchVehicles, dataDir: dir, logger = console }) {
  if (stopTimer) return;
  dataDir = dir || dataDir;
  if (!dataDir) throw new Error("startCameraWatcher needs a dataDir");
  loadCameraLocations();
  seedTimersFromDisk();
  const tick = () => {
    pollCoaches(bodsKey, fetchVehicles).catch((err) => {
      logger.warn?.(`[camera] poll failed: ${err.message}`);
    });
  };
  tick();
  stopTimer = setInterval(tick, POLL_MS);
  stopTimer.unref?.();
  return stopTimer;
}

export function stopCameraWatcher() {
  if (stopTimer) clearInterval(stopTimer);
  stopTimer = null;
}

export { ATTRIBUTION as CAMERA_ATTRIBUTION, COACH_OPERATORS };

