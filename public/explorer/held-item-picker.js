// The held-item dropdown shared by the Team Builder (Stats tab, 1v1 sides) and the Aniilog page's Growth table:
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

  // A saved { itemId, level } as the picker uses it: a listed item at its rarity's top level, or null.
  function normalize(data, heldItem) {
    const id = heldItem?.itemId ? String(heldItem.itemId) : "";
    const item = data?.held_item_catalog?.[id];
    if (!id || !isListed(item)) return null;
    return { itemId: id, level: maxLevel(data, item.quality) };
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
        option.textContent = `${item.name} (${rarity}, Lv ${maxLevel(data, item.quality)})${effect ? ` · ${effect}` : ""}`;
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

  // render({ data, formId, itemId, onChange(heldItem | null), label }) -> element.
  function render({ data, formId, itemId, onChange, label = "Held item" }) {
    let current = normalize(data, { itemId })?.itemId || "";
    const field = document.createElement("div");
    field.className = "potential-field held-item-field";
    const head = document.createElement("div");
    head.className = "held-item-head";
    const caption = document.createElement("span");
    caption.className = "potential-field-label";
    caption.textContent = `${label} · top level`;
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = legendaryOnly();
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "held-item-toggle";
    toggleLabel.append(toggle, document.createTextNode("Legendary only"));
    head.append(caption, toggleLabel);
    const pick = (heldItem) => { current = heldItem?.itemId || ""; onChange(heldItem); };
    let control = buildPicker(data, formId, current, toggle.checked, pick, label);
    toggle.addEventListener("change", () => {
      setLegendaryOnly(toggle.checked);
      const next = buildPicker(data, formId, current, toggle.checked, pick, label);
      control.replaceWith(next);
      control = next;
    });
    field.append(head, control);
    return field;
  }

  window.AniilogsHeldItems = Object.freeze({ LEGENDARY, maxLevel, listItems, normalize, describe, legendaryOnly, setLegendaryOnly, render });
})();
