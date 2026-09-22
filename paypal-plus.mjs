/** PayPal Checkout (Orders API) for UK Bus Tracker Plus. */

const SANDBOX = String(process.env.PAYPAL_MODE || "").toLowerCase() === "sandbox";
const API_BASE = SANDBOX ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";

let cachedToken = null;
let cachedTokenExp = 0;

export function paypalConfigured() {
  return Boolean(
    String(process.env.PAYPAL_CLIENT_ID || "").trim() &&
      String(process.env.PAYPAL_CLIENT_SECRET || "").trim(),
  );
}

export function plusAmount() {
  const raw = String(process.env.PLUS_AMOUNT || "2.99").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : "2.99";
}

export function plusCurrency() {
  return String(process.env.PLUS_CURRENCY || "GBP").trim().toUpperCase() || "GBP";
}

async function paypalToken() {
  const id = String(process.env.PAYPAL_CLIENT_ID || "").trim();
  const secret = String(process.env.PAYPAL_CLIENT_SECRET || "").trim();
  if (!id || !secret) throw Object.assign(new Error("PayPal is not configured"), { status: 503 });

  if (cachedToken && Date.now() < cachedTokenExp - 30_000) return cachedToken;

  const auth = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw Object.assign(new Error(data?.error_description || "PayPal auth failed"), { status: 502 });
  }
  cachedToken = data.access_token;
  cachedTokenExp = Date.now() + Number(data.expires_in || 300) * 1000;
  return cachedToken;
}

async function paypalFetch(path, { method = "GET", body } = {}) {
  const token = await paypalToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.message ||
      data?.details?.[0]?.description ||
      data?.error_description ||
      `PayPal request failed (${res.status})`;
    throw Object.assign(new Error(msg), { status: 502, details: data });
  }
  return data;
}

export async function createPlusOrder({ userId, email, origin }) {
  const amount = plusAmount();
  const currency = plusCurrency();
  const returnUrl = `${origin}/api/plus/paypal/return`;
  const cancelUrl = `${origin}/api/plus/paypal/cancel`;

  const order = await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          custom_id: String(userId),
          description: "UK Bus Tracker Plus",
          amount: {
            currency_code: currency,
            value: amount,
          },
        },
      ],
      application_context: {
        brand_name: "UK Bus Tracker",
        landing_page: "NO_PREFERENCE",
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING",
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
      payer: email ? { email_address: email } : undefined,
    },
  });

  const approve = (order.links || []).find((link) => link.rel === "approve");
  if (!approve?.href) {
    throw Object.assign(new Error("PayPal did not return an approval link"), { status: 502 });
  }
  return { id: order.id, url: approve.href };
}

export async function capturePlusOrder(orderId) {
  const id = String(orderId || "").trim();
  if (!id) throw Object.assign(new Error("Missing PayPal order id"), { status: 400 });

  const captured = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
    method: "POST",
    body: {},
  });

  const status = String(captured.status || "").toUpperCase();
  const unit = captured.purchase_units?.[0] || {};
  const capture = unit.payments?.captures?.[0] || {};
  const captureStatus = String(capture.status || "").toUpperCase();
  const customId = String(unit.custom_id || capture.custom_id || "").trim();
  const userId = Number(customId);
  const paid = status === "COMPLETED" || captureStatus === "COMPLETED";
  if (!paid) {
    throw Object.assign(new Error("PayPal payment was not completed"), { status: 402 });
  }
  if (!Number.isFinite(userId) || userId <= 0) {
    throw Object.assign(new Error("PayPal order is missing account reference"), { status: 502 });
  }

  return {
    orderId: id,
    userId,
    status,
    captureStatus,
    amount: capture.amount?.value || unit.amount?.value || plusAmount(),
    currency: capture.amount?.currency_code || plusCurrency(),
  };
}
