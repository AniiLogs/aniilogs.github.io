import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Treasure chests: the chest mark filled with its tier's colour (outlined white; an Ancient chest rainbow-edged and pearly),
// and a Chests checklist whose ticks are the pins' own ticks.
const read = (file) => readFileSync(new URL(`../public/explorer/${file}`, import.meta.url), "utf8");
const app = read("app.js");
const css = read("styles.css");

test("chest marks are filled blue, purple, gold or red by tier; outlined white, or rainbow-edged and pearly if Ancient", () => {
  assert.match(app, /CHEST_TIER_COLORS = Object\.freeze\(\{ blue: "#4da3ff", purple: "#b57cff", gold: "#f2c14e", red: "#ff4d4d" \}\)/u);
  assert.match(app, /pin-chest pin-chest-\$\{spawn\.chest_tier\}/u);
  assert.match(app, /checklist-chest checklist-chest-\$\{entry\.chest_tier\}/u);
  // DOM pins and checklist icons: the mark is a mask over the tier's colour
  assert.match(app, /CHEST_TIER_COLORS\[spawn\.chest_tier\] \? chestGlyph\("pin-icon", iconSource\)/u);
  assert.match(app, /\? chestGlyph\(iconClasses\.join\(" "\), entry\.icon\)/u);
  assert.match(css, /\.chest-glyph-fill,\r?\n\.chest-glyph-edge \{[^}]*mask: var\(--chest-icon\) center \/ contain no-repeat;/u);
  assert.match(css, /\.chest-glyph-fill \{[^}]*background: var\(--chest-ring\);/u);
  for (const tier of ["purple", "gold", "red"]) assert.match(css, new RegExp(`\\.pin-chest-${tier},\\r?\\n\\.checklist-chest-${tier} \\{`, "u"));
  // the outline: white; an Ancient chest instead gets a rainbow edge behind it and a pearly sheen over its colour
  assert.match(css, /\.chest-glyph \{[^}]*drop-shadow\(1\.5px 0 0 #ffffff\)/u);
  assert.match(css, /\.checklist-chest-ancient \.chest-glyph-edge \{[^}]*background: conic-gradient\(#ff4fd8, #ffe14d, #4dffb8, #3fd9ff, #9d6bff, #ff4fd8\);/u);
  // (the chest sits inside its rainbow edge, so an Ancient chest is the same size as the others)
  assert.match(css, /\.checklist-chest-ancient \.chest-glyph-fill \{\r?\n  transform: scale\(0\.8\);[^\n]*\r?\n  background:\r?\n    linear-gradient\(135deg, transparent 30%, rgba\(255, 255, 255, 0\.75\) 45%, transparent 60%\),\r?\n    var\(--chest-ring\);/u);
  // the canvas map: the tier-tinted mark over a white outline, or between the rainbow edge and the sheen
  assert.match(app, /tintedCanvasIcon\(icon, "#ffffff"\)/u);
  assert.match(app, /context\.drawImage\(pearlCanvasLayer\(icon, "edge"\), left, top, iconSize, iconSize\);/u);
  assert.match(app, /context\.drawImage\(pearlCanvasLayer\(icon, "sheen"\), x - innerSize \/ 2, y - innerSize \/ 2, innerSize, innerSize\);/u);
  assert.doesNotMatch(css, /\.pin-chest \.pin-body \{/u);          // no ring around the mark
});

test("a chest checklist row says what it pays, can Locate its pin, and ticks the pin with it", () => {
  assert.match(app, /entry\?\.kind === "treasure_chest" && entry\.rewards/u);
  assert.match(app, /\(isLuminChecklistEntry\(entry\) \|\| entry\?\.kind === "treasure_chest"\) && entry\?\.map_id/u);
  assert.match(app, /if \(isLuminChecklistEntry\(entry\) \|\| entry\?\.kind === "treasure_chest"\) \{\r?\n    refreshLuminCompletionViews\(\);/u);
});
