/*
 * Tests for the Longton virtual camera's data handling.
 *
 * The part that has to be right is turning a feed row into something drawable.
 * That is easy to get subtly wrong: `coordinates` is a [lon, lat] PAIR on this
 * feed, not an object, and getting that backwards puts every bus in the Atlantic
 * instead of on the road. The real live row is reproduced here verbatim.
 */
const fs = require("fs");

const src = fs.readFileSync("src/longton-camera.js", "utf8");

function extract(name) {
  const start = src.search(new RegExp(`^(export )?(async )?function ${name}\\b`, "m"));
  if (start < 0) throw new Error(`${name} not found`);
  const close = /\r?\n\}\r?\n/g;
  close.lastIndex = start;
  const m = close.exec(src);
  return src.slice(start, m.index + m[0].length);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const factory = new Function(
  "esc",
  `${extract("esc")}
   const L = { layerGroup: () => ({ addTo() { return this; }, clearLayers() {} }) };
   ${extract("haversineM")}
   ${extract("positionOf")}
   ${extract("normalise")}
   ${extract("busIcon")}
   ${extract("popupHtml")}
   return { haversineM, positionOf, normalise, busIcon, popupHtml };`,
);
const { haversineM, positionOf, normalise } = factory(esc);

let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
};

// A real CRDR row captured from the live feed.
const LIVE_ROW = {
  id: "bods-CRDR-CRDR-1",
  source: "bods",
  coordinates: [-1.824915, 52.681396],
  heading: 0,
  datetime: "2026-09-26T16:47:39+00:00",
  destination: "Lichfield Bus Station",
  direction: "outbound",
  origin: "Walsall Bus Station",
  service: { line_name: "36", operator: { noc: "CRDR", name: "CRDR", id: "CRDR" } },
  operator: { noc: "CRDR", name: "CRDR", id: "CRDR" },
  vehicle: { name: "1", reg: "", fleet_code: "1", colour: "#2563eb", livery: "op:CRDR" },
};

const pos = positionOf(LIVE_ROW);
ok("coordinates are read as a [lon, lat] pair", pos && Math.abs(pos.lon - (-1.824915)) < 1e-9 && Math.abs(pos.lat - 52.681396) < 1e-9,
  JSON.stringify(pos));
ok("latitude is the second element, not the first", pos.lat > 52 && pos.lat < 53);

const bus = normalise(LIVE_ROW);
ok("the row normalises", !!bus);
ok("the route number comes through", bus.line === "36", bus.line);
ok("the destination comes through", bus.destination === "Lichfield Bus Station", bus.destination);
ok("the operator comes through", bus.operator === "CRDR", bus.operator);
ok("the livery colour comes through", bus.colour === "#2563eb", bus.colour);
ok("the heading comes through", bus.heading === 0, String(bus.heading));

// A row with a registration, as First Potteries sends.
const FPOT_ROW = {
  ...LIVE_ROW,
  id: "bods-FPOT-1",
  coordinates: [-2.2756, 53.0014],
  heading: 217,
  service: { line_name: "25", operator: { noc: "FPOT", name: "First Potteries", id: "FPOT" } },
  operator: { noc: "FPOT", name: "First Potteries", id: "FPOT" },
  vehicle: { name: "231", reg: "BN72TUW", colour: "#c8102e" },
};
const fpot = normalise(FPOT_ROW);
ok("a registration is picked up", fpot.reg === "BN72TUW", fpot.reg);
ok("a bearing is picked up", fpot.heading === 217, String(fpot.heading));
ok("the full operator name is used", fpot.operatorName === "First Potteries", fpot.operatorName);

// Rows with nothing usable in them must be dropped, not drawn at 0,0.
ok("a row with no coordinates is rejected", positionOf({ id: "x" }) === null);
ok("a row with null coordinates is rejected", positionOf({ id: "x", coordinates: null }) === null);
ok("a row with a short pair is rejected", positionOf({ id: "x", coordinates: [1] }) === null);
ok(
  "a row with non-numeric coordinates is rejected",
  positionOf({ id: "x", coordinates: ["a", "b"] }) === null,
);
ok("a row that is not an object is rejected", positionOf(null) === null);
ok("a row with no coordinates does not normalise", normalise({ id: "x" }) === null);

// The object form some feeds use must work too.
const objForm = positionOf({ coordinates: { latitude: 53.04, longitude: -2.1 } });
ok("an object-shaped position also works", objForm && objForm.lat === 53.04 && objForm.lon === -2.1,
  JSON.stringify(objForm));

// Distance, which decides what the camera can see.
const CAM = { lat: 53.0443, lon: -2.1068 };
ok("distance to itself is zero", Math.abs(haversineM(CAM.lat, CAM.lon, CAM.lat, CAM.lon)) < 0.01);
const dNearby = haversineM(CAM.lat, CAM.lon, 53.05, -2.1068);
ok("a nearby point is about 630 m away", dNearby > 600 && dNearby < 660, dNearby.toFixed(0));
const dHanley = haversineM(CAM.lat, CAM.lon, 53.0014, -2.2756);
ok("Hanley bus station is well over 1 km away", dHanley > 12000, (dHanley / 1000).toFixed(1) + " km");
ok("a bus 12 km away would be out of view", dHanley > 1200);

// The camera point itself must be the Longton town centre, not somewhere else.
// Evaluate the const rather than JSON.parse-ing it: it carries a comment, which
// is not JSON.
const constSrc = src.match(/export const LONGTON_CAMERA = (\{[\s\S]*?\n\});/)[1];
const cfg = new Function(`return (${constSrc});`)();
ok("the camera is over Longton", Math.abs(cfg.lat - 53.0443) < 0.01 && Math.abs(cfg.lon + 2.1068) < 0.01,
  `${cfg.lat},${cfg.lon}`);
ok("the view radius is 1.2 km", cfg.radiusM === 1200, String(cfg.radiusM));

// It must never be mistakable for CCTV.
ok("the module says plainly it is not CCTV", /there is no real picture of Longton/i.test(src));
ok("the disclaimer is in the markup", /Not CCTV\./.test(fs.readFileSync("index.html", "utf8")));
ok("the frame carries a virtual camera tag", /virtual camera/.test(fs.readFileSync("index.html", "utf8")));
ok("the map has an honest accessible name", /not CCTV footage/.test(fs.readFileSync("index.html", "utf8")));
ok("the view cannot be panned or zoomed", /dragging: false/.test(src) && /scrollWheelZoom: false/.test(src));
ok("an empty frame explains itself", /Local services finish for the day/.test(src));

console.log(failed ? `\n${failed} failure(s)` : "\nlongton camera data handling is correct");
process.exit(failed ? 1 : 0);
