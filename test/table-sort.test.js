import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFileSync(resolve(import.meta.dirname, "..", path), "utf8").replaceAll("\r\n", "\n");
const helperSource = read("public/table-sort.js");
const home = read("public/index.html");
const boards = read("public/leaderboard/index.html");
const explorer = read("public/explorer/index.html");
const leaderboard = read("public/leaderboard/leaderboard.js");
const app = read("public/app.js");
const duel = read("public/explorer/duel.js");

const context = { window: {}, Intl };
vm.runInNewContext(helperSource, context);
const { sortRows, nextSort, ariaSort, compare } = context.window.AniilogsTableSort;

test("table-sort: numbers by value, text A–Z ignoring case and with numbers in order, empty values last either way", () => {
  const rows = [{ v: 3 }, { v: null }, { v: 10 }, { v: 1 }, { v: Number.NaN }, { v: 3 }];
  assert.deepEqual(sortRows(rows, (r) => r.v, "asc").map((r) => r.v), [1, 3, 3, 10, null, Number.NaN]);
  assert.deepEqual(sortRows(rows, (r) => r.v, "desc").map((r) => r.v), [10, 3, 3, 1, null, Number.NaN]);
  assert.deepEqual(sortRows(["b", "Week 10", "", "a", "Week 9"].map((v) => ({ v })), (r) => r.v, "asc").map((r) => r.v),
    ["a", "b", "Week 9", "Week 10", ""]);
  assert.ok(compare("apple", "Banana") < 0);
});

test("table-sort: ties keep their order (a ranked list stays ranked), and the input isn't changed", () => {
  const rows = [{ id: "a", v: 5 }, { id: "b", v: 7 }, { id: "c", v: 5 }, { id: "d", v: 7 }];
  assert.deepEqual(sortRows(rows, (r) => r.v, "desc").map((r) => r.id), ["b", "d", "a", "c"]);
  assert.deepEqual(sortRows(rows, (r) => r.v, "asc").map((r) => r.id), ["a", "c", "b", "d"]);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c", "d"]);
});

test("table-sort: a new column starts in its natural order, the same column flips; aria-sort follows", () => {
  assert.deepEqual({ ...nextSort({ key: "played", order: "desc" }, "mode", "asc") }, { key: "mode", order: "asc" });
  assert.deepEqual({ ...nextSort({ key: "mode", order: "asc" }, "mode", "asc") }, { key: "mode", order: "desc" });
  assert.deepEqual({ ...nextSort({ key: "mode", order: "desc" }, "mode", "asc") }, { key: "mode", order: "asc" });
  assert.deepEqual({ ...nextSort({ key: "", order: "asc" }, "Damage", "desc") }, { key: "Damage", order: "desc" });
  assert.equal(ariaSort(true, "asc"), "ascending");
  assert.equal(ariaSort(true, "desc"), "descending");
  assert.equal(ariaSort(false, "asc"), null);
});

test("table-sort is loaded before each page script that uses it", () => {
  for (const [page, script] of [[home, "/app.js"], [boards, "/leaderboard/leaderboard.js"], [explorer, "./duel.js"]]) {
    const helper = page.search(/<script[^>]+src="(\.\.)?\/table-sort\.js\?v=/u);
    assert.ok(helper > 0 && helper < page.indexOf(`src="${script}?v=`), script);
  }
});

test("leaderboards: no Rank by menu or ladder chips; column headers sort every board", () => {
  assert.doesNotMatch(boards, /data-filter-sort|Rank by/u);
  assert.doesNotMatch(leaderboard, /els\.sort|lb-chips/u);
  // every column the API can sort by has a sort key, so its header is a button
  assert.match(leaderboard, /sorts: \["clear_time_s", "player", "style", "party_size", "played_at"\]/u);
  assert.match(leaderboard, /sorts: \["standing", "score", "stars", "player", "cycle", "played_at"\]/u);
  assert.match(leaderboard, /sorts: \["score", "difficulty", "cleared", "clear_time_s", "defeats", "player", "cycle", "played_at"\]/u);
  // Season Ladder: sorted here by its headers; ?rank=stars from older links still reads
  assert.match(leaderboard, /state\.rank = Object\.hasOwn\(SEASON_SORTS, params\.get\("rank"\) \|\| ""\) \? params\.get\("rank"\) : "score";/u);
  assert.match(leaderboard, /window\.AniilogsTableSort\.sortRows\(data\.standings, SEASON_SORTS\[state\.rank\]\.value, order\)/u);
  // View all: a figure's header picks the ladder, clicked again ?order= flips it
  assert.match(leaderboard, /if \(state\.viewOrder\) ask\.set\("order", state\.viewOrder\);/u);
  // the ▲/▼ and aria-sort on a sorted header
  assert.match(leaderboard, /"aria-sort": active \? \(order === "asc" \? "ascending" : "descending"\) : null/u);
  // no inline style attributes (the CSP has no 'unsafe-inline' for styles)
  assert.doesNotMatch(leaderboard, /style: `/u);
});

test("My runs: Played newest first by default, the headers sort on the server, rows shown as sent", () => {
  assert.match(app, /const myRuns = \{[^}]*sort: "played", order: "desc" \};/u);
  assert.match(app, /sort: myRuns\.sort, order: myRuns\.order \}\);/u);
  assert.match(app, /rows\.replaceChildren\(\.\.\.page\.runs\.map\(myRunRow\)\);/u);
});

test("1v1: the attack tables sort by their column headers", () => {
  assert.match(duel, /sorter\.sortRows\(result\.rows, sortedBy\.value, attackSort\.order\)/u);
  assert.match(duel, /className: "duel-sort"/u);
});
