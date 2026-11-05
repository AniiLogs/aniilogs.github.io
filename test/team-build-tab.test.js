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
  assert.match(team, /wrap\.append\(renderSkillPicks\(member, form, index\), renderStatTable\(member, entry\)\);/u);
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
  assert.match(card, /const tag = skill\.core \? \(skill\.enhanced \? " \(Core · Enhanced\)" : " \(Core\)"\) : "";/u);
  assert.match(team, /slot, core: Boolean\(skill\.core\), enhanced: Boolean\(enhanced\) \}\)\),/u);
  assert.match(card, /"STAR-UP"/u);
  assert.doesNotMatch(team + card, /Star Up/u);
});

test("Team Builder's tabs: Team Builder, Type matchups and the Guide on top; PvE / PvP; then that group's modes", () => {
  assert.match(team, /\[\["team", "Team Builder"\], \["types", "Type matchups"\], \["guide", window\.AniilogsGuide\?\.title \|\| "Guide"\]\]/u);
  for (const [id, label, group] of [["standard", "Standard", "pve"], ["interlink", "Interlink", "pve"], ["holosim", "Holo-Sim", "pve"],
    ["eggheist", "Egg Heist", "pve"], ["pvpfair", "Fair \\(WIP\\)", "pvp"], ["pvpunfair", "Unfair \\(WIP\\)", "pvp"], ["eggheistpvp", "Egg Heist PvP", "pvp"]]) {
    assert.match(team, new RegExp(`\\{ id: "${id}", label: "${label}", share: "[a-z]", group: "${group}"`, "u"));
  }
  // 1v1 is PvP's first tab (its own page, duel.js)
  assert.match(team, /const DUEL_TAB = \["duel", "1v1"\];/u);
  assert.match(team, /if \(viewState\.page === DUEL_TAB\[0\]\) return "pvp";/u);
  assert.match(team, /if \(!typesPage && !guidePage\) controls\.append\(renderGroupSwitch\(\), renderModeSwitch\(\)\);/u);
});

test("both Egg Heist modes work like Interlink with the main Aniimo in slot 2; every Aniimo's trait is on the card", () => {
  assert.match(team, /id: "eggheist", label: "Egg Heist", share: "e", group: "pve", main: 1 \}/u);
  assert.match(team, /id: "eggheistpvp", label: "Egg Heist PvP", share: "x", group: "pvp", main: 1 \}/u);
  assert.match(team, /return main !== null && index !== main;/u);
  assert.match(team, /index === main \? "Main Aniimo" : `Support \$\{index < main \? index \+ 1 : index\}`/u);
  assert.match(team, /traits: cardTraits\(form\),/u);
  assert.match(card, /\(mate\.traits \|\| \[\]\)\.forEach\(\(trait\) => \{/u);
});

test("the Core skill has its own slot: never an active pick, always listed; the card puts Core left, actives stacked, Ultimate right", () => {
  assert.match(team, /const skills = skillsOf\(form, "skill"\)\.filter\(\(skill\) => !skill\.core\);/u);
  assert.match(team, /skillsOf\(form, "skill"\)\.filter\(\(skill\) => !skill\.core\)\.map\(\(skill\) => String\(skill\.id\)\)/u);
  assert.match(team, /if \(core\) rows\.push\(coreRow\(core\)\);/u);
  assert.match(card, /tall\(core, rx, "No Core skill"/u);
  assert.match(card, /const y = 280 \+ row \* 71;/u);
  assert.match(card, /tall\(ultimate, mx \+ cellW \+ 10, "No Ultimate"/u);
});

test("a filled slot has a Remove button (sidebar and overview); when the team is full, Add to team becomes Replace with a list of the team", () => {
  assert.match(team, /const remove = button\("Remove", "team-slot-remove"/u);
  assert.match(team, /function removeFromTeam\(index\)/u);
  assert.match(team, /const holder = el\("div", "team-overview-slot"\);/u);
  assert.match(team, /menu\.append\(el\("summary", "team-loadout-action team-partners-add", "Replace"\)\);/u);
  assert.match(team, /const option = button\("", "team-replace-option", \(\) => addToTeam\(formId, index\)\);/u);
  assert.match(team, /card\.append\(copy, renderAddControl\(formId\)\);/u);
  assert.doesNotMatch(team, /label: "Replace…"/u);
});

test("in Interlink and both Egg Heist modes the share card is always about the main Aniimo, whichever slot is open", () => {
  assert.match(team, /const index = main \?\? selectedIndex;/u);
  assert.match(team, /const member = main === null \? selectedMember : model\.members\[main\];/u);
  assert.match(team, /make\.disabled = !window\.AniilogsBuildCard \|\| !formFor\(target\.member\);/u);
});

test("the Core skill says whether it is enhanced (the game's word): a toggle beside it, and on the card", () => {
  assert.match(team, /function coreEnhanced\(member, skill\)/u);
  assert.match(team, /slot: coreEnhanced\(member, skill\) \? "Core skill · Enhanced" : "Core skill"/u);
  assert.match(team, /function renderCoreEnhanced\(member, core\)/u);
  assert.match(team, /coreToggle: false,/u);
  assert.match(card, /skill\.enhanced \? " \(Core · Enhanced\)" : " \(Core\)"/u);
});

test("Generate Team Card sits next to Copy team link; on phones the floating button is a quick-actions menu with both", () => {
  const app = read("app.js");
  assert.match(team, /window\.AniilogsTeamBuilder = Object\.freeze\(\{ show, applyAddress, quickActions \}\);/u);
  assert.match(team, /\{ id: "link", label: "Copy team link"/u);
  assert.match(team, /\{ id: "card", label: "Generate Team Card"/u);
  assert.match(team, /shareRow\.append\(button\("Copy team link", "team-share-button", shareTeam\), renderCardButton\(\)\);/u);
  assert.match(app, /if \(state\.sidebarView !== "team" \|\| !window\.matchMedia\(PHONE_CATALOG_QUERY\)\.matches\) return \[\];/u);
  assert.match(app, /item\("Back to team", icons\.top/u);
  assert.match(app, /const contents = Boolean\(input\) && !input\.matches\("input"\);/u);
});
