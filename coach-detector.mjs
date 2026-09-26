/**
 * Coach detection for the National Highways camera frames.
 *
 * The user's requirement is blunt: only show a screenshot if a coach is actually
 * in it. Two cheaper attempts were tried and measured, and both failed honestly:
 *
 *  - Livery colour: grey tarmac (74,74,74) sits within any sane tolerance of
 *    National Express navy, so road surface scored an 80% "brand match" while a
 *    real white coach scored 0.25% white. Useless at 720x576.
 *  - Motion streak: a line of moving cars is just as elongated as a coach. It
 *    passed frames containing nothing but cars.
 *
 * So this runs a real detector. YOLOv10n is small enough to run on the VPS per
 * capture, and its COCO label set has "bus", which is what coaches are annotated
 * as. It answers "is a coach in this picture" - it still cannot answer "is it
 * the coach we are tracking", because there is no plate to read at this
 * resolution. Callers must not claim otherwise.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";

const MODEL_SIZE = 640;
/** The v6.0 YOLOv8n export takes float32 and has dynamic input dims. */
const DTYPE = "float32";
/** COCO label id for a bus - coaches are annotated as buses. */
const BUS_CLASS = 5;
const NUM_CLASSES = 80;
/** Below this the detector is guessing, and a guess is worse than nothing. */
const MIN_BUS_CONF = 0.4;

/** IEEE half precision, because the model wants it. */
const f32buf = new Float32Array(1);
const i32buf = new Int32Array(f32buf.buffer);
function toHalf(value) {
  f32buf[0] = value;
  const x = i32buf[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) {
    bits |= 0x7c00;
    bits |= (e === 255 ? 0 : 1) && x & 0x007fffff;
    return bits;
  }
  if (e < 113) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

let sessionPromise = null;
let unavailableReason = "";

function modelPath(dataDir) {
  return join(dataDir || process.cwd(), "models", "yolov8n.onnx");
}

async function getSession(dataDir) {
  if (unavailableReason) throw new Error(unavailableReason);
  if (!sessionPromise) {
    const file = modelPath(dataDir);
    if (!existsSync(file)) {
      unavailableReason = `detector model missing at ${file} - run scripts/fetch-detector.mjs`;
      throw new Error(unavailableReason);
    }
    sessionPromise = (async () => {
      const ort = await import("onnxruntime-node");
      return ort.InferenceSession.create(file, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      });
    })().catch((err) => {
      unavailableReason = `detector failed to load: ${err.message}`;
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

/** Letterbox to the model's input size, keeping the picture's own aspect. */
async function toTensor(buffer) {
  const image = sharp(buffer).rotate();
  const meta = await image.metadata();
  // sharp does the letterboxing, so the mapping back out is a plain scale.
  const scale = Math.min(MODEL_SIZE / meta.width, MODEL_SIZE / meta.height);
  const uchar = await image
    .resize(MODEL_SIZE, MODEL_SIZE, {
      fit: "contain",
      background: { r: 114, g: 114, b: 114 },
      kernel: "cubic",
    })
    .removeAlpha()
    .raw()
    .toBuffer();
  const data = new Float32Array(MODEL_SIZE * MODEL_SIZE * 3);
  for (let i = 0, j = 0; i < uchar.length && j < data.length; i += 1, j += 1) {
    data[j] = uchar[i] / 255;
  }
  return { data, meta, scale };
}

function boxesFromOutput(output, tensor) {
  /*
   * YOLOv8 head: [1, 4 + nc, anchors] as (x, y, w, h) then one score per class.
   * There is no separate objectness channel - reading one is what made an
   * earlier attempt score every anchor as a bus. The export applies sigmoid, but
   * guard anyway so an unsigmoided build cannot produce nonsense.
   */
  const data = output.data;
  if (!data) return { found: [] };
  const [batch, ch, anchors] = output.dims.length === 3 ? output.dims : [1, 84, 0];
  const nAnchor = anchors || Math.floor(data.length / (4 + NUM_CLASSES));
  const nc = Math.min(NUM_CLASSES, ch - 4);
  const found = [];
  const raw = (v) => (v > 1 || v < 0 ? 1 / (1 + Math.exp(-v)) : v);
  for (let i = 0; i < nAnchor; i += 1) {
    let best = 0;
    let cls = -1;
    for (let c = 0; c < nc; c += 1) {
      const v = raw(data[(4 + c) * nAnchor + i]);
      if (v > best) {
        best = v;
        cls = c;
      }
    }
    if (cls !== BUS_CLASS) continue;
    if (!(best >= MIN_BUS_CONF)) continue;
    const cx = data[i] / tensor.scale;
    const cy = data[nAnchor + i] / tensor.scale;
    const bw = data[2 * nAnchor + i] / tensor.scale;
    const bh = data[3 * nAnchor + i] / tensor.scale;
    found.push({
      score: Number(best.toFixed(3)),
      box: [
        Math.max(0, Math.round(cx - bw / 2)),
        Math.max(0, Math.round(cy - bh / 2)),
        Math.min(tensor.meta.width, Math.round(cx + bw / 2)),
        Math.min(tensor.meta.height, Math.round(cy + bh / 2)),
      ],
    });
  }
  found.sort((a, b) => b.score - a.score);
  return { found, batch };
}

/**
 * Look for a coach in one camera frame.
 * Returns { found, score, box, boxes, skipped } - never throws.
 */
export async function detectCoach(jpegBuffer, { dataDir } = {}) {
  try {
    const session = await getSession(dataDir);
    const tensor = await toTensor(jpegBuffer);
    const inputName = session.inputNames[0];
    const feeds = { [inputName]: new ortTensor(tensor) };
    const results = await session.run(feeds);
    const out = results[Object.keys(results)[0]];
    const { found } = boxesFromOutput(out, tensor) || { found: [] };
    const best = found[0] || null;
    return {
      found: Boolean(best),
      score: best?.score ?? 0,
      box: best?.box ?? null,
      boxes: found.slice(0, 4),
    };
  } catch (err) {
    return { found: false, score: 0, box: null, boxes: [], skipped: err.message };
  }
}

let ortModule = null;
function ortTensor(tensor) {
  if (!ortModule) throw new Error("runtime not initialised");
  return new ortModule.Tensor(DTYPE, tensor.data, [1, 3, MODEL_SIZE, MODEL_SIZE]);
}

// onnxruntime-node is loaded lazily inside getSession; keep a reference for
// building tensors without importing it twice.
export async function primeDetector(dataDir) {
  const session = await getSession(dataDir);
  ortModule = await import("onnxruntime-node");
  return Boolean(session);
}

export function detectorStatus() {
  return { available: !unavailableReason, reason: unavailableReason, minConf: MIN_BUS_CONF };
}

export function ensureModelDir(dataDir) {
  const dir = dirname(modelPath(dataDir));
  mkdirSync(dir, { recursive: true });
  return dir;
}


