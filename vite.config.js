import { defineConfig, loadEnv } from "vite";
import { bodsOccupancyPlugin, fetchBodsVehiclesJson } from "./bods-occupancy.js";
import { dgAtTimetablePlugin } from "./dg-at-timetable.js";
import { firstStopTimesPlugin } from "./first-departures.js";

function dgProxy() {
  return {
    target: "https://api-v3.nextstopapp.co.uk",
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on("proxyReq", (proxyReq) => {
        proxyReq.setHeader("identifier", "9865w159-a113-3mmg-as5k-7354d43sgd");
        proxyReq.setHeader("X-Requested-With", "XMLHttpRequest");
        proxyReq.setHeader("Origin", "https://www.dgbus.co.uk");
        proxyReq.setHeader("Referer", "https://www.dgbus.co.uk/");
        proxyReq.setHeader("Accept", "application/json");
      });
    },
  };
}

/** Dev: /api/vehicles from BODS SIRI-VM (same shape as production). */
function bodsVehiclesPlugin(apiKey) {
  const key = String(apiKey || "").trim();
  return {
    name: "bods-vehicles-map",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = String(req.url || "");
        if (!url.startsWith("/api/vehicles")) return next();
        try {
          const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
          const result = await fetchBodsVehiclesJson(qs, key);
          res.statusCode = result.status;
          res.setHeader("Content-Type", result.contentType || "application/json");
          res.setHeader("X-Vehicles-Source", "bods");
          res.end(result.body);
        } catch (error) {
          console.warn("[vite] bods vehicles failed:", error?.message || error);
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json");
          res.end("[]");
        }
      });
      const emptyList = JSON.stringify({ count: 0, next: null, previous: null, results: [] });
      const gone = JSON.stringify({
        detail: "Not available (bustimes.org unused for this endpoint)",
      });
      const emptyStops = JSON.stringify({ type: "FeatureCollection", features: [] });
      server.middlewares.use((req, res, next) => {
        const url = String(req.url || "").split("?")[0];
        if (url === "/api/stops-geo") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(emptyStops);
          return;
        }
        if (
          url.startsWith("/api/bt-services") ||
          url.startsWith("/api/bt-operators")
        ) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(emptyList);
          return;
        }
        // bt-trips / bt-vehicles / bt-vehiclejourneys / bt-liveries / bt-paint → proxied.
        if (url.startsWith("/api/bt-stops") || url.startsWith("/api/stop-times")) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(gone);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [
      bodsVehiclesPlugin(env.BODS_API_KEY),
      bodsOccupancyPlugin(env.BODS_API_KEY),
      dgAtTimetablePlugin(),
      firstStopTimesPlugin(env.FIRST_APP_KEY),
    ],
    build: {
      target: "es2022",
      cssCodeSplit: true,
      reportCompressedSize: false,
    },
    server: {
      host: true,
      port: 5173,
      allowedHosts: true,
      proxy: {
        "/api/bt-trips": {
          target: "https://bustimes.org",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/bt-trips/, "/api/trips"),
          headers: { "User-Agent": "uk-bus-tracker/1.0 (journey map geometry)" },
        },
        "/api/bt-vehicles": {
          target: "https://bustimes.org",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/bt-vehicles/, "/api/vehicles"),
          headers: { "User-Agent": "uk-bus-tracker/1.0 (history + marker paint)" },
        },
        "/api/bt-vehiclejourneys": {
          target: "https://bustimes.org",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/bt-vehiclejourneys/, "/api/vehiclejourneys"),
          headers: { "User-Agent": "uk-bus-tracker/1.0 (tails / history)" },
        },
        "/api/bt-liveries": {
          target: "https://bustimes.org",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/bt-liveries/, "/api/liveries"),
          headers: { "User-Agent": "uk-bus-tracker/1.0 (marker livery paint)" },
        },
        "/api/bt-paint": {
          target: "https://bustimes.org",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/bt-paint/, "/vehicles.json"),
          headers: { "User-Agent": "uk-bus-tracker/1.0 (marker livery paint)" },
        },
        "/api/overpass": {
          target: "https://overpass-api.de",
          changeOrigin: true,
          rewrite: (path) => `/api/interpreter${path.includes("?") ? path.slice(path.indexOf("?")) : ""}`,
          headers: { "User-Agent": "uk-bus-tracker/1.0 (local map app)" },
        },
        "/api/overpass-alt": {
          target: "https://overpass.kumi.systems",
          changeOrigin: true,
          rewrite: (path) => `/api/interpreter${path.includes("?") ? path.slice(path.indexOf("?")) : ""}`,
          headers: { "User-Agent": "uk-bus-tracker/1.0 (local map app)" },
        },
        "/api/ofm": {
          target: "https://tiles.openfreemap.org",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/ofm/, ""),
          headers: { "User-Agent": "uk-bus-tracker/1.0 (local map app)" },
        },
        "/api/osrm-match": {
          target: "https://router.project-osrm.org",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/osrm-match/, "/match/v1/driving"),
          headers: { "User-Agent": "uk-bus-tracker/1.0 (local map app)" },
        },
        "/api/first-next-bus": {
          target: "https://www.firstbus.co.uk",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/first-next-bus/, "/api/get-next-bus"),
          headers: {
            "User-Agent": "uk-bus-tracker/1.0 (local map app)",
            Accept: "application/json",
          },
        },
        "/api/geocode": {
          target: "https://nominatim.openstreetmap.org",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/geocode/, "/search"),
          headers: { "User-Agent": "uk-bus-tracker/1.0 (local map app)" },
        },
        "/api/dg-vehicles": {
          ...dgProxy(),
          rewrite: () => "/api/v1/buses/realtime",
        },
        "/api/dg-services": {
          ...dgProxy(),
          rewrite: () => "/api/v1/region/526/services",
        },
        "/api/dg-vehicle": {
          ...dgProxy(),
          rewrite: (path) => path.replace(/^\/api\/dg-vehicle/, "/api/v1/vehicle"),
        },
      },
    },
  };
});
