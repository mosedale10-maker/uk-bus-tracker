/** Account signup / login UI — syncs Plus across devices. */

let currentUser = null;
let modalEl = null;
let accountBtn = null;
let onAuthChange = null;

export function getUser() {
  return currentUser;
}

export function isLoggedIn() {
  return Boolean(currentUser?.email);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

export async function refreshSession() {
  try {
    const data = await api("/api/auth/me");
    currentUser = data.user || null;
  } catch {
    currentUser = null;
  }
  syncAccountUi();
  onAuthChange?.(currentUser);
  return currentUser;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showAuthError(message) {
  const err = modalEl?.querySelector("[data-auth-error]");
  if (!err) return;
  err.hidden = !message;
  err.textContent = message || "";
}

function setAuthMode(mode) {
  if (!modalEl) return;
  const signup = mode === "signup";
  modalEl.dataset.mode = signup ? "signup" : "login";
  const title = modalEl.querySelector("#auth-modal-title");
  if (title) title.textContent = signup ? "Create account" : "Log in";
  const submit = modalEl.querySelector("[data-auth-submit]");
  if (submit) submit.textContent = signup ? "Sign up" : "Log in";
  const switchBtn = modalEl.querySelector("[data-auth-switch]");
  if (switchBtn) {
    switchBtn.textContent = signup ? "Already have an account? Log in" : "Need an account? Sign up";
  }
  showAuthError("");
}

export function openAuthModal(mode = "login") {
  ensureAuthModal();
  if (!modalEl) return;
  setAuthMode(mode);
  modalEl.hidden = false;
  modalEl.querySelector("#auth-email")?.focus?.();
}

export function closeAuthModal() {
  if (modalEl) modalEl.hidden = true;
}

function syncAccountUi() {
  if (accountBtn) {
    if (currentUser?.email) {
      const label = currentUser.plus ? "Account · Plus" : "Account";
      accountBtn.textContent = label;
      accountBtn.title = currentUser.email;
      accountBtn.classList.add("is-in");
      accountBtn.classList.toggle("is-plus", Boolean(currentUser.plus));
    } else {
      accountBtn.textContent = "Account";
      accountBtn.title = "Sign up or log in";
      accountBtn.classList.remove("is-in", "is-plus");
    }
  }

  const emailEl = modalEl?.querySelector("[data-auth-email]");
  const loggedIn = modalEl?.querySelector("[data-auth-logged-in]");
  const form = modalEl?.querySelector("[data-auth-form]");
  if (emailEl) emailEl.textContent = currentUser?.email || "";
  if (loggedIn) loggedIn.hidden = !currentUser;
  if (form) form.hidden = Boolean(currentUser);
  const cancelBtn = modalEl?.querySelector("[data-auth-cancel-plus]");
  if (cancelBtn) {
    const show = Boolean(currentUser?.plus);
    cancelBtn.hidden = !show;
    cancelBtn.disabled = Boolean(currentUser?.plusCancelled);
    cancelBtn.textContent = currentUser?.plusCancelled ? "Plus cancelled" : "Cancel Plus";
  }
  const reset = modalEl?.querySelector("[data-auth-reset]");
  if (reset && !currentUser) reset.open = false;
  showChangePasswordError("");
  const ok = modalEl?.querySelector("[data-auth-change-ok]");
  if (ok) ok.hidden = true;
}

async function submitAuth(event) {
  event?.preventDefault?.();
  showAuthError("");
  const email = String(modalEl?.querySelector("#auth-email")?.value || "").trim();
  const password = String(modalEl?.querySelector("#auth-password")?.value || "");
  const mode = modalEl?.dataset.mode === "signup" ? "signup" : "login";
  const btn = modalEl?.querySelector("[data-auth-submit]");
  if (btn) btn.disabled = true;
  try {
    const data = await api(mode === "signup" ? "/api/auth/signup" : "/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    currentUser = data.user || null;
    syncAccountUi();
    onAuthChange?.(currentUser);
    closeAuthModal();
  } catch (error) {
    showAuthError(error.message || "Could not continue");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST", body: {} });
  } catch {
    /* ignore */
  }
  currentUser = null;
  syncAccountUi();
  onAuthChange?.(null);
  closeAuthModal();
}

function showChangePasswordError(message) {
  const err = modalEl?.querySelector("[data-auth-change-error]");
  const ok = modalEl?.querySelector("[data-auth-change-ok]");
  if (ok) ok.hidden = true;
  if (!err) return;
  err.hidden = !message;
  err.textContent = message || "";
}

async function submitChangePassword(event) {
  event?.preventDefault?.();
  showChangePasswordError("");
  const form = modalEl?.querySelector("[data-auth-change-password]");
  const currentPassword = String(form?.querySelector("#auth-current-password")?.value || "");
  const newPassword = String(form?.querySelector("#auth-new-password")?.value || "");
  const confirmPassword = String(form?.querySelector("#auth-confirm-password")?.value || "");
  if (newPassword.length < 8) {
    showChangePasswordError("New password must be at least 8 characters");
    return;
  }
  if (newPassword !== confirmPassword) {
    showChangePasswordError("New passwords do not match");
    return;
  }
  const btn = modalEl?.querySelector("[data-auth-change-submit]");
  if (btn) btn.disabled = true;
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: { currentPassword, newPassword },
    });
    form?.reset?.();
    const ok = modalEl?.querySelector("[data-auth-change-ok]");
    if (ok) ok.hidden = false;
  } catch (error) {
    showChangePasswordError(error.message || "Could not update password");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function ensureAuthModal() {
  if (modalEl) return;
  modalEl = document.getElementById("auth-modal");
  if (!modalEl) return;

  modalEl.querySelectorAll("[data-auth-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeAuthModal());
  });
  modalEl.addEventListener("click", (event) => {
    if (event.target === modalEl) closeAuthModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modalEl && !modalEl.hidden) closeAuthModal();
  });
  modalEl.querySelector("[data-auth-form]")?.addEventListener("submit", submitAuth);
  modalEl.querySelector("[data-auth-change-password]")?.addEventListener("submit", submitChangePassword);
  modalEl.querySelector("[data-auth-switch]")?.addEventListener("click", () => {
    setAuthMode(modalEl.dataset.mode === "signup" ? "login" : "signup");
  });
  modalEl.querySelector("[data-auth-logout]")?.addEventListener("click", () => logout());
  modalEl.querySelector("[data-auth-cancel-plus]")?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("uk-bus-cancel-plus"));
  });
}

