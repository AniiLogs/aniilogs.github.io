import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/explorer/held-item-picker.js", import.meta.url), "utf8");
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source, context);
const H = context.window.AniilogsHeldItems;

const data = {
  held_item_levels: { 1: {}, 10: {}, 15: {} },
  held_item_catalog: {
    552002: { name: "Ferocious Fang", quality: 4, stats: [], tiers: [] },
    553002: { name: "Ferocious Fang", quality: 5, stats: [{ label: "Damage Amp", value: 0.1 }],
      tiers: [{ level: 10, buffs: [{ attributes: [{ key: "pet_individual_point_atk", label: "ATK", value: 2 }] }] }] },
    553020: { name: "Lightning Needle", quality: 5, stats: [{ label: "HP", value: 0.1 }], tiers: [] },
  },
  forms: { 7: { recommended: { held_items: [{ tiers: [{ item_id: 553020 }] }] } } },
};

test("held-item picker lists only Legendary items, the Aniimo's recommended ones first", () => {
  const rows = H.legendaryItems(data, "7");
  assert.equal(rows.map((row) => row.id).join(","), "553020,553002");
  assert.equal(rows[0].recommended, true);
});

test("a saved held item counts only as a Legendary at the top item level", () => {
  assert.equal(H.maxLevel(data), 15);
  assert.deepEqual({ ...H.normalize(data, { itemId: 553002, level: 3 }) }, { itemId: "553002", level: 15 });
  assert.equal(H.normalize(data, { itemId: 552002, level: 10 }), null);
  assert.equal(H.normalize(data, null), null);
  assert.equal(H.describe(data.held_item_catalog[553002]), "Damage Amp +10%, ATK potential +2");
});
