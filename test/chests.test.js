import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Treasure chests: map pins outlined by tier, and a Chests checklist whose ticks are the pins' own ticks.
const read = (file) => readFileSync(new URL(`../public/explorer/${file}`, import.meta.url), "utf8");
const app = read("app.js");
const css = read("styles.css");

test("chest pins and checklist icons are outlined blue, purple or gold by tier", () => {
  assert.match(app, /CHEST_TIER_COLORS = Object\.freeze\(\{ blue: "#4da3ff", purple: "#b57cff", gold: "#f2c14e" \}\)/u);
  assert.match(app, /pin-chest pin-chest-\$\{spawn\.chest_tier\}/u);
  assert.match(app, /checklist-chest checklist-chest-\$\{entry\.chest_tier\}/u);
  for (const tier of ["purple", "gold"]) assert.match(css, new RegExp(`\\.pin-chest-${tier},\\r?\\n\\.checklist-chest-${tier} \\{`, "u"));
  assert.match(css, /\.pin-chest \.pin-icon,\r?\n\.checklist-chest \{\r?\n  filter:\r?\n    drop-shadow\(1\.5px 0 0 var\(--chest-ring\)\)/u);
  assert.doesNotMatch(css, /\.pin-chest \.pin-body \{/u);          // an outline on the mark, no ring around it
  assert.match(app, /tintedCanvasIcon\(icon, chestColor\)/u);
});

test("a chest checklist row says what it pays, can Locate its pin, and ticks the pin with it", () => {
  assert.match(app, /entry\?\.kind === "treasure_chest" && entry\.rewards/u);
  assert.match(app, /\(isLuminChecklistEntry\(entry\) \|\| entry\?\.kind === "treasure_chest"\) && entry\?\.map_id/u);
  assert.match(app, /if \(isLuminChecklistEntry\(entry\) \|\| entry\?\.kind === "treasure_chest"\) \{\r?\n    refreshLuminCompletionViews\(\);/u);
});
