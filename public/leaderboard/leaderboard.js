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
      { kind: "sim_run", label: "Trials", sorts: ["clear_time_s"], fields: ["trial", "difficulty", "party", "buff"] },
    ],
    // From the desktop meter: the Rank Info screen (season standing) and each match's end screen (Matches)
    eggheist: [
      { kind: "eggheist_season", label: "Season standings", sorts: ["standing", "score", "stars"], fields: ["cycle"] },
      // each match, from the game's end screen; best loot per player unless "every run"
      { kind: "eggheist_match", label: "Matches", sorts: ["score", "difficulty", "clear_time_s", "defeats", "player", "played_at"], fields: ["cycle", "difficulty", "cleared"] },
      { kind: "eggheist_pvp", label: "PvP (coming soon)", soon: true },
    ],
  });
  const SORT_LABELS = Object.freeze({
    standing: "Rank", score: "Score", team_dps: "Team DPS", clear_time_s: "Fastest time", stars: "Stars", meter_dps: "Meter DPS", floors: "Floors",
    p_dps: "Avg DPS", p_break: "BREAK", p_taken: "Damage taken", p_heal: "Healing", defeats: "Total Defeats",
    difficulty: "Difficulty (hardest first)", player: "Player (A–Z)", played_at: "Date (newest first)",
  });
  // Table columns per board; `sort` makes the header clickable.
  const COLUMNS = Object.freeze({
    eggheist_season: [
      { label: "Rank", sort: "standing", value: (e) => e.seasonRank?.name || (e.seasonRank?.tier ? `Tier ${e.seasonRank.tier}` : "—") },
      // Egg Emperor is the top rank: its points are maxed out (it counts stars instead)
      { label: "Rank points", sort: "score", value: (e) => (e.seasonRank?.tier === 7 ? "MAX" : number(e.score)) },
      // Stars only exist at the top rank (Egg Emperor)
      { label: "Emperor stars", sort: "stars", value: (e) => (e.seasonRank?.tier === 7 || e.stars ? number(e.stars) : "—") },
      { label: "Season", value: (e) => e.cycle || "—" },
      { label: "Updated", value: (e) => date(e.playedAt || e.submittedAt) },
    ],
    eggheist_match: [
      { label: "Loot", sort: "score", value: (e) => number(e.score) },
      { label: "Difficulty", sort: "difficulty", value: (e) => e.difficulty || "—" },
      { label: "Outcome", value: (e) => (e.cleared === true ? "Escaped" : e.cleared === false ? "Failed" : "—") },
      { label: "Time", sort: "clear_time_s", value: (e) => duration(e.clearTimeS) },
      { label: "Total Defeats", sort: "defeats", info: "defeats", value: (e) => number(e.defeats) },
      { label: "Season", value: (e) => e.cycle || "—" },
      { label: "Date", sort: "played_at", value: (e) => date(e.playedAt || e.submittedAt) },
    ],
    sim_run: [
      { label: "Battle time", sort: "clear_time_s", value: (e) => duration(e.clearTimeS) },
      { label: "Trial", value: (e) => e.trialName || e.trial || "—" },
      { label: "Difficulty", value: (e) => e.difficulty || "—" },
      { label: "Buffs", value: (e) => number(e.buffs?.length) },
      { label: "Party", value: (e) => number(e.partySize) },
      { label: "Date", value: (e) => date(e.playedAt || e.submittedAt) },
    ],
  });

  const $ = (selector) => document.querySelector(selector);
  const els = {
    gate: $("[data-gate]"), gateTitle: $("[data-gate-title]"), gateDetail: $("[data-gate-detail]"),
    board: $("[data-board]"), badge: $("[data-preview-badge]"), filters: $("[data-filters]"),
    boardTabs: $("[data-board-tabs]"), sort: $("[data-filter-sort]"), summary: $("[data-summary]"),
    head: $("[data-head]"), rows: $("[data-rows]"), prev: $("[data-prev]"), next: $("[data-next]"), page: $("[data-page]"),
    login: $("[data-login]"),
    serverPick: $("[data-server-pick]"), serverSelect: $("[data-server-select]"),
    interlink: $("[data-interlink]"), tableWrap: $("[data-table-wrap]"),
  };
  const state = {
    mode: "interlink", kind: "interlink_boss", sort: "", order: "", offset: 0, server: "",
    // Interlink: the week shown, the board opened with "View all" and its ladder, each board's ladder, the boss a phone
    // shows (0 left, 1 center, 2 right), and the Season Ladder's season, split ("all": the whole season) and order
    week: "", viewBoss: "", viewLadder: "score", ladders: {}, slot: 1, season: "", split: "", rank: "score",
    status: null, facets: null, total: 0, expanded: new Set(), requestId: 0,
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
    state.season = params.get("season") || ""; state.split = params.get("split") || ""; state.rank = params.get("rank") === "stars" ? "stars" : "score";
    state.server = params.get("server") || "";
    for (const name of ["cycle", "boss", "level", "difficulty", "trial", "party", "buff", "player"]) {
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
    if (board().custom === "boss") {
      if (state.week) params.set("week", state.week);
      if (state.viewBoss) {
        params.set("boss", state.viewBoss);
        params.set("ladder", state.viewLadder);
        if (state.offset) params.set("offset", String(state.offset));
      }
      return params;
    }
    if (board().custom === "season") {
      if (state.season) params.set("season", state.season);
      if (state.split) params.set("split", state.split);
      if (state.rank === "stars") params.set("rank", "stars");
      return params;
    }
    if (state.sort) params.set("sort", state.sort);
    if (state.order) params.set("order", state.order);
    const fields = board().fields;
    for (const name of ["cycle", "boss", "level", "difficulty", "trial", "party", "buff"]) {
      let value = els.filters.elements[name]?.value;
      if (name === "trial") value = String(value || "").split("|").pop();   // "<stage>|<element>": the API takes the element
      if (value && fields.includes(name)) params.set(name, value);
    }
    const player = els.filters.elements.player.value.trim();
    if (player) params.set("player", player);
    if (fields.includes("cleared") && els.filters.elements.cleared.checked) params.set("cleared", "1");
    if (els.filters.elements.best.checked) params.set("best", "0");
    if (state.status?.canModerate && els.filters.elements.hidden.checked) params.set("hidden", "1");
    if (state.offset) params.set("offset", String(state.offset));
    return params;
  }
  function writeUrl() {
    const url = new URL(window.location.href);
    url.search = query().toString();
    window.history.replaceState(null, "", url);
  }

  // ---------------------------------------------------------------- filters
  function fillSelect(select, options, emptyLabel) {
    const pending = select.dataset.pending ?? select.value;
    select.replaceChildren(el("option", { value: "", text: emptyLabel }));
    for (const option of options) select.append(el("option", { value: option.value, text: option.label }));
    if ([...select.options].some((option) => option.value === pending)) select.value = pending;
    delete select.dataset.pending;
  }
  function renderControls() {
    $("[data-mode-note]").hidden = state.mode !== "eggheist";
    $("[data-cycle-label]").textContent = state.mode === "eggheist" ? "Season" : "Week";
    document.querySelectorAll("[data-mode-tab]").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.modeTab === state.mode));
    });
    const pickBoard = (kind) => {
      if (state.kind === kind) return;
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
    if (!sorts.includes(state.sort)) state.sort = sorts[0];
    // a board can name a measure its own way (Egg Heist matches call their score "Loot")
    els.sort.replaceChildren(...sorts.map((key) => el("option", { value: key, text: (state.kind === "eggheist_match" && key === "score" ? "Loot" : SORT_LABELS[key]) })));
    els.sort.value = state.sort;
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
    fillSimPickers();
  }
  // Holo-Battle Sim: one board per stage and difficulty. The Trial picker lists the game's stages from the API's rules,
  // grouped (Basic Training: Training of Grass / Water / Fire; Elemental Crucible: Crucible of …), each option's value
  // "<stage>|<element>"; Difficulty lists that stage's difficulties (the hardest one with runs, unless one was picked).
  function fillSimPickers() {
    const f = els.filters.elements;
    const rules = state.facets?.simRules;
    if (state.mode !== "sim" || !rules?.stages?.length) return;
    const pendingElement = f.trial.dataset.pending;
    const pendingLevel = f.difficulty.dataset.pending;
    const chosen = pendingElement
      ? `${(rules.stages.find((stage) => stage.difficulties.includes(pendingLevel)) || rules.stages[0]).id}|${pendingElement}`
      : f.trial.value;
    f.trial.replaceChildren(...rules.stages.map((stage) => el("optgroup", { label: stage.label },
      rules.elements.map((element) => el("option", { value: `${stage.id}|${element}`,
        text: `${stage.name.replace("{element}", element)}${stage.alias ? ` (${stage.alias.replace("{element}", element)})` : ""}` })))));
    f.trial.value = [...f.trial.options].some((option) => option.value === chosen) ? chosen : f.trial.options[0].value;
    delete f.trial.dataset.pending;
    const [stageId, element] = f.trial.value.split("|");
    const levels = rules.stages.find((stage) => stage.id === stageId).difficulties;
    const withRuns = (state.facets.trials || []).filter((row) => row.trial === element && levels.includes(row.difficulty)).map((row) => row.difficulty);
    const level = pendingLevel ?? f.difficulty.value;
    f.difficulty.replaceChildren(...levels.map((name) => el("option", { value: name, text: name })));
    f.difficulty.value = levels.includes(level) ? level : [...levels].reverse().find((name) => withRuns.includes(name)) || levels.at(-1);
    delete f.difficulty.dataset.pending;
  }
  // the board's name for the summary: "Training of Water - Hard"
  function simBoardName() {
    const f = els.filters.elements;
    const [stageId, element] = String(f.trial.value || "").split("|");
    const stage = state.facets?.simRules?.stages?.find((item) => item.id === stageId);
    return stage && element ? `${stage.name.replace("{element}", element)}${f.difficulty.value ? ` - ${f.difficulty.value}` : ""}` : "";
  }

  // ---------------------------------------------------------------- table
  function renderHead() {
    const columns = COLUMNS[state.kind];
    const headers = [el("th", { scope: "col", text: "#" })];
    for (const column of [{ label: "Player", sort: "player", playerColumn: true }, ...columns]) {
      const info = column.info ? infoButton(column.info) : null;
      if (!column.sort || !board().sorts.includes(column.sort)) {
        headers.push(info ? el("th", { scope: "col" }, el("span", { class: "lb-th-info" }, el("span", { text: column.label }), info)) : el("th", { scope: "col", text: column.label }));
        continue;
      }
      const active = state.sort === column.sort;
      const arrow = active ? (currentOrder() === "asc" ? " ▲" : " ▼") : "";
      headers.push(el("th", { scope: "col", "aria-sort": active ? (currentOrder() === "asc" ? "ascending" : "descending") : null },
        el("button", {
          type: "button", class: active ? "lb-sort is-active" : "lb-sort", text: column.label + arrow,
          onclick: () => {
            if (state.sort === column.sort) state.order = currentOrder() === "asc" ? "desc" : "asc";
            else { state.sort = column.sort; state.order = ""; }
            state.offset = 0;
            renderControls();
            void loadEntries();
          },
        }), info));
    }
    els.head.replaceChildren(el("tr", {}, headers));
  }
  function currentOrder() {
    if (state.order) return state.order;
    return state.sort === "clear_time_s" || state.sort === "player" ? "asc" : "desc";
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
  // A picture icon next to a name when the run has its result screenshot, for anyone: hover it to see the screenshot
  // as large as the window allows, click (or tap) to keep it open.
  const proofImages = new Map();                       // submission id -> object URL, loaded once per page
  // shot: "summary" (the result screen) or "battle" (Battle Data)
  async function proofImage(submissionId, shot = "summary") {
    const key = `${submissionId}|${shot}`;
    if (!proofImages.has(key)) {
      proofImages.set(key, (async () => {
        const response = await apiFetch(`/leaderboard/submissions/${encodeURIComponent(submissionId)}/evidence${shot === "battle" ? "?shot=battle" : ""}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return URL.createObjectURL(await response.blob());
      })().catch((error) => { proofImages.delete(key); throw error; }));
    }
    return proofImages.get(key);
  }
  function proofButton(submissionId) {
    if (!submissionId) return null;
    const button = el("button", { type: "button", class: "lb-proof", title: "Hover to see this run's screenshot, click to keep it open",
      "aria-label": "View this run's screenshot", onclick: () => { hideProofPreview(); openProof(submissionId); } });
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v9.6l3.3-3.3a1 1 0 0 1 1.4 0l2.8 2.8 4.3-4.3a1 1 0 0 1 1.4 0L19 11.6V6H5Zm3.5 1.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/></svg>';
    // hover (mouse or pen only: a tap goes straight to the click)
    button.addEventListener("pointerenter", (event) => { if (event.pointerType !== "touch") showProofPreview(submissionId); });
    button.addEventListener("pointerleave", hideProofPreview);
    button.addEventListener("focus", () => showProofPreview(submissionId));
    button.addEventListener("blur", hideProofPreview);
    return button;
  }
  let previewFor = null;
  async function showProofPreview(submissionId) {
    previewFor = submissionId;
    let preview = document.querySelector(".lb-proof-preview");
    if (!preview) { preview = el("div", { class: "lb-proof-preview", "aria-hidden": "true" }); document.body.append(preview); }
    preview.replaceChildren(el("p", { class: "lb-empty", text: "Loading the screenshot…" }));
    preview.hidden = false;
    try {
      const url = await proofImage(submissionId);
      if (previewFor === submissionId) preview.replaceChildren(el("img", { src: url, alt: "" }));
    } catch {
      if (previewFor === submissionId) preview.replaceChildren(el("p", { class: "lb-empty", text: "This screenshot isn't available." }));
    }
  }
  function hideProofPreview() {
    previewFor = null;
    const preview = document.querySelector(".lb-proof-preview");
    if (preview) preview.hidden = true;
  }
  async function openProof(submissionId) {
    let dialog = document.querySelector("dialog.lb-proof-dialog");
    if (!dialog) {
      dialog = el("dialog", { class: "lb-proof-dialog" },
        el("form", { method: "dialog" }, el("button", { type: "submit", class: "lb-proof-close", "aria-label": "Close", text: "×" })),
        el("div", { class: "lb-proof-body" }));
      dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });   // click outside
      document.body.append(dialog);
    }
    const body = dialog.querySelector(".lb-proof-body");
    dialog.showModal();
    // the result screen, and the run's Battle Data when it was sent with it
    const show = async (shot) => {
      body.replaceChildren(el("p", { class: "lb-empty", text: "Loading the screenshot…" }));
      try {
        const url = await proofImage(submissionId, shot);
        body.replaceChildren(el("img", { class: "lb-proof-image", src: url, alt: shot === "battle" ? "The run's Battle Data" : "The run's result screen" }));
      } catch {
        body.replaceChildren(el("p", { class: "lb-empty", text: shot === "battle" ? "This run has no Battle Data screenshot." : "This screenshot isn't available." }));
      }
      for (const tab of dialog.querySelectorAll("[data-proof-shot]")) tab.setAttribute("aria-selected", String(tab.dataset.proofShot === shot));
    };
    let tabs = dialog.querySelector(".lb-proof-tabs");
    if (!tabs) {
      tabs = el("div", { class: "lb-proof-tabs", role: "tablist" },
        el("button", { type: "button", role: "tab", "data-proof-shot": "summary", text: "Summary" }),
        el("button", { type: "button", role: "tab", "data-proof-shot": "battle", text: "Battle Data" }));
      dialog.insertBefore(tabs, body);
    }
    for (const tab of tabs.querySelectorAll("[data-proof-shot]")) tab.onclick = () => show(tab.dataset.proofShot);
    await show("summary");
  }
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
    { id: "clear", label: "Fastest clear", short: "Time", proof: "clear", value: (e) => clearText(e) },
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
  // A run's time, kept short for phones: the clear time, or "No clear" (time ran out, or no kill recorded)
  function clearText(entry) {
    return entry.clearTimeS == null ? "No clear" : duration(entry.clearTimeS);
  }
  function shortDate(unix) {
    return new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function weekRange(week) {
    return `Week of ${shortDate(week.start)} – ${shortDate(week.end)}`;
  }
  // When the newest run on these boards reached AniiLogs
  function updatedLine(unix) {
    if (!unix) return el("p", { class: "lb-updated" }, el("i", { "aria-hidden": "true" }), "No runs sent yet");
    const minutes = Math.max(0, Math.round((Date.now() / 1000 - unix) / 60));
    const ago = minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago`
      : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`;
    const when = new Date(unix * 1000).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    return el("p", { class: "lb-updated", title: "When the newest run on these boards reached AniiLogs" },
      el("i", { "aria-hidden": "true" }), `Updated ${when} (${ago})`);
  }
  function playerName(entry, proofId) {
    return el("span", { class: "lb-who-name" }, profileName(entry.player, entry.profileId, {}, entry.uid),
      entry.own ? el("span", { class: "lb-you", text: "you" }) : null, ...nameMarks(entry), proofButton(proofId));
  }
  function bossHead(boss, className, detail = "") {
    return el("div", { class: className },
      el("div", {}, el("div", { class: "lb-slot", text: [boss.slot || "Boss", detail].filter(Boolean).join(" · ") }),
        el("h3", {}, boss.name, boss.level ? el("small", { text: ` · Lv ${boss.level}` }) : null)),
      boss.starCap ? el("div", { class: "lb-cap" }, el("span", { text: "Max stars" }), stars(boss.starCap)) : null);
  }
  function failed() {
    els.summary.textContent = "The leaderboard could not be loaded.";
    els.interlink.replaceChildren();
    els.tableWrap.hidden = true;
  }

  // Per Boss: the week's three boards, each with its own ladder menu.
  function bossBoard(boss) {
    const ladder = ladderOf(state.ladders[boss.id]);
    const select = el("select", { "aria-label": `Rank the ${boss.slot || boss.name} board by`,
      onchange: (event) => { void loadBoard(boss.id, event.target.value); } },
    ...LADDERS.map((item) => el("option", { value: item.id, text: item.label })));
    select.value = ladder.id;
    const rows = boss.entries.map((entry) => el("li", { class: entry.own ? "lb-row is-own" : "lb-row" },
      el("span", { class: "lb-rk", text: String(entry.rank) }),
      el("span", { class: "lb-who" }, playerName(entry, entry.proofIds?.[ladder.proof] || entry.proofId), el("small", { text: clearText(entry) })),
      el("span", { class: "lb-val", text: ladder.value(entry) }),
      stars(entry.stars)));
    return el("article", { class: `lb-boss ${SLOT_CLASSES[boss.slotIndex] || ""}`, "data-board-id": boss.id,
      "data-shown": String(boss.slotIndex == null || boss.slotIndex === state.slot) },
    bossHead(boss, "lb-boss-head"),
    el("label", { class: "lb-ladder" }, el("span", { text: "Ladder" }), select),
    rows.length ? el("ol", { class: "lb-rows" }, rows)
      : el("p", { class: "lb-empty", text: ladder.id === "score" ? "No runs on this boss yet." : `No ${ladder.label.replace(/ \(one player\)$/u, "").toLowerCase()} on this boss yet.` }),
    boss.total ? el("button", { type: "button", class: "lb-more", text: `View all ${number(boss.total)} →`,
      onclick: () => { state.viewBoss = boss.id; state.viewLadder = ladder.id; state.offset = 0; void loadEntries(); } }) : null);
  }
  // One board's ladder changed: reload just that board.
  async function loadBoard(bossId, ladderId) {
    state.ladders[bossId] = ladderOf(ladderId).id;
    const ask = new URLSearchParams({ cycle: state.week, boss: bossId, ladder: state.ladders[bossId], limit: String(BOARD_ROWS) });
    if (state.server) ask.set("server", state.server);
    const response = await apiFetch(`/leaderboard/interlink?${ask}`);
    const boss = response.ok ? (await response.json()).bosses?.[0] : null;
    const old = els.interlink.querySelector(`[data-board-id="${CSS.escape(bossId)}"]`);
    if (boss && old) old.replaceWith(bossBoard(boss));
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
    const go = (week) => { state.week = week.id; state.ladders = {}; state.viewBoss = ""; state.offset = 0; void loadEntries(); };
    const when = weekAgo(data.cycle);
    return el("div", { class: "lb-week-nav" },
      el("button", { type: "button", "aria-label": "Previous week", text: "‹", disabled: at <= 0, onclick: () => go(weeks[at - 1]) }),
      el("span", {}, weekRange(data.cycle), el("small", { text: ` · ${when === "this week" ? "current" : when}` })),
      el("button", { type: "button", "aria-label": "Next week", text: "›", disabled: at < 0 || at >= weeks.length - 1, onclick: () => go(weeks[at + 1]) }));
  }
  function renderPerBoss(data) {
    const caps = data.rules?.starCaps || [];
    const clear = [...new Set(data.rules?.clearStars || [])];
    const slotted = data.bosses.filter((boss) => boss.slotIndex != null);
    els.interlink.replaceChildren(
      el("div", { class: "lb-subbar" }, weekNav(data), updatedLine(data.updatedAt)),
      el("p", { class: "lb-rules" },
        caps.length ? el("span", {}, el("b", { text: "Max stars " }), caps.join(" / ")) : null,
        clear.length === 1 ? el("span", { text: `A kill is ${clear[0]} stars` }) : null,
        el("span", { text: "Best run per player per boss" }),
        el("span", { text: "Ranked by score; pick another ladder in each board's menu" })),
      el("div", { class: "lb-slot-switch", role: "tablist", "aria-label": "Boss" }, ...slotted.map((boss) => el("button", {
        type: "button", role: "tab", "data-slot-index": boss.slotIndex, "aria-selected": String(boss.slotIndex === state.slot),
        class: SLOT_CLASSES[boss.slotIndex], onclick: () => { state.slot = boss.slotIndex; showSlot(); },
      }, boss.slot, el("small", { text: boss.name.replace(/^(Alpha|Omega) /u, "") })))),
      el("div", { class: "lb-bosses" }, data.bosses.map(bossBoard)),
      el("p", { class: "lb-note", text: "Only what the result screens show: score, stars, clear time, team DPS and each player's Avg DPS, BREAK damage and healing." }));
    els.tableWrap.hidden = true;
    els.summary.textContent = "";
  }

  // "View all": one board, every player, paged, with every figure and a ladder chip row.
  const FULL_COLUMNS = [
    { id: "score", label: "Score", value: (e) => number(e.score) },
    { id: "stars", label: "Stars", value: (e) => stars(e.stars) },
    { id: "clear", label: "Time", value: (e) => clearText(e) },
    { id: "teamDps", label: "Team DPS", value: (e) => number(e.teamDps) },
    { id: "dps", label: "Avg DPS", value: (e) => number(e.avgDps) },
    { id: "break", label: "BREAK", value: (e) => number(e.breakValue) },
    { id: "heal", label: "Healing", value: (e) => number(e.heal) },
  ];
  function renderFull(data) {
    const boss = data.bosses[0];
    const ladder = ladderOf(state.viewLadder);
    const back = () => { state.viewBoss = ""; state.offset = 0; void loadEntries(); };
    if (!boss) { back(); return; }
    // the ladder's figure first; on phones the figures it isn't ranked by beyond score and stars fold away
    const columns = [...FULL_COLUMNS.filter((column) => column.id === ladder.id), ...FULL_COLUMNS.filter((column) => column.id !== ladder.id)];
    els.interlink.replaceChildren(
      el("div", { class: "lb-subbar" },
        el("div", { class: "lb-crumbs" }, el("button", { type: "button", class: "lb-back", text: "← Per Boss", onclick: back }),
          el("span", { text: `${boss.slot ? `${boss.slot} boss` : boss.name} · ${weekRange(data.cycle)}` })),
        updatedLine(data.updatedAt)),
      bossHead(boss, `lb-full-head ${SLOT_CLASSES[boss.slotIndex] || ""}`),
      el("div", { class: "lb-chips", role: "group", "aria-label": "Ladder" }, LADDERS.map((item) => el("button", {
        type: "button", "aria-pressed": String(item.id === ladder.id), text: item.short || item.label,
        onclick: () => { state.viewLadder = item.id; state.offset = 0; void loadEntries(); },
      }))));
    els.head.replaceChildren(el("tr", {}, el("th", { scope: "col", text: "#" }), el("th", { scope: "col", text: "Player" }),
      columns.map((column, index) => el("th", { scope: "col", class: [index ? "" : "is-ranked", fold(column, index)].join(" ").trim() || null, text: column.label }))));
    els.rows.replaceChildren(...(boss.entries.length ? boss.entries.map((entry) => el("tr", { class: entry.own ? "is-own" : null },
      el("td", { class: "lb-rank", text: String(entry.rank) }),
      el("td", { class: "lb-player" }, playerName(entry, entry.proofIds?.[ladder.proof] || entry.proofId)),
      columns.map((column, index) => el("td", { class: [index ? "" : "is-ranked", fold(column, index)].join(" ").trim() || null }, column.value(entry)))))
      : [el("tr", {}, el("td", { colspan: String(columns.length + 2), class: "lb-empty", text: "No runs on this ladder yet." }))]));
    els.tableWrap.hidden = false;
    const first = boss.total ? state.offset + 1 : 0;
    const last = state.offset + boss.entries.length;
    els.page.textContent = boss.total ? `${first}–${last} of ${number(boss.total)}` : "";
    for (const node of [els.prev, els.next, els.page]) node.hidden = boss.total <= FULL_ROWS;
    els.prev.disabled = state.offset <= 0;
    els.next.disabled = last >= boss.total;
    els.summary.textContent = `${boss.name} · ranked by ${ladder.label.toLowerCase()} · ${number(boss.total)} player${boss.total === 1 ? "" : "s"}`;
  }
  function fold(column, index) {
    return index && !["score", "stars", "clear"].includes(column.id) ? "lb-hide-sm" : "";
  }

  // Season Ladder: each player's best on each boss of each week, added up over a split (stars reset each split) or a season.
  function splitOf(seasons, cycle) {
    const season = seasons.find((item) => item.season === cycle.season);
    return season?.splits.find((split) => split.start <= cycle.start && cycle.start <= split.end)?.id ?? null;
  }
  function renderSeason(data) {
    const pick = el("select", { "aria-label": "Season or split", onchange: (event) => {
      [state.season, state.split] = event.target.value.split("|");
      void loadEntries();
    } }, ...[...data.seasons].sort((a, b) => b.end - a.end).flatMap((season) => [
      ...[...season.splits].reverse().map((split) => el("option", { value: `${season.season}|${split.id}`,
        text: `Season ${season.season} · ${split.label} (${shortDate(split.start)} – ${shortDate(split.end)})` })),
      el("option", { value: `${season.season}|all`, text: `Season ${season.season} · whole season` }),
    ]));
    pick.value = `${data.season}|${data.split ?? "all"}`;
    const now = Date.now() / 1000;
    const played = data.weeks.filter((week) => week.start <= now).length;
    els.interlink.replaceChildren(
      el("div", { class: "lb-subbar" }, el("label", { class: "lb-split" }, el("span", { text: "Split" }), pick), updatedLine(data.updatedAt)),
      el("p", { class: "lb-rules" }, el("span", { text: "Each week: your best run on the left, center and right boss, added together; then every week added up." }),
        el("span", { text: "Stars reset when a split starts, so the current split shows first." })),
      el("div", { class: "lb-chips", role: "group", "aria-label": "Rank by" }, [["score", "Combined score"], ["stars", "Total stars"]].map(([id, label]) => el("button", {
        type: "button", "aria-pressed": String(state.rank === id), text: label,
        onclick: () => { state.rank = id; void loadEntries(); },
      }))));
    const most = Math.max(1, ...data.standings.map((entry) => Number(entry.stars) || 0));
    els.head.replaceChildren(el("tr", {}, ["#", "Player", "Combined score", "Total stars", "Weeks", "Best week"].map((text, index) => el("th", {
      scope: "col", text, class: [index === (state.rank === "stars" ? 3 : 2) ? "is-ranked" : "", index > 3 ? "lb-hide-sm" : ""].join(" ").trim() || null,
    }))));
    els.rows.replaceChildren(...(data.standings.length ? data.standings.map((entry) => el("tr", { class: entry.own ? "is-own" : null },
      el("td", { class: "lb-rank", text: String(entry.rank) }),
      el("td", { class: "lb-player" }, playerName(entry), el("span", { class: "lb-bar", "aria-hidden": "true" },
        el("i", { style: `width: ${Math.round((Number(entry.stars) || 0) / most * 100)}%` }))),
      el("td", { class: state.rank === "score" ? "is-ranked" : null, text: number(entry.total) }),
      el("td", { class: state.rank === "stars" ? "is-ranked" : null }, stars(entry.stars)),
      el("td", { class: "lb-hide-sm", text: `${number(entry.weeks)} / ${number(played)}` }),
      el("td", { class: "lb-hide-sm", text: number(entry.bestWeek) })))
      : [el("tr", {}, el("td", { colspan: "6", class: "lb-empty", text: "No scores in this split yet." }))]));
    els.tableWrap.hidden = false;
    els.summary.textContent = `${pick.selectedOptions[0]?.textContent || `Season ${data.season}`} · ${number(data.standings.length)} player${data.standings.length === 1 ? "" : "s"}`;
  }

  async function loadInterlink(requestId) {
    const ask = new URLSearchParams();
    if (state.server) ask.set("server", state.server);
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
    if (state.week) ask.set("cycle", state.week);
    if (state.viewBoss) {
      ask.set("boss", state.viewBoss);
      ask.set("ladder", state.viewLadder);
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
    state.week = data.cycle.id;
    writeUrl();
    if (state.viewBoss) renderFull(data);
    else renderPerBoss(data);
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
    els.summary.textContent = simBoard
      ? `${simBoard} · fastest Victory first · ${result.bestPerPlayer ? "best per player" : "every run"} · ${number(result.total)} record${result.total === 1 ? "" : "s"}`
      : `${board().label} · ranked by ${(state.kind === "eggheist_match" && result.sort === "score" ? "Loot" : SORT_LABELS[result.sort]) || result.sort} · ${result.bestPerPlayer ? "best per player" : "every run"} · ${number(result.total)} record${result.total === 1 ? "" : "s"}`;
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
  els.sort.addEventListener("change", () => {
    state.sort = els.sort.value;
    state.order = "";
    state.offset = 0;
    void loadEntries();
  });
  let searchTimer = 0;
  els.filters.addEventListener("input", (event) => {
    if (event.target === els.sort) return;
    if (event.target === els.filters.elements.trial) fillSimPickers();   // that trial's own difficulties
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.offset = 0;
      void loadEntries();
    }, event.target.type === "search" ? 300 : 0);
  });
  els.filters.addEventListener("submit", (event) => event.preventDefault());
  els.serverSelect.addEventListener("change", () => { state.server = els.serverSelect.value; state.offset = 0; void loadEntries(); });
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
