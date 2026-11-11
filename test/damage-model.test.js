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

test("CP matches a real Lv 70 Irisalis card: Core skill upgraded, Prismana caught and the Feather at +15", () => {
  const data = {
    potential_cp: Array.from({ length: 21 }, (_, level) => ({ cp: 6 * level, recommended_rate: 2 })),
    held_item_catalog: { 553025: { name: "Floral Rainbow Feather", quality: 5, cp: 200, cp_per_level: 15 } },
    forms: { 1021300: { stat_template: { recommended_stats: ["ATK", "REGEN"] } } },
  };
  const species = { HP: 90, ATK: 130, "P.DEF": 78, "M.DEF": 78, REGEN: 108, BREAK: 56 };
  const own = { HP: 20, ATK: 20, "P.DEF": 20, REGEN: 20, "M.DEF": 17, BREAK: 20 };
  const card = { resonanceCp: 1050, heldItems: [{ itemId: "553025", level: 15 }], coreUpgraded: true, formsCollected: 1, rainbowForms: 1 };
  assert.equal(D.combatPower(data, data.forms[1021300], species, 70, own, card), 4212);
  // What the site showed before: no Core upgrade, no forms counted, no held item.
  assert.equal(D.combatPower(data, data.forms[1021300], species, 70, own, { resonanceCp: 1050 }), 3646);
});

