// Run checks for staff (administrators and the owner): "Run checks" in the account menu, with the number of runs waiting,
// and the list it opens - only the runs the automatic checks think may be cheated (GET /api/admin/run-checks/staff;
// the server decides who is staff, and answers 403 to everyone else, who then see nothing of it). Each run says what
// was sent, why it is listed, what the second reading read where it differs, its pictures (the run viewer) and what
// Confirm and Reject do (POST /api/admin/run-checks/<id>). On a page without the run viewer the entry opens
// /leaderboard/?checks=1.
(() => {
  const siteConfig = window.ANIILOGS_CONFIG || {};
  const API_URL = String(siteConfig.apiUrl || siteConfig.shareApiUrl || "").replace(/\/+$/u, "");
  const AUTH_SESSION_STORAGE_KEY = "aniilogs:auth:session:v1";
  const POLL_MS = 2 * 60 * 1000;
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
  const number = (value) => (value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US"));
  const clock = (seconds) => (seconds == null ? null : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`);
  function age(seconds) {
    const ago = Math.max(0, Date.now() / 1000 - seconds);
    if (ago < 3600) return `${Math.max(1, Math.floor(ago / 60))} min ago`;
    if (ago < 86400) return `${Math.floor(ago / 3600)} h ago`;
    if (ago < 2 * 86400) return "yesterday";
    if (ago < 7 * 86400) return `${Math.floor(ago / 86400)} days ago`;
    return new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  // ---------------------------------------------------------------- the menu entry and its number
  const menus = [...document.querySelectorAll("[data-account-menu]")];
  if (!menus.length) return;
  let staff = null;            // null: not known yet; false: not staff (the entry stays hidden)
  // read before the page's own script tidies its address (the boards keep only their own parameters there)
  let openOnLoad = new URLSearchParams(window.location.search).get("checks") === "1";
  let count = 0;
  let timer = 0;
  const parts = menus.map((menu) => {
    const popover = menu.querySelector(".account-menu-popover");
    const badge = el("b", { class: "rc-count", hidden: true });
    const entry = el("button", { type: "button", class: "rc-menu-entry", hidden: true, "data-run-checks-open": "" }, el("span", { text: "Run checks" }), badge);
    entry.addEventListener("click", () => {
      menu.open = false;
      if (window.AniilogsProof) openPanel();
      else window.location.href = "/leaderboard/?checks=1";
    });
    const after = popover?.querySelector(".nt-menu-entry, [data-profile-link], #topbarProfileLink");
    if (after) after.after(entry);
    else popover?.prepend(entry);
    return { entry, badge };
  });
  function showCount(value) {
    count = Math.max(0, Number(value) || 0);
    for (const part of parts) {
      part.entry.hidden = !staff;
      part.badge.hidden = count === 0;
      part.badge.textContent = count > 99 ? "99+" : String(count);
      part.entry.setAttribute("aria-label", count ? `Run checks, ${count} waiting` : "Run checks, none waiting");
    }
  }
  const signedIn = () => Boolean(sessionToken()) && menus.some((menu) => !menu.hidden);
  async function askCount() {
    if (staff === false || !signedIn() || document.visibilityState !== "visible") return;
    try {
      const response = await apiFetch("/admin/run-checks/staff?count=1");
      if (response.status === 401 || response.status === 403) { staff = false; stop(); return; }
      if (!response.ok) return;
      staff = true;
      showCount((await response.json()).count);
      openIfAsked();
    } catch {
      // offline: the next round asks again
    }
  }
  // /leaderboard/?checks=1 opens the list once staff is known and the run viewer's script (loaded after this one) has run
  function openIfAsked() {
    if (!staff || !openOnLoad || document.readyState === "loading" || !window.AniilogsProof || panel) return;
    openOnLoad = false;
    openPanel();
  }
  document.addEventListener("DOMContentLoaded", openIfAsked, { once: true });
  function start() {
    if (timer || !signedIn() || staff === false) return;
    void askCount();
    timer = window.setInterval(() => { void askCount(); }, POLL_MS);
  }
  function stop() {
    window.clearInterval(timer);
    timer = 0;
    for (const part of parts) part.entry.hidden = true;
  }
  new MutationObserver(() => (signedIn() ? start() : stop())).observe(menus[0], { attributes: true, attributeFilter: ["hidden"] });
  for (const menu of menus.slice(1)) new MutationObserver(() => (signedIn() ? start() : stop())).observe(menu, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && timer) void askCount(); });
  if (signedIn()) start();

  // ---------------------------------------------------------------- the list
  let panel = null;
  let runs = [];
  const decided = new Map();   // submission id -> the decision just made
  const armed = new Map();     // submission id -> "confirmed" | "rejected": the second tap makes it
  const failed = new Set();    // a decision the API didn't take
  function closePanel() {
    panel?.remove();
    panel = null;
    document.removeEventListener("keydown", onKey, true);
  }
  function onKey(event) {
    if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;   // the run viewer closes first
    closePanel();
  }
  async function openPanel() {
    if (panel) { closePanel(); return; }
    decided.clear();
    armed.clear();
    panel = el("section", { class: "rc-panel", role: "dialog", "aria-label": "Run checks" });
    const header = document.querySelector(".app-topbar");
    panel.style.top = `${Math.max(8, Math.round((header?.getBoundingClientRect().bottom || 56) + 8))}px`;
    document.body.append(panel);
    document.addEventListener("keydown", onKey, true);
    const art = el("span", { class: "rc-loader-art", "aria-hidden": "true" });
    window.AlogsLoader?.create(art)?.loop();
    panel.replaceChildren(heading(), el("p", { class: "rc-loading", role: "status" }, art, el("span", { text: "Loading the runs waiting for staff…" })));
    try {
      const response = await apiFetch("/admin/run-checks/staff");
      if (!response.ok) throw new Error(String(response.status));
      const answer = await response.json();
      runs = answer.runs || [];
      showCount(answer.count);
      render();
      panel?.querySelector(".rc-close")?.focus({ preventScroll: true });
    } catch {
      if (panel) panel.replaceChildren(heading(), el("p", { class: "rc-empty", text: "Could not load the list. Try again in a moment." }));
    }
  }
  function heading() {
    return el("div", { class: "rc-head" }, el("h2", { text: "Run checks" }),
      el("button", { type: "button", class: "rc-close", "aria-label": "Close run checks", text: "×", onclick: closePanel }));
  }
  function render() {
    if (!panel) return;
    const intro = el("p", { class: "rc-intro", text: "Runs pass their checks by themselves. Only runs that may be cheated are listed here. Nobody but staff sees this list or that a run is on it." });
    if (!runs.length) {
      panel.replaceChildren(heading(), intro, el("p", { class: "rc-empty", text: "Nothing to look at: no run is waiting for a decision." }));
      return;
    }
    panel.replaceChildren(heading(), intro, el("div", { class: "rc-list" }, runs.map(card)));
  }
  const MODE_NAMES = Object.freeze({ interlink_run: "Interlink", sim_run: "Holo-Battle Sim", eggheist_match: "Egg Heist match", eggheist_season: "Egg Heist standing" });
  function title(run) {
    const parts = [MODE_NAMES[run.kind] || run.kind];
    if (run.kind === "interlink_run") parts.push(run.cycle ? `week ${run.cycle}` : null, run.bossName);
    else if (run.kind === "sim_run") parts.push(run.trialName, run.difficulty);
    else if (run.kind === "eggheist_match") parts.push(run.difficulty);
    else parts.push(run.cycle ? `season ${run.cycle}` : null);
    return parts.filter(Boolean).join(" · ");
  }
  function sent(run) {
    const parts = [];
    if (run.kind === "interlink_run") {
      parts.push(`score ${number(run.score)}`, `${number(run.stars)} stars`, clock(run.clearTimeS), run.teamDps ? `team DPS ${number(run.teamDps)}` : null);
    } else if (run.kind === "eggheist_match") {
      parts.push(`loot ${number(run.score)}`, clock(run.clearTimeS), run.cleared == null ? null : run.cleared ? "won" : "lost", run.defeats == null ? null : `${number(run.defeats)} defeats`);
    } else if (run.kind === "eggheist_season") {
      parts.push(run.rankName, run.score == null ? null : `${number(run.score)} rank points`);
    } else {
      parts.push(run.clearTimeS == null ? null : `cleared in ${clock(run.clearTimeS)}`);
    }
    return parts.filter(Boolean).join(" · ");
  }
  const DECIDES = Object.freeze({
    badge: "Confirm shows the verified tick on this run; Reject leaves it with no badge. Either way it stays on the boards.",
    boards: "This run is off the boards while it waits. Confirm puts it on the boards; Reject keeps it off.",
    nothing: "This check only lists the run. Confirm or Reject records your decision; nothing on the boards changes.",
  });
  function card(run) {
    const done = decided.get(run.submissionId);
    const head = el("div", { class: "rc-card-head" }, el("strong", { class: "rc-title", text: title(run) }),
      el("span", { class: "rc-meta", text: [run.player || "Unnamed player", `sent ${age(run.sentAt)}`, run.copies > 1 ? `${run.copies} players sent it` : null].filter(Boolean).join(" · ") }));
    if (done) {
      return el("article", { class: "rc-card is-done" }, head,
        el("p", { class: "rc-done", role: "status", text: done === "confirmed" ? "Confirmed." : "Rejected." }));
    }
    const read = run.read && run.kind === "interlink_run"
      ? el("p", { class: "rc-line" }, el("span", { class: "rc-label", text: "The picture read" }),
        [`score ${number(run.read.score)}`, run.read.stars == null ? null : `${number(run.read.stars)} stars`, run.read.time].filter(Boolean).join(" · "))
      : null;
    const button = (decision, text) => {
      const ready = armed.get(run.submissionId) === decision;
      return el("button", { type: "button", class: `rc-decide is-${decision}${ready ? " is-armed" : ""}`, text: ready ? `Tap again to ${text.toLowerCase()}` : text,
        onclick: () => (ready ? decide(run, decision) : arm(run, decision)) });
    };
    return el("article", { class: "rc-card" }, head,
      el("p", { class: "rc-line" }, el("span", { class: "rc-label", text: "Sent" }), sent(run) || "—"),
      read,
      el("ul", { class: "rc-reasons" }, (run.reasons || []).map((reason) => el("li", { text: reason }))),
      el("p", { class: "rc-decides", text: DECIDES[run.decides] || DECIDES.nothing }),
      failed.has(run.submissionId) ? el("p", { class: "rc-failed", role: "alert", text: "The decision was not saved. Try again in a moment." }) : null,
      el("div", { class: "rc-actions" },
        el("button", { type: "button", class: "rc-pictures", text: "Pictures", onclick: () => window.AniilogsProof?.open(run.submissionId, null) }),
        button("confirmed", "Confirm"), button("rejected", "Reject")));
  }
  function arm(run, decision) {
    armed.set(run.submissionId, decision);
    render();
    window.setTimeout(() => { if (armed.get(run.submissionId) === decision) { armed.delete(run.submissionId); render(); } }, 4000);
  }
  async function decide(run, decision) {
    armed.delete(run.submissionId);
    failed.delete(run.submissionId);
    try {
      const response = await apiFetch(`/admin/run-checks/${encodeURIComponent(run.submissionId)}`, { method: "POST", body: JSON.stringify({ decision }) });
      if (!response.ok) throw new Error(String(response.status));
      decided.set(run.submissionId, decision);
      showCount(count - 1);
    } catch {
        failed.add(run.submissionId);
    }
    render();
  }
  window.AniilogsRunChecks = Object.freeze({ open: openPanel, refresh: askCount });
})();
