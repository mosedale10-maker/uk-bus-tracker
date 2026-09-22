/**
 * Sync per-vehicle marker paint from trainbasher.com First Potteries photos.
 * Usage: node scripts/sync-trainbasher-liveries.mjs
 *
 * Writes: src/photo-liveries.generated.js
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outFile = path.join(root, "src", "photo-liveries.generated.js");

const CATEGORY_URLS = [
  "https://trainbasher.com/category/region-wm/fpot/",
  "https://trainbasher.com/category/region-wm/fpot/page/2/",
  "https://trainbasher.com/category/region-wm/fpot/page/3/",
];

const UA = "uk-bus-tracker/1.0 (+https://ukbustracker.co.uk; livery colour sample from public photos)";

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

function compactReg(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Parse "63364 SM65WMJ" style titles → { fleet, reg } */
function parseFleetReg(text) {
  const t = String(text || "");
  const m =
    t.match(/\b(\d{4,5})\s+([A-Z]{2}\d{2}\s*[A-Z]{3})\b/i) ||
    t.match(/\b(\d{4,5})\s+([A-Z]\d{1,3}\s*[A-Z]{3})\b/i) ||
    t.match(/\b([A-Z]{2}\d{2}\s*[A-Z]{3})\b/i);
  if (!m) return null;
  if (m[2]) return { fleet: m[1], reg: compactReg(m[2]) };
  return { fleet: "", reg: compactReg(m[1]) };
}

function collectPostLinks(html, base) {
  const links = new Map();
  for (const m of html.matchAll(/href=["']([^"']+)["'][^>]*>([^<]{0,80})</gi)) {
    const href = m[1];
    const label = m[2].trim();
    if (!/trainbasher\.com\/\d{4}\/\d{2}\/\d{2}\//i.test(href) && !/\/\d{4}\/\d{2}\/\d{2}\//.test(href)) {
      continue;
    }
    const parsed = parseFleetReg(label) || parseFleetReg(href);
    if (!parsed?.reg) continue;
    let abs;
    try {
      abs = new URL(href, base).href;
    } catch {
      continue;
    }
    if (!links.has(parsed.reg)) links.set(parsed.reg, { ...parsed, url: abs });
  }
  // Also scan plain text headings nearby
  for (const m of html.matchAll(/\b(\d{4,5})\s+([A-Z]{2}\d{2}[A-Z]{3}|[A-Z]{2}\d{2}\s+[A-Z]{3})\b/gi)) {
    const reg = compactReg(m[2]);
    const slug = reg.toLowerCase();
    const hrefMatch = html.match(new RegExp(`href=["']([^"']*${slug}[^"']*)["']`, "i"));
    if (hrefMatch && !links.has(reg)) {
      try {
        links.set(reg, {
          fleet: m[1],
          reg,
          url: new URL(hrefMatch[1], base).href,
        });
      } catch {
        /* skip */
      }
    }
  }
  return [...links.values()];
}

function pickMainImage(html, base) {
  const imgs = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
  const candidates = imgs
    .map((src) => {
      try {
        return new URL(src, base).href;
      } catch {
        return "";
      }
    })
    .filter(
      (u) =>
        /wp-content\/uploads/i.test(u) &&
        /\.(jpe?g|png|webp)(\?|$)/i.test(u) &&
        !/avatar|logo|icon|emoji|cookie|gravatar/i.test(u),
    );
  // Prefer full-size over -300x200 thumbs
  candidates.sort((a, b) => {
    const score = (u) => (/-\d+x\d+\./.test(u) ? 0 : 2) + (/scaled/.test(u) ? 1 : 0) + Math.min(u.length, 200) / 200;
    return score(b) - score(a);
  });
  return candidates[0] || "";
}

function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"))
      .join("")
  );
}

