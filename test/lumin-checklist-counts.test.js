import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// The Lumin checklist counts each find once (game build 3857679): the Blessed Wisptis Themed Puzzle and its Amber are
// linked, 13 Themed Puzzles that give no Amber are listed as such, and app.js leaves both kinds out of the totals.
const window = {};
vm.runInNewContext(readFileSync(new URL("../public/explorer/lumin-routes.js", import.meta.url), "utf8"), { window });
const app = readFileSync(new URL("../public/explorer/app.js", import.meta.url), "utf8");

test("Blessed Wisptis Themed Puzzle and its Amber are one find", () => {
  const puzzle = "amber:lumin_marking:country-of-time:3000:CURRENT_N774_11_1328_83:collected";
  const amber = "amber:overworld:country-of-time:3000:CURRENT_N771_79_1323_74:collected";
  assert.deepEqual([...window.ANIILOGS_LUMIN_LINKS[puzzle]], [amber]);
  assert.deepEqual([...window.ANIILOGS_LUMIN_LINKS[amber]], [puzzle]);
});

test("Themed Puzzles without an Amber are listed and left out of the checklist", () => {
  const noAmber = window.ANIILOGS_LUMIN_NO_AMBER;
  assert.equal(noAmber.length, 14);
  assert.ok(noAmber.includes("amber:event:whisperwake-isles:3003:CURRENT_70_63_N20_02:collected"));
  assert.ok(!noAmber.includes("amber:lumin_marking:country-of-time:3000:CURRENT_N774_11_1328_83:collected"));
  assert.match(app, /const leftOut = luminChecklistLeftOut\(state\.checklistData\.entries\);/u);
  assert.match(app, /!leftOut\.has\(entry\?\.completion_states\?\.\[0\]\?\.id\)/u);
});

test("Breezy Plains Sanctums are Lumin finds on the checklist, and the region's Lumin stop at 200", () => {
  const sanctums = window.ANIILOGS_SANCTUM_LUMIN;
  assert.equal(sanctums.length, 17);
  for (const entry of sanctums) {
    assert.equal(entry.kind, "lumin_sanctum");
    assert.equal(entry.completion_states[0].quantity, 1);
    assert.match(entry.completion_states[0].legacy_completion_ids[0], /^pin:country-of-time:current-poi-10305:CURRENT_/u);
  }
  assert.match(app, /function isLuminSanctumSpawn\(spawn\)/u);
  assert.match(app, /const LUMIN_REGION_CAPS = Object\.freeze\(\{ "country-of-time": 200 \}\);/u);
  assert.match(app, /\.\.\.\(window\.ANIILOGS_SANCTUM_LUMIN \|\| \[\]\),/u);
});
