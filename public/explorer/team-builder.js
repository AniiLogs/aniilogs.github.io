// game-audit: unaudited skills, traits, buffs and recommendations from team_builder_data.json (generated from the game tables)
(() => {
  "use strict";

  // Team Builder: skill loadouts, how each skill works, and team synergy, from the reviewed
  // team_builder_data.json release file (skills, traits and buffs traced from the game tables).
  // The explorer mounts it with show({ sidebar, panel, loadAniilog, contentUrl, dataUrl }).
  const STORAGE_KEY = "aniilogs:team-builder:v1";
  const VIEW_STORAGE_KEY = "aniilogs:team-builder:view:v1";
  const MAX_TYPE_SELECTION = 2;
  const STRONG = 1.6;
  const WEAK = 0.625;
  const LOADOUT_FILE_FORMAT = "aniilogs-team-loadout";
  const LOADOUT_FILE_VERSION = 1;
  const MAX_LOCAL_LOADOUTS = 50;
  const MAX_LOADOUT_FILE_BYTES = 256 * 1024;
  const SHARE_HASH_KEY = "t";
  // Four Aniimo fight; Holo-Sim adds a fifth reserve that can be swapped in outside battle.
  const TEAM_SIZE = 4;
  const RESERVE_SLOT = 4;
  const MEMBER_SLOTS = 5;
  const MAX_ACTIVE_SKILLS = 2;
  // Team setups, under PvE or PvP (Team Builder's second row of tabs). 1v1 is a PvP tab too, but its own page
  // (duel.js): DUEL_TAB below. card: how the share card names the mode. main: the one slot whose skills are picked,
  // the others support with their Core skill only (Interlink: slot 1; both Egg Heist modes: slot 2).
  const MODES = Object.freeze([
    Object.freeze({ id: "standard", label: "Standard", share: "s", group: "pve" }),
    Object.freeze({ id: "interlink", label: "Interlink", share: "c", group: "pve", main: 0 }),
    Object.freeze({ id: "holosim", label: "Holo-Sim", share: "h", group: "pve" }),
    Object.freeze({ id: "eggheist", label: "Egg Heist", share: "e", group: "pve", main: 1 }),
    // Fair and Unfair: four Aniimo; their rule sets aren't known yet, so they're marked work in progress.
    Object.freeze({ id: "pvpfair", label: "Fair (WIP)", share: "f", group: "pvp", card: "PvP · Fair (WIP)" }),
    Object.freeze({ id: "pvpunfair", label: "Unfair (WIP)", share: "u", group: "pvp", card: "PvP · Unfair (WIP)" }),
    Object.freeze({ id: "eggheistpvp", label: "Egg Heist PvP", share: "x", group: "pvp", main: 1 }),
  ]);
  const MODE_GROUPS = Object.freeze([
    Object.freeze({ id: "pve", label: "PvE" }),
    Object.freeze({ id: "pvp", label: "PvP" }),
  ]);
  const DUEL_TAB = ["duel", "1v1"];
  const MODE_NOTES = Object.freeze({
    standard: "Four Aniimo, each with two picked active skills. Each Aniimo's Core switch-skill and Ultimate are always available.",
    interlink: "You control the first Aniimo and pick its skills. The other three bring their Core skills.",
    holosim: "Like Standard, plus a reserve you can swap in and out between battles in the Holo-Battle Simulator.",
    eggheist: "Like Interlink: you control the Aniimo in slot 2 and pick its skills. The other three support with their Core skills.",
    pvpfair: "Fair PvP: four Aniimo against another player's team. Its rules aren't known yet (work in progress).",
    pvpunfair: "Unfair PvP: four Aniimo against another player's team. Its rules aren't known yet (work in progress).",
    eggheistpvp: "Egg Heist against other players, like Interlink: you control the Aniimo in slot 2 and pick its skills. The other three support with their Core skills.",
  });
  const WHO_LABELS = Object.freeze({
    self: "Self",
    enemy: "Enemies",
    ally: "Allies",
    "active Aniimo": "Active Aniimo",
    player: "Player",
    target: "Affected targets",
  });
  const ROLE_NOTES = Object.freeze({
    Team: "Reaches allies or whichever Aniimo is out.",
    "Carries over on switch": "Its buff stays on the next Aniimo you switch in.",
    "Enemy debuff": "Changes enemy stats, so it helps whoever hits that enemy.",
    "Self only": "Its effects stay on this Aniimo.",
    "Not traced": "Its effects run through something the game tables don't describe (such as spawned pickups). See the game description.",
  });
  // Attribute keys ending like these hold fractions; everything else is a plain amount.
  const PERCENT_KEY = /(?:_rate|_ratio|_p)(?:_v)?$|_rate_|_ratio_/u;

  let host = null;
  let aniilog = null;
  let data = null;
  let loadPromise = null;
  let loadError = "";
  let status = "";
  let store = loadStore();
  let model = activeLoadout().model;
  // The Try-Hard Guide moved to its own page (/guides/): an old Team Builder guide link (?tab=guide or #guide-…)
  // goes there, to the same section.
  function guideAddress() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") !== "team") return "";
    if (params.get("tab") !== "guide" && !/^#guide-/u.test(window.location.hash)) return "";
    return `/guides/?guide=damage${window.location.hash || ""}`;
  }
  if (guideAddress()) window.location.replace(guideAddress());

  // Which Team Builder page is open, the elements picked in Type matchups and its PvE or PvP values (per viewer).
  let viewState = loadViewState();

  function loadViewState() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(VIEW_STORAGE_KEY) || "null");
      return {
        page: pageFromAddress() || (["types", "duel"].includes(saved?.page) ? saved.page : "team"),
        types: Array.isArray(saved?.types) ? saved.types.slice(0, MAX_TYPE_SELECTION).map(String) : [],
        memberTab: String(saved?.memberTab || "build"),
        lastPve: String(saved?.lastPve || ""),
        lastPvp: String(saved?.lastPvp || ""),
        matchupMode: saved?.matchupMode === "pvp" ? "pvp" : "pve",
        typesTab: saved?.typesTab === "compare" ? "compare" : "matchups",
        compare: normalizeCompare(saved?.compare),
      };
    } catch {
      return { page: "team", types: [], memberTab: "build", lastPve: "", lastPvp: "", matchupMode: "pve", typesTab: "matchups", compare: normalizeCompare(null) };
    }
  }

  // Type matchups › Compare: two Aniimo (form ids) or two saved teams (loadout ids). Empty means "pick for me".
  function normalizeCompare(value) {
    const text = (key) => String(value?.[key] || "").slice(0, 80);
    return { kind: value?.kind === "teams" ? "teams" : "aniimo", a: text("a"), b: text("b"), teamA: text("teamA"), teamB: text("teamB") };
  }

  function saveViewState() {
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(viewState));
    } catch {
      // Remembering the open page is only a convenience.
    }
  }

  // The open tab is in the address (/explorer/?view=team&tab=duel): a shared or reloaded link opens it, and the
  // browser's Back and Forward return to it. Switching tabs adds a history entry; anything else keeps the entry.
  // (Called while viewState is first read, so the tab list is a literal here rather than a later constant.)
  function pageFromAddress() {
    const tab = new URLSearchParams(window.location.search).get("tab");
    return ["team", "types", "duel"].includes(tab) ? tab : "";
  }

  // push: a new history entry, written before the render so the entry being left keeps its own scroll position.
  function writePageAddress(push, page = viewState.page) {
    const url = new URL(window.location.href);
    if (url.searchParams.get("view") !== "team" || url.searchParams.get("tab") === page) return;
    url.searchParams.set("tab", page);
    if (push && host?.pushAddress) host.pushAddress(url, { workspaceView: "team", tab: page });
    else if (push) window.history.pushState({ workspaceView: "team", tab: page }, "", url);
    else window.history.replaceState(window.history.state, "", url);
  }

  function goToPage(page) {
    if (viewState.page !== page) writePageAddress(true, page);
    viewState.page = page;
    saveViewState();
    render();
  }

  // Back/Forward (the explorer's popstate): the tab named in the address.
  function applyAddress() {
    const page = pageFromAddress() || "team";
    if (viewState.page === page) return;
    viewState.page = page;
    saveViewState();
  }

  function openTypes(types) {
    if (viewState.page !== "types") writePageAddress(true, "types");
    viewState = { ...viewState, page: "types", typesTab: "matchups", types: types.map(String).slice(0, MAX_TYPE_SELECTION) };
    saveViewState();
    render();
    host.panel.scrollTo?.({ top: 0 });
  }

  function defaultMember() {
    return { formId: "", activeSkills: ["", ""] };
  }

  function defaultModel() {
    return {
      mode: "standard",
      activeSlot: 0,
      members: Array.from({ length: MEMBER_SLOTS }, defaultMember),
      scenario: {},
    };
  }

  // Older saves call Interlink "coop".
  function normalizeMode(value) {
    if (value === "coop") return "interlink";
    return MODES.some((mode) => mode.id === value) ? value : "standard";
  }

  function slotCount(mode = model.mode) {
    return mode === "holosim" ? MEMBER_SLOTS : TEAM_SIZE;
  }

  function slotIndexes() {
    return Array.from({ length: slotCount() }, (_, index) => index);
  }

  function battleMembers() {
    return model.members.slice(0, TEAM_SIZE).map((member, index) => ({ member, index, form: formFor(member) }))
      .filter((row) => row.form);
  }

  function normalizeMember(value) {
    const activeSkills = Array.isArray(value?.activeSkills)
      ? value.activeSkills.slice(0, MAX_ACTIVE_SKILLS).map((skill) => String(skill || ""))
      : [];
    while (activeSkills.length < MAX_ACTIVE_SKILLS) activeSkills.push("");
    const member = { formId: String(value?.formId || ""), activeSkills };
    // Build tab inputs (also read by the 1v1 tab); unset means level cap and no potential.
    if (Number.isFinite(Number(value?.level)) && value?.level !== null && value?.level !== "") member.level = Math.round(Number(value.level));
    // Potential: one number per stat (older saves stored one number for all six).
    if (value?.potential && typeof value.potential === "object") {
      member.potential = Object.fromEntries(Object.entries(value.potential)
        .filter(([stat, points]) => ["HP", "ATK", "P.DEF", "REGEN", "M.DEF", "BREAK"].includes(stat) && Number.isFinite(Number(points)))
        .map(([stat, points]) => [stat, Math.min(20, Math.max(0, Math.round(Number(points))))]));
    } else if (Number.isFinite(Number(value?.potential)) && value?.potential !== null && value?.potential !== "") {
      member.potential = Math.round(Number(value.potential));
    }
    if (value?.perfect === true) member.perfect = true;
    if (Array.isArray(value?.formResearch)) member.formResearch = value.formResearch.map(String).filter((id) => /^\d+$/u.test(id));
    // CP-only inputs: Core skill upgraded, and forms / Prismana forms caught in the Aniilog.
    if (value?.coreUpgraded === true) member.coreUpgraded = true;
    if (Number.isFinite(Number(value?.formsCaught)) && value?.formsCaught !== null) member.formsCaught = Math.min(99, Math.max(1, Math.round(Number(value.formsCaught))));
    if (Number.isFinite(Number(value?.prismanaCaught)) && value?.prismanaCaught !== null) member.prismanaCaught = Math.min(99, Math.max(0, Math.round(Number(value.prismanaCaught))));
    if (value?.starUp && Number(value.starUp.stage) > 0) {
      member.starUp = { stage: Math.round(Number(value.starUp.stage)), level: Math.max(0, Math.round(Number(value.starUp.level) || 0)) };
    }
    // Build tab card calculator: personality letters (one per pair) and one held item with its level.
    if (Array.isArray(value?.personality)) member.personality = value.personality.map(String).filter((letter) => /^[EISNTFJP]$/u.test(letter)).slice(0, 4);
    if (value?.heldItem && Number.isFinite(Number(value.heldItem.itemId))) {
      // No saved level means the item's top level (held-item-picker.js normalize).
      member.heldItem = { itemId: String(value.heldItem.itemId) };
      const level = value.heldItem.level;
      if (level !== undefined && level !== null && level !== "" && Number.isFinite(Number(level))) {
        member.heldItem.level = Math.max(0, Math.round(Number(level)));
      }
    } else if (value?.heldItem === null) {
      // "No held item" picked on purpose; unset means the default (held-item-picker.js defaultFor).
      member.heldItem = null;
    }
    return member;
  }

  function normalizeModel(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaultModel();
    const members = Array.isArray(value.members) ? value.members.slice(0, MEMBER_SLOTS).map(normalizeMember) : [];
    while (members.length < MEMBER_SLOTS) members.push(defaultMember());
    const scenario = value.scenario && typeof value.scenario === "object" && !Array.isArray(value.scenario)
      ? Object.fromEntries(Object.entries(value.scenario).slice(0, 500).map(([key, enabled]) => [String(key), Boolean(enabled)]))
      : {};
    const mode = normalizeMode(value.mode);
    return {
      mode,
      activeSlot: Math.min(slotCount(mode) - 1, Math.max(0, Math.round(Number(value.activeSlot) || 0))),
      members,
      scenario,
    };
  }

  function loadoutId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function cleanName(value, fallback = "Team") {
    return String(value || "").replace(/\s+/gu, " ").trim().slice(0, 80) || fallback;
  }

  function normalizeLoadout(value, index) {
    const now = new Date().toISOString();
    return {
      id: String(value?.id || loadoutId()),
      name: cleanName(value?.name, `Team ${index + 1}`),
      createdAt: String(value?.createdAt || now),
      updatedAt: String(value?.updatedAt || value?.createdAt || now),
      model: normalizeModel(value?.model),
    };
  }

  function normalizeStore(value) {
    const saved = Array.isArray(value?.loadouts) ? value.loadouts.slice(0, MAX_LOCAL_LOADOUTS).map(normalizeLoadout) : [];
    const loadouts = saved.length ? saved : [normalizeLoadout({ name: "Team 1" }, 0)];
    const activeId = String(value?.activeId || "");
    return {
      version: 1,
      activeId: loadouts.some((loadout) => loadout.id === activeId) ? activeId : loadouts[0].id,
      loadouts,
    };
  }

  function loadStore() {
    try {
      return normalizeStore(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null"));
    } catch {
      return normalizeStore(null);
    }
  }

  function saveStore() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      // The builder stays usable for this visit when storage is unavailable.
    }
  }

  function activeLoadout() {
    return store.loadouts.find((loadout) => loadout.id === store.activeId) || store.loadouts[0];
  }

  function persist() {
    const loadout = activeLoadout();
    model = normalizeModel(model);
    loadout.model = model;
    loadout.updatedAt = new Date().toISOString();
    saveStore();
  }

  function uniqueName(requested) {
    const base = cleanName(requested, `Team ${store.loadouts.length + 1}`);
    const names = new Set(store.loadouts.map((loadout) => loadout.name.toLocaleLowerCase()));
    if (!names.has(base.toLocaleLowerCase())) return base;
    let suffix = 2;
    while (names.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix += 1;
    return `${base} ${suffix}`;
  }

  function createLoadout(name, initialModel = defaultModel()) {
    if (store.loadouts.length >= MAX_LOCAL_LOADOUTS) {
      throw new Error(`You can save up to ${MAX_LOCAL_LOADOUTS} teams in this browser.`);
    }
    const now = new Date().toISOString();
    const loadout = normalizeLoadout({ id: loadoutId(), name: uniqueName(name), createdAt: now, updatedAt: now, model: initialModel }, store.loadouts.length);
    store.loadouts.push(loadout);
    store.activeId = loadout.id;
    model = loadout.model;
    saveStore();
    return loadout;
  }

  function switchLoadout(id) {
    persist();
    const loadout = store.loadouts.find((entry) => entry.id === id);
    if (!loadout) return;
    store.activeId = loadout.id;
    model = normalizeModel(loadout.model);
    loadout.model = model;
    status = `Loaded ${loadout.name}.`;
    saveStore();
    render();
  }

  function runAction(action) {
    try {
      action();
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  // From the saved-team list's "Rename" on that team's row (aniimo-picker.js rename).
  function renameLoadout(id, requested) {
    const loadout = store.loadouts.find((entry) => entry.id === id);
    if (!loadout) return;
    const name = cleanName(requested, loadout.name);
    if (store.loadouts.some((entry) => entry.id !== loadout.id && entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      status = `A team named ${name} already exists.`;
    } else {
      loadout.name = name;
      status = `Renamed to ${name}.`;
      persist();
    }
    render();
  }

  function deleteLoadout() {
    const loadout = activeLoadout();
    if (!window.confirm(`Delete ${loadout.name} from this browser?`)) return;
    store.loadouts = store.loadouts.filter((entry) => entry.id !== loadout.id);
    store = normalizeStore(store);
    model = activeLoadout().model;
    status = `Deleted ${loadout.name}.`;
    saveStore();
    render();
  }

  // Compact team payload used by both the export file and the share link.
  function teamPayload() {
    return {
      m: MODES.find((mode) => mode.id === model.mode)?.share || "s",
      t: model.members.slice(0, slotCount()).map((member) => [member.formId, ...member.activeSkills]),
    };
  }

  function modelFromPayload(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.t)) throw new Error("This team link or file is not valid.");
    return normalizeModel({
      mode: MODES.find((mode) => mode.share === payload.m)?.id || "standard",
      members: payload.t.slice(0, MEMBER_SLOTS).map((row) => (Array.isArray(row) ? {
        formId: row[0],
        activeSkills: [row[1], row[2]],
      } : {})),
    });
  }

  function encodeBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  }

  function decodeBase64Url(value) {
    const binary = atob(String(value).replace(/-/gu, "+").replace(/_/gu, "/"));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    window.prompt("Copy this link:", value);
    return false;
  }

  async function shareTeam() {
    persist();
    const url = new URL(window.location.href);
    url.searchParams.set("view", "team");
    url.hash = `${SHARE_HASH_KEY}=${encodeBase64Url(JSON.stringify(teamPayload()))}`;
    try {
      status = (await copyText(url.toString())) ? "Team link copied." : "Team link ready to copy.";
    } catch {
      status = "Could not copy the team link.";
    }
    render();
  }

  // A shared link (#t=...) opens as a new local team, then the hash is cleared.
  function loadSharedTeam() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
    const encoded = params.get(SHARE_HASH_KEY);
    if (!encoded) return;
    try {
      const loadout = createLoadout("Shared team", modelFromPayload(JSON.parse(decodeBase64Url(encoded))));
      status = `Opened the shared team as ${loadout.name}.`;
    } catch (error) {
      status = error instanceof Error ? error.message : "This team link is not valid.";
    }
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(window.history.state, "", url);
  }

  function exportLoadout() {
    persist();
    const loadout = activeLoadout();
    const payload = { format: LOADOUT_FILE_FORMAT, version: LOADOUT_FILE_VERSION, name: loadout.name, team: teamPayload() };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${loadout.name.replace(/[^\w.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "team"}.aniiteam`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    status = `Exported ${loadout.name}.`;
    render();
  }

  async function importLoadout(file) {
    if (!file) return;
    try {
      if (file.size > MAX_LOADOUT_FILE_BYTES) throw new Error("That file is too large to be a team file.");
      const payload = JSON.parse(await file.text());
      if (payload?.format !== LOADOUT_FILE_FORMAT || payload?.version !== LOADOUT_FILE_VERSION) {
        throw new Error("That file is not an AniiLogs team file.");
      }
      const loadout = createLoadout(payload.name || "Imported team", modelFromPayload(payload.team));
      status = `Imported ${loadout.name}.`;
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  // --- Data -----------------------------------------------------------------------------------

  function entryForForm(formId) {
    return formId ? aniilog?.entries?.find((entry) => String(entry.form_id) === String(formId)) || null : null;
  }

  function formFor(member) {
    return member?.formId ? data?.forms?.[member.formId] || null : null;
  }

  function skillsOf(form, type) {
    return (form?.skills || []).filter((skill) => skill.type === type);
  }

  function skillFor(form, id) {
    return id ? (form?.skills || []).find((skill) => String(skill.id) === String(id)) || null : null;
  }

  function buff(id) {
    return data?.buffs?.[String(id)] || null;
  }

  function formLabel(entry, form) {
    const name = entry?.name || form?.name || "Aniimo";
    return entry?.form_label ? `${name} · ${entry.form_label}` : name;
  }

  // The "take me there" link to a form's Aniilog page (aniimo-link.js), or null.
  function aniimoLink(formId, entry, form, options) {
    return formId ? window.AniilogsAniimoLink?.create(String(formId), formLabel(entry, form), options) || null : null;
  }

  // Names the Aniimo picker also matches, as [kind, name]: its skills and traits, the effects they apply
  // (a debuff when it lands on an enemy, otherwise a buff) and the skills' tags. Basic attacks are all
  // called "ATK", so only their effects count. An effect named like its own skill or trait is left out.
  function aniimoKeywords(form) {
    const named = new Set();
    const rows = [];
    const add = (kind, name) => {
      if (!name || named.has(name)) return;
      named.add(name);
      rows.push([kind, name]);
    };
    const links = [];
    (form?.skills || []).forEach((skill) => [skill, skill.upgrade].filter(Boolean).forEach((variant) => {
      if (variant.type !== "normal") add(variant.type === "ultimate" ? "Ultimate" : "Skill", variant.name);
      links.push(...(variant.mechanics?.buffs || []));
    }));
    (form?.traits || []).forEach((trait) => {
      add("Trait", trait.name);
      links.push(...(trait.buffs || []).map((id) => ({ id, on: "self" })));
    });
    links.filter((link) => !isInternal(link.id))
      .forEach((link) => add(link.on === "enemy" ? "Debuff" : "Buff", buff(link.id)?.name));
    (form?.skills || []).forEach((skill) => (skill.tags || []).forEach((tag) => add("Tag", tag)));
    return rows;
  }

  function aniimoOptions() {
    // Aniilog order (its entries are already sorted for display).
    const order = new Map((aniilog?.entries || []).map((entry, index) => [String(entry.form_id), index]));
    const rows = Object.keys(data?.forms || {}).map((formId) => ({
      value: formId,
      label: formLabel(entryForForm(formId), data.forms[formId]),
      group: entryForForm(formId)?.surface_label || "",
      // Extra words the picker's filter matches: elements and the Aniilog number.
      search: [...(data.forms[formId].elements || []).map((id) => element(id)?.name),
        entryForForm(formId)?.aniilog_number].filter(Boolean).join(" "),
      keywords: aniimoKeywords(data.forms[formId]),
      sort: order.get(formId) ?? Number.MAX_SAFE_INTEGER,
    }));
    rows.sort((left, right) => left.sort - right.sort);
    return [{ value: "", label: "Empty slot" }, ...rows];
  }

  // Keep a member's choices valid for its Aniimo and the loadout rules.
  function validateMember(member) {
    const form = formFor(member);
    if (!form) {
      Object.assign(member, defaultMember(), { formId: member.formId && data?.forms?.[member.formId] ? member.formId : "" });
      return;
    }
    // The Core skill has its own slot, so it is never one of the two active picks.
    const combat = new Set(skillsOf(form, "skill").filter((skill) => !skill.core).map((skill) => String(skill.id)));
    const seen = new Set();
    member.activeSkills = member.activeSkills.map((id) => {
      if (!combat.has(id) || seen.has(id)) return "";
      seen.add(id);
      return id;
    });
  }

  async function ensureData() {
    if (aniilog && data) return;
    if (!loadPromise) {
      loadPromise = Promise.all([
        host.loadAniilog(),
        fetch(host.dataUrl).then((response) => {
          if (!response.ok) throw new Error(`Team Builder data is unavailable (${response.status}).`);
          return response.json();
        }),
      ]).then(([aniilogPayload, teamPayload]) => {
        // The explorer's Aniilog loader resolves null when it rejects the Aniilog files.
        if (!aniilogPayload?.entries) throw new Error("Aniilog data is unavailable, so the Team Builder can't load.");
        if (!teamPayload?.forms || !teamPayload?.buffs) throw new Error("Team Builder data has an invalid format.");
        aniilog = aniilogPayload;
        data = teamPayload;
        loadError = "";
      }).catch((error) => {
        loadPromise = null;
        loadError = error instanceof Error ? error.message : String(error);
      });
    }
    await loadPromise;
  }

  // --- Formatting -----------------------------------------------------------------------------

  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = text;
    return node;
  }

  function button(text, className, onClick) {
    const node = el("button", className, text);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function icon(path, className) {
    const image = el("img", className);
    image.src = host.contentUrl(path);
    image.alt = "";
    image.loading = "lazy";
    return image;
  }

  function selectControl(labelText, options, value, onChange, className = "") {
    const label = el("label", `team-field ${className}`.trim());
    const select = el("select", "team-select");
    options.forEach((option) => {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      item.disabled = Boolean(option.disabled);
      item.selected = String(option.value) === String(value || "");
      select.append(item);
    });
    select.setAttribute("aria-label", labelText);
    select.addEventListener("change", () => onChange(select.value));
    label.append(el("span", "team-field-label", labelText), select);
    window.AniilogsPicker?.enhance(select, { placeholder: "Type to filter", emptyText: "No matches" });
    return label;
  }

  function formatNumber(value) {
    return String(Math.round(Number(value) * 10000) / 10000);
  }

  function formatValues(key, values) {
    const unique = [...new Set(values || [])];
    if (!unique.length) return "";
    const percent = PERCENT_KEY.test(key);
    return unique.map((value) => (percent ? `${formatNumber(value * 100)}%` : formatNumber(value))).join(" / ");
  }

  // A heading or name with a link after it (when there is one).
  function withLink(node, link) {
    if (link) node.append(link);
    return node;
  }

  function pill(text, modifier = "") {
    return el("span", `team-pill${modifier ? ` team-pill--${modifier}` : ""}`, text);
  }

  // The slot whose skills are picked when the others only support (Interlink, Egg Heist), or null.
  function mainSlot() {
    const main = MODES.find((mode) => mode.id === model.mode)?.main;
    return Number.isInteger(main) ? main : null;
  }

  function slotRole(index) {
    if (model.mode === "interlink") return index === 0 ? "Controlled Aniimo" : `Interlink ally ${index}`;
    const main = mainSlot();
    if (main !== null) return index === main ? "Main Aniimo" : `Support ${index < main ? index + 1 : index}`;
    if (model.mode === "holosim" && index === RESERVE_SLOT) return "Reserve";
    return `Team slot ${index + 1}`;
  }

  // Interlink allies and Egg Heist supports only bring their Core skills; everyone else has their picks plus the
  // Ultimate that comes with the Aniimo.
  function supportOnly(index) {
    const main = mainSlot();
    return main !== null && index !== main;
  }

  function memberSkills(member, index) {
    const form = formFor(member);
    if (!form) return [];
    const coreRow = (skill) => ({ skill, slot: coreEnhanced(member, skill) ? "Core skill · Enhanced" : "Core skill", enhanced: coreEnhanced(member, skill) });
    if (supportOnly(index)) return skillsOf(form, "skill").filter((skill) => skill.core).map(coreRow);
    // Two active skills plus the Core skill, which has its own slot (the switch-skill) and is always there.
    const core = coreSkill(form);
    const rows = member.activeSkills.map((id) => skillFor(form, id)).filter((skill) => skill && skill !== core)
      .map((skill) => ({ skill, slot: "Active" }));
    if (core) rows.push(coreRow(core));
    skillsOf(form, "ultimate").forEach((skill) => rows.push({ skill, slot: "Ultimate" }));
    return rows;
  }

  // The Core skill is enhanced (the game's word; a Prismatic Stone does it) when the player says so and it has an
  // enhanced version.
  function coreEnhanced(member, skill) {
    return Boolean(member?.coreUpgraded && skill?.core && skill.upgrade);
  }

  // Every form has at most one Core skill in the current data.
  function coreSkill(form) {
    return skillsOf(form, "skill").find((skill) => skill.core) || null;
  }

  // --- How a skill works ----------------------------------------------------------------------

  // Unnamed buffs that change no stat are internal states (dodge windows, hit checks).
  function isInternal(id) {
    const detail = buff(id);
    return !detail || (!detail.name && !detail.attributes?.length);
  }

  // Which skills or traits apply each buff, to name unnamed states a condition checks for.
  let appliersIndex = null;
  function appliers(id) {
    if (!appliersIndex) {
      appliersIndex = new Map();
      const add = (buffId, name) => {
        const names = appliersIndex.get(String(buffId)) || new Set();
        names.add(name);
        appliersIndex.set(String(buffId), names);
      };
      Object.values(data?.forms || {}).forEach((form) => {
        form.skills.forEach((skill) => [skill, skill.upgrade].filter(Boolean)
          .forEach((variant) => variant.mechanics?.buffs.forEach((link) => add(link.id, skill.name))));
        form.traits.forEach((trait) => trait.buffs.forEach((id) => add(id, trait.name)));
      });
    }
    return [...(appliersIndex.get(String(id)) || [])];
  }

  const CONDITION_HOLDERS = Object.freeze({ self: "this Aniimo", target: "the target", player: "the player", enemy: "the enemy" });

  // "Only while this Aniimo has Shrouded in Mist" — the buff checks on the path to an effect. A check
  // for an unnamed buff that no skill or trait in the game files applies is shown as a special state.
  function conditionText(requires) {
    if (!requires?.length) return "";
    const unknown = (item) => !buff(item.buff)?.name && !appliers(item.buff).length;
    const known = requires.filter((item) => !unknown(item));
    const special = requires.filter(unknown);
    const parts = known.map((item) => {
      const detail = buff(item.buff);
      const from = appliers(item.buff);
      const name = detail?.name || `the state from ${from.slice(0, 2).join(" / ")}`;
      return `${CONDITION_HOLDERS[item.on] || item.on} ${item.holds ? "has" : "doesn't have"} ${name}`;
    });
    const sentences = [];
    if (parts.length) sentences.push(`Only while ${parts.join(" and ")}.`);
    if (special.some((item) => item.holds)) {
      const ids = special.filter((item) => item.holds).map((item) => item.buff).join(", ");
      sentences.push(`Only in a special state (unnamed buff ${ids}, which no skill in the game files applies).`);
    } else if (special.length) {
      sentences.push("Normal case (without that special state).");
    }
    return sentences.join(" ");
  }

  // The stats of the member whose skills and traits are being drawn (their stat card: level, potential, Star-Up,
  // held item...), so values that scale with a stat show their number for this build. Null outside that.
  let scalingStats = null;

  // The held item a member uses: the one picked, or until then its signature or first recommended item.
  function heldItemOf(member) {
    const items = window.AniilogsHeldItems;
    return items?.chosen ? items.chosen(data, aniilog, member?.formId, member?.heldItem) : member?.heldItem || null;
  }

  // A member's build with that held item filled in, for the stat card, CP and the editors.
  function memberBuild(member) {
    return { ...member, heldItem: heldItemOf(member) };
  }

  function memberCardStats(member) {
    const damage = window.AniilogsDamage;
    const growth = aniilog?.stat_growth;
    if (!damage?.statTotals || !growth || !member?.formId) return null;
    const cap = Number(growth.level_cap) || 70;
    const editor = window.AniilogsPotentialEditor;
    const options = editor ? editor.totalsOptions(memberBuild(member), cap, data) : { level: member.level ?? cap, potential: member.potential ?? 0 };
    return damage.statTotals(data, aniilog, member.formId, options)?.total || null;
  }
  // " At this build's 929 ATK: 33.4%." after a scaling note, or "" without the member's stats.
  function scalingSuffix(note) {
    const result = scalingStats && window.AniilogsDamage?.scalingNote?.(note, scalingStats);
    if (!result) return "";
    const shown = result.value.toFixed(Math.max(result.decimals, result.percent ? 1 : 2));
    return ` At this build's ${Math.round(result.statValue).toLocaleString("en-US")} ${result.stat}: ${shown}${result.percent ? "%" : ""}.`;
  }

  function renderBuffLine(link, fallbackName = "Unnamed effect") {
    const detail = buff(link.id);
    const item = el("li", "team-buff");
    const title = el("div", "team-buff-title");
    title.append(el("strong", "", detail?.name || fallbackName), pill(`On ${WHO_LABELS[link.on] || link.on}`, "scope"));
    const duration = link.duration ?? detail?.duration;
    if (Number(duration) > 0) title.append(pill(`${formatNumber(duration)}s`));
    if (link.stacks) title.append(pill(`${link.stacks} stacks`));
    if (Number(detail?.max_layer) > 1) title.append(pill(`Up to ${detail.max_layer} stacks`));
    if (detail?.carries_over_on_switch) title.append(pill("Carries over on switch", "synergy"));
    item.append(title);
    if (link.requires?.length) item.append(el("p", "team-condition", conditionText(link.requires)));
    if (detail?.description) item.append(el("p", "team-buff-description", detail.description));
    const attributes = (detail?.attributes || []).filter((attribute) => attribute.values?.length || attribute.formula);
    if (attributes.length) {
      const list = el("dl", "team-skill-coefficients");
      attributes.forEach((attribute) => {
        // A value that scales with a stat: its number at this member's stat, beside how it scales.
        const scaled = attribute.scaling && scalingStats && window.AniilogsDamage?.scaledValue
          ? window.AniilogsDamage.scaledValue(attribute.scaling, scalingStats, attribute.scaling.bases?.length || 1) : null;
        const atStat = Number.isFinite(scaled)
          ? `${formatValues(attribute.key, [scaled])} at this build's ${Math.round(scalingStats[attribute.scaling.stat]).toLocaleString("en-US")} ${attribute.scaling.stat}` : "";
        const value = [formatValues(attribute.key, attribute.values), atStat, attribute.formula].filter(Boolean).join(" · ");
        // A row that only applies in a state ("While holding 3 Movements") says so beside its label.
        list.append(el("dt", "", attribute.condition ? `${attribute.label} (${attribute.condition.replace(/^./u, (c) => c.toLowerCase())})` : attribute.label),
          el("dd", "", `${value}${attribute.per_stack ? " per stack" : ""}`));
      });
      item.append(list);
    }
    return item;
  }

  function renderMechanics(skill) {
    const mechanics = skill.mechanics;
    const section = el("div", "team-skill-mechanics");
    if (!mechanics) {
      section.append(el("p", "team-skill-caveat", "No execution record is linked to this skill. The game description is below."));
      return section;
    }
    const tags = el("div", "team-skill-mechanics-tags");
    tags.append(pill(mechanics.team_role, ["Self only", "Not traced"].includes(mechanics.team_role) ? "" : "synergy"));
    mechanics.targets.forEach((target) => tags.append(pill(WHO_LABELS[target] || target, "scope")));
    section.append(tags);
    if (ROLE_NOTES[mechanics.team_role]) section.append(el("p", "team-skill-variant-note", ROLE_NOTES[mechanics.team_role]));

    if (mechanics.operations.length) {
      const operations = el("ul", "team-skill-operations");
      mechanics.operations.forEach((operation) => {
        const row = el("li", "team-skill-operation");
        const value = [formatValues(operation.key, operation.values), ...(operation.formulas || [])].filter(Boolean).join(" · ");
        row.append(
          el("strong", "", operation.label),
          el("span", "", ` → ${WHO_LABELS[operation.on] || operation.on}`),
          el("small", "", [value, operation.count > 1 ? `${operation.count} hits/ticks` : ""].filter(Boolean).join(" · ")),
        );
        if (operation.requires?.length) row.append(el("span", "team-condition", conditionText(operation.requires)));
        operations.append(row);
      });
      section.append(operations);
    }
    const shown = mechanics.buffs.filter((link) => !isInternal(link.id));
    if (shown.length) {
      const buffs = el("ul", "team-buff-list");
      shown.forEach((link) => buffs.append(renderBuffLine(link)));
      section.append(buffs);
    }
    const internal = mechanics.buffs.length - shown.length;
    if (internal) section.append(el("p", "team-skill-caveat", `Also applies ${internal} unnamed internal state${internal === 1 ? "" : "s"} with no stat change.`));
    return section;
  }

  // The Try-Hard Guide's note for a skill or trait when its game text leaves something out (damage-guide.js).
  function guideNote(kind, id, formId) {
    const note = window.AniilogsGuide?.explanationFor?.(kind, id, formId);
    if (!note?.text) return null;
    const line = el("p", "team-guide-note");
    line.append(el("strong", "", "Worth knowing: "), note.text);
    return line;
  }

  function formIdOf(form) {
    return Object.keys(data?.forms || {}).find((id) => data.forms[id] === form) || null;
  }

  function renderSkillCard(skill, slotLabel, formId) {
    const card = el("article", "team-skill-summary");
    if (skill.icon) card.append(icon(skill.icon, "team-skill-icon"));
    const copy = el("div", "team-skill-copy");
    const top = el("div", "team-skill-top");
    top.append(el("strong", "", skill.name), pill(slotLabel));
    copy.append(top);
    const note = guideNote("skill", skill.id, formId);
    if (note) copy.append(note);
    const meta = [
      skill.might !== null ? `Might ${skill.might}` : "",
      Number(skill.ep_cost) > 0 ? `EP ${skill.ep_cost}` : "",
      Number(skill.cooldown) > 0 ? `Cooldown ${formatNumber(skill.cooldown)}s` : "",
      ...(skill.tags || []),
    ].filter(Boolean).join(" · ");
    if (meta) copy.append(el("small", "", meta));
    if (skill.core) copy.append(el("small", "team-skill-behavior", "Core skill"));
    if (skill.unlock_forms?.length) {
      const forms = skill.unlock_forms.map((formId) => formLabel(entryForForm(formId), data.forms[formId])).join(", ");
      copy.append(el("small", "team-skill-behavior", `Unlocks with: ${forms}`));
    }
    const how = el("details", "team-skill-how");
    how.open = true;
    how.append(el("summary", "", "How this skill works"), renderMechanics(skill));
    copy.append(how);
    if (skill.description) {
      const description = el("details", "team-skill-description");
      description.append(el("summary", "", "Game description"), el("p", "", skill.description));
      skill.scaling?.forEach((note) => description.append(el("p", "team-skill-caveat", note + scalingSuffix(note))));
      copy.append(description);
    }
    if (skill.upgrade) copy.append(renderUpgrade(skill, skill.upgrade));
    card.append(copy);
    return card;
  }

  const requiresKey = (requires) => (requires || []).map((item) => `${item.holds ? "+" : "-"}${item.buff}@${item.on}`).sort().join(",");

  // The upgraded Core skill, shown as only what differs from the normal version.
  function renderUpgrade(base, upgrade) {
    const section = el("details", "team-skill-description team-upgrade");
    section.append(el("summary", "", upgrade.name === base.name ? "Enhanced version" : `Enhanced: ${upgrade.name}`));
    const changes = el("ul", "team-upgrade-changes");
    const change = (label, from, to) => {
      const row = el("li");
      row.append(el("strong", "", label), el("span", "team-upgrade-from", String(from)), el("span", "", " → "), el("span", "team-upgrade-to", String(to)));
      changes.append(row);
    };
    [["Might", "might"], ["EP cost", "ep_cost"], ["Cooldown", "cooldown", "s"]].forEach(([label, key, unit = ""]) => {
      if (base[key] !== upgrade[key]) change(label, `${formatNumber(base[key] ?? 0)}${unit}`, `${formatNumber(upgrade[key] ?? 0)}${unit}`);
    });
    const tagsBefore = (base.tags || []).join(", ");
    const tagsAfter = (upgrade.tags || []).join(", ");
    if (tagsBefore !== tagsAfter) change("Tags", tagsBefore || "none", tagsAfter || "none");

    // Effects: compare operations and buffs by what they are, who they land on and when. When the game
    // links no execution record to the upgrade, there is nothing to compare, so make no effect claims.
    const effectsKnown = Boolean(upgrade.mechanics && base.mechanics);
    if (effectsKnown) compareEffects(base, upgrade, change);

    if (changes.childElementCount) section.append(changes);
    const textChanged = Boolean(upgrade.description) && upgrade.description !== base.description;
    if (textChanged) {
      section.append(el("p", "team-upgrade-label", "Enhanced game description"), el("p", "", upgrade.description));
    }
    if (!effectsKnown) {
      section.append(el("p", "team-skill-caveat", "The game data links no effect record to the enhanced version, so only its stats and text are compared."));
    }
    section.append(el("p", "team-skill-variant-note", changes.childElementCount || textChanged
      ? "Everything not listed here is the same as the normal version."
      : "No differences from the normal version were found in the game data."));
    return section;
  }

  function compareEffects(base, upgrade, change) {
    const opKey = (operation) => `${operation.key}|${operation.on}|${requiresKey(operation.requires)}`;
    const opValue = (operation) => [formatValues(operation.key, operation.values), ...(operation.formulas || [])].filter(Boolean).join(" · ") || "runtime value";
    // Rows name their condition; an upgrade effect that only adds "doesn't have X" is compared with the
    // normal version's unconditional one (e.g. Tail Flick Combo's plain hits vs its Elasticity Burst hits).
    const when = (requires) => (requires?.length ? ` (${conditionText(requires).replace(/\.$/u, "").replace(/^Only/u, "only")})` : "");
    const baseOps = new Map((base.mechanics?.operations || []).map((operation) => [opKey(operation), operation]));
    const upgradeOps = new Map((upgrade.mechanics?.operations || []).map((operation) => [opKey(operation), operation]));
    const matchedBase = new Set();
    upgradeOps.forEach((operation, key) => {
      let beforeKey = baseOps.has(key) ? key : null;
      if (!beforeKey && operation.requires?.length && operation.requires.every((item) => !item.holds)) {
        const plain = `${operation.key}|${operation.on}|`;
        if (baseOps.has(plain) && !upgradeOps.has(plain)) beforeKey = plain;
      }
      const before = beforeKey ? baseOps.get(beforeKey) : null;
      if (beforeKey) matchedBase.add(beforeKey);
      const where = `${operation.label} → ${WHO_LABELS[operation.on] || operation.on}${when(operation.requires)}`;
      if (!before) change(where, "not in the normal version", opValue(operation));
      else if (opValue(before) !== opValue(operation) || before.count !== operation.count) {
        change(where, `${opValue(before)} (${before.count}×)`, `${opValue(operation)} (${operation.count}×)`);
      }
    });
    baseOps.forEach((operation, key) => {
      if (!upgradeOps.has(key) && !matchedBase.has(key)) {
        change(`${operation.label} → ${WHO_LABELS[operation.on] || operation.on}${when(operation.requires)}`, opValue(operation), "removed");
      }
    });
    const linkKey = (link) => `${link.id}|${link.on}|${requiresKey(link.requires)}`;
    const linkValue = (link) => [link.duration ? `${formatNumber(link.duration)}s` : "", link.stacks ? `${link.stacks} stacks` : ""].filter(Boolean).join(", ") || "applied";
    const linkName = (link) => `${buff(link.id)?.name || "Unnamed effect"} on ${WHO_LABELS[link.on] || link.on}${when(link.requires)}`;
    const visible = (links) => (links || []).filter((link) => !isInternal(link.id));
    const baseLinks = new Map(visible(base.mechanics?.buffs).map((link) => [linkKey(link), link]));
    const upgradeLinks = new Map(visible(upgrade.mechanics?.buffs).map((link) => [linkKey(link), link]));
    upgradeLinks.forEach((link, key) => {
      const before = baseLinks.get(key);
      if (!before) change(linkName(link), "not in the normal version", linkValue(link));
      else if (linkValue(before) !== linkValue(link)) change(linkName(link), linkValue(before), linkValue(link));
    });
    baseLinks.forEach((link, key) => {
      if (!upgradeLinks.has(key)) change(linkName(link), linkValue(link), "removed");
    });
  }

  // --- Team synergy ---------------------------------------------------------------------------

  // Every buff and ally-side operation the whole battle roster's skills and traits put out, sorted by
  // who it reaches. A Holo-Sim reserve is not in the fight until it is swapped in.
  function synergyEffects() {
    const effects = [];
    battleMembers().forEach(({ member, index, form }) => {
      const source = formLabel(entryForForm(member.formId), form);
      const consider = (origin, kind, links, operations = []) => {
        links.forEach((link) => {
          const detail = buff(link.id);
          if (!detail || isInternal(link.id)) return;
          let reach = "";
          if (["ally", "active Aniimo", "player"].includes(link.on)) reach = link.on === "player" ? "player" : "team";
          else if (link.on === "self") reach = detail.carries_over_on_switch ? "switch" : "self";
          else if (link.on === "enemy" && detail.attributes.length) reach = "enemy";
          if (!reach) return;
          effects.push({ key: `${index}:${kind}:${origin.id}:${link.id}:${link.on}`, slot: index, source, origin: origin.name, kind, link, detail, reach });
        });
        operations.filter((operation) => ["ally", "active Aniimo"].includes(operation.on) && !operation.key.startsWith("instant_"))
          .forEach((operation) => effects.push({
            key: `${index}:${kind}:${origin.id}:op:${operation.key}:${operation.on}`, slot: index, source, origin: origin.name, kind, operation, reach: "team",
          }));
      };
      memberSkills(member, index).forEach(({ skill, slot }) => {
        if (skill.mechanics) consider(skill, slot, skill.mechanics.buffs, skill.mechanics.operations);
      });
      (form.traits || []).forEach((trait) => consider(trait, "Trait", trait.buffs.map((id) => ({ id, on: "self" }))));
    });
    return effects;
  }

  // Shared groups reach more than the Aniimo that made them; "self" stays on its own Aniimo.
  const REACH_GROUPS = Object.freeze([
    { id: "team", label: "Team buffs and heals", shared: true },
    { id: "switch", label: "Carries over when you switch", shared: true },
    { id: "enemy", label: "Enemy debuffs (help whoever hits that enemy)", shared: true },
    { id: "self", label: "Each Aniimo's own buffs", shared: false },
    { id: "player", label: "Player buffs", shared: false },
  ]);

  function renderScenario() {
    const section = el("section", "team-scenario");
    const effects = synergyEffects();
    const enabled = effects.filter((effect) => model.scenario[effect.key]);
    const heading = el("div", "team-section-heading");
    heading.append(el("div", "", "Team synergy"), el("small", "", `${enabled.length} of ${effects.length} on`));
    section.append(heading);
    const roster = battleMembers();
    section.append(el("p", "team-section-copy", roster.length
      ? `Every effect your ${model.mode === "holosim" ? "four Aniimo in battle" : "team"} puts out from its picked skills, Ultimates and traits. Switch on the ones active in the fight you want to model.`
      : "Add Aniimo to your team to see the effects they share."));
    if (roster.length) {
      const counts = el("div", "team-type-quick");
      roster.forEach(({ member, index, form }) => {
        const count = effects.filter((effect) => effect.slot === index).length;
        counts.append(el("span", "team-pill team-pill--scope", `${entryForForm(member.formId)?.name || form.name}: ${count}`));
      });
      section.append(counts);
    }
    if (model.mode === "holosim" && formFor(model.members[RESERVE_SLOT])) {
      section.append(el("p", "team-data-note", "The reserve's effects aren't counted until you swap it into the team."));
    }
    if (roster.length && !effects.length) section.append(el("p", "team-empty-copy", "No shared effects from the current picks."));
    REACH_GROUPS.forEach((group) => {
      const rows = effects.filter((effect) => effect.reach === group.id);
      if (!rows.length) return;
      section.append(el("div", "team-subsection-heading", group.label));
      const list = el("div", "team-synergy-list");
      rows.forEach((effect) => list.append(renderSynergyCard(effect)));
      section.append(list);
    });
    if (enabled.length) section.append(renderEnabledTotals(enabled));
    if (data?.build) section.append(el("p", "team-data-note", `Effects traced from game build ${data.build}. Values are the game's configured inputs, not final damage.`));
    return section;
  }

  function renderSynergyCard(effect) {
    const label = el("label", "team-synergy-card");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(model.scenario[effect.key]);
    if (input.checked) label.classList.add("is-enabled");
    input.addEventListener("change", () => {
      model.scenario[effect.key] = input.checked;
      persist();
      render();
    });
    const copy = el("span", "team-synergy-copy");
    const title = el("span", "team-synergy-title");
    title.append(
      el("strong", "", effect.detail?.name || (effect.kind === "Trait" ? `${effect.origin} effect` : effect.operation?.label || "Unnamed effect")),
      el("small", "", `${effect.source} · ${effect.origin}`),
    );
    copy.append(title);
    if (effect.detail) {
      const facts = [effect.link.on === "self" ? `On ${effect.source}` : `On ${WHO_LABELS[effect.link.on] || effect.link.on}`];
      const duration = effect.link.duration ?? effect.detail.duration;
      if (Number(duration) > 0) facts.push(`${formatNumber(duration)}s`);
      if (effect.detail.carries_over_on_switch) facts.push("Carries over on switch");
      copy.append(el("span", "team-synergy-scope", facts.join(" · ")));
      if (effect.link.requires?.length) copy.append(el("span", "team-condition", conditionText(effect.link.requires)));
      if (effect.detail.description) copy.append(el("span", "team-synergy-description", effect.detail.description));
      const values = effect.detail.attributes.filter((attribute) => attribute.values?.length)
        .map((attribute) => `${attribute.label} ${formatValues(attribute.key, attribute.values)}${attribute.per_stack ? " per stack" : ""}`);
      if (values.length) copy.append(el("span", "team-synergy-note", values.join(" · ")));
    } else {
      const value = [formatValues(effect.operation.key, effect.operation.values), ...(effect.operation.formulas || [])].filter(Boolean).join(" · ");
      copy.append(el("span", "team-synergy-scope", `On ${WHO_LABELS[effect.operation.on] || effect.operation.on}`));
      if (effect.operation.requires?.length) copy.append(el("span", "team-condition", conditionText(effect.operation.requires)));
      if (value) copy.append(el("span", "team-synergy-note", value));
    }
    label.append(input, copy);
    return label;
  }

  // Sum of switched-on configured values per game attribute (first level, one stack). Shared effects
  // are added together; each Aniimo's own buffs are added per Aniimo, since they only reach it.
  function sumAttributes(effects) {
    const totals = new Map();
    effects.forEach((effect) => {
      (effect.detail?.attributes || []).forEach((attribute) => {
        const value = Number(attribute.values?.[0]);
        if (!Number.isFinite(value)) return;
        const current = totals.get(attribute.key) || { label: attribute.label, key: attribute.key, value: 0, perStack: false };
        current.value += value;
        current.perStack ||= Boolean(attribute.per_stack);
        totals.set(attribute.key, current);
      });
    });
    return totals;
  }

  function totalsList(totals) {
    const list = el("dl", "team-skill-coefficients");
    totals.forEach((total) => list.append(
      el("dt", "", total.label),
      el("dd", "", `${formatValues(total.key, [total.value])}${total.perStack ? " (one stack each)" : ""}`),
    ));
    return list;
  }

  function renderEnabledTotals(enabled) {
    const section = el("div", "team-damage-preview");
    section.append(el("p", "team-eyebrow", "Switched-on modifiers"));
    const shared = REACH_GROUPS.filter((group) => group.shared).map((group) => group.id);
    const sharedTotals = sumAttributes(enabled.filter((effect) => shared.includes(effect.reach)));
    const groups = [];
    if (sharedTotals.size) groups.push(["Shared by the team", sharedTotals]);
    battleMembers().forEach(({ member, index, form }) => {
      const own = sumAttributes(enabled.filter((effect) => effect.reach === "self" && effect.slot === index));
      if (own.size) groups.push([`${entryForForm(member.formId)?.name || form.name} only`, own]);
    });
    if (!groups.length) {
      section.append(el("p", "", "The switched-on effects have no configured stat values (heals and timed effects are listed above)."));
      return section;
    }
    groups.forEach(([label, totals]) => section.append(el("div", "team-subsection-heading", label), totalsList(totals)));
    section.append(el("p", "", "Added up per stat as configured; whether they stack in combat is up to the game."));
    return section;
  }

  // --- Layout ---------------------------------------------------------------------------------

  // PvE or PvP: the 1v1 page counts as PvP; otherwise the team's mode decides.
  function currentGroup() {
    if (viewState.page === DUEL_TAB[0]) return "pvp";
    return MODES.find((mode) => mode.id === model.mode)?.group || "pve";
  }

  function selectMode(id) {
    model.mode = id;
    model.activeSlot = Math.min(model.activeSlot, slotCount() - 1);
    persist();
    viewState[MODES.find((mode) => mode.id === id)?.group === "pvp" ? "lastPvp" : "lastPve"] = id;
    if (viewState.page !== "team") {
      goToPage("team");
      return;
    }
    saveViewState();
    render();
  }

  function openDuel() {
    viewState.lastPvp = DUEL_TAB[0];
    goToPage(DUEL_TAB[0]);
  }

  // PvE / PvP, back to the tab last open there (1v1 first in PvP, Standard in PvE).
  function renderGroupSwitch() {
    const group = el("div", "team-mode-switch team-group-switch");
    group.setAttribute("role", "tablist");
    MODE_GROUPS.forEach(({ id, label }) => {
      const control = button(label, "team-mode-button", () => {
        if (currentGroup() === id) return;
        const last = MODES.find((mode) => mode.group === id && mode.id === viewState[id === "pvp" ? "lastPvp" : "lastPve"]);
        if (last) selectMode(last.id);
        else if (id === "pvp") openDuel();
        else selectMode("standard");
      });
      control.setAttribute("role", "tab");
      control.setAttribute("aria-selected", String(currentGroup() === id));
      group.append(control);
    });
    return group;
  }

  // The tabs of the open group: PvE's team setups, or PvP's 1v1 and team setups.
  function renderModeSwitch(compact = false) {
    const group = el("div", compact ? "team-mode-switch team-mode-switch--compact" : "team-mode-switch");
    group.setAttribute("role", "tablist");
    const open = currentGroup();
    if (open === "pvp") {
      const duel = button(DUEL_TAB[1], "team-mode-button", openDuel);
      duel.setAttribute("role", "tab");
      duel.setAttribute("aria-selected", String(viewState.page === DUEL_TAB[0]));
      group.append(duel);
    }
    MODES.filter((mode) => mode.group === open).forEach((mode) => {
      const control = button(mode.label, "team-mode-button", () => selectMode(mode.id));
      control.setAttribute("role", "tab");
      control.setAttribute("aria-selected", String(viewState.page === "team" && model.mode === mode.id));
      group.append(control);
    });
    return group;
  }

  function renderSidebarSlot(member, index) {
    const form = formFor(member);
    const entry = entryForForm(member.formId);
    const card = el("article", "team-sidebar-slot");
    if (model.activeSlot === index) card.classList.add("is-active");
    if (index === RESERVE_SLOT) card.classList.add("team-slot--reserve");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-pressed", String(model.activeSlot === index));
    const activate = () => {
      model.activeSlot = index;
      persist();
      render();
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate();
    });
    const header = el("div", "team-sidebar-slot-header");
    header.append(el("span", "team-sidebar-slot-role", slotRole(index)));
    const slotLink = form ? aniimoLink(member.formId, entry, form) : null;
    const headerActions = el("div", "team-sidebar-slot-actions");
    if (slotLink) headerActions.append(slotLink);
    if (form) {
      const name = entry?.name || form.name;
      const remove = button("Remove", "team-slot-remove", (event) => {
        event.stopPropagation();
        removeFromTeam(index);
      });
      remove.setAttribute("aria-label", `Remove ${name} from ${slotRole(index).toLocaleLowerCase()}`);
      remove.addEventListener("keydown", (event) => event.stopPropagation());
      headerActions.append(remove);
    }
    if (headerActions.childElementCount) header.append(headerActions);
    const identity = el("div", "team-sidebar-slot-identity");
    if (entry?.icon) identity.append(icon(entry.icon, "team-sidebar-slot-icon"));
    else identity.append(el("span", "team-sidebar-slot-icon team-sidebar-slot-icon--empty", String(index + 1)));
    const copy = el("div", "team-sidebar-slot-copy");
    copy.append(
      el("strong", "", form ? entry?.name || form.name : "Empty slot"),
      el("small", "", form ? entry?.form_label || "" : "Choose an Aniimo below"),
    );
    identity.append(copy);
    const select = el("select", "team-sidebar-select");
    // One group per Aniilog region (Breezy Plains, Whisperwake Isles, ...), in Aniilog order.
    const groups = new Map();
    aniimoOptions().forEach((option) => {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      if (option.search) item.dataset.search = option.search;
      if (option.keywords?.length) item.dataset.keywords = JSON.stringify(option.keywords);
      if (option.value) item.dataset.aniimoLink = option.value;
      item.selected = option.value === member.formId;
      if (!option.group) {
        select.append(item);
        return;
      }
      if (!groups.has(option.group)) {
        const group = document.createElement("optgroup");
        group.label = option.group;
        groups.set(option.group, group);
        select.append(group);
      }
      groups.get(option.group).append(item);
    });
    select.setAttribute("aria-label", slotRole(index));
    select.addEventListener("click", (event) => event.stopPropagation());
    select.addEventListener("keydown", (event) => event.stopPropagation());
    select.addEventListener("change", (event) => {
      event.stopPropagation();
      model.members[index] = { ...defaultMember(), formId: select.value };
      model.activeSlot = index;
      persist();
      render();
    });
    // Type-to-filter on top of the select (aniimo-picker.js); the select still drives the change.
    const picker = window.AniilogsPicker?.enhance(select, { placeholder: "Name, element, skill, trait or effect", emptyText: "No Aniimo match" });
    if (picker) {
      picker.wrap.addEventListener("click", (event) => event.stopPropagation());
      picker.wrap.addEventListener("keydown", (event) => event.stopPropagation());
    }
    card.append(header, identity, picker ? picker.wrap : select);
    return card;
  }

  function renderLoadoutControls() {
    const section = el("section", "team-loadout-controls");
    const field = el("label", "team-loadout-field");
    field.append(el("span", "team-loadout-label", "Saved team"));
    const selector = el("select", "team-select team-loadout-select");
    store.loadouts.forEach((loadout) => {
      const option = document.createElement("option");
      option.value = loadout.id;
      option.textContent = loadout.name;
      option.selected = loadout.id === store.activeId;
      selector.append(option);
    });
    const newOption = document.createElement("option");
    newOption.value = "__new__";
    newOption.textContent = "+ New team…";
    selector.append(newOption);
    selector.addEventListener("change", () => {
      if (selector.value === "__new__") {
        runAction(() => {
          const loadout = createLoadout(`Team ${store.loadouts.length + 1}`);
          status = `${loadout.name} created. Changes save automatically in this browser.`;
        });
        return;
      }
      switchLoadout(selector.value);
    });
    selector.setAttribute("aria-label", "Saved team");
    field.append(selector);
    window.AniilogsPicker?.enhance(selector, {
      placeholder: "Type a team name",
      emptyText: "No team matches",
      rename: { label: "Rename", applies: (option) => option.value !== "__new__", onRename: renameLoadout },
    });
    const fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = ".aniiteam,application/json";
    fileInput.hidden = true;
    fileInput.addEventListener("change", async () => {
      const [file] = fileInput.files || [];
      fileInput.value = "";
      await importLoadout(file);
    });
    const actions = el("div", "team-loadout-actions");
    actions.append(
      button("Import", "team-loadout-action", () => fileInput.click()),
      button("Export", "team-loadout-action", exportLoadout),
      button("Delete", "team-loadout-action", deleteLoadout),
    );
    section.append(field, fileInput, actions);
    return section;
  }

  function renderSidebar() {
    const sidebar = host.sidebar;
    sidebar.textContent = "";
    const heading = el("div", "team-sidebar-heading");
    // The page title (Team Builder) and the mode switch are in the main panel's header; the sidebar is the team.
    heading.append(el("h2", "", "Your team"), button("Clear", "team-clear-button", () => {
      if (!window.confirm("Clear every slot in this team?")) return;
      model = defaultModel();
      persist();
      render();
    }));
    sidebar.append(heading, renderLoadoutControls());
    const slots = el("div", "team-sidebar-slots");
    slotIndexes().forEach((index) => slots.append(renderSidebarSlot(model.members[index], index)));
    const shareWrap = el("div", "team-share-wrap");
    const shareRow = el("div", "team-share-actions");
    shareRow.append(button("Copy team link", "team-share-button", shareTeam), renderCardButton());
    shareWrap.append(shareRow);
    if (status) shareWrap.append(el("p", "team-share-status", status));
    sidebar.append(slots, shareWrap);
  }

  function renderOverview() {
    const section = el("section", "team-overview");
    const heading = el("div", "team-section-heading");
    heading.append(el("div", "", "Team overview"), el("small", "", {
      interlink: "1 controlled + 3 Core allies",
      eggheist: "1 main (slot 2) + 3 Core supports",
      eggheistpvp: "1 main (slot 2) + 3 Core supports",
      holosim: "4 in battle + 1 reserve",
    }[model.mode] || "Up to 4 Aniimo"));
    const grid = el("div", "team-overview-grid");
    slotIndexes().forEach((index) => {
      const member = model.members[index];
      const form = formFor(member);
      const entry = entryForForm(member.formId);
      const card = button("", "team-overview-card", () => {
        model.activeSlot = index;
        persist();
        render();
      });
      if (model.activeSlot === index) card.classList.add("is-active");
      if (index === RESERVE_SLOT) card.classList.add("team-slot--reserve");
      if (entry?.icon) card.append(icon(entry.icon, "team-overview-icon"));
      else card.append(el("span", "team-overview-icon team-overview-icon--empty", "+"));
      const copy = el("span", "team-overview-copy");
      copy.append(
        el("small", "", slotRole(index)),
        el("strong", "", form ? entry?.name || form.name : "Empty slot"),
        el("span", "", form ? entry?.form_label || "" : "Select a team member"),
      );
      card.append(copy);
      // The card picks the slot; the link in its corner opens the Aniimo's page.
      const slotCard = form && window.AniilogsAniimoLink ? window.AniilogsAniimoLink.wrapCorner(card, member.formId, formLabel(entry, form)) : card;
      if (!form) {
        grid.append(slotCard);
        return;
      }
      // Remove sits beside the card (a button can't hold another button), in its bottom corner.
      const holder = el("div", "team-overview-slot");
      const remove = button("Remove", "team-slot-remove", () => removeFromTeam(index));
      remove.setAttribute("aria-label", `Remove ${entry?.name || form.name} from ${slotRole(index).toLocaleLowerCase()}`);
      holder.append(slotCard, remove);
      grid.append(holder);
    });
    section.append(heading, renderPartners(), grid);
    return section;
  }

  function renderSkillLoadout(member, form, index) {
    const section = el("section", "team-config-section");
    const heading = el("div", "team-section-heading");
    const allyOnly = supportOnly(index);
    heading.append(el("div", "", allyOnly ? "Core skills brought to the team" : "Skill loadout"));
    section.append(heading);
    if (!allyOnly) section.append(el("p", "team-skill-variant-note", "Skills are picked on the Build tab."));
    const chosen = memberSkills(member, index);
    if (!chosen.length) {
      section.append(el("p", "team-empty-copy", allyOnly ? "This Aniimo has no Core skill." : "Choose skills on the Build tab to see how they work."));
    } else {
      const cards = el("div", "team-skill-cards");
      chosen.forEach(({ skill, slot }) => cards.append(renderSkillCard(skill, slot, member.formId)));
      section.append(cards);
    }
    const normal = skillsOf(form, "normal")[0];
    if (normal && !allyOnly) {
      const details = el("details", "team-skill-description");
      details.append(el("summary", "", `Normal attack: ${normal.name}`), renderMechanics(normal));
      section.append(details);
    }
    return section;
  }

  function renderTraits(form) {
    const section = el("section", "team-config-section");
    const heading = el("div", "team-section-heading");
    heading.append(el("div", "", "Trait"), el("small", "", "Always active"));
    section.append(heading);
    if (!form.traits?.length) {
      section.append(el("p", "team-empty-copy", "No trait in the current data."));
      return section;
    }
    form.traits.forEach((trait) => {
      const card = el("article", "team-skill-summary");
      if (trait.icon) card.append(icon(trait.icon, "team-skill-icon"));
      const copy = el("div", "team-skill-copy");
      copy.append(el("div", "team-skill-top"));
      copy.firstChild.append(el("strong", "", trait.name || "Trait"), pill("Trait"));
      const traitNote = guideNote("trait", trait.id, formIdOf(form));
      if (traitNote) copy.append(traitNote);
      if (trait.description) copy.append(el("small", "", trait.description));
      if (trait.buffs.length) {
        const list = el("ul", "team-buff-list");
        trait.buffs.forEach((id) => list.append(renderBuffLine({ id, on: "self" }, `${trait.name || "Trait"} effect`)));
        copy.append(list);
      }
      card.append(copy);
      section.append(card);
    });
    return section;
  }

  // Holo-Sim: the reserve and a battle slot trade places, skills and all.
  function swapWithReserve(slot) {
    const reserve = model.members[RESERVE_SLOT];
    model.members[RESERVE_SLOT] = model.members[slot];
    model.members[slot] = reserve;
    model.activeSlot = slot;
    const name = formFor(reserve) ? entryForForm(reserve.formId)?.name || formFor(reserve).name : "Reserve";
    status = `${name} swapped into team slot ${slot + 1}.`;
    persist();
    render();
  }

  function renderSwapBar(index) {
    const reserve = model.members[RESERVE_SLOT];
    const bar = el("section", "team-swap-bar");
    if (index === RESERVE_SLOT) {
      bar.append(el("span", "team-field-label", "Swap in for"));
      for (let slot = 0; slot < TEAM_SIZE; slot += 1) {
        const member = model.members[slot];
        const name = formFor(member) ? entryForForm(member.formId)?.name || formFor(member).name : "empty";
        bar.append(button(`Slot ${slot + 1} · ${name}`, "team-loadout-action", () => swapWithReserve(slot)));
      }
      bar.append(el("p", "team-skill-variant-note", "In the Holo-Battle Simulator the reserve can be swapped in and out any time outside a battle."));
      return bar;
    }
    if (!formFor(reserve)) return null;
    const name = entryForForm(reserve.formId)?.name || formFor(reserve).name;
    bar.append(button(`Swap with reserve (${name})`, "team-loadout-action", () => swapWithReserve(index)));
    return bar;
  }

  function renderMember(member, index) {
    const form = formFor(member);
    if (!form) {
      const empty = el("section", "team-builder-empty");
      empty.append(el("strong", "", "Choose an Aniimo for this slot"), el("p", "", "Use the team slots on the left to pick a team member."));
      return empty;
    }
    const entry = entryForForm(member.formId);
    const wrapper = el("div", "team-member-configuration");
    const identity = el("section", "team-member-identity team-member-identity--simple");
    if (entry?.icon) identity.append(icon(entry.icon, "team-member-icon"));
    const copy = el("div", "team-member-copy");
    copy.append(
      el("p", "team-eyebrow", slotRole(index)),
      withLink(el("h2", "", entry?.name || form.name), aniimoLink(member.formId, entry, form)),
      el("p", "team-member-meta", [entry?.form_label, entry?.role].filter((part) => typeof part === "string" && part).join(" · ")),
    );
    if (form.elements?.length) {
      const chips = el("div", "team-type-chips");
      form.elements.forEach((id) => chips.append(elementChip(id)));
      chips.append(button("Type matchups →", "team-type-link", () => openTypes(form.elements)));
      copy.append(chips);
    }
    identity.append(copy);
    wrapper.append(identity);
    if (model.mode === "holosim") {
      const swap = renderSwapBar(index);
      if (swap) wrapper.append(swap);
    }
    const tab = memberTab();
    const body = el("div", "team-member-tab-panel");
    body.setAttribute("role", "tabpanel");
    if (tab === "build") body.append(renderBuild(member, form, entry, index));
    else if (tab === "recommended") body.append(renderRecommended(member, form, entry));
    else {
      scalingStats = memberCardStats(member);
      try { body.append(renderSkillLoadout(member, form, index), renderTraits(form)); } finally { scalingStats = null; }
    }
    wrapper.append(renderMemberTabs(), body);
    return wrapper;
  }

  // The selected Aniimo's setup beside the whole roster's synergy, which stays visible whichever
  // slot is selected.
  function renderTeamPage() {
    const columns = el("div", "team-builder-columns");
    const main = el("div", "team-builder-main-column");
    main.append(renderMember(model.members[model.activeSlot], model.activeSlot));
    columns.append(main, renderScenario());
    return columns;
  }

  // --- Recommended partners, build and stats ---------------------------------------------------
  // From pet_data's recommend* fields (team_builder_data.json `recommended`), the Aniilog's stat_growth
  // through duel.js's grownStat, and pet_talent_data personality traits (`personality`).

  // Build: everything the player chooses (skills, level, personality, potential, Star-Up, held item, Aniilog) and
  // the card it makes. Skills: how each chosen skill works. Recommended: the game's suggestions and reference.
  const MEMBER_TABS = Object.freeze([
    { id: "build", label: "Build" },
    { id: "skills", label: "Skills" },
    { id: "recommended", label: "Recommended" },
  ]);
  let developerOverlay = null;

  function developerMode() {
    return typeof window.developerModeEnabled === "function" && window.developerModeEnabled();
  }

  // Developer Mode adds unreleased partners and held items from dev-content/team-builder/overlay.json.
  function requestDeveloperOverlay() {
    if (!developerMode() || typeof window.loadDeveloperOverlay !== "function") {
      developerOverlay = null;
      return;
    }
    void window.loadDeveloperOverlay("team-builder").then((overlay) => {
      if (overlay === developerOverlay) return;
      developerOverlay = overlay;
      render();
    });
  }

  function developerAdditions(formId, field) {
    if (!developerOverlay || !developerMode()) return [];
    return developerOverlay.records
      .filter((record) => record.op === "patch" && record.target === "forms" && String(record.match?.form_id) === String(formId))
      .flatMap((record) => (Array.isArray(record.append?.[field]) ? record.append[field] : [])
        .map((value) => ({ ...value, availability: record.availability, availability_note: record.availability_note || "" })));
  }

  function availabilityBadge(item) {
    return typeof window.developerAvailabilityBadge === "function"
      ? window.developerAvailabilityBadge(item.availability, item.availability_note)
      : null;
  }

  function percentText(value) {
    return `${formatNumber(value * 100)}%`;
  }

  function sectionHeading(title, note = "") {
    const heading = el("div", "team-section-heading");
    heading.append(el("div", "", title));
    if (note) heading.append(el("small", "", note));
    return heading;
  }

  // Partners the game recommends for anyone in the slots, minus Aniimo already on the team.
  function recommendedPartners() {
    const onTeam = new Set(model.members.map((member) => member.formId).filter(Boolean));
    const partners = new Map();
    slotIndexes().forEach((index) => {
      const member = model.members[index];
      const form = formFor(member);
      if (!form) return;
      const by = entryForForm(member.formId)?.name || form.name;
      const add = (formId, unreleased = null) => {
        const key = String(formId);
        if (onTeam.has(key)) return;
        if (!partners.has(key)) partners.set(key, { formId: key, unreleased, by: [] });
        const row = partners.get(key);
        if (!row.by.includes(by)) row.by.push(by);
      };
      (form.recommended?.partners || []).forEach((formId) => add(formId));
      developerAdditions(member.formId, "recommended_partners").forEach((partner) => add(partner.form_id, partner));
    });
    return [...partners.values()];
  }

  // Add to team while a slot is free; when the team is full, Replace opens a list of the team's Aniimo to swap out.
  function renderAddControl(formId) {
    if (slotIndexes().some((index) => model.members[index].formId === formId)) {
      const inTeam = button("In team", "team-loadout-action team-partners-add");
      inTeam.disabled = true;
      return inTeam;
    }
    const empty = slotIndexes().find((index) => !model.members[index].formId);
    if (empty !== undefined) return button("Add to team", "team-loadout-action team-partners-add", () => addToTeam(formId));
    const menu = el("details", "team-replace-menu");
    menu.append(el("summary", "team-loadout-action team-partners-add", "Replace"));
    const list = el("div", "team-replace-list");
    slotIndexes().forEach((index) => {
      const member = model.members[index];
      const entry = entryForForm(member.formId);
      const option = button("", "team-replace-option", () => addToTeam(formId, index));
      if (entry?.icon) option.append(icon(entry.icon, "team-replace-icon"));
      const copy = el("span", "team-replace-copy");
      copy.append(el("strong", "", entry?.name || formFor(member)?.name || "Empty"), el("small", "", slotRole(index)));
      option.append(copy);
      list.append(option);
    });
    menu.append(list);
    // One list open at a time; it closes when you tap anywhere else.
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      document.querySelectorAll(".team-replace-menu[open]").forEach((other) => { if (other !== menu) other.open = false; });
      const close = (event) => {
        if (menu.contains(event.target)) return;
        menu.open = false;
        document.removeEventListener("pointerdown", close, true);
      };
      document.addEventListener("pointerdown", close, true);
    });
    return menu;
  }

  function renderPartnerChip(partner) {
    const extra = partner.unreleased;
    const entry = extra ? null : entryForForm(partner.formId);
    const form = extra ? null : data.forms[partner.formId];
    const chip = el("article", "team-partners-chip");
    if (entry?.icon) chip.append(icon(entry.icon, "team-partners-icon"));
    else chip.append(el("span", "team-partners-icon team-partners-icon--empty", "?"));
    const copy = el("div", "team-partners-copy");
    const name = el("strong", "", extra ? extra.name : formLabel(entry, form));
    if (!extra) withLink(name, aniimoLink(partner.formId, entry, form));
    if (extra) {
      const badge = availabilityBadge(extra);
      if (badge) name.append(" ", badge);
      if (extra.name_source) chip.title = `Name from ${extra.name_source}`;
    }
    const elements = extra ? extra.elements || [] : form?.elements || [];
    copy.append(name);
    if (elements.length) copy.append(chipRow(elements));
    copy.append(el("small", "", `Recommended for ${partner.by.join(", ")}`));
    chip.append(copy);
    if (!extra) chip.append(renderAddControl(partner.formId));
    return chip;
  }

  function renderPartners() {
    const strip = el("section", "team-partners");
    const full = !slotIndexes().some((index) => !model.members[index].formId);
    strip.append(sectionHeading("Recommended partners", full
      ? "The team is full: Replace swaps one in for an Aniimo you pick"
      : "The game’s suggested teammates for this team"));
    const partners = recommendedPartners();
    if (!partners.length) {
      const anyone = slotIndexes().some((index) => formFor(model.members[index]));
      strip.append(el("p", "team-empty-copy", anyone
        ? "Every partner the game recommends for this team is already on it."
        : "Add an Aniimo to see the partners the game recommends for it."));
      return strip;
    }
    const row = el("div", "team-partners-row");
    partners.forEach((partner) => row.append(renderPartnerChip(partner)));
    strip.append(row);
    return strip;
  }

  function memberTab() {
    return MEMBER_TABS.some((tab) => tab.id === viewState.memberTab) ? viewState.memberTab : "build";
  }

  function renderMemberTabs() {
    const tabs = el("div", "team-member-tabs");
    tabs.setAttribute("role", "tablist");
    MEMBER_TABS.forEach((tab) => {
      const node = button(tab.label, "team-member-tab", () => {
        viewState.memberTab = tab.id;
        saveViewState();
        render();
      });
      node.setAttribute("role", "tab");
      node.setAttribute("aria-selected", String(memberTab() === tab.id));
      if (memberTab() === tab.id) node.classList.add("is-active");
      tabs.append(node);
    });
    return tabs;
  }

  function renderHeldItem(item) {
    const card = el("article", "team-build-item");
    if (item.icon) card.append(icon(item.icon, "team-build-icon"));
    const copy = el("div", "team-build-copy");
    const name = el("strong", "", item.name || "Held item");
    if (item.availability) {
      const badge = availabilityBadge(item);
      if (badge) name.append(" ", badge);
    }
    const tiers = el("ul", "team-build-tiers");
    (item.tiers || []).forEach((tier) => {
      const stats = (tier.stats || []).map((stat) => `${stat.label || `Stat ${stat.stat}`} +${percentText(stat.value)}`).join(", ");
      tiers.append(el("li", "", `${tier.quality_label || `Quality ${tier.quality}`}: ${stats || "no base stat"}`));
    });
    copy.append(name, tiers);
    card.append(copy);
    return card;
  }

  function renderRecommended(member, form, entry) {
    const recommended = form.recommended || {};
    const wrap = el("div", "team-build");
    const items = el("section", "team-config-section");
    items.append(sectionHeading("Recommended held items", "Base stat at each quality"));
    const heldItems = [...(recommended.held_items || []), ...developerAdditions(member.formId, "held_items")];
    if (!heldItems.length) items.append(el("p", "team-empty-copy", "The game recommends no held items for this Aniimo."));
    heldItems.forEach((item) => items.append(renderHeldItem(item)));
    items.append(el("p", "team-data-note", "Base stats come from the game’s held-item table. Each item’s extra effects (its buff and energy bonuses) aren’t traced yet, so they aren’t listed. The game data also names recommended gems, but nothing in the game reads them, so they aren’t shown."));

    const presets = el("section", "team-config-section");
    presets.append(sectionHeading("Attribute point presets", "The game’s recommended splits"));
    const rows = recommended.attribute_presets || [];
    if (!rows.length) presets.append(el("p", "team-empty-copy", "The game has no attribute presets for this Aniimo."));
    rows.forEach((preset) => {
      const card = el("article", "team-build-preset");
      const top = el("div", "team-skill-top");
      top.append(el("strong", "", preset.title || "Preset"));
      if (preset.default) top.append(pill("Default"));
      if (preset.percent !== null && preset.percent !== undefined) top.append(el("span", "team-build-percent", `${preset.percent}%`));
      card.append(top);
      if (preset.summary) card.append(el("p", "", preset.summary));
      if (preset.allocation) card.append(el("small", "", preset.allocation));
      presets.append(card);
    });
    if (rows.length) presets.append(el("p", "team-data-note", "The percentage is the one the game shows on each preset."));
    wrap.append(items, presets, renderPersonality(entry));
    return wrap;
  }

  // --- Build tab: every choice the player makes for this Aniimo, and the card it gives -------------

  // A skill as one line: icon, name, what slot it fills, and its numbers.
  function compactSkill(skill, slotLabel) {
    const card = el("article", "team-build-skill");
    if (skill.icon) card.append(icon(skill.icon, "team-skill-icon"));
    const copy = el("div", "team-skill-copy");
    const top = el("div", "team-skill-top");
    top.append(el("strong", "", skill.name), pill(slotLabel));
    copy.append(top);
    const meta = [
      skill.might !== null && skill.might !== undefined ? `Might ${skill.might}` : "",
      Number(skill.ep_cost) > 0 ? `EP ${skill.ep_cost}` : "",
      Number(skill.cooldown) > 0 ? `Cooldown ${formatNumber(skill.cooldown)}s` : "",
      ...(skill.tags || []),
    ].filter(Boolean).join(" · ");
    if (meta) copy.append(el("small", "", meta));
    card.append(copy);
    return card;
  }

  // The two active picks and the Core skill, then the Ultimate in its own part underneath.
  function renderSkillPicks(member, form, index) {
    const section = el("section", "team-config-section");
    if (supportOnly(index)) {
      section.append(sectionHeading("Skills", `${model.mode === "interlink" ? "Interlink allies" : "Supports"} bring their Core skill`));
      const core = coreSkill(form);
      section.append(core ? compactSkill(core, coreEnhanced(member, core) ? "Core skill · Enhanced" : "Core skill") : el("p", "team-empty-copy", "This Aniimo has no Core skill."));
      const toggle = renderCoreEnhanced(member, core);
      if (toggle) section.append(toggle);
      return section;
    }
    section.append(sectionHeading("Skills", "Two active skills, plus the Core skill"));
    const skills = skillsOf(form, "skill").filter((skill) => !skill.core);
    const grid = el("div", "team-field-grid");
    for (let position = 0; position < MAX_ACTIVE_SKILLS; position += 1) {
      const other = member.activeSkills[position === 0 ? 1 : 0];
      const options = [{ value: "", label: "Choose a skill" }, ...skills.map((skill) => ({
        value: String(skill.id),
        label: skill.name,
        disabled: other === String(skill.id),
      }))];
      grid.append(selectControl(`Active skill ${position + 1}`, options, member.activeSkills[position], (value) => {
        member.activeSkills[position] = value;
        validateMember(member);
        persist();
        render();
      }));
    }
    section.append(grid);
    const picks = el("div", "team-build-skills");
    memberSkills(member, index).filter(({ slot }) => slot !== "Ultimate")
      .forEach(({ skill, slot }) => picks.append(compactSkill(skill, slot)));
    if (picks.childElementCount) section.append(picks);
    const core = coreSkill(form);
    const toggle = renderCoreEnhanced(member, core);
    if (toggle) section.append(toggle);
    section.append(el("p", "team-skill-variant-note", core
      ? `Core skill: ${core.name}, in its own slot (the switch-skill) on top of the two active skills.`
      : "This Aniimo has no Core skill, so no switch-skill."));

    const ultimate = skillsOf(form, "ultimate")[0];
    section.append(el("h3", "team-build-subheading", "Ultimate"));
    section.append(ultimate ? compactSkill(ultimate, "Ultimate") : el("p", "team-empty-copy", "This Aniimo has no Ultimate."));
    if (ultimate) section.append(el("p", "team-skill-variant-note", "Comes with this Aniimo: there is nothing to pick."));
    return section;
  }

  // Whether this Aniimo's Core skill is enhanced: changes the skill and adds to CP.
  function renderCoreEnhanced(member, core) {
    if (!core?.upgrade) return null;
    const check = el("input");
    check.type = "checkbox";
    check.checked = Boolean(member.coreUpgraded);
    check.addEventListener("change", () => {
      member.coreUpgraded = check.checked;
      persist();
      render();
    });
    const label = el("label", "potential-check team-core-enhanced");
    label.title = "Enhanced with a Prismatic Stone. Also adds to CP: +5% on the level part and +20.";
    label.append(check, el("span", "", `${core.name} is enhanced`));
    return label;
  }

  function renderBuild(member, form, entry, index) {
    const wrap = el("div", "team-build team-build--player");
    wrap.append(renderSkillPicks(member, form, index), renderStatTable(member, entry));
    return wrap;
  }

  // --- Share card: a picture of this build, drawn on the player's device (build-card.js) ------------

  const PERSONALITY_ORDER = "EISNTFJP";

  // A held item as the card shows it (at the level picked, else its rarity's top level), or null.
  function cardHeldItem(member) {
    const held = heldItemOf(member);
    const item = held ? data?.held_item_catalog?.[held.itemId] : null;
    return item ? { name: item.name, icon: item.icon ? host.contentUrl(item.icon) : "", rarity: item.quality_label || "", level: held.level } : null;
  }

  // The rest of the team on the card: who they are, their held item and the skills they bring in this mode (an
  // Interlink ally or Egg Heist support its Core skill; otherwise the two active skills and the Core skill).
  // No stats or CP: those are only for the Aniimo the card is about.
  // A form's traits as the card shows them (always active, in every mode).
  function cardTraits(form) {
    return (form?.traits || []).map((trait) => ({ name: trait.name || "Trait", icon: trait.icon ? host.contentUrl(trait.icon) : "" }));
  }

  function cardTeammates(index) {
    return slotIndexes().filter((slot) => slot !== index).map((slot) => {
      const member = model.members[slot];
      const form = formFor(member);
      if (!form) return null;
      const entry = entryForForm(member.formId);
      return {
        name: entry?.name || form.name,
        role: slotRole(slot),
        icon: entry?.icon ? host.contentUrl(entry.icon) : "",
        skills: memberSkills(member, slot).filter(({ slot: kind }) => kind !== "Ultimate")
          .map(({ skill, slot: kind, enhanced }) => ({ name: skill.name, icon: skill.icon ? host.contentUrl(skill.icon) : "", slot: kind, core: Boolean(skill.core), enhanced: Boolean(enhanced) })),
        traits: cardTraits(form),
        heldItem: cardHeldItem(member),
      };
    }).filter(Boolean);
  }

  function buildCardSpec(member, index) {
    const form = formFor(member);
    const entry = entryForForm(member.formId);
    const damage = window.AniilogsDamage;
    const growth = aniilog?.stat_growth;
    const cap = Number(growth?.level_cap) || 70;
    const editor = window.AniilogsPotentialEditor;
    const options = editor ? editor.totalsOptions(memberBuild(member), cap, data) : { level: member.level ?? cap, potential: member.potential ?? 0 };
    const totals = damage?.statTotals && growth ? damage.statTotals(data, aniilog, member.formId, options) : null;
    const researched = new Set((member.formResearch || []).map(String));
    const baseId = entry?.base_id;
    const forms = baseId ? (aniilog?.entries || []).filter((row) => row.base_id === baseId).length : 1;
    const build = window.ANIILOGS_CONFIG?.gameBuild;
    return {
      name: entry?.name || form?.name || "Aniimo",
      formLabel: entry?.form_label || "",
      role: typeof entry?.role === "string" ? entry.role : "",
      icon: entry?.icon ? host.contentUrl(entry.icon) : "",
      elements: (form?.elements || []).map((id) => ({ name: element(id)?.name || String(id), color: element(id)?.color || "" })),
      level: options.level ?? cap,
      cp: totals?.cp,
      personality: [...(member.personality || [])].sort((a, b) => PERSONALITY_ORDER.indexOf(a) - PERSONALITY_ORDER.indexOf(b)).join(""),
      perfect: Boolean(member.perfect),
      stats: CARD_STATS.map((stat) => ({ stat, value: totals?.total?.[stat] ?? null, potential: totals?.potential?.[stat]?.total || 0 })),
      skills: memberSkills(member, index).map(({ skill, slot, enhanced }) => ({ name: skill.name, icon: skill.icon ? host.contentUrl(skill.icon) : "", slot, core: Boolean(skill.core), enhanced: Boolean(enhanced) })),
      heldItem: cardHeldItem(member),
      traits: cardTraits(form),
      slot: slotRole(index),
      mode: (({ card, label } = {}) => card || label || "")(MODES.find((mode) => mode.id === model.mode)),
      team: cardTeammates(index),
      starUp: member.starUp?.stage ? { stage: Number(member.starUp.stage), level: Number(member.starUp.level) || 0 } : null,
      research: (form?.form_research || []).filter((row) => researched.has(String(row.form_id))).map((row) => row.form_label || "Form"),
      aniilog: { forms: member.formsCaught ?? 1, total: forms > 1 ? forms : 0, prismana: member.prismanaCaught ?? 0 },
      coreUpgraded: Boolean(member.coreUpgraded),
      footer: `aniilogs.github.io${build ? ` · game build ${build}` : ""}`,
    };
  }

  // Interlink and both Egg Heist modes: the card is always about the main Aniimo (Interlink slot 1, Egg Heist slot 2),
  // whichever slot is open, with the supports in the team row. Other modes: the Aniimo you have selected.
  // Which Aniimo the share card is about: the main one in Interlink and both Egg Heist modes, else the selected one.
  function cardTarget(selectedMember, selectedIndex) {
    const main = mainSlot();
    const index = main ?? selectedIndex;
    const member = main === null ? selectedMember : model.members[main];
    return { main, index, member, mainEmpty: main !== null && !formFor(member) };
  }

  // Draws the card and opens it to copy, save or share. Returns false when it could not be drawn.
  async function makeShareCard({ member, index }) {
    if (!window.AniilogsBuildCard || !formFor(member)) return false;
    try {
      const spec = buildCardSpec(member, index);
      const canvas = await window.AniilogsBuildCard.draw(spec);
      openCardDialog(await window.AniilogsBuildCard.toBlob(canvas), spec.name);
      return true;
    } catch (error) {
      status = error instanceof Error ? error.message : "The card could not be drawn.";
      render();
      return false;
    }
  }

  // The phone's floating button (app.js) offers these on the team page.
  function quickActions() {
    if (!host || !data || viewState.page !== "team") return [];
    const target = cardTarget(model.members[model.activeSlot], model.activeSlot);
    return [
      { id: "link", label: "Copy team link", run: async () => { await shareTeam(); return status; } },
      { id: "card", label: "Generate Team Card", disabled: !window.AniilogsBuildCard || !formFor(target.member), run: () => makeShareCard(target) },
    ];
  }

  // Generate Team Card, next to Copy team link: a picture of the selected Aniimo's build (the main Aniimo in Interlink and
  // both Egg Heist modes) with the rest of the team. Made on the device: nothing is uploaded.
  function renderCardButton() {
    const target = cardTarget(model.members[model.activeSlot], model.activeSlot);
    const { main, mainEmpty } = target;
    const label = "Generate Team Card";
    const make = button(label, "team-share-button team-share-card-button", async () => {
      make.disabled = true;
      make.textContent = "Drawing card…";
      if (!(await makeShareCard(target))) return;
      make.disabled = false;
      make.textContent = label;
    });
    make.disabled = !window.AniilogsBuildCard || !formFor(target.member);
    make.title = mainEmpty
      ? `Add the ${slotRole(main)} (slot ${main + 1}) first: in this mode the card is about it.`
      : !formFor(target.member)
        ? "Pick an Aniimo for the selected slot first."
        : `A picture of ${main !== null ? `the ${slotRole(main)}` : "the selected Aniimo"}'s build with the rest of the team. Made on your device: nothing is uploaded.`;
    return make;
  }

  function cardFileName(name) {
    return `${String(name).replace(/[^\w.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "aniimo"}-build.png`;
  }

  function openCardDialog(blob, name) {
    const url = URL.createObjectURL(blob);
    const dialog = el("dialog", "team-card-dialog");
    const preview = el("img", "team-card-preview");
    preview.src = url;
    preview.alt = `${name} build card`;
    const note = el("p", "team-data-note", "Copy it and paste it into Discord or a chat, or save the picture.");
    const actions = el("div", "team-card-actions");
    if (navigator.clipboard?.write && window.ClipboardItem) {
      actions.append(button("Copy image", "team-loadout-action", async () => {
        try {
          await navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })]);
          note.textContent = "Copied. Paste it anywhere.";
        } catch {
          note.textContent = "Your browser didn't allow copying the picture. Save it instead.";
        }
      }));
    }
    const save = el("a", "team-loadout-action", "Save PNG");
    save.href = url;
    save.download = cardFileName(name);
    actions.append(save);
    const file = typeof File === "function" ? new File([blob], cardFileName(name), { type: "image/png" }) : null;
    if (file && navigator.canShare?.({ files: [file] })) {
      actions.append(button("Share…", "team-loadout-action", async () => {
        try { await navigator.share({ files: [file], title: `${name} build` }); } catch { /* closed the share sheet */ }
      }));
    }
    actions.append(button("Close", "team-loadout-action", () => dialog.close()));
    dialog.addEventListener("close", () => {
      URL.revokeObjectURL(url);
      dialog.remove();
    });
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    dialog.append(preview, note, actions);
    document.body.append(dialog);
    dialog.showModal();
  }

  function clampInt(value, min, max, fallback) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function numberField(labelText, value, min, max, onChange) {
    const label = el("label", "team-field team-stats-field");
    const input = el("input", "team-select");
    input.type = "number";
    input.inputMode = "numeric";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.addEventListener("change", () => onChange(clampInt(input.value, min, max, value)));
    label.append(el("span", "team-field-label", labelText), input);
    return label;
  }

  const PERSONALITY_PAIRS = Object.freeze([["E", "I"], ["S", "N"], ["T", "F"], ["J", "P"]]);
  const CARD_STATS = Object.freeze(["HP", "ATK", "P.DEF", "REGEN", "M.DEF", "BREAK"]);

  // The game's stat card for this member (damage-model.js statTotals): base stats from level and potential, then
  // personality, Star-Up, held item and Form Research bonuses, and CP.
  function renderCardCalculator(member, entry) {
    const model = window.AniilogsDamage;
    const growth = aniilog?.stat_growth;
    if (!model?.statTotals || !growth) return null;
    const box = el("div", "team-card-calc");
    const traits = data?.personality?.traits || [];
    const chosen = new Set(member.personality || []);
    box.append(el("h3", "team-build-subheading", "Personality"));
    const pairs = el("div", "team-card-personality");
    PERSONALITY_PAIRS.forEach((pair) => {
      const group = el("div", "team-card-pair");
      group.setAttribute("role", "group");
      pair.forEach((letter) => {
        const trait = traits.find((row) => row.letter === letter);
        const control = button(letter, "team-card-letter", () => {
          const next = new Set(member.personality || []);
          pair.forEach((other) => next.delete(other));
          if (!chosen.has(letter)) next.add(letter);
          member.personality = [...next];
          persist();
          render();
        });
        control.setAttribute("aria-pressed", String(chosen.has(letter)));
        control.title = trait ? `${trait.name}: ${trait.battle}` : letter;
        group.append(control);
      });
      pairs.append(group);
    });
    box.append(pairs);

    const cap = Number(growth.level_cap) || 70;
    const editor = window.AniilogsPotentialEditor;
    const options = editor ? editor.totalsOptions(memberBuild(member), cap, data) : {
      level: clampInt(member.level ?? cap, 1, cap, cap), potential: member.potential ?? 0, personality: member.personality || [],
    };
    const totals = model.statTotals(data, aniilog, member.formId, options);
    // Per-stat potential, Star-Up and held item (potential-editor.js), saved on the member.
    if (editor) {
      box.append(el("h3", "team-build-subheading", "Star-Up, held item, Aniilog and potential"));
      box.append(editor.render({
        coreToggle: false,
        data, aniilog, formId: member.formId, build: memberBuild(member), totals,
        onChange: (next) => {
          for (const key of ["potential", "starUp", "heldItem", "perfect", "formResearch", "coreUpgraded", "formsCaught", "prismanaCaught"]) {
            // A held item set to none stays none (null); otherwise the default would come back.
            if (key === "heldItem" && next[key] === null) member[key] = null;
            else if (next[key] === null || next[key] === undefined) delete member[key];
            else member[key] = next[key];
          }
          persist();
          render();
        },
      }));
    }
    if (!totals) return box;
    box.append(el("h3", "team-build-subheading", "Card stats"));
    const table = el("table", "team-stats-table team-card-table");
    const head = el("tr");
    ["Stat", "Species", "Base", "Card total"].forEach((text) => head.append(el("th", "", text)));
    table.append(el("thead"), el("tbody"));
    table.tHead.append(head);
    const species = Object.fromEntries((entry?.stats || []).map((row) => [model.STAT_ALIASES?.[row.label] || row.label, row.value]));
    CARD_STATS.forEach((stat) => {
      const line = el("tr");
      const total = totals.total[stat];
      const base = totals.base[stat];
      const bonus = el("td", "team-card-total", total === null ? "–" : total.toLocaleString());
      const sources = totals.bonus?.[stat]?.sources || [];
      if (sources.length) bonus.title = sources.map((row) => `${row.source}: ${row.key} ${row.value}`).join("\n");
      line.append(el("th", "", stat), el("td", "", String(species[stat] ?? "–")), el("td", "", base === null ? "–" : base.toLocaleString()), bonus);
      table.tBodies[0].append(line);
    });
    box.append(table);
    if (Number.isFinite(totals.cp)) {
      const cp = el("p", "team-card-cp");
      cp.append(el("strong", "", "CP "), totals.cp.toLocaleString());
      box.append(cp);
    }
    box.append(el("p", "team-data-note", "Card total = (base + Star-Up flat stats) × (1 + potential, personality, Star-Up, held-item and Form Research percentages) + flat bonuses, as the game adds them up, rounded up. The held item counts at the level you pick (up to Rare 5, Epic 10, Legendary 15). Not included: held-item talents, which are rolled on each item."));
    if (Number.isFinite(totals.cp)) box.append(el("p", "team-data-note", "CP is the game's formula: species stats and level, your own potential, Star-Up, the held item, an enhanced Core skill, and the forms and Prismana forms you have caught."));
    return box;
  }

  function renderStatTable(member, entry) {
    const section = el("section", "team-config-section");
    const growth = aniilog?.stat_growth;
    const grownStat = window.AniilogsDuel?.grownStat;
    const calculator = window.AniilogsDamage?.statTotals && entry?.stats?.length;
    if (calculator && growth) {
      const cap = Number(growth.level_cap) || 70;
      const level = clampInt(member.level ?? cap, 1, cap, cap);
      section.append(sectionHeading("Level, personality and bonuses", `Level ${level}`));
      const inputs = el("div", "team-stats-inputs");
      inputs.append(numberField(`Level (1–${cap})`, level, 1, cap, (next) => { member.level = next; persist(); render(); }));
      section.append(inputs);
      const card = renderCardCalculator(member, entry);
      if (card) {
        section.append(card);
        return section;
      }
    }
    if (!growth || typeof grownStat !== "function" || !entry?.stats?.length) {
      section.append(sectionHeading("Stats"), el("p", "team-empty-copy", "Stat growth isn’t available for this Aniimo."));
      return section;
    }
    const cap = Number(growth.level_cap) || 70;
    const maxPotential = Number(growth.attribute_points_max) || 20;
    const level = clampInt(member.level ?? cap, 1, cap, cap);
    // Without the calculator only one potential number applies to every stat.
    const potential = typeof member.potential === "object" ? 0 : clampInt(member.potential ?? 0, 0, maxPotential, 0);
    section.append(sectionHeading("Stats", `Level ${level}, potential ${potential}`));
    const inputs = el("div", "team-stats-inputs");
    inputs.append(
      numberField(`Level (1–${cap})`, level, 1, cap, (next) => { member.level = next; persist(); render(); }),
      numberField(`Potential, each stat (0–${maxPotential})`, potential, 0, maxPotential, (next) => { member.potential = next; persist(); render(); }),
    );
    section.append(inputs);
    const table = el("table", "team-stats-table");
    const head = el("tr");
    ["Stat", "Species value", `Level ${level}`].forEach((text) => head.append(el("th", "", text)));
    table.append(el("thead"), el("tbody"));
    table.tHead.append(head);
    // Magic Attack is a leftover table field: the game's six base stats and potentials
    // (pet_base_prop_attr_names, attribute_group 110) have no Magic Attack.
    entry.stats.filter((row) => row.label !== "Magic Attack").forEach((row) => {
      const value = grownStat(growth, row.label, Number(row.value), level, potential);
      const line = el("tr");
      line.append(el("th", "", row.label), el("td", "", String(row.value)), el("td", "", value === null ? "–" : value.toLocaleString()));
      table.tBodies[0].append(line);
    });
    section.append(table, el("p", "team-data-note", "Exact base stats from the game’s own formulas (formula_data.lua 3003 HP, 3004 Attack, 3007 Defense and Magic Defense, 3008 EP Regen, 3018 Break) and the potential bonus in pet_attr_convert_data. Not included: allocated attribute points, held items, personality traits and other bonuses."));
    return section;
  }

  function renderPersonality(entry) {
    const section = el("section", "team-config-section");
    section.append(sectionHeading("Personality", "Rolled at random on each Aniimo"));
    const traits = data?.personality?.traits || [];
    const list = el("div", "team-stats-traits");
    traits.forEach((trait) => {
      const card = el("article", "team-stats-trait");
      const top = el("div", "team-skill-top");
      top.append(el("strong", "", trait.name || trait.letter), pill(trait.letter));
      card.append(top);
      if (trait.battle) card.append(el("p", "", `Battle: ${trait.battle}`));
      if (trait.home) card.append(el("small", "", `Home: ${trait.home}`));
      list.append(card);
    });
    if (traits.length) section.append(list);
    if (data?.personality?.note) section.append(el("p", "team-data-note", data.personality.note));
    const natures = entry?.profile?.natures || [];
    if (natures.length) {
      section.append(el("p", "team-stats-natures", `Natures: ${natures.map((nature) => `${nature.name} ${nature.percent}%`).join(" · ")}`),
        el("p", "team-data-note", "Natures are flavour only: the game gives them no stat change."));
    }
    return section;
  }

  // --- Type matchups -------------------------------------------------------------------------

  function element(id) {
    return data?.elements?.[String(id)] || null;
  }

  function elementIds() {
    return Object.keys(data?.elements || {});
  }

  function elementChip(id) {
    const info = element(id);
    const chip = el("span", "team-type-chip", info?.name || String(id));
    if (info?.color) chip.style.setProperty("--type-color", info.color);
    return chip;
  }

  function chipRow(ids, emptyText = "None") {
    const row = el("div", "team-type-chips");
    if (!ids.length) row.append(el("span", "team-type-none", emptyText));
    ids.forEach((id) => row.append(elementChip(id)));
    return row;
  }

  // real_element_against rows are the attacking element, columns the defending one.
  function attackersAt(defender, multiplier) {
    return elementIds().filter((attacker) => element(attacker).against[String(defender)] === multiplier);
  }

  function defendersAt(attacker, multiplier) {
    return elementIds().filter((defender) => element(attacker)?.against[defender] === multiplier);
  }

  function formsWithTypes(types) {
    const wanted = types.map(Number);
    return Object.entries(data?.forms || {})
      .filter(([, form]) => wanted.every((id) => form.elements?.includes(id)))
      .map(([formId, form]) => ({ formId, form, entry: entryForForm(formId) }))
      .sort((left, right) => (left.form.elements.length - right.form.elements.length)
        || String(left.entry?.name || left.form.name).localeCompare(String(right.entry?.name || right.form.name)));
  }

  function removeFromTeam(index) {
    const member = model.members[index];
    const name = entryForForm(member.formId)?.name || formFor(member)?.name || "Aniimo";
    model.members[index] = defaultMember();
    model.activeSlot = index;
    persist();
    status = `Removed ${name} from ${slotRole(index).toLocaleLowerCase()}.`;
    render();
  }

  function addToTeam(formId, targetSlot) {
    const empty = slotIndexes().find((index) => !model.members[index].formId);
    const slot = targetSlot ?? empty ?? model.activeSlot;
    model.members[slot] = { ...defaultMember(), formId };
    model.activeSlot = slot;
    persist();
    status = `Added to ${slotRole(slot).toLocaleLowerCase()}.`;
    goToPage("team");
  }

  function renderTypePicker() {
    const section = el("section", "team-config-section");
    const heading = el("div", "team-section-heading");
    heading.append(el("div", "", "Elements"), el("small", "", "Pick one or two"));
    section.append(heading);
    const grid = el("div", "team-type-grid");
    elementIds().forEach((id) => {
      const selected = viewState.types.includes(id);
      const control = button(element(id).name, "team-type-button", () => openTypes(selected
        ? viewState.types.filter((type) => type !== id)
        : [...viewState.types, id].slice(-MAX_TYPE_SELECTION)));
      control.style.setProperty("--type-color", element(id).color || "var(--accent)");
      control.setAttribute("aria-pressed", String(selected));
      grid.append(control);
    });
    section.append(grid);
    const team = slotIndexes().map((index) => ({ member: model.members[index], form: formFor(model.members[index]) })).filter((row) => row.form);
    if (team.length) {
      const quick = el("div", "team-type-quick");
      quick.append(el("span", "team-field-label", "Your team"));
      team.forEach(({ member, form }) => {
        const entry = entryForForm(member.formId);
        const pick = button("", "team-type-member", () => openTypes(form.elements));
        if (entry?.icon) pick.append(icon(entry.icon, "team-type-member-icon"));
        pick.append(el("span", "", entry?.name || form.name));
        quick.append(window.AniilogsAniimoLink?.inline(pick, member.formId, formLabel(entry, form)) || pick);
      });
      section.append(quick);
    }
    if (viewState.types.length) section.append(button("Clear", "team-loadout-action team-type-clear", () => openTypes([])));
    return section;
  }

  function matchupBlock(title, rows) {
    const block = el("div", "team-type-block");
    block.append(el("div", "team-subsection-heading", title));
    rows.forEach(([label, ids, tone]) => {
      const row = el("div", `team-type-row team-type-row--${tone}`);
      row.append(el("span", "team-type-multiplier", label), chipRow(ids));
      block.append(row);
    });
    return block;
  }

  // PvE or PvP values (type-matchups.js) for everything on the Type matchups page.
  function matchupMode() {
    return viewState.matchupMode === "pvp" ? "pvp" : "pve";
  }

  function renderMatchupModeSwitch() {
    const group = el("div", "team-matchup-mode");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Matchup values");
    window.AniilogsMatchups.MODES.forEach((mode) => {
      const control = button(mode.label, "team-matchup-mode-button", () => {
        viewState.matchupMode = mode.id;
        saveViewState();
        render();
      });
      control.setAttribute("aria-pressed", String(matchupMode() === mode.id));
      group.append(control);
    });
    return group;
  }

  function renderMatchups(types) {
    const matchups = window.AniilogsMatchups;
    const mode = matchupMode();
    const [, resisted, countered] = matchups.steps(mode);
    const section = el("section", "team-config-section");
    const heading = el("div", "team-section-heading");
    heading.append(el("div", "", "Matchups"), chipRow(types));
    section.append(heading);
    // One list for the typing as a whole: the game multiplies the values of the defending elements
    // (CombatActionTool, getElementAgainstValue), so with two elements only the product matters.
    const taken = matchups.groups(matchups.row(data.elements, types, mode)).filter((group) => group.tone !== "even")
      .map((group) => [`Takes ${matchups.format(group.value)}`, group.entries.map((entry) => entry.id), group.tone === "more" ? "weak" : "resist"]);
    if (types.length > 1) {
      const mixed = elementIds().filter((attacker) => {
        const values = types.map((type) => element(attacker).against[type]);
        return values.includes(STRONG) && values.includes(WEAK);
      });
      if (mixed.length) taken.push(["Takes ×1 (countered and resisted)", mixed, "mixed"]);
    }
    // The radar (as on an Aniimo's page) beside the lists.
    const layout = el("div", "team-matchup-radar-row");
    const lists = el("div", "team-matchup-lists");
    lists.append(matchupBlock(types.length > 1 ? "Defending with both elements" : `${element(types[0]).name} defending`, taken));
    types.forEach((type) => lists.append(matchupBlock(`${element(type).name} attacking one element`, [
      [`Deals ${matchups.format(countered)}`, defendersAt(type, STRONG), "strong"],
      [`Deals ${matchups.format(resisted)}`, defendersAt(type, WEAK), "resist"],
    ])));
    layout.append(matchups.renderRadar(matchups.row(data.elements, types, mode), { mode, color: element(types[0])?.color || "" }), lists);
    section.append(layout);
    section.append(el("p", "team-data-note", `${matchups.note(mode)} An elemental shield on the target may change it too; that isn't confirmed.`));
    return section;
  }

  // One grid: the picked typing and every Aniimo in battle, by attacking element.
  function renderTeamDefence(types) {
    const matchups = window.AniilogsMatchups;
    const section = el("section", "team-config-section");
    const heading = el("div", "team-section-heading");
    heading.append(el("div", "", "Damage taken"), renderMatchupModeSwitch());
    section.append(heading);
    const rows = [];
    if (types.length) rows.push({ head: chipRow(types), defending: types, current: true, count: false });
    battleMembers().forEach(({ member, form }) => {
      const entry = entryForForm(member.formId);
      const head = button("", "matchup-form", () => openTypes(form.elements));
      if (entry?.icon) head.append(icon(entry.icon, "team-type-member-icon"));
      const label = el("span", "", entry?.name || form.name);
      // Two forms of one Aniimo can be on the team: say which.
      if (entry?.form_label) label.append(" ", el("small", "", entry.form_label.replace(/ Form$/u, "")));
      head.append(label);
      head.title = `${formLabel(entry, form)}: show its matchups`;
      rows.push({ head, defending: form.elements });
    });
    if (!rows.length) {
      section.append(el("p", "team-empty-copy", "Pick an element or add Aniimo to your team to see what they take from each element."));
      return section;
    }
    section.append(matchups.renderGrid(data.elements, rows, { mode: matchupMode(), foot: "Team members that take more" }), matchups.renderLegend());
    // With a typing picked, the Matchups section below carries the note.
    if (matchupMode() === "pvp" && !types.length) section.append(el("p", "team-data-note", matchups.PVP_NOTE));
    return section;
  }

  function renderTypeAniimo(types) {
    const section = el("section", "team-config-section");
    const rows = formsWithTypes(types);
    const heading = el("div", "team-section-heading");
    heading.append(el("div", "", types.length > 1 ? "Aniimo with both elements" : "Aniimo with this element"), el("small", "", String(rows.length)));
    section.append(heading);
    if (!rows.length) {
      section.append(el("p", "team-empty-copy", "No published Aniimo has this combination."));
      return section;
    }
    const groups = types.length === 1
      ? [["Only this element", rows.filter((row) => row.form.elements.length === 1)], ["With a second element", rows.filter((row) => row.form.elements.length > 1)]]
      : [["", rows]];
    groups.forEach(([label, list]) => {
      if (!list.length) return;
      if (label) section.append(el("div", "team-subsection-heading", label));
      const grid = el("div", "team-type-aniimo");
      list.forEach(({ formId, form, entry }) => {
        const card = el("article", "team-type-card");
        if (entry?.icon) card.append(icon(entry.icon, "team-overview-icon"));
        const copy = el("div", "team-overview-copy");
        copy.append(
          withLink(el("strong", "", entry?.name || form.name), aniimoLink(formId, entry, form)),
          el("small", "", [entry?.form_label, entry?.role].filter(Boolean).join(" · ")),
          chipRow(form.elements),
        );
        card.append(copy, renderAddControl(formId));
        grid.append(card);
      });
      section.append(grid);
    });
    return section;
  }

  // Per element: which of the team's elements counter it, and which members it hits for more than x1 across
  // all of their elements (a member with one countered and one resisting element takes x1, so isn't listed).
  function renderTeamCoverage() {
    const section = el("section", "team-config-section");
    const heading = el("div", "team-section-heading");
    heading.append(el("div", "", "Team coverage"), el("small", "", model.mode === "holosim"
      ? "From the four Aniimo in battle"
      : "From your team's elements"));
    section.append(heading);
    const team = battleMembers();
    if (!team.length) {
      section.append(el("p", "team-empty-copy", "Add Aniimo to your team to see which elements it covers."));
      return section;
    }
    const teamTypes = [...new Set(team.flatMap((row) => row.form.elements.map(String)))];
    const table = el("div", "team-coverage");
    const matchups = window.AniilogsMatchups;
    const mode = matchupMode();
    ["Element", `Your ${matchups.format(matchups.steps(mode)[2])} hits`, "Members that take more"].forEach((label) => table.append(el("span", "team-coverage-head", label)));
    elementIds().forEach((id) => {
      const hits = teamTypes.filter((attacker) => element(attacker)?.against[id] === STRONG);
      const exposed = team.map((row) => ({ ...row, taken: matchups.net(data.elements, row.form.elements, id, mode) })).filter((row) => row.taken > 1);
      const names = exposed.map((row) => `${entryForForm(row.member.formId)?.name || row.form.name}${row.taken > 2 ? ` (${matchups.format(row.taken)})` : ""}`).join(", ") || "—";
      table.append(elementChip(id), chipRow(hits, "No strong hit"), el("span", exposed.length >= 2 ? "team-coverage-risk" : "", names));
    });
    section.append(table);
    return section;
  }

  // --- Type matchups › Compare ---------------------------------------------------------------

  function setCompare(changes) {
    viewState.compare = { ...viewState.compare, ...changes };
    saveViewState();
    render();
  }

  function renderTypesTabs() {
    const row = el("div", "team-matchup-tabs");
    row.setAttribute("role", "tablist");
    [["matchups", "Matchups"], ["compare", "Compare"]].forEach(([id, label]) => {
      const control = button(label, "team-matchup-tab", () => {
        viewState.typesTab = id;
        saveViewState();
        render();
      });
      control.setAttribute("role", "tab");
      control.setAttribute("aria-selected", String((viewState.typesTab === "compare" ? "compare" : "matchups") === id));
      row.append(control);
    });
    return row;
  }

  // Every published form, by name, for the two pickers.
  function compareFormOptions() {
    return Object.entries(data?.forms || {})
      .filter(([, form]) => form?.elements?.length)
      .map(([formId, form]) => ({ value: formId, label: formLabel(entryForForm(formId), form) }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  // A form id that is still published: the saved pick, else a team member, else the first form.
  function comparePick(saved, fallbacks, options) {
    const ids = new Set(options.map((option) => option.value));
    return [saved, ...fallbacks].find((id) => id && ids.has(String(id))) || options[0]?.value || "";
  }

  function compareHead(side, formId) {
    const form = data.forms[formId];
    const entry = entryForForm(formId);
    const head = el("span", `matchup-compare-head matchup-side-${side}`);
    if (entry?.icon) head.append(icon(entry.icon, "team-type-member-icon"));
    else head.append(el("i", "matchup-compare-mark"));
    head.append(el("span", "", entry?.name || form?.name || "Aniimo"));
    return head;
  }

  function comparePicker(side, control, sub) {
    const box = el("div", `matchup-compare-pick matchup-side-${side}`);
    box.append(control);
    if (sub) box.append(sub);
    return box;
  }

  function summaryLine(label, text, side = "") {
    const line = el("div", "matchup-compare-line");
    if (side) line.classList.add(`matchup-side-${side}`);
    line.append(el("strong", "", label), " ", el("span", "", text || "nobody"));
    return line;
  }

  function names(list) {
    return list.length ? list.join(", ") : "";
  }

  function renderCompareAniimo() {
    const matchups = window.AniilogsMatchups;
    const mode = matchupMode();
    const options = compareFormOptions();
    const team = battleMembers().map(({ member }) => member.formId);
    const a = comparePick(viewState.compare.a, team, options);
    const other = options.find((option) => String(data.forms[option.value].elements) !== String(data.forms[a]?.elements))?.value;
    const b = comparePick(viewState.compare.b, [...team.filter((id) => id !== a), other], options);
    const formA = data.forms[a];
    const formB = data.forms[b];
    const section = el("section", "team-config-section");
    if (!formA || !formB) {
      section.append(el("p", "team-empty-copy", "No Aniimo to compare yet."));
      return section;
    }
    const nameA = entryForForm(a)?.name || formA.name;
    const nameB = entryForForm(b)?.name || formB.name;
    const pickers = el("div", "matchup-compare-pickers");
    pickers.append(
      comparePicker("a", selectControl("First Aniimo", options, a, (value) => setCompare({ a: value })), chipRow(formA.elements)),
      el("span", "matchup-compare-vs", "vs"),
      comparePicker("b", selectControl("Second Aniimo", options, b, (value) => setCompare({ b: value })), chipRow(formB.elements)),
    );
    section.append(pickers);
    const rowA = matchups.row(data.elements, formA.elements, mode);
    const rowB = matchups.row(data.elements, formB.elements, mode);
    const layout = el("div", "team-matchup-radar-row");
    const summary = el("div", "matchup-compare-summary");
    const hits = (attacker, defender) => attacker.elements.map((id) => `${element(id).name} ${matchups.format(matchups.net(data.elements, defender.elements, id, mode))}`).join(", ");
    const where = (test) => names(rowA.filter((entry, index) => test(entry.value, rowB[index].value)).map((entry) => entry.name));
    summary.append(
      summaryLine(`${nameA} hits ${nameB} for`, hits(formA, formB), "a"),
      summaryLine(`${nameB} hits ${nameA} for`, hits(formB, formA), "b"),
      summaryLine("Both take more from", where((left, right) => left > 1 && right > 1) || "none"),
      summaryLine(`${nameB} covers ${nameA} against`, where((left, right) => left > 1 && right < 1) || "none"),
      summaryLine(`${nameA} covers ${nameB} against`, where((left, right) => left < 1 && right > 1) || "none"),
    );
    layout.append(matchups.renderCompareRadar([{ entries: rowA, name: nameA }, { entries: rowB, name: nameB }], { mode }), summary);
    section.append(layout, matchups.renderGrid(data.elements, [
      { head: compareHead("a", a), defending: formA.elements },
      { head: compareHead("b", b), defending: formB.elements },
    ], { mode }));
    return section;
  }

  // A saved team's Aniimo in battle (the first three slots), with their forms.
  function teamForms(loadout) {
    return (loadout?.model?.members || []).slice(0, TEAM_SIZE)
      .map((member) => ({ formId: member.formId, form: formFor(member) })).filter((row) => row.form);
  }

  function renderCompareTeams() {
    const matchups = window.AniilogsMatchups;
    const mode = matchupMode();
    const section = el("section", "team-config-section");
    const options = store.loadouts.map((loadout) => ({ value: loadout.id, label: loadout.name }));
    const ids = new Set(options.map((option) => option.value));
    const teamA = ids.has(viewState.compare.teamA) ? viewState.compare.teamA : store.activeId;
    const teamB = ids.has(viewState.compare.teamB) ? viewState.compare.teamB
      : options.find((option) => option.value !== teamA)?.value || teamA;
    const loadoutA = store.loadouts.find((loadout) => loadout.id === teamA);
    const loadoutB = store.loadouts.find((loadout) => loadout.id === teamB);
    const membersA = teamForms(loadoutA);
    const membersB = teamForms(loadoutB);
    const sub = (members) => el("small", "matchup-compare-members", members.map(({ formId, form }) => entryForForm(formId)?.name || form.name).join(", ") || "No Aniimo yet");
    const pickers = el("div", "matchup-compare-pickers");
    pickers.append(
      comparePicker("a", selectControl("First team", options, teamA, (value) => setCompare({ teamA: value })), sub(membersA)),
      el("span", "matchup-compare-vs", "vs"),
      comparePicker("b", selectControl("Second team", options, teamB, (value) => setCompare({ teamB: value })), sub(membersB)),
    );
    section.append(pickers);
    if (store.loadouts.length < 2) section.append(el("p", "team-data-note", "Make a second team in Team Builder (+ New team… in the team list) to compare two teams."));
    if (!membersA.length || !membersB.length) {
      section.append(el("p", "team-empty-copy", "Both teams need Aniimo in battle to compare them."));
      return section;
    }
    const nameA = loadoutA.name;
    const nameB = teamB === teamA ? `${loadoutB.name} (again)` : loadoutB.name;
    const rowA = matchups.teamRow(data.elements, membersA.map(({ form }) => form.elements), mode);
    const rowB = matchups.teamRow(data.elements, membersB.map(({ form }) => form.elements), mode);
    // A member "can counter" another when one of its own elements hits it for more than x1.
    const label = ({ formId, form }) => entryForForm(formId)?.name || form.name;
    const countered = (attackers, defenders) => defenders.filter(({ form }) => attackers.some((attacker) => attacker.form.elements
      .some((id) => matchups.net(data.elements, form.elements, id, mode) > 1))).map(label);
    const safe = (attackers, defenders) => defenders.filter(({ form }) => attackers.every((attacker) => attacker.form.elements
      .every((id) => matchups.net(data.elements, form.elements, id, mode) <= 1))).map(label);
    const layout = el("div", "team-matchup-radar-row");
    const summary = el("div", "matchup-compare-summary");
    summary.append(
      summaryLine(`${nameA} can counter`, names(countered(membersA, membersB)), "a"),
      summaryLine(`${nameB} can counter`, names(countered(membersB, membersA)), "b"),
      summaryLine(`Safe from ${nameA}:`, names(safe(membersA, membersB))),
      summaryLine(`Safe from ${nameB}:`, names(safe(membersB, membersA))),
    );
    layout.append(matchups.renderCompareRadar([{ entries: rowA, name: nameA }, { entries: rowB, name: nameB }], { mode }), summary);
    const rows = [
      ...membersA.map(({ formId, form }) => ({ head: compareHead("a", formId), defending: form.elements })),
      ...membersB.map(({ formId, form }, index) => ({ head: compareHead("b", formId), defending: form.elements, className: index ? "" : "matchup-grid-split" })),
    ];
    section.append(layout, matchups.renderGrid(data.elements, rows, { mode }), matchups.renderLegend(),
      el("p", "team-data-note", "Radar: each team's average damage taken from each element (the members in battle). Counters use each member's own elements: skills of another element, stats and gear aren't counted."));
    return section;
  }

  function renderComparePage() {
    const section = el("section", "team-config-section");
    const heading = el("div", "team-section-heading");
    const kinds = el("div", "team-matchup-mode");
    kinds.setAttribute("role", "group");
    kinds.setAttribute("aria-label", "Compare");
    [["aniimo", "Two Aniimo"], ["teams", "Two teams"]].forEach(([id, label]) => {
      const control = button(label, "team-matchup-mode-button", () => setCompare({ kind: id }));
      control.setAttribute("aria-pressed", String(viewState.compare.kind === id));
      kinds.append(control);
    });
    heading.append(el("div", "", "Compare"), kinds, renderMatchupModeSwitch());
    section.append(heading);
    const page = el("div", "team-builder-main-column");
    page.append(section, viewState.compare.kind === "teams" ? renderCompareTeams() : renderCompareAniimo(),
      el("p", "team-data-note", matchupMode() === "pvp" ? window.AniilogsMatchups.PVP_NOTE : window.AniilogsMatchups.PVE_NOTE));
    return page;
  }

  function renderTypesPage() {
    const wrapper = el("div", "team-member-configuration");
    wrapper.append(renderTypesTabs());
    if (viewState.typesTab === "compare") {
      wrapper.append(renderComparePage());
      return wrapper;
    }
    const types = viewState.types.filter((type) => element(type));
    const columns = el("div", "team-builder-columns");
    const main = el("div", "team-builder-main-column");
    main.append(renderTypePicker(), renderTeamDefence(types));
    if (types.length) main.append(renderMatchups(types), renderTypeAniimo(types));
    else main.append(el("section", "team-builder-empty", "Pick an element above, or tap a team member, to see its matchups and every Aniimo with that typing."));
    const side = el("div", "team-builder-main-column");
    side.append(renderTeamCoverage());
    if (data?.build) side.append(el("p", "team-data-note", `Multipliers from game build ${data.build}.`));
    columns.append(main, side);
    wrapper.append(columns);
    return wrapper;
  }

  function renderPageSwitch() {
    const group = el("div", "team-mode-switch");
    group.setAttribute("role", "tablist");
    [["team", "Team Builder"], ["types", "Type matchups"]].forEach(([id, label]) => {
      const control = button(label, "team-mode-button", () => goToPage(id));
      control.setAttribute("role", "tab");
      // 1v1 is under Team Builder (PvP).
      control.setAttribute("aria-selected", String(viewState.page === id || (id === "team" && viewState.page === DUEL_TAB[0] && Boolean(window.AniilogsDuel))));
      group.append(control);
    });
    // The guides moved to their own page; this keeps them a tap away on phones, whose bottom tabs don't list it.
    const guides = el("a", "team-mode-button", "Guides");
    guides.href = "/guides/";
    group.append(guides);
    return group;
  }

  function renderPanel() {
    const panel = host.panel;
    panel.textContent = "";
    const header = el("header", "team-builder-header");
    const copy = el("div");
    const typesPage = viewState.page === "types";
    // 1v1 lives in duel.js; without it the tab falls back to the team page.
    const duelPage = viewState.page === "duel" && Boolean(window.AniilogsDuel);
    copy.append(el("h1", "", typesPage ? "Type matchups" : duelPage ? "1v1" : "Team Builder"), el("p", "", typesPage
      ? "See what an element or pair of elements is weak to and strong against, and which Aniimo have that typing."
      : duelPage
        ? "How much one Aniimo’s attacks take off another, and how fast each side gets the KO."
        : MODE_NOTES[model.mode]));
    const controls = el("div", "team-header-controls");
    controls.append(renderPageSwitch());
    if (!typesPage) controls.append(renderGroupSwitch(), renderModeSwitch());
    header.append(copy, controls);
    panel.append(header);
    if (typesPage) panel.append(renderTypesPage());
    else if (duelPage) panel.append(renderDuelPage());
    else panel.append(renderOverview(), renderTeamPage());
  }

  function renderDuelPage() {
    return window.AniilogsDuel.render({
      aniilog,
      data,
      members: model.members.map((member) => member?.formId).filter(Boolean).map(String),
      // The level and potential set on each member’s Build tab (unset level = the cap).
      memberStats: Object.fromEntries(model.members.filter((member) => member?.formId)
        .map((member) => [String(member.formId), { level: member.level, potential: member.potential, starUp: member.starUp,
          heldItem: heldItemOf(member), personality: member.personality, perfect: member.perfect, formResearch: member.formResearch,
          coreUpgraded: member.coreUpgraded, formsCaught: member.formsCaught, prismanaCaught: member.prismanaCaught }])),
      formLabel,
      contentUrl: host.contentUrl,
      developerMode: typeof window.developerModeEnabled === "function" && window.developerModeEnabled(),
      rerender: renderPanel,
    });
  }

  function renderLoading() {
    if (!host) return;
    host.sidebar.textContent = "";
    host.panel.textContent = "";
    const message = loadError || "Loading Team Builder…";
    host.sidebar.append(el("p", "team-loading", message));
    host.panel.append(el("p", "team-loading", message));
  }

  function render() {
    if (!host) return;
    if (!aniilog || !data) {
      renderLoading();
      return;
    }
    model.members.forEach(validateMember);
    renderSidebar();
    renderPanel();
  }

  async function show(options) {
    host = options;
    renderLoading();
    await ensureData();
    if (!data) {
      renderLoading();
      return;
    }
    loadSharedTeam();
    model.members.forEach(validateMember);
    persist();
    render();
    writePageAddress(false);
    requestDeveloperOverlay();
  }

  // A #guide-… link followed on an open Team Builder goes to the Guides page too.
  window.addEventListener("hashchange", () => {
    if (guideAddress()) window.location.assign(guideAddress());
  });

  window.AniilogsTeamBuilder = Object.freeze({ show, applyAddress, quickActions });
})();
