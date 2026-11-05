import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Team Builder Build tab: every choice the player makes (skills with the Ultimate underneath, level, personality,
// potential, Star Up, held item, Aniilog bonuses) in one tab, and a share card drawn on the player's device.
const read = (file) => readFileSync(new URL(`../public/explorer/${file}`, import.meta.url), "utf8");
const team = read("team-builder.js");
const card = read("build-card.js");
const html = read("index.html");

test("Build is the first and default member tab; Stats is gone and the game's suggestions are under Recommended", () => {
  assert.match(team, /\{ id: "build", label: "Build" \},\r?\n    \{ id: "skills", label: "Skills" \},\r?\n    \{ id: "recommended", label: "Recommended" \},/u);
  assert.match(team, /viewState\.memberTab : "build";/u);
  assert.doesNotMatch(team, /function renderStats\(/u);
  assert.match(team, /wrap\.append\(renderShareBar\(member, index\), renderSkillPicks\(member, form, index\), renderStatTable\(member, entry\)\);/u);
  assert.match(team, /wrap\.append\(items, presets, renderPersonality\(entry\)\);/u);
});

test("the skill picks are on the Build tab, with the Ultimate in its own part underneath", () => {
  assert.match(team, /function renderSkillPicks\(member, form, index\)/u);
  assert.match(team, /el\("h3", "team-build-subheading", "Ultimate"\)/u);
  assert.match(team, /"Skills are picked on the Build tab\."/u);
});

test("the share card is drawn in the browser and copied, saved or shared: nothing is uploaded and no link is made", () => {
  assert.match(html, /<script defer src="\.\/build-card\.js\?v=[^"]+"><\/script>\s*<script defer src="\.\/team-builder\.js/u);
  assert.match(card, /window\.AniilogsBuildCard = Object\.freeze\(\{ draw, toBlob, WIDTH, HEIGHT \}\);/u);
  assert.match(card, /createImageBitmap\(await response\.blob\(\)\)/u);
  assert.match(team, /navigator\.clipboard\.write\(\[new window\.ClipboardItem\(\{ "image\/png": blob \}\)\]\)/u);
  assert.match(team, /save\.download = cardFileName\(name\);/u);
  assert.doesNotMatch(card, /shareApiUrl|apiUrl|method: "POST"/u);
});

test("the card shows the rest of the team: who they are, the skills they bring in this mode and their held item, no stats", () => {
  assert.match(team, /function cardTeammates\(index\)/u);
  assert.match(team, /memberSkills\(member, slot\)\.filter\(\(\{ slot: kind \}\) => kind !== "Ultimate"\)/u);
  assert.match(team, /team: cardTeammates\(index\),/u);
  assert.match(card, /function drawTeam\(ctx, team, images, mode\)/u);
  assert.doesNotMatch(card.slice(card.indexOf("function drawTeam"), card.indexOf("async function draw(")), /\.cp|stats/u);
});

test("the card centres the team row, tags each Core skill (Core) in gold, and says Star-Up as the game does", () => {
  assert.match(card, /const start = left \+ \(width - \(shown\.length \* tileW \+ \(shown\.length - 1\) \* 10\)\) \/ 2;/u);
  assert.match(card, /const tag = skill\.core \? " \(Core\)" : "";/u);
  assert.match(team, /slot, core: Boolean\(skill\.core\) \}\)\),/u);
  assert.match(card, /"STAR-UP"/u);
  assert.doesNotMatch(team + card, /Star Up/u);
});
