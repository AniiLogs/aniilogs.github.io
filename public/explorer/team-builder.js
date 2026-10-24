(() => {
  "use strict";

  // Team Builder: skill loadouts, how each skill works, and team synergy, from the reviewed
  // team_builder_data.json release file (skills, traits and buffs traced from the game tables).
  // The explorer mounts it with show({ sidebar, panel, loadAniilog, contentUrl, dataUrl }).
  const STORAGE_KEY = "aniilogs:team-builder:v1";
  const LOADOUT_FILE_FORMAT = "aniilogs-team-loadout";
  const LOADOUT_FILE_VERSION = 1;
  const MAX_LOCAL_LOADOUTS = 50;
  const MAX_LOADOUT_FILE_BYTES = 256 * 1024;
  const SHARE_HASH_KEY = "t";
  const TEAM_SIZE = 4;
  const MAX_ACTIVE_SKILLS = 2;
  const MODES = Object.freeze([
    Object.freeze({ id: "standard", label: "Standard" }),
    Object.freeze({ id: "coop", label: "Co-op" }),
  ]);
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

  function defaultMember() {
    return { formId: "", activeSkills: ["", ""], switchSkill: "", ultimateSkill: "" };
  }

  function defaultModel() {
    return {
      mode: "standard",
      activeSlot: 0,
      members: Array.from({ length: TEAM_SIZE }, defaultMember),
      scenario: {},
    };
  }

  function normalizeMember(value) {
    const activeSkills = Array.isArray(value?.activeSkills)
      ? value.activeSkills.slice(0, MAX_ACTIVE_SKILLS).map((skill) => String(skill || ""))
      : [];
    while (activeSkills.length < MAX_ACTIVE_SKILLS) activeSkills.push("");
    return {
      formId: String(value?.formId || ""),
      activeSkills,
      switchSkill: String(value?.switchSkill || ""),
      ultimateSkill: String(value?.ultimateSkill || ""),
    };
  }

  function normalizeModel(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaultModel();
    const members = Array.isArray(value.members) ? value.members.slice(0, TEAM_SIZE).map(normalizeMember) : [];
    while (members.length < TEAM_SIZE) members.push(defaultMember());
    const scenario = value.scenario && typeof value.scenario === "object" && !Array.isArray(value.scenario)
      ? Object.fromEntries(Object.entries(value.scenario).slice(0, 500).map(([key, enabled]) => [String(key), Boolean(enabled)]))
      : {};
    return {
      mode: value.mode === "coop" ? "coop" : "standard",
      activeSlot: Math.min(TEAM_SIZE - 1, Math.max(0, Math.round(Number(value.activeSlot) || 0))),
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
      m: model.mode === "coop" ? "c" : "s",
      t: model.members.map((member) => [member.formId, ...member.activeSkills, member.switchSkill, member.ultimateSkill]),
    };
  }

  function modelFromPayload(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.t)) throw new Error("This team link or file is not valid.");
    return normalizeModel({
      mode: payload.m === "c" ? "coop" : "standard",
      members: payload.t.slice(0, TEAM_SIZE).map((row) => (Array.isArray(row) ? {
        formId: row[0],
        activeSkills: [row[1], row[2]],
        switchSkill: row[3],
        ultimateSkill: row[4],
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
    const switchSkill = skillFor(form, member.switchSkill);
    if (!switchSkill?.core || member.activeSkills.includes(member.switchSkill)) member.switchSkill = "";
    if (!skillsOf(form, "ultimate").some((skill) => String(skill.id) === member.ultimateSkill)) member.ultimateSkill = "";
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
    if (model.mode !== "coop") return `Team slot ${index + 1}`;
    return index === 0 ? "Main Aniimo" : `Core skill ally ${index}`;
  }

  function memberSkills(member, index) {
    const form = formFor(member);
    if (!form) return [];
    if (model.mode === "coop" && index > 0) {
      return skillsOf(form, "skill").filter((skill) => skill.core).map((skill) => ({ skill, slot: "Core skill" }));
    }
    const rows = member.activeSkills.map((id) => skillFor(form, id)).filter(Boolean).map((skill) => ({ skill, slot: "Active" }));
    const switchSkill = skillFor(form, member.switchSkill);
    if (switchSkill) rows.push({ skill: switchSkill, slot: "Switch-skill" });
    const ultimate = skillFor(form, member.ultimateSkill);
    if (ultimate) rows.push({ skill: ultimate, slot: "Ultimate" });
    return rows;
  }

  // --- How a skill works ----------------------------------------------------------------------

  // Unnamed buffs that change no stat are internal states (dodge windows, hit checks).
  function isInternal(id) {
    const detail = buff(id);
    return !detail || (!detail.name && !detail.attributes?.length);
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
    if (skill.upgrade) {
      const upgrade = el("details", "team-skill-description");
      upgrade.append(el("summary", "", `Upgraded: ${skill.upgrade.name}`));
      if (skill.upgrade.description) upgrade.append(el("p", "", skill.upgrade.description));
      upgrade.append(renderMechanics(skill.upgrade));
      copy.append(upgrade);
    }
    card.append(copy);
    return card;
  }

  // --- Team synergy ---------------------------------------------------------------------------

  // Every buff and ally-side operation the team's chosen skills and traits put out, with whether it
  // can reach the selected Aniimo (the one being built around).
  function synergyEffects() {
    const effects = [];
    const focus = model.activeSlot;
    model.members.forEach((member, index) => {
      const form = formFor(member);
      if (!form) return;
      const source = formLabel(entryForForm(member.formId), form);
      const consider = (origin, kind, links, operations = []) => {
        links.forEach((link) => {
          const detail = buff(link.id);
          if (!detail || isInternal(link.id)) return;
          let reach = "";
          if (["ally", "active Aniimo", "player"].includes(link.on)) reach = link.on === "player" ? "player" : "team";
          else if (link.on === "self") reach = detail.carries_over_on_switch ? "switch" : index === focus ? "self" : "";
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

  const REACH_GROUPS = Object.freeze([
    { id: "team", label: "Team buffs and heals" },
    { id: "switch", label: "Carries over when you switch" },
    { id: "enemy", label: "Enemy debuffs" },
    { id: "self", label: "Selected Aniimo's own buffs" },
    { id: "player", label: "Player buffs" },
  ]);

  function renderScenario() {
    const section = el("section", "team-scenario");
    const effects = synergyEffects();
    const enabled = effects.filter((effect) => model.scenario[effect.key]);
    const heading = el("div", "team-section-heading");
    heading.append(el("div", "", "Team synergy"), el("small", "", `${enabled.length} of ${effects.length} on`));
    section.append(heading);
    const focus = formFor(model.members[model.activeSlot]);
    section.append(el("p", "team-section-copy", focus
      ? `Effects your team can put on ${formLabel(entryForForm(model.members[model.activeSlot].formId), focus)}. Switch on the ones active in the fight you want to model.`
      : "Choose team members and skills to see the effects they share."));
    if (!effects.length) {
      if (focus) section.append(el("p", "team-empty-copy", "No shared effects from the current picks."));
    }
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
      const facts = [`On ${WHO_LABELS[effect.link.on] || effect.link.on}`];
      const duration = effect.link.duration ?? effect.detail.duration;
      if (Number(duration) > 0) facts.push(`${formatNumber(duration)}s`);
      if (effect.detail.carries_over_on_switch) facts.push("Carries over on switch");
      copy.append(el("span", "team-synergy-scope", facts.join(" · ")));
      if (effect.detail.description) copy.append(el("span", "team-synergy-description", effect.detail.description));
      const values = effect.detail.attributes.filter((attribute) => attribute.values?.length)
        .map((attribute) => `${attribute.label} ${formatValues(attribute.key, attribute.values)}${attribute.per_stack ? " per stack" : ""}`);
      if (values.length) copy.append(el("span", "team-synergy-note", values.join(" · ")));
    } else {
      const value = [formatValues(effect.operation.key, effect.operation.values), ...(effect.operation.formulas || [])].filter(Boolean).join(" · ");
      copy.append(el("span", "team-synergy-scope", `On ${WHO_LABELS[effect.operation.on] || effect.operation.on}`));
      if (value) copy.append(el("span", "team-synergy-note", value));
    }
    label.append(input, copy);
    return label;
  }

  // Sum of the switched-on buffs' configured values, per game attribute (first level, one stack).
  function renderEnabledTotals(enabled) {
    const totals = new Map();
    enabled.forEach((effect) => {
      (effect.detail?.attributes || []).forEach((attribute) => {
        const value = Number(attribute.values?.[0]);
        if (!Number.isFinite(value)) return;
        const current = totals.get(attribute.key) || { label: attribute.label, key: attribute.key, value: 0, perStack: false };
        current.value += value;
        current.perStack ||= Boolean(attribute.per_stack);
        totals.set(attribute.key, current);
      });
    });
    const section = el("div", "team-damage-preview");
    section.append(el("p", "team-eyebrow", "Switched-on modifiers"));
    if (!totals.size) {
      section.append(el("p", "", "The switched-on effects have no configured stat values (heals and timed effects are listed above)."));
      return section;
    }
    const list = el("dl", "team-skill-coefficients");
    totals.forEach((total) => list.append(
      el("dt", "", total.label),
      el("dd", "", `${formatValues(total.key, [total.value])}${total.perStack ? " (one stack each)" : ""}`),
    ));
    section.append(list, el("p", "", "Added up per stat as configured; whether they stack in combat is up to the game."));
    return section;
  }

  // --- Layout ---------------------------------------------------------------------------------

  function renderModeSwitch(compact = false) {
    const group = el("div", compact ? "team-mode-switch team-mode-switch--compact" : "team-mode-switch");
    group.setAttribute("role", "tablist");
    MODES.forEach((mode) => {
      const control = button(mode.label, "team-mode-button", () => {
        model.mode = mode.id;
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
    aniimoOptions().forEach((option) => {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      item.selected = option.value === member.formId;
      select.append(item);
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
    sidebar.append(el("p", "team-sidebar-description", model.mode === "coop"
      ? "Control one main Aniimo and bring the Core skills of three allies."
      : "Build a four-Aniimo team with two active skills, an optional Core switch-skill, and an Ultimate each."));
    const slots = el("div", "team-sidebar-slots");
    model.members.forEach((member, index) => slots.append(renderSidebarSlot(member, index)));
    const shareWrap = el("div", "team-share-wrap");
    shareWrap.append(button("Copy team link", "team-share-button", shareTeam));
    if (status) shareWrap.append(el("p", "team-share-status", status));
    sidebar.append(slots, shareWrap);
  }

  function renderOverview() {
    const section = el("section", "team-overview");
    const heading = el("div", "team-section-heading");
    heading.append(el("div", "", "Team overview"), el("small", "", model.mode === "coop" ? "1 main + 3 Core allies" : "Up to 4 Aniimo"));
    const grid = el("div", "team-overview-grid");
    model.members.forEach((member, index) => {
      const form = formFor(member);
      const entry = entryForForm(member.formId);
      const card = button("", "team-overview-card", () => {
        model.activeSlot = index;
        persist();
        render();
      });
      if (model.activeSlot === index) card.classList.add("is-active");
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
    const supportOnly = model.mode === "coop" && index > 0;
    heading.append(el("div", "", supportOnly ? "Core skills brought to the team" : "Skill loadout"));
    section.append(heading);
    if (!supportOnly) {
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
      const cores = skillsOf(form, "skill").filter((skill) => skill.core && !member.activeSkills.includes(String(skill.id)));
      grid.append(selectControl("Switch-skill (Core)", [
        { value: "", label: skillsOf(form, "skill").some((skill) => skill.core) ? "No switch-skill" : "No Core skill" },
        ...cores.map((skill) => ({ value: String(skill.id), label: skill.name })),
      ], member.switchSkill, (value) => {
        member.switchSkill = value;
        validateMember(member);
        persist();
        render();
      }, "team-field--wide"));
      const ultimates = skillsOf(form, "ultimate");
      grid.append(selectControl("Ultimate", [
        { value: "", label: ultimates.length ? "Choose an Ultimate" : "No Ultimate" },
        ...ultimates.map((skill) => ({ value: String(skill.id), label: skill.name })),
      ], member.ultimateSkill, (value) => {
        member.ultimateSkill = value;
        persist();
        render();
      }, "team-field--wide"));
      section.append(grid);
    }
    const chosen = memberSkills(member, index);
    if (!chosen.length) {
      section.append(el("p", "team-empty-copy", supportOnly ? "This Aniimo has no Core skill." : "Choose skills to see how they work."));
    } else {
      const cards = el("div", "team-skill-cards");
      chosen.forEach(({ skill, slot }) => cards.append(renderSkillCard(skill, slot)));
      section.append(cards);
    }
    const normal = skillsOf(form, "normal")[0];
    if (normal && !supportOnly) {
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
      el("p", "team-member-meta", [entry?.form_label, entry?.role, ...(entry?.elements || []).map((element) => element?.name || element)]
        .filter((part) => typeof part === "string" && part).join(" · ")),
    );
    identity.append(copy);
    wrapper.append(identity);
    const columns = el("div", "team-builder-columns");
    const main = el("div", "team-builder-main-column");
    main.append(renderSkillLoadout(member, form, index), renderTraits(form));
    columns.append(main, renderScenario());
    wrapper.append(columns);
    return wrapper;
  }

  function renderPanel() {
    const panel = host.panel;
    panel.textContent = "";
    const header = el("header", "team-builder-header");
    const copy = el("div");
    copy.append(el("h1", "", "Team Builder"), el("p", "", model.mode === "coop"
      ? "Configure one controlled Aniimo and the Core skills your three allies bring."
      : "Pick four Aniimo and their skills, see how each skill works, and model the effects they share."));
    header.append(copy, renderModeSwitch());
    panel.append(header, renderOverview(), renderMember(model.members[model.activeSlot], model.activeSlot));
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