test("held-item CP at every item level: base CP + per-level CP x level (CoreCarryInfo:getCpValue), level 0 = a new item", () => {
  const data = {
    potential_cp: Array.from({ length: 21 }, (_, level) => ({ cp: 6 * level, recommended_rate: 2 })),
    held_item_catalog: {
      551025: { name: "Floral Rainbow Feather", quality: 3, cp: 50, cp_per_level: 5 },
      553025: { name: "Floral Rainbow Feather", quality: 5, cp: 200, cp_per_level: 15 },
    },
    forms: { 1021300: { stat_template: { recommended_stats: ["ATK", "REGEN"] } } },
  };
  const species = { HP: 90, ATK: 130, "P.DEF": 78, "M.DEF": 78, REGEN: 108, BREAK: 56 };
  const own = { HP: 20, ATK: 20, "P.DEF": 20, REGEN: 20, "M.DEF": 17, BREAK: 20 };
  const card = { resonanceCp: 1050, coreUpgraded: true, formsCollected: 1, rainbowForms: 1 };
  const cp = (itemId, level) => D.combatPower(data, data.forms[1021300], species, 70, own, { ...card, heldItems: [{ itemId, level }] });
  const without = D.combatPower(data, data.forms[1021300], species, 70, own, card);
  for (let level = 0; level <= 15; level += 1) assert.equal(cp("553025", level), without + 200 + 15 * level, `Legendary Lv ${level}`);
  for (let level = 0; level <= 5; level += 1) assert.equal(cp("551025", level), without + 50 + 5 * level, `Rare Lv ${level}`);
  assert.equal(cp("553025", 15), 4212);
  assert.equal(cp("553025", 0), 3987);
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

test("stat totals use own potential plus Star Up and held-item potential, and CP counts only your own", () => {
  const growth = {
    level_cap: 70, attribute_points_max: 20, attribute_point_bonus: 0.008,
    level_value: { per_level: 6, base: 35, extra_from_level: 60, extra_levels: 10, extra_weight: 1.8 },
    stats: { HP: { offset: 20, divisor: 120, scale: 20, extra: true }, ATK: { offset: 0, divisor: 120, scale: 1, extra: true },
      "P.DEF": { offset: 0, divisor: 80, scale: 0.5, extra: true }, "M.DEF": { offset: 0, divisor: 80, scale: 0.5, extra: true },
      REGEN: { offset: 0, divisor: 90, scale: 0.5, extra: false }, BREAK: { offset: 0, divisor: 100, scale: 1, extra: false } },
    potentials: { percent_steps: Object.fromEntries(["HP", "ATK", "P.DEF", "M.DEF", "REGEN", "BREAK"].map((stat) => [stat, { every: 4, percent: 0.04 }])) },
  };
  const aniilog = { stat_growth: growth, entries: [{ form_id: "1", stats: [["HP", 100], ["ATK", 100], ["P.DEF", 50], ["M.DEF", 50], ["REGEN", 50], ["BREAK", 50]].map(([label, value]) => ({ label, value })) }] };
  const allSix = ["pet_individual_point_atk", "pet_individual_point_hp", "pet_individual_point_def", "pet_individual_point_def_mag", "pet_individual_point_ep_regen_force", "pet_individual_point_bp_atk"];
  const data = {
    forms: { 1: { stat_template: {} } },
    potential_cp: Array.from({ length: 21 }, (_, level) => ({ cp: 6 * level, recommended_rate: 2 })),
    star_up: { 6: { 6: { cp: 0, stats: [{ keys: allSix, value: 2 }, { keys: ["atk_v"], value: 80 }] } } },
    held_item_levels: { 10: { enhance_ratio: 0.5 } },
    held_item_catalog: { 9: { name: "Horn", stats: [], conversions: [], cp: 0, cp_per_level: 0,
      tiers: [{ level: 10, need_energy: 0, buffs: [{ attributes: [{ key: "pet_individual_point_bp_atk", value: 2 }] }] }] } },
  };
  const result = D.statTotals(data, aniilog, "1", { level: 65, potential: { ATK: 20, BREAK: 20 }, starUp: { stage: 6, level: 6 }, heldItems: [{ itemId: 9, level: 10 }] });
  assert.equal(result.potential.ATK.total, 22);
  assert.equal(result.potential.BREAK.total, 24);
  assert.equal(result.potential.BREAK.held_items, 2);
  assert.equal(result.potential.HP.total, 2);
  // ATK: (formula at potential 22 + 80 Star Up flat) x (1 + 5 x 4%), rounded up
  const base = D.baseValue(growth, "ATK", 100, 65, 22);
  assert.equal(result.total.ATK, Math.ceil((base + 80) * 1.2 - 1e-9));
  const ownOnly = D.statTotals(data, aniilog, "1", { level: 65, potential: { ATK: 20, BREAK: 20 } });
  assert.equal(result.cp, ownOnly.cp);
});

test("a researched form's Form Research bonus adds to every form of the species", () => {
  const growth = {
    level_cap: 70, attribute_points_max: 20, attribute_point_bonus: 0.008,
    level_value: { per_level: 6, base: 35, extra_from_level: 60, extra_levels: 10, extra_weight: 1.8 },
    stats: { ATK: { offset: 0, divisor: 120, scale: 1, extra: true } },
    potentials: { percent_steps: { ATK: { every: 4, percent: 0.04 } } },
  };
  const aniilog = { stat_growth: growth, entries: [{ form_id: "1", stats: [{ label: "ATK", value: 100 }] }] };
  const data = { forms: { 1: { stat_template: {}, form_research: [{ form_id: 2, form_label: "Prismana Form", key: "atk_p", label: "ATK", value: 0.02 }] } } };
  const without = D.statTotals(data, aniilog, "1", { level: 65, potential: { ATK: 20 } });
  const researched = D.statTotals(data, aniilog, "1", { level: 65, potential: { ATK: 20 }, formResearch: ["2"] });
  const base = D.baseValue(growth, "ATK", 100, 65, 20);
  assert.equal(without.total.ATK, Math.ceil(base * 1.2 - 1e-9));
  assert.equal(researched.total.ATK, Math.ceil(base * 1.22 - 1e-9));
  assert.equal(researched.bonus.ATK.sources[0].source, "Form Research: Prismana Form");
});

test("role ATK (game 1.1): DPS as is, BREAK formula 3512, Support / REGEN / Heal formula 3513 when above ATK", () => {
  // DPS and an unknown role: ATK, one damage-ATK per ATK point.
  assert.deepEqual([D.roleAttack("DPS", 437, 204, 70).atk, D.roleAttack("DPS", 437, 204, 70).slope], [437, 1]);
  assert.equal(D.roleAttack(undefined, 437, 900, 70).atk, 437);
  // BREAK: ATK + 0.42 x (min(BREAK, 2.2 x ATK) - 0.5 x ATK); 0.79 per ATK point in range, 1.714 at the cap, 1 below half.
  const breaker = D.roleAttack("BREAK", 350, 491, 70);
  assert.ok(Math.abs(breaker.atk - (350 + 0.42 * (491 - 175))) < 1e-9);
  assert.ok(Math.abs(breaker.slope - 0.79) < 1e-9);
  assert.ok(Math.abs(D.roleAttack("BREAK", 200, 1000, 70).atk - 200 * 1.714) < 1e-9);
  assert.ok(Math.abs(D.roleAttack("BREAK", 200, 1000, 70).slope - 1.714) < 1e-9);
  assert.deepEqual([D.roleAttack("BREAK", 400, 150, 70).atk, D.roleAttack("BREAK", 400, 150, 70).slope], [400, 1]);
  // Support / REGEN / Heal (both the game's and the Aniilog's role names): max(ATK, 7 x min(60, Lv) + 0.3 x ATK).
  for (const role of ["SUP", "SUPPORT", "ENERGY", "REGEN", "HEAL", "HEALER"]) {
    assert.ok(Math.abs(D.roleAttack(role, 335, 0, 70).atk - (420 + 100.5)) < 1e-9, role);
    assert.equal(D.roleAttack(role, 335, 0, 70).basis, "inferred");
  }
  assert.ok(Math.abs(D.roleAttack("SUP", 213, 0, 30).atk - (210 + 63.9)) < 1e-9);
  assert.equal(D.roleAttack("SUP", 213, 0, 30).slope, 0.3);
  assert.deepEqual([D.roleAttack("HEAL", 700, 0, 70).atk, D.roleAttack("HEAL", 700, 0, 70).slope], [700, 1]);
  assert.equal(D.roleOf("HEALER").label, "Heal");
});

test("the Try-Hard Guide explains ATK by role (game 1.1) and how much an ATK point is worth per role", () => {
  const section = G.sections.find((row) => row.id === "role-atk");
  assert.equal(section.basis, "inferred");
  const text = section.paragraphs.join(" ");
  assert.match(text, /formula 3512/u);
  assert.match(text, /formula 3513/u);
  assert.match(text, /ATK 483/u);
  assert.match(text, /ATK 521/u);
  const atk = G.sections.find((row) => row.id === "atk").paragraphs.join(" ");
  assert.match(atk, /rate 0\.79/u);
  assert.match(atk, /rate 0\.3/u);
  // The worked examples match the model.
  assert.equal(Math.round(D.roleAttack("BREAK", 350, 491, 70).atk), 483);
  assert.equal(Math.round(D.roleAttack("HEALER", 335, 0, 70).atk), 521);
});

test("Guide audit for 1.1: ATK table and BREAK example use the rounded-up stat cards, notes match the 1.1 buff data", () => {
  const atk = G.sections.find((row) => row.id === "atk");
  assert.equal(atk.table.rows.at(-1).join(" | "), "20 | 431 / 281 (+77%) | 575 / 374 (+76%) | 609 / 397 (+76%)");
  assert.match(G.sections.find((row) => row.id === "break").paragraphs.join(" "), /BREAK 209\. Fire Kick \(Might 72\) deals about 209 × 7\.2/u);
  assert.match(G.explanationFor("skill", 10900480).text, /^Once the skill is upgraded/u);
  assert.doesNotMatch(G.explanationFor("skill", 10300090, 1019100).text, /for 10s, not Damage Amp for 20s/u);
});

const near = (value) => Math.round(value * 1e6) / 1e6;

test("PvP: formula 3001's max(0.2, pvpDmg) x 0.15 uses pvp_taken_*, only in PvP, and leaves BREAK alone", () => {
  const pvp = { ...context, pvp: true };
  const hit = (modifiers, target = {}, ctx = pvp) => D.hit({ ...attacker, modifiers }, { ...defender, modifiers: target }, fireSkill, ctx);
  const base = hit({}).hit;
  // x0.15, and the countered matchup (Fire on Grass) takes its PvP value: x0.9.
  assert.equal(near(base / hit({}, {}, context).hit), near(0.15 * 0.9));
  assert.equal(near(hit({ pvp_taken_dmg_inc_rate_v: 0.2 }).hit / base), 1.2);
  assert.equal(near(hit({ pvp_taken_dmg_inc_rate_v: 0.2 }, { pvp_taken_dmg_dec_rate_v: 0.5 }).hit / base), 0.7);
  assert.equal(near(hit({}, { pvp_taken_dmg_dec_rate_v: 5 }).hit / base), 0.2);
  assert.equal(near(hit({ pvp_taken_dmg_inc_rate_v: 0.5 }, { pvp_taken_dmg_dec_rate_v: 0.5 }, context).hit / hit({}, {}, context).hit), 1);
  // BREAK ignores the PvP damage terms (its PvP matchup value is tested below).
  assert.equal(hit({}, { pvp_taken_dmg_dec_rate_v: 0.5 }).break, hit({}, {}).break);
});

test("crit: the target's resistance by attack type, from getCriticalDamageRatio", () => {
  const rate = (type, target) => D.hit({ ...attacker, critRate: 0.5 }, { ...defender, modifiers: target }, { ...fireSkill, type }, context).critChance;
  const multiplier = (type, target) => D.hit({ ...attacker, critDamage: 1 }, { ...defender, modifiers: target }, { ...fireSkill, type }, context).critMultiplier;
  assert.equal(near(rate("basic", { normal_attack_crit_dec_rate_v: 0.2 })), 0.3);
  assert.equal(near(rate("skill", { normal_attack_crit_dec_rate_v: 0.2 })), 0.5);
  assert.equal(near(rate("skill", { skill_crit_dec_rate_v: 0.2 })), 0.3);
  assert.equal(near(rate("ultimate", { ultimate_crit_dec_rate_v: 0.2 })), 0.3);
  assert.equal(near(multiplier("basic", { normal_attack_crit_dmg_dec_rate_v: 0.5 })), 1.5);
  assert.equal(near(multiplier("skill", { skill_crit_dmg_dec_rate_v: 0.5 })), 1.5);
  assert.equal(near(multiplier("ultimate", { ultimate_crit_dec_dmg_v: 0.5 })), 1.5);
  assert.equal(near(multiplier("ultimate", { skill_crit_dmg_dec_rate_v: 0.5 })), 2);
});

test("crit bonuses for a target in BREAK count only then", () => {
  const mods = { break_crit_inc_rate_v: 0.2, break_crit_dmg_v: 0.5 };
  const up = { ...attacker, critRate: 0.1, critDamage: 0.5, modifiers: mods };
  const normal = D.hit(up, defender, fireSkill, context);
  assert.equal(near(normal.critChance), 0.1);
  assert.equal(near(normal.critMultiplier), 1.5);
  const broken = D.hit(up, defender, fireSkill, { ...context, broken: true });
  assert.equal(near(broken.critChance), 0.3);
  assert.equal(near(broken.critMultiplier), 2);
});

test("damage to a target in BREAK: dmg_break_add_ratio less dmg_break_dec_ratio, which isn't an element", () => {
  const hit = (ctx, target) => D.hit({ ...attacker, modifiers: { dmg_break_add_ratio: 0.3 } }, { ...defender, modifiers: target }, fireSkill, ctx).hit;
  const plain = hit(context, {});
  assert.equal(D.bracketOf("dmg_break_dec_ratio").bracket, "vs_break");
  assert.equal(near(hit({ ...context, broken: true }, {}) / plain), 1.3);
  assert.equal(near(hit({ ...context, broken: true }, { dmg_break_dec_ratio: 0.1 }) / plain), 1.2);
  assert.equal(hit(context, { dmg_break_dec_ratio: 0.1 }), plain);
});

test("Ultimate BREAK Efficiency counts on Ultimates only", () => {
  const value = (type) => D.hit({ ...attacker, modifiers: { ultimate_bp_add_ratio: 0.5 } }, defender, { ...fireSkill, type }, context).break;
  assert.equal(near(value("ultimate") / value("skill")), 1.5);
});

test("the Guide's toughness drain matches calc_lv_modify_data: x0.5 from 5 above, x0.2 from 16, x0.1 from 20", () => {
  const level = G.sections.find((row) => row.id === "level").paragraphs.join(" ");
  assert.match(level, /5 to 15 levels above you, your hits drain ×0\.5 toughness; 16 to 19 above, ×0\.2; 20 or more above, ×0\.1/u);
  assert.match(level, /BREAK damage changes by the square root/u);
});

test("PvP matchups: the duel buff takes 0.5 off Counter and Resistance Boost (not below 0), then 0.1 more", () => {
  const pvp = { ...context, pvp: true };
  const matchupStep = (result) => result.steps.find((row) => row.label.startsWith("Element matchup"));
  const run = (target, ctx = pvp) => D.hit(attacker, { ...defender, elements: target }, fireSkill, ctx);
  assert.equal(near(matchupStep(run([6])).value), near(1.6 * 0.9));
  assert.equal(near(matchupStep(run([3])).value), near(0.625 / 0.9));
  assert.equal(near(matchupStep(run([3, 5])).value), near(0.390625 / 0.9));
  assert.equal(matchupStep(run([3, 6])).value, 1);
  assert.equal(matchupStep(run([6])).basis, "inferred");
  assert.equal(matchupStep(run([6], context)).value, 1.6);
  assert.equal(matchupStep(run([6], context)).basis, "exact");
  // BREAK uses max(1, matchup), so a countered hit's BREAK damage drops by the same 10%.
  assert.equal(near(run([6]).break / run([6], context).break), 0.9);
  assert.equal(D.duelBoost(0.3), -0.1);
  assert.equal(near(D.duelBoost(0.75)), 0.15);
});
