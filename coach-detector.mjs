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
/** COCO label ids we treat as "this could be a coach". */
const BUS_CLASSES = new Set([5]); // bus (coaches are labelled bus in COCO)
/** Below this the detector is guessing, and a guess is worse than nothing. */
const MIN_BUS_CONF = 0.35;

let sessionPromise = null;
let unavailableReason = "";

function modelPath(dataDir) {
  return join(dataDir || process.cwd(), "models", "yolov10n.onnx");
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
      background: { r: 0, g: 0, b: 0 },
      kernel: "cubic",
    })
    .removeAlpha()
    .raw()
    .toBuffer();
  const data = new Float32Array(MODEL_SIZE * MODEL_SIZE * 3);
  for (let i = 0; i < uchar.length && i < data.length; i += 1) data[i] = uchar[i];
  return { data, meta, scale };
}

function boxesFromOutput(output, tensor) {
  // YOLOv10 output rows are (x1, y1, x2, y2, score, class) in model pixels.
  const data = output.data;
  if (!data) return { found: [] };
  const rows = Math.floor(data.length / 6);
  const found = [];
  for (let i = 0; i < rows; i += 1) {
    const o = i * 6;
    const score = data[o + 4];
    const cls = Math.round(data[o + 5]);
    if (!(score >= MIN_BUS_CONF) || !BUS_CLASSES.has(cls)) continue;
    const x1 = data[o] / tensor.scale;
    const y1 = data[o + 1] / tensor.scale;
    const x2 = data[o + 2] / tensor.scale;
    const y2 = data[o + 3] / tensor.scale;
    found.push({
      score: Number(score.toFixed(3)),
      box: [
        Math.max(0, Math.round(x1)),
        Math.max(0, Math.round(y1)),
        Math.min(tensor.meta.width, Math.round(x2)),
        Math.min(tensor.meta.height, Math.round(y2)),
      ],
    });
  }
  found.sort((a, b) => b.score - a.score);
  return { found };
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
  return new ortModule.Tensor("float32", tensor.data, [1, 3, MODEL_SIZE, MODEL_SIZE]);
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
