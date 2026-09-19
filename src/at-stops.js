/** Alton Towers employee routes AT1 / AT2 / AT3 — stop overlay + live ETAs. */
import atData from "./at-stops-data.json";

export const AT_LINES = ["AT1", "AT2", "AT3"];

export function atStopsInBounds(bounds, { pad = 0.01 } = {}) {
  if (!bounds) return [];
  const south = bounds.getSouth() - pad;
  const north = bounds.getNorth() + pad;
  const west = bounds.getWest() - pad;
  const east = bounds.getEast() + pad;
  return (atData.stops || []).filter(
    (stop) =>
      Number.isFinite(stop.lat) &&
      Number.isFinite(stop.lng) &&
      stop.lat >= south &&
      stop.lat <= north &&
      stop.lng >= west &&
      stop.lng <= east,
  );
}

export function atStopByAtco(atco) {
  const id = String(atco || "");
  if (!id) return null;
  return (atData.stops || []).find((stop) => stop.atco === id) || null;
}

export function atRouteStops(line) {
  return atData.routes?.[String(line || "").toUpperCase()] || [];
}

export function atFeatureFromStop(stop) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [stop.lng, stop.lat] },
    properties: {
      name: stop.name || stop.label,
      url: stop.atco ? `/stops/${stop.atco}` : "",
      services: stop.lines || [],
      atEmployee: true,
      atLines: stop.lines || [],
    },
    atStop: stop,
  };
}

function haversineMeters(aLat, aLng, bLat, bLng) {
  const toRad = (d) => (d * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Build synthetic departures from live AT vehicles near a stop.
 * @param {object} stop
 * @param {Iterable} staffMarkers values with .staff / .line / getLatLng
 */
export function atLiveDeparturesForStop(stop, staffMarkers, { limit = 6 } = {}) {
  if (!stop || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) return [];
  const lines = new Set((stop.lines || []).map((l) => String(l).toUpperCase()));
  const now = Date.now();
  const rows = [];
  for (const marker of staffMarkers || []) {
    const line = String(marker.line || "").toUpperCase();
    if (!lines.has(line)) continue;
    const ll = marker.getLatLng?.() || marker;
    const lat = Number(ll.lat);
    const lng = Number(ll.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const dist = haversineMeters(stop.lat, stop.lng, lat, lng);
    if (dist > 12000) continue;
    const speedMph = Number(marker.staff?.speedMph);
    const speedMs = Number.isFinite(speedMph) && speedMph > 2 ? (speedMph * 1609.34) / 3600 : 8;
    const etaSec = dist / Math.max(3, speedMs);
    const dest =
      marker.extra?.to ||
      marker.staff?.currentJourney?.destination?.name ||
      "Alton Towers";
    const when = new Date(now + etaSec * 1000).toISOString();
    rows.push({
      line,
      dest,
      when,
      ms: now + etaSec * 1000,
      live: true,
      atEmployee: true,
      distanceM: Math.round(dist),
    });
  }
  return rows.sort((a, b) => a.ms - b.ms).slice(0, limit);
}

export { atData };