export function setupAuth({ onChange } = {}) {
  onAuthChange = typeof onChange === "function" ? onChange : null;
  accountBtn = document.getElementById("account-btn");
  ensureAuthModal();
  syncAccountUi();

  accountBtn?.addEventListener("click", () => {
    openAuthModal(currentUser ? "login" : "signup");
    if (currentUser) {
      // Opening while logged in shows account panel.
      setAuthMode("login");
      syncAccountUi();
    }
  });

  return refreshSession();
}

export function authStatusHtml() {
  if (!currentUser) {
    return `<p class="plus-account-note">Create a free account first. Plus is added to your account after PayPal confirms payment.</p>
      <button type="button" class="plus-account-btn" data-plus-open-auth>Sign up / Log in</button>`;
  }
  let plusBit = " · Pay below to unlock Plus";
  if (currentUser.plus) {
    const until = currentUser.plusUntil
      ? new Date(currentUser.plusUntil).toLocaleDateString("en-GB", {
          timeZone: "Europe/London",
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "";
    if (currentUser.plusCancelled) {
      plusBit = until
        ? ` · Plus cancelled · access until ${esc(until)}`
        : " · Plus cancelled";
    } else {
      plusBit = until ? ` · Plus until ${esc(until)}` : " · Plus on this account";
    }
  }
  return `<p class="plus-account-note">Signed in as <strong>${esc(currentUser.email)}</strong>${plusBit}. Same login works on every device.</p>`;
}
