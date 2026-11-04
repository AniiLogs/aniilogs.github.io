import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Treasure chests: the chest mark filled with its tier's colour (outlined white, or pearlescent for an Ancient chest),
// and a Chests checklist whose ticks are the pins' own ticks.
const read = (file) => readFileSync(new URL(`../public/explorer/${file}`, import.meta.url), "utf8");
const app = read("app.js");
const css = read("styles.css");

test("chest marks are filled blue, purple, gold or red by tier, outlined white or pearlescent", () => {
  assert.match(app, /CHEST_TIER_COLORS = Object\.freeze\(\{ blue: "#4da3ff", purple: "#b57cff", gold: "#f2c14e", red: "#ff4d4d" \}\)/u);
  assert.match(app, /pin-chest pin-chest-\$\{spawn\.chest_tier\}/u);
  assert.match(app, /checklist-chest checklist-chest-\$\{entry\.chest_tier\}/u);
  // DOM pins and checklist icons: the mark is a mask over the tier's colour
  assert.match(app, /CHEST_TIER_COLORS\[spawn\.chest_tier\] \? chestGlyph\("pin-icon", iconSource\)/u);
  assert.match(app, /\? chestGlyph\(iconClasses\.join\(" "\), entry\.icon\)/u);
  assert.match(css, /\.chest-glyph-fill \{[^}]*background: var\(--chest-ring\);[^}]*mask: var\(--chest-icon\) center \/ contain no-repeat;/u);
  for (const tier of ["purple", "gold", "red"]) assert.match(css, new RegExp(`\\.pin-chest-${tier},\\r?\\n\\.checklist-chest-${tier} \\{`, "u"));
  // the outline: white, or a soft hue per side for an Ancient chest
  assert.match(css, /\.chest-glyph \{[^}]*drop-shadow\(1\.5px 0 0 var\(--chest-edge-1\)\)/u);
  assert.match(css, /\.pin-chest-ancient,\r?\n\.checklist-chest-ancient \{\r?\n  --chest-edge-1: #ff7ad9;/u);
  // the canvas map: the tier-tinted mark over a white (or pearlescent) outline
  assert.match(app, /tintedCanvasIcon\(icon, ancient \? CHEST_PEARL_COLORS\[side\] : "#ffffff"\)/u);
  assert.match(app, /context\.drawImage\(tintedCanvasIcon\(icon, chestColor\), left, top, iconSize, iconSize\)/u);
  assert.doesNotMatch(css, /\.pin-chest \.pin-body \{/u);          // no ring around the mark
});

test("a chest checklist row says what it pays, can Locate its pin, and ticks the pin with it", () => {
  assert.match(app, /entry\?\.kind === "treasure_chest" && entry\.rewards/u);
  assert.match(app, /\(isLuminChecklistEntry\(entry\) \|\| entry\?\.kind === "treasure_chest"\) && entry\?\.map_id/u);
  assert.match(app, /if \(isLuminChecklistEntry\(entry\) \|\| entry\?\.kind === "treasure_chest"\) \{\r?\n    refreshLuminCompletionViews\(\);/u);
});
