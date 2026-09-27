/**
 * Collect freely-licensed photographs of The Strand, Longton.
 *
 * WHY COMMONS AND NOT GOOGLE
 * There is street-level photography of Longton on Google, and it would look far
 * better. It is also not licensed for reuse, and pasting it into a rendered scene
 * would be a breach. Geograph, via Wikimedia Commons, photographed every street in
 * Britain under CC BY-SA 2.0 precisely so the images could be reused, and it has
 * eight photographs of The Strand itself - the Superdrug and Ryman frontage, the
 * Potteries Oatcake Company, the view from Gold Street, the corner of Commerce
 * Street. Those are the real shops, in the real street, free to use with credit.
 *
 * Each image's GPS position is recorded so a photograph can be matched to the
 * building it actually shows, rather than dropped at random.
 *
 * Run: node scripts/fetch-longton-photos.mjs
 */
import { writeFileSync } from "node:fs";

/** The Strand and the streets either side of it. */
const SEARCHES = [
  "The Strand Longton",
  "Longton Market Stoke-on-Trent",
  "Longton Stoke-on-Trent",
  "Commerce Street Longton",
  "Market Street Longton Stoke",
  "King Street Longton Stoke-on-Trent",
];

/** The scene origin, so distances can be worked out and far-flung shots dropped. */
const ORIGIN = { lat: 52.988038, lon: -2.137064 };
const MAX_M = 500;

const API = "https://commons.wikimedia.org/w/api.php";
const UA = "uk-bus-tracker/1.0 (Longton virtual camera)";

/** Wikimedia often wraps artist names in HTML. */
function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function search(term) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `filetype:bitmap ${term}`,
    gsrnamespace: "6",
    gsrlimit: "20",
    prop: "imageinfo",
    iiprop: "url|extmetadata|size",
    iiurlwidth: "1024",
  });
  const res = await fetch(`${API}?${params}`, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const data = await res.json();
  return Object.values(data?.query?.pages || {});
}

function haversineM(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

const found = new Map();
for (const term of SEARCHES) {
  const pages = await search(term);
  console.log(`  '${term}': ${pages.length} file(s)`);
  for (const page of pages) {
    const info = (page.imageinfo || [])[0];
    if (!info) continue;
    const meta = info.extmetadata || {};
    const licence = stripHtml(meta.LicenseShortName?.value);
    // Only licences that actually permit reuse. "Fair use" and unknown are out.
    if (!/^(CC0|CC BY|Public domain|PD)/i.test(licence)) continue;
    if (/non-?free|fair use/i.test(licence)) continue;

    const lat = Number(meta.GPSLatitude?.value);
    const lon = Number(meta.GPSLongitude?.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const distance = haversineM(ORIGIN.lat, ORIGIN.lon, lat, lon);
    if (distance > MAX_M) continue;

    const file = String(page.title || "").replace(/^File:/, "");
    if (found.has(file)) continue;
    found.set(file, {
      file,
      title: file.replace(/\.[a-z]+$/i, "").replace(/_/g, " "),
      page: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
      // A 1024px thumb is plenty for a texture and much lighter than the original.
      thumb: info.thumburl || info.url,
      original: info.url,
      width: info.thumbwidth || info.width || 0,
      height: info.thumbheight || info.height || 0,
      lat,
      lon,
      distanceM: Math.round(distance),
      licence,
      licenceUrl: stripHtml(meta.LicenseUrl?.value) || "",
      author: stripHtml(meta.Artist?.value) || "unknown",
      credit: stripHtml(meta.Credit?.value) || "",
    });
  }
}

const photos = [...found.values()].sort((a, b) => a.distanceM - b.distanceM);
const body = {
  generated: new Date().toISOString(),
  source: "Wikimedia Commons (Geograph and other contributors)",
  note:
    "Freely-licensed photographs of the actual street, reused under CC BY-SA / CC BY. " +
    "Each needs crediting its author; see the attribution list in the frame.",
  count: photos.length,
  photos,
};
writeFileSync(new URL("../longton-photos.generated.json", import.meta.url), `${JSON.stringify(body)}\n`);

console.log(`\nkept ${photos.length} photograph(s) within ${MAX_M} m of the camera:`);
for (const p of photos) {
  console.log(
    `  ${String(p.distanceM).padStart(4)} m  ${p.licence.padEnd(12)} ${p.width}x${p.height}  ${p.title.slice(0, 46)}`,
  );
}
