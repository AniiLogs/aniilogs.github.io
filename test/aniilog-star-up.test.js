import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// The Aniilog tab's Growth stats offer the Team Builder's Star Up (stage and level), worked out by the same stat model.
const app = readFileSync(new URL("../public/explorer/app.js", import.meta.url), "utf8");

test("the Aniilog Growth stats have Star Up stage and level, computed like the Team Builder", () => {
  assert.match(app, /const starTable = state\.afpTeamData\?\.star_up;/u);
  assert.match(app, /makeSelect\("Star Up", \[\[0, "None"\]/u);
  assert.match(app, /makeSelect\("Star Up level"/u);
  assert.match(app, /function afpBonusGains\(entry, stats, own, level, heldItem, starUp\)/u);
  assert.match(app, /heldItems: heldItem \? \[heldItem\] : \[\], starUp: starUp \|\| undefined/u);
  assert.doesNotMatch(app, /afpHeldItemGains|typedMax/u);
});

test("the Aniilog Growth values are the Team Builder's (rounded up like the game's card), not a separate formula", () => {
  assert.match(app, /const totalsByLevel = model\?\.statTotals && teamData\?\.forms\?\.\[String\(entry\.form_id\)\]/u);
  assert.match(app, /totalsByLevel\[index\]\?\.\[stat\.display\]/u);
});

test("held-item buffs that change past a stat's potential are applied once every potential source is counted", () => {
  const model = readFileSync(new URL("../public/explorer/damage-model.js", import.meta.url), "utf8");
  assert.match(model, /if \(attribute\.potential_over\) conditional\.push\(\{ attribute, source \}\);/u);
  assert.match(model, /total > attribute\.potential_over\.over \? attribute\.potential_over\.value : attribute\.value/u);
});
