import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFile(new URL(`../public/explorer/${path}`, import.meta.url), "utf8");
const context = { window: {} };
vm.runInNewContext(await read("skill-tags.js"), context);
const T = context.window.AniilogsSkillTags;
const explorer = await read("app.js");
const page = await read("index.html");

const skill = (name, types, id = name) => ({ skill_id: id, name, combat: { category: "Physical", types } });
const hammer = { id: "a", skills: [skill("Jab", ["Melee"]), skill("Hammer", ["Control", "Pound"])], ultimates: [{ ultimate_id: "u", name: "Shatter", combat: { types: ["BREAK", "Buffs"] } }] };
const blade = { id: "b", skills: [skill("Blade", ["Abnormal Status", "Damage"]), skill("Bind", ["Control"])] };
const plain = { id: "c", skills: [{ skill_id: "x", name: "No combat data" }], traits: [{ name: "Trait", combat: { types: ["Control"] } }] };
const names = (list) => Array.from(list, (ability) => ability.name);

test("tags are the game's labels on skills and Ultimates, counted per Aniimo and listed A to Z", () => {
  const options = Array.from(T.options([hammer, blade, plain]), (option) => `${option.label}:${option.count}:${option.id}`);
  assert.deepEqual(options, [
    "Abnormal Status:1:abnormal-status", "BREAK:1:break", "Buffs:1:buffs", "Control:2:control", "Damage:1:damage",
    "Melee:1:melee", "Pound:1:pound",
  ]);
  assert.deepEqual(Array.from(T.options(null)), []);
});

test("no chosen tag matches every Aniimo; one tag matches those with a skill that has it", () => {
  assert.ok([hammer, blade, plain].every((entry) => T.matches(entry, new Set())));
  assert.deepEqual([hammer, blade, plain].map((entry) => T.matches(entry, new Set(["control"]))), [true, true, false]);
  assert.equal(T.matches(hammer, ["break"]), true, "an Ultimate's tags count");
  assert.equal(T.matches(plain, ["control"]), false, "traits are not skills");
});

test("several tags: on one skill by default, or across the Aniimo's skills", () => {
  assert.deepEqual(names(T.matchingSkills(hammer, ["control", "pound"])), ["Hammer"]);
  assert.equal(T.matches(blade, ["control", "abnormal-status"]), false);
  assert.equal(T.matches(blade, ["control", "abnormal-status"], "any"), true);
  assert.deepEqual(names(T.matchingSkills(blade, ["control", "abnormal-status"], "any")), ["Blade", "Bind"]);
  assert.equal(T.matches(blade, ["control", "pound"], "any"), false, "every chosen tag must be there");
  assert.deepEqual(names(T.matchingSkills(hammer, ["Abnormal Status"])), [], "labels and ids both work");
  assert.deepEqual(names(T.matchingSkills(blade, ["Abnormal Status"])), ["Blade"]);
});

test("the Aniilog filter uses it: its own section, cleared with the other filters, and a skill's tag filters by it", () => {
  assert.ok(page.indexOf("skill-tags.js") > 0 && page.indexOf("skill-tags.js") < page.indexOf("./app.js"));
  assert.match(explorer, /renderAniilogFilterSection\("skillTags", "Skill tags"/u);
  assert.match(explorer, /AniilogsSkillTags\.matches\(entry, aniilogFilterSet\("skillTags"\), filters\.skillTagMatch\)/u);
  assert.equal(explorer.split('["classes", "elements", "homeland", "stages", "forms", "skillTags"]').length, 4);
  assert.match(explorer, /badge\.addEventListener\("click", \(\) => showAniimoWithSkillTag\(label\)\)/u);
});
