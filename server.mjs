import express from "express";
import compression from "compression";
import { createProxyMiddleware } from "http-proxy-middleware";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleBodsOccupancy, handleBodsVehicles } from "./bods-occupancy.js";
import {
  initAuthStore,
  hasDatabase,
  createUser,
  authenticateUser,
  userFromRequest,
  publicUser,
  signSession,
  sessionCookie,
  setUserPlus,
  grantPlusByEmail,
  cancelUserPlus,
  userHasPlus,
} from "./auth-store.mjs";
import { paypalConfigured, createPlusOrder, capturePlusOrder, plusAmount, plusCurrency } from "./paypal-plus.mjs";
import {
  initPhotoStore,
  photosEnabled,
  submitBusPhoto,
  getApprovedPhotoForReg,
  getPhotoImage,
  listPendingPhotos,
  listRecentPhotos,
  setPhotoStatus,
  deletePhoto,
  decodeDataUrlOrBase64,
  requireAdminSecret,
  compactRegKey,
} from "./photo-store.mjs";

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
    const original = req?.originalUrl || raw;
    const qIdx = raw.indexOf("?");
    const oqIdx = original.indexOf("?");
    const pathname = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const query =
      (qIdx >= 0 ? raw.slice(qIdx) : "") ||
      (oqIdx >= 0 ? original.slice(oqIdx) : "");
    if (file) return `${destBase}${query}`;

    const suffix = !pathname || pathname === "/" ? "" : pathname;
    // Keep a trailing slash on collection endpoints. Bustimes 301s `/api/vehicles` →
    // `/api/vehicles/`; following that relative redirect can re-enter this app and hit
    // the `/api/vehicles` → vehicles.json proxy instead of the REST API.
    const base = destBase.replace(/\/$/, "");
    const path = suffix ? `${base}${suffix}` : `${base}/`;
    const withSlash = path.endsWith("/") ? path : `${path}/`;
    return `${withSlash}${query}`;
  };
}

function proxy(options) {
  return createProxyMiddleware({
    changeOrigin: true,
    ...options,
  });
}

const app = express();
app.disable("x-powered-by");
app.use(compression({ threshold: 1024 }));

app.get("/api/bods-occupancy", (req, res) => handleBodsOccupancy(req, res, bodsKey));
app.get("/api/bods-vehicles", (req, res) => handleBodsVehicles(req, res, bodsKey));

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
  "/api/bt-services",
  proxy({
    target: "https://bustimes.org",
    pathRewrite: rewriteMount("/api/services"),
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

app.get("/api/adsb", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const dist = Math.min(Math.max(Number(req.query.dist) || 60, 10), 100);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: "lat and lon required" });
    return;
  }
  try {
    const url = `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`;
    const upstream = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
    });
    const text = await upstream.text();
    res.status(upstream.status).type("application/json").send(text);
  } catch (error) {
    res.status(502).json({ error: error.message || "ADS-B upstream failed" });
  }
});

app.use(express.json({ limit: "900kb" }));

function requestOrigin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host) return "";
  return `${proto}://${host}`;
}

function sendAuthError(res, error) {
  const status = Number(error?.status) || 500;
  res.status(status).json({ error: error?.message || "Request failed" });
}

function adminOk(req, res) {
  try {
    requireAdminSecret(req);
    return true;
  } catch (error) {
    sendAuthError(res, error);
    return false;
  }
}