async function sampleSideGradient(imageUrl) {
  const res = await fetch(imageUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { data, info } = await sharp(buf)
    .rotate()
    .resize(240, 140, { fit: "inside" })
    .normalize()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const fuchsia = [];
  const body = [];
  const all = [];

  for (let y = Math.floor(h * 0.2); y < Math.floor(h * 0.75); y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      all.push([r, g, b]);
      // First fuchsia / magenta nose
      if (r > 130 && r > g + 35 && r > b + 15 && g < 170) fuchsia.push([r, g, b]);
      // Pale silver / white body panels
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max > 150 && max - min < 40 && max < 250) body.push([r, g, b]);
    }
  }

  const mean = (arr) => {
    if (!arr.length) return null;
    const s = arr.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]);
    return [s[0] / arr.length, s[1] / arr.length, s[2] / arr.length];
  };

  const f = mean(fuchsia);
  const bd = mean(body);
  // Fallback: brighter half of pixels as body, most saturated as accent
  let accent = f;
  let panel = bd;
  if (!accent || !panel) {
    const sat = all
      .map((c) => ({ c, s: Math.max(...c) - Math.min(...c) }))
      .sort((a, b) => b.s - a.s);
    const bright = all.filter((c) => (c[0] + c[1] + c[2]) / 3 > 140);
    accent = accent || mean(sat.slice(0, Math.max(20, Math.floor(sat.length * 0.05))).map((x) => x.c));
    panel = panel || mean(bright.length ? bright : all);
  }

  const fuchsiaHex = rgbToHex(...(accent || [213, 19, 126]));
  const bodyHex = rgbToHex(...(panel || [232, 233, 237]));
  const midHex = rgbToHex(
    ((accent?.[0] ?? 213) + (panel?.[0] ?? 232)) / 2,
    ((accent?.[1] ?? 19) + (panel?.[1] ?? 233)) / 2,
    ((accent?.[2] ?? 126) + (panel?.[2] ?? 237)) / 2,
  );
  const skirtHex = rgbToHex(
    Math.max(40, (panel?.[0] ?? 180) * 0.55),
    Math.max(40, (panel?.[1] ?? 180) * 0.55),
    Math.max(40, (panel?.[2] ?? 180) * 0.55),
  );

  // Match Fuchsia Front Urban layout: nose → blend → silver body → skirt
  const left_css = `linear-gradient(90deg,${fuchsiaHex} 0% 17%,${midHex} 17% 24%,${bodyHex} 24% 78%,${skirtHex} 78% 100%)`;
  return {
    left_css,
    colour: bodyHex,
    stroke_colour: "#374151",
    meta: {
      fuchsiaPixels: fuchsia.length,
      bodyPixels: body.length,
      fuchsiaHex,
      bodyHex,
    },
  };
}

async function main() {
  const found = new Map();
  for (const cat of CATEGORY_URLS) {
    const html = await fetchText(cat);
    if (!html) {
      console.log("skip missing", cat);
      continue;
    }
    const posts = collectPostLinks(html, cat);
    console.log(cat, "→", posts.length, "vehicle posts");
    for (const p of posts) {
      if (!found.has(p.reg)) found.set(p.reg, p);
    }
  }

  const liveries = {};
  for (const post of found.values()) {
    try {
      const html = await fetchText(post.url);
      if (!html) continue;
      const image = pickMainImage(html, post.url);
      if (!image) {
        console.log(post.reg, "no image");
        continue;
      }
      const sample = await sampleSideGradient(image);
      liveries[post.reg] = {
        id: `reg:${post.reg}`,
        name: post.fleet
          ? `First Potteries ${post.fleet} (photo)`
          : `First Potteries (photo)`,
        colour: sample.colour,
        left_css: sample.left_css,
        stroke_colour: sample.stroke_colour,
        source: post.url,
        image,
      };
      if (post.fleet) {
        liveries[`FPOT:${post.fleet}`] = { ...liveries[post.reg], id: `fleet:FPOT:${post.fleet}` };
      }
      console.log("ok", post.reg, sample.left_css.slice(0, 90) + "…");
    } catch (error) {
      console.warn(post.reg, error?.message || error);
    }
  }

  const body = `/** Auto-generated by scripts/sync-trainbasher-liveries.mjs — do not edit by hand. */\nexport const PHOTO_LIVERIES = ${JSON.stringify(liveries, null, 2)};\n`;
  writeFileSync(outFile, body, "utf8");
  console.log("wrote", outFile, "entries", Object.keys(liveries).length);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
