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

const CAMERA_IMAGE_BASE =
  "https://public.highwaystrafficcameras.co.uk/cctvpublicaccess/images/";
const ATTRIBUTION = "Camera imagery © National Highways (Crown copyright)";

/**
 * A coach this close to a camera is plausibly inside its frame. Tight on
 * purpose: motorway cameras are gantries over the carriageway, so a coach is
 * only reliably in shot within a couple of hundred metres. At 500m it is a
 * speck among other traffic, and a speck is not evidence of anything.
 */
const NEAR_M = 250;
/** Closer than this and the close-up is worth trusting. */
const CLOSE_M = 150;
/** Two frames this far apart, so a moving vehicle can be seen to move. */
const FRAME_GAP_MS = 12_000;
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
let dataDir = "";
let lastPruneAt = 0;
let cycles = 0;
let captureBusy = false;
let stopTimer = null;

function compactReg(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
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
 * Grab two frames a few seconds apart. One picture of a motorway cannot show
 * whether the coach we are tracking is the coach in it; two frames can, because
 * a vehicle in the frame will have moved between them. We still do not claim to
 * have identified it — the card says so — but this is evidence rather than a
 * picture of the same road.
 */
async function capture(reg, cam, takenAt) {
  const first = await fetchFrame(cam.id, takenAt);
  await sleep(FRAME_GAP_MS);
  let second = null;
  try {
    second = await fetchFrame(cam.id, takenAt + FRAME_GAP_MS);
  } catch {
    /* one good frame still beats none; the card will show what we have */
  }
  mkdirSync(snapshotDir(), { recursive: true });
  const snap = {
    reg,
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
  if (second) writeFileSync(regFile(reg, "b.jpg"), second);
  else {
    try {
      unlinkSync(regFile(reg, "b.jpg"));
    } catch {
      /* no stale second frame to remove */
    }
  }
  writeFileSync(regFile(reg, "json"), JSON.stringify(snap));
  snapshots.set(reg, snap);
  return snap;
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
    compactReg(vehicle?.vehicle?.name) ||
    compactReg(vehicle?._bods?.vehicleRef) ||
    ""
  );
}

async function pollCoaches(bodsKey, fetchVehicles) {
  const now = Date.now();
  pruneOldSnapshots(now);
  if (captureBusy || !cameras.length) return;

  let vehicles = [];
  for (const op of COACH_OPERATORS) {
    try {
      const out = await fetchVehicles(`operator=${op}`, bodsKey);
      const list = JSON.parse(out.body.toString("utf8"));
      if (Array.isArray(list)) vehicles.push(...list);
    } catch {
      /* one operator being unavailable must not stop the others */
    }
  }
  if (!vehicles.length) return;

  captureBusy = true;
  try {
    for (const vehicle of vehicles) {
      const coords = vehicle?.coordinates;
      const lat = Number(coords?.[1]);
      const lon = Number(coords?.[0]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const reg = coachRegOf(vehicle);
      if (!reg) continue;
      const near = nearestCameras(lat, lon, NEAR_M, 1);
      if (!near.length) {
        lastSeen.delete(reg);
        continue;
      }
      const cam = near[0];
      const prev = lastSeen.get(reg);
      lastSeen.set(reg, { cameraId: cam.id, distanceM: cam.distanceM, at: now });
      // A coach pulling away from the camera is already out of shot, so there is
      // nothing to see. Approaching, running alongside or stopped in a queue are
      // exactly the cases worth keeping.
      if (prev && prev.cameraId === cam.id && cam.distanceM > prev.distanceM + RECEDING_M) {
        continue;
      }
      const existing = snapshots.get(reg);
      if (existing && now - existing.takenAt < CAPTURE_INTERVAL_MS) continue;
      try {
        await capture(reg, cam, now);
        console.log(`[camera] ${reg} near ${cam.road} ${cam.desc} (${cam.distanceM}m)`);
      } catch (err) {
        console.warn(`[camera] ${reg} capture failed: ${err.message}`);
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
