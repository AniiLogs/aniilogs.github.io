import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/explorer/held-item-picker.js", import.meta.url), "utf8");
const store = new Map();
const context = { window: { localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) } } };
vm.createContext(context);
vm.runInContext(source, context);
const H = context.window.AniilogsHeldItems;

// held_item_levels as core_carry_level_data ships it: each level lists the qualities that can reach it.
const levels = Object.fromEntries(Array.from({ length: 15 }, (_, index) => {
  const level = index + 1;
  return [level, { enhance_ratio: level <= 10 ? level * 0.05 : 0.5 + (level - 10) * 0.1, qualities: level <= 5 ? [3, 4, 5] : level <= 10 ? [4, 5] : [5] }];
}));
const data = {
  held_item_levels: levels,
  held_item_catalog: {
    528000: { name: "Test Held Item 1", quality: 3, stats: [], tiers: [] },
    551002: { name: "Ferocious Fang", quality: 3, quality_label: "Rare", stats: [{ label: "Damage Amp", value: 0.03 }], tiers: [] },
    552002: { name: "Ferocious Fang", quality: 4, quality_label: "Epic", stats: [{ label: "Damage Amp", value: 0.05 }],
      tiers: [{ level: 10, need_energy: 0, buffs: [{ attributes: [{ key: "pet_individual_point_atk", label: "ATK potential", value: 2 }] }] }] },
    553002: { name: "Ferocious Fang", quality: 5, quality_label: "Legendary", stats: [{ label: "Damage Amp", value: 0.1 }],
      tiers: [{ level: 10, need_energy: 0, buffs: [{ attributes: [{ key: "pet_individual_point_atk", label: "ATK", value: 2 }] }] }] },
    553020: { name: "Lightning Needle", quality: 5, quality_label: "Legendary", stats: [{ label: "HP", value: 0.1 }], tiers: [] },
  },
  forms: { 7: { recommended: { held_items: [{ tiers: [{ item_id: 553020 }] }] } } },
};

test("held-item picker lists every rarity except test items, the Aniimo's recommended ones first", () => {
  assert.equal(H.listItems(data, "7").map((row) => row.id).join(","), "553020,551002,552002,553002");
  assert.equal(H.listItems(data, "7", { legendaryOnly: true }).map((row) => row.id).join(","), "553020,553002");
  // The current pick stays listed when "Legendary only" is switched on.
  assert.equal(H.listItems(data, "7", { legendaryOnly: true, keepId: "552002" }).map((row) => row.id).join(","), "553020,552002,553002");
});

test("each rarity counts at its own top level (Rare 5, Epic 10, Legendary 15)", () => {
  assert.equal(H.maxLevel(data, 3), 5);
  assert.equal(H.maxLevel(data, 4), 10);
  assert.equal(H.maxLevel(data, 5), 15);
  assert.equal(JSON.stringify(H.normalize(data, { itemId: 551002, level: 1 })), JSON.stringify({ itemId: "551002", level: 5 }));
  assert.equal(JSON.stringify(H.normalize(data, { itemId: 553002, level: 3 })), JSON.stringify({ itemId: "553002", level: 15 }));
  assert.equal(H.normalize(data, { itemId: 528000 }), null);
  assert.equal(H.normalize(data, null), null);
  assert.equal(H.describe(data.held_item_catalog[551002], data), "Damage Amp +3.8%");
  assert.equal(H.describe(data.held_item_catalog[552002], data), "Damage Amp +7.5%, ATK potential +2");
  assert.equal(H.describe(data.held_item_catalog[553002], data), "Damage Amp +20%, ATK potential +2");
});

test("the Legendary-only toggle is remembered", () => {
  assert.equal(H.legendaryOnly(), false);
  H.setLegendaryOnly(true);
  assert.equal(H.legendaryOnly(), true);
  H.setLegendaryOnly(false);
  assert.equal(H.legendaryOnly(), false);
});
