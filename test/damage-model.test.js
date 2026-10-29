import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const load = async (file) => {
  const context = { window: {} };
  vm.runInNewContext(await readFile(new URL(`../public/explorer/${file}`, import.meta.url), "utf8"), context);
  return context.window;
};
const { AniilogsDamage: D } = await load("damage-model.js");
const { AniilogsGuide: G } = await load("damage-guide.js");

const ELEMENTS = { 5: { against: { 5: 0.625, 3: 0.625, 6: 1.6 } } };
const attacker = { atk: 430, pdef: 208, mdef: 183, breakAtk: 208, elements: [5], modifiers: {} };
const defender = { atk: 430, pdef: 150, mdef: 120, breakDef: 0, elements: [6], modifiers: {} };
const context = { elements: ELEMENTS, sameElementBonus: 0.1, elementKeys: { 5: { add: "dmg_fire_add_ratio", dec: "dmg_fire_dec_ratio" } } };
const fireSkill = { might: 30, breakPower: 10, element: 5, category: "Physical", type: "skill" };

test("formula 3001: (ATK - DEF) x Might / 10, then matchup and same-element bonus", () => {
  const result = D.hit(attacker, defender, fireSkill, context);
  assert.equal(Math.round(result.hit * 1000) / 1000, Math.round((430 - 150) * 3 * 1.6 * 1.1 * 1000) / 1000);
  assert.equal(result.critMultiplier, 1.5);
  assert.equal(result.critChance, 0.1);
});

test("Magical hits face M.DEF and the 10% of ATK floor holds", () => {
  const magic = D.hit(attacker, defender, { ...fireSkill, category: "Magical" }, context);
  assert.ok(magic.hit > D.hit(attacker, defender, fireSkill, context).hit);
  const tank = D.hit(attacker, { ...defender, pdef: 1000 }, fireSkill, context);
  assert.equal(Math.round(tank.steps[0].value * 1000) / 1000, Math.round(43 * 3 * 1000) / 1000);
});

test("Damage Amp sources add in one pot; the target's reduction comes out of it, floored at 0.2", () => {
  const amp = (modifiers, target = {}) => D.hit({ ...attacker, modifiers }, { ...defender, modifiers: target }, fireSkill, context).hit;
  const base = amp({});
  assert.equal(Math.round(amp({ taken_dmg_inc_rate_v: 0.3 }) / base * 1000) / 1000, 1.3);
  assert.equal(Math.round(amp({}, { taken_dmg_dec_rate_v: 5 }) / base * 1000) / 1000, 0.2);
});

test("elemental damage at or below 0 ignores the hit; mixed matchups are neutral", () => {
  const blocked = D.hit(attacker, { ...defender, modifiers: { dmg_fire_dec_ratio: 1 } }, fireSkill, context);
  assert.equal(blocked.hit, 0);
  const mixed = D.elementMatchup({ 5: { against: { 3: 0.625, 6: 1.6 } } }, 5, [3, 6], 0.25, 0.5);
  assert.equal(mixed.factor, 1);
  assert.equal(mixed.kind, "neutral");
  assert.equal(D.elementMatchup(ELEMENTS, 5, [6], 0.25).factor, 1.6 * 1.25);
});

test("crit is capped at 3x", () => {
  const result = D.hit({ ...attacker, critDamage: 5 }, defender, fireSkill, context);
  assert.equal(result.critMultiplier, 3);
});

test("the Try-Hard Guide has its sections and form-scoped notes", () => {
  assert.equal(G.title, "Try-Hard Guide");
  assert.ok(G.sections.some((section) => section.id === "atk" && section.table.rows.length === 6));
  assert.match(G.explanationFor("skill", 10300090, 1019100).text, /Water Elemental Boost/u);
  assert.equal(G.explanationFor("skill", 10300090, 1019400), null);
  assert.ok(G.sections.every((section) => ["exact", "by-name", "inferred"].includes(section.basis)));
});

test("CP is formula 3100: species total, level, potential CP (x2 on recommended stats) and held items", () => {
  const data = {
    potential_cp: Array.from({ length: 21 }, (_, level) => ({ cp: 6 * level, recommended_rate: 2 })),
    forms: { 1: { stat_template: { recommended_stats: ["ATK"] }, recommended: { held_items: [{ tiers: [{ item_id: 9, cp: 200, cp_per_level: 15 }] }] } } },
  };
  const species = { HP: 100, ATK: 100, "P.DEF": 50, "M.DEF": 50, REGEN: 50, BREAK: 50 };
  const none = { HP: 0, ATK: 0, "P.DEF": 0, "M.DEF": 0, REGEN: 0, BREAK: 0 };
  // species total 100 + 2 x 100 + 4 x 50 = 500; round(0.005 x 335 x 500) = 838
  assert.equal(D.combatPower(data, data.forms[1], species, 50, none), 838);
  // ATK potential 10 = 60 CP x 2 = 120: round(837.5 x 1.066) + 0.3 x 120 = 893 + 36
  assert.equal(D.combatPower(data, data.forms[1], species, 50, { ...none, ATK: 10 }), 929);
  // held item level 2: 200 + 2 x 15
  assert.equal(D.combatPower(data, data.forms[1], species, 50, none, { heldItems: [{ itemId: 9, level: 2 }] }), 1068);
});

test("toughness drain is hit share x the skill's BREAK power x the target's modifiers", () => {
  assert.equal(D.toughnessDrain(24), 24);
  assert.equal(D.toughnessDrain(24, { hitShare: 0.5, tpReduceAdd: 0.25, sizeResistRate: 2 }), 7.5);
});

test("BREAK damage is formula 3023: (BREAK - BREAK DEF) x Might / 10 x bpRate, with crit, not Damage Amp", () => {
  const breaker = { ...attacker, breakAtk: 208, critDamage: 0.5, modifiers: { taken_dmg_inc_rate_v: 0.5 } };
  const kick = { might: 72, breakRate: 1, element: 5, category: "Physical", type: "skill" };
  const result = D.hit(breaker, { ...defender, elements: [3], breakDef: 0 }, kick, context);
  assert.equal(Math.round(result.break * 10) / 10, 1497.6);
  assert.equal(Math.round(result.breakCrit * 10) / 10, 2246.4);
  assert.equal(D.hitsToBreak({ pet_break_bar: { by_level: [2185, 27866] } }, 2, result.break), 19);
  assert.equal(D.hit(breaker, defender, { ...kick, breakRate: 0 }, context).break, 0);
});

test("stat-scaled buff values follow base x min(max, min + stat x rate)", () => {
  const waltz = { stat: "ATK", bases: [0.35], min: 0.8, per_point: 0.00075, max: 1.4 };
  assert.equal(Math.round(D.scaledValue(waltz, { ATK: 400 }) * 1e6) / 1e6, 0.385);
  assert.equal(D.scaledValue(waltz, { ATK: 5000 }), 0.35 * 1.4);
  const range = D.scaledRange(waltz);
  assert.equal(Math.round(range.from * 1000) / 1000, 0.28);
  assert.equal(Math.round(range.to * 1000) / 1000, 0.49);
  assert.equal(Math.round(range.cap_at), 800);
  const guard = { stat: "P.DEF", bases: [100], min: 0, per_point: 0.002, max: 1.2, round_down: true };
  assert.equal(D.scaledValue(guard, { "P.DEF": 499 }), 99);
  assert.equal(D.scaledValue(guard, { "P.DEF": 900 }), 120);
  assert.equal(Math.round(D.scaledValue({ ...waltz, factor: -1 }, { ATK: 0 }) * 1000) / 1000, -0.28);
});
