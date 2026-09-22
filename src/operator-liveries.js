/**
 * Local brand liveries for map markers — same paint model as before
 * (left_css / stroke_colour on .bus-livery), without bustimes.org.
 */

/** @typedef {{ id: string, name: string, colour: string, left_css: string, stroke_colour: string }} BrandLivery */

/** @type {Record<string, BrandLivery>} */
export const OPERATOR_LIVERIES = {
  FPOT: {
    id: "op:FPOT",
    name: "First Potteries",
    colour: "#d5137e",
    left_css:
      "linear-gradient(180deg,#ffffff 0 12%,#d5137e 12% 55%,#f5a3c7 55% 68%,#d5137e 68% 88%,#1a1a1a 88%)",
    stroke_colour: "#1a1a1a",
  },
  DAGC: {
    id: "op:DAGC",
    name: "D & G Bus",
    colour: "#00a651",
    left_css:
      "linear-gradient(180deg,#ffffff 0 14%,#00a651 14% 58%,#ffd200 58% 72%,#00a651 72% 90%,#0f172a 90%)",
    stroke_colour: "#0f172a",
  },
  FLIX: {
    id: "op:FLIX",
    name: "FlixBus",
    colour: "#73d700",
    left_css: "linear-gradient(#73d700 0 58%, #ff8500 58% 70%, #73d700 70%)",
    stroke_colour: "#1a1a1a",
  },
  NATX: {
    id: "op:NATX",
    name: "National Express",
    colour: "#ffffff",
    // Mirrors bustimes.org livery 643 ("National Express") white coach with grey stripe.
    left_css:
      "linear-gradient(#0000 45%,#fff 45%),linear-gradient(120deg,#fff 52%,#b7bbcb 52% 56%,#fff 56% 60%,#b7bbcb 60% 64%,#fff 64% 68%,#b7bbcb 68% 72%,#fff 72% 76%,#b7bbcb 76% 80%,#fff 80% 84%)",
    stroke_colour: "#334155",
  },
  SCCM: {
    id: "op:SCCM",
    name: "Stagecoach",
    colour: "#ffffff",
    left_css:
      "linear-gradient(180deg,#ffffff 0 45%,#e30613 45% 58%,#ff8200 58% 72%,#003087 72%)",
    stroke_colour: "#003087",
  },
  SCCO: {
    id: "op:SCCO",
    name: "Stagecoach",
    colour: "#ffffff",
    left_css:
      "linear-gradient(180deg,#ffffff 0 45%,#e30613 45% 58%,#ff8200 58% 72%,#003087 72%)",
    stroke_colour: "#003087",
  },
  SCMN: {
    id: "op:SCMN",
    name: "Stagecoach",
    colour: "#ffffff",
    left_css:
      "linear-gradient(180deg,#ffffff 0 45%,#e30613 45% 58%,#ff8200 58% 72%,#003087 72%)",
    stroke_colour: "#003087",
  },
  ARCT: {
    id: "op:ARCT",
    name: "Arriva",
    colour: "#71c5e8",
    left_css:
      "linear-gradient(180deg,#ffffff 0 18%,#71c5e8 18% 55%,#003087 55% 70%,#71c5e8 70% 88%,#0f172a 88%)",
    stroke_colour: "#003087",
  },
  ARBB: {
    id: "op:ARBB",
    name: "Arriva",
    colour: "#71c5e8",
    left_css:
      "linear-gradient(180deg,#ffffff 0 18%,#71c5e8 18% 55%,#003087 55% 70%,#71c5e8 70% 88%,#0f172a 88%)",
    stroke_colour: "#003087",
  },
  GNEL: {
    id: "op:GNEL",
    name: "Go North East",
    colour: "#e30613",
    left_css:
      "linear-gradient(180deg,#ffffff 0 20%,#e30613 20% 60%,#ffd200 60% 74%,#e30613 74% 90%,#111 90%)",
    stroke_colour: "#111111",
  },
  FBRI: {
    id: "op:FBRI",
    name: "First Bus",
    colour: "#e87722",
    left_css:
      "linear-gradient(180deg,#ffffff 0 14%,#e87722 14% 58%,#54266e 58% 74%,#e87722 74% 90%,#1a1a1a 90%)",
    stroke_colour: "#1a1a1a",
  },
  FSYO: {
    id: "op:FSYO",
    name: "First Bus",
    colour: "#e87722",
    left_css:
      "linear-gradient(180deg,#ffffff 0 14%,#e87722 14% 58%,#54266e 58% 74%,#e87722 74% 90%,#1a1a1a 90%)",
    stroke_colour: "#1a1a1a",
  },
  TNXB: {
    id: "op:TNXB",
    name: "National Express West Midlands",
    colour: "#e30613",
    left_css:
      "linear-gradient(180deg,#ffffff 0 55%,#e30613 55% 78%,#003087 78%)",
    stroke_colour: "#003087",
  },
  TCM: {
    id: "op:TCM",
    name: "Transport for Greater Manchester",
    colour: "#ff8200",
    left_css:
      "linear-gradient(180deg,#ffffff 0 30%,#ff8200 30% 70%,#6b2d7b 70%)",
    stroke_colour: "#6b2d7b",
  },
  TFGM: {
    id: "op:TFGM",
    name: "Bee Network",
    colour: "#ff8200",
    left_css:
      "linear-gradient(180deg,#ffffff 0 30%,#ff8200 30% 70%,#6b2d7b 70%)",
    stroke_colour: "#6b2d7b",
  },
  SLBS: {
    id: "op:SLBS",
    name: "Select Bus Services",
    colour: "#1d4ed8",
    left_css:
      "linear-gradient(180deg,#ffffff 0 16%,#1d4ed8 16% 58%,#fbbf24 58% 72%,#1d4ed8 72% 90%,#0f172a 90%)",
    stroke_colour: "#0f172a",
  },
  CRDR: {
    id: "op:CRDR",
    name: "Chaserider",
    colour: "#0ea5e9",
    left_css:
      "linear-gradient(180deg,#ffffff 0 14%,#0ea5e9 14% 55%,#0369a1 55% 70%,#0ea5e9 70% 88%,#0f172a 88%)",
    stroke_colour: "#0f172a",
  },
  BANG: {
    id: "op:BANG",
    name: "Banga Buses",
    colour: "#16a34a",
    left_css:
      "linear-gradient(180deg,#ffffff 0 14%,#16a34a 14% 58%,#facc15 58% 72%,#16a34a 72% 90%,#14532d 90%)",
    stroke_colour: "#14532d",
  },
  HIPK: {
    id: "op:HIPK",
    name: "High Peak",
    colour: "#7c3aed",
    left_css:
      "linear-gradient(180deg,#ffffff 0 14%,#7c3aed 14% 55%,#c4b5fd 55% 68%,#7c3aed 68% 88%,#1e1b4b 88%)",
    stroke_colour: "#1e1b4b",
  },
  TBTN: {
    id: "op:TBTN",
    name: "trentbarton",
    colour: "#e11d48",
    left_css:
      "linear-gradient(180deg,#ffffff 0 14%,#e11d48 14% 58%,#fb7185 58% 70%,#e11d48 70% 88%,#111 88%)",
    stroke_colour: "#111111",
  },
  DIAM: {
    id: "op:DIAM",
    name: "Diamond Bus",
    colour: "#dc2626",
    left_css:
      "linear-gradient(180deg,#ffffff 0 14%,#dc2626 14% 55%,#fbbf24 55% 70%,#dc2626 70% 88%,#111 88%)",
    stroke_colour: "#111111",
  },
  MDCL: {
    id: "op:MDCL",
    name: "Diamond Bus East Midlands",
    colour: "#dc2626",
    left_css:
      "linear-gradient(180deg,#ffffff 0 14%,#dc2626 14% 55%,#fbbf24 55% 70%,#dc2626 70% 88%,#111 88%)",
    stroke_colour: "#111111",
  },
  SOST: {
    id: "op:SOST",
    name: "Stanton's of Stoke",
    colour: "#2563eb",
    left_css:
      "linear-gradient(180deg,#ffffff 0 16%,#2563eb 16% 58%,#93c5fd 58% 70%,#2563eb 70% 88%,#0f172a 88%)",
    stroke_colour: "#0f172a",
  },
  AMNO: {
    id: "op:AMNO",
    name: "Arriva Midlands North",
    colour: "#71c5e8",
    left_css:
      "linear-gradient(180deg,#ffffff 0 18%,#71c5e8 18% 55%,#003087 55% 70%,#71c5e8 70% 88%,#0f172a 88%)",
    stroke_colour: "#003087",
  },
  ADER: {
    id: "op:ADER",
    name: "Arriva Derby",
    colour: "#71c5e8",
    left_css:
      "linear-gradient(180deg,#ffffff 0 18%,#71c5e8 18% 55%,#003087 55% 70%,#71c5e8 70% 88%,#0f172a 88%)",
    stroke_colour: "#003087",
  },
};

