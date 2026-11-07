import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path) => readFileSync(resolve(import.meta.dirname, "..", path), "utf8").replaceAll("\r\n", "\n");
const home = read("public/index.html");
const boards = read("public/leaderboard/index.html");
const app = read("public/app.js");
const viewer = read("public/proof-viewer.js");
const leaderboard = read("public/leaderboard/leaderboard.js");

test("My runs: one proof viewer, shared by the leaderboards and the profile, loaded before either page's script", () => {
  for (const [page, script] of [[home, "/app.js"], [boards, "/leaderboard/leaderboard.js"]]) {
    const shared = page.indexOf('<script src="/proof-viewer.js');
    assert.ok(shared > 0 && shared < page.indexOf(`<script src="${script}`), script);
    assert.match(page, /<link rel="stylesheet" href="\/proof-viewer\.css\?v=/u);
  }
  assert.match(viewer, /window\.AniilogsProof = Object\.freeze\(\{ open: openProof, button: proofButton, checkBadge, partyPanel \}\)/u);
  // the menu picture beside the run's, and a menu best's run beside it
  assert.match(viewer, /label: "Menu"/u);
  assert.match(viewer, /details\.runProof/u);
  // the leaderboards use it rather than a copy of their own
  assert.doesNotMatch(leaderboard, /async function openProof/u);
  assert.match(leaderboard, /const proofViewer = window\.AniilogsProof;/u);
});

test("My runs: search, mode filter, 20/30/50 per page (remembered), numbered pages, proof column, on your own profile only", () => {
  assert.match(home, /data-history-search/u);
  assert.match(home, /<select data-history-page-size><option value="20">20<\/option><option value="30">30<\/option><option value="50">50<\/option><\/select>/u);
  assert.match(home, /<th scope="col">Mode<\/th><th scope="col">Fight<\/th><th scope="col">Played<\/th><th scope="col">Result<\/th><th scope="col">Party<\/th><th scope="col">Proof<\/th>/u);
  assert.match(app, /const MY_RUNS_PAGE_SIZES = \[20, 30, 50\];/u);
  assert.match(app, /window\.localStorage\.setItem\(MY_RUNS_PAGE_SIZE_KEY/u);
  assert.match(app, /const MY_RUNS_SEARCH_WAIT_MS = 250;/u);
  assert.match(app, /new URLSearchParams\(\{ page: String\(myRuns\.page\), limit: String\(myRuns\.pageSize\)/u);
  // a public profile keeps its own view; only your own profile gets My runs
  assert.match(app, /if \(publicId\) void loadHistoryPage\(true\); else startMyRuns\(\);/u);
  assert.match(app, /historyPath = publicId \? `\/profiles\/\$\{encodeURIComponent\(publicId\)\}\/history` : "\/profile\/history";/u);
  // each teammate's Battle Data figures, and the proof viewer's button with the menu picture
  assert.match(app, /\["DPS", player\.avgDps\], \["BREAK", player\.breakValue\], \["Taken", player\.damageTaken\], \["Heal", player\.heal\]/u);
  assert.match(app, /window\.AniilogsProof\.button\(run\.submissionId, run\.check, run\.menuProofId \|\| null\)/u);
  // a stale answer never replaces a newer search's
  assert.match(app, /if \(request !== myRuns\.request\) return;/u);
});
