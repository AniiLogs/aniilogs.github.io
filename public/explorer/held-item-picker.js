// game-audit: unaudited held-item catalog and top levels per rarity (core_carry_level_data needQuality)
// The held-item dropdown shared by the Team Builder (Build tab, 1v1 sides) and the Aniilog page's Growth table:
// every held item an Aniimo can equip (team_builder_data.json held_item_catalog), each rarity at its own top
// level, with a remembered "Legendary only" toggle. Type-to-filter through aniimo-picker.js; the items the game
// recommends for the Aniimo come first. What an item adds is worked out by damage-model.js statTotals (heldItems).
(() => {
  const LEGENDARY = 5;
  const STORAGE_KEY = "aniilogs:held-items:legendary-only";
  // Test rows the client ships (e.g. "Test Held Item 1"); never shown.
  const TEST_NAME = /^Test Held Item\s*#?\s*\d+$/iu;

  const isListed = (item) => Boolean(item) && !TEST_NAME.test(String(item.name || "").trim());

  // The highest item level a rarity can reach: core_carry_level_data's needQuality lists the qualities each
  // level allows (PetAttributeCalcUtils.getCoreCarryLevel), so Rare stops at 5, Epic at 10, Legendary at 15.
  function maxLevel(data, quality = LEGENDARY) {
    const levels = Object.entries(data?.held_item_levels || {})
      .filter(([, row]) => !Array.isArray(row?.qualities) || row.qualities.includes(Number(quality)))
      .map(([level]) => Number(level)).filter(Number.isFinite);
    return levels.length ? Math.max(...levels) : 15;
  }

  // [{ id, item, recommended }]: recommended first, then by name and rarity. legendaryOnly keeps Legendary
  // items plus keepId (the item already chosen), so switching the toggle never hides the current pick.
  function listItems(data, formId, { legendaryOnly = false, keepId = "" } = {}) {
    const recommended = new Set((data?.forms?.[formId]?.recommended?.held_items || [])
      .flatMap((group) => group.tiers.map((tier) => String(tier.item_id))));
    return Object.entries(data?.held_item_catalog || {})
      .filter(([id, item]) => isListed(item) && (!legendaryOnly || Number(item.quality) === LEGENDARY || id === String(keepId)))
      .map(([id, item]) => ({ id, item, recommended: recommended.has(id) }))
      .sort((a, b) => Number(b.recommended) - Number(a.recommended) || String(a.item.name).localeCompare(String(b.item.name))
        || Number(a.item.quality) - Number(b.item.quality));
  }

  // A saved { itemId, level } as the picker uses it, or null: a listed item at its level, kept between 0 (a new
  // item: level 1 takes 100 exp, core_carry_level_data) and its rarity's top level; no level means the top level.
  function normalize(data, heldItem) {
    const id = heldItem?.itemId ? String(heldItem.itemId) : "";
    const item = data?.held_item_catalog?.[id];
    if (!id || !isListed(item)) return null;
    const top = maxLevel(data, item.quality);
    const raw = heldItem.level;
    const level = raw === undefined || raw === null || raw === "" || !Number.isFinite(Number(raw))
      ? top : Math.min(top, Math.max(0, Math.round(Number(raw))));
    return { itemId: id, level };
  }

  // The form ids in formId's evolution line: aniilog entries' evolution.from / .to ("aniimo:<form id>"), and
  // the other forms of each species there (same base_id; a Prismana form lists no evolution of its own).
  function evolutionLine(aniilog, formId) {
    const links = new Map();
    const link = (a, b) => {
      if (!links.has(a)) links.set(a, new Set());
      links.get(a).add(b);
    };
    const species = new Map();
    for (const entry of aniilog?.entries || []) {
      if (entry.base_id === undefined || entry.base_id === null) continue;
      const id = String(entry.form_id);
      const first = species.get(String(entry.base_id));
      if (first) { link(id, first); link(first, id); } else species.set(String(entry.base_id), id);
    }
    for (const entry of aniilog?.entries || []) {
      const id = String(entry.form_id);
      for (const other of [...(entry.evolution?.from || []), ...(entry.evolution?.to || [])]) {
        const otherId = String(other?.id || "").replace(/^aniimo:/u, "");
        if (otherId) { link(id, otherId); link(otherId, id); }
      }
    }
    const line = new Set([String(formId)]);
    const queue = [String(formId)];
    while (queue.length) {
      for (const next of links.get(queue.shift()) || []) if (!line.has(next)) { line.add(next); queue.push(next); }
    }
    return line;
  }

  // The held item an Aniimo has until you pick one, as { itemId, level } at its top level, or null: its signature
  // item (one the game recommends only within this Aniimo's evolution line, e.g. Irisalis' Floral Rainbow
  // Feather), else the game's first recommended item. The Legendary version where there is one.
  function defaultFor(data, aniilog, formId) {
    const groups = data?.forms?.[formId]?.recommended?.held_items || [];
    if (!groups.length) return null;
    const line = evolutionLine(aniilog, formId);
    const recommendedBy = (group) => Object.entries(data.forms)
      .filter(([, form]) => (form.recommended?.held_items || []).some((other) => other.name === group.name))
      .map(([id]) => id);
    const signature = groups.find((group) => recommendedBy(group).every((id) => line.has(id)));
    for (const group of signature ? [signature, ...groups] : groups) {
      const tiers = [...(group.tiers || [])].sort((a, b) => Number(b.quality) - Number(a.quality));
      for (const tier of tiers) {
        const held = normalize(data, { itemId: tier.item_id });
        if (held) return held;
      }
    }
    return null;
  }

  // The held item a build uses: the one picked, none when "no held item" was picked (null), and the default
  // above while nothing has been picked (undefined).
  function chosen(data, aniilog, formId, heldItem) {
    if (heldItem === undefined) return defaultFor(data, aniilog, formId);
    return normalize(data, heldItem);
  }

  function legendaryOnly() {
    try { return window.localStorage?.getItem(STORAGE_KEY) === "1"; } catch { return false; }
  }

  function setLegendaryOnly(value) {
    try { window.localStorage?.setItem(STORAGE_KEY, value ? "1" : "0"); } catch { /* the toggle still works for this page */ }
  }

  // Per-pet-level conversions (propConversions "level" -> <attr>_conv), by the stat they add to.
  const CONVERSION_LABELS = Object.freeze({
    hp_max_conv: "HP", atk_conv: "ATK", def_conv: "P.DEF", def_mag_conv: "M.DEF", ep_regen_force_conv: "REGEN", bp_atk_conv: "BREAK",
  });

  // What the item shows in the list and searches by, at its top level: stats (x (1 + enhance ratio)),
  // per-level gains and the potential its tiers add.
  function describe(item, data = null) {
    const level = data ? maxLevel(data, item.quality) : 0;
    const ratio = data?.held_item_levels?.[level]?.enhance_ratio || 0;
    const parts = item.stats.map((stat) => `${stat.label} +${Math.round(stat.value * (1 + ratio) * 1000) / 10}%`);
    for (const row of item.conversions || []) {
      if (row.from === "level" && CONVERSION_LABELS[row.key]) parts.push(`${CONVERSION_LABELS[row.key]} +${row.rate} per level`);
    }
    for (const tier of item.tiers || []) {
      if (data && (tier.level > level || tier.need_energy)) continue;
      for (const buff of tier.buffs || []) {
        for (const attribute of buff.attributes || []) {
          if (!attribute.key.startsWith("pet_individual_point_") || !attribute.value) continue;
          const label = /potential/iu.test(attribute.label) ? attribute.label : `${attribute.label} potential`;
          parts.push(`${label} +${attribute.value}`);
        }
      }
    }
    return parts.join(", ");
  }

  function buildPicker(data, formId, itemId, onlyLegendary, onChange, label) {
    const select = document.createElement("select");
    select.className = "potential-select";
    select.setAttribute("aria-label", label);
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No held item";
    select.append(none);
    const items = listItems(data, formId, { legendaryOnly: onlyLegendary, keepId: itemId });
    const others = onlyLegendary ? "Legendary held items" : "All held items";
    for (const [title, rows] of [["Recommended for this Aniimo", items.filter((row) => row.recommended)], [others, items.filter((row) => !row.recommended)]]) {
      if (!rows.length) continue;
      const group = document.createElement("optgroup");
      group.label = title;
      for (const { id, item } of rows) {
        const option = document.createElement("option");
        option.value = id;
        const rarity = item.quality_label || `quality ${item.quality}`;
        const effect = describe(item, data);
        option.textContent = `${item.name} (${rarity}, up to Lv ${maxLevel(data, item.quality)})${effect ? ` · ${effect}` : ""}`;
        option.dataset.search = item.stats.map((stat) => stat.label).join(" ");
        group.append(option);
      }
      select.append(group);
    }
    select.value = normalize(data, { itemId })?.itemId || "";
    select.addEventListener("change", () => onChange(normalize(data, { itemId: select.value })));
    const picker = window.AniilogsPicker?.enhance(select, { placeholder: "Type an item name, rarity or stat", emptyText: "No held item matches" });
    return picker?.wrap || select;
  }

  // The item level control: 0 up to the item's rarity's top level (Rare 5, Epic 10, Legendary 15).
  function buildLevel(data, held, onChange, label) {
    const select = document.createElement("select");
    select.className = "potential-select held-item-level";
    select.setAttribute("aria-label", `${label} level`);
    const item = held ? data?.held_item_catalog?.[held.itemId] : null;
    const top = item ? maxLevel(data, item.quality) : 0;
    for (let level = 0; level <= top; level += 1) {
      const option = document.createElement("option");
      option.value = String(level);
      option.textContent = `Lv ${level}`;
      select.append(option);
    }
    select.value = String(held?.level ?? 0);
    select.disabled = !held;
    select.addEventListener("change", () => onChange(Number(select.value)));
    return select;
  }

  // render({ data, formId, itemId, level, onChange(heldItem | null), label }) -> element. A new item starts at its
  // top level; the level control changes it.
  function render({ data, formId, itemId, level, onChange, label = "Held item" }) {
    let held = normalize(data, { itemId, level });
    let current = held?.itemId || "";
    const field = document.createElement("div");
    field.className = "potential-field held-item-field";
    const head = document.createElement("div");
    head.className = "held-item-head";
    const caption = document.createElement("span");
    caption.className = "potential-field-label";
    caption.textContent = label;
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = legendaryOnly();
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "held-item-toggle";
    toggleLabel.append(toggle, document.createTextNode("Legendary only"));
    head.append(caption, toggleLabel);
    const row = document.createElement("div");
    row.className = "held-item-row";
    let levelControl = null;
    const setLevel = (value) => {
      held = normalize(data, { itemId: current, level: value });
      onChange(held);
    };
    const showLevel = () => {
      const next = buildLevel(data, held, setLevel, label);
      if (levelControl) levelControl.replaceWith(next);
      else row.append(next);
      levelControl = next;
    };
    const pick = (heldItem) => {
      held = heldItem;
      current = heldItem?.itemId || "";
      showLevel();
      onChange(heldItem);
    };
    let control = buildPicker(data, formId, current, toggle.checked, pick, label);
    row.append(control);
    showLevel();
    toggle.addEventListener("change", () => {
      setLegendaryOnly(toggle.checked);
      const next = buildPicker(data, formId, current, toggle.checked, pick, label);
      control.replaceWith(next);
      control = next;
    });
    field.append(head, row);
    return field;
  }

  window.AniilogsHeldItems = Object.freeze({ LEGENDARY, maxLevel, listItems, normalize, defaultFor, chosen, describe, legendaryOnly, setLegendaryOnly, render });
})();
