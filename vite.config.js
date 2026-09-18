import { defineConfig, loadEnv } from "vite";
import { bodsOccupancyPlugin } from "./bods-occupancy.js";

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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
  plugins: [bodsOccupancyPlugin(env.BODS_API_KEY)],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api/vehicles": {
        target: "https://bustimes.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/vehicles/, "/vehicles.json"),
      },
      "/api/bt-trips": {
        target: "https://bustimes.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bt-trips/, "/api/trips"),
      },
      "/api/bt-vehicles": {
        target: "https://bustimes.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bt-vehicles/, "/api/vehicles"),
      },
      "/api/bt-vehiclejourneys": {
        target: "https://bustimes.org",
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/api\/bt-vehiclejourneys/, "/api/vehiclejourneys"),
      },
      "/api/bt-operators": {
        target: "https://bustimes.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bt-operators/, "/api/operators"),
      },
      "/api/bt-liveries": {
        target: "https://bustimes.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bt-liveries/, "/api/liveries"),
      },
      "/api/bt-stops": {
        target: "https://bustimes.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bt-stops/, "/api/stops"),
      },
      "/api/stops-geo": {
        target: "https://bustimes.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/stops-geo/, "/stops.json"),
      },
      "/api/stop-times": {
        target: "https://bustimes.org",
        changeOrigin: true,
        rewrite: (path) => {
          const match = path.match(/^\/api\/stop-times\/([^/?#]+)/);
          return match ? `/stops/${match[1]}/times.json` : path;
        },
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
      "/api/first-next-bus": {
        target: "https://www.firstbus.co.uk",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/first-next-bus/, "/api/get-next-bus"),
        headers: {
          "User-Agent": "uk-bus-tracker/1.0 (local map app)",
          Origin: "https://www.firstbus.co.uk",
          Referer: "https://www.firstbus.co.uk/",
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
        rewrite: (path) =>
          path.replace(/^\/api\/dg-vehicles/, "/api/v1/buses/realtime"),
      },
      "/api/dg-services": {
        ...dgProxy(),
        rewrite: (path) =>
          path.replace(/^\/api\/dg-services/, "/api/v1/region/526/services"),
      },
      "/api/dg-vehicle": {
        ...dgProxy(),
        rewrite: (path) => path.replace(/^\/api\/dg-vehicle/, "/api/v1/vehicle"),
      },
    },
  },
};
});
