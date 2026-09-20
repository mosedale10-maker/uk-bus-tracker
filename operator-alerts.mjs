/** Fetch public Stoke-on-Trent operator service updates into service_notices. */

import {
  deactivateMissingOperatorNotices,
  initNoticeStore,
  noticesEnabled,
  upsertOperatorNotice,
} from "./notice-store.mjs";

/** Stoke-on-Trent / Potteries conurbation only (not wider Staffordshire). */
const STOKE_AREA_HINT =
  /\b(stoke(?:[\s-]?on[\s-]?trent)?|potteries|hanley|longton|meir|fenton|burslem|tunstall|bentilee|trentham|sideway|shelton|penkhull|blurton|smallthorne|norton(?:[\s-]?in[\s-]?the[\s-]?moors)?|abbey hulton|birches head|cliffe vale|etruria|cobridge|sneyd|packmoor|chell|bradeley|ubberley|weston coyney|lightwood|wood lane|kee?le|chesterton|newcastle(?:[\s-]?under[\s-]?lyme)?|kidsgrove|audley|talke|wolstanton|knutton|silverdale|madeley)\b/i;

/** Out-of-area places — drop if present without a clear Stoke/Potteries place. */
const OUTSIDE_STOKE_HINT =
  /\b(stone|stafford|leek|cheadle|uttoxeter|cannock|burton|bollington|macclesfield|congleton|crewe|nantwich|alsager|sandbach|winsford|northwich|whitchurch|market drayton|shrewsbury|eccleshall|swynnerton|yarnfield|aston lodge|chaserider|biddulph|endon|alton|cheshire|greater manchester)\b/i;

