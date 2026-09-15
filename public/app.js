const loginLinks = [...document.querySelectorAll("[data-login]")];
const accountButton = document.querySelector("[data-account]");
const profileLink = document.querySelector("[data-profile-link]");
const accountMenu = document.querySelector("[data-account-menu]");
const logoutButton = document.querySelector("[data-logout]");
const deleteAccountButton = document.querySelector("[data-delete-account]");
const settingsShortcut = document.querySelector("[data-settings-shortcut]");
const status = document.querySelector("[data-auth-status]");
const profileEditor = document.querySelector("[data-profile-editor]");
const profileDisplayName = document.querySelector("[data-profile-display-name]");
const profileBio = document.querySelector("[data-profile-bio]");
const profileSaveButton = document.querySelector("[data-profile-save]");
const profileStatus = document.querySelector("[data-profile-status]");
const siteConfig = window.ANIILOGS_CONFIG || {};
const API_URL = String(siteConfig.apiUrl || siteConfig.shareApiUrl || "").replace(/\/+$/u, "");
const AUTH_SESSION_STORAGE_KEY = "aniilogs:auth:session:v1";

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
    if (link.classList.contains("secondary-button")) {
      link.textContent = "Continue with Discord";
      continue;
    }
    const label = link.querySelector("span");
    if (label) label.textContent = "Sign in";
    link.setAttribute("aria-label", "Sign in with Discord");
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
  accountMenu.hidden = true;
  accountButton.hidden = true;
  profileLink.hidden = true;
  logoutButton.hidden = true;
  deleteAccountButton.hidden = true;
  settingsShortcut.hidden = false;
  profileEditor.hidden = true;
  profileEditor.reset();
  profileStatus.textContent = "";
  status.textContent = message;
}

function showSignedIn(account) {
  for (const link of loginLinks) link.hidden = true;
  const name = account.displayName || account.globalName || account.username;
  accountMenu.hidden = false;
  accountButton.textContent = name;
  accountButton.title = `Signed in as @${account.username}`;
  accountButton.hidden = false;
  profileLink.hidden = false;
  logoutButton.hidden = false;
  deleteAccountButton.hidden = false;
  settingsShortcut.hidden = true;
  status.textContent = `Signed in as ${name}. Your profile is private by default.`;
  void loadPrivateProfile(name);
}

async function loadPrivateProfile(fallbackName = "") {
  profileEditor.hidden = false;
  profileStatus.textContent = "Loading your private profile…";
  try {
    const response = await apiFetch("/profile");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const profile = payload.profile || {};
    profileDisplayName.value = String(profile.displayName || fallbackName).slice(0, 80);
    profileBio.value = String(profile.bio || "").slice(0, 500);
    profileStatus.textContent = profile.isPublic
      ? "Profile visibility was reset to private."
      : "Private · visible only to you";
  } catch {
    profileEditor.hidden = true;
    profileStatus.textContent = "";
    status.textContent = "Signed in, but your private profile could not be loaded.";
  }
}

profileEditor.addEventListener("submit", async (event) => {
  event.preventDefault();
  const displayName = profileDisplayName.value.trim();
  const bio = profileBio.value.trim();
  if (!displayName) {
    profileStatus.textContent = "Enter a display name.";
    profileDisplayName.focus();
    return;
  }
  profileSaveButton.disabled = true;
  profileStatus.textContent = "Saving privately…";
  try {
    const response = await apiFetch("/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName, bio }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.profile?.isPublic !== false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    profileDisplayName.value = payload.profile.displayName;
    profileBio.value = payload.profile.bio || "";
    accountButton.textContent = payload.profile.displayName;
    profileStatus.textContent = "Saved privately · visible only to you";
  } catch {
    profileStatus.textContent = "Could not save. Nothing was published.";
  } finally {
    profileSaveButton.disabled = false;
  }
});

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
    accountMenu.open = false;
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
    accountMenu.open = false;
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
