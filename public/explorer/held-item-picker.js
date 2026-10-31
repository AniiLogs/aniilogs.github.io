// The held-item dropdown shared by the Team Builder (Stats tab, 1v1 sides) and the Aniilog page's Growth table:
// Legendary held items only, always at the top item level (team_builder_data.json held_item_catalog and
// held_item_levels). Type-to-filter through aniimo-picker.js; the items the game recommends for the Aniimo
// come first. What an item adds is worked out by damage-model.js statTotals (heldItems).
(() => {
  const LEGENDARY = 5;

  function maxLevel(data) {
    const levels = Object.keys(data?.held_item_levels || {}).map(Number).filter(Number.isFinite);
    return levels.length ? Math.max(...levels) : 15;
  }

  // [{ id, item, recommended }], recommended first, then by name.
  function legendaryItems(data, formId) {
    const recommended = new Set((data?.forms?.[formId]?.recommended?.held_items || [])
      .flatMap((group) => group.tiers.map((tier) => String(tier.item_id))));
    return Object.entries(data?.held_item_catalog || {})
      .filter(([, item]) => Number(item.quality) === LEGENDARY)
      .map(([id, item]) => ({ id, item, recommended: recommended.has(id) }))
      .sort((a, b) => Number(b.recommended) - Number(a.recommended) || String(a.item.name).localeCompare(String(b.item.name)));
  }

  // A saved { itemId, level } as the picker uses it: a Legendary item at the top level, or null.
  function normalize(data, heldItem) {
    const id = heldItem?.itemId ? String(heldItem.itemId) : "";
    if (!id || Number(data?.held_item_catalog?.[id]?.quality) !== LEGENDARY) return null;
    return { itemId: id, level: maxLevel(data) };
  }

  // Per-pet-level conversions (propConversions "level" -> <attr>_conv), by the stat they add to.
  const CONVERSION_LABELS = Object.freeze({
    hp_max_conv: "HP", atk_conv: "ATK", def_conv: "P.DEF", def_mag_conv: "M.DEF", ep_regen_force_conv: "REGEN", bp_atk_conv: "BREAK",
  });

  // What the item shows in the list and searches by: its stats, per-level gains and the potential its tiers add.
  function describe(item) {
    const parts = item.stats.map((stat) => `${stat.label} +${Math.round(stat.value * 1000) / 10}%`);
    for (const row of item.conversions || []) {
      if (row.from === "level" && CONVERSION_LABELS[row.key]) parts.push(`${CONVERSION_LABELS[row.key]} +${row.rate} per level`);
    }
    for (const tier of item.tiers || []) {
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

  // render({ data, formId, itemId, onChange(heldItem | null), label }) -> element.
  function render({ data, formId, itemId, onChange, label = "Held item" }) {
    const top = maxLevel(data);
    const select = document.createElement("select");
    select.className = "potential-select";
    select.setAttribute("aria-label", `${label} (Legendary, level ${top})`);
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No held item";
    select.append(none);
    const items = legendaryItems(data, formId);
    for (const [title, rows] of [["Recommended for this Aniimo", items.filter((row) => row.recommended)], ["Legendary held items", items.filter((row) => !row.recommended)]]) {
      if (!rows.length) continue;
      const group = document.createElement("optgroup");
      group.label = title;
      for (const { id, item } of rows) {
        const option = document.createElement("option");
        option.value = id;
        const effect = describe(item);
        option.textContent = effect ? `${item.name} · ${effect}` : item.name;
        option.dataset.search = item.stats.map((stat) => stat.label).join(" ");
        group.append(option);
      }
      select.append(group);
    }
    select.value = normalize(data, { itemId })?.itemId || "";
    select.addEventListener("change", () => onChange(select.value ? { itemId: select.value, level: top } : null));
    const picker = window.AniilogsPicker?.enhance(select, { placeholder: "Type an item name or stat" });
    const field = document.createElement("label");
    field.className = "potential-field held-item-field";
    const caption = document.createElement("span");
    caption.className = "potential-field-label";
    caption.textContent = `${label} · Legendary, Lv ${top}`;
    field.append(caption, picker?.wrap || select);
    return field;
  }

  window.AniilogsHeldItems = Object.freeze({ LEGENDARY, maxLevel, legendaryItems, normalize, describe, render });
})();
