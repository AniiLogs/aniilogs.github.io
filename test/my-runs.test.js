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
  assert.match(viewer, /window\.AniilogsProof = Object\.freeze\(\{ open: openProof, button: proofButton, checkBadge, partyPanel, allowDelete \}\)/u);
  // the menu picture beside the run's, and a menu best's run beside it
  assert.match(viewer, /label: "Menu"/u);
  assert.match(viewer, /details\.runProof/u);
  // the leaderboards use it rather than a copy of their own
  assert.doesNotMatch(leaderboard, /async function openProof/u);
  assert.match(leaderboard, /const proofViewer = window\.AniilogsProof;/u);
});

test("My runs: search, mode filter, 20/30/50 per page (remembered), numbered pages, proof column, on your profile", () => {
  assert.match(home, /data-history-search/u);
  assert.match(home, /<select data-history-page-size><option value="20">20<\/option><option value="30">30<\/option><option value="50">50<\/option><\/select>/u);
  assert.match(home, /<th scope="col" data-myruns-sort="mode">Mode<\/th><th scope="col" data-myruns-sort="fight">Fight<\/th><th scope="col" data-myruns-sort="played" aria-sort="descending">Played<\/th><th scope="col" data-myruns-sort="result">Result<\/th><th scope="col" data-myruns-sort="party">Party<\/th><th scope="col">Proof<\/th>/u);
  assert.match(app, /const MY_RUNS_PAGE_SIZES = \[20, 30, 50\];/u);
  assert.match(app, /window\.localStorage\.setItem\(MY_RUNS_PAGE_SIZE_KEY/u);
  assert.match(app, /const MY_RUNS_SEARCH_WAIT_MS = 250;/u);
  assert.match(app, /new URLSearchParams\(\{ page: String\(myRuns\.page\), limit: String\(myRuns\.pageSize\)/u);
  // your own profile, or a visitor on a profile whose runs are public (the server decides; the same list)
  assert.match(app, /historyPath = publicId \? `\/profiles\/\$\{encodeURIComponent\(publicId\)\}\/history` : "\/profile\/history";/u);
  // each teammate's Battle Data figures, and the proof viewer's button with the menu picture
  assert.match(app, /\["DPS", player\.avgDps\], \["BREAK", player\.breakValue\], \["Taken", player\.damageTaken\], \["Heal", player\.heal\]/u);
  assert.match(app, /window\.AniilogsProof\.button\(run\.submissionId, run\.check, run\.menuProofId \|\| null\)/u);
  // a stale answer never replaces a newer search's
  assert.match(app, /if \(request !== myRuns\.request\) return;/u);
});

test("My runs' switch: in Edit profile, private by default, off the Custom list, sent as runsPublic", () => {
  assert.match(home, /<select name="runsPublic" data-profile-runs-public>\s*<option value="private">Private: only me<\/option>\s*<option value="public">Public: on my public profile<\/option>/u);
  assert.doesNotMatch(home, /<input type="checkbox" value="history">/u);
  assert.match(app, /runsPublic: profileRunsPublic\.value === "public",/u);
  assert.match(app, /profileRunsPublic\.disabled = !shown;/u);
  // visitors get the same list (when the profile shows it), a season part's best runs from the Interlink card
  assert.match(app, /startMyRuns\(publicId\);/u);
  assert.match(app, /params\.set\("split", myRuns\.scope\.split\);/u);
});

test("the Interlink card: the current season part, its weeks as a tree (week > boss > runs), earlier parts linking to their best runs", () => {
  assert.match(app, /function renderInterlink\(boards, \{ publicId = null, runsOpen = false \} = \{\}\)/u);
  assert.match(app, /const parts = boards\.interlinkParts;/u);
  assert.match(app, /next\.set\("best", "1"\);/u);
  // a visitor's boss lines open to runs only when the profile shows its runs
  assert.match(app, /runsOpen: !publicId \|\| \(Array\.isArray\(overview\.parts\) && overview\.parts\.includes\("history"\)\)/u);
  assert.match(app, /new URLSearchParams\(\{ page: "1", limit: "50", mode: "interlink", boss: boss\.id, cycle: week\.cycle \}\)/u);
});

test("every row that opens on the profile shows whether it is open: a turning chevron, aria-expanded, an accent bar", () => {
  const styles = read("public/styles.css");
  assert.match(app, /const sync = \(\) => summary\.setAttribute\("aria-expanded", String\(details\.open\)\);/u);
  // the Interlink weeks and bosses and the Battle History runs all use it
  assert.match(app, /details\.append\(summary\);\s*disclosure\(details\);\s*const bosses/u);
  assert.match(app, /inner\.append\(head, holder\);\s*disclosure\(inner\);/u);
  assert.match(app, /summary\.append\(title, numbers, chips\);\s*details\.append\(summary\);\s*disclosure\(details\);/u);
  assert.match(styles, /\.disclosure\[open\] > summary \.disclosure-chevron \{ transform: rotate\(90deg\);/u);
  assert.match(styles, /\.disclosure\[open\] > summary \{[^}]*box-shadow: inset 3px 0 0 var\(--teal\);/u);
  // a run's party: a block per player, the lead not repeated among the team chips
  assert.match(app, /if \(leadAt >= 0\) team\.splice\(leadAt, 1\);/u);
  assert.doesNotMatch(app, /"Team: "/u);
  // Battle Data in a narrow card: labelled figures, no sideways scroll
  assert.match(styles, /@container \(max-width: 459px\) \{\s*\.history-party, \.history-party tbody, \.history-party tr \{ display: block; \}/u);
});
