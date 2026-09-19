/** UK Bus Tracker Plus — client entitlements + paywall. */

import { getUser, openAuthModal, authStatusHtml, refreshSession } from "./auth.js";

export const PLUS_STORAGE_KEY = "uk-bus-plus";
export const PLUS_PRICE_LABEL = String(import.meta.env.VITE_PLUS_PRICE || "£4.99/month").trim();

const FEATURES = {
  announcements: {
    title: "Live announcements",
    blurb: "Spoken next-stop style updates while you follow a bus.",
  },
  "stop-board": {
    title: "Virtual stop board",
    blurb: "Simple route and time board when you tap a stop.",
  },
  history: {
    title: "Extended vehicle history",
    blurb: "Look back 3 or 7 days instead of today only.",
  },
  "bus-photo": {
    title: "Bus photos",
    blurb: "Submit a photo of a bus for the owner to approve on its card.",
  },
};

let modalEl = null;
let statusBtn = null;
let onChangeCb = null;

export function isPlus() {
  if (getUser()?.plus) return true;
  try {
    return localStorage.getItem(PLUS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPlus(on) {
  try {
    if (on) localStorage.setItem(PLUS_STORAGE_KEY, "1");
    else localStorage.removeItem(PLUS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  syncPlusUi();
  onChangeCb?.(isPlus());
}

export function requirePlus(feature = "") {
  if (isPlus()) return true;
  openPlusModal(feature);
  return false;
}

function formatPlusUntil(iso) {
  if (!iso) return "";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return at.toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function syncPlusExpiryUi() {
  const el = modalEl?.querySelector("[data-plus-expiry]");
  const title = modalEl?.querySelector("#plus-modal-title");
  const cancelBtn = modalEl?.querySelector("[data-plus-cancel]");
  const checkout = modalEl?.querySelector("[data-plus-checkout]");
  if (!el) return;
  const user = getUser();
  if (user?.plus) {
    const until = formatPlusUntil(user.plusUntil);
    el.hidden = false;
    if (user.plusCancelled) {
      el.innerHTML = until
        ? `Plus cancelled. You keep access until <strong>${esc(until)}</strong>, then it will not renew.`
        : `Plus is cancelled on this account.`;
    } else {
      el.innerHTML = until
        ? `Your Plus is active until <strong>${esc(until)}</strong>`
        : `Your Plus is active on this account`;
    }
    if (title) title.textContent = "Your Plus";
    if (cancelBtn) {
      cancelBtn.hidden = false;
      cancelBtn.disabled = Boolean(user.plusCancelled);
      cancelBtn.textContent = user.plusCancelled ? "Plus cancelled" : "Cancel Plus";
    }
    if (checkout) checkout.hidden = !user.plusCancelled;
    if (checkout && user.plusCancelled) checkout.textContent = `Resubscribe · ${PLUS_PRICE_LABEL}`;
    return;
  }
  if (isPlus()) {
    el.hidden = false;
    el.innerHTML = `Plus is active on this device. <strong>Log in</strong> to manage or cancel on your account.`;
    if (title) title.textContent = "Plus";
    if (cancelBtn) {
      cancelBtn.hidden = false;
      cancelBtn.disabled = false;
      cancelBtn.textContent = "Turn off Plus on this device";
    }
    if (checkout) checkout.hidden = true;
    return;
  }
  el.hidden = true;
  el.textContent = "";
  if (title) title.textContent = "Go Plus";
  if (cancelBtn) cancelBtn.hidden = true;
  if (checkout) {
    checkout.hidden = false;
    checkout.innerHTML = `Pay with PayPal · <span data-plus-price>${esc(PLUS_PRICE_LABEL)}</span>`;
  }
}

export function openPlusModal(feature = "") {
  ensureModal();
  if (!modalEl) return;
  const info = FEATURES[feature];
  const featureEl = modalEl.querySelector("[data-plus-feature]");
  if (featureEl) {
    if (info) {
      featureEl.hidden = false;
      featureEl.innerHTML = `<strong>${esc(info.title)}</strong> is a Plus feature. ${esc(info.blurb)}`;
    } else if (isPlus()) {
      featureEl.hidden = false;
      const until = formatPlusUntil(getUser()?.plusUntil);
      const user = getUser();
      featureEl.innerHTML = user?.plus
        ? `<strong>Plus is on your account</strong> (${esc(user.email)})${
            until ? ` · ${user.plusCancelled ? "cancelled · access until" : "expires"} <strong>${esc(until)}</strong>` : ""
          }. Log in on another device to use it there.`
        : `<strong>Plus is active.</strong> Log in with the account that paid so it syncs on other devices.`;
    } else {
      featureEl.hidden = true;
      featureEl.textContent = "";
    }
  }
  syncPlusExpiryUi();
  const accountEl = modalEl.querySelector("[data-plus-account]");
  if (accountEl) accountEl.innerHTML = authStatusHtml();
  const err = modalEl.querySelector("[data-plus-error]");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  modalEl.hidden = false;
  modalEl.querySelector("[data-plus-close]")?.focus?.();
}

export function closePlusModal() {
  if (modalEl) modalEl.hidden = true;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ensureModal() {
  if (modalEl) return;
  modalEl = document.getElementById("plus-modal");
  if (!modalEl) return;

  modalEl.querySelectorAll("[data-plus-close]").forEach((btn) => {
    btn.addEventListener("click", () => closePlusModal());
  });
  modalEl.addEventListener("click", (event) => {
    if (event.target === modalEl) closePlusModal();
    if (event.target.closest?.("[data-plus-open-auth]")) {
      event.preventDefault();
      openAuthModal("signup");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modalEl && !modalEl.hidden) closePlusModal();
  });

  modalEl.querySelector("[data-plus-checkout]")?.addEventListener("click", () => startCheckout());
  modalEl.querySelector("[data-plus-cancel]")?.addEventListener("click", () => cancelPlus());
}

async function cancelPlus() {
  showError("");
  const user = getUser();
  if (!user) {
    // Device-only Plus with no account.
    if (!confirm("Turn off Plus on this device?")) return;
    setPlus(false);
    syncPlusExpiryUi();
    return;
  }
  if (user.plusCancelled) {
    showError("Plus is already cancelled on this account.");
    return;
  }
  const until = formatPlusUntil(user.plusUntil);
  const ok = confirm(
    until
      ? `Cancel Plus? You will keep access until ${until}, then it will not renew.`
      : "Cancel Plus on your account? You can subscribe again any time.",
  );
  if (!ok) return;

  const btn = modalEl?.querySelector("[data-plus-cancel]");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/plus/cancel", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not cancel Plus");
    await refreshSession();
    if (!getUser()?.plus) setPlus(false);
    else syncPlusUi();
    openPlusModal();
    showError(data.message || "Plus cancelled.");
  } catch (error) {
    showError(error.message || "Could not cancel Plus");
  } finally {
    if (btn) btn.disabled = Boolean(getUser()?.plusCancelled);
  }
}

function showError(message) {
  const err = modalEl?.querySelector("[data-plus-error]");
  if (!err) return;
  err.hidden = !message;
  err.textContent = message || "";
}

async function startCheckout() {
  showError("");
  if (!getUser()) {
    showError("Create an account and log in before paying — Plus is saved to your account.");
    openAuthModal("signup");
    return;
  }
  const btn = modalEl?.querySelector("[data-plus-checkout]");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/plus/checkout", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    if (data.alreadyPlus) {
      setPlus(true);
      await refreshSession();
      closePlusModal();
      return;
    }
    if (!res.ok || !data.url) {
      throw new Error(data.error || "Checkout is not set up yet.");
    }
    window.location.href = data.url;
  } catch (error) {
    showError(error.message || "Could not start checkout");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handlePlusReturn() {
  const params = new URLSearchParams(window.location.search);
  const flag = params.get("plus");
  if (!flag) return;

  const clean = () => {
    params.delete("plus");
    params.delete("session_id");
    params.delete("reason");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  };

  if (flag === "success") {
    const sessionId = params.get("session_id") || "";
    if (sessionId) {
      try {
        const res = await fetch(`/api/plus/verify?session_id=${encodeURIComponent(sessionId)}`, {
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          setPlus(true);
          await refreshSession();
          clean();
          openPlusModal();
          return;
        }
      } catch {
        /* fall through to session refresh */
      }
    }
    await refreshSession();
    if (getUser()?.plus) setPlus(true);
    clean();
    openPlusModal();
    return;
  }

  if (flag === "cancel") {
    clean();
    openPlusModal();
    showError("Payment cancelled. You can try again whenever you’re ready.");
    return;
  }

  if (flag === "error") {
    const reason = params.get("reason") || "Payment could not be confirmed.";
    clean();
    openPlusModal();
    showError(reason);
  }
}

function syncPlusUi() {
  const on = isPlus();
  document.documentElement.dataset.plus = on ? "1" : "0";
  if (statusBtn) {
    statusBtn.textContent = on ? "Plus" : "Go Plus";
    statusBtn.classList.toggle("is-plus", on);
    statusBtn.setAttribute("aria-pressed", on ? "true" : "false");
    const until = formatPlusUntil(getUser()?.plusUntil);
    statusBtn.title = on
      ? until
        ? `Plus active until ${until}`
        : "UK Bus Tracker Plus is active"
      : "Unlock Plus features";
  }
  const priceEls = document.querySelectorAll("[data-plus-price]");
  priceEls.forEach((el) => {
    el.textContent = PLUS_PRICE_LABEL;
  });
  const accountEl = modalEl?.querySelector("[data-plus-account]");
  if (accountEl && modalEl && !modalEl.hidden) accountEl.innerHTML = authStatusHtml();
  if (modalEl && !modalEl.hidden) syncPlusExpiryUi();
}

export function setupPlus({ onChange } = {}) {
  onChangeCb = typeof onChange === "function" ? onChange : null;
  statusBtn = document.getElementById("plus-btn");
  ensureModal();
  syncPlusUi();

  statusBtn?.addEventListener("click", () => openPlusModal());
  window.addEventListener("uk-bus-cancel-plus", () => {
    ensureModal();
    cancelPlus();
  });

  handlePlusReturn().then(() => {
    onChangeCb?.(isPlus());
  });
}

/** Call when auth session changes so Plus follows the account. */
export function syncPlusFromAccount(user) {
  if (user?.plus) setPlus(true);
  else {
    try {
      localStorage.removeItem(PLUS_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    syncPlusUi();
  }
  onChangeCb?.(isPlus());
}
