import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Values that scale with a stat (ATK, REGEN, HP, P.DEF...) show their number at the stats you set: the Team Builder
// member's stat card, or the Aniilog tab's Growth panel.
const read = (file) => readFileSync(new URL(`../public/explorer/${file}`, import.meta.url), "utf8");
const window = {};
vm.runInNewContext(read("damage-model.js"), { window });
const { scalingNote } = window.AniilogsDamage;

test("a skill's scaling note gives its value at a stat, capped at its maximum", () => {
  assert.deepEqual({ ...scalingNote("20.00, plus an additional 1.25 for every 100 ATK, up to a total maximum of 30.00.", { ATK: 469 }) },
    { value: 25.8625, percent: false, stat: "ATK", statValue: 469, decimals: 2 });
  assert.equal(scalingNote("24.0%, plus an additional 3.60% for every 100 REGEN, up to a total maximum of 42.0%.", { REGEN: 460 }).value.toFixed(2), "40.56");
  assert.equal(scalingNote("28.0%, plus an additional 2.63% for every 100 ATK, up to a total maximum of 49.0%.", { ATK: 2000 }).value, 49);
  assert.equal(scalingNote("Also applies 1 unnamed internal state.", { ATK: 1 }), null);
  assert.equal(scalingNote("0.80, plus an additional 0.08 for every 100 HP, up to a total maximum of 1.20.", {}), null);
});

test("the Team Builder and the Aniilog tab use the stats you set", () => {
  const team = read("team-builder.js");
  assert.match(team, /scalingStats = memberCardStats\(member\);/u);
  assert.match(team, /note \+ scalingSuffix\(note\)/u);
  assert.match(team, /window\.AniilogsDamage\.scaledValue\(attribute\.scaling, scalingStats/u);
  const app = read("app.js");
  assert.match(app, /text\.dataset\.scalingNote = line;/u);
  assert.match(app, /window\.setTimeout\(\(\) => afpRefreshScalingNotes\(entry\), 0\);/u);
});
