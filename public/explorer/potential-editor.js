// Potential, Star Up and held item for one Aniimo, shared by the Team Builder Stats tab and the 1v1 sides.
// A "build" is { level, potential: { HP, ATK, "P.DEF", REGEN, "M.DEF", BREAK } (or one number for all),
// starUp: { stage, level } | null, heldItem: { itemId, level } | null, personality: [letters] }.
// Each stat's potential is your own (rolled + Capability Awakening, 0-20) plus extra from Star Up and the
// held item's tiers, which go past 20; stats use the total (damage-model.js statTotals).
(() => {
  const STATS = ["HP", "ATK", "P.DEF", "REGEN", "M.DEF", "BREAK"];

  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = text;
    return node;
  }

  const clampInt = (value, min, max, fallback) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };

  // One number (older saves and the 1v1's old field) becomes the same own potential on every stat.
  function ownPotential(value, max = 20) {
    if (value && typeof value === "object") {
      return Object.fromEntries(STATS.map((stat) => [stat, clampInt(value[stat] ?? 0, 0, max, 0)]));
    }
    const all = clampInt(value ?? 0, 0, max, 0);
    return Object.fromEntries(STATS.map((stat) => [stat, all]));
  }

  // statTotals options for a build.
  function totalsOptions(build, cap = 70) {
    return {
      level: clampInt(build?.level ?? cap, 1, cap, cap),
      potential: ownPotential(build?.potential),
      personality: build?.personality || [],
      starUp: build?.starUp?.stage ? { stage: Number(build.starUp.stage), level: Number(build.starUp.level) || 0 } : null,
      heldItems: build?.heldItem?.itemId ? [{ itemId: String(build.heldItem.itemId), level: Number(build.heldItem.level) || 0 }] : [],
      // "Perfect" quality: species points with the property template's bonus (e.g. +15 HP / P.DEF / M.DEF).
      // Inferred: it reproduced a real Lv 65 Perfect Fulmintis card exactly; not shown in the game's code.
      useTemplate: Boolean(build?.perfect),
    };
  }

  function field(labelText, control) {
    const label = el("label", "potential-field");
    label.append(el("span", "potential-field-label", labelText), control);
    return label;
  }

  function numberInput(value, min, max, onChange, ariaLabel) {
    const input = el("input", "potential-number");
    input.type = "number";
    input.inputMode = "numeric";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    if (ariaLabel) input.setAttribute("aria-label", ariaLabel);
    input.addEventListener("change", () => onChange(clampInt(input.value, min, max, value)));
    return input;
  }

  function selectInput(options, value, onChange, ariaLabel) {
    const select = el("select", "potential-select");
    if (ariaLabel) select.setAttribute("aria-label", ariaLabel);
    for (const option of options) {
      if (option.group) {
        const group = el("optgroup");
        group.label = option.group;
        option.items.forEach((item) => group.append(optionNode(item, value)));
        select.append(group);
      } else {
        select.append(optionNode(option, value));
      }
    }
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  function optionNode(item, value) {
    const node = el("option", "", item.label);
    node.value = String(item.value);
    node.selected = String(item.value) === String(value ?? "");
    if (item.search) node.dataset.search = item.search;
    return node;
  }

  // render({ data, aniilog, formId, build, onChange(nextBuild), totals }) -> element. `totals` is the
  // statTotals result for this build, so the breakdown shows where each stat's potential comes from.
  function render({ data, aniilog, formId, build, onChange, totals }) {
    const growth = aniilog?.stat_growth;
    const maxOwn = Number(growth?.attribute_points_max) || 20;
    const own = ownPotential(build?.potential, maxOwn);
    const update = (patch) => onChange({ ...build, ...patch });
    const box = el("div", "potential-editor");

    // Star Up stage and level (pet_resonance_property_data), and the held item with its level.
    const stages = Object.keys(data?.star_up || {}).map(Number).sort((a, b) => a - b);
    const stage = Number(build?.starUp?.stage) || 0;
    const stageLevels = stage ? Object.keys(data.star_up[stage] || {}).map(Number).sort((a, b) => a - b) : [];
    const sources = el("div", "potential-sources");
    sources.append(field("Star Up", selectInput([{ value: 0, label: "None" }, ...stages.map((value) => ({ value, label: `Stage ${value}` }))],
      stage, (value) => update({ starUp: Number(value) ? { stage: Number(value), level: 0 } : null }), "Star Up stage")));
    if (stageLevels.length > 1) {
      sources.append(field("Star Up level", selectInput(stageLevels.map((value) => ({ value, label: `Level ${value}` })),
        Number(build.starUp.level) || 0, (value) => update({ starUp: { stage, level: Number(value) } }), "Star Up level")));
    }
    const catalog = Object.entries(data?.held_item_catalog || {});
    const recommended = new Set((data?.forms?.[formId]?.recommended?.held_items || []).flatMap((item) => item.tiers.map((tier) => String(tier.item_id))));
    const itemOption = ([id, item]) => ({ value: id, label: `${item.name} (${item.quality_label || `quality ${item.quality}`})`,
      search: item.stats.map((stat) => stat.label).join(" ") });
    const itemOptions = [{ value: "", label: "No held item" }];
    const mine = catalog.filter(([id]) => recommended.has(id));
    if (mine.length) itemOptions.push({ group: "Recommended for this Aniimo", items: mine.map(itemOption) });
    itemOptions.push({ group: "All held items", items: catalog.filter(([id]) => !recommended.has(id)).map(itemOption) });
    const itemSelect = selectInput(itemOptions, build?.heldItem?.itemId || "",
      (value) => update({ heldItem: value ? { itemId: value, level: build?.heldItem?.level || 0 } : null }), "Held item");
    const picker = window.AniilogsPicker?.enhance(itemSelect, { placeholder: "Type an item name or stat" });
    sources.append(field("Held item", picker?.wrap || itemSelect));
    if (build?.heldItem?.itemId) {
      const levels = Object.keys(data?.held_item_levels || {}).map(Number).filter(Number.isFinite);
      const maxLevel = levels.length ? Math.max(...levels) : 15;
      sources.append(field(`Item level (0–${maxLevel})`, numberInput(build.heldItem.level || 0, 0, maxLevel,
        (value) => update({ heldItem: { ...build.heldItem, level: value } }), "Held item level")));
    }
    const perfect = el("input");
    perfect.type = "checkbox";
    perfect.checked = Boolean(build?.perfect);
    perfect.addEventListener("change", () => update({ perfect: perfect.checked }));
    const perfectLabel = el("label", "potential-check");
    perfectLabel.title = "Adds the species bonus the game keeps for this Aniimo's quality. It matched a real Perfect Fulmintis card; not confirmed in the game's code.";
    perfectLabel.append(perfect, el("span", "", "Perfect quality"));
    sources.append(perfectLabel);
    box.append(sources);

    // Per stat: your own potential (0-20) and what Star Up and the held item add on top.
    const table = el("table", "potential-table");
    const head = el("tr");
    ["Stat", `Own (0–${maxOwn})`, "Star Up", "Item", "Total"].forEach((text) => head.append(el("th", "", text)));
    table.append(el("thead"), el("tbody"));
    table.tHead.append(head);
    for (const stat of STATS) {
      const parts = totals?.potential?.[stat] || { own: own[stat], star_up: 0, held_items: 0, other: 0, total: own[stat] };
      const row = el("tr");
      const ownCell = el("td");
      ownCell.append(numberInput(own[stat], 0, maxOwn, (value) => update({ potential: { ...own, [stat]: value } }), `${stat} potential`));
      const extra = (value) => el("td", value ? "potential-extra" : "potential-none", value ? `+${value}` : "–");
      row.append(el("th", "", stat), ownCell, extra(parts.star_up), extra(parts.held_items + (parts.other || 0)), el("td", "potential-total", String(parts.total)));
      table.tBodies[0].append(row);
    }
    box.append(table, el("p", "potential-note",
      "Own = rolled at capture plus Capability Awakening, up to 20 per stat. Star Up and held items add extra potential on top of that cap. Stats use the total."));
    return box;
  }

  window.AniilogsPotentialEditor = Object.freeze({ STATS, ownPotential, totalsOptions, render });
})();