const STAFF_LINE_LIVERIES = {
  // Fallbacks when bustimes vehicle lookup misses — CSS mirrors common AT / D&G paints.
  AT1: {
    id: "line:AT1",
    name: "Alton Towers AT1",
    colour: "#ff6700",
    left_css: "linear-gradient(110deg,#ff6700 55%,#fff 55% 62%,#cc181a 62%)",
    stroke_colour: "#7c2d12",
  },
  AT2: {
    id: "line:AT2",
    name: "Alton Towers AT2",
    colour: "#cc181a",
    left_css: "linear-gradient(110deg,#cc181a 55%,#fef503 55% 62%,#2b2b8d 62%)",
    stroke_colour: "#1e1b4b",
  },
  AT3: {
    id: "line:AT3",
    name: "Alton Towers AT3",
    colour: "#cc181a",
    left_css: "linear-gradient(110deg,#cc181a 55%,#fef503 55% 62%,#2b2b8d 62%)",
    stroke_colour: "#1e1b4b",
  },
};

function nocOf(bus) {
  return String(
    bus?._bods?.operator ||
      bus?.operator?.noc ||
      bus?.operator?.id ||
      bus?.service?.operator?.noc ||
      bus?.service?.operator?.id ||
      "",
  )
    .trim()
    .toUpperCase();
}