app.get("/api/bus-photos", async (req, res) => {
  try {
    await initPhotoStore();
    const reg = compactRegKey(req.query?.reg);
    if (!reg) {
      res.status(400).json({ error: "reg required" });
      return;
    }
    const photo = await getApprovedPhotoForReg(reg);
    res.json({ photo });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/bus-photos/:id/image", async (req, res) => {
  try {
    await initPhotoStore();
    const row = await getPhotoImage(req.params.id);
    if (!row?.image) {
      res.status(404).end();
      return;
    }
    // Pending images only for admin (secret); approved are public.
    if (row.status !== "approved") {
      try {
        requireAdminSecret(req);
      } catch {
        res.status(404).end();
        return;
      }
    }
    res.setHeader("Content-Type", row.mime || "image/jpeg");
    res.setHeader("Cache-Control", row.status === "approved" ? "public, max-age=86400" : "no-store");
    res.send(row.image);
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/bus-photos", async (req, res) => {
  try {
    await initPhotoStore();
    if (!photosEnabled()) {
      res.status(503).json({ error: "Photo uploads are not available yet" });
      return;
    }
    const user = await userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "Log in with your Plus account to submit a photo" });
      return;
    }
    if (!user.plus) {
      res.status(403).json({ error: "Plus is required to submit bus photos" });
      return;
    }
    const decoded = decodeDataUrlOrBase64(req.body?.image || req.body?.data);
    const photo = await submitBusPhoto({
      reg: req.body?.reg,
      fleet: req.body?.fleet,
      operator: req.body?.operator,
      mime: req.body?.mime || decoded.mime,
      buffer: decoded.buffer,
      user,
      note: req.body?.note,
      uploaderName: req.body?.uploaderName || req.body?.name || req.body?.credit,
    });
    res.status(201).json({
      ok: true,
      photo,
      message: "Thanks — your photo is waiting for owner approval before it appears on the bus card.",
    });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/bus-photos/admin/pending", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    await initPhotoStore();
    const photos = await listPendingPhotos();
    res.json({ photos });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/bus-photos/admin/list", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    await initPhotoStore();
    const photos = await listRecentPhotos({
      limit: req.query?.limit,
      status: req.query?.status,
    });
    res.json({ photos });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/bus-photos/admin/:id/approve", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    const photo = await setPhotoStatus(req.params.id, "approved");
    res.json({ ok: true, photo });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/bus-photos/admin/:id/reject", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    const photo = await setPhotoStatus(req.params.id, "rejected");
    res.json({ ok: true, photo });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.delete("/api/bus-photos/admin/:id", async (req, res) => {
  if (!adminOk(req, res)) return;
  try {
    const result = await deletePhoto(req.params.id);
    res.json(result);
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/auth/config", (_req, res) => {
  res.json({ accounts: hasDatabase() });
});

app.get("/api/auth/me", async (req, res) => {
  try {
    await initAuthStore();
    const user = await userFromRequest(req);
    res.json({ user: publicUser(user) });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/auth/signup", async (req, res) => {
  try {
    const user = await createUser(req.body?.email, req.body?.password);
    const token = signSession(user);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const user = await authenticateUser(req.body?.email, req.body?.password);
    const token = signSession(user);
    res.setHeader("Set-Cookie", sessionCookie(token));
    res.json({ user: publicUser(user) });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", sessionCookie("", { clear: true }));
  res.json({ ok: true });
});

app.post("/api/auth/admin/grant-plus", async (req, res) => {
  try {
    const secret = String(process.env.AUTH_SECRET || "").trim();
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!secret || !token || token !== secret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const email = String(req.body?.email || "").trim();
    const months = Math.max(1, Number(req.body?.months) || 1);
    if (!email) {
      res.status(400).json({ error: "email required" });
      return;
    }
    const user = await grantPlusByEmail(email, { months });
    res.json({ ok: true, user: publicUser(user) });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.post("/api/plus/cancel", async (req, res) => {
  try {
    await initAuthStore();
    const user = await userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "Log in to cancel Plus on your account." });
      return;
    }
    const updated = await cancelUserPlus(user.id);
    res.setHeader("Set-Cookie", sessionCookie(signSession(updated)));
    const until = updated?.plus_until ? new Date(updated.plus_until) : null;
    const keepsAccess = Boolean(until && until.getTime() > Date.now() && userHasPlus(updated));
    res.json({
      ok: true,
      user: publicUser(updated),
      keepsAccess,
      message: keepsAccess
        ? `Plus cancelled. You keep access until ${until.toLocaleDateString("en-GB", {
            timeZone: "Europe/London",
            day: "numeric",
            month: "short",
            year: "numeric",
          })} — it will not renew after that.`
        : "Plus cancelled on your account. You can subscribe again any time.",
    });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/plus/config", (_req, res) => {
  res.json({
    configured: Boolean(
      paypalConfigured() ||
        (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
    ),
    paypal: paypalConfigured(),
    price: process.env.PLUS_PRICE_LABEL || `£${plusAmount()}/month`,
    amount: plusAmount(),
    currency: plusCurrency(),
    accounts: hasDatabase(),
  });
});

app.post("/api/plus/checkout", async (req, res) => {
  try {
    const user = await userFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "Create an account and log in before paying for Plus." });
      return;
    }
    if (user.plus) {
      res.json({ alreadyPlus: true, user: publicUser(user) });
      return;
    }

    const origin = requestOrigin(req) || "https://ukbustracker.up.railway.app";

    if (paypalConfigured()) {
      const order = await createPlusOrder({
        userId: user.id,
        email: user.email,
        origin,
      });
      res.json({ url: order.url, orderId: order.id, paypal: true });
      return;
    }

    const secret = String(process.env.STRIPE_SECRET_KEY || "").trim();
    const price = String(process.env.STRIPE_PRICE_ID || "").trim();
    if (secret && price) {
      const body = new URLSearchParams({
        mode: "subscription",
        "line_items[0][price]": price,
        "line_items[0][quantity]": "1",
        client_reference_id: String(user.id),
        customer_email: user.email,
        success_url: `${origin}/?plus=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?plus=cancel`,
        allow_promotion_codes: "true",
      });
      const upstream = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      const data = await upstream.json();
      if (!upstream.ok || !data.url) {
        res.status(502).json({ error: data?.error?.message || "Stripe checkout failed" });
        return;
      }
      res.json({ url: data.url, id: data.id });
      return;
    }

    res.status(503).json({
      error:
        "Plus payments need PayPal API keys (PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET). paypal.me links cannot confirm payment automatically.",
    });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/plus/paypal/return", async (req, res) => {
  const origin = requestOrigin(req) || "https://ukbustracker.up.railway.app";
  const orderId = String(req.query.token || req.query.order_id || "").trim();
  try {
    if (!paypalConfigured()) {
      res.redirect(302, `${origin}/?plus=error&reason=paypal_not_configured`);
      return;
    }
    const paid = await capturePlusOrder(orderId);
    const updated = await setUserPlus(paid.userId, true);
    if (!updated) {
      res.redirect(302, `${origin}/?plus=error&reason=account_missing`);
      return;
    }
    const sessionUser = await userFromRequest(req);
    if (sessionUser && Number(sessionUser.id) === Number(updated.id)) {
      res.setHeader("Set-Cookie", sessionCookie(signSession(updated)));
    }
    res.redirect(302, `${origin}/?plus=success`);
  } catch (error) {
    const reason = encodeURIComponent(error?.message || "payment_failed");
    res.redirect(302, `${origin}/?plus=error&reason=${reason}`);
  }
});

app.get("/api/plus/paypal/cancel", (req, res) => {
  const origin = requestOrigin(req) || "https://ukbustracker.up.railway.app";
  res.redirect(302, `${origin}/?plus=cancel`);
});

app.get("/api/plus/verify", async (req, res) => {
  const sessionId = String(req.query.session_id || "").trim();
  const secret = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!sessionId) {
    res.status(400).json({ ok: false, error: "session_id required" });
    return;
  }
  if (!secret) {
    res.status(503).json({ ok: false, error: "Stripe verify is not configured" });
    return;
  }
  try {
    const upstream = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(502).json({ ok: false, error: data?.error?.message || "Verify failed" });
      return;
    }
    const paid = data.payment_status === "paid" || data.status === "complete";
    if (!paid) {
      res.json({ ok: false, status: data.status, payment_status: data.payment_status });
      return;
    }
    const refId = Number(data.client_reference_id || 0);
    let user = null;
    if (Number.isFinite(refId) && refId > 0) {
      user = await setUserPlus(refId, true);
    } else {
      const sessionUser = await userFromRequest(req);
      if (sessionUser) user = await setUserPlus(sessionUser.id, true);
    }
    if (!user) {
      res.status(401).json({
        ok: false,
        error: "Payment received but no account was linked. Log in and contact support.",
      });
      return;
    }
    res.setHeader("Set-Cookie", sessionCookie(signSession(user)));
    res.json({ ok: true, user: publicUser(user) });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message || "Verify failed" });
  }
});

initAuthStore().catch((error) => {
  console.error("[auth] init failed", error?.message || error);
});
initPhotoStore().catch((error) => {
  console.error("[photos] init failed", error?.message || error);
});

app.use(
  express.static(distDir, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache");
        return;
      }
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return;
      }
      res.setHeader("Cache-Control", "public, max-age=86400");
    },
  }),
);
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(distDir, "index.html"), (err) => {
    if (err) next(err);
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`UK Bus Tracker listening on http://0.0.0.0:${port}`);
});
