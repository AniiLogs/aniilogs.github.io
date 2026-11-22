// game-audit: unaudited Challenge Score from bossrush_grade_data, Interlink and Holo-Battle Sim rules
(() => {
  const siteConfig = window.ANIILOGS_CONFIG || {};
  const API_URL = String(siteConfig.apiUrl || siteConfig.shareApiUrl || "").replace(/\/+$/u, "");
  const AUTH_SESSION_STORAGE_KEY = "aniilogs:auth:session:v1";
  const PREFERENCES_KEY = "aniilogs:explorer:preferences:v1";
  const ROWS_KEY = "aniilogs:leaderboard:rows:v1";
  const PAGE_SIZE = 50;

  // Boards per mode: which records they rank, what they can be ranked by, and which filters apply.
  const BOARDS = Object.freeze({
    // Interlink runs weekly (a new week starts Wednesday 20:00 UTC) with three bosses (left, center, right).
    // Per Boss: a week's three boards; Season Ladder: a split's (or a whole season's) weeks added up.
    interlink: [
      { kind: "interlink_boss", label: "Per Boss", custom: "boss", sorts: [], fields: [] },
      { kind: "interlink_ladder", label: "Season Ladder", custom: "season", sorts: [], fields: [] },
    ],
    sim: [
      // one board per trial and difficulty, read from the Victory screen ("Battle time 00:08:22 Training of Water - Hard")
      // and, as the game's own leaderboard tabs them, one Training Style (from aLogs' setup read)
      { kind: "sim_run", label: "Trials", sorts: ["clear_time_s", "player", "style", "party_size", "played_at"], fields: ["trial", "difficulty", "style", "party", "buff"] },
    ],
    // From the desktop meter: the Rank Info screen (season standing) and each match's end screen (Matches)
    eggheist: [
      { kind: "eggheist_season", label: "Season standings", sorts: ["standing", "score", "stars", "player", "cycle", "played_at"], fields: ["cycle"] },
      // each match, from the game's end screen; best loot per player unless "every run"
      { kind: "eggheist_match", label: "Matches", sorts: ["score", "difficulty", "cleared", "clear_time_s", "player", "cycle", "played_at"], fields: ["cycle", "difficulty", "cleared"] },
      { kind: "eggheist_pvp", label: "PvP (coming soon)", soon: true },
    ],
  });
  // What the summary line calls each sort ("sorted by Season")
  const SORT_LABELS = Object.freeze({
    standing: "Rank", score: "Score", team_dps: "Team DPS", clear_time_s: "Fastest time", stars: "Stars", meter_dps: "Meter DPS", floors: "Floors",
    p_dps: "Avg DPS", p_break: "BREAK", p_taken: "Damage taken", p_heal: "Healing", defeats: "Total Defeats",
    difficulty: "Difficulty", player: "Player", played_at: "Date", cycle: "Season", cleared: "Outcome", style: "Training Style", party_size: "Party size",
  });
  // Sorts that start A–Z / smallest first (the API's natural order); the rest start highest or newest first.
  const ASCENDING_SORTS = new Set(["clear_time_s", "player", "style", "party_size"]);
  // Table columns per board; `sort` makes the header clickable (sorted by the API: the boards are paged). The board's
  // first sort is its ranking; the other columns re-order the same rows (each player's best).
  const COLUMNS = Object.freeze({
    eggheist_season: [
      { label: "Rank", sort: "standing", value: (e) => e.seasonRank?.name || (e.seasonRank?.tier ? `Tier ${e.seasonRank.tier}` : "—") },
      // Egg Emperor is the top rank: its points are maxed out (it counts stars instead)
      { label: "Rank points", sort: "score", value: (e) => (e.seasonRank?.tier === 7 ? "MAX" : number(e.score)) },
      // Stars only exist at the top rank (Egg Emperor)
      { label: "Emperor stars", sort: "stars", value: (e) => (e.seasonRank?.tier === 7 || e.stars ? number(e.stars) : "—") },
      { label: "Season", sort: "cycle", value: (e) => e.cycle || "—" },
      { label: "Last updated", sort: "played_at", value: (e) => date(e.playedAt || e.submittedAt) },
    ],
    eggheist_match: [
      { label: "Loot", sort: "score", value: (e) => number(e.score) },
      { label: "Difficulty", sort: "difficulty", value: (e) => e.difficulty || "—" },
      { label: "Outcome", sort: "cleared", value: (e) => (e.cleared === true ? "Escaped" : e.cleared === false ? "Failed" : "—") },
      { label: "Time", sort: "clear_time_s", value: (e) => duration(e.clearTimeS) },
      { label: "Total Defeats", info: "defeats", value: (e) => number(e.defeats) },
      { label: "Season", sort: "cycle", value: (e) => e.cycle || "—" },
      { label: "Last updated", sort: "played_at", value: (e) => date(e.playedAt || e.submittedAt) },
    ],
    sim_run: [
      { label: "Battle time", sort: "clear_time_s", value: (e) => duration(e.clearTimeS) },
      { label: "Trial", value: (e) => e.trialName || e.trial || "—" },
      { label: "Difficulty", value: (e) => e.difficulty || "—" },
      { label: "Style", sort: "style", value: (e) => e.extra?.setup?.style || "—" },
      // each gizmo series with its count ("Energy 6 · Valor 2"); runs from before the setup was read: their buff count
      { label: "Gizmos", value: (e) => gizmoSeries(e.extra?.setup) || number(e.buffs?.length) },
      { label: "Party", sort: "party_size", value: (e) => number(e.partySize) },
      { label: "Last updated", sort: "played_at", value: (e) => date(e.playedAt || e.submittedAt) },
    ],
  });

  const $ = (selector) => document.querySelector(selector);
  const els = {
    gate: $("[data-gate]"), gateTitle: $("[data-gate-title]"), gateDetail: $("[data-gate-detail]"),
    board: $("[data-board]"), badge: $("[data-preview-badge]"), filters: $("[data-filters]"),
    boardTabs: $("[data-board-tabs]"), summary: $("[data-summary]"),
    head: $("[data-head]"), rows: $("[data-rows]"), prev: $("[data-prev]"), next: $("[data-next]"), page: $("[data-page]"),
    login: $("[data-login]"),
    serverPick: $("[data-server-pick]"), serverSelect: $("[data-server-select]"), unlinked: $("[data-unlinked]"), rowsPick: $("[data-rows-pick]"),
    partyPick: $("[data-party-pick]"), partySelect: $("[data-party-select]"),
    interlink: $("[data-interlink]"), tableWrap: $("[data-table-wrap]"),
  };
  const state = {
    mode: "interlink", kind: "interlink_boss", sort: "", order: "", offset: 0, server: "",
    // Interlink: the week shown, the board opened with "View all" and its ladder, each board's ladder, the boss a phone
    // shows (0 left, 1 center, 2 right), and the Season Ladder's season, split ("all": the whole season) and order
    week: "", viewBoss: "", viewLadder: "score", ladders: {}, slot: 1, season: "", split: "", rank: "score", rankOrder: "",
    // the team ladders' rows: "teams" (one row per run, its players together) or "players" (one row each), every board
    rows: "teams",
    status: null, facets: null, total: 0, expanded: new Set(), requestId: 0, push: false,
  };

  // ---------------------------------------------------------------- helpers
  function sessionToken() {
    try { return String(window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY) || ""); } catch { return ""; }
  }
  // the Teams / Players choice, kept for the next visit (a page that can't store it starts on Teams)
  function storedRows() {
    try { return window.localStorage.getItem(ROWS_KEY) === "players" ? "players" : "teams"; } catch { return "teams"; }
  }
  function storeRows(value) {
    try { window.localStorage.setItem(ROWS_KEY, value); } catch { /* the choice lasts for this page only */ }
  }
  function developerModeOn() {
    try { return Boolean(JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) || "{}").developerMode); } catch { return false; }
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
  // A name linked to its owner's public profile (only profiles their owners made public carry an id). A claimed
  // character shows its UID on hover: names can look alike (or use lookalike letters), UIDs can't.
  // character: set when name is the player's Discord name (they picked it under Show me by): the Discord logo goes
  // before it and the character that played stays on hover.
  function profileName(name, profileId, props = {}, uid = null, character = null) {
    const title = [character ? `Discord name · character ${character}` : "", uid ? `UID ${uid}` : "", profileId ? "Open their profile" : ""]
      .filter(Boolean).join(" · ") || null;
    const label = character ? shownName(name, "discord") : null;
    if (!profileId) return el("span", { ...props, title, text: label ? null : name }, label);
    return el("a", { ...props, href: `/?profile=${encodeURIComponent(profileId)}`, title, text: label ? null : name }, label);
  }
  // a player's name as they chose to be shown (site-sidebar.js draws the Discord logo)
  function shownName(text, nameSource) {
    return window.AniiSite?.playerName(text, nameSource) || document.createTextNode(String(text || ""));
  }
  // a board row's name: its Discord name when its player picked that, else the character's
  function rowName(entry, props = {}) {
    return entry.discordName ? profileName(entry.discordName, entry.profileId, props, entry.uid, entry.player)
      : profileName(entry.player, entry.profileId, props, entry.uid);
  }
  // A claimed player's badge: a filled blue seal with a white tick, after the name. It differs from the run's green
  // check (proof-viewer.js) in shape as well as colour: this one is about who the player is, that one about the run.
  const CLAIMED_TEXT = "Claimed: this run is tied to this player's own UID.";
  const UNCLAIMED_TEXT = "From a teammate's run. Not claimed: no UID was recorded for this player with the run.";
  const SEAL = Array.from({ length: 24 }, (_, i) => {          // a 12-point scalloped seal, rounded by its own stroke
    const angle = (i * Math.PI) / 12 - Math.PI / 2;
    const radius = i % 2 ? 9.6 : 11;
    return `${(12 + radius * Math.cos(angle)).toFixed(2)},${(12 + radius * Math.sin(angle)).toFixed(2)}`;
  }).join(" ");
  function claimedBadge() {
    const badge = el("span", { class: "lb-claimed", role: "img", title: CLAIMED_TEXT, "aria-label": CLAIMED_TEXT });
    badge.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polygon points="${SEAL}" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>`
      + '<path d="M7.6 12.4l3 3 5.8-6.2" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return badge;
  }
  // Marks after a name, in this order: the blue badge when the player is claimed, "you", an app user without a
  // character name, a name that looks like a claimed one. An unclaimed player gets no mark: their line is softer and
  // says why on hover (nameLine).
  function nameMarks(entry) {
    return [
      entry.unclaimed ? null : claimedBadge(),
      entry.own ? el("span", { class: "lb-you", text: "you" }) : null,
      // shown with "Show unlinked": an app user whose character name was never read (no UID to show either)
      !entry.unclaimed && !entry.uid && state.unlinked && entry.player === "Pathfinder" ? el("span", { class: "lb-mark", title: "An aLogs user whose app hasn't read their character's name yet.", text: "no character" }) : null,
      entry.lookalike ? el("span", { class: "lb-mark lb-lookalike", title: "This name looks like a claimed player's name but isn't theirs. Only the UID tells players apart.", text: "≈" }) : null,
    ];
  }
  // One player's line: the name (cut with "…" only when it alone is too long), then its marks and `extra` (their own
  // copy's pictures), which never wrap away from it. An unclaimed player's line is marked is-unclaimed.
  function nameLine(entry, ...extra) {
    return el("span", { class: ["lb-who-name", entry.unclaimed ? "is-unclaimed" : "", entry.own ? "is-own-name" : ""].filter(Boolean).join(" "),
      title: entry.unclaimed ? UNCLAIMED_TEXT : null },
      fullTitle(rowName(entry, { class: "lb-name" })), ...nameMarks(entry), ...extra);
  }
  // a name that may be cut with "…" keeps all of it on hover: the shown name first in its title
  function fullTitle(node) {
    const shown = node.textContent.trim();
    if (shown && !String(node.title || "").startsWith(shown)) node.title = [shown, node.title].filter(Boolean).join(" · ");
    return node;
  }
  // 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 101st, 111th, ...: a place said in running text
  function ordinal(n) {
    const value = Math.trunc(Number(n));
    const teen = Math.abs(value) % 100;
    const suffix = teen >= 11 && teen <= 13 ? "th" : ["th", "st", "nd", "rd"][Math.abs(value) % 10] || "th";
    return `${value}${suffix}`;
  }
  function number(value) {
    return value === null || value === undefined ? "—" : Number(value).toLocaleString();
  }
  function duration(seconds) {
    if (seconds === null || seconds === undefined) return "—";
    const total = Math.round(Number(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = String(total % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
  }
  function date(unix) {
    return unix ? new Date(unix * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
  }
  function board() {
    return BOARDS[state.mode].find((item) => item.kind === state.kind) || BOARDS[state.mode][0];
  }

  // ---------------------------------------------------------------- URL state
  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    if (Object.hasOwn(BOARDS, params.get("mode") || "")) state.mode = params.get("mode");
    const kind = params.get("kind");
    if (BOARDS[state.mode].some((item) => item.kind === kind && !item.soon)) state.kind = kind;   // a "coming soon" ladder isn't a board yet
    else state.kind = BOARDS[state.mode][0].kind;
    state.sort = params.get("sort") || "";
    state.order = params.get("order") || "";
    state.offset = Math.max(0, Number.parseInt(params.get("offset") || "0", 10) || 0);
    state.week = params.get("week") || ""; state.viewBoss = params.get("boss") || ""; state.viewLadder = ladderOf(params.get("ladder")).id;
    // "View all": its ladder flipped, or listed by when the rows were submitted (newest or oldest first)
    state.viewOrder = state.viewBoss && ["asc", "desc", "submitted", "submitted_asc"].includes(state.order) ? state.order : "";
    state.season = params.get("season") || ""; state.split = params.get("split") || "";
    state.rows = ["teams", "players"].includes(params.get("rows")) ? params.get("rows") : storedRows();
    state.players = ["1", "2", "3", "4"].includes(params.get("players")) ? params.get("players") : "";   // the Party filter
    // the Season Ladder's sorted column (?rank=, so ?rank=stars from older links still works) and ?order=
    state.rank = Object.hasOwn(SEASON_SORTS, params.get("rank") || "") ? params.get("rank") : "score";
    state.rankOrder = board().custom === "season" && ["asc", "desc"].includes(state.order) ? state.order : "";
    state.server = params.get("server") || "";
    state.unlinked = params.get("unlinked") === "1"; els.unlinked.checked = state.unlinked;
    for (const name of ["cycle", "boss", "level", "difficulty", "trial", "style", "party", "buff", "player"]) {
      const field = els.filters.elements[name];
      if (field && params.get(name)) field.dataset.pending = params.get(name);
      if (field && field.tagName === "INPUT") field.value = params.get(name) || "";
    }
    els.filters.elements.cleared.checked = params.get("cleared") === "1";
    els.filters.elements.best.checked = params.get("best") === "0";
    els.filters.elements.hidden.checked = params.get("hidden") === "1";
  }
  function query() {
    const params = new URLSearchParams({ mode: state.mode, kind: state.kind });
    if (state.server) params.set("server", state.server);              // every board: one game server, or all
    if (state.unlinked) params.set("unlinked", "1");                   // every board: everyone's records, not only linked players
    if (board().custom === "boss") {
      if (state.week) params.set("week", state.week);
      if (state.rows === "players") params.set("rows", "players");      // Teams is the default
      if (state.players) params.set("players", state.players);         // the Party filter: hides rows, places stay
      if (state.viewBoss) {
        params.set("boss", state.viewBoss);
        params.set("ladder", state.viewLadder);
        if (state.viewOrder) params.set("order", state.viewOrder);
        if (state.offset) params.set("offset", String(state.offset));
      }
      return params;
    }
    if (board().custom === "season") {
      if (state.season) params.set("season", state.season);
      if (state.split) params.set("split", state.split);
      if (state.rank !== "score") params.set("rank", state.rank);
      if (state.rankOrder) params.set("order", state.rankOrder);
      return params;
    }
    if (state.sort) params.set("sort", state.sort);
    if (state.order) params.set("order", state.order);
    const fields = board().fields;
    for (const name of ["cycle", "boss", "level", "difficulty", "trial", "style", "party", "buff"]) {
      let value = els.filters.elements[name]?.value;
      if (name === "trial") value = String(value || "").split("|").pop();   // "<season>|<stage>|<element>": the API takes the element
      if (value && fields.includes(name)) params.set(name, value);
    }
    const season = fields.includes("trial") ? String(els.filters.elements.trial.value || "").split("|")[0] : "";
    if (season) params.set("cycle", season);                             // Sim: each season its own boards
    const player = els.filters.elements.player.value.trim();
    if (player) params.set("player", player);
    if (fields.includes("cleared") && els.filters.elements.cleared.checked) params.set("cleared", "1");
    if (els.filters.elements.best.checked) params.set("best", "0");
    if (state.status?.canModerate && els.filters.elements.hidden.checked) params.set("hidden", "1");
    if (state.offset) params.set("offset", String(state.offset));
    return params;
  }
  // Switching game mode, board, week or "View all" is a navigation (state.push: a new history entry, after the page
  // being left saves its scroll position in its own entry); sorting, filters and paging only rewrite the entry.
  // The browser's Back and Forward (popstate below) bring the board back.
  function writeUrl() {
    const url = new URL(window.location.href);
    url.search = query().toString();
    // a run open from the address (openRunFromUrl) stays in it until its viewer closes, so the address can be shared
    for (const [key, value] of Object.entries(state.openRun || {})) if (value) url.searchParams.set(key, value);
    const push = state.push && url.href !== window.location.href;
    state.push = false;
    if (push) {
      window.history.replaceState({ ...(window.history.state || {}), scroll: window.scrollY }, "", window.location.href);
      window.history.pushState(null, "", url);
    } else {
      window.history.replaceState(window.history.state, "", url);
    }
  }

  // ---------------------------------------------------------------- filters
  function fillSelect(select, options, emptyLabel) {
    const pending = select.dataset.pending ?? select.value;
    select.replaceChildren(el("option", { value: "", text: emptyLabel }));
    for (const option of options) select.append(el("option", { value: option.value, text: option.label }));
    if ([...select.options].some((option) => option.value === pending)) select.value = pending;
    delete select.dataset.pending;
    const picker = pickers.get(select);
    if (picker) { picker.input.placeholder = emptyLabel; picker.refresh(); }
  }
  // The long or growing lists (week or season, boss, trial, rogue buff) get the site's type-to-filter box
  // (/explorer/aniimo-picker.js). The select stays the source of truth: a pick sets it and fires "change", and code
  // that fills or sets one calls its picker's refresh().
  const pickers = new Map();
  function enhanceFilters() {
    for (const name of ["cycle", "boss", "trial", "buff"]) {
      const select = els.filters.elements[name];
      const picker = window.AniilogsPicker?.makeCombobox(select, { placeholder: select.options[0]?.text || "Type to filter", emptyText: "No matches" });
      if (picker) pickers.set(select, picker);
    }
  }
  function renderControls() {
    $("[data-mode-note]").hidden = state.mode !== "eggheist";
    $("[data-cycle-label]").textContent = state.mode === "eggheist" ? "Season" : "Week";
    document.querySelectorAll("[data-mode-tab]").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.modeTab === state.mode));
    });
    const pickBoard = (kind) => {
      if (state.kind === kind) return;
      state.push = true;
      state.kind = kind;
      state.sort = "";
      state.order = "";
      state.offset = 0;
      state.viewBoss = "";
      state.expanded.clear();
      renderControls();
      void loadEntries();
    };
    // Egg Heist's boards are ranked ladders, picked from one "Ladders" dropdown (PvP listed, not yet selectable)
    if (state.mode === "eggheist") {
      const select = el("select", { "aria-label": "Ladder", onchange: (event) => pickBoard(event.target.value) },
        ...BOARDS.eggheist.map((item) => el("option", { value: item.kind, text: item.label, disabled: item.soon ? "" : null })));
      select.value = state.kind;
      els.boardTabs.replaceChildren(el("label", { class: "lb-ladders" }, el("span", { text: "Ladders" }), select));
      els.boardTabs.hidden = false;
    } else els.boardTabs.replaceChildren(...BOARDS[state.mode].map((item) => el("button", {
      type: "button", role: "tab", "aria-selected": String(item.kind === state.kind), "data-kind": item.kind,
      text: item.label,
      onclick: () => pickBoard(item.kind),
    })));
    if (state.mode !== "eggheist") els.boardTabs.hidden = BOARDS[state.mode].length < 2;
    const custom = board().custom;
    els.filters.hidden = Boolean(custom);
    els.interlink.hidden = !custom;
    els.tableWrap.hidden = false;
    for (const node of [els.prev, els.next, els.page]) node.hidden = Boolean(custom);
    if (custom !== "boss") showRowsPick();          // Season Ladder and the other modes: no Show switch
    els.partyPick.hidden = custom !== "boss";       // the Party filter: Interlink's boss boards only
    els.partySelect.value = state.players;
    if (custom) return;
    const sorts = board().sorts;
    if (!sorts.includes(state.sort)) { state.sort = sorts[0]; state.order = ""; }
    const clearedLabel = els.filters.querySelector("[data-cleared-label]");
    if (clearedLabel) clearedLabel.textContent = state.kind === "eggheist_match" ? "Escapes only" : "Kills only";
    for (const label of els.filters.querySelectorAll("[data-field]")) {
      label.hidden = !board().fields.includes(label.dataset.field);
    }
    for (const node of document.querySelectorAll("[data-mod-only]")) node.hidden = !state.status?.canModerate;
  }
  async function loadFacets() {
    const response = await apiFetch(`/leaderboard/facets?mode=${state.mode}`);
    if (!response.ok) return;
    const facets = await response.json();
    state.facets = facets;
    // the game servers this mode has records from (records from older apps have none and show under "All servers")
    const servers = facets.servers || [];
    els.serverPick.hidden = !servers.length;
    els.serverSelect.replaceChildren(el("option", { value: "", text: "All servers" }),
      ...servers.map((row) => el("option", { value: row.value, text: row.value })));
    els.serverSelect.value = servers.some((row) => row.value === state.server) ? state.server : "";
    const f = els.filters.elements;
    const seasonMode = state.mode === "eggheist";
    fillSelect(f.cycle, facets.cycles.map((row) => ({ value: row.value, label: seasonMode ? `Season ${row.value}` : `Cycle ${row.value}` })),
      seasonMode ? "All seasons" : "All weeks");
    fillSelect(f.boss, facets.bosses.map((row) => ({ value: row.id, label: row.name || row.id })), "All bosses");
    fillSelect(f.level, facets.levels.map((row) => ({ value: row.value, label: `Lv ${row.value}` })), "Any");
    if (f.difficulty) fillSelect(f.difficulty, (facets.difficulties || []).map((row) => ({ value: row.value, label: row.value })), "Any difficulty");
    fillSelect(f.party, facets.partySizes.map((row) => ({ value: row.value, label: row.value === 1 ? "Solo" : `${row.value} players` })), "Any size");
    fillSelect(f.buff, (facets.buffs || []).map((row) => ({ value: row.name, label: `${row.name} (${row.count})` })), "Any buff");
    const styleCounts = new Map((facets.styles || []).map((row) => [row.value, row.count]));
    fillSelect(f.style, (facets.simRules?.styles || []).map((name) => ({ value: name, label: styleCounts.has(name) ? `${name} (${styleCounts.get(name)})` : name })), "Any style");
    fillSimPickers();
  }
  // Holo-Battle Sim: one board per season, stage and difficulty. The Trial picker lists the game's stages from the API's
  // rules, newest season first and grouped (Season 2 · Training: Earth / Lightning / Dark Training; Season 1 · Basic
  // Training: Training of Grass / Water / Fire; Season 1 · Elemental Crucible: Crucible of …), each option's value
  // "<season>|<stage>|<element>"; Difficulty lists that stage's difficulties (the hardest one with runs, unless one was
  // picked).
  function fillSimPickers() {
    const f = els.filters.elements;
    const seasons = state.facets?.simRules?.seasons;
    if (state.mode !== "sim" || !seasons?.length) return;
    const pendingElement = f.trial.dataset.pending;
    const pendingLevel = f.difficulty.dataset.pending;
    const pendingSeason = new URLSearchParams(window.location.search).get("cycle");
    const season = pendingElement && (seasons.find((item) => String(item.season) === pendingSeason && item.elements.includes(pendingElement))
      || seasons.find((item) => item.elements.includes(pendingElement)));
    const stage = season && (season.stages.find((item) => item.difficulties.includes(pendingLevel)) || season.stages[0]);
    const chosen = season ? `${season.season}|${stage.id}|${pendingElement}` : f.trial.value;
    f.trial.replaceChildren(...seasons.flatMap((item) => item.stages.map((stage) => el("optgroup", { label: `Season ${item.season} · ${stage.label}` },
      item.elements.map((element) => el("option", { value: `${item.season}|${stage.id}|${element}`,
        text: `${stage.name.replace("{element}", element)}${stage.alias ? ` (${stage.alias.replace("{element}", element)})` : ""}` }))))));
    f.trial.value = [...f.trial.options].some((option) => option.value === chosen) ? chosen : f.trial.options[0].value;
    delete f.trial.dataset.pending;
    const [seasonId, stageId, element] = f.trial.value.split("|");
    const levels = simStageOf(seasonId, stageId).difficulties;
    const withRuns = (state.facets.trials || []).filter((row) => String(row.season) === seasonId && row.trial === element && levels.includes(row.difficulty))
      .map((row) => row.difficulty);
    const level = pendingLevel ?? f.difficulty.value;
    f.difficulty.replaceChildren(...levels.map((name) => el("option", { value: name, text: name })));
    f.difficulty.value = levels.includes(level) ? level : [...levels].reverse().find((name) => withRuns.includes(name)) || levels.at(-1);
    delete f.difficulty.dataset.pending;
    pickers.get(f.trial)?.refresh();
  }
  function simStageOf(seasonId, stageId) {
    return state.facets?.simRules?.seasons?.find((item) => String(item.season) === seasonId)?.stages.find((item) => item.id === stageId) || null;
  }
  // the board's name for the summary: "Earth Training - Trial"
  function simBoardName() {
    const f = els.filters.elements;
    const [seasonId, stageId, element] = String(f.trial.value || "").split("|");
    const stage = simStageOf(seasonId, stageId);
    return stage && element ? `${stage.name.replace("{element}", element)}${f.difficulty.value ? ` - ${f.difficulty.value}` : ""}` : "";
  }

  // ---------------------------------------------------------------- table
  // A column header: a sort button (▲/▼ and aria-sort while the table is sorted by it) when the column sorts, plain
  // text otherwise, with its (i) explanation if it has one.
  function headCell(label, { sortable = false, active = false, order = "desc", onSort = null, info = null, className = null } = {}) {
    if (!sortable) {
      return info ? el("th", { scope: "col", class: className }, el("span", { class: "lb-th-info" }, el("span", { text: label }), info))
        : el("th", { scope: "col", class: className, text: label });
    }
    return el("th", { scope: "col", class: className, "aria-sort": active ? (order === "asc" ? "ascending" : "descending") : null },
      el("button", { type: "button", class: active ? "lb-sort is-active" : "lb-sort", title: `Sort by ${label}`,
        text: label + (active ? (order === "asc" ? " ▲" : " ▼") : ""), onclick: onSort }), info);
  }
  function renderHead() {
    const columns = COLUMNS[state.kind];
    const headers = [el("th", { scope: "col", text: "#" })];
    for (const column of [{ label: "Player", sort: "player" }, ...columns]) {
      const active = state.sort === column.sort;
      headers.push(headCell(column.label, {
        sortable: Boolean(column.sort) && board().sorts.includes(column.sort), active, order: currentOrder(),
        info: column.info ? infoButton(column.info) : null,
        onSort: () => {
          if (active) state.order = currentOrder() === "asc" ? "desc" : "asc";
          else { state.sort = column.sort; state.order = ""; }
          state.offset = 0;
          renderControls();
          void loadEntries();
        },
      }));
    }
    els.head.replaceChildren(el("tr", {}, headers));
  }
  function currentOrder() {
    if (state.order) return state.order;
    return ASCENDING_SORTS.has(state.sort) ? "asc" : "desc";
  }
  function gizmoSeries(setup) {
    return (setup?.gizmos || []).map((row) => (row.count == null ? row.series : `${row.series} ${row.count}`)).join(" · ");
  }
  // a Holo-Battle Sim run's setup, as aLogs read it from the Victory screen and the gizmo row: text only
  function simSetup(setup) {
    if (!setup) return null;
    const facts = [["Training Style", setup.style], ["Core", setup.core], ["Alpha Transformation", setup.transform],
      ["Coins", setup.coins == null ? null : number(setup.coins)], ["Gizmos", gizmoSeries(setup)]].filter(([, value]) => value);
    const shares = [["damage", "Damage"], ["taken", "Damage taken"], ["healing", "Healing"]]
      .filter(([key]) => setup.mvpShares?.[key] != null).map(([key, label]) => `${label} ${number(setup.mvpShares[key])}%`);
    const picked = (setup.gizmos || []).some((row) => row.picked?.length)
      ? (setup.gizmos || []).filter((row) => row.picked?.length).map((row) => el("li", {}, el("strong", { text: `${row.series}: ` }),
        row.picked.map((item) => `${item.name}${item.rarity ? ` (${item.rarity})` : ""}`).join(", ")))
      : (setup.picked || []).map((item) => el("li", { text: `${item.series ? `${item.series} · ` : ""}${item.name}${item.rarity ? ` (${item.rarity})` : ""}` }));
    return el("div", { class: "lb-setup" },
      el("strong", { text: "Setup" }),
      setup.team?.length ? el("ol", { class: "lb-setup-team" }, setup.team.map((member) => el("li", {},
        el("span", { text: `${member.name}${member.level ? ` Lv ${member.level}` : ""}` }),
        // the run records only the name (read from the result screen): the Aniilog finds the Aniimo by it
        member.name ? window.AniilogsAniimoLink?.create(member.name, member.name) : null,
        member.mvp ? el("span", { class: "lb-mark lb-mvp", text: "MVP" }) : null))) : null,
      shares.length ? el("p", { class: "lb-facts", text: `MVP share: ${shares.join(" · ")}` }) : null,
      facts.length ? el("dl", { class: "lb-setup-facts" }, facts.flatMap(([label, value]) => [el("dt", { text: label }), el("dd", { text: value })])) : null,
      picked.length ? el("details", { class: "lb-setup-picked" }, el("summary", { text: "Picked gizmos" }), el("ul", {}, picked)) : null);
  }
  function detailRow(entry, span) {
    const parts = [];
    if (entry.players?.length) {
      const rows = entry.players.map((player) => el("tr", {},
        el("td", {}, profileName(player.name || "—", player.profileId), player.ai ? el("span", { class: "lb-ai", text: "AI" }) : null,
          player.lookalike ? el("span", { class: "lb-mark lb-lookalike", title: "This name looks like a claimed player's name. Only the UID tells players apart.", text: "≈" }) : null),
        el("td", { text: player.stat ? `${player.stat}: ${number(player.value)}` : "—" }),
        el("td", { text: number(player.avgDps) }),
        el("td", { text: number(player.breakValue) }),
        el("td", { text: number(player.damageTaken) }),
        el("td", { text: number(player.heal) })));
      parts.push(el("table", { class: "lb-players" },
        el("thead", {}, el("tr", {}, ["Player", "Highlight", "Avg DPS", "BREAK", "Damage taken", "Healing"].map((text) => el("th", { text })))),
        el("tbody", {}, rows)));
    }
    const setup = simSetup(entry.extra?.setup);
    if (setup) parts.push(setup);
    const teams = partyPanel({ lineup: entry.extra?.lineup });         // each player's team (the buffs are below)
    if (teams) parts.push(teams);
    if (entry.buffs?.length) {
      parts.push(el("div", { class: "lb-buffs" }, el("strong", { text: "Rogue buffs" }),
        el("ol", {}, entry.buffs.map((buff) => el("li", { text: `${buff.floor ? `F${buff.floor} · ` : ""}${buff.name}${buff.level ? ` Lv ${buff.level}` : ""}` })))));
    }
    const facts = [];
    if (entry.meterDps !== null && entry.meterDps !== undefined) facts.push(`Meter DPS ${number(entry.meterDps)}`);
    if (entry.meterDamage) facts.push(`meter damage ${number(entry.meterDamage)}`);
    if (entry.status === "hidden") facts.push(entry.extra?.autoHidden === "party" ? "hidden: its Party screen shows another party"
      : entry.extra?.autoHidden === "check" ? "hidden: held for review by the run checks" : "hidden by a moderator");
    if (facts.length) parts.push(el("p", { class: "lb-facts", text: facts.join(" · ") }));
    const actions = [];
    if (entry.hasEvidence) {
      actions.push(el("button", { type: "button", class: "secondary-button", text: "View screenshot", onclick: (event) => showEvidence(entry, event.currentTarget) }));
    }
    if (state.status?.canModerate) {
      const hide = entry.status !== "hidden";
      actions.push(el("button", { type: "button", class: "secondary-button", text: hide ? "Hide" : "Unhide", onclick: () => moderate(entry, hide ? "hidden" : "visible") }));
    }
    if (actions.length) parts.push(el("div", { class: "lb-actions" }, actions));
    if (!parts.length) parts.push(el("p", { class: "lb-facts", text: "No further details were recorded for this entry." }));
    return el("tr", { class: "lb-detail" }, el("td", { colspan: span }, parts));
  }
  // View all's phone layout (leaderboard.css shows it, not the table, from 900px down): put in, or taken out
  function showStack(node = null) {
    els.tableWrap.querySelector(".lb-stack")?.remove();
    els.tableWrap.classList.toggle("has-stack", Boolean(node));
    if (node) els.tableWrap.append(node);
  }
  function renderRows(entries) {
    showStack();
    const columns = COLUMNS[state.kind];
    const span = columns.length + 2;
    const rows = [];
    for (const entry of entries) {
      const open = state.expanded.has(entry.submissionId);
      const cells = [
        el("td", { class: "lb-rank", text: String(entry.rank) }),
        el("td", { class: entry.unclaimed ? "lb-player is-unclaimed" : "lb-player", title: entry.unclaimed ? UNCLAIMED_TEXT : null }, el("button", {
          type: "button", class: "lb-expand", "aria-expanded": String(open), text: entry.discordName ? null : entry.player || "—",
          title: [entry.discordName ? `Discord name · character ${entry.player}` : "", entry.uid ? `UID ${entry.uid}` : ""].filter(Boolean).join(" · ") || null,
          onclick: () => {
            if (state.expanded.has(entry.submissionId)) state.expanded.delete(entry.submissionId);
            else state.expanded.add(entry.submissionId);
            renderRows(entries);
          },
        }, entry.discordName ? shownName(entry.discordName, "discord") : null), ...nameMarks(entry),
        entry.hasEvidence ? proofButton(entry.submissionId) : null,
        entry.profileId ? profileName("View profile", entry.profileId, { class: "lb-character" }) : null),
        ...columns.map((column) => el("td", { text: column.value(entry) })),
      ];
      rows.push(el("tr", { class: [entry.own ? "is-own" : "", entry.status === "hidden" ? "is-hidden" : ""].join(" ").trim() || null }, cells));
      if (open) rows.push(detailRow(entry, span));
    }
    if (!rows.length) rows.push(el("tr", {}, el("td", { colspan: span, class: "lb-empty", text: "No records match these filters yet." })));
    els.rows.replaceChildren(...rows);
  }
  // ---------------------------------------------------------------- Interlink weeks and seasons
  // The game's challenge-rating star, drawn for the boards (not the game's art).
  function starIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "lb-star"); svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = '<circle cx="12" cy="12" r="11" fill="#f2c230" stroke="#c98e12" stroke-width="1.5"/>'
      + '<path d="M12 5.2l1.95 4.1 4.5.55-3.3 3.1.85 4.45L12 15.2l-4 2.2.85-4.45-3.3-3.1 4.5-.55z" fill="#7a4b00"/>';
    return svg;
  }
  // The line icon for a row's "last updated": a calendar (drawn here).
  function calendarIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "lb-line-icon"); svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></g>';
    return svg;
  }
  // A Per Boss row's "Submitted": a calendar icon, last in the row's icons; hover or tap shows when that player's
  // best run reached AniiLogs.
  function updatedIcon(unix) {
    if (!unix) return el("span", { class: "lb-row-when" });
    const at = new Date(unix * 1000);
    const tip = `Submitted ${at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} (${agoText(unix)})`;
    const button = el("button", { type: "button", class: "lb-row-when", title: tip, "aria-label": tip, "data-tip": tip,
      onclick: (event) => {
        event.stopPropagation();
        const open = !button.classList.contains("is-open");
        for (const other of document.querySelectorAll(".lb-row-when.is-open")) other.classList.remove("is-open");
        button.classList.toggle("is-open", open);
      } });
    button.append(calendarIcon());
    return button;
  }
  function stars(value) {
    return el("span", { class: "lb-stars" }, starIcon(), el("span", { text: number(value) }));
  }
  // When a week ran, said the way people do: "this week" while it runs, then "last week", "2 weeks ago", ... counted
  // in whole weeks since it ended, so a week that ended stops calling itself "this week" even before the next one is known.
  function weekAgo(week, now = Date.now() / 1000) {
    if (!week) return "this week";
    if (now < week.start) return "upcoming";
    if (now <= week.end) return "this week";
    const weeks = Math.max(1, Math.ceil((now - week.end) / (7 * 86400)));
    return weeks === 1 ? "last week" : `${weeks} weeks ago`;
  }
  // The proof viewer is shared with My runs (/proof-viewer.js, loaded first)
  const proofViewer = window.AniilogsProof;
  const proofButton = (...args) => proofViewer.button(...args);
  const partyPanel = (details) => proofViewer.partyPanel(details);
  const checkBadge = (check) => proofViewer.checkBadge(check);
  // How the game's Challenge Score adds up (bossrush_grade_data in the game files, checked against recorded runs).
  // Explanations behind the (i) next to a column name, in a popover (one shared element per explanation)
  const INFO = Object.freeze({
    defeats: {
      title: "What Total Defeats counts",
      points: [
        "Opponents you beat in battles during the match: the guard and elite Aniimo you actually fight.",
        "Not the regular monsters you sneak past or hit out in the open, and not times you were knocked out.",
        "It's the game's own number from the end screen (the Chinese original says \u201ctotal defeated\u201d).",
      ],
    },
  });
  function infoButton(key) {
    const id = `lbInfo-${key}`;
    if (!document.getElementById(id)) {
      const info = INFO[key];
      document.body.append(el("div", { id, class: "lb-info-pop", popover: "auto" },
        el("strong", { text: info.title }), el("ul", {}, ...info.points.map((text) => el("li", { text })))));
    }
    return el("button", { type: "button", class: "lb-info", popovertarget: id, "aria-label": INFO[key].title, text: "i",
      onclick: (event) => event.stopPropagation() });
  }
  // ---------------------------------------------------------------- Interlink: Per Boss and Season Ladder
  // What a boss board can rank by (the API's ?ladder=). Each is a separate best, with the run behind it as its proof.
  const LADDERS = [
    { id: "score", label: "Score", proof: "score", value: (e) => number(e.score) },
    { id: "stars", label: "Stars", proof: "score", value: (e) => number(e.score) },
    { id: "clear", label: "Fastest clear", short: "Time", proof: "clear", value: (e, boss) => clearText(e, boss) },
    { id: "teamDps", label: "Team DPS", proof: "teamDps", value: (e) => number(e.teamDps) },
    { id: "dps", label: "Avg DPS (one player)", short: "Avg DPS", proof: "dps", value: (e) => number(e.avgDps) },
    { id: "break", label: "BREAK damage (one player)", short: "BREAK", proof: "break", value: (e) => number(e.breakValue) },
    { id: "heal", label: "Healing (one player)", short: "Healing", proof: "heal", value: (e) => number(e.heal) },
  ];
  function ladderOf(id) {
    return LADDERS.find((ladder) => ladder.id === id) || LADDERS[0];
  }
  const BOARD_ROWS = 10;                                  // a boss board's top rows; "View all" pages the rest
  const FULL_ROWS = 25;
  const SLOT_CLASSES = ["is-left", "is-center", "is-right"];
  // How a run ended, with its battle clock: "Boss Killed" ("Both Killed" on a two-boss board), "Early Exit" (every
  // star, the leader ended it) or "Timed Out" (a quit run - invalid - is on no board); "Menu proof" when there's no
  // clock. Runs from before outcomes were kept go by their clear time. An "unconfirmed" run - a two-boss center that
  // ended under the clock without every star - shows its time alone: until a live run shows how the two bosses' stars
  // add up, the site can't say if it was a kill.
  function clearText(entry, boss = null) {
    const time = entry.runTimeS ?? entry.clearTimeS;
    if (entry.outcome === "unconfirmed") return duration(time);
    const killed = boss?.second ? "Both Killed" : "Boss Killed";
    const ending = entry.outcome === "ended-early" ? "Early Exit" : entry.outcome === "cleared" ? killed
      : entry.outcome === "time-up" ? "Timed Out" : entry.clearTimeS != null ? killed : time != null ? "Timed Out" : null;
    if (!ending) return "Menu proof";                 // sent from the game's menu (its best), not a result screen
    return time == null ? ending : `${ending}: ${duration(time)}`;
  }
  function shortDate(unix) {
    return new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  // A two-boss fight (weeks 4003-4005's center: the second boss comes when the first dies, in the same run) is named by
  // both bosses: "Alpha Blazen + Omega Tucking", on its tab "Blazen + Tucking".
  function bossName(boss) {
    return boss.second ? `${boss.name} + ${boss.second.name}` : boss.name;
  }
  function bossTab(boss) {
    const short = (name) => String(name).replace(/^(Alpha|Omega) /u, "");
    return boss.second ? `${short(boss.name)} + ${short(boss.second.name)}` : short(boss.name);
  }
  // The rules line over a week's boards. Live runs on the two-boss Center (week 4003) confirmed its cap (40) and earned
  // all 40 stars with the second boss still up at the clock's end, so a kill's stars are only said for the other
  // fights; the two-boss fight gets one sentence of its own. slots: rules.slots; bosses: the week's boards.
  function rulesLine(caps, clear, slots, bosses) {
    const pairs = bosses.filter((boss) => boss.second && boss.slotIndex != null);
    const paired = (slot) => pairs.some((boss) => boss.slotIndex === slot);
    const slotName = (slot) => slots[slot] || `boss ${slot + 1}`;
    const parts = [];
    if (caps.length) parts.push({ label: "Max stars ", text: caps.join(" / ") });
    const kills = clear.map((value, slot) => ({ value, slot })).filter(({ slot }) => !paired(slot));
    if (kills.length && !pairs.length) parts.push({ text: `A kill is ${new Set(clear).size === 1 ? clear[0] : clear.join(" / ")} stars` });
    else if (kills.length && new Set(kills.map((kill) => kill.value)).size === 1) {
      parts.push({ text: `A kill is ${kills[0].value} stars on the ${kills.map((kill) => slotName(kill.slot)).join(" and ")}` });
    } else if (kills.length) parts.push({ text: `A kill is ${kills.map((kill) => `${kill.value} stars on the ${slotName(kill.slot)}`).join(", ")}` });
    for (const boss of pairs) {
      parts.push({ pair: true, text: `The ${boss.slot || slotName(boss.slotIndex)} is two bosses in one run: ${boss.name}, then ${boss.second.name}.` });
    }
    return parts;
  }
  function weekRange(week) {
    return `Week of ${shortDate(week.start)} – ${shortDate(week.end)}`;
  }
  // When the newest run on these boards reached AniiLogs
  function agoText(unix) {
    const minutes = Math.max(0, Math.round((Date.now() / 1000 - unix) / 60));
    return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago`
      : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`;
  }
  function updatedLine(unix) {
    if (!unix) return el("p", { class: "lb-updated" }, el("i", { "aria-hidden": "true" }), "No runs sent yet");
    const when = new Date(unix * 1000).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    return el("p", { class: "lb-updated", title: "When the newest run on these boards reached AniiLogs" },
      el("i", { "aria-hidden": "true" }), `Updated ${when} (${agoText(unix)})`);
  }
  // A player's own "last updated": when their best run on this board (or their newest best, for totals) reached AniiLogs.
  function playerUpdated(unix, label = "Updated ") {
    if (!unix) return null;
    const at = new Date(unix * 1000);
    return el("time", { class: "lb-when", datetime: at.toISOString(), title: `New best sent ${at.toLocaleString()} (${agoText(unix)})`,
      text: `${label}${at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` });
  }
  // How a board row's run ended, with its proof pictures beside it: [Solo / Duo / Trio tag, text, pictures, link]. The
  // link (share.js) is the row's place on this ladder: a one-player ladder's is the player's own row.
  function resultLine(entry, ladder, boss = null) {
    const proofId = entry.proofIds?.[ladder.proof] || entry.proofId;
    const link = proofId ? { run: proofId, ladder: ladder.id, player: ONE_PLAYER_COLUMNS.includes(ladder.id) ? entry.player : undefined } : null;
    return [share?.tag(entry.realPlayers) || null, clearText(entry, boss),
      proofButton(proofId, rowCheck(entry, ladder), entry.menuProofId, link ? { link: { ...link, realPlayers: entry.realPlayers } } : {}),
      share?.button(link) || null];
  }
  const share = window.AniilogsShare;
  // A board row's badge: its run's check, or "invalid" when the row has no proof pictures at all
  function rowCheck(entry, ladder) {
    return Object.keys(entry.proofIds || {}).length ? entry.checks?.[ladder.proof] || entry.checks?.score : "invalid";
  }
  // a table's player cell (View all, Season Ladder): the name line, then the run's check
  function playerName(entry, check = null) {
    return nameLine(entry, checkBadge(check));
  }
  function bossHead(boss, className, detail = "") {
    return el("div", { class: className },
      el("div", {}, el("div", { class: "lb-slot", text: [boss.slot || "Boss", detail].filter(Boolean).join(" · ") }),
        el("h3", {}, bossName(boss), boss.level ? el("small", { text: ` · Lv ${boss.level}` }) : null)),
      boss.starCap ? el("div", { class: "lb-cap" }, el("span", { text: "Max stars" }), stars(boss.starCap)) : null);
  }
  function failed() {
    showStack();
    els.summary.textContent = "The leaderboard could not be loaded.";
    els.interlink.replaceChildren();
    els.tableWrap.hidden = true;
    state.fullTeams = false;
    showRowsPick();
  }

  // Per Boss: the week's three boards, each with its own ladder menu. A row: the place, then one line per player on
  // the left, and on the right the ladder's figure over the stars, how the run ended and the run's icons (rowFigures).
  // Team ladders rank runs: one Interlink run sent by each of its players is one result, its players sharing a row and
  // its place (Teams), or one row each with that place (Players). Avg DPS, BREAK and healing are one player's own.
  const TEAM_LADDERS = ["score", "stars", "clear", "teamDps"];
  // the Teams / Players switch: on team ladders, once the API sends team rows (boss.teams)
  function hasTeams(boss, ladder) {
    return TEAM_LADDERS.includes(ladder.id) && boss.teams !== undefined;
  }
  function teamView(boss, ladder) {
    return hasTeams(boss, ladder) && state.rows === "teams";
  }
  // a board's entries as its team rows: the players of one row are next to each other and share `team`
  function teamsOf(entries) {
    const teams = [];
    for (const entry of entries) {
      if (teams.length && teams[teams.length - 1][0].team === entry.team) teams[teams.length - 1].push(entry);
      else teams.push([entry]);
    }
    return teams;
  }
  // a team row's "last updated": when the first of its players' copies reached AniiLogs
  function teamUpdated(members) {
    const times = members.map((entry) => entry.updatedAt).filter(Boolean);
    return times.length ? Math.min(...times) : null;
  }
  // Every copy of a team row's run that came with pictures: the lead's is on the row's result line; a player whose
  // pictures are another copy (their own app's) gets that copy's button by their name. A copy is shown once (a
  // teammate credited from someone's copy has that copy's pictures). entry -> proof id, or null
  function copyProofs(members, ladder) {
    const proofOf = (entry) => entry.proofIds?.[ladder.proof] || entry.proofId || null;
    const seen = new Set([proofOf(members[0])].filter(Boolean));
    return new Map(members.map((entry) => {
      const id = proofOf(entry);
      if (!id || seen.has(id)) return [entry, null];
      seen.add(id);
      return [entry, id];
    }));
  }
  function memberProof(entry, proofs, ladder) {
    return proofs.get(entry) ? proofButton(proofs.get(entry), rowCheck(entry, ladder)) : null;
  }
  // A team row's seats, each { kind, seat, entry }: its players ("player"), the players on the run who are ranked with
  // another run ("also", the API's lead.also) and the run's bots ("bot", lead.bots, the API's one bot rule). The API
  // sends a seat (1-4, the run's 1P-4P) only when it knows it. In seat order when every line has one; otherwise the
  // players, then the also-players, then the bots, as the API lists them.
  const seatOf = (value) => ([1, 2, 3, 4].includes(value) ? value : null);
  function teamSeats(members) {
    const lead = members[0];
    const items = [
      ...members.map((entry) => ({ kind: "player", seat: seatOf(entry.seat), entry })),
      ...(Array.isArray(lead?.also) ? lead.also : []).map((entry) => ({ kind: "also", seat: seatOf(entry?.seat), entry })),
      ...(Array.isArray(lead?.bots) ? lead.bots : []).map((bot) => ({ kind: "bot", seat: seatOf(bot?.seat),
        entry: { name: String((typeof bot === "string" ? bot : bot?.name) || "") } })),
    ];
    if (items.every((item) => item.seat)) items.sort((a, b) => a.seat - b.seat);
    return items;
  }
  // The game's seat mark left of a name on a team row: 1P-4P, or "Ai" for a bot in place of its number (the game's own
  // pictures, from the content store; never in this repository). Until a picture loads, or when it can't, its text in
  // the same spot: "1P" ... "4P", and the "AI" pill for a bot. No seat: the same empty space, so the names line up.
  const SEAT_PICTURES = Object.freeze({ 1: "1p", 2: "2p", 3: "3p", 4: "4p", ai: "ai" });
  function contentUrl(path) {
    const base = String(siteConfig.contentBaseUrl || "").replace(/\/+$/u, "");
    if (!base) return "";
    const url = new URL(`${base}/${path}`, window.location.href);
    if (siteConfig.contentRevision) url.searchParams.set("v", String(siteConfig.contentRevision));
    return url.toString();
  }
  function seatMark(seat, bot = false) {
    const box = el("span", { class: "lb-seat" });
    const label = bot ? "AI" : seat ? `${seat}P` : "";
    if (!label) return box;
    const fallback = () => box.replaceChildren(bot ? botPill() : el("span", { class: "lb-seat-text", text: label }));
    const src = contentUrl(`assets/ui/position/${SEAT_PICTURES[bot ? "ai" : seat]}.png`);
    if (!src) { fallback(); return box; }
    const picture = el("img", { src, alt: label, width: bot ? 93 : 90, height: bot ? 87 : 85, decoding: "async", title: bot ? BOT_TEXT : null });
    picture.addEventListener("error", fallback, { once: true });
    box.append(picture);
    return box;
  }
  // One line per seat (teamSeats), each starting with its mark: a player's name line with their own copy's pictures; an
  // also-player's name in italics with their place, "Name (1st)" (a link when they have a public profile); a bot's
  // name, plain softer text, never a link. Bots and also-players are never claimed and never "you".
  const BOT_TEXT = "A bot the game added to fill the team.";
  function teamNames(members, ladder) {
    const proofs = copyProofs(members, ladder);
    return teamSeats(members).map((item) => seatLine(item, item.kind === "player" ? [memberProof(item.entry, proofs, ladder)] : []));
  }
  function seatLine(item, extra = []) {
    const mark = seatMark(item.seat, item.kind === "bot");
    if (item.kind === "bot") return el("span", { class: "lb-who-name lb-bot", title: BOT_TEXT }, mark, fullTitle(el("span", { class: "lb-name", text: item.entry.name })));
    if (item.kind === "also") {
      const other = item.entry;
      const place = ordinal(other.rank);
      const name = other.discordName ? profileName(other.discordName, other.profileId, { class: "lb-name" }, null, other.player)
        : profileName(other.player || "Pathfinder", other.profileId, { class: "lb-name" });
      return el("span", { class: "lb-who-name lb-also-line", title: `Ranked ${place} with another run.` }, mark, fullTitle(name),
        el("span", { class: "lb-also-place", text: `(${place})` }));
    }
    const line = nameLine(item.entry, ...extra);
    line.prepend(mark);
    return line;
  }
  function botPill() {
    return el("span", { class: "lb-ai", title: BOT_TEXT, text: "AI" });
  }
  // View all's result cell: how the run ended, its one check badge and its proof pictures
  function teamResult(lead, ladder, boss) {
    const [tag, text, proof, link] = resultLine(lead, ladder, boss);
    return [tag, text, checkBadge(rowCheck(lead, ladder)), proof, link];
  }
  // A Per Boss row's right column, right-aligned, top to bottom: the ladder's figure, the stars, how the run ended (the
  // Solo / Duo / Trio tag, then "Boss Killed: 1:55"), then one line of icons: the run's check, its pictures, its link
  // and the "last updated" calendar. The same in both views (Teams: the lead's copy; Players: the player's own best).
  function rowFigures(entry, ladder, boss, updatedAt) {
    const [tag, text, proof, link] = resultLine(entry, ladder, boss);
    return el("span", { class: "lb-figs" },
      el("span", { class: "lb-val", text: ladder.value(entry, boss) }), stars(entry.stars),
      el("small", { class: "lb-row-result" }, tag, el("span", { class: "lb-outcome", text })),
      el("span", { class: "lb-row-icons" }, checkBadge(rowCheck(entry, ladder)), proof, link, updatedIcon(updatedAt)));
  }
  // The page's one Teams / Players switch (beside Server and Show unlinked): it changes every board on the page, or
  // View all's table. The control stays in place while the boards reload, so keyboard focus stays on the pressed button.
  function setRows(value) {
    if (state.rows === value) return;
    state.rows = value;
    storeRows(value);
    showRowsPick();
    if (state.viewBoss) { state.offset = 0; void loadEntries(); return; }
    writeUrl();
    // every board on the page in the new view, each with its own ladder
    for (const node of els.interlink.querySelectorAll(".lb-boss[data-board-id]")) {
      const { boardId, week } = node.dataset;
      void loadBoard(boardId, state.ladders[`${week}:${boardId}`], week);
    }
  }
  // Shown only where it changes something: a Per Boss page (or View all) with at least one board on a team ladder
  // (Score, Stars, Fastest clear, Team DPS) that has team rows. Boards mark that with data-teams; View all with
  // state.fullTeams. Only boards on screen count: a phone shows one boss at a time (the Left / Center / Right tabs).
  // Called after every draw of a board, when the boss tab changes and when the page crosses the phone width.
  function showRowsPick() {
    const interlink = board().custom === "boss" && !els.interlink.hidden;
    const shown = [...els.interlink.querySelectorAll(".lb-boss[data-teams]")].some((node) => node.offsetParent !== null);
    const applies = interlink && (state.viewBoss ? Boolean(state.fullTeams) : shown);
    els.rowsPick.hidden = !applies;
    for (const button of els.rowsPick.querySelectorAll("[data-rows-choice]")) button.setAttribute("aria-pressed", String(button.dataset.rowsChoice === state.rows));
  }

  function bossBoard(boss, cycleId = state.week) {
    const ladder = ladderOf(state.ladders[`${cycleId}:${boss.id}`]);
    const select = el("select", { "aria-label": `Rank the ${boss.slot || boss.name} board by`,
      onchange: (event) => { void loadBoard(boss.id, event.target.value, cycleId); } },
    ...LADDERS.map((item) => el("option", { value: item.id, text: item.label })));
    select.value = ladder.id;
    const teams = teamView(boss, ladder);
    // A row, both views: three columns, top-aligned: the place | one line per seat (Teams: players, players ranked with another run, bots) | the
    // ladder's figure, stars, outcome and icons (rowFigures).
    const playerRow = (entry) => el("li", { class: entry.own ? "lb-row is-own" : "lb-row", "data-place": String(entry.rank) },
      el("span", { class: "lb-rk", text: String(entry.rank) }),
      el("span", { class: "lb-who" }, nameLine(entry)),
      rowFigures(entry, ladder, boss, entry.updatedAt));
    const teamRow = (members) => {
      const lead = members[0];
      return el("li", { class: members.some((entry) => entry.own) ? "lb-row lb-team is-own" : "lb-row lb-team", "data-place": String(lead.rank) },
        el("span", { class: "lb-rk", text: String(lead.rank) }),
        el("span", { class: "lb-who" }, ...teamNames(members, ladder)),
        rowFigures(lead, ladder, boss, teamUpdated(members)));
    };
    const rows = teams ? teamsOf(boss.entries).map(teamRow) : boss.entries.map(playerRow);
    // over the rows: what each column is
    const head = el("div", { class: "lb-rows-head", "aria-hidden": "true" }, el("span", { text: "#" }), el("span", { text: teams ? "Team" : "Player" }),
      el("span", { text: ladder.label.replace(/ \(one player\)$/u, "") }));
    const count = teams ? boss.teams : boss.total;
    const noun = boss.teams === undefined ? "" : ` ${teams ? "team" : "player"}${count === 1 ? "" : "s"}`;
    return el("article", { class: `lb-boss ${SLOT_CLASSES[boss.slotIndex] || ""}`, "data-board-id": boss.id, "data-week": cycleId,
      "data-shown": String(boss.slotIndex == null || boss.slotIndex === state.slot),
      "data-teams": hasTeams(boss, ladder) && boss.total ? "" : null },      // the page's Show switch applies (nothing to switch on an empty board)
    bossHead(boss, "lb-boss-head"),
    el("label", { class: "lb-ladder" }, el("span", { text: "Ladder" }), select),
    rows.length ? head : null,
    rows.length ? el("ol", { class: "lb-rows" }, rows)
      : el("p", { class: "lb-empty", text: state.players ? "No runs of this party size on this board." : ladder.id === "score" ? "No runs on this boss yet." : `No ${ladder.label.replace(/ \(one player\)$/u, "").toLowerCase()} on this boss yet.` }),
    boss.total ? el("button", { type: "button", class: "lb-more", text: `View all ${number(count)}${noun} →`,
      onclick: () => {
        state.push = true;
        state.returnWeek = state.week; state.week = cycleId;     // back from "View all" returns to this page
        state.viewBoss = boss.id; state.viewLadder = ladder.id; state.viewOrder = ""; state.offset = 0; void loadEntries();
      } }) : null);
  }
  // One board's ladder changed: reload just that board.
  async function loadBoard(bossId, ladderId, cycleId) {
    const key = `${cycleId}:${bossId}`;
    state.ladders[key] = ladderOf(ladderId).id;
    const ask = new URLSearchParams({ cycle: cycleId, boss: bossId, ladder: state.ladders[key], limit: String(BOARD_ROWS) });
    if (state.rows === "teams") ask.set("rows", "teams");       // the top rows are team rows
    if (state.players) ask.set("players", state.players);
    if (state.server) ask.set("server", state.server);
    if (state.unlinked) ask.set("unlinked", "1");
    const response = await apiFetch(`/leaderboard/interlink?${ask}`);
    const boss = response.ok ? (await response.json()).bosses?.[0] : null;
    const old = els.interlink.querySelector(`[data-week="${CSS.escape(cycleId)}"][data-board-id="${CSS.escape(bossId)}"]`);
    if (!boss || !old) return;
    const menuFocused = old.querySelector(".lb-ladder select") === document.activeElement;
    const fresh = bossBoard(boss, cycleId);
    old.replaceWith(fresh);
    if (menuFocused) fresh.querySelector(".lb-ladder select")?.focus();      // the Ladder menu just used keeps the focus
    showRowsPick();
  }
  function showSlot() {
    for (const node of els.interlink.querySelectorAll(".lb-boss")) {
      node.dataset.shown = String(!SLOT_CLASSES.some((name) => node.classList.contains(name)) || node.classList.contains(SLOT_CLASSES[state.slot]));
    }
    for (const button of els.interlink.querySelectorAll("[data-slot-index]")) {
      button.setAttribute("aria-selected", String(Number(button.dataset.slotIndex) === state.slot));
    }
    showRowsPick();
  }
  // the phone width (leaderboard.css: one boss at a time from 900px down): which boards are on screen changes
  window.matchMedia?.("(max-width: 900px)").addEventListener?.("change", () => showRowsPick());
  function weekNav(data) {
    const now = Date.now() / 1000;
    const weeks = data.weeks.filter((week) => week.start <= now || week.id === data.cycle.id);   // in time order
    const at = weeks.findIndex((week) => week.id === data.cycle.id);
    const go = (week) => { state.push = true; state.week = week.id; state.ladders = {}; state.viewBoss = ""; state.offset = 0; void loadEntries(); };
    const when = weekAgo(data.cycle);
    return el("div", { class: "lb-week-nav" },
      el("button", { type: "button", "aria-label": "Previous week", text: "‹", disabled: at <= 0, onclick: () => go(weeks[at - 1]) }),
      el("span", {}, weekRange(data.cycle), el("small", { text: ` · ${when === "this week" ? "current" : when}` })),
      el("button", { type: "button", "aria-label": "Next week", text: "›", disabled: at < 0 || at >= weeks.length - 1, onclick: () => go(weeks[at + 1]) }));
  }
  // A week's heading over its boards when two weeks show: this (or the coming) week, then last week.
  function weekHead(data, dates = true) {
    const now = Date.now() / 1000;
    const label = data.cycle.start > now ? `Next week · starts ${shortDate(data.cycle.start)}` : data.cycle.end >= now ? "This week" : "Last week";
    return el("div", { class: "lb-week-head" }, el("h3", { text: label }), dates ? el("span", { text: weekRange(data.cycle) }) : null,
      data.cycle.start <= now ? updatedLine(data.updatedAt) : null);
  }
  // the marks on the boards' rows, said once beside the week menu
  function marksLegend() {
    return el("p", { class: "lb-marks-legend" }, el("span", {}, claimedBadge(), " claimed player"),
      el("span", {}, seatMark(null, true), " a bot"),
      el("span", {}, el("span", { class: "lb-legend-also", text: "Name (1st)" }), " ranked with another run"),
      el("span", {}, checkBadge("verified"), " verified run"));
  }
  function renderPerBoss(data, last = null) {
    const caps = data.rules?.starCaps || [];
    const clear = data.rules?.clearStars || [];
    const slotted = data.bosses.filter((boss) => boss.slotIndex != null);
    const rules = rulesLine(caps, clear, data.rules?.slots || [], slotted);
    els.interlink.replaceChildren(
      el("div", { class: "lb-subbar" }, weekNav(data), marksLegend(), last ? null : updatedLine(data.updatedAt)),
      el("p", { class: "lb-rules" },
        ...rules.filter((part) => !part.pair).map((part) => (part.label
          ? el("span", {}, el("b", { text: part.label }), part.text) : el("span", { text: part.text }))),
        el("span", { text: "Best run per player per boss" }),
        el("span", { text: "Ranked by score; pick another ladder in each board's menu" }),
        // a two-boss fight's sentence, on a line of its own
        ...rules.filter((part) => part.pair).map((part) => el("span", { class: "lb-pair-note", text: part.text }))),
      el("div", { class: "lb-slot-switch", role: "tablist", "aria-label": "Boss" }, ...slotted.map((boss) => el("button", {
        type: "button", role: "tab", "data-slot-index": boss.slotIndex, "aria-selected": String(boss.slotIndex === state.slot),
        class: SLOT_CLASSES[boss.slotIndex], onclick: () => { state.slot = boss.slotIndex; showSlot(); },
      }, boss.slot, el("small", { text: bossTab(boss) })))),
      ...(last ? [weekHead(data, false)] : []),            // its dates are in the week menu just above
      el("div", { class: "lb-bosses" }, data.bosses.map((boss) => bossBoard(boss, data.cycle.id))),
      ...(last ? [weekHead(last), el("div", { class: "lb-bosses" }, last.bosses.map((boss) => bossBoard(boss, last.cycle.id)))] : []),
      el("p", { class: "lb-note", text: "Only what the result screens show: score, stars, clear time, team DPS and each player's Avg DPS, BREAK damage and healing." }),
      el("p", { class: "lb-note lb-check-legend" }, checkBadge("verified"), " confirmed by another player's copy of the run or by its pictures · ",
        checkBadge("pending"), " its check hasn't run yet · ", checkBadge("invalid"), " sent without proof pictures · no badge: not confirmed by either"));
    els.tableWrap.hidden = true;
    els.summary.textContent = "";
    showRowsPick();
  }

  // "View all": one board, every player, paged, with every figure; a figure's column header ranks the board by it
  // (the API's ?ladder=, clicked again ?order= the other way round). Who sent it and when only show. The columns come
  // in two groups: each player's own figures (Avg DPS, BREAK, healing) beside their name, then the run's shared figures
  // (score, stars, time, team DPS, when it was sent) after a soft divider. Both views use this order, so the columns
  // don't move when Teams / Players is switched.
  const FULL_COLUMNS = [
    { id: "dps", label: "Avg DPS", value: (e) => number(e.avgDps) },
    { id: "break", label: "BREAK", value: (e) => number(e.breakValue) },
    { id: "heal", label: "Healing", value: (e) => number(e.heal) },
    { id: "score", label: "Score", shared: "start", value: (e) => number(e.score) },
    { id: "stars", label: "Stars", shared: true, value: (e) => stars(e.stars) },
    { id: "clear", label: "Time", shared: true, value: (e, boss) => clearText(e, boss) },
    { id: "teamDps", label: "Team DPS", shared: true, value: (e) => number(e.teamDps) },
    { id: "date", label: "Submitted", shared: true, value: (e) => playerUpdated(e.updatedAt, "") || "—" },     // when this best reached the site
  ];
  function renderFull(data) {
    const boss = data.bosses[0];
    const ladder = ladderOf(state.viewLadder);
    const back = () => {
      if (state.returnWeek !== undefined) { state.week = state.returnWeek; delete state.returnWeek; }
      state.push = true;
      state.viewBoss = ""; state.offset = 0; void loadEntries();
    };
    if (!boss) { back(); return; }
    // the columns stay in place; the ranked one is highlighted, and on phones the figures it isn't ranked by beyond
    // score, stars and time fold away
    const columns = FULL_COLUMNS;
    const natural = ladder.id === "clear" ? "asc" : "desc";
    // sorted by Submitted: the rows by when they reached the site (the API's order=submitted / submitted_asc), each
    // keeping its place on the ladder (the # column)
    const submitted = state.viewOrder.startsWith("submitted");
    const order = submitted ? natural : state.viewOrder || natural;
    // what a column header does (and the phone's Sort by): a ladder ranks by it, again the other way round; Submitted
    // lists newest first, again oldest first
    const sortBy = (id, flip = true) => {
      if (id === "date") state.viewOrder = flip && state.viewOrder === "submitted" ? "submitted_asc" : "submitted";
      else if (flip && id === ladder.id && !submitted) state.viewOrder = order === "asc" ? "desc" : "asc";
      else { state.viewLadder = id; state.viewOrder = ""; }
      if (state.viewOrder === (state.viewLadder === "clear" ? "asc" : "desc")) state.viewOrder = "";
      state.offset = 0;
      void loadEntries();
    };
    const ranked = (column) => [column.id === ladder.id ? "is-ranked" : "", fold(column, ladder), column.shared === "start" ? "lb-shared-start" : "", column.shared ? "" : "lb-own-fig"]
      .join(" ").trim() || null;
    els.interlink.replaceChildren(
      el("div", { class: "lb-subbar" },
        el("div", { class: "lb-crumbs" }, el("button", { type: "button", class: "lb-back", text: "← Per Boss", onclick: back }),
          el("span", { text: `${boss.slot ? `${boss.slot} ${boss.second ? "bosses" : "boss"}` : bossName(boss)} · ${weekRange(data.cycle)}` })),
        updatedLine(data.updatedAt)),
      bossHead(boss, `lb-full-head ${SLOT_CLASSES[boss.slotIndex] || ""}`));
    state.fullTeams = hasTeams(boss, ladder) && Boolean(boss.total);       // the page's Show switch applies
    showRowsPick();
    const teams = teamView(boss, ladder);
    els.head.replaceChildren(el("tr", {}, el("th", { scope: "col", text: "#" }), el("th", { scope: "col", text: "Player" }),
      columns.map((column) => headCell(column.label, {
        sortable: column.id === "date" || LADDERS.some((item) => item.id === column.id),
        active: column.id === "date" ? submitted : column.id === ladder.id && !submitted,
        order: column.id === "date" ? (state.viewOrder === "submitted_asc" ? "asc" : "desc") : order, className: ranked(column),
        onSort: () => sortBy(column.id),
      }))));
    const playerRow = (entry) => el("tr", { class: entry.own ? "is-own" : null },
      el("td", { class: "lb-rank", text: String(entry.rank) }),
      el("td", { class: "lb-player" }, playerName(entry, rowCheck(entry, ladder))),
      columns.map((column) => el("td", { class: ranked(column) },
        column.id === "clear" ? el("span", { class: "lb-result" }, ...resultLine(entry, ladder, boss)) : column.value(entry, boss))));
    // Teams: one block of rows per team row, one row per seat (teamSeats: its players, the players ranked with another
    // run as "Name (1st)", its bots), each with its mark and that player's own Avg DPS, BREAK and healing ("—" for a bot:
    // the API sends no bot figures; an also-player's are this run's, when the API passes them). The place and the run's
    // shared figures are one cell each for the block (rowspan), after the divider, so the faint lines between its
    // players stop at the divider and a stronger line closes the block. Hover and the own-team colour light the block.
    const teamRows = (members) => {
      const lead = members[0];
      const items = teamSeats(members);
      const span = items.length > 1 ? String(items.length) : null;
      const shared = { ...lead, updatedAt: teamUpdated(members) };
      const own = members.some((entry) => entry.own);
      const proofs = copyProofs(members, ladder);
      const block = [];
      const hover = (on) => () => { for (const row of block) row.classList.toggle("is-hover", on); };
      items.forEach((item, index) => {
        const row = el("tr", { class: ["lb-team-row", index ? "" : "lb-team-first", index === items.length - 1 ? "lb-team-last" : "", own ? "is-own" : ""]
          .filter(Boolean).join(" "), onmouseenter: hover(true), onmouseleave: hover(false) },
        index ? null : el("td", { class: "lb-rank", rowspan: span, text: String(lead.rank) }),
        el("td", { class: "lb-player" }, seatLine(item, item.kind === "player" ? [memberProof(item.entry, proofs, ladder)] : [])),
        columns.map((column) => {
          if (!column.shared) return el("td", { class: ranked(column) }, item.kind === "bot" ? "—" : column.value(item.entry, boss));
          if (index) return null;
          return el("td", { class: ranked(column), rowspan: span },
            column.id === "clear" ? el("span", { class: "lb-result" }, ...teamResult(lead, ladder, boss)) : column.value(shared, boss));
        }));
        block.push(row);
      });
      return block;
    };
    const shown = teams ? teamsOf(boss.entries) : boss.entries;
    els.rows.replaceChildren(...(shown.length ? shown.flatMap((item) => (teams ? teamRows(item) : [playerRow(item)]))
      : [el("tr", {}, el("td", { colspan: String(columns.length + 2), class: "lb-empty", text: "No runs on this ladder yet." }))]));
    showStack(fullStack({ boss, ladder, teams, shown, submitted, order, sortBy }));
    els.tableWrap.hidden = false;
    // Teams pages by team rows
    const count = teams ? boss.teams : boss.total;
    const first = count ? state.offset + 1 : 0;
    const last = state.offset + shown.length;
    els.page.textContent = count ? `${first}–${last} of ${number(count)}` : "";
    for (const node of [els.prev, els.next, els.page]) node.hidden = count <= FULL_ROWS;
    els.prev.disabled = state.offset <= 0;
    els.next.disabled = last >= count;
    const players = `${number(boss.total)} player${boss.total === 1 ? "" : "s"}`;
    els.summary.textContent = `${bossName(boss)} · ranked by ${ladder.label.toLowerCase()}${order === natural ? "" : " (reversed)"}${
      submitted ? ` · ${state.viewOrder === "submitted" ? "newest" : "oldest"} submitted first` : ""} · ${
      teams ? `${number(boss.teams)} team${boss.teams === 1 ? "" : "s"} · ${players}` : players}`;
  }
  // View all on a phone (900px and under, where the regrouped table no longer fits): a block per team (or per player
  // in the Players view), no sideways scrolling. Left: the place, then one line per seat (mark, name, claimed check)
  // with that player's Avg DPS, BREAK and healing in three narrow columns, named once above the first block. Right,
  // after the same column line: the run's score and stars on one line, its team DPS, how it ended, when it was submitted,
  // then its icons (the Solo / Duo / Trio tag first, so the outcome never wraps). The visitor's own name takes the
  // "you" pill's colour (no room for the pill). A Sort by menu and a direction button do what the headers do.
  const SORT_CHOICES = [["score", "Score"], ["stars", "Stars"], ["clear", "Time"], ["teamDps", "Team DPS"], ["date", "Submitted"],
    ["dps", "Avg DPS"], ["break", "BREAK"], ["heal", "Healing"]];
  function fullStack({ boss, ladder, teams, shown, submitted, order, sortBy }) {
    const figure = (id, entry) => el("span", { class: "lb-stack-num" }, entry ? FULL_COLUMNS.find((column) => column.id === id).value(entry, boss) : "—");
    const line = (name, entry) => el("div", { class: "lb-stack-line" }, name, ...["dps", "break", "heal"].map((id) => figure(id, entry)));
    const run = (lead, updatedAt) => {
      const [tag, text, proof, link] = resultLine(lead, ladder, boss);
      return el("div", { class: "lb-stack-run" },
        el("span", { class: "lb-stack-score" }, el("b", { text: number(lead.score) }), stars(lead.stars)),
        el("span", { class: "lb-stack-teamdps" }, el("small", { text: "Team DPS " }), number(lead.teamDps)),
        el("span", { class: "lb-stack-outcome", text }),
        el("span", { class: "lb-stack-when" }, playerUpdated(updatedAt, "") || "—"),
        el("span", { class: "lb-stack-icons" }, tag, checkBadge(rowCheck(lead, ladder)), proof, link));
    };
    const block = (rank, own, lines, lead, updatedAt) => el("li", { class: own ? "lb-stack-team is-own" : "lb-stack-team", "data-place": String(rank) },
      el("span", { class: "lb-stack-rank", text: String(rank) }), el("div", { class: "lb-stack-players" }, lines), run(lead, updatedAt));
    const blocks = shown.map((item) => {
      if (!teams) return block(item.rank, item.own, [line(nameLine(item), item)], item, item.updatedAt);
      // a line is only the mark, the name and its check here: a teammate's own copy's pictures are in the table's view
      return block(item[0].rank, item.some((entry) => entry.own), teamSeats(item).map((seat) => line(seatLine(seat), seat.kind === "bot" ? null : seat.entry)),
      item[0], teamUpdated(item));
    });
    const current = submitted ? "date" : ladder.id;
    const ascending = submitted ? state.viewOrder === "submitted_asc" : order === "asc";
    const now = current === "date" ? (ascending ? "oldest first" : "newest first") : ascending ? "lowest first" : "highest first";
    const pick = el("select", { "aria-label": "Sort by", onchange: (event) => sortBy(event.target.value, false) },
      ...SORT_CHOICES.map(([id, label]) => el("option", { value: id, text: label })));
    pick.value = current;
    return el("div", { class: "lb-stack" },
      el("div", { class: "lb-stack-sort" }, el("label", {}, el("span", { text: "Sort by" }), pick),
        el("button", { type: "button", class: "lb-stack-dir", title: `Now ${now}; press to reverse`, "aria-label": `Reverse the order (now ${now})`,
          text: ascending ? "▲" : "▼", onclick: () => sortBy(current) })),
      blocks.length ? el("div", { class: "lb-stack-head", "aria-hidden": "true" }, el("span", { text: "#" }),
        el("div", { class: "lb-stack-line" }, el("span", { text: teams ? "Team" : "Player" }), el("span", { text: "Avg DPS" }), el("span", { text: "Break" }), el("span", { text: "Heal" })),
        el("span", { class: "lb-stack-runhead", text: "Run" })) : null,
      blocks.length ? el("ol", { class: "lb-stack-list" }, blocks) : el("p", { class: "lb-empty", text: "No runs on this ladder yet." }));
  }
  const ONE_PLAYER_COLUMNS = ["dps", "break", "heal"];     // a player's own figures: one cell each in a team's rows
  function fold(column, ladder) {
    return column.id !== ladder.id && !["score", "stars", "clear", "date"].includes(column.id) ? "lb-hide-sm" : "";
  }

  // Season Ladder: each player's best on each boss of each week, added up over a split (stars reset each split) or a season.
  function splitOf(seasons, cycle) {
    const season = seasons.find((item) => item.season === cycle.season);
    return season?.splits.find((split) => split.start <= cycle.start && cycle.start <= split.end)?.id ?? null;
  }
  // The Season Ladder's columns and how a header click sorts them. The whole list comes in one answer, so it's sorted
  // here; the API ranks it (the # column) by combined score, or by total stars when that's the sort (?sort=stars).
  const SEASON_SORTS = Object.freeze({
    player: { label: "Player", natural: "asc", value: (e) => e.discordName || e.player || "" },
    score: { label: "Combined score", natural: "desc", value: (e) => Number(e.total) || 0 },
    stars: { label: "Total stars", natural: "desc", value: (e) => Number(e.stars) || 0 },
    weeks: { label: "Weeks", natural: "desc", value: (e) => Number(e.weeks) || 0, small: true },
    bestWeek: { label: "Best week", natural: "desc", value: (e) => Number(e.bestWeek) || 0, small: true },
  });
  function seasonOrder() {
    return state.rankOrder || SEASON_SORTS[state.rank].natural;
  }
  function renderSeason(data) {
    showStack();
    state.seasonData = data;
    const pick = el("select", { "aria-label": "Season or split", onchange: (event) => {
      [state.season, state.split] = event.target.value.split("|");
      void loadEntries();
    } }, ...[...data.seasons].sort((a, b) => b.end - a.end).flatMap((season) => [
      ...[...season.splits].reverse().map((split) => el("option", { value: `${season.season}|${split.id}`,
        text: `${season.label || `Season ${season.season}`} · ${split.label} (${shortDate(split.start)} – ${shortDate(split.end)})` })),
      el("option", { value: `${season.season}|all`, text: `${season.label || `Season ${season.season}`} · whole season` }),
    ]));
    pick.value = `${data.season}|${data.split ?? "all"}`;
    const now = Date.now() / 1000;
    const played = data.weeks.filter((week) => week.start <= now).length;
    els.interlink.replaceChildren(
      el("div", { class: "lb-subbar" }, el("label", { class: "lb-split" }, el("span", { text: "Split" }), pick), updatedLine(data.updatedAt)),
      el("p", { class: "lb-rules" }, el("span", { text: "Each week: your best run on the left, center and right boss, added together; then every week added up." }),
        el("span", { text: "Stars reset when a split starts, so the current split shows first." })));
    const most = Math.max(1, ...data.standings.map((entry) => Number(entry.stars) || 0));
    const order = seasonOrder();
    const cellClass = (key) => [state.rank === key ? "is-ranked" : "", SEASON_SORTS[key].small && state.rank !== key ? "lb-hide-sm" : ""]
      .join(" ").trim() || null;
    els.head.replaceChildren(el("tr", {}, el("th", { scope: "col", text: "#" }), Object.entries(SEASON_SORTS).map(([key, column]) => headCell(column.label, {
      sortable: true, active: state.rank === key, order, className: key === "player" ? null : cellClass(key),
      onSort: () => {
        const before = state.rank === "stars";
        if (state.rank === key) state.rankOrder = order === "asc" ? "desc" : "asc";
        else { state.rank = key; state.rankOrder = ""; }
        if (state.rankOrder === SEASON_SORTS[state.rank].natural) state.rankOrder = "";
        // the # column follows stars or score, which the API ranks; any other sort is only a new order of this list
        if ((state.rank === "stars") !== before || !state.seasonData) void loadEntries();
        else { writeUrl(); renderSeason(state.seasonData); }
      },
    }))));
    const shown = window.AniilogsTableSort.sortRows(data.standings, SEASON_SORTS[state.rank].value, order);
    els.rows.replaceChildren(...(shown.length ? shown.map((entry) => {
      const bar = el("i");
      bar.style.width = `${Math.round((Number(entry.stars) || 0) / most * 100)}%`;
      return el("tr", { class: entry.own ? "is-own" : null },
        el("td", { class: "lb-rank", text: String(entry.rank) }),
        el("td", { class: state.rank === "player" ? "lb-player is-ranked" : "lb-player" }, playerName(entry), playerUpdated(entry.updatedAt),
          el("span", { class: "lb-bar", "aria-hidden": "true" }, bar)),
        el("td", { class: cellClass("score"), text: number(entry.total) }),
        el("td", { class: cellClass("stars") }, stars(entry.stars)),
        el("td", { class: cellClass("weeks"), text: `${number(entry.weeks)} / ${number(played)}` }),
        el("td", { class: cellClass("bestWeek"), text: number(entry.bestWeek) }));
    }) : [el("tr", {}, el("td", { colspan: "6", class: "lb-empty", text: "No scores in this split yet." }))]));
    els.tableWrap.hidden = false;
    els.summary.textContent = `${pick.selectedOptions[0]?.textContent || `Season ${data.season}`} · ${number(data.standings.length)} player${data.standings.length === 1 ? "" : "s"}`;
  }

  async function loadInterlink(requestId) {
    const ask = new URLSearchParams();
    if (state.server) ask.set("server", state.server);
    if (state.unlinked) ask.set("unlinked", "1");
    const get = async (params) => {
      const response = await apiFetch(`/leaderboard/interlink?${params}`);
      return response.ok ? response.json() : null;
    };
    if (board().custom === "season") {
      if (!state.season) {                                   // nothing picked: the current week's season and split
        const now = await get(new URLSearchParams([...ask, ["limit", "1"]]));
        if (requestId !== state.requestId) return;
        if (!now) { failed(); return; }
        state.season = String(now.cycle.season ?? "");
        state.split = String(splitOf(now.seasons || [], now.cycle) ?? "all");
      }
      ask.set("season", state.season);
      ask.set("split", state.split || "all");
      if (state.rank === "stars") ask.set("sort", "stars");
      const data = await get(ask);
      if (requestId !== state.requestId) return;
      if (!data) { failed(); return; }
      writeUrl();
      renderSeason(data);
      return;
    }
    // the plain Per Boss page (no week picked): this week's boards - or the coming week's, between weeks - over last week's
    const twoWeeks = !state.viewBoss && !state.week;
    if (state.week) ask.set("cycle", state.week);
    if (state.viewBoss) {
      ask.set("boss", state.viewBoss);
      ask.set("ladder", state.viewLadder);
      if (state.viewOrder) ask.set("order", state.viewOrder);
      ask.set("limit", String(FULL_ROWS));
      ask.set("offset", String(state.offset));
    } else {
      state.ladders = {};
      ask.set("ladder", "score");
      ask.set("limit", String(BOARD_ROWS));
    }
    if (state.rows === "teams") ask.set("rows", "teams");       // limit and offset count team rows
    if (state.players) ask.set("players", state.players);       // the Party filter: rows hidden, places kept
    const data = await get(ask);
    if (requestId !== state.requestId) return;
    if (!data) { failed(); return; }
    if (!twoWeeks) {
      state.week = data.cycle.id;
      writeUrl();
      if (state.viewBoss) renderFull(data);
      else renderPerBoss(data);
      return;
    }
    const now = Date.now() / 1000;
    const ordered = [...data.weeks].sort((a, b) => a.start - b.start);
    const top = ordered.find((week) => week.start <= now && now <= week.end) || ordered.find((week) => week.start > now) || data.cycle;
    const prev = ordered[ordered.findIndex((week) => week.id === top.id) - 1] || null;
    const weekData = (id) => (id === data.cycle.id ? data : get(new URLSearchParams([...ask, ["cycle", id]])));
    const [topData, lastData] = await Promise.all([weekData(top.id), prev ? weekData(prev.id) : null]);
    if (requestId !== state.requestId) return;
    if (!topData) { failed(); return; }
    writeUrl();
    renderPerBoss(topData, lastData);
  }

  async function loadEntries() {
    const requestId = ++state.requestId;
    if (board().custom) {
      renderControls();
      els.summary.textContent = "Loading…";
      await loadInterlink(requestId);
      return;
    }
    writeUrl();
    renderHead();
    els.summary.textContent = "Loading…";
    const params = query();
    params.set("limit", String(PAGE_SIZE));
    const response = await apiFetch(`/leaderboard/entries?${params}`);
    if (requestId !== state.requestId) return;
    if (!response.ok) {
      els.summary.textContent = "The leaderboard could not be loaded.";
      els.rows.replaceChildren();
      return;
    }
    const result = await response.json();
    state.total = result.total;
    renderRows(result.entries);
    const first = result.total ? result.offset + 1 : 0;
    const last = result.offset + result.entries.length;
    const simBoard = state.kind === "sim_run" ? simBoardName() : "";
    // ranked by the board's own measure, or sorted by another column (a board can name a measure its own way: Egg
    // Heist matches call their score "Loot"); "(reversed)" when a header was clicked twice
    const sortName = (state.kind === "eggheist_match" && result.sort === "score" ? "Loot" : SORT_LABELS[result.sort]) || result.sort;
    const reversed = result.order && result.order !== (ASCENDING_SORTS.has(result.sort) ? "asc" : "desc") ? " (reversed)" : "";
    const sortedBy = result.sort === board().sorts[0] && !reversed
      ? (simBoard ? "fastest Victory first" : `ranked by ${sortName}`)
      : `${result.sort === board().sorts[0] ? "ranked" : "sorted"} by ${sortName}${reversed}`;
    els.summary.textContent = `${simBoard || board().label} · ${sortedBy} · ${result.bestPerPlayer ? "best per player" : "every run"} · ${number(result.total)} record${result.total === 1 ? "" : "s"}`;
    // when the newest run on this board reached AniiLogs, as on the Interlink boards (only once the API sends it)
    if ("updatedAt" in result && result.updatedAt) els.summary.append(` · ${updatedLine(result.updatedAt).textContent}`);
    els.page.textContent = result.total ? `${first}–${last} of ${number(result.total)}` : "";
    els.prev.disabled = state.offset <= 0;
    els.next.disabled = last >= result.total;
  }

  // ---------------------------------------------------------------- row actions
  async function showEvidence(entry, button) {
    button.disabled = true;
    try {
      const response = await apiFetch(`/leaderboard/submissions/${entry.submissionId}/evidence`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      button.replaceWith(el("img", { class: "lb-evidence", src: dataUrl, alt: "Result screenshot submitted with this record" }));
    } catch {
      button.disabled = false;
      button.textContent = "Screenshot unavailable";
    }
  }
  async function moderate(entry, status) {
    const response = await apiFetch(`/leaderboard/submissions/${entry.submissionId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }),
    });
    if (!response.ok) window.alert("Could not update this record.");
    void loadEntries();
  }

  // ---------------------------------------------------------------- events
  document.querySelectorAll("[data-mode-tab]").forEach((tab) => {
    tab.addEventListener("click", async () => {
      if (state.mode === tab.dataset.modeTab) return;
      state.push = true;
      state.mode = tab.dataset.modeTab;
      state.kind = BOARDS[state.mode][0].kind;
      state.sort = "";
      state.order = "";
      state.offset = 0;
      state.expanded.clear();
      renderControls();
      await loadFacets();
      void loadEntries();
    });
  });
  let searchTimer = 0;
  const onFilter = (target) => {
    if (target === els.filters.elements.trial) fillSimPickers();   // that trial's own difficulties
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.offset = 0;
      void loadEntries();
    }, target.type === "search" ? 300 : 0);
  };
  enhanceFilters();
  // typing in a picker's box only filters its list; the pick itself arrives as the select's "change"
  els.filters.addEventListener("input", (event) => { if (!event.target.classList.contains("aniimo-picker-input")) onFilter(event.target); });
  els.filters.addEventListener("change", (event) => { if (pickers.has(event.target)) onFilter(event.target); });
  els.filters.addEventListener("submit", (event) => event.preventDefault());
  els.serverSelect.addEventListener("change", () => { state.server = els.serverSelect.value; state.offset = 0; void loadEntries(); });
  els.unlinked.addEventListener("change", () => { state.unlinked = els.unlinked.checked; state.offset = 0; void loadEntries(); });
  els.partySelect.addEventListener("change", () => { state.players = els.partySelect.value; state.offset = 0; void loadEntries(); });
  for (const button of els.rowsPick.querySelectorAll("[data-rows-choice]")) button.addEventListener("click", () => setRows(button.dataset.rowsChoice));
  // a board opened with "View all" pages by FULL_ROWS, the record boards by PAGE_SIZE
  const pageSize = () => (board().custom ? FULL_ROWS : PAGE_SIZE);
  els.prev.addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - pageSize());
    void loadEntries();
  });
  els.next.addEventListener("click", () => {
    state.offset += pageSize();
    void loadEntries();
  });

  // Back/Forward: the board in the address, then the scroll position it was left at.
  window.addEventListener("popstate", async (event) => {
    if (els.board.hidden) return;
    const mode = state.mode;
    state.push = false;
    delete state.returnWeek;
    state.expanded.clear();
    readUrl();
    renderControls();
    if (state.mode !== mode) await loadFacets();
    renderControls();
    await loadEntries();
    const scroll = Number(event.state?.scroll);
    if (Number.isFinite(scroll)) window.requestAnimationFrame(() => window.scrollTo(0, scroll));
  });

  // ---------------------------------------------------------------- access gate
  function gate(title, detail, link) {
    els.gate.hidden = false;
    els.board.hidden = true;
    els.gateTitle.textContent = title;
    els.gateDetail.replaceChildren(detail, link ? el("a", { href: link.href, text: link.text }) : "");
  }
  // A link to one run: /leaderboard/?run=<submission id> (any copy of a team run), as a placement's short link sends
  // (with week, boss, ladder, rows and offset for the board behind it, and link: its code) and notifications do
  // (&tab=comments). The viewer opens on load, on the tab `tab` names (an unknown one is ignored); its link button
  // copies that place on `ladder` (Score when none). run, tab and link stay in the address while it's open (writeUrl)
  // and leave it, without a reload, when it closes. A run that isn't there shows "This run isn't available".
  function openRunFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const runId = params.get("run") || "";
    if (!/^[A-Za-z0-9_-]{8,40}$/u.test(runId)) return;
    const tab = ["comments"].includes(params.get("tab")) ? params.get("tab") : "";
    const ladder = ladderOf(params.get("ladder")).id;
    const code = /^[23456789abcdefghjkmnpqrstuvwxyz]{5}$/u.test(params.get("link") || "") ? params.get("link") : "";
    state.openRun = { run: runId, tab, link: code };
    void proofViewer.open(runId, null, null, { ...(tab ? { tab } : {}), link: { run: runId, ladder, code } });
    // closed (×, Esc, a click outside, or another page's code): seen as its open attribute going, which also works where
    // the close event is held back (a page in the background)
    const dialog = document.querySelector("dialog.lb-proof-dialog");
    if (!dialog) return;
    const watch = new MutationObserver(() => {
      if (dialog.open) return;
      watch.disconnect();
      state.openRun = null;
      const url = new URL(window.location.href);
      for (const key of ["run", "tab", "link"]) url.searchParams.delete(key);
      window.history.replaceState(window.history.state, "", url);
    });
    watch.observe(dialog, { attributes: true, attributeFilter: ["open"] });
  }
  async function start() {
    if (!API_URL) return gate("Leaderboards are unavailable.", "The AniiLogs API is not configured for this page.");
    // the top bar (site-chrome.js) finishes a returning Discord sign-in and shows the account first
    await window.AniilogsChrome?.ready;
    openRunFromUrl();
    let status;
    try {
      status = await (await apiFetch("/leaderboard/status")).json();
    } catch {
      return gate("Leaderboards are temporarily unavailable.", "The account service could not be reached. Try again shortly.");
    }
    state.status = status;
    proofViewer.allowDelete({ any: Boolean(status.canDeleteRuns), onDeleted: () => { void loadEntries(); } });   // owner, administrators
    if (!status.public) {
      if (!status.authenticated) return gate("Leaderboards are in developer preview.", "Sign in with a developer account to preview them. ", { href: els.login.href, text: "Sign in with Discord" });
      if (!status.canRead) return gate("Leaderboards are in developer preview.", "They will open to everyone once they are ready.");
      if (!developerModeOn()) return gate("Developer mode is off.", "Turn on Developer mode in Settings to preview leaderboards. ", { href: "/explorer/?settings=1", text: "Open settings" });
      els.badge.hidden = false;
    }
    els.gate.hidden = true;
    els.board.hidden = false;
    readUrl();
    renderControls();
    await loadFacets();
    renderControls();
    void loadEntries();
  }

  void start();
})();
