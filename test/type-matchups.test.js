import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFile(new URL(`../public/explorer/${path}`, import.meta.url), "utf8");
const context = { window: {} };
vm.runInNewContext(await read("type-matchups.js"), context);
const M = context.window.AniilogsMatchups;
const teamBuilder = await read("team-builder.js");
const explorer = await read("app.js");
const page = await read("index.html");

// Fire hits Ice and Grass hard and is resisted by Water and Fire; Water hits Fire hard and is resisted by Ice.
const ELEMENTS = {
  5: { name: "Fire", color: "#e03d3d", against: { 2: 1.6, 3: 0.625, 5: 0.625, 6: 1.6 } },
  3: { name: "Water", color: "#1e90ff", against: { 2: 0.625, 3: 0.625, 5: 1.6, 6: 0.625 } },
  6: { name: "Grass", color: "#43a061", against: { 2: 1, 3: 1.6, 5: 0.625, 6: 0.625 } },
  2: { name: "Ice", color: "#58d0e8", against: { 2: 0.625, 3: 1.6, 5: 0.625, 6: 1 } },
};
// The module runs in its own vm realm, so compare its arrays by value.
const plain = (value) => JSON.parse(JSON.stringify(value));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test("PvE multiplies the value of each defending element", () => {
  close(M.net(ELEMENTS, [2], 5), 1.6);
  close(M.net(ELEMENTS, [3], 5), 0.625);
  close(M.net(ELEMENTS, [2, 6], 5), 2.56);
  close(M.net(ELEMENTS, [3, 5], 5), 0.390625);
  close(M.net(ELEMENTS, [2, 3], 5), 1);
  close(M.net(ELEMENTS, [6], 2), 1);
});

test("PvP softens a matchup by 10% once, however many elements defend, and leaves mixed ones alone", () => {
  close(M.net(ELEMENTS, [2], 5, "pvp"), 1.6 * 0.9);
  close(M.net(ELEMENTS, [3], 5, "pvp"), 0.625 / 0.9);
  close(M.net(ELEMENTS, [2, 6], 5, "pvp"), 2.56 * 0.9);
  close(M.net(ELEMENTS, [3, 5], 5, "pvp"), 0.390625 / 0.9);
  close(M.net(ELEMENTS, [2, 3], 5, "pvp"), 1);
  assert.deepEqual(plain(M.steps("pve").map(M.format)), ["×0.39", "×0.625", "×1.6", "×2.56"]);
  assert.deepEqual(plain(M.steps("pvp").map(M.format)), ["×0.43", "×0.69", "×1.44", "×2.304"]);
});

test("a row lists every element in chart order, with a tone, and groups by multiplier", () => {
  const row = M.row(ELEMENTS, [2, 6]);
  assert.deepEqual(plain(row.map((entry) => entry.name)), ["Fire", "Water", "Grass", "Ice"]);
  assert.deepEqual(plain(row.map((entry) => entry.tone)), ["more", "less", "less", "less"]);
  assert.deepEqual(plain(M.groups(row).map((group) => [M.format(group.value), group.entries.map((entry) => entry.name).join()])),
    [["×2.56", "Fire"], ["×0.625", "Grass,Ice"], ["×0.39", "Water"]]);
  assert.equal(M.sentence(row), "Takes more from Fire. Takes less from Water, Grass, Ice.");
  assert.equal(M.sentence(M.row({ 9: { name: "Wind", against: { 9: 1 } } }, [9])), "Takes normal damage from every element.");
});

test("the radar puts bigger multipliers further out and keeps every mode's values on the chart", () => {
  const radii = [...M.steps("pve"), ...M.steps("pvp"), 1].sort((a, b) => a - b).map(M.radarRadius);
  radii.slice(1).forEach((radius, index) => assert.ok(radius > radii[index]));
  assert.ok(M.radarRadius(0.390625) >= 34 && M.radarRadius(2.56) <= 112.0001);
  const [x, y] = M.radarPoint(0, 9, 100);
  close(x, 190);
  close(y, 65);
});

test("both pages use the shared module, and the page loads it before them", () => {
  assert.ok(page.indexOf("type-matchups.js") > 0 && page.indexOf("type-matchups.js") < page.indexOf("team-builder.js"));
  assert.match(explorer, /window\.AniilogsMatchups/u);
  assert.match(teamBuilder, /window\.AniilogsMatchups/u);
});

test("Team coverage counts a member by its net multiplier, not by any one of its elements", () => {
  assert.doesNotMatch(teamBuilder, /row\.form\.elements\.some\(\(type\) => element\(id\)\.against/u);
});

test("a team's radar value is the geometric mean of its members' multipliers", () => {
  close(M.average(ELEMENTS, [[2], [3]], 5), 1);
  close(M.average(ELEMENTS, [[2], [6]], 5), 1.6);
  close(M.average(ELEMENTS, [[2, 6], [3, 5]], 5), Math.sqrt(2.56 * 0.390625));
  close(M.average(ELEMENTS, [], 5), 1);
  assert.deepEqual(plain(M.teamRow(ELEMENTS, [[2], [6]]).map((entry) => entry.tone)), ["more", "less", "less", "less"]);
});

test("Type matchups has a radar beside the lists and a Compare tab for two Aniimo or two saved teams", () => {
  assert.match(teamBuilder, /matchups\.renderRadar\(matchups\.row\(data\.elements, types, mode\)/u);
  assert.match(teamBuilder, /\[\["matchups", "Matchups"\], \["compare", "Compare"\]\]/u);
  assert.match(teamBuilder, /\[\["aniimo", "Two Aniimo"\], \["teams", "Two teams"\]\]/u);
  assert.match(teamBuilder, /matchups\.teamRow\(data\.elements, membersA/u);
});
