/** Transactional email for Plus purchases (Resend API). */

import { plusAmount, plusCurrency } from "./paypal-plus.mjs";

export function mailConfigured() {
  return Boolean(String(process.env.RESEND_API_KEY || "").trim());
}

function mailFrom() {
  return (
    String(process.env.MAIL_FROM || "").trim() ||
    "UK Bus Tracker <onboarding@resend.dev>"
  );
}

function siteUrl() {
  return (
    String(process.env.PUBLIC_SITE_URL || "").trim().replace(/\/$/, "") ||
    "https://ukbustracker.up.railway.app"
  );
}

function formatMoney(amount, currency) {
  const cur = String(currency || plusCurrency() || "GBP").toUpperCase();
  const value = String(amount || plusAmount());
  if (cur === "GBP") return `£${value}`;
  return `${value} ${cur}`;
}

function formatUkDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function receiptNumber(provider, externalId) {
  const code = String(externalId || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(-10)
    .toUpperCase();
  const prefix = provider === "stripe" ? "STR" : provider === "admin" ? "ADM" : "PPL";
  return `UKBT-${prefix}-${code || "PLUS"}`;
}

function buildPlusThankYou({
  email,
  amount,
  currency,
  orderId,
  provider = "paypal",
  plusUntil = null,
  purchasedAt = new Date().toISOString(),
} = {}) {
  const money = formatMoney(amount, currency);
  const when = formatUkDate(purchasedAt) || formatUkDate(new Date().toISOString());
  const until = formatUkDate(plusUntil);
  const receipt = receiptNumber(provider, orderId);
  const payLabel = provider === "stripe" ? "Stripe" : provider === "admin" ? "Account credit" : "PayPal";
  const site = siteUrl();

  const subject = "Thank you for UK Bus Tracker Plus";
  const text = [
    "Thanks for supporting UK Bus Tracker!",
    "",
    "Your Plus purchase is confirmed. This email is your proof of purchase / receipt.",
    "",
    `Receipt: ${receipt}`,
    `Account: ${email}`,
    `Item: UK Bus Tracker Plus (1 month)`,
    `Amount paid: ${money}`,
    `Payment method: ${payLabel}`,
    `Payment reference: ${orderId || "—"}`,
    `Date: ${when}`,
    until ? `Plus access until: ${until}` : "",
    "",
    "Plus unlocks live announcements, the virtual stop board, longer vehicle history, and bus photo uploads.",
    "",
    `Open the tracker: ${site}`,
    "",
    "If anything looks wrong with this receipt, reply to this email or contact the site owner.",
    "",
    "— Owen · UK Bus Tracker",
  ]
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en-GB">
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,system-ui,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
          <tr>
            <td style="padding:22px 24px 8px;background:#0f172a;color:#f8fafc;">
              <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.75;">UK Bus Tracker</div>
              <div style="font-size:22px;font-weight:800;margin-top:6px;">Thank you for Plus</div>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 24px;">
              <p style="margin:0 0 14px;line-height:1.5;">Thanks for supporting the live map — your Plus purchase is confirmed. Keep this email as your <strong>proof of purchase</strong>.</p>
              <table role="presentation" width="100%" style="border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
                <tr><td style="padding:10px 12px;color:#64748b;font-size:13px;">Receipt</td><td style="padding:10px 12px;text-align:right;font-weight:700;">${escapeHtml(receipt)}</td></tr>
                <tr><td style="padding:10px 12px;color:#64748b;font-size:13px;">Account</td><td style="padding:10px 12px;text-align:right;">${escapeHtml(email)}</td></tr>
                <tr><td style="padding:10px 12px;color:#64748b;font-size:13px;">Item</td><td style="padding:10px 12px;text-align:right;">UK Bus Tracker Plus (1 month)</td></tr>
                <tr><td style="padding:10px 12px;color:#64748b;font-size:13px;">Amount paid</td><td style="padding:10px 12px;text-align:right;font-weight:800;">${escapeHtml(money)}</td></tr>
                <tr><td style="padding:10px 12px;color:#64748b;font-size:13px;">Payment</td><td style="padding:10px 12px;text-align:right;">${escapeHtml(payLabel)}</td></tr>
                <tr><td style="padding:10px 12px;color:#64748b;font-size:13px;">Reference</td><td style="padding:10px 12px;text-align:right;font-family:ui-monospace,monospace;font-size:12px;">${escapeHtml(orderId || "—")}</td></tr>
                <tr><td style="padding:10px 12px;color:#64748b;font-size:13px;">Date</td><td style="padding:10px 12px;text-align:right;">${escapeHtml(when)}</td></tr>
                ${
                  until
                    ? `<tr><td style="padding:10px 12px;color:#64748b;font-size:13px;">Plus until</td><td style="padding:10px 12px;text-align:right;">${escapeHtml(until)}</td></tr>`
                    : ""
                }
              </table>
              <p style="margin:16px 0 0;line-height:1.5;color:#334155;font-size:14px;">Plus unlocks live announcements, the virtual stop board, longer vehicle history, and bus photo uploads.</p>
              <p style="margin:18px 0 0;">
                <a href="${escapeHtml(site)}" style="display:inline-block;background:#fbbf24;color:#111;text-decoration:none;font-weight:800;padding:10px 16px;border-radius:999px;">Open the tracker</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 22px;color:#64748b;font-size:12px;line-height:1.45;">
              If anything looks wrong with this receipt, reply to this email or contact the site owner.<br />— Owen · UK Bus Tracker
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html, receipt };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function sendEmail({ to, subject, text, html } = {}) {
  const key = String(process.env.RESEND_API_KEY || "").trim();
  if (!key) {
    throw Object.assign(new Error("Email is not configured (set RESEND_API_KEY)"), { status: 503 });
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: mailFrom(),
      to: [String(to || "").trim()],
      subject,
      text,
      html,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data?.message || `Email send failed (${res.status})`), {
      status: 502,
      details: data,
    });
  }
  return data;
}

/**
 * Send Plus thank-you + proof of purchase. Safe to call after payment grant.
 * No-ops (with a log) when RESEND_API_KEY is missing so checkout still works.
 */
export async function sendPlusThankYouEmail(opts = {}) {
  const email = String(opts.email || "").trim();
  if (!email) return { skipped: true, reason: "no_email" };
  if (!mailConfigured()) {
    console.warn("[mail] RESEND_API_KEY missing — Plus thank-you email skipped");
    return { skipped: true, reason: "not_configured" };
  }
  const built = buildPlusThankYou(opts);
  const result = await sendEmail({
    to: email,
    subject: built.subject,
    text: built.text,
    html: built.html,
  });
  console.log(`[mail] Plus thank-you sent to ${email} (${built.receipt})`);
  return { ok: true, receipt: built.receipt, id: result?.id || null };
}
