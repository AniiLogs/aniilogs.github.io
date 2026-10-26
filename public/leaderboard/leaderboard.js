(() => {
  const siteConfig = window.ANIILOGS_CONFIG || {};
  const API_URL = String(siteConfig.apiUrl || siteConfig.shareApiUrl || "").replace(/\/+$/u, "");
  const AUTH_SESSION_STORAGE_KEY = "aniilogs:auth:session:v1";
  const PREFERENCES_KEY = "aniilogs:explorer:preferences:v1";
  const PAGE_SIZE = 50;

  // Boards per mode: which records they rank, what they can be ranked by, and which filters apply.
  const BOARDS = Object.freeze({
    // Interlink runs weekly (a new week starts Wednesday 20:00 UTC) with three bosses; seasons add the weeks up.
    interlink: [
      { kind: "interlink_week_view", label: "This week", custom: "week", sorts: [], fields: [] },
      { kind: "interlink_season_view", label: "Season", custom: "season", sorts: [], fields: [] },
      { kind: "interlink_run", label: "All runs", sorts: ["score", "team_dps", "clear_time_s", "stars", "meter_dps"], fields: ["cycle", "boss", "level", "party", "cleared"] },
    ],
    sim: [
      { kind: "sim_run", label: "Full clears", sorts: ["clear_time_s", "floors"], fields: ["party", "buff"] },
    ],
    // Skeleton: the meter doesn't read Egg Heist results yet; entries can only come in through the API for now.
    eggheist: [
      { kind: "eggheist_season", label: "Season standings", sorts: ["standing", "score", "stars"], fields: ["cycle"] },
    ],
  });
  const SORT_LABELS = Object.freeze({
    standing: "Rank", score: "Score", team_dps: "Team DPS", clear_time_s: "Fastest time", stars: "Stars", meter_dps: "Meter DPS", floors: "Floors",
  });
  // Table columns per board; `sort` makes the header clickable.
  const COLUMNS = Object.freeze({
    interlink_run: [
      { label: "Boss", value: (e) => bossLabel(e) },
      { label: "Score", sort: "score", value: (e) => number(e.score) },
      { label: "Stars", sort: "stars", value: (e) => number(e.stars) },
      { label: "Time", sort: "clear_time_s", value: (e) => duration(e.clearTimeS) + (e.cleared === false ? " (timed out)" : "") },
      { label: "Team DPS", sort: "team_dps", value: (e) => number(e.teamDps) },
      { label: "Party", value: (e) => number(e.partySize) },
      { label: "Week", value: (e) => e.cycle || "—" },
      { label: "Played", value: (e) => date(e.playedAt || e.submittedAt) },
    ],
    interlink_week: [
      { label: "Week", value: (e) => e.cycle || "—" },
      { label: "Weekly score", sort: "score", value: (e) => number(e.score) },
      { label: "Stars", sort: "stars", value: (e) => number(e.stars) },
      { label: "Recorded", value: (e) => date(e.playedAt || e.submittedAt) },
    ],
    interlink_best: [
      { label: "Boss", value: (e) => bossLabel(e) },
      { label: "Best score", sort: "score", value: (e) => number(e.score) },
      { label: "Stars", sort: "stars", value: (e) => number(e.stars) },
      { label: "Week", value: (e) => e.cycle || "—" },
    ],
    eggheist_season: [
      { label: "Rank", sort: "standing", value: (e) => e.seasonRank?.name || (e.seasonRank?.tier ? `Tier ${e.seasonRank.tier}` : "—") },
      { label: "Rank points", sort: "score", value: (e) => number(e.score) },
      // Stars only exist at the top rank (Egg Emperor)
      { label: "Emperor stars", sort: "stars", value: (e) => (e.seasonRank?.tier === 7 || e.stars ? number(e.stars) : "—") },
      { label: "Season", value: (e) => e.cycle || "—" },
      { label: "Updated", value: (e) => date(e.playedAt || e.submittedAt) },
    ],
    sim_run: [
      { label: "Clear time", sort: "clear_time_s", value: (e) => duration(e.clearTimeS) },
      { label: "Floors", sort: "floors", value: (e) => number(e.floors) },
      { label: "Buffs", value: (e) => number(e.buffs?.length) },
      { label: "Party", value: (e) => number(e.partySize) },
      { label: "Played", value: (e) => date(e.playedAt || e.submittedAt) },
    ],
  });

  const $ = (selector) => document.querySelector(selector);
  const els = {
    gate: $("[data-gate]"), gateTitle: $("[data-gate-title]"), gateDetail: $("[data-gate-detail]"),
    board: $("[data-board]"), badge: $("[data-preview-badge]"), filters: $("[data-filters]"),
    boardTabs: $("[data-board-tabs]"), sort: $("[data-filter-sort]"), summary: $("[data-summary]"),
    head: $("[data-head]"), rows: $("[data-rows]"), prev: $("[data-prev]"), next: $("[data-next]"), page: $("[data-page]"),
    login: $("[data-login]"), account: $("[data-account]"),
    weekly: $("[data-weekly]"), weekSelect: $("[data-week-select]"), seasonSelect: $("[data-season-select]"),
    serverPick: $("[data-server-pick]"), serverSelect: $("[data-server-select]"),
    weekPick: $("[data-week-pick]"), seasonPick: $("[data-season-pick]"), subTabs: $("[data-sub-tabs]"),
  };
  const state = {
    mode: "interlink", kind: "interlink_week_view", sort: "", order: "", offset: 0, week: "", sub: "total", season: "", server: "",
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
    return el("a", { ...props, href: `/?profile=${encodeURIComponent(profileId)}#my-profile`, title, text: name });
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
  function bossLabel(entry) {
    const name = entry.boss?.name || entry.boss?.id || "—";
    return entry.boss?.level ? `${name} · Lv ${entry.boss.level}` : name;
  }
  function board() {
    return BOARDS[state.mode].find((item) => item.kind === state.kind) || BOARDS[state.mode][0];
  }

  // ---------------------------------------------------------------- URL state
  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    if (Object.hasOwn(BOARDS, params.get("mode") || "")) state.mode = params.get("mode");
    const kind = params.get("kind");
    if (BOARDS[state.mode].some((item) => item.kind === kind)) state.kind = kind;
    else state.kind = BOARDS[state.mode][0].kind;
    state.sort = params.get("sort") || "";
    state.order = params.get("order") || "";
    state.offset = Math.max(0, Number.parseInt(params.get("offset") || "0", 10) || 0);
    state.week = params.get("week") || ""; state.sub = params.get("board") || "total"; state.season = params.get("season") || "";
    state.server = params.get("server") || "";
    for (const name of ["cycle", "boss", "level", "party", "buff", "player"]) {
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
    if (board().custom === "week") {
      if (state.week) params.set("week", state.week);
      if (state.sub !== "total") params.set("board", state.sub);
      return params;
    }
    if (board().custom === "season") {
      if (state.season) params.set("season", state.season);
      return params;
    }
    if (state.sort) params.set("sort", state.sort);
    if (state.order) params.set("order", state.order);
    const fields = board().fields;
    for (const name of ["cycle", "boss", "level", "party", "buff"]) {
      const value = els.filters.elements[name]?.value;
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
    els.boardTabs.replaceChildren(...BOARDS[state.mode].map((item) => el("button", {
      type: "button", role: "tab", "aria-selected": String(item.kind === state.kind), text: item.label,
      onclick: () => {
        if (state.kind === item.kind) return;
        state.kind = item.kind;
        state.sort = "";
        state.order = "";
        state.offset = 0;
        state.expanded.clear();
        renderControls();
        void loadEntries();
      },
    })));
    els.boardTabs.hidden = BOARDS[state.mode].length < 2;
    const custom = board().custom;
    els.filters.hidden = Boolean(custom);
    els.weekly.hidden = !custom;
    els.weekPick.hidden = custom !== "week";
    els.subTabs.hidden = custom !== "week";
    els.seasonPick.hidden = custom !== "season";
    for (const node of [els.prev, els.next, els.page]) node.hidden = Boolean(custom);
    if (custom) return;
    const sorts = board().sorts;
    if (!sorts.includes(state.sort)) state.sort = sorts[0];
    els.sort.replaceChildren(...sorts.map((key) => el("option", { value: key, text: SORT_LABELS[key] })));
    els.sort.value = state.sort;
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
    fillSelect(f.party, facets.partySizes.map((row) => ({ value: row.value, label: row.value === 1 ? "Solo" : `${row.value} players` })), "Any size");
    fillSelect(f.buff, (facets.buffs || []).map((row) => ({ value: row.name, label: `${row.name} (${row.count})` })), "Any buff");
  }

  // ---------------------------------------------------------------- table
  function renderHead() {
    const columns = COLUMNS[state.kind];
    const headers = [el("th", { scope: "col", text: "#" }), el("th", { scope: "col", text: "Player" })];
    for (const column of columns) {
      if (!column.sort || !board().sorts.includes(column.sort)) {
        headers.push(el("th", { scope: "col", text: column.label }));
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
        })));
    }
    els.head.replaceChildren(el("tr", {}, headers));
  }
  function currentOrder() {
    if (state.order) return state.order;
    return state.sort === "clear_time_s" ? "asc" : "desc";
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
    if (entry.hasEvidence && (entry.own || state.status?.canModerate)) {
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
  function weekLabel(week, current) {
    const start = new Date(week.start * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `Week of ${start} · ${week.bosses.map((boss) => boss.name.replace(/^Omega /u, "")).join(", ")}${week.id === current ? " (this week)" : ""}`;
  }
  function playerCell(entry) {
    return el("td", { class: "lb-player" }, profileName(entry.player, entry.profileId, {}, entry.uid),
      entry.own ? el("span", { class: "lb-you", text: "you" }) : null, ...nameMarks(entry));
  }
  // How the game's Challenge Score adds up (bossrush_grade_data in the game files, checked against recorded runs).
  function scoreHeader(text) {
    const tip = el("div", { id: "lbScoreInfo", class: "lb-info-pop", popover: "auto" },
      el("strong", { text: "How Challenge Score works" }),
      el("ul", {},
        el("li", { text: "Each star is worth 1,000: 500 for reaching it, plus up to 500 for the boss HP you take off on the way to the next star." }),
        el("li", { text: "15 stars = 15,000. Taking the boss down after that is worth up to 5,000 more." }),
        el("li", { text: "Finishing early adds a further bonus that the game doesn't publish. We're still working it out from recorded runs." })),
      el("p", { text: "Boss boards rank by stars, then score, then fastest clear. A clear means 15 stars, then ending early." }));
    return el("th", { scope: "col" }, el("span", { class: "lb-th-info" }, el("span", { text }),
      el("button", { type: "button", class: "lb-info", popovertarget: "lbScoreInfo", "aria-label": "How Challenge Score works", text: "i" })), tip);
  }
  function table(headers, rows, empty) {
    els.head.replaceChildren(el("tr", {}, headers.map((text) => (/score$/u.test(text) ? scoreHeader(text) : el("th", { scope: "col", text })))));
    els.rows.replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { colspan: String(headers.length), class: "lb-empty", text: empty }))]));
  }
  async function loadInterlink(requestId) {
    const custom = board().custom;
    const ask = new URLSearchParams();
    if (custom === "week" && state.week) ask.set("cycle", state.week);
    else if (custom === "season" && state.season) ask.set("season", state.season);
    if (state.server) ask.set("server", state.server);
    let response = await apiFetch(`/leaderboard/interlink${ask.size ? `?${ask}` : ""}`);
    if (requestId !== state.requestId) return;
    let data = response.ok ? await response.json() : null;
    if (custom === "season" && data && !state.season) {            // no season picked: the current week's season
      state.season = String(data.cycle?.season ?? "");
      response = await apiFetch(`/leaderboard/interlink?season=${encodeURIComponent(state.season)}${state.server ? `&server=${encodeURIComponent(state.server)}` : ""}`);
      if (requestId !== state.requestId) return;
      data = response.ok ? await response.json() : null;
    }
    if (!data) { els.summary.textContent = "The leaderboard could not be loaded."; els.rows.replaceChildren(); return; }
    if (custom === "week") {
      state.week = data.cycle.id;
      const now = Date.now() / 1000;
      const weeks = data.weeks.filter((week) => week.start <= now || week.id === data.cycle.id).reverse();
      els.weekSelect.replaceChildren(...weeks.map((week) => el("option", { value: week.id, text: weekLabel(week, data.current) })));
      els.weekSelect.value = state.week;
      const subs = [{ id: "total", name: "Week total" }, ...data.bosses];
      if (!subs.some((sub) => sub.id === state.sub)) state.sub = "total";
      els.subTabs.replaceChildren(...subs.map((sub) => el("button", {
        type: "button", role: "tab", "aria-selected": String(sub.id === state.sub), text: sub.name,
        onclick: () => { state.sub = sub.id; void loadEntries(); },
      })));
      writeUrl();
      if (state.sub === "total") {
        table(["#", "Player", "Week score", "Stars", ...data.bosses.map((boss) => boss.name)],
          data.week.map((entry) => el("tr", { class: entry.own ? "is-own" : null }, el("td", { class: "lb-rank", text: String(entry.rank) }),
            playerCell(entry), el("td", { text: number(entry.total) }), el("td", {}, stars(entry.stars)),
            ...data.bosses.map((boss) => el("td", {}, entry.scores[boss.id] == null ? "—"
              : el("span", { class: "lb-boss-cell" }, el("span", { text: number(entry.scores[boss.id]) }), stars(entry.bossStars?.[boss.id])))))),
          "No scores this week yet.");
        els.summary.textContent = `Week total · each player's best score on each of this week's three bosses, added up · ${number(data.week.length)} player${data.week.length === 1 ? "" : "s"}`;
      } else {
        const bossBoard = data.bosses.find((boss) => boss.id === state.sub);
        table(["#", "Player", "Best score", "Stars", "Fastest clear"],
          bossBoard.entries.map((entry) => el("tr", { class: entry.own ? "is-own" : null }, el("td", { class: "lb-rank", text: String(entry.rank) }),
            playerCell(entry), el("td", { text: number(entry.score) }), el("td", {}, stars(entry.stars)),
            el("td", { text: entry.clearTimeS == null ? "—" : duration(entry.clearTimeS) }))),
          "No scores on this boss this week yet.");
        els.summary.textContent = `${bossBoard.name} · each player's best score this week · ${number(bossBoard.entries.length)} player${bossBoard.entries.length === 1 ? "" : "s"}`;
      }
      return;
    }
    const seasons = [...new Set(data.weeks.map((week) => week.season))].filter((value) => value != null);
    els.seasonSelect.replaceChildren(...seasons.map((value) => el("option", { value: String(value), text: `Season ${value}` })));
    els.seasonSelect.value = String(data.season);
    writeUrl();
    table(["#", "Player", "Season score", "Stars", "Weeks played"],
      data.standings.map((entry) => el("tr", { class: entry.own ? "is-own" : null }, el("td", { class: "lb-rank", text: String(entry.rank) }),
        playerCell(entry), el("td", { text: number(entry.total) }), el("td", {}, stars(entry.stars)), el("td", { text: number(entry.weeks) }))),
      "No scores this season yet.");
    els.summary.textContent = `Season ${data.season} · every week's scores added up (${number(data.weeks.length)} weeks) · ${number(data.standings.length)} player${data.standings.length === 1 ? "" : "s"}`;
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
    els.summary.textContent = `${board().label} · ranked by ${SORT_LABELS[result.sort] || result.sort} · ${result.bestPerPlayer ? "best per player" : "every run"} · ${number(result.total)} record${result.total === 1 ? "" : "s"}`;
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
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.offset = 0;
      void loadEntries();
    }, event.target.type === "search" ? 300 : 0);
  });
  els.filters.addEventListener("submit", (event) => event.preventDefault());
  els.weekSelect.addEventListener("change", () => { state.week = els.weekSelect.value; void loadEntries(); });
  els.serverSelect.addEventListener("change", () => { state.server = els.serverSelect.value; state.offset = 0; void loadEntries(); });
  els.seasonSelect.addEventListener("change", () => { state.season = els.seasonSelect.value; void loadEntries(); });
  els.prev.addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - PAGE_SIZE);
    void loadEntries();
  });
  els.next.addEventListener("click", () => {
    state.offset += PAGE_SIZE;
    void loadEntries();
  });

  // ---------------------------------------------------------------- access gate
  function gate(title, detail, link) {
    els.gate.hidden = false;
    els.board.hidden = true;
    els.gateTitle.textContent = title;
    els.gateDetail.replaceChildren(detail, link ? el("a", { href: link.href, text: link.text }) : "");
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

  async function start() {
    if (!API_URL) return gate("Leaderboards are unavailable.", "The AniiLogs API is not configured for this page.");
    try {
      await consumeAuthHandoff();
    } catch {
      // A failed handoff leaves the page signed out; the gate explains what to do.
    }
    const returnUrl = new URL(window.location.href);
    returnUrl.hash = "";
    els.login.href = `${API_URL}/auth/discord/start?return_to=${encodeURIComponent(returnUrl.toString())}`;
    let status;
    let account = null;
    try {
      const [statusResponse, meResponse] = await Promise.all([apiFetch("/leaderboard/status"), apiFetch("/auth/me")]);
      status = await statusResponse.json();
      const me = await meResponse.json();
      if (me.authenticated) account = me.account;
    } catch {
      return gate("Leaderboards are temporarily unavailable.", "The account service could not be reached. Try again shortly.");
    }
    state.status = status;
    if (account) {
      els.login.hidden = true;
      els.account.hidden = false;
      els.account.textContent = account.displayName || account.globalName || account.username;
    }
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
