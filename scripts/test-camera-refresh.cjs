/*
 * Behavioural tests for the Cameras tab auto-refresh.
 *
 * The thing that actually matters is the decision inside loadCameraGallery to
 * re-render or not. Getting that wrong is not cosmetic: rebuilding an identical
 * grid re-downloads every thumbnail, throws away the scroll position and
 * restarts every coach close-up, and a naive "just poll and re-render" does it
 * every 30 seconds.
 *
 * So the function is extracted from the real source and run against a fake DOM
 * and a fake fetch, and the assertions are about what happened to the page.
 */
const fs = require("fs");

const source = fs.readFileSync("src/main.js", "utf8");

/** Pull one top-level function declaration out of the source by name. */
function extractFn(name) {
  const start = source.search(new RegExp(`^(async )?function ${name}\\b`, "m"));
  if (start < 0) throw new Error(`${name} not found`);
  const close = /\r?\n\}\r?\n/g;
  close.lastIndex = start;
  const m = close.exec(source);
  if (!m) throw new Error(`end of ${name} not found`);
  return source.slice(start, m.index + m[0].length);
}

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const cameraPhotoTime = (ts) => (ts ? String(ts) : "");

const factory = new Function(
  "deps",
  `
  const {
    esc, cameraPhotoTime, zoomGalleryHits, document: doc,
    setInterval, clearInterval,
  } = deps;
  const { camerasGridEl, camerasEmptyEl, camerasCountEl, camerasUpdatedEl,
          camerasOnlyHitsEl, camerasOnlyReadableEl } = deps;
  // The extracted code refers to the real globals, so they have to exist under
  // those names in here. The destructured setInterval/clearInterval above shadow
  // the real ones inside this scope, which is the point: the test needs to count
  // the timers rather than actually start them.
  const document = doc;
  // In the app appTab is a plain string variable, not an object. Modelling it as
  // an object would make every comparison against "cameras" silently false.
  let appTab = deps.appTab;
  let cameraGalleryLoaded = false;
  let cameraGallerySig = "";
  let camerasRefreshBusy = false;
  let camerasUpdatedAt = 0;
  let camerasRefreshTimer = null;
  const CAMERAS_REFRESH_MS = 30000;
  ${extractFn("cameraGallerySignature")}
  ${extractFn("markGalleryUpdated")}
  ${extractFn("loadCameraGallery")}
  ${extractFn("syncCameraGalleryPolling")}
  return {
    loadCameraGallery,
    syncCameraGalleryPolling,
    setTab: (t) => { appTab = t; },
    state: () => ({ loaded: cameraGalleryLoaded, sig: cameraGallerySig, busy: camerasRefreshBusy,
                    timer: camerasRefreshTimer, updatedAt: camerasUpdatedAt }),
  };
`,
);

/** A stand-in element that records every write to innerHTML. */
function el() {
  return {
    innerHTML: "",
    textContent: "",
    hidden: false,
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    // No element is mid-press in these tests; a test that needs one sets this.
    _activeInside: null,
    querySelector: function (sel) {
      return sel === ":active" ? this._activeInside : null;
    },
    _writes: 0,
  };
}
function trackWrites(e) {
  let html = "";
  Object.defineProperty(e, "innerHTML", {
    get: () => html,
    set: (v) => {
      html = v;
      e._writes += 1;
    },
  });
  return e;
}

function makeHarness({ responses }) {
  const grid = trackWrites(el());
  const state = {
    grid,
    count: el(),
    updated: el(),
    empty: el(),
    hits: { checked: false },
    readable: { checked: true },
    appTab: "map",
    fetched: 0,
    crops: 0,
    timers: [],
    cleared: [],
    docHidden: false,
  };
  const api = factory({
    camerasGridEl: grid,
    camerasEmptyEl: state.empty,
    camerasCountEl: state.count,
    camerasUpdatedEl: state.updated,
    camerasOnlyHitsEl: state.hits,
    camerasOnlyReadableEl: state.readable,
    appTab: state.appTab,
    esc,
    cameraPhotoTime,
    zoomGalleryHits: () => {
      state.crops += 1;
    },
    document: {
      get hidden() {
        return state.docHidden;
      },
      addEventListener() {},
    },
    setInterval: (fn, ms) => {
      state.timers.push(ms);
      return state.timers.length;
    },
    clearInterval: (id) => state.cleared.push(id),
  });
  state.api = api;
  state.state = api.state;
  let n = 0;
  state.fetchImpl = async () => {
    const r = responses[Math.min(n, responses.length - 1)];
    n += 1;
    state.fetched += 1;
    if (r === null) return { ok: false, status: 500, json: async () => null };
    if (r === "throw") throw new Error("network down");
    return { ok: true, json: async () => r };
  };
  return state;
}

