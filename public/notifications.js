// Notifications about comments, in the account menu of every page: a number on the account button and next to
// "Notifications" in the menu, and the list that entry opens. One implementation for every page: it adds itself to each
// [data-account-menu] (site-chrome.js, app.js and explorer/app.js show that menu once signed in) and asks the API only
// while that menu is shown and the tab is visible - on load, then about once a minute. Opening the list clears the
// number; an entry stays unread until it is opened. An entry opens /leaderboard/?run=<id>&tab=comments.
(() => {
  const siteConfig = window.ANIILOGS_CONFIG || {};
  const API_URL = String(siteConfig.apiUrl || siteConfig.shareApiUrl || "").replace(/\/+$/u, "");
  const AUTH_SESSION_STORAGE_KEY = "aniilogs:auth:session:v1";
  const POLL_MS = 60 * 1000;
  if (!API_URL) return;

  function sessionToken() {
    try { return String(window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY) || ""); } catch { return ""; }
  }
  async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = sessionToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    return fetch(`${API_URL}${path}`, { ...options, credentials: "omit", headers });
  }
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }
  function icon(markup) {
    const span = el("span", { class: "nt-icon", "aria-hidden": "true" });
    span.innerHTML = markup;
    return span;
  }
  const DOTS = '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>';
  const BELL_OFF = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.7 3.6A6 6 0 0 1 18 8.5c0 3 .7 5 1.6 6.3"/><path d="M17 17H4.5c1-1.3 1.5-3.3 1.5-8 0-.5.1-1 .2-1.5"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/><path d="M3 3l18 18"/></svg>';
  const DOT = '<svg viewBox="0 0 24 24" width="19" height="19"><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  function age(ms) {
    const seconds = Math.max(0, (Date.now() - ms) / 1000);
    if (seconds < 60) return "just now";
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
    if (seconds < 3600) return plural(Math.floor(seconds / 60), "minute");
    if (seconds < 86400) return plural(Math.floor(seconds / 3600), "hour");
    if (seconds < 2 * 86400) return "Yesterday";
    if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)} days ago`;
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  const runLink = (runId) => `/leaderboard/?run=${encodeURIComponent(runId)}&tab=comments`;

  // ---------------------------------------------------------------- the number
  let count = 0;
  let lastAsked = 0;
  let timer = 0;
  const menus = [...document.querySelectorAll("[data-account-menu]")];
  if (!menus.length) return;
  const parts = menus.map((menu) => {
    const summary = menu.querySelector("summary");
    const popover = menu.querySelector(".account-menu-popover");
    const badge = el("b", { class: "nt-badge", "aria-hidden": "true", hidden: true });
    const spoken = el("i", { class: "nt-sr" });
    summary?.append(badge, spoken);
    const number = el("b", { class: "nt-count", hidden: true });
    const entry = el("button", { type: "button", class: "nt-menu-entry", "data-notifications-open": "" }, el("span", { text: "Notifications" }), number);
    entry.addEventListener("click", () => { menu.open = false; openPanel(); });
    const after = popover?.querySelector("[data-profile-link], #topbarProfileLink");
    if (after) after.after(entry);
    else popover?.prepend(entry);
    return { menu, badge, spoken, number, entry };
  });
  const signedIn = () => Boolean(sessionToken()) && menus.some((menu) => !menu.hidden);
  function showCount(value) {
    count = Math.max(0, Number(value) || 0);
    const text = count > 99 ? "99+" : String(count);
    for (const part of parts) {
      part.badge.hidden = count === 0;
      part.badge.textContent = text;
      part.number.hidden = count === 0;
      part.number.textContent = text;
      part.spoken.textContent = count ? `, ${count} new ${count === 1 ? "notification" : "notifications"}` : "";
      part.entry.setAttribute("aria-label", count ? `Notifications, ${count} new` : "Notifications");
    }
  }
  async function askCount() {
    if (!signedIn() || document.visibilityState !== "visible") return;
    lastAsked = Date.now();
    try {
      const response = await apiFetch("/notifications/count");
      if (response.status === 401) { stop(); return; }
      if (response.ok) showCount((await response.json()).count);
    } catch {
      // offline: the next minute asks again
    }
  }
  function start() {
    if (timer || !signedIn()) return;
    for (const part of parts) part.entry.hidden = false;
    void askCount();
    timer = window.setInterval(() => { void askCount(); }, POLL_MS);
  }
  function stop() {
    window.clearInterval(timer);
    timer = 0;
    showCount(0);
    for (const part of parts) part.entry.hidden = true;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && timer && Date.now() - lastAsked >= POLL_MS) void askCount();
  });
  // the page scripts show the menu once the account is known, and hide it on signing out
  const watch = new MutationObserver(() => (signedIn() ? start() : stop()));
  for (const menu of menus) watch.observe(menu, { attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("aniilogs:notifications-changed", () => { if (timer) void askCount(); });
  if (signedIn()) start();
  else for (const part of parts) part.entry.hidden = true;

  // ---------------------------------------------------------------- the list
  let panel = null;
  let entries = [];
  let openMenu = null;          // the entry whose "…" menu is open
  const off = new Set();        // entries just turned off: a line with Undo in their place
  function closePanel() {
    if (!panel) return;
    panel.remove();
    panel = null;
    openMenu = null;
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function outside(event) {
    if (panel && !panel.contains(event.target) && !event.target.closest?.("[data-notifications-open]")) closePanel();
  }
  function onKey(event) {
    if (event.key !== "Escape") return;
    if (openMenu) { openMenu = null; render(); return; }
    closePanel();
    parts.find((part) => !part.menu.hidden)?.menu.querySelector("summary")?.focus();
  }
  async function openPanel() {
    if (panel) { closePanel(); return; }
    off.clear();
    panel = el("section", { class: "nt-panel", role: "dialog", "aria-label": "Notifications" });
    const header = document.querySelector(".app-topbar");
    panel.style.top = `${Math.max(8, Math.round((header?.getBoundingClientRect().bottom || 56) + 8))}px`;
    document.body.append(panel);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
    const art = el("span", { class: "nt-loader-art", "aria-hidden": "true" });
    window.AlogsLoader?.create(art)?.loop();
    panel.replaceChildren(heading(false), el("p", { class: "nt-loading", role: "status" }, art, el("span", { text: "Loading your notifications…" })));
    try {
      const response = await apiFetch("/notifications");
      if (!response.ok) throw new Error(String(response.status));
      entries = (await response.json()).entries || [];
      // opening the list clears the number
      apiFetch("/notifications/seen", { method: "POST", body: "{}" }).catch(() => {});
      showCount(0);
      render();
      panel?.querySelector(".nt-entry-link, .nt-close")?.focus();
    } catch {
      if (panel) panel.replaceChildren(heading(false), el("p", { class: "nt-empty", text: "Could not load your notifications. Try again in a moment." }));
    }
  }
  function heading(withMarkAll) {
    return el("div", { class: "nt-head" }, el("h2", { text: "Notifications" }),
      withMarkAll ? el("button", { type: "button", class: "nt-mark-all", text: "Mark all as read", onclick: async () => {
        for (const entry of entries) entry.unread = false;
        render();
        apiFetch("/notifications/read-all", { method: "POST", body: "{}" }).catch(() => {});
      } }) : null,
      el("button", { type: "button", class: "nt-close", "aria-label": "Close notifications", text: "×", onclick: closePanel }));
  }
  // "<A> commented on your run", "<A> and <B> commented on a run you were on", "<A> and 2 others also commented on a run
  // you commented on"
  function sentence(entry) {
    const names = entry.actors.map((actor) => el("strong", { text: actor.name }));
    const who = entry.others ? [names[0], " and ", el("strong", { text: `${entry.others} others` })]
      : names.length === 2 ? [names[0], " and ", names[1]] : [names[0] || el("strong", { text: "Someone" })];
    const what = entry.relation === "sender" ? " commented on your run"
      : entry.relation === "player" ? " commented on a run you were on" : " also commented on a run you commented on";
    return el("span", { class: "nt-text" }, who, what);
  }
  function render() {
    if (!panel) return;
    if (!entries.length) {
      panel.replaceChildren(heading(false), el("p", { class: "nt-empty",
        text: "Nothing yet. New comments on your runs, and on runs you commented on, show up here." }));
      return;
    }
    panel.replaceChildren(heading(entries.some((entry) => entry.unread)), el("div", { class: "nt-list" }, entries.map(entryNode)));
  }
  function entryNode(entry) {
    if (off.has(entry.runId)) {
      return el("div", { class: "nt-off", role: "status" }, el("span", { text: "Notifications for this thread are off." }),
        el("button", { type: "button", class: "nt-undo", text: "Undo", onclick: async () => {
          const response = await setThread(entry, true);
          if (response?.ok) { off.delete(entry.runId); render(); }
        } }));
    }
    const menuOpen = openMenu === entry.runId;
    const toggle = el("button", { type: "button", class: "nt-more", "aria-label": "Options for this notification", "aria-expanded": String(menuOpen),
      onclick: () => { openMenu = menuOpen ? null : entry.runId; render(); } }, icon(DOTS));
    const item = (art, text, onclick) => el("button", { type: "button", role: "menuitem", class: "nt-menu-item", onclick }, icon(art), el("span", { text }));
    const menu = menuOpen ? el("div", { class: "nt-menu", role: "menu" },
      item(BELL_OFF, "Turn off notifications for this thread", async () => {
        const response = await setThread(entry, false);
        openMenu = null;
        if (response?.ok) off.add(entry.runId);
        render();
      }),
      entry.unread
        ? item(CHECK, "Mark as read", () => { entry.unread = false; openMenu = null; render(); mark(entry, "read"); })
        : item(DOT, "Mark as unread", () => { entry.unread = true; openMenu = null; render(); mark(entry, "unread"); })) : null;
    const link = el("a", { class: "nt-entry-link", href: runLink(entry.runId), onclick: (event) => {
      entry.unread = false;
      // a page with the run viewer opens it in place; others go to the boards page
      if (!window.AniilogsProof || event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) return;
      event.preventDefault();
      closePanel();
      window.AniilogsProof.open(entry.runId, null, null, { tab: "comments" });
    } }, sentence(entry), el("span", { class: "nt-run", text: entry.title }),
    el("time", { class: "nt-age", datetime: new Date(entry.at).toISOString(), text: age(entry.at) }));
    return el("div", { class: `nt-entry${entry.unread ? " is-unread" : ""}${menuOpen ? " has-menu" : ""}` },
      entry.unread ? el("span", { class: "nt-dot", role: "img", "aria-label": "New" }) : el("span"), link, toggle, menu);
  }
  function setThread(entry, on) {
    return apiFetch(`/runs/${encodeURIComponent(entry.runId)}/thread/notifications`, { method: "PUT", body: JSON.stringify({ on }) }).catch(() => null);
  }
  function mark(entry, how) {
    apiFetch(`/runs/${encodeURIComponent(entry.runId)}/thread/${how}`, { method: "POST", body: "{}" }).catch(() => {});
  }

  window.AniilogsNotifications = Object.freeze({ refresh: askCount, open: openPanel });
})();
