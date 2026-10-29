// The shared top bar on the pages outside the explorer (Leaderboards, Companion App, Profiles), the same bar as
// Map / Aniilog / Item-log / Checklists / Team Builder: marks the current page, adds the phone bottom tabs, and on
// pages whose own script doesn't handle the account (data-chrome-account on the bar) runs Discord sign-in and the
// account menu. window.AniilogsChrome.ready resolves with the signed-in account (or null) once that is settled.
(() => {
  const header = document.querySelector(".app-topbar[data-chrome-page]");
  if (!header) return;
  const siteConfig = window.ANIILOGS_CONFIG || {};
  const API_URL = String(siteConfig.apiUrl || siteConfig.shareApiUrl || "").replace(/\/+$/u, "");
  const AUTH_SESSION_STORAGE_KEY = "aniilogs:auth:session:v1";
  // The explorer's own five sections, as its bottom tabs (public/explorer/app.js BOTTOM_TABS).
  const BOTTOM_TABS = [
    ["Map", "/explorer/", "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14"],
    ["Aniilog", "/explorer/?view=aniilog", "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Zm0 13a3 3 0 0 1 3-3h11"],
    ["Item-log", "/explorer/?view=itemlog", "M12 3 4 7v10l8 4 8-4V7l-8-4Zm0 0v18M4 7l8 4 8-4"],
    ["Checklists", "/explorer/?view=checklist", "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"],
    ["Team", "/explorer/?view=team", "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20a6 6 0 0 1 12 0m-2 0a6 6 0 0 1 10-4"],
  ];

  // The current page's link: the bar names it, except the home page, which is Profiles only on a profile view.
  const params = new URLSearchParams(window.location.search);
  const page = header.dataset.chromePage === "home" && (params.get("view") === "profile" || params.has("profile"))
    ? "profiles" : header.dataset.chromePage;
  for (const link of header.querySelectorAll("nav a[data-chrome-link]")) {
    if (link.dataset.chromeLink === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }

  const tabs = document.createElement("nav");
  tabs.className = "bottom-tabs";
  tabs.setAttribute("aria-label", "Sections");
  for (const [label, href, path] of BOTTOM_TABS) {
    const link = document.createElement("a");
    link.href = href;
    link.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg><span></span>`;
    link.querySelector("span").textContent = label;
    tabs.append(link);
  }
  document.body.append(tabs);

  // ---------------------------------------------------------------- account (when the page leaves it to the bar)
  const sessionToken = () => {
    try { return String(window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY) || ""); } catch { return ""; }
  };
  async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = sessionToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${API_URL}${path}`, { ...options, credentials: "omit", headers });
  }
  // Finishes a Discord sign-in that returned to this page (one-time handoff in the URL fragment).
  async function consumeAuthHandoff() {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
    const handoff = fragment.get("aniilogs_auth") || "";
    if (!handoff) return;
    fragment.delete("aniilogs_auth");
    const cleanUrl = new URL(window.location.href);
    cleanUrl.hash = fragment.toString();
    window.history.replaceState(null, "", cleanUrl);
    const response = await apiFetch("/auth/exchange", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handoff }),
    });
    if (!response.ok) return;
    const result = await response.json();
    if (/^[A-Za-z0-9_-]{32,256}$/u.test(String(result.token || ""))) {
      window.localStorage.setItem(AUTH_SESSION_STORAGE_KEY, result.token);
    }
  }
  const login = header.querySelector("[data-login]");
  const menu = header.querySelector("[data-account-menu]");
  const name = header.querySelector("[data-account]");
  const profile = header.querySelector("[data-profile-link]");
  const logout = header.querySelector("[data-logout]");
  const settings = header.querySelector("[data-settings-shortcut]");
  function show(account) {
    const signedIn = Boolean(account);
    login.hidden = signedIn;
    menu.hidden = !signedIn;
    name.hidden = !signedIn;
    profile.hidden = !signedIn;
    logout.hidden = !signedIn;
    settings.hidden = signedIn;                     // the account menu has Settings once signed in
    if (signedIn) {
      name.textContent = account.displayName || account.globalName || account.username;
      name.title = `Signed in as @${account.username}`;
    }
  }
  async function runAccount() {
    if (!API_URL) return null;
    const returnUrl = new URL(window.location.href);
    returnUrl.hash = "";
    login.href = `${API_URL}/auth/discord/start?return_to=${encodeURIComponent(returnUrl.toString())}`;
    try {
      await consumeAuthHandoff();
    } catch {
      // A failed handoff leaves the page signed out.
    }
    try {
      const me = await (await apiFetch("/auth/me")).json();
      const account = me.authenticated ? me.account : null;
      show(account);
      return account;
    } catch {
      show(null);
      return null;
    }
  }
  const ownsAccount = header.hasAttribute("data-chrome-account");
  if (ownsAccount) {
    logout.addEventListener("click", async () => {
      logout.disabled = true;
      try {
        const response = await apiFetch("/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        if (response.ok) {
          try { window.localStorage.removeItem(AUTH_SESSION_STORAGE_KEY); } catch { /* already signed out here */ }
          window.location.reload();
        }
      } finally {
        logout.disabled = false;
      }
    });
  }
  const ready = ownsAccount ? runAccount() : Promise.resolve(null);
  window.AniilogsChrome = Object.freeze({ ready });
})();
