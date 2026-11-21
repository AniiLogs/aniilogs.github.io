// The run's proof viewer, shared by the leaderboards and My runs: every picture of a run in its own tab (the result
// screen, Battle Data, Holo-Battle Sim's Gizmo screen, the Party screen), a menu best's picture beside its run's, and
// what each player went in with, under a line saying which fight it is. window.AniilogsProof: open(submissionId, check, menuId, options), button(...), checkBadge,
// partyPanel, allowDelete({ any, onDeleted }). options (the profile's trophies): shot, the picture to open on ("battle"), and note, a line over the
// pictures (Battle Data shows the whole party: the note says whose row the trophy is). options.tab "comments": open on
// the run's Comments tab (comments.js; also when the viewer already shows that run). options.link { run, ladder, player?,
// code?, realPlayers? } (the boards): a button copying a link to that place, and the Solo / Duo / Trio tag.
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
        if (response.status === 404) return { shots: [], missing: true };    // no such run, or no pictures left
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const details = await response.json();
        return { ...details, shots: Array.isArray(details.shots) && details.shots.length ? details.shots : ["summary"] };
      // a run that isn't there (a link to a deleted run): no pictures; an older API: the two it always had
      })().catch((error) => ({ shots: String(error?.message) === "HTTP 404" ? [] : ["summary", "battle"] })));
    }
    return proofLists.get(submissionId);
  }

  // What each player went in with (the Party screen when the battle started) and the run's buffs: a row per player -
  // the name, their main Aniimo in its own chip (level and CP beside it), the rest of their team and, when the API sent
  // it (?shot=list), their Average DPS off the Battle Data card ("Not captured" when no card is surely theirs); under it
  // the team's DPS and the buffs. On a phone each row stacks.
  function partyPanel(details) {
    const facts = (m) => [Number.isInteger(m.aniimoLevel) ? `Lv ${m.aniimoLevel}` : "", Number.isInteger(m.cp) ? `CP ${number(m.cp)}` : ""]
      .filter(Boolean).join(" · ");
    // a renamed Aniimo: its species (read from the Party picture's portrait), then the player's own name for it
    const nick = (m) => (m.nickname ? `“${m.nickname}”` : "");
    const aniimo = (m) => [m.aniimo, nick(m), facts(m)].filter(Boolean).join(" ");
    const players = (details.lineup || []).filter((p) => p.name || p.aniimo);
    const buffs = details.buffs || [];
    const teamDps = Number.isFinite(details.teamDps) && details.teamDps > 0 ? details.teamDps : null;
    if (!players.length && !buffs.length) return null;
    // the Avg DPS column only when the API says (an older API, or a board row's lineup, has none: the row's table shows it)
    const dps = players.some((p) => Object.hasOwn(p, "avgDps"));
    const cell = (label, ...children) => el("div", { class: "lb-party-cell", "data-label": label }, el("span", { class: "lb-party-value" }, ...children));
    const summary = [
      teamDps ? el("span", { class: "lb-party-sum" }, el("span", { class: "lb-party-sum-label", text: "Team avg DPS" }), ` ${number(teamDps)}`) : null,
      buffs.length ? el("span", { class: "lb-party-sum lb-party-buffs" }, el("span", { class: "lb-party-sum-label", text: "Buffs" }),
        ` ${buffs.map((b) => `${b.name}${b.level ? ` Lv ${b.level}` : ""}`).join(" · ")}`) : null,
    ].filter(Boolean);
    return el("div", { class: "lb-proof-party" },
      players.length ? el("div", { class: `lb-party-grid${dps ? " has-dps" : ""}`, role: "table", "aria-label": "What each player went in with" },
        el("div", { class: "lb-party-row lb-party-head", role: "row" },
          ["Player", "Main Aniimo", "With", ...(dps ? ["Avg DPS"] : [])].map((text) => el("span", { role: "columnheader", text }))),
        players.map((p) => {
          const team = (p.team || []).filter((m) => m.aniimo && m.aniimo !== p.aniimo).map(aniimo);
          const level = facts(p);
          return el("div", { class: "lb-party-row", role: "row" },
            cell("Player", el("span", { class: "lb-party-name", text: p.name || "—" }), p.ai ? el("span", { class: "lb-ai", text: "AI" }) : null),
            cell("Main Aniimo", p.aniimo ? el("span", { class: "lb-party-lead" }, el("span", { class: "lb-party-lead-name", text: p.aniimo }),
              p.nickname ? el("span", { class: "lb-party-lead-nick", text: nick(p), title: "The player's own name for this Aniimo" }) : null,
              level ? el("span", { class: "lb-party-lead-facts", text: level }) : null) : el("span", { class: "lb-party-none", text: "—" })),
            cell("With", el("span", { class: "lb-party-team", text: team.length ? team.join(", ") : "—" })),
            dps ? cell("Avg DPS", Number.isFinite(p.avgDps) && p.avgDps > 0 ? el("span", { class: "lb-party-dps", text: number(p.avgDps) })
              : el("span", { class: "lb-party-none", text: "Not captured", title: "No Battle Data card for this player came with the run" })) : null);
        })) : null,
      summary.length ? el("p", { class: "lb-party-summary" }, summary) : null);
  }
  // The line over the pictures: which fight the run is (the API's fight), so a picture is never shown without it.
  // Interlink: the boss, its level, the week, stars, score and time; Holo-Battle Sim: the training, its difficulty and
  // time; Egg Heist: the difficulty or rank and its score, rank points or escape.
  const FIGHT_MODES = Object.freeze({ interlink: "Interlink", sim: "Holo-Battle Sim", eggheist: "Egg Heist" });
  function fightLine(fight) {
    const chip = FIGHT_MODES[fight?.mode];
    if (!chip) return null;
    const day = (unix) => new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const seconds = (value) => `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
    const has = (value) => value !== undefined && value !== null;
    const facts = [];
    if (fight.mode === "interlink") {
      if (fight.week?.start && fight.week?.end) facts.push(`Week of ${day(fight.week.start)} – ${day(fight.week.end)}`);
      if (has(fight.stars)) facts.push(`${number(fight.stars)} ${fight.stars === 1 ? "star" : "stars"}`);
      if (has(fight.score)) facts.push(number(fight.score));
    } else if (fight.mode === "sim") {
      if (fight.difficulty) facts.push(fight.difficulty);
    } else if (fight.kind === "eggheist_season") {
      if (has(fight.points)) facts.push(`${number(fight.points)} rank points`);
    } else {
      if (has(fight.score)) facts.push(`${number(fight.score)} pts`);
      if (typeof fight.escaped === "boolean") facts.push(fight.escaped ? "Escaped" : "Failed");
    }
    if (has(fight.time)) facts.push(seconds(fight.time));
    const title = fight.title || (fight.mode === "eggheist" ? (fight.kind === "eggheist_season" ? "Season rank" : "Match") : "");
    return el("p", { class: "lb-proof-fight" }, el("span", { class: "lb-proof-mode", text: chip }),
      title ? el("strong", { text: title }) : null,
      fight.mode === "interlink" && Number.isInteger(fight.level) ? el("span", { text: `Lv ${fight.level}` }) : null,
      ...facts.map((fact) => el("span", { class: "lb-proof-fact", text: fact })));
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
  let openComments = null;                             // its Comments tab (comments.js), and what picks that tab
  let showCommentsTab = null;
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
    if (dialog.open && proofOpenFor === submissionId) {
      if (options?.tab === "comments") showCommentsTab?.();
      return;
    }
    proofOpenFor = submissionId;
    openComments?.detach();
    openComments = null;
    showCommentsTab = null;
    tabs.replaceChildren();
    dialog.querySelector(".lb-proof-party")?.remove();
    dialog.querySelector(".lb-proof-note")?.remove();
    dialog.querySelector(".lb-proof-fight")?.remove();
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
    // which fight it is, over the pictures (a menu best's own facts, else its run's)
    dialog.querySelector(".lb-proof-fight")?.remove();
    const fight = fightLine(details.fight || run?.fight);
    if (fight) dialog.insertBefore(fight, dialog.querySelector(".lb-proof-note") || body);
    const pictures = [
      ...(menu?.shots?.includes("summary") ? [{ id: menuId, shot: "summary", label: "Menu" }] : []),
      ...details.shots.map((shot) => ({ id: submissionId, shot, label: details.menu && shot === "summary" ? "Menu" : shotLabel(shot, details.shots) })),
      ...(run ? run.shots.map((shot) => ({ id: details.runProof, shot, label: shotLabel(shot, run.shots) })) : []),
    ];
    dialog.querySelector(".lb-proof-party")?.remove();
    const shown = details.lineup?.length || details.buffs?.length || !run ? details : run;
    const party = partyPanel(shown);
    if (party) dialog.append(party);
    // Each lead as the Party picture shows it (party-portraits.js): a renamed Aniimo's card prints the nickname, so
    // the name the app read says nothing about the species. The table is drawn again once the picture is read.
    const shownId = shown === details ? submissionId : details.runProof;
    const portraits = window.AniilogsPartyPortraits;
    if (party && portraits?.lineupFromPicture && shown.lineup?.length && shown.shots?.includes("party")) {
      const mode = (shown.fight || details.fight)?.mode === "eggheist" ? "eggheist" : "interlink";
      portraits.lineupFromPicture(shownId, shown.lineup, async () => (await fetch(await proofImage(shownId, "party"))).blob(), mode)
        .then((lineup) => {
          if (proofOpenFor !== submissionId || lineup === shown.lineup) return;
          const fresh = partyPanel({ ...shown, lineup });
          const old = dialog.querySelector(".lb-proof-party");
          if (fresh && old) old.replaceWith(fresh);
        });
    }
    deleteAction(dialog, submissionId, details);
    // the run's comments (comments.js): a tab after the pictures; a menu best's go to its run
    const commentsRun = details.menu ? details.runProof : submissionId;
    const comments = commentsRun && window.AniilogsComments ? window.AniilogsComments.mount(commentsRun) : null;
    dialog.classList.remove("is-comments");
    const showComments = () => {
      for (const tab of tabs.querySelectorAll("[data-proof-shot]")) tab.setAttribute("aria-selected", "false");
      comments.tab.setAttribute("aria-selected", "true");
      dialog.classList.add("is-comments");
      return comments.show(body);
    };
    openComments = comments;
    showCommentsTab = comments ? showComments : null;
    // a tab for each picture
    const show = async (index) => {
      const picture = pictures[index];
      dialog.classList.remove("is-comments");
      comments?.tab.setAttribute("aria-selected", "false");
      if (!picture) { body.replaceChildren(el("p", { class: "lb-empty", text: "This run isn't available." })); return; }
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
    if (comments) {
      comments.tab.addEventListener("click", showComments);
      tabs.append(comments.tab);
    }
    // the run check's badge beside the tabs
    const badge = checkBadge(check);
    if (badge) tabs.append(badge);
    // options.link (the boards): the run's Solo / Duo / Trio tag and a link to its place (leaderboard/share.js)
    const share = options?.link && window.AniilogsShare;
    const shareTag = share ? share.tag(options.link.realPlayers) : null;
    const shareButton = share && details.shots.length ? share.button(options.link) : null;
    if (shareTag || shareButton) tabs.append(el("span", { class: "lb-proof-share" }, shareTag, shareButton));
    // options.tab "comments" opens on the Comments tab (a link to a run's comments); a run with no pictures left too
    if (comments && (options?.tab === "comments" || (!pictures.length && await comments.ready))) {
      if (proofOpenFor === submissionId) await showComments();
      return;
    }
    // the picture asked for (a trophy read off Battle Data opens on it), else the first
    const start = options?.shot ? pictures.findIndex((picture) => picture.id === submissionId && picture.shot === options.shot) : -1;
    await show(Math.max(0, start));
  }
  window.AniilogsProof = Object.freeze({ open: openProof, button: proofButton, checkBadge, partyPanel, allowDelete });
})();
