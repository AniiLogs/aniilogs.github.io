import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/explorer/duel.js", import.meta.url), "utf8");
const teamBuilder = await readFile(new URL("../public/explorer/team-builder.js", import.meta.url), "utf8");
const explorerHtml = await readFile(new URL("../public/explorer/index.html", import.meta.url), "utf8");

function loadDuel() {
  const window = { localStorage: { getItem: () => null, setItem: () => {} } };
  vm.runInNewContext(source, { window, document: {} });
  return window.AniilogsDuel;
}

const duel = loadDuel();
const data = { elements: { 5: { name: "Fire", against: { 2: 1.6, 3: 1.6, 5: 0.625 } }, 2: { name: "Ice", against: {} }, 3: { name: "Grass", against: {} } } };
const attacker = { stats: { Attack: 354, Defense: 177, Break: 182 }, elements: ["5"] };
const scenario = { data, startHp: 100, broken: false, brokenBonus: 0, pvp: false, actionSeconds: 1 };
const fireKick = { id: "1", category: "Physical", element: "5", might: 72, breakPower: 1, cooldown: 15, epCost: 0, rates: [1, 1.2] };

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
});

test("BREAK damage follows formula 3023 and never drops below 1x for elements", () => {
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

test("the page says every number assumes the attacks land, covers crits, and keeps the gauge in Developer Mode", () => {
  assert.match(source, /"Assumes every attack lands\."/u);
  assert.match(source, /Crits use the game's base/u);
  assert.match(source, /No crits: .*Every hit crits:/u);
  assert.match(source, /if \(options\.developerMode\) \{\s+const gauge = breakGauge/u);
  assert.match(source, /"Unverified"/u);
});

test("Team Builder has a 1v1 tab that hands off to duel.js", () => {
  assert.match(teamBuilder, /\["duel", "1v1"\]/u);
  assert.match(teamBuilder, /window\.AniilogsDuel\.render\(\{/u);
  assert.match(explorerHtml, /<script defer src="\.\/duel\.js\?v=[^"]+"><\/script>/u);
});
