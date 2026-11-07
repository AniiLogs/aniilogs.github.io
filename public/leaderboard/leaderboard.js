// game-audit: unaudited Challenge Score from bossrush_grade_data, Interlink and Holo-Battle Sim rules
(() => {
  const siteConfig = window.ANIILOGS_CONFIG || {};
  const API_URL = String(siteConfig.apiUrl || siteConfig.shareApiUrl || "").replace(/\/+$/u, "");
  const AUTH_SESSION_STORAGE_KEY = "aniilogs:auth:session:v1";
  const PREFERENCES_KEY = "aniilogs:explorer:preferences:v1";
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
      { kind: "eggheist_match", label: "Matches", sorts: ["score", "difficulty", "cleared", "clear_time_s", "defeats", "player", "cycle", "played_at"], fields: ["cycle", "difficulty", "cleared"] },
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
      { label: "Updated", sort: "played_at", value: (e) => date(e.playedAt || e.submittedAt) },
    ],
    eggheist_match: [
      { label: "Loot", sort: "score", value: (e) => number(e.score) },
      { label: "Difficulty", sort: "difficulty", value: (e) => e.difficulty || "—" },
      { label: "Outcome", sort: "cleared", value: (e) => (e.cleared === true ? "Escaped" : e.cleared === false ? "Failed" : "—") },
      { label: "Time", sort: "clear_time_s", value: (e) => duration(e.clearTimeS) },
      { label: "Total Defeats", sort: "defeats", info: "defeats", value: (e) => number(e.defeats) },
      { label: "Season", sort: "cycle", value: (e) => e.cycle || "—" },
      { label: "Date", sort: "played_at", value: (e) => date(e.playedAt || e.submittedAt) },
    ],
    sim_run: [
      { label: "Battle time", sort: "clear_time_s", value: (e) => duration(e.clearTimeS) },
      { label: "Trial", value: (e) => e.trialName || e.trial || "—" },
      { label: "Difficulty", value: (e) => e.difficulty || "—" },
      { label: "Style", sort: "style", value: (e) => e.extra?.setup?.style || "—" },
      // each gizmo series with its count ("Energy 6 · Valor 2"); runs from before the setup was read: their buff count
      { label: "Gizmos", value: (e) => gizmoSeries(e.extra?.setup) || number(e.buffs?.length) },
      { label: "Party", sort: "party_size", value: (e) => number(e.partySize) },
      { label: "Date", sort: "played_at", value: (e) => date(e.playedAt || e.submittedAt) },
    ],
  });

  const $ = (selector) => document.querySelector(selector);
  const els = {
    gate: $("[data-gate]"), gateTitle: $("[data-gate-title]"), gateDetail: $("[data-gate-detail]"),
    board: $("[data-board]"), badge: $("[data-preview-badge]"), filters: $("[data-filters]"),
    boardTabs: $("[data-board-tabs]"), summary: $("[data-summary]"),
    head: $("[data-head]"), rows: $("[data-rows]"), prev: $("[data-prev]"), next: $("[data-next]"), page: $("[data-page]"),
    login: $("[data-login]"),
    serverPick: $("[data-server-pick]"), serverSelect: $("[data-server-select]"), unlinked: $("[data-unlinked]"),
    interlink: $("[data-interlink]"), tableWrap: $("[data-table-wrap]"),
  };
  const state = {
    mode: "interlink", kind: "interlink_boss", sort: "", order: "", offset: 0, server: "",
    // Interlink: the week shown, the board opened with "View all" and its ladder, each board's ladder, the boss a phone
    // shows (0 left, 1 center, 2 right), and the Season Ladder's season, split ("all": the whole season) and order
    week: "", viewBoss: "", viewLadder: "score", ladders: {}, slot: 1, season: "", split: "", rank: "score", rankOrder: "",
    status: null, facets: null, total: 0, expanded: new Set(), requestId: 0, push: false,
  };

  // ---------------------------------------------------------------- helpers
  function sessionToken() {
    try { return String(window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY) || ""); } catch { return ""; }
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
  function profileName(name, profileId, props = {}, uid = null) {
    const title = [uid ? `UID ${uid}` : "", profileId ? "Open their profile" : ""].filter(Boolean).join(" · ") || null;
    if (!profileId) return el("span", { ...props, title, text: name });
    return el("a", { ...props, href: `/?profile=${encodeURIComponent(profileId)}`, title, text: name });
  }
  // Marks after a name: a teammate's row nobody claimed yet, and a name that looks like a claimed one.
  function nameMarks(entry) {
    return [
      entry.unclaimed ? el("span", { class: "lb-mark", title: "From a teammate's run. Not claimed: no UID was recorded for this player with the run.", text: "unclaimed" }) : null,
      // shown with "Show unlinked": an app user whose character name was never read (no UID to show either)
      !entry.unclaimed && !entry.uid && state.unlinked && entry.player === "Pathfinder" ? el("span", { class: "lb-mark", title: "An aLogs user whose app hasn't read their character's name yet.", text: "no character" }) : null,
      entry.lookalike ? el("span", { class: "lb-mark lb-lookalike", title: "This name looks like a claimed player's name but isn't theirs. Only the UID tells players apart.", text: "≈" }) : null,
    ];
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
    state.viewOrder = state.viewBoss && ["asc", "desc"].includes(state.order) ? state.order : "";   // "View all": its ladder flipped
    state.season = params.get("season") || ""; state.split = params.get("split") || "";
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
    if (entry.status === "hidden") facts.push("hidden by a moderator");
    if (facts.length) parts.push(el("p", { class: "lb-facts", text: facts.join(" · ") }));
    const actions = [];
    if (entry.hasEvidence) {
      actions.push(el("button", { type: "button", class: "secondary-button", text: "View screenshot", onclick: (event) => showEvidence(entry, event.currentTarget) }));
    }
    if (state.status?.canModerate) {
      const hide = entry.status !== "hidden";
      actions.push(el("button", { type: "button", class: "secondary-button", text: hide ? "Hide" : "Unhide", onclick: () => moderate(entry, hide ? "hidden" : "visible") }));
    }
    if (entry.own) actions.push(el("button", { type: "button", class: "danger-button", text: "Delete my record", onclick: () => removeEntry(entry) }));
    if (actions.length) parts.push(el("div", { class: "lb-actions" }, actions));
    if (!parts.length) parts.push(el("p", { class: "lb-facts", text: "No further details were recorded for this entry." }));
    return el("tr", { class: "lb-detail" }, el("td", { colspan: span }, parts));
  }
  function renderRows(entries) {
    const columns = COLUMNS[state.kind];
    const span = columns.length + 2;
    const rows = [];
    for (const entry of entries) {
      const open = state.expanded.has(entry.submissionId);
      const cells = [
        el("td", { class: "lb-rank", text: String(entry.rank) }),
        el("td", { class: "lb-player" }, el("button", {
          type: "button", class: "lb-expand", "aria-expanded": String(open), text: entry.player || "—",
          title: entry.uid ? `UID ${entry.uid}` : null,
          onclick: () => {
            if (state.expanded.has(entry.submissionId)) state.expanded.delete(entry.submissionId);
            else state.expanded.add(entry.submissionId);
            renderRows(entries);
          },
        }), entry.own ? el("span", { class: "lb-you", text: "you" }) : null, ...nameMarks(entry),
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
    { id: "teamDps", label: "Team DPS", proof: "score", value: (e) => number(e.teamDps) },
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
  // How a two-boss fight's stars add up is only known from a live run (the API says when: rules.twoBossStarsConfirmed);
  // until then its max stars and a kill's stars are marked unconfirmed.
  function markPairs(data) {
    for (const boss of data?.bosses || []) boss.unconfirmed = Boolean(boss.second) && data.rules?.twoBossStarsConfirmed !== true;
    return data;
  }
  const UNCONFIRMED = "Two bosses in one run: how their stars add up isn't confirmed yet";
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
  // How a board row's run ended, with its proof pictures beside it
  function resultLine(entry, ladder, boss = null) {
    return [clearText(entry, boss), proofButton(entry.proofIds?.[ladder.proof] || entry.proofId, rowCheck(entry, ladder), entry.menuProofId)];
  }
  // A board row's badge: its run's check, or "invalid" when the row has no proof pictures at all
  function rowCheck(entry, ladder) {
    return Object.keys(entry.proofIds || {}).length ? entry.checks?.[ladder.proof] || entry.checks?.score : "invalid";
  }
  function playerName(entry, proofId, check = null) {
    return el("span", { class: "lb-who-name" }, profileName(entry.player, entry.profileId, {}, entry.uid),
      entry.own ? el("span", { class: "lb-you", text: "you" }) : null, ...nameMarks(entry), checkBadge(check), proofButton(proofId, check));
  }
  function bossHead(boss, className, detail = "") {
    return el("div", { class: className },
      el("div", {}, el("div", { class: "lb-slot", text: [boss.slot || "Boss", detail].filter(Boolean).join(" · ") }),
        el("h3", {}, bossName(boss), boss.level ? el("small", { text: ` · Lv ${boss.level}` }) : null)),
      boss.starCap ? el("div", { class: "lb-cap" }, el("span", { text: "Max stars" }), stars(boss.starCap),
        boss.unconfirmed ? el("small", { class: "lb-unconfirmed", title: UNCONFIRMED, text: "unconfirmed" }) : null) : null);
  }
  function failed() {
    els.summary.textContent = "The leaderboard could not be loaded.";
    els.interlink.replaceChildren();
    els.tableWrap.hidden = true;
  }

  // Per Boss: the week's three boards, each with its own ladder menu. A row: the player and how the run ended on the
  // left, the ladder's figure over the stars on the right.
  function bossBoard(boss, cycleId = state.week) {
    const ladder = ladderOf(state.ladders[`${cycleId}:${boss.id}`]);
    const select = el("select", { "aria-label": `Rank the ${boss.slot || boss.name} board by`,
      onchange: (event) => { void loadBoard(boss.id, event.target.value, cycleId); } },
    ...LADDERS.map((item) => el("option", { value: item.id, text: item.label })));
    select.value = ladder.id;
    const rows = boss.entries.map((entry) => el("li", { class: entry.own ? "lb-row is-own" : "lb-row" },
      el("span", { class: "lb-rk", text: String(entry.rank) }),
      el("span", { class: "lb-who" }, playerName(entry, null, rowCheck(entry, ladder)), el("small", { class: "lb-result" }, ...resultLine(entry, ladder, boss))),
      el("span", { class: "lb-figs" }, el("span", { class: "lb-val", text: ladder.value(entry, boss) }), stars(entry.stars))));
    return el("article", { class: `lb-boss ${SLOT_CLASSES[boss.slotIndex] || ""}`, "data-board-id": boss.id, "data-week": cycleId,
      "data-shown": String(boss.slotIndex == null || boss.slotIndex === state.slot) },
    bossHead(boss, "lb-boss-head"),
    el("label", { class: "lb-ladder" }, el("span", { text: "Ladder" }), select),
    rows.length ? el("ol", { class: "lb-rows" }, rows)
      : el("p", { class: "lb-empty", text: ladder.id === "score" ? "No runs on this boss yet." : `No ${ladder.label.replace(/ \(one player\)$/u, "").toLowerCase()} on this boss yet.` }),
    boss.total ? el("button", { type: "button", class: "lb-more", text: `View all ${number(boss.total)} →`,
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
    if (state.server) ask.set("server", state.server);
    if (state.unlinked) ask.set("unlinked", "1");
    const response = await apiFetch(`/leaderboard/interlink?${ask}`);
    const boss = response.ok ? markPairs(await response.json()).bosses?.[0] : null;
    const old = els.interlink.querySelector(`[data-week="${CSS.escape(cycleId)}"][data-board-id="${CSS.escape(bossId)}"]`);
    if (boss && old) old.replaceWith(bossBoard(boss, cycleId));
  }
  function showSlot() {
    for (const node of els.interlink.querySelectorAll(".lb-boss")) {
      node.dataset.shown = String(!SLOT_CLASSES.some((name) => node.classList.contains(name)) || node.classList.contains(SLOT_CLASSES[state.slot]));
    }
    for (const button of els.interlink.querySelectorAll("[data-slot-index]")) {
      button.setAttribute("aria-selected", String(Number(button.dataset.slotIndex) === state.slot));
    }
  }
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
  function renderPerBoss(data, last = null) {
    const caps = data.rules?.starCaps || [];
    const clear = data.rules?.clearStars || [];
    const slotted = data.bosses.filter((boss) => boss.slotIndex != null);
    // a two-boss fight's slot: its max stars and kill stars aren't confirmed yet
    const pairs = slotted.filter((boss) => boss.unconfirmed);
    const mark = (values) => values.map((value, slot) => (pairs.some((boss) => boss.slotIndex === slot) ? `${value} (unconfirmed)` : value)).join(" / ");
    els.interlink.replaceChildren(
      el("div", { class: "lb-subbar" }, weekNav(data), last ? null : updatedLine(data.updatedAt)),
      el("p", { class: "lb-rules" },
        caps.length ? el("span", {}, el("b", { text: "Max stars " }), mark(caps)) : null,
        clear.length ? el("span", { text: `A kill is ${new Set(clear).size === 1 && !pairs.length ? clear[0] : mark(clear)} stars` }) : null,
        ...pairs.map((boss) => el("span", { class: "lb-unconfirmed-note",
          text: `${boss.slot || "This"} fight: ${boss.name}, then ${boss.second.name}, in one run. How its stars add up isn't confirmed yet.` })),
        el("span", { text: "Best run per player per boss" }),
        el("span", { text: "Ranked by score; pick another ladder in each board's menu" })),
      el("div", { class: "lb-slot-switch", role: "tablist", "aria-label": "Boss" }, ...slotted.map((boss) => el("button", {
        type: "button", role: "tab", "data-slot-index": boss.slotIndex, "aria-selected": String(boss.slotIndex === state.slot),
        class: SLOT_CLASSES[boss.slotIndex], onclick: () => { state.slot = boss.slotIndex; showSlot(); },
      }, boss.slot, el("small", { text: bossTab(boss) })))),
      ...(last ? [weekHead(data, false)] : []),            // its dates are in the week menu just above
      el("div", { class: "lb-bosses" }, data.bosses.map((boss) => bossBoard(boss, data.cycle.id))),
      ...(last ? [weekHead(last), el("div", { class: "lb-bosses" }, last.bosses.map((boss) => bossBoard(boss, last.cycle.id)))] : []),
      el("p", { class: "lb-note", text: "Only what the result screens show: score, stars, clear time, team DPS and each player's Avg DPS, BREAK damage and healing." }),
      el("p", { class: "lb-note lb-check-legend" }, checkBadge("verified"), " checked against the run's full screenshots · ",
        checkBadge("pending"), " waiting for that check · ", checkBadge("invalid"), " sent without proof pictures · no badge: not checked"));
    els.tableWrap.hidden = true;
    els.summary.textContent = "";
  }

  // "View all": one board, every player, paged, with every figure; a figure's column header ranks the board by it
  // (the API's ?ladder=, clicked again ?order= the other way round). Who sent it and when only show.
  const FULL_COLUMNS = [
    { id: "score", label: "Score", value: (e) => number(e.score) },
    { id: "stars", label: "Stars", value: (e) => stars(e.stars) },
    { id: "clear", label: "Time", value: (e, boss) => clearText(e, boss) },
    { id: "teamDps", label: "Team DPS", value: (e) => number(e.teamDps) },
    { id: "dps", label: "Avg DPS", value: (e) => number(e.avgDps) },
    { id: "break", label: "BREAK", value: (e) => number(e.breakValue) },
    { id: "heal", label: "Healing", value: (e) => number(e.heal) },
    { id: "date", label: "Submitted", value: (e) => playerUpdated(e.updatedAt, "") || "—" },     // when this best was sent
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
    const order = state.viewOrder || natural;
    const ranked = (column) => [column.id === ladder.id ? "is-ranked" : "", fold(column, ladder)].join(" ").trim() || null;
    els.interlink.replaceChildren(
      el("div", { class: "lb-subbar" },
        el("div", { class: "lb-crumbs" }, el("button", { type: "button", class: "lb-back", text: "← Per Boss", onclick: back }),
          el("span", { text: `${boss.slot ? `${boss.slot} boss` : boss.name} · ${weekRange(data.cycle)}` })),
        updatedLine(data.updatedAt)),
      bossHead(boss, `lb-full-head ${SLOT_CLASSES[boss.slotIndex] || ""}`));
    els.head.replaceChildren(el("tr", {}, el("th", { scope: "col", text: "#" }), el("th", { scope: "col", text: "Player" }),
      columns.map((column) => headCell(column.label, {
        sortable: LADDERS.some((item) => item.id === column.id), active: column.id === ladder.id, order, className: ranked(column),
        onSort: () => {
          if (column.id === ladder.id) state.viewOrder = order === "asc" ? "desc" : "asc";
          else { state.viewLadder = column.id; state.viewOrder = ""; }
          if (state.viewOrder === (state.viewLadder === "clear" ? "asc" : "desc")) state.viewOrder = "";
          state.offset = 0;
          void loadEntries();
        },
      }))));
    els.rows.replaceChildren(...(boss.entries.length ? boss.entries.map((entry) => el("tr", { class: entry.own ? "is-own" : null },
      el("td", { class: "lb-rank", text: String(entry.rank) }),
      el("td", { class: "lb-player" }, playerName(entry, null, rowCheck(entry, ladder))),
      columns.map((column) => el("td", { class: ranked(column) },
        column.id === "clear" ? el("span", { class: "lb-result" }, ...resultLine(entry, ladder, boss)) : column.value(entry, boss)))))
      : [el("tr", {}, el("td", { colspan: String(columns.length + 2), class: "lb-empty", text: "No runs on this ladder yet." }))]));
    els.tableWrap.hidden = false;
    const first = boss.total ? state.offset + 1 : 0;
    const last = state.offset + boss.entries.length;
    els.page.textContent = boss.total ? `${first}–${last} of ${number(boss.total)}` : "";
    for (const node of [els.prev, els.next, els.page]) node.hidden = boss.total <= FULL_ROWS;
    els.prev.disabled = state.offset <= 0;
    els.next.disabled = last >= boss.total;
    els.summary.textContent = `${bossName(boss)} · ranked by ${ladder.label.toLowerCase()}${order === natural ? "" : " (reversed)"} · ${number(boss.total)} player${boss.total === 1 ? "" : "s"}`;
  }
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
    player: { label: "Player", natural: "asc", value: (e) => e.player || "" },
    score: { label: "Combined score", natural: "desc", value: (e) => Number(e.total) || 0 },
    stars: { label: "Total stars", natural: "desc", value: (e) => Number(e.stars) || 0 },
    weeks: { label: "Weeks", natural: "desc", value: (e) => Number(e.weeks) || 0, small: true },
    bestWeek: { label: "Best week", natural: "desc", value: (e) => Number(e.bestWeek) || 0, small: true },
  });
  function seasonOrder() {
    return state.rankOrder || SEASON_SORTS[state.rank].natural;
  }
  function renderSeason(data) {
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
      return response.ok ? markPairs(await response.json()) : null;
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
  async function removeEntry(entry) {
    if (!window.confirm("Delete this record from the leaderboard?")) return;
    const response = await apiFetch(`/leaderboard/submissions/${entry.submissionId}`, { method: "DELETE" });
    if (!response.ok) window.alert("Could not delete this record.");
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
  async function start() {
    if (!API_URL) return gate("Leaderboards are unavailable.", "The AniiLogs API is not configured for this page.");
    // the top bar (site-chrome.js) finishes a returning Discord sign-in and shows the account first
    await window.AniilogsChrome?.ready;
    let status;
    try {
      status = await (await apiFetch("/leaderboard/status")).json();
    } catch {
      return gate("Leaderboards are temporarily unavailable.", "The account service could not be reached. Try again shortly.");
    }
    state.status = status;
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
