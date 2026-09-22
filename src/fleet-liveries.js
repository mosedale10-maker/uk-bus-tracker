/**
 * Per-vehicle liveries you maintain locally (no bustimes.org).
 * Keys: compact registration (YX66WFJ) or operator:fleet (DAGC:100 / FPOT:67151).
 *
 * Photo-sampled paints from trainbasher.com are merged from photo-liveries.generated.js
 * (run: node scripts/sync-trainbasher-liveries.mjs).
 */

import { PHOTO_LIVERIES } from "./photo-liveries.generated.js";

/** @typedef {{ id: string, name: string, colour: string, left_css: string, stroke_colour: string }} FleetLivery */

export function compactRegKey(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** @type {Record<string, FleetLivery>} */
export const FLEET_LIVERIES = {
  // —— First Potteries (live BN72 batch — standard magenta) ——
  BN72TTX: {
    id: "reg:BN72TTX",
    name: "First Potteries · magenta",
    colour: "#d5137e",
    left_css:
      "linear-gradient(180deg,#ffffff 0 10%,#d5137e 10% 52%,#f7b6d4 52% 64%,#d5137e 64% 86%,#111111 86%)",
    stroke_colour: "#111111",
  },
  BN72TTY: {
    id: "reg:BN72TTY",
    name: "First Potteries · magenta",
    colour: "#d5137e",
    left_css:
      "linear-gradient(180deg,#ffffff 0 10%,#d5137e 10% 52%,#f7b6d4 52% 64%,#d5137e 64% 86%,#111111 86%)",
    stroke_colour: "#111111",
  },
  BN72TTZ: {
    id: "reg:BN72TTZ",
    name: "First Potteries · magenta",
    colour: "#d5137e",
    left_css:
      "linear-gradient(180deg,#ffffff 0 10%,#d5137e 10% 52%,#f7b6d4 52% 64%,#d5137e 64% 86%,#111111 86%)",
    stroke_colour: "#111111",
  },
  BN72TUA: {
    id: "reg:BN72TUA",
    name: "First Potteries · magenta",
    colour: "#d5137e",
    left_css:
      "linear-gradient(180deg,#ffffff 0 10%,#d5137e 10% 52%,#f7b6d4 52% 64%,#d5137e 64% 86%,#111111 86%)",
    stroke_colour: "#111111",
  },
  // Older Potteries plate style (common on the map historically)
  YX66WFJ: {
    id: "reg:YX66WFJ",
    name: "First Potteries · magenta",
    colour: "#d5137e",
    left_css:
      "linear-gradient(180deg,#ffffff 0 12%,#d5137e 12% 55%,#f5a3c7 55% 68%,#d5137e 68% 88%,#1a1a1a 88%)",
    stroke_colour: "#1a1a1a",
  },
  YX66WBV: {
    id: "reg:YX66WBV",
    name: "First Potteries · magenta",
    colour: "#d5137e",
    left_css:
      "linear-gradient(180deg,#ffffff 0 12%,#d5137e 12% 55%,#f5a3c7 55% 68%,#d5137e 68% 88%,#1a1a1a 88%)",
    stroke_colour: "#1a1a1a",
  },
  // —— First Potteries StreetLites from trainbasher.com photos (side/front samples) ——
  // SM65 WMJ (63364): Fuchsia Front Urban — fuchsia nose, pale silver body
  // Photo: https://trainbasher.com/2018/06/12/63364-sm65wmj/
  SM65WMJ: {
    id: "reg:SM65WMJ",
    name: "First · Fuchsia Front Urban",
    colour: "#d4d6da",
    left_css:
      "linear-gradient(90deg,#d5137e 0 18%,#e8a3c5 18% 24%,#eef0f3 24% 78%,#c5c7cb 78% 92%,#8a8c90 92%)",
    stroke_colour: "#4b5563",
  },
  // Sister StreetLites same scheme (trainbasher FPOT album)
  SM65WME: {
    id: "reg:SM65WME",
    name: "First · Fuchsia Front Urban",
    colour: "#d4d6da",
    left_css:
      "linear-gradient(90deg,#d5137e 0 18%,#e8a3c5 18% 24%,#eef0f3 24% 78%,#c5c7cb 78% 92%,#8a8c90 92%)",
    stroke_colour: "#4b5563",
  },
  SM65WMU: {
    id: "reg:SM65WMU",
    name: "First · Fuchsia Front Urban",
    colour: "#d4d6da",
    left_css:
      "linear-gradient(90deg,#d5137e 0 18%,#e8a3c5 18% 24%,#eef0f3 24% 78%,#c5c7cb 78% 92%,#8a8c90 92%)",
    stroke_colour: "#4b5563",
  },

  // —— D & G (BODS often only has fleet number → use DAGC:nnn keys) ——
  "DAGC:100": {
    id: "fleet:DAGC:100",
    name: "D & G · green / yellow",
    colour: "#00a651",
    left_css:
      "linear-gradient(180deg,#ffffff 0 12%,#00a651 12% 56%,#ffd200 56% 70%,#00a651 70% 88%,#0f172a 88%)",
    stroke_colour: "#0f172a",
  },
  "DAGC:101": {
    id: "fleet:DAGC:101",
    name: "D & G · green / yellow",
    colour: "#00a651",
    left_css:
      "linear-gradient(180deg,#ffffff 0 12%,#00a651 12% 56%,#ffd200 56% 70%,#00a651 70% 88%,#0f172a 88%)",
    stroke_colour: "#0f172a",
  },
  "DAGC:108": {
    id: "fleet:DAGC:108",
    name: "D & G · green / yellow",
    colour: "#00a651",
    left_css:
      "linear-gradient(180deg,#ffffff 0 12%,#00a651 12% 56%,#ffd200 56% 70%,#00a651 70% 88%,#0f172a 88%)",
    stroke_colour: "#0f172a",
  },
  // Known AT staff plates (when AVL shows the reg)
  BU25ZCT: {
    id: "reg:BU25ZCT",
    name: "D & G · Alton Towers AT1",
    colour: "#6b21a8",
    left_css: "linear-gradient(180deg,#c4b5fd 0 40%,#6b21a8 40% 78%,#3b0764 78%)",
    stroke_colour: "#3b0764",
  },
  LA14HZW: {
    id: "reg:LA14HZW",
    name: "D & G · Alton Towers AT3",
    colour: "#1f6b2d",
    left_css: "linear-gradient(180deg,#86efac 0 40%,#1f6b2d 40% 78%,#14532d 78%)",
    stroke_colour: "#14532d",
  },
};

function plateFromText(value) {
  const text = String(value || "").toUpperCase();
  const match =
    text.match(/\b([A-Z]{2}\d{2}\s*[A-Z]{3})\b/) || text.match(/\b([A-Z]\d{1,3}\s*[A-Z]{3})\b/);
  return match ? compactRegKey(match[1]) : "";
}

function fleetKeyFromBus(bus) {
  const noc = String(
    bus?._bods?.operator || bus?.operator?.noc || bus?.operator?.id || "",
  )
    .trim()
    .toUpperCase();
  if (!noc) return "";

  const ref = String(bus?._bods?.vehicleRef || "").trim();
  const name = String(bus?.vehicle?.name || "").trim();
  // DAGC-100 / FPOT-67151 style
  const fromRef = ref.match(new RegExp(`^${noc}[-_]?(.+)$`, "i"));
  const fleet =
    (fromRef ? fromRef[1] : "") ||
    (name.match(/^\d{2,5}$/) ? name : "") ||
    (name.match(/^(\d+)\b/) || [])[1] ||
    "";
  const compact = compactRegKey(fleet);
  if (!compact) return "";
  return `${noc}:${compact}`;
}

/** Per-vehicle livery if we have a reg or fleet-number entry. */
export function fleetLiveryForBus(bus) {
  if (!bus) return null;

  const candidates = [
    compactRegKey(bus.vehicle?.reg),
    plateFromText(bus.vehicle?.name),
    plateFromText(bus._bods?.vehicleRef),
    fleetKeyFromBus(bus),
  ].filter(Boolean);

  // Photo-sampled liveries win over hand-written brand guesses.
  const tables = [PHOTO_LIVERIES, FLEET_LIVERIES];
  for (const key of candidates) {
    for (const table of tables) {
      const hit = table?.[key];
      if (hit?.left_css || hit?.left) return hit;
    }
  }
  return null;
}
