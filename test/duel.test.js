import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/explorer/duel.js", import.meta.url), "utf8");
const teamBuilder = await readFile(new URL("../public/explorer/team-builder.js", import.meta.url), "utf8");
const explorerHtml = await readFile(new URL("../public/explorer/index.html", import.meta.url), "utf8");

const damageModel = await readFile(new URL("../public/explorer/damage-model.js", import.meta.url), "utf8");

// Loaded the way the page loads them: damage-model.js first (the role ATK lives there), then duel.js.
function loadDuel({ withModel = true } = {}) {
  const window = { localStorage: { getItem: () => null, setItem: () => {} } };
  const context = { window, document: {} };
  if (withModel) vm.runInNewContext(damageModel, context);
  vm.runInNewContext(source, context);
  return window.AniilogsDuel;
}

const duel = loadDuel();
const data = { elements: { 5: { name: "Fire", against: { 2: 1.6, 3: 1.6, 5: 0.625 } }, 2: { name: "Ice", against: {} }, 3: { name: "Grass", against: {} } } };
const attacker = { stats: { Attack: 354, Defense: 177, Break: 182 }, elements: ["5"] };
const scenario = { data, startHp: 100, broken: false, brokenBonus: 0, pvp: false, actionSeconds: 1 };
const fireKick = { id: "1", category: "Physical", element: "5", might: 72, breakPower: 24, breakRate: 1, cooldown: 15, epCost: 0, rates: [1, 1.2] };

test("HP damage follows formula 3001: max(ATK - DEF, 10% ATK) x Might / 10, elements, same element and crits", () => {
  const defender = { stats: { Defense: 171 }, elements: ["9"] };
  const plain = duel.hpDamage(attacker, defender, fireKick, scenario, false);
  assert.ok(Math.abs(plain - (354 - 171) * 7.2 * 1.1) < 1e-9);
  assert.ok(Math.abs(duel.hpDamage(attacker, defender, fireKick, scenario, true) - plain * 1.5) < 1e-9);
  // DEF above ATK still leaves 10% of ATK.
  const wall = { stats: { Defense: 900 }, elements: [] };
  assert.ok(Math.abs(duel.hpDamage(attacker, wall, fireKick, scenario, false) - 35.4 * 7.2 * 1.1) < 1e-9);
  // Two weak elements multiply (1.6 x 1.6), PvP scales to 15%, and a broken bonus adds on.
  const double = { stats: { Defense: 171 }, elements: ["2", "3"] };
  assert.ok(Math.abs(duel.hpDamage(attacker, double, fireKick, scenario, false) - plain * 2.56) < 1e-9);
  assert.ok(Math.abs(duel.hpDamage(attacker, defender, fireKick, { ...scenario, pvp: true }, false) - plain * 0.15) < 1e-9);
  assert.ok(Math.abs(duel.hpDamage(attacker, defender, fireKick, { ...scenario, broken: true, brokenBonus: 0.5 }, false) - plain * 1.5) < 1e-9);
  // PvP matchup values (duel buff, expected): an advantage x0.9 once, a disadvantage / 0.9.
  assert.ok(Math.abs(duel.hpDamage(attacker, double, fireKick, { ...scenario, pvp: true }, false) - plain * 2.56 * 0.9 * 0.15) < 1e-9);
  const same = { stats: { Defense: 171 }, elements: ["5"] };
  assert.ok(Math.abs(duel.hpDamage(attacker, same, fireKick, { ...scenario, pvp: true }, false) - plain * 0.625 / 0.9 * 0.15) < 1e-9);
});

test("the attacker's role sets the ATK that goes into formula 3001 (formula_data 3512 and 3513)", () => {
  const side = (role, level, atk, breakValue) => ({ entry: { role }, side: { level }, stats: { Attack: atk, Break: breakValue } });
  // DPS (and no role) use ATK as is.
  assert.equal(duel.roleAttack(side("DPS", 70, 500, 900)).atk, 500);
  assert.equal(duel.roleAttack({ stats: { Attack: 354 } }).atk, 354);
  // BREAK: ATK + 0.42 x (min(BREAK, 2.2 x ATK) - 0.5 x ATK), never below ATK.
  assert.ok(Math.abs(duel.roleAttack(side("BREAK", 70, 300, 600)).atk - (300 + 0.42 * (600 - 150))) < 1e-9);
  assert.ok(Math.abs(duel.roleAttack(side("BREAK", 70, 300, 2000)).atk - (300 + 0.42 * (660 - 150))) < 1e-9);
  assert.equal(duel.roleAttack(side("BREAK", 70, 300, 100)).atk, 300);
  // Support / REGEN / Heal: the higher of ATK and 7 x min(60, Lv) + 0.3 x ATK.
  assert.ok(Math.abs(duel.roleAttack(side("HEALER", 70, 300, 0)).atk - (420 + 90)) < 1e-9);
  assert.ok(Math.abs(duel.roleAttack(side("SUPPORT", 30, 100, 0)).atk - (210 + 30)) < 1e-9);
  assert.equal(duel.roleAttack(side("REGEN", 70, 800, 0)).atk, 800);
  // Game role keys work too (pet_data.functionId).
  assert.ok(Math.abs(duel.roleAttack(side("HEAL", 70, 300, 0)).atk - 510) < 1e-9);
  // duel.js uses the damage model's helper; without the model loaded it falls back to ATK.
  assert.match(source, /model\.roleAttack\(attacker\.entry\?\.role, stats\.Attack, stats\.Break, attacker\.side\?\.level\)/u);
  assert.equal(loadDuel({ withModel: false }).roleAttack(side("HEALER", 70, 300, 0)).atk, 300);
  // hpDamage uses it.
  const healer = { ...side("HEALER", 70, 300, 0), elements: [] };
  const target = { stats: { Defense: 110 }, elements: [] };
  assert.ok(Math.abs(duel.hpDamage(healer, target, fireKick, scenario, false) - (510 - 110) * 7.2) < 1e-9);
});

