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
  // The level picked is kept (0 = a new item), held to the rarity's top level; no level means the top level.
  assert.equal(JSON.stringify(H.normalize(data, { itemId: 551002, level: 1 })), JSON.stringify({ itemId: "551002", level: 1 }));
  assert.equal(JSON.stringify(H.normalize(data, { itemId: 551002, level: 9 })), JSON.stringify({ itemId: "551002", level: 5 }));
  assert.equal(JSON.stringify(H.normalize(data, { itemId: 553002, level: 3 })), JSON.stringify({ itemId: "553002", level: 3 }));
  assert.equal(JSON.stringify(H.normalize(data, { itemId: 553002, level: 0 })), JSON.stringify({ itemId: "553002", level: 0 }));
  assert.equal(JSON.stringify(H.normalize(data, { itemId: 553002, level: -2 })), JSON.stringify({ itemId: "553002", level: 0 }));
  assert.equal(JSON.stringify(H.normalize(data, { itemId: 553002, level: 20 })), JSON.stringify({ itemId: "553002", level: 15 }));
  assert.equal(JSON.stringify(H.normalize(data, { itemId: 553002 })), JSON.stringify({ itemId: "553002", level: 15 }));
  assert.equal(JSON.stringify(H.normalize(data, { itemId: 553002, level: null })), JSON.stringify({ itemId: "553002", level: 15 }));
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

test("until one is picked, an Aniimo holds its signature item, else the game's first recommended one, at Legendary", () => {
  const fang = { name: "Ferocious Fang", tiers: [{ item_id: 551002, quality: 3 }, { item_id: 552002, quality: 4 }, { item_id: 553002, quality: 5 }] };
  const needle = { name: "Lightning Needle", tiers: [{ item_id: 553020, quality: 5 }] };
  const team = {
    ...data,
    forms: {
      1: { recommended: { held_items: [fang, needle] } }, // Needle recommended only in this line: its signature item
      2: { recommended: { held_items: [fang, needle] } }, // evolves from 1
      3: { recommended: { held_items: [fang] } },
      4: { recommended: { held_items: [] } },
    },
  };
  const aniilog = { entries: [
    { form_id: 1, evolution: { from: [], to: [{ id: "aniimo:2" }] } },
    { form_id: 2, evolution: { from: [{ id: "aniimo:1" }], to: [] } },
    { form_id: 3, evolution: { from: [], to: [] } },
  ] };
  const json = (value) => JSON.stringify(value);
  assert.equal(json(H.defaultFor(team, aniilog, "1")), json({ itemId: "553020", level: 15 }));
  assert.equal(json(H.defaultFor(team, aniilog, "2")), json({ itemId: "553020", level: 15 }));
  // Fang is recommended for 1 and 2 too, so it isn't 3's signature item; it's still the first recommended.
  assert.equal(json(H.defaultFor(team, aniilog, "3")), json({ itemId: "553002", level: 15 }));
  assert.equal(H.defaultFor(team, aniilog, "4"), null);
  // Without the evolution data, Needle is recommended outside form 1 alone, so it falls back to Fang.
  assert.equal(json(H.defaultFor(team, null, "1")), json({ itemId: "553002", level: 15 }));
  // A pick wins; "No held item" (null) stays none; nothing picked (undefined) gets the default.
  assert.equal(json(H.chosen(team, aniilog, "1", { itemId: 551002 })), json({ itemId: "551002", level: 5 }));
  assert.equal(H.chosen(team, aniilog, "1", null), null);
  assert.equal(json(H.chosen(team, aniilog, "1", undefined)), json({ itemId: "553020", level: 15 }));
});

test("another form of the same species (a Prismana form with no evolution listed) is in the line", () => {
  const needle = { name: "Lightning Needle", tiers: [{ item_id: 553020, quality: 5 }] };
  const fang = { name: "Ferocious Fang", tiers: [{ item_id: 553002, quality: 5 }] };
  const team = { ...data, forms: { 10: { recommended: { held_items: [fang, needle] } }, 11: { recommended: { held_items: [fang, needle] } }, 12: { recommended: { held_items: [fang] } } } };
  const aniilog = { entries: [{ form_id: 10, base_id: 9, evolution: {} }, { form_id: 11, base_id: 9, evolution: {} }, { form_id: 12, base_id: 8, evolution: {} }] };
  assert.equal(H.defaultFor(team, aniilog, "11")?.itemId, "553020");
  assert.equal(H.defaultFor(team, aniilog, "12")?.itemId, "553002");
});