function isStokeAreaAlert(text) {
  const t = String(text || "");
  if (!STOKE_AREA_HINT.test(t)) return false;
  // e.g. "Stone – Aston Lodge" must not slip through on a weak match.
  if (
    OUTSIDE_STOKE_HINT.test(t) &&
    !/\b(hanley|longton|meir|fenton|burslem|tunstall|bentilee|stoke|potteries|newcastle|kidsgrove|chesterton|kee?le|wood lane|trentham|sideway|blurton|shelton|penkhull)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  return true;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;|&#8217;|&#39;|&apos;/g, "'")
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function hashKey(parts) {
  const raw = parts.map((p) => String(p || "").trim().toLowerCase()).join("|");
  let h = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; uk-bus-tracker/1.0; +https://ukbustracker.up.railway.app)",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const text = await res.text();
  if (!text || text.length < 200) throw new Error(`${url} → empty body (${text.length})`);
  return text;
}

function parseDgPanels(html) {
  // Split mid-opening-tag: class is "panel panel-service-update list wow fadeIn"
  const chunks = html.split(/<div class="panel panel-service-update/i).slice(1);
  const items = [];
  for (const raw of chunks) {
    // Drop leftover attributes from the split opening tag, then take the panel body.
    const afterTag = raw.includes(">") ? raw.slice(raw.indexOf(">") + 1) : raw;
    const bodyOpen = afterTag.match(/<div class="panel-body">([\s\S]*)$/i)?.[1] || afterTag;
    // panel-body has no nested divs on D&G; stop at its closing tag (avoids page footer on last panel).
    const bodyHtml = bodyOpen.split(/<\/div>/i)[0] || bodyOpen;
    const titleHtml = bodyHtml.match(/<h5 class="title[^"]*"[^>]*>([\s\S]*?)<\/h5>/i)?.[1] || "";
    let title = stripHtml(titleHtml.replace(/<small[\s\S]*?<\/small>/gi, " "));
    title = title.replace(/\bDate:\s*.+$/i, "").replace(/\s+/g, " ").trim();
    let block = stripHtml(bodyHtml.slice(0, 3500));
    block = block
      .replace(/\bLinks\b[\s\S]*$/i, "")
      .replace(/\bContactless Card Payment History\b[\s\S]*$/i, "")
      .replace(/\bPrivacy Policy\b[\s\S]*$/i, "")
      .trim();
    if (!block || block.length < 40) continue;
    if (!isStokeAreaAlert(block)) continue;
    if (!title || title.length < 4 || /wow fadeIn|data-wow/i.test(title)) {
      title =
        block.match(/^(Service\s+[\dA-Za-z,\s/-]{1,40})/i)?.[1] ||
        block.match(/^([^.\n]{8,90}?)(?:\s+Date:|\s+Road Closed:)/i)?.[1] ||
        block.slice(0, 72);
    }
    title = String(title).trim();
    const routes =
      (block.match(/Affected Services?:\s*([^\n]+)/i)?.[1] ||
        block.match(/Service affected:\s*([^\n]+)/i)?.[1] ||
        block.match(/\b(\d[\dA-Za-z,\s/&-]{0,40})\s+(?:Meir|Hanley|Kidsgrove|Newcastle|Longton|Fenton|Burslem|Tunstall|Stoke)/i)?.[1] ||
        "")
        .replace(/\s+/g, " ")
        .replace(/\b(Links|Contact|About|Privacy)\b.*$/i, "")
        .trim()
        .slice(0, 120);
    const body = block.slice(0, 700).trim();
    items.push({
      title: title.slice(0, 140),
      body,
      routes,
      key: `dg:${hashKey([title, routes, body.slice(0, 120)])}`,
    });
  }
  return items.slice(0, 25);
}

function parseFirstPotteries(html) {
  const text = stripHtml(html);
  if (/you.?re good to go|there are currently no issues/i.test(text)) {
    return [
      {
        title: "First Potteries · no current issues",
        body: "First Bus Potteries reports no current service issues.",
        routes: "",
        key: "first:no-issues",
        priority: 10,
      },
    ];
  }
  const items = [];
  const alertBlocks = [...html.matchAll(/<article[\s\S]{0,40}?class="[^"]*"[^>]*>([\s\S]*?)<\/article>/gi)];
  for (const match of alertBlocks.slice(0, 15)) {
    const block = stripHtml(match[1]);
    if (block.length < 40) continue;
    const title = block.slice(0, 90).split(/Effective|Share this/i)[0].trim();
    if (!title) continue;
    items.push({
      title: title.slice(0, 140),
      body: block.slice(0, 700),
      routes: "",
      key: `first:${hashKey([title, block.slice(0, 100)])}`,
    });
  }
  if (items.length) return items;
  // Drupal body fallback: grab paragraphs under the page content column.
  const content =
    html.match(/<div class="order-2[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i)?.[1] || "";
  const paras = stripHtml(content).split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 40);
  if (paras.length) {
    return [
      {
        title: "First Potteries · current issues",
        body: paras.slice(0, 4).join("\n").slice(0, 700),
        routes: "",
        key: `first:${hashKey([paras[0].slice(0, 100)])}`,
        priority: 50,
      },
    ];
  }
  return [
    {
      title: "First Potteries · service updates",
      body: "See First Bus Potteries current issues for the latest travel alerts.",
      routes: "",
      key: "first:page",
      priority: 20,
    },
  ];
}

async function syncDg() {
  const url = "https://www.dgbus.co.uk/service-updates/";
  const html = await fetchText(url);
  const items = parseDgPanels(html);
  const keys = [];
  for (const item of items) {
    await upsertOperatorNotice({
      externalKey: item.key,
      title: item.title,
      body: item.body,
      operator: "D&G Bus",
      routes: item.routes,
      area: "Stoke-on-Trent",
      sourceUrl: url,
      priority: 45,
    });
    keys.push(item.key);
  }
  await deactivateMissingOperatorNotices("dg:", keys);
  return keys.length;
}

async function syncFirst() {
  const url = "https://www.firstbus.co.uk/potteries/news-and-service-updates/current-issues";
  const html = await fetchText(url);
  const items = parseFirstPotteries(html);
  const keys = [];
  for (const item of items) {
    await upsertOperatorNotice({
      externalKey: item.key,
      title: item.title,
      body: item.body,
      operator: "First Potteries",
      routes: item.routes,
      area: "Stoke-on-Trent",
      sourceUrl: url,
      priority: item.priority ?? 50,
    });
    keys.push(item.key);
  }
  await deactivateMissingOperatorNotices("first:", keys);
  return keys.length;
}

let syncing = null;
let lastSyncAt = 0;

export async function syncOperatorAlerts({ force = false } = {}) {
  await initNoticeStore();
  if (!noticesEnabled()) return { ok: false, reason: "no-db" };
  const now = Date.now();
  if (!force && now - lastSyncAt < 4 * 60_000) {
    return { ok: true, skipped: true, lastSyncAt };
  }
  if (syncing) return syncing;
  syncing = (async () => {
    const result = { ok: true, dg: 0, first: 0, errors: [] };
    try {
      result.dg = await syncDg();
    } catch (error) {
      result.errors.push(`D&G: ${error.message || error}`);
    }
    try {
      result.first = await syncFirst();
    } catch (error) {
      result.errors.push(`First: ${error.message || error}`);
    }
    lastSyncAt = Date.now();
    console.log(
      `[notices] operator sync dg=${result.dg} first=${result.first}` +
        (result.errors.length ? ` errors=${result.errors.join("; ")}` : ""),
    );
    return result;
  })();
  try {
    return await syncing;
  } finally {
    syncing = null;
  }
}

export function startOperatorAlertPoller(intervalMs = 10 * 60_000) {
  const run = () => {
    syncOperatorAlerts().catch((error) => {
      console.warn("[notices] operator sync failed", error?.message || error);
    });
  };
  setTimeout(run, 8_000);
  setInterval(run, intervalMs);
}
