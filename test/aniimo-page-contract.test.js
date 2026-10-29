import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const explorer = await readFile(new URL("../public/explorer/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../public/explorer/styles.css", import.meta.url), "utf8");
const themeShell = await readFile(new URL("../public/theme-shell.js", import.meta.url), "utf8");

const pageCode = explorer.slice(explorer.indexOf("// ---- The Aniimo form page"), explorer.indexOf("function renderAniilogCatalogRecord(entry) {"));

test("the Aniimo form page is one fixed grid with the same panels for every form", () => {
  assert.match(explorer, /record\.append\(renderAniilogFormGrid\(entry\)\);/u);
  assert.match(pageCode, /renderAfpJumpBar\(\), renderAfpStats\(entry\), renderAfpSkills\(entry\), renderAfpKit\(entry\), renderAfpProfile\(entry\), renderAfpTabs\(entry\)/u);
  assert.match(pageCode, /const AFP_SKILL_SLOTS = 7;/u);
  assert.match(pageCode, /"Evolution", "Research", "Habitat", "Resonance", "Build", "Rewards"/u);
  assert.match(styles, /grid-template-areas: "stats skills kit" "profile skills tabs";/u);
});

test("every feature of the old page is still reachable from the new one", () => {
  for (const feature of [
    "renderCatalogAbilitySection(\"Combat skills\"", // skill cards: badges, Lv 1 <-> 2, scaling, how it works, unlock forms
    "renderCatalogAbilitySection(\"Ultimate\"",
    "renderCatalogAbilitySection(\"Traits\"",
    "renderCatalogAbilitySection(\"Mobility skills\"",
    "renderCatalogAbilitySection(\"Aniilog Research\"", // research guides with Locate on Map
    "renderCatalogLevels(\"Exploration\"",
    "renderCatalogHomelandLevels(entry.homeland)",
    "renderCatalogLocations(entry)",
    "renderAniilogBossVariants(entry.boss_variants)",
    "renderCatalogEvolution(evolution)",
    "renderAniimoResearch(entry",
    "renderAniimoProgression(value",
    "renderAniilogStatComparison(entry)",
    "locateAniilogEntry(entry)",
    "renderItemlogReference(",
    "openAniilogRecord(partner.id)",
  ]) assert.ok(pageCode.includes(feature), `missing: ${feature}`);
  // View Model and Show Artwork move into the form header; the mobile sticky header's copies press the real ones.
  assert.match(explorer, /identityActions\.prepend\(\.\.\.headingActions\.childNodes\)/u);
  assert.match(explorer, /\.catalog-showcase-button, \.catalog-model-button"\)\.forEach/u);
});

test("growth uses the game's formulas: +0.8% per potential level and +4% every 4 levels", () => {
  assert.match(pageCode, /\(1 \+ growth\.attribute_point_bonus \* points\) \/ formula\.divisor \* value \* formula\.scale/u);
  assert.match(pageCode, /Math\.floor\(points \/ step\.every\) \* step\.percent/u);
  assert.match(pageCode, /steps \* \(20 \+ 3 \* steps\) \/ 50/u);
});

test("developer-only details show only in Developer Mode, with Unverified badges", () => {
  assert.match(pageCode, /const details = developerModeEnabled\(\) \? afpDeveloperDetails\(entry\) : null;/u);
  assert.match(pageCode, /\.\.\.\(developerModeEnabled\(\) \? \["Developer"\] : \[\]\)/u);
  assert.match(pageCode, /developerAvailabilityBadge\("unverified"/u);
});

test("in the aLogs app the site hides its theme picker and sign-in, and offers Open in browser", () => {
  assert.match(styles, /html\[data-embed="app"\] \.theme-picker-label,\s*html\[data-embed="app"\] #topbarSignInLink,\s*html\[data-embed="app"\] #topbarLogoutButton/u);
  assert.match(themeShell, /\["embed", "uid", "theme", "v"\]\.forEach\(\(name\) => url\.searchParams\.delete\(name\)\)/u);
  assert.match(themeShell, /link\.target = "_blank";/u);
});