test("BREAK damage follows formula 3023 (Might x BREAK rate) and never drops below 1x for elements", () => {
  const resist = { stats: {}, elements: ["5"] };
  assert.ok(Math.abs(duel.breakDamage(attacker, resist, fireKick, scenario, false) - 182 * 7.2) < 1e-9);
});

test("the KO plan uses the strongest attack off cooldown and stops at the KO", () => {
  const rows = [
    { attack: { id: "a", name: "Big", cooldown: 15, epCost: 0 }, average: 40 },
    { attack: { id: "b", name: "Small", cooldown: 0.3, epCost: 10 }, average: 10 },
  ];
  const plan = duel.rotation(rows, 100, 1, "average");
  assert.equal(plan.ko, true);
  assert.equal(plan.hits, 7);
  assert.equal(plan.time, 6);
  assert.equal(plan.used.get("Big"), 1);
  assert.equal(plan.ep, 60);
});

test("stats use the same growth as the Aniimo page", () => {
  const growth = {
    level_value: { per_level: 6, base: 35, extra_from_level: 60, extra_levels: 10, extra_weight: 1.8 },
    attribute_point_bonus: 0.008,
    stats: { HP: { offset: 20, divisor: 120, scale: 20, extra: true } },
    potentials: { percent_steps: { HP: { every: 4, percent: 0.04 } } },
  };
  assert.equal(duel.grownStat(growth, "HP", 67, 70, 0), 6858);
});

test("the page says every number assumes the attacks land, covers crits, and marks Hits to BREAK as not verified", () => {
  assert.match(source, /"Assumes every attack lands\."/u);
  assert.match(source, /Crits use the game's base/u);
  assert.match(source, /No crits: .*Every hit crits:/u);
  assert.match(source, /window\.AniilogsDamage\?\.breakBar\?\.\(options\.data, result\.defender\.side\.level\)/u);
  assert.match(source, /"Not verified"/u);
});

test("Team Builder has a 1v1 tab that hands off to duel.js", () => {
  assert.match(teamBuilder, /\["duel", "1v1"\]/u);
  assert.match(teamBuilder, /window\.AniilogsDuel\.render\(\{/u);
  assert.match(explorerHtml, /<script defer src="\.\/duel\.js\?v=[^"]+"><\/script>/u);
});

const guidePage = await readFile(new URL("../public/explorer/guide-page.js", import.meta.url), "utf8");
const guidesHtml = await readFile(new URL("../public/guides/index.html", import.meta.url), "utf8");
const guidesJs = await readFile(new URL("../public/guides/guides.js", import.meta.url), "utf8");

test("the 1v1 uses the damage model, the team's buffs and debuffs, and shows how a hit was worked out", () => {
  assert.match(source, /model\.hit\(side\(attacker, attackerMods\), side\(defender, scenario\.defenderMods \|\| \{\}\)/u);
  assert.match(source, /model\.options\(options\.data, formIds\)/u);
  // A teammate's own self buffs don't reach the Aniimo you attack with.
  assert.match(source, /if \(String\(raw\.form_id\) !== you && !TEAM_WIDE\.has\(raw\.who\)\) continue;/u);
  // Stat-scaled effects get their amount from the caster's card stats.
  assert.match(source, /model\.scaledValue\(raw\.scaling, statsFor\(raw\.form_id\)/u);
  assert.match(source, /attackerMods: mods\.you, defenderMods: mods\.foe/u);
  assert.match(source, /attackerMods: mods\.foe, defenderMods: mods\.you/u);
  assert.match(source, /function renderSteps\(row, result\)/u);
});

test("the guides have their own page, with contents, a link per section and Back to contents", () => {
  assert.match(guidePage, /link\.href = `#\$\{SECTION_PREFIX\}\$\{section\.id\}`/u);
  assert.match(guidePage, /"Back to contents"/u);
  assert.match(guidePage, /const SECTION_PREFIX = "guide-";/u);
  // /guides/ lists the guides and shows one; Team Builder's old guide links (?tab=guide, #guide-…) go there.
  assert.match(guidesHtml, /<script src="\/explorer\/guide-page\.js\?v=[^"]+" defer><\/script>/u);
  assert.match(guidesHtml, /<a href="\/guides\/" data-chrome-link="guides" aria-current="page">Guides<\/a>/u);
  assert.match(guidesJs, /window\.AniilogsGuidePage\.render\(\{ guide, aniilog \}\)/u);
  assert.match(teamBuilder, /return `\/guides\/\?guide=damage\$\{window\.location\.hash \|\| ""\}`;/u);
  assert.match(teamBuilder, /if \(guideAddress\(\)\) window\.location\.replace\(guideAddress\(\)\);/u);
  assert.match(explorerHtml, /<a id="topNavGuides" href="\/guides\/">Guides<\/a>/u);
});
