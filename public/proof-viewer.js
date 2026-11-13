// The run's proof viewer, shared by the leaderboards and My runs: every picture of a run in its own tab (the result
// screen, Battle Data, Holo-Battle Sim's Gizmo screen, the Party screen), a menu best's picture beside its run's, and
// what each player went in with. window.AniilogsProof: open(submissionId, check, menuId, options), button(...), checkBadge,
// partyPanel, allowDelete({ any, onDeleted }). options (the profile's trophies): shot, the picture to open on ("battle"), and note, a line over the
// pictures (Battle Data shows the whole party: the note says whose row the trophy is).
(() => {
  const siteConfig = window.ANIILOGS_CONFIG || {};
  const API_URL = String(siteConfig.apiUrl || siteConfig.shareApiUrl || "").replace(/\/+$/u, "");
  const AUTH_SESSION_STORAGE_KEY = "aniilogs:auth:session:v1";
  function sessionToken() {
    try { return String(window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY) || ""); } catch { return ""; }
  }
  async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = sessionToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
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
    for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
    return node;
  }
  function number(value) {
    return value === null || value === undefined ? "—" : Number(value).toLocaleString();
  }
  // The run check's badge (shadow mode: nothing is held either way)
  const CHECK_BADGES = Object.freeze({
    verified: { text: "✓", label: "Verified", title: "Verified" },
    pending: { text: "i", label: "Pending", title: "Pending" },
    invalid: { text: "✕", label: "Invalid", title: "Invalid" },
  });
  function checkBadge(check) {
    const badge = CHECK_BADGES[check];
    return badge ? el("span", { class: `lb-check is-${check}`, title: badge.title, "aria-label": badge.label, text: badge.text }) : null;
  }
  // A picture icon next to a name when the run has proof pictures, for anyone: hover it to see them side by side (the
  // result screen, Battle Data, Holo-Battle Sim's Gizmo screen), click (or tap) to keep them open, one per tab.
  const proofImages = new Map();                       // submission id|shot -> object URL, loaded once per page
  // shot: "summary" (the result screen), "battle" (Battle Data), "gizmo1"... (Holo-Battle Sim's Gizmo screen, a view
  // per part of its list) or "party" (the Party screen the run started from)
  async function proofImage(submissionId, shot = "summary") {
    const key = `${submissionId}|${shot}`;
    if (!proofImages.has(key)) {
      proofImages.set(key, (async () => {
        const response = await apiFetch(`/leaderboard/submissions/${encodeURIComponent(submissionId)}/evidence${shot === "summary" ? "" : `?shot=${shot}`}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return URL.createObjectURL(await response.blob());
      })().catch((error) => { proofImages.delete(key); throw error; }));
    }
    return proofImages.get(key);
  }
  // Which pictures a run has, in the order they were on screen, with each player's team and the run's buffs (the
  // API's ?shot=list)
  const proofLists = new Map();
  function proofDetails(submissionId) {
    if (!proofLists.has(submissionId)) {
      proofLists.set(submissionId, (async () => {
        const response = await apiFetch(`/leaderboard/submissions/${encodeURIComponent(submissionId)}/evidence?shot=list`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const details = await response.json();
        return { ...details, shots: Array.isArray(details.shots) && details.shots.length ? details.shots : ["summary"] };
      })().catch(() => ({ shots: ["summary", "battle"] })));     // an older API: the two it always had
    }
    return proofLists.get(submissionId);
  }

  // What each player went in with (the Party screen when the battle started) and the run's buffs
  function partyPanel(details) {
    const aniimo = (m) => [m.aniimo, Number.isInteger(m.aniimoLevel) ? `Lv ${m.aniimoLevel}` : "", Number.isInteger(m.cp) ? `CP ${number(m.cp)}` : ""]
      .filter(Boolean).join(" ");
    const players = (details.lineup || []).filter((p) => p.name || p.aniimo);
    const buffs = details.buffs || [];
    if (!players.length && !buffs.length) return null;
    return el("div", { class: "lb-proof-party" },
      players.length ? el("ul", { class: "lb-party-players" }, players.map((p) => {
        const team = (p.team || []).filter((m) => m.aniimo && m.aniimo !== p.aniimo).map(aniimo);
        return el("li", {}, el("strong", { text: p.name || "—" }), p.ai ? el("span", { class: "lb-ai", text: "AI" }) : null,
          p.aniimo ? el("span", { class: "lb-party-lead", text: aniimo(p) }) : null,
          team.length ? el("span", { class: "lb-party-team", text: `with ${team.join(", ")}` }) : null);
      })) : null,
      buffs.length ? el("p", { class: "lb-party-buffs" }, el("strong", { text: "Buffs " }),
        buffs.map((b) => `${b.name}${b.level ? ` Lv ${b.level}` : ""}`).join(" · ")) : null);
  }
  function shotLabel(shot, shots) {
    if (shot === "battle") return "Battle Data";
    if (shot === "party") return "Party";
    if (shot.startsWith("gizmo")) return shots.filter((s) => s.startsWith("gizmo")).length > 1 ? `Gizmos ${shot.slice(5)}` : "Gizmos";
    return "Summary";
  }
  const HOVER_OPEN_MS = 350;                           // a hover this long opens the viewer; passing over the icon doesn't
  function proofButton(submissionId, check = null, menuId = null, options = {}) {
    if (!submissionId) return null;
    const button = el("button", { type: "button", class: "lb-proof", title: "This run's screenshots (they stay open until you click outside)",
      "aria-label": "View this run's screenshots", onclick: () => { clearTimeout(hoverTimer); openProof(submissionId, check, menuId, options); } });
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v9.6l3.3-3.3a1 1 0 0 1 1.4 0l2.8 2.8 4.3-4.3a1 1 0 0 1 1.4 0L19 11.6V6H5Zm3.5 1.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/></svg>';
    // hover (mouse or pen only: a tap goes straight to the click) opens the same viewer as a click
    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch") return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => openProof(submissionId, check, menuId, options), HOVER_OPEN_MS);
    });
    button.addEventListener("pointerleave", () => clearTimeout(hoverTimer));
    return button;
  }
  let hoverTimer = null;
  // Deleting a run from the viewer: only the owner and administrators (the API's canDeleteRuns; the page passes it to
  // allowDelete). The API checks again.
  let deleter = null;
  function allowDelete(config) { deleter = config || null; }
  function deleteAction(dialog, submissionId, details) {
    if (!deleter?.any) return;
    const what = details.menu ? "menu best" : "run";
    const button = el("button", { type: "button", class: "danger-button", text: `Delete this ${what}`, onclick: async () => {
      if (!window.confirm(`Delete this ${what} from the leaderboards, with its pictures? This can't be undone.`)) return;
      button.disabled = true;
      const response = await apiFetch(`/leaderboard/submissions/${encodeURIComponent(submissionId)}`, { method: "DELETE" }).catch(() => null);
      if (!response?.ok) { button.disabled = false; window.alert(`Could not delete this ${what}.`); return; }
      proofLists.delete(submissionId);
      dialog.close();
      deleter?.onDeleted?.(submissionId);
    } });
    dialog.append(el("div", { class: "lb-proof-actions" }, button));
  }
  let proofOpenFor = null;                             // the run the viewer shows (a late picture of another is dropped)
  async function openProof(submissionId, check = null, menuId = null, options = {}) {
    let dialog = document.querySelector("dialog.lb-proof-dialog");
    if (!dialog) {
      dialog = el("dialog", { class: "lb-proof-dialog" },
        el("form", { method: "dialog" }, el("button", { type: "submit", class: "lb-proof-close", "aria-label": "Close", text: "×" })),
        el("div", { class: "lb-proof-body" }));
      dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });   // click outside
      document.body.append(dialog);
    }
    const body = dialog.querySelector(".lb-proof-body");
    let tabs = dialog.querySelector(".lb-proof-tabs");
    if (!tabs) { tabs = el("div", { class: "lb-proof-tabs", role: "tablist" }); dialog.insertBefore(tabs, body); }
    if (dialog.open && proofOpenFor === submissionId) return;
    proofOpenFor = submissionId;
    tabs.replaceChildren();
    dialog.querySelector(".lb-proof-party")?.remove();
    dialog.querySelector(".lb-proof-note")?.remove();
    dialog.querySelector(".lb-proof-actions")?.remove();
    if (options?.note) dialog.insertBefore(el("p", { class: "lb-proof-note", text: String(options.note) }), body);
    body.replaceChildren(el("p", { class: "lb-empty", text: "Loading the screenshots…" }));
    if (!dialog.open) dialog.showModal();             // it stays until a click outside it, × or Esc
    const details = await proofDetails(submissionId);
    if (proofOpenFor !== submissionId) return;
    // A best sent from the game's menu: its menu picture first, then the pictures of the player's best run of that boss
    // and week (the menu proof is added to them, it doesn't replace them).
    const run = details.menu && details.runProof ? await proofDetails(details.runProof) : null;
    // A run whose score a menu best matched: the menu picture goes with the run's (the board's menuProofId)
    const menu = !details.menu && menuId ? await proofDetails(menuId).catch(() => null) : null;
    if (proofOpenFor !== submissionId) return;
    const pictures = [
      ...(menu?.shots?.includes("summary") ? [{ id: menuId, shot: "summary", label: "Menu" }] : []),
      ...details.shots.map((shot) => ({ id: submissionId, shot, label: details.menu && shot === "summary" ? "Menu" : shotLabel(shot, details.shots) })),
      ...(run ? run.shots.map((shot) => ({ id: details.runProof, shot, label: shotLabel(shot, run.shots) })) : []),
    ];
    dialog.querySelector(".lb-proof-party")?.remove();
    const party = partyPanel(details.lineup?.length || details.buffs?.length || !run ? details : run);
    if (party) dialog.append(party);
    deleteAction(dialog, submissionId, details);
    // a tab for each picture
    const show = async (index) => {
      const picture = pictures[index];
      for (const tab of tabs.querySelectorAll("[data-proof-shot]")) tab.setAttribute("aria-selected", String(Number(tab.dataset.proofShot) === index));
      body.replaceChildren(el("p", { class: "lb-empty", text: "Loading the screenshot…" }));
      try {
        const url = await proofImage(picture.id, picture.shot);
        if (proofOpenFor !== submissionId) return;
        body.replaceChildren(el("img", { class: "lb-proof-image", src: url, alt: `This run's ${picture.label} screen` }));
      } catch {
        body.replaceChildren(el("p", { class: "lb-empty", text: `This run has no ${picture.label} screenshot.` }));
      }
    };
    tabs.append(...pictures.map((picture, index) => el("button", { type: "button", role: "tab", "data-proof-shot": String(index),
      text: picture.label, onclick: () => show(index) })));
    // the run check's badge beside the tabs
    const badge = checkBadge(check);
    if (badge) tabs.append(badge);
    // the picture asked for (a trophy read off Battle Data opens on it), else the first
    const start = options?.shot ? pictures.findIndex((picture) => picture.id === submissionId && picture.shot === options.shot) : -1;
    await show(Math.max(0, start));
  }
  window.AniilogsProof = Object.freeze({ open: openProof, button: proofButton, checkBadge, partyPanel, allowDelete });
})();
