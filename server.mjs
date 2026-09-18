import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleBodsOccupancy } from "./bods-occupancy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "dist");
const port = Number(process.env.PORT) || 4173;
const bodsKey = process.env.BODS_API_KEY || "";

const UA = "uk-bus-tracker/1.0 (hosted map app)";

function dgHeaders(proxyReq) {
  proxyReq.setHeader("identifier", "9865w159-a113-3mmg-as5k-7354d43sgd");
  proxyReq.setHeader("X-Requested-With", "XMLHttpRequest");
  proxyReq.setHeader("Origin", "https://www.dgbus.co.uk");
  proxyReq.setHeader("Referer", "https://www.dgbus.co.uk/");
  proxyReq.setHeader("Accept", "application/json");
}

/** Express strips the mount path; rebuild the upstream path from the remainder. */
function rewriteMount(destBase, { file = false } = {}) {
  return (incomingPath, req) => {
    const raw = req?.url || incomingPath || "";
    const qIdx = raw.indexOf("?");
    const pathname = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const query = qIdx >= 0 ? raw.slice(qIdx) : "";
    if (file) return `${destBase}${query}`;
    const suffix = !pathname || pathname === "/" ? "" : pathname;
    return `${destBase.replace(/\/$/, "")}${suffix}${query}`;
  };
}

function proxy(options) {
  return createProxyMiddleware({
    changeOrigin: true,
    ...options,
  });
}

const app = express();

app.get("/api/bods-occupancy", (req, res) => handleBodsOccupancy(req, res, bodsKey));

app.use(
  "/api/vehicles",
  proxy({
    target: "https://bustimes.org",
    pathRewrite: rewriteMount("/vehicles.json", { file: true }),
  }),
);
app.use(
  "/api/bt-trips",
  proxy({
    target: "https://bustimes.org",
    pathRewrite: rewriteMount("/api/trips"),
  }),
);
app.use(
  "/api/bt-vehicles",
  proxy({
    target: "https://bustimes.org",
    pathRewrite: rewriteMount("/api/vehicles"),
  }),
);
app.use(
  "/api/bt-vehiclejourneys",
  proxy({
    target: "https://bustimes.org",
    pathRewrite: rewriteMount("/api/vehiclejourneys"),
  }),
);
app.use(
  "/api/bt-operators",
  proxy({
    target: "https://bustimes.org",
    pathRewrite: rewriteMount("/api/operators"),
  }),
);
app.use(
  "/api/bt-liveries",
  proxy({
    target: "https://bustimes.org",
    pathRewrite: rewriteMount("/api/liveries"),
  }),
);
app.use(
  "/api/bt-stops",
  proxy({
    target: "https://bustimes.org",
    pathRewrite: rewriteMount("/api/stops"),
  }),
);
app.use(
  "/api/stops-geo",
  proxy({
    target: "https://bustimes.org",
    pathRewrite: rewriteMount("/stops.json", { file: true }),
  }),
);
app.use(
  "/api/stop-times",
  proxy({
    target: "https://bustimes.org",
    pathRewrite: (incomingPath, req) => {
      const raw = req?.url || incomingPath || "";
      const qIdx = raw.indexOf("?");
      const pathname = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
      const query = qIdx >= 0 ? raw.slice(qIdx) : "";
      const atco = pathname.replace(/^\//, "").split("/")[0];
      return atco ? `/stops/${atco}/times.json${query}` : incomingPath;
    },
  }),
);
app.use(
  "/api/overpass",
  proxy({
    target: "https://overpass-api.de",
    pathRewrite: (_path, req) => {
      const full = req.originalUrl || "";
      const q = full.includes("?") ? full.slice(full.indexOf("?")) : "";
      return `/api/interpreter${q}`;
    },
    headers: { "User-Agent": UA },
  }),
);
app.use(
  "/api/overpass-alt",
  proxy({
    target: "https://overpass.kumi.systems",
    pathRewrite: (_path, req) => {
      const full = req.originalUrl || "";
      const q = full.includes("?") ? full.slice(full.indexOf("?")) : "";
      return `/api/interpreter${q}`;
    },
    headers: { "User-Agent": UA },
  }),
);
app.use(
  "/api/ofm",
  proxy({
    target: "https://tiles.openfreemap.org",
    pathRewrite: rewriteMount(""),
    headers: { "User-Agent": UA },
  }),
);
app.use(
  "/api/first-next-bus",
  proxy({
    target: "https://www.firstbus.co.uk",
    pathRewrite: rewriteMount("/api/get-next-bus", { file: true }),
    headers: {
      "User-Agent": UA,
      Origin: "https://www.firstbus.co.uk",
      Referer: "https://www.firstbus.co.uk/",
      Accept: "application/json",
    },
  }),
);
app.use(
  "/api/geocode",
  proxy({
    target: "https://nominatim.openstreetmap.org",
    pathRewrite: rewriteMount("/search", { file: true }),
    headers: { "User-Agent": UA },
  }),
);
app.use(
  "/api/dg-vehicles",
  proxy({
    target: "https://api-v3.nextstopapp.co.uk",
    pathRewrite: rewriteMount("/api/v1/buses/realtime", { file: true }),
    on: { proxyReq: dgHeaders },
  }),
);
app.use(
  "/api/dg-services",
  proxy({
    target: "https://api-v3.nextstopapp.co.uk",
    pathRewrite: rewriteMount("/api/v1/region/526/services", { file: true }),
    on: { proxyReq: dgHeaders },
  }),
);
app.use(
  "/api/dg-vehicle",
  proxy({
    target: "https://api-v3.nextstopapp.co.uk",
    pathRewrite: rewriteMount("/api/v1/vehicle"),
    on: { proxyReq: dgHeaders },
  }),
);

app.use(express.static(distDir, { index: false, maxAge: "1h" }));
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  res.sendFile(path.join(distDir, "index.html"), (err) => {
    if (err) next(err);
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`UK Bus Tracker listening on http://0.0.0.0:${port}`);
});
