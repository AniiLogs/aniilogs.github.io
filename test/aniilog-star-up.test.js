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