const shot = (key, over = {}) => ({
  key,
  label: `Coach ${key}`,
  road: "M6",
  desc: "J10",
  distanceM: 40,
  takenAt: 1700000000000,
  shotCount: 3,
  busDetected: true,
  busConfidence: 0.5,
  readable: true,
  busBox: null,
  image: `/api/camera-snapshot/${key}.jpg`,
  link: `/?bus=${key}`,
  ...over,
});

let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
};

// Build a run with a controllable fetch, returning the harness plus a promise
// wrapper so each test reads as a sequence.
function scenario(responses) {
  const h = makeHarness({ responses });
  global.fetch = h.fetchImpl;
  return h;
}

(async () => {
  // 1. First load renders.
  {
    const h = scenario([{ photos: [shot("AAA"), shot("BBB")], captured: 7 }]);
    await h.api.loadCameraGallery();
    ok("first load renders the grid", h.grid._writes >= 1);
    ok("first load draws both cards", /AAA/.test(h.grid.innerHTML) && /BBB/.test(h.grid.innerHTML));
    ok("first load reports what is hidden", /5 hidden/.test(h.count.textContent), h.count.textContent);
    ok("coach close-ups run once", h.crops === 1);
  }

  // 2. An unchanged poll must NOT rebuild the grid.
  {
    const payload = { photos: [shot("AAA"), shot("BBB")], captured: 7 };
    const h = scenario([payload, payload, payload]);
    await h.api.loadCameraGallery();
    const writesAfterFirst = h.grid._writes;
    const cropsAfterFirst = h.crops;
    await h.api.loadCameraGallery({ force: true, quiet: true });
    await h.api.loadCameraGallery({ force: true, quiet: true });
    ok("an unchanged poll does not rebuild the grid", h.grid._writes === writesAfterFirst,
      `writes went ${writesAfterFirst} -> ${h.grid._writes}`);
    ok("an unchanged poll does not re-run the close-ups", h.crops === cropsAfterFirst);
    ok("an unchanged poll still reports it checked", /just now|updated/.test(h.updated.textContent),
      h.updated.textContent);
  }

  // 3. A changed poll must rebuild.
  {
    const h = scenario([
      { photos: [shot("AAA")], captured: 7 },
      { photos: [shot("AAA"), shot("NEW")], captured: 8 },
    ]);
    await h.api.loadCameraGallery();
    const before = h.grid._writes;
    await h.api.loadCameraGallery({ force: true, quiet: true });
    ok("a new photo rebuilds the grid", h.grid._writes > before);
    ok("the new photo is on screen", /NEW/.test(h.grid.innerHTML));
  }

  // 4. A new detection on an existing coach must rebuild - the whole point.
  {
    const h = scenario([
      { photos: [shot("AAA", { busDetected: false, busBox: null })], captured: 7 },
      { photos: [shot("AAA", { busDetected: true, busBox: [1, 2, 3, 4] })], captured: 7 },
    ]);
    await h.api.loadCameraGallery();
    const before = h.grid._writes;
    ok("a coach with nothing in frame shows the no-coach badge",
      /no coach in frame/.test(h.grid.innerHTML));
    await h.api.loadCameraGallery({ force: true, quiet: true });
    ok("a coach newly detected rebuilds and shows the badge", h.grid._writes > before &&
      /coach in frame/.test(h.grid.innerHTML));
  }

  // 5. A background pass must not blank the grid.
  {
    const h = scenario([{ photos: [shot("AAA")], captured: 7 }]);
    await h.api.loadCameraGallery();
    const html = h.grid.innerHTML;
    h.grid._writes = 0;
    await h.api.loadCameraGallery({ force: true, quiet: true });
    ok("a quiet pass never writes Loading", !/Loading photos/.test(h.grid.innerHTML));
    ok("a quiet pass leaves the rendered HTML alone", h.grid._writes === 0);
    ok("the photos were still on screen", /AAA/.test(h.grid.innerHTML) && html.length > 0);
  }

  // 5b. A click in progress must not be thrown away by a re-render.
  {
    const h = scenario([
      { photos: [shot("AAA")], captured: 7 },
      { photos: [shot("AAA"), shot("NEW")], captured: 8 },
    ]);
    await h.api.loadCameraGallery();
    h.grid._activeInside = {}; // the user is mid-click on a card
    const before = h.grid._writes;
    await h.api.loadCameraGallery({ force: true, quiet: true });
    ok("a re-render is deferred while a card is being pressed", h.grid._writes === before);
    ok("the click target is still the old card", !/NEW/.test(h.grid.innerHTML));
    h.grid._activeInside = null;
    await h.api.loadCameraGallery({ force: true, quiet: true });
    ok("the deferred photo appears on the next pass", /NEW/.test(h.grid.innerHTML));
  }

  // 6. A failure must not claim there are no photos.
  {
    const h = scenario([{ photos: [shot("AAA")], captured: 7 }, "throw", { ok: false }]);
    await h.api.loadCameraGallery();
    await h.api.loadCameraGallery({ force: true, quiet: true });
    ok("a failed pass keeps the photos on screen", /AAA/.test(h.grid.innerHTML));
    ok("a failed pass does not say zero", !/none of the|0 shown/.test(h.count.textContent),
      h.count.textContent);
  }

  {
    const h = scenario(["throw"]);
    await h.api.loadCameraGallery();
    ok("a failure on first load says so plainly", /Could not reach/.test(h.grid.innerHTML));
  }

  // 7. Overlapping requests must not stack up.
  {
    const h = scenario([{ photos: [shot("AAA")], captured: 1 }]);
    const a = h.api.loadCameraGallery({ force: true, quiet: true });
    const b = h.api.loadCameraGallery({ force: true, quiet: true });
    await Promise.all([a, b]);
    ok("two passes at once make one request", h.fetched === 1, `fetched ${h.fetched}`);
  }

  // 8. The non-forced call is a no-op once loaded, so tab switches do not refetch.
  {
    const h = scenario([{ photos: [shot("AAA")], captured: 1 }]);
    await h.api.loadCameraGallery();
    await h.api.loadCameraGallery();
    ok("a second plain load does not refetch", h.fetched === 1, `fetched ${h.fetched}`);
  }

  // 9. Timer lifecycle: only while the cameras tab is on screen.
  {
    const h = scenario([{ photos: [shot("AAA")], captured: 1 }]);
    h.api.syncCameraGalleryPolling();
    ok("no timer on another tab", h.state().timer === null);
    h.api.setTab("cameras");
    h.api.syncCameraGalleryPolling();
    ok("a timer starts on the cameras tab", h.state().timer !== null);
    ok("the interval is 30s", h.timers.includes(30000), JSON.stringify(h.timers));
    h.api.setTab("map");
    h.api.syncCameraGalleryPolling();
    ok("the timer is cleared when leaving the tab", h.state().timer === null);
    ok("clearInterval was called", h.cleared.length >= 1);
  }

  {
    const h = scenario([{ photos: [shot("AAA")], captured: 1 }]);
    h.api.setTab("cameras");
    h.docHidden = true;
    h.api.syncCameraGalleryPolling();
    ok("no timer while the page is hidden", h.state().timer === null);
    h.docHidden = false;
    h.api.syncCameraGalleryPolling();
    ok("the timer starts again when the page returns", h.state().timer !== null);
  }

  // 10. Opening the tab refreshes immediately, and the count stays honest.
  {
    const h = scenario([{ photos: [shot("AAA")], captured: 12 }]);
    h.api.setTab("cameras");
    h.api.syncCameraGalleryPolling();
    await new Promise((r) => setTimeout(r, 30));
    ok("opening the tab fetches straight away", h.fetched >= 1);
    ok("only one request despite load + sync", h.fetched === 1, `fetched ${h.fetched}`);
    ok("the hidden count is reported", /11 hidden/.test(h.count.textContent), h.count.textContent);
  }

  console.log(failed ? `\n${failed} failure(s)` : "\ncamera auto-refresh behaves");
  process.exit(failed ? 1 : 0);
})();
