const loginLinks = [...document.querySelectorAll("[data-login]")];
const accountButton = document.querySelector("[data-account]");
const logoutButton = document.querySelector("[data-logout]");
const deleteAccountButton = document.querySelector("[data-delete-account]");
const status = document.querySelector("[data-auth-status]");
const siteConfig = window.ANIILOGS_CONFIG || {};
const API_URL = String(siteConfig.apiUrl || siteConfig.shareApiUrl || "").replace(/\/+$/u, "");
const AUTH_SESSION_STORAGE_KEY = "aniilogs:auth:session:v1";
const COLOR_MODE_STORAGE_KEY = "aniilogs:color-mode:v1";
const themeToggle = document.querySelector("[data-theme-toggle]");

function applyColorMode(mode) {
  const normalized = mode === "light" ? "light" : "dark";
  document.documentElement.dataset.colorMode = normalized;
  if (themeToggle) {
    const next = normalized === "dark" ? "light" : "dark";
    themeToggle.innerHTML = `<span aria-hidden="true">${normalized === "dark" ? "☾" : "☀"}</span>`;
    themeToggle.setAttribute("aria-label", `Switch to ${next} mode`);
    themeToggle.title = `Switch to ${next} mode`;
  }
}

let initialColorMode = "dark";
try {
  initialColorMode = window.localStorage.getItem(COLOR_MODE_STORAGE_KEY) || "dark";
} catch {
  // Storage denial leaves the privacy-safe dark default in place.
}
applyColorMode(initialColorMode);
themeToggle?.addEventListener("click", () => {
  const next = document.documentElement.dataset.colorMode === "dark" ? "light" : "dark";
  applyColorMode(next);
  try {
    window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, next);
  } catch {
    // The selected mode still applies for this page view.
  }
});

function authSessionToken() {
  try {
    return String(window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

function clearAuthSession() {
  try {
    window.localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
  } catch {
    // Storage denial already leaves this page signed out.
  }
}

async function apiFetch(path, options = {}) {
  if (!API_URL) throw new Error("AniiLogs account API is not configured.");
  const headers = new Headers(options.headers || {});
  const token = authSessionToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${API_URL}${path}`, { ...options, credentials: "omit", headers });
}

function signInUrl() {
  const returnUrl = new URL(window.location.href);
  returnUrl.hash = "";
  return `${API_URL}/auth/discord/start?return_to=${encodeURIComponent(returnUrl.toString())}`;
}

function configureLoginLinks() {
  for (const link of loginLinks) {
    link.href = signInUrl();
    link.classList.remove("is-disabled");
    link.removeAttribute("aria-disabled");
    if (link.classList.contains("secondary-button")) link.textContent = "Continue with Discord";
    else link.innerHTML = '<span aria-hidden="true">✦</span> Sign in';
  }
}

async function consumeAuthHandoff() {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
  const handoff = fragment.get("aniilogs_auth") || "";
  if (!handoff) return;
  fragment.delete("aniilogs_auth");
  const cleanUrl = new URL(window.location.href);
  cleanUrl.hash = fragment.toString();
  window.history.replaceState(null, "", cleanUrl);
  const response = await apiFetch("/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handoff }),
  });
  if (!response.ok) throw new Error(`Discord sign-in handoff returned ${response.status}`);
  const result = await response.json();
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(String(result.token || ""))) {
    throw new Error("Discord sign-in handoff did not return a valid session.");
  }
  window.localStorage.setItem(AUTH_SESSION_STORAGE_KEY, result.token);
}

function showSignedOut(message = "Sign in to sync progress. Profiles remain private while sharing controls are being built.") {
  for (const link of loginLinks) link.hidden = false;
  accountButton.hidden = true;
  logoutButton.hidden = true;
  deleteAccountButton.hidden = true;
  status.textContent = message;
}

function showSignedIn(account) {
  for (const link of loginLinks) link.hidden = true;
  const name = account.displayName || account.globalName || account.username;
  accountButton.textContent = name;
  accountButton.title = `Signed in as @${account.username}`;
  accountButton.hidden = false;
  logoutButton.hidden = false;
  deleteAccountButton.hidden = false;
  status.textContent = `Signed in as ${name}. Your profile is private by default.`;
}

async function refreshAccount() {
  try {
    await consumeAuthHandoff();
    const response = await apiFetch("/auth/me");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.authenticated) showSignedIn(payload.account);
    else {
      clearAuthSession();
      showSignedOut();
    }
  } catch {
    showSignedOut("Account service is temporarily unavailable. The public tools remain accessible.");
  }
}

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    const response = await apiFetch("/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    clearAuthSession();
    showSignedOut("You are signed out.");
  } catch {
    status.textContent = "Could not sign out. Please try again.";
  } finally {
    logoutButton.disabled = false;
  }
});

deleteAccountButton.addEventListener("click", async () => {
  const confirmation = window.prompt(
    "Delete your AniiLogs account, cloud progress, private profile, sessions, and active map shares? Local browser progress will remain. Type DELETE to confirm.",
  );
  if (confirmation !== "DELETE") {
    status.textContent = confirmation === null ? "Account deletion cancelled." : "Type DELETE exactly to delete your account.";
    return;
  }
  deleteAccountButton.disabled = true;
  try {
    const response = await apiFetch("/account", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    clearAuthSession();
    showSignedOut("Your cloud account and its saved data were deleted. Local browser progress was kept.");
  } catch {
    status.textContent = "Could not delete your account. Nothing was changed; please try again.";
  } finally {
    deleteAccountButton.disabled = false;
  }
});

const authResult = new URLSearchParams(window.location.search).get("auth");
if (authResult) {
  const messages = {
    cancelled: "Discord sign-in was cancelled.",
    failed: "Discord sign-in could not be completed.",
    invalid: "Discord returned an invalid or expired sign-in request.",
    unavailable: "Discord sign-in is awaiting deployment credentials.",
  };
  status.textContent = messages[authResult] || "Discord sign-in was not completed.";
  history.replaceState({}, "", window.location.pathname);
}

if (!API_URL) {
  for (const link of loginLinks) {
    link.href = "#profiles";
    link.classList.add("is-disabled");
    link.setAttribute("aria-disabled", "true");
    link.textContent = "Discord sign-in soon";
  }
  status.textContent = "Account sync is awaiting its branded API origin. The public tools remain available to everyone.";
} else {
  configureLoginLinks();
  void refreshAccount();
}