function lineOf(bus) {
  return String(bus?.service?.line_name || "").trim().toUpperCase();
}

/** Brand / line livery for a live bus (bustimes-shaped object). */
export function brandLiveryForLine(line) {
  const code = String(line || "").trim().toUpperCase();
  return STAFF_LINE_LIVERIES[code] || null;
}

/** Brand / line livery for a live bus (bustimes-shaped object). */
export function brandLiveryForBus(bus) {
  if (!bus) return null;
  const line = lineOf(bus);
  if (STAFF_LINE_LIVERIES[line]) return STAFF_LINE_LIVERIES[line];

  const noc = nocOf(bus);
  if (noc && OPERATOR_LIVERIES[noc]) return OPERATOR_LIVERIES[noc];

  // Soft First / Stagecoach / Arriva family match from NOC prefixes.
  if (/^F[A-Z]{2,}$/.test(noc) && noc !== "FLIX") {
    return { ...OPERATOR_LIVERIES.FBRI, id: `op:${noc}`, name: noc };
  }
  if (/^SC/.test(noc)) {
    return { ...OPERATOR_LIVERIES.SCCM, id: `op:${noc}`, name: noc };
  }
  if (/^AR/.test(noc)) {
    return { ...OPERATOR_LIVERIES.ARCT, id: `op:${noc}`, name: noc };
  }
  if (/FLIX|MEGA/i.test(noc) || /flix/i.test(String(bus?.vehicle?.name || ""))) {
    return OPERATOR_LIVERIES.FLIX;
  }
  if (/NATX|NX/i.test(noc)) return OPERATOR_LIVERIES.NATX;

  return null;
}

export function brandColourForBus(bus, fallback = "#2563eb") {
  return brandLiveryForBus(bus)?.colour || fallback;
}
