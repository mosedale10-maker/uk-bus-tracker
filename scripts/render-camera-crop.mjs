/**
 * Render the close-up the bus card shows, so it can be looked at directly.
 * Mirrors cameraCoachCrop() in src/main.js: expand the detected box, keep the
 * frame's aspect, and draw the box so a wrong detection is obvious.
 *
 * Run: node scripts/render-camera-crop.mjs <frame.jpg> <out.jpg> x1,y1,x2,y2
 */
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const [, , inFile, outFile, boxArg] = process.argv;
if (!inFile || !outFile || !boxArg) {
  console.error("usage: node scripts/render-camera-crop.mjs <in.jpg> <out.jpg> x1,y1,x2,y2");
  process.exit(1);
}
const [bx1, by1, bx2, by2] = boxArg.split(",").map(Number);

const image = sharp(readFileSync(inFile));
const meta = await image.metadata();
const W = meta.width;
const H = meta.height;
const aspect = W / H;

const bw = Math.max(24, bx2 - bx1);
const bh = Math.max(24, by2 - by1);
const cx = (bx1 + bx2) / 2;
const cy = (by1 + by2) / 2;
let w = bw * 2.6;
let h = bh * 2.6;
if (w / h < aspect) w = h * aspect;
else h = w / aspect;
w = Math.min(w, W);
h = Math.min(h, H);
const left = Math.max(0, Math.min(W - w, cx - w / 2));
const top = Math.max(0, Math.min(H - h, cy - h / 2));

const scale = Math.min(2.4, 640 / w);
const outW = Math.round(Math.max(260, w * scale));
const outH = Math.round(Math.max(190, h * scale));

const lineWidth = Math.max(2, Math.round(outW / 220));
const rect = Buffer.from(
  `<svg width="${outW}" height="${outH}">
     <rect x="${(bx1 - left) * scale}" y="${(by1 - top) * scale}"
           width="${bw * scale}" height="${bh * scale}"
           fill="none" stroke="#22c55e" stroke-width="${lineWidth}"/>
   </svg>`,
);

await image
  .extract({ left: Math.round(left), top: Math.round(top), width: Math.round(w), height: Math.round(h) })
  .resize(outW, outH, { kernel: "cubic" })
  .composite([{ input: rect, top: 0, left: 0 }])
  .jpeg({ quality: 88 })
  .toFile(outFile);

console.log(
  `frame ${W}x${H} | box ${bx1},${by1},${bx2},${by2} | crop ${Math.round(w)}x${Math.round(h)} -> ${outW}x${outH}`,
);
