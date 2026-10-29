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
  const MODES = Object.freeze([
    Object.freeze({ id: "standard", label: "Standard", share: "s" }),
    Object.freeze({ id: "interlink", label: "Interlink", share: "c" }),
    Object.freeze({ id: "holosim", label: "Holo-Sim", share: "h" }),
  ]);
  const MODE_NOTES = Object.freeze({
    standard: "Four Aniimo, each with two picked active skills. Each Aniimo's Core switch-skill and Ultimate are always available.",
    interlink: "You control the first Aniimo and pick its skills. The other three bring their Core skills.",
    holosim: "Like Standard, plus a reserve you can swap in and out between battles in the Holo-Battle Simulator.",
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
  // Which Team Builder page is open and the elements picked in Type matchups (per viewer).
  let viewState = loadViewState();

  function loadViewState() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(VIEW_STORAGE_KEY) || "null");
      return {
        page: saved?.page === "types" ? "types" : "team",
        types: Array.isArray(saved?.types) ? saved.types.slice(0, MAX_TYPE_SELECTION).map(String) : [],
      };
    } catch {
      return { page: "team", types: [] };
    }
  }

  function saveViewState() {
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(viewState));
    } catch {
      // Remembering the open page is only a convenience.
    }
  }

  function openTypes(types) {
    viewState = { page: "types", types: types.map(String).slice(0, MAX_TYPE_SELECTION) };
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
    return {
      formId: String(value?.formId || ""),
      activeSkills,
    };
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

  function renameLoadout() {
    const loadout = activeLoadout();
    const requested = window.prompt("Team name:", loadout.name);
    if (requested === null) return;
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

  function aniimoOptions() {
    // Aniilog order (its entries are already sorted for display).
    const order = new Map((aniilog?.entries || []).map((entry, index) => [String(entry.form_id), index]));
    const rows = Object.keys(data?.forms || {}).map((formId) => ({
      value: formId,
      label: formLabel(entryForForm(formId), data.forms[formId]),
      group: entryForForm(formId)?.surface_label || "",
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
    const combat = new Set(skillsOf(form, "skill").map((skill) => String(skill.id)));
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
    select.addEventListener("change", () => onChange(select.value));
    label.append(el("span", "team-field-label", labelText), select);
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

  function pill(text, modifier = "") {
    return el("span", `team-pill${modifier ? ` team-pill--${modifier}` : ""}`, text);
  }

  function slotRole(index) {
    if (model.mode === "interlink") return index === 0 ? "Controlled Aniimo" : `Interlink ally ${index}`;
    if (model.mode === "holosim" && index === RESERVE_SLOT) return "Reserve";
    return `Team slot ${index + 1}`;
  }

  // Interlink allies only bring their Core skills; everyone else has their picks plus the Ultimate
  // that comes with the Aniimo.
  function supportOnly(index) {
    return model.mode === "interlink" && index > 0;
  }

  function memberSkills(member, index) {
    const form = formFor(member);
    if (!form) return [];
    if (supportOnly(index)) {
      return skillsOf(form, "skill").filter((skill) => skill.core).map((skill) => ({ skill, slot: "Core skill" }));
    }
    // The Core skill is the switch-skill: always usable through the switch shortcut, picked or not.
    const core = coreSkill(form);
    const rows = member.activeSkills.map((id) => skillFor(form, id)).filter(Boolean)
      .map((skill) => ({ skill, slot: skill === core ? "Active · Switch-skill" : "Active" }));
    if (core && !rows.some((row) => row.skill === core)) rows.push({ skill: core, slot: "Switch-skill" });
    skillsOf(form, "ultimate").forEach((skill) => rows.push({ skill, slot: "Ultimate" }));
    return rows;
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
        const value = [formatValues(attribute.key, attribute.values), attribute.formula].filter(Boolean).join(" · ");
        list.append(el("dt", "", attribute.label), el("dd", "", `${value}${attribute.per_stack ? " per stack" : ""}`));
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

  function renderSkillCard(skill, slotLabel) {
    const card = el("article", "team-skill-summary");
    if (skill.icon) card.append(icon(skill.icon, "team-skill-icon"));
    const copy = el("div", "team-skill-copy");
    const top = el("div", "team-skill-top");
    top.append(el("strong", "", skill.name), pill(slotLabel));
    copy.append(top);
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
      skill.scaling?.forEach((note) => description.append(el("p", "team-skill-caveat", note)));
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
    section.append(el("summary", "", upgrade.name === base.name ? "Upgraded version" : `Upgraded: ${upgrade.name}`));
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
      section.append(el("p", "team-upgrade-label", "Upgraded game description"), el("p", "", upgrade.description));
    }
    if (!effectsKnown) {
      section.append(el("p", "team-skill-caveat", "The game data links no effect record to the upgraded version, so only its stats and text are compared."));
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

  function renderModeSwitch(compact = false) {
    const group = el("div", compact ? "team-mode-switch team-mode-switch--compact" : "team-mode-switch");
    group.setAttribute("role", "tablist");
    MODES.forEach((mode) => {
      const control = button(mode.label, "team-mode-button", () => {
        model.mode = mode.id;
        model.activeSlot = Math.min(model.activeSlot, slotCount() - 1);
        persist();
        render();
      });
      control.setAttribute("role", "tab");
      control.setAttribute("aria-selected", String(model.mode === mode.id));
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
    card.append(header, identity, select);
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
    field.append(selector);
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
      button("Rename", "team-loadout-action", renameLoadout),
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
    heading.append(el("h2", "", "Team Builder"), button("Clear", "team-clear-button", () => {
      if (!window.confirm("Clear every slot in this team?")) return;
      model = defaultModel();
      persist();
      render();
    }));
    sidebar.append(heading, renderLoadoutControls(), renderModeSwitch(true));
    sidebar.append(el("p", "team-sidebar-description", MODE_NOTES[model.mode]));
    const slots = el("div", "team-sidebar-slots");
    slotIndexes().forEach((index) => slots.append(renderSidebarSlot(model.members[index], index)));
    const shareWrap = el("div", "team-share-wrap");
    shareWrap.append(button("Copy team link", "team-share-button", shareTeam));
    if (status) shareWrap.append(el("p", "team-share-status", status));
    sidebar.append(slots, shareWrap);
  }

  function renderOverview() {
    const section = el("section", "team-overview");
    const heading = el("div", "team-section-heading");
    heading.append(el("div", "", "Team overview"), el("small", "", {
      interlink: "1 controlled + 3 Core allies",
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
      grid.append(card);
    });
    section.append(heading, grid);
    return section;
  }

  function renderSkillLoadout(member, form, index) {
    const section = el("section", "team-config-section");
    const heading = el("div", "team-section-heading");
    const allyOnly = supportOnly(index);
    heading.append(el("div", "", allyOnly ? "Core skills brought to the team" : "Skill loadout"));
    section.append(heading);
    if (!allyOnly) {
      const skills = skillsOf(form, "skill");
      const grid = el("div", "team-field-grid");
      for (let position = 0; position < MAX_ACTIVE_SKILLS; position += 1) {
        const other = member.activeSkills[position === 0 ? 1 : 0];
        const options = [{ value: "", label: "Choose a skill" }, ...skills.map((skill) => ({
          value: String(skill.id),
          label: `${skill.core ? "Core · " : ""}${skill.name}`,
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
      const core = coreSkill(form);
      const ultimate = skillsOf(form, "ultimate")[0];
      section.append(
        el("p", "team-skill-variant-note", core
          ? `Switch-skill: ${core.name} (its Core skill, always usable with the switch shortcut).`
          : "This Aniimo has no Core skill, so no switch-skill."),
        el("p", "team-skill-variant-note", ultimate
          ? `Ultimate: ${ultimate.name} (comes with this Aniimo).`
          : "This Aniimo has no Ultimate."),
      );
    }
    const chosen = memberSkills(member, index);
    if (!chosen.length) {
      section.append(el("p", "team-empty-copy", allyOnly ? "This Aniimo has no Core skill." : "Choose skills to see how they work."));
    } else {
      const cards = el("div", "team-skill-cards");
      chosen.forEach(({ skill, slot }) => cards.append(renderSkillCard(skill, slot)));
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
      el("h2", "", entry?.name || form.name),
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
    wrapper.append(renderSkillLoadout(member, form, index), renderTraits(form));
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

  function addToTeam(formId) {
    const empty = slotIndexes().find((index) => !model.members[index].formId);
    const slot = empty ?? model.activeSlot;
    model.members[slot] = { ...defaultMember(), formId };
    model.activeSlot = slot;
    persist();
    status = `Added to ${slotRole(slot).toLocaleLowerCase()}.`;
    viewState.page = "team";
    saveViewState();
    render();
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
        quick.append(pick);
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

  function renderMatchups(types) {
    const section = el("section", "team-config-section");
    const heading = el("div", "team-section-heading");
    heading.append(el("div", "", "Matchups"), chipRow(types));
    section.append(heading);
    types.forEach((type) => section.append(matchupBlock(`${element(type).name} defending`, [
      [`Takes ${STRONG}×`, attackersAt(type, STRONG), "weak"],
      [`Takes ${WEAK}×`, attackersAt(type, WEAK), "resist"],
    ])));
    if (types.length > 1) {
      // Facts per element only: the game tables do not say how two defending elements combine.
      const onAll = (multiplier) => elementIds().filter((attacker) => types.every((type) => element(attacker).against[type] === multiplier));
      const mixed = elementIds().filter((attacker) => {
        const values = types.map((type) => element(attacker).against[type]);
        return values.includes(STRONG) && values.includes(WEAK);
      });
      section.append(matchupBlock("Across both elements", [
        [`${STRONG}× on both`, onAll(STRONG), "weak"],
        [`${WEAK}× on both`, onAll(WEAK), "resist"],
        [`${STRONG}× on one, ${WEAK}× on the other`, mixed, "mixed"],
      ]));
      section.append(el("p", "team-data-note", "The game's tables give one multiplier per element pair. How two defending elements combine is decided in battle and isn't in the data, so each element is listed on its own."));
    }
    types.forEach((type) => section.append(matchupBlock(`${element(type).name} attacking`, [
      [`Deals ${STRONG}×`, defendersAt(type, STRONG), "strong"],
      [`Deals ${WEAK}×`, defendersAt(type, WEAK), "resist"],
    ])));
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
          el("strong", "", entry?.name || form.name),
          el("small", "", [entry?.form_label, entry?.role].filter(Boolean).join(" · ")),
          chipRow(form.elements),
        );
        const inTeam = slotIndexes().some((index) => model.members[index].formId === formId);
        const add = button(inTeam ? "In team" : "Add to team", "team-loadout-action", () => addToTeam(formId));
        add.disabled = inTeam;
        card.append(copy, add);
        grid.append(card);
      });
      section.append(grid);
    });
    return section;
  }

  // Per element: which of the team's elements hit it for 1.6x, and which members have an element it hits for 1.6x.
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
    ["Element", `Your ${STRONG}× hits`, `Members it hits ${STRONG}×`].forEach((label) => table.append(el("span", "team-coverage-head", label)));
    elementIds().forEach((id) => {
      const hits = teamTypes.filter((attacker) => element(attacker)?.against[id] === STRONG);
      const exposed = team.filter((row) => row.form.elements.some((type) => element(id).against[String(type)] === STRONG));
      const names = exposed.map((row) => entryForForm(row.member.formId)?.name || row.form.name).join(", ") || "—";
      table.append(elementChip(id), chipRow(hits, "No strong hit"), el("span", exposed.length >= 2 ? "team-coverage-risk" : "", names));
    });
    section.append(table);
    return section;
  }

  function renderTypesPage() {
    const wrapper = el("div", "team-member-configuration");
    const types = viewState.types.filter((type) => element(type));
    const columns = el("div", "team-builder-columns");
    const main = el("div", "team-builder-main-column");
    main.append(renderTypePicker());
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
    [["team", "Team"], ["types", "Type matchups"]].forEach(([id, label]) => {
      const control = button(label, "team-mode-button", () => {
        viewState.page = id;
        saveViewState();
        render();
      });
      control.setAttribute("role", "tab");
      control.setAttribute("aria-selected", String(viewState.page === id));
      group.append(control);
    });
    return group;
  }

  function renderPanel() {
    const panel = host.panel;
    panel.textContent = "";
    const header = el("header", "team-builder-header");
    const copy = el("div");
    const typesPage = viewState.page === "types";
    copy.append(el("h1", "", typesPage ? "Type matchups" : "Team Builder"), el("p", "", typesPage
      ? "See what an element or pair of elements is weak to and strong against, and which Aniimo have that typing."
      : MODE_NOTES[model.mode]));
    const controls = el("div", "team-header-controls");
    controls.append(renderPageSwitch());
    if (!typesPage) controls.append(renderModeSwitch());
    header.append(copy, controls);
    panel.append(header);
    if (typesPage) panel.append(renderTypesPage());
    else panel.append(renderOverview(), renderTeamPage());
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
  }

  window.AniilogsTeamBuilder = Object.freeze({ show });
})();
