// The Per Boss boards' rows (public/leaderboard/leaderboard.js and .css): one line per player, the result on the right,
// a blue badge for claimed players, places said 1st / 2nd, bots on a team row marked AI. Made-up names only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFileSync(resolve(import.meta.dirname, "..", "public", path), "utf8");
const boards = read("leaderboard/leaderboard.js");
const css = read("leaderboard/leaderboard.css");

// the page's own ordinal(), taken out of the page script and run as it is
function loadOrdinal() {
  const start = boards.indexOf("function ordinal(n) {");
  assert.ok(start > 0, "ordinal() is in the page script");
  const end = boards.indexOf("\n  }\n", start);
  return vm.runInNewContext(`(${boards.slice(start, end + 4)})`);
}

test("ordinal: 1st, 2nd, 3rd, 4th, and the teens with th", () => {
  const ordinal = loadOrdinal();
  const cases = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 11: "11th", 12: "12th", 13: "13th", 21: "21st", 22: "22nd", 23: "23rd",
    101: "101st", 111: "111th", 112: "112th", 10: "10th", 100: "100th", 113: "113th", 1011: "1011th", 1021: "1021st" };
  for (const [n, said] of Object.entries(cases)) assert.equal(ordinal(Number(n)), said, n);
  assert.equal(ordinal("3"), "3rd");                                         // a rank sent as text
});

test("a team row: the players ranked with another run are lines in their seats, \"Name (1st)\" in italics; no \"place N\"", () => {
  assert.match(boards, /el\("span", \{ class: "lb-who-name lb-also-line", title: `Ranked \$\{place\} with another run\.` \}, mark, name,\s*el\("span", \{ class: "lb-also-place", text: `\(\$\{place\}\)` \}\)\)/u);
  assert.match(boards, /const place = ordinal\(other\.rank\);/u);
  assert.match(boards, /el\("span", \{ class: "lb-who" \}, \.\.\.teamNames\(members, ladder\)\),/u);     // no "Also on this run" under the boards' names
  assert.doesNotMatch(boards, /\(place \$\{/u);
  assert.match(css, /\.lb-also-line > \.lb-name, \.lb-also-place, \.lb-legend-also \{ color: color-mix\(in srgb, var\(--text\) 62%, transparent\); font-style: italic;/u);
});

test("seats: lines in seat order only when every line has one; else players, also-players, bots; the mark column always there", () => {
  assert.match(boards, /\.\.\.members\.map\(\(entry\) => \(\{ kind: "player", seat: seatOf\(entry\.seat\), entry \}\)\),\s*\.\.\.\(Array\.isArray\(lead\?\.also\) \? lead\.also : \[\]\)\.map\(\(entry\) => \(\{ kind: "also"/u);
  assert.match(boards, /if \(items\.every\(\(item\) => item\.seat\)\) items\.sort\(\(a, b\) => a\.seat - b\.seat\);/u);
  // the game's pictures come from the content store (never this repository), with their text in the same spot otherwise
  assert.match(boards, /const SEAT_PICTURES = Object\.freeze\(\{ 1: "1p", 2: "2p", 3: "3p", 4: "4p", ai: "ai" \}\);/u);
  assert.match(boards, /contentUrl\(`assets\/ui\/position\/\$\{SEAT_PICTURES\[bot \? "ai" : seat\]\}\.png`\)/u);
  assert.match(boards, /picture\.addEventListener\("error", fallback, \{ once: true \}\);/u);
  assert.match(boards, /box\.replaceChildren\(bot \? botPill\(\) : el\("span", \{ class: "lb-seat-text", text: label \}\)\)/u);
  assert.match(boards, /el\("img", \{ src, alt: label, width: bot \? 93 : 90, height: bot \? 87 : 85, decoding: "async"/u);
  assert.doesNotMatch(boards, /loading: "lazy"/u);
  assert.match(css, /\.lb-seat \{ display: inline-grid; flex: none; place-items: center; width: 1\.65rem;/u);
});

test("a claimed player gets the blue badge after the name; an unclaimed one no pill, a softer line that says why", () => {
  assert.match(boards, /const CLAIMED_TEXT = "Claimed: this run is tied to this player's own UID\.";/u);
  assert.match(boards, /el\("span", \{ class: "lb-claimed", role: "img", title: CLAIMED_TEXT, "aria-label": CLAIMED_TEXT \}\)/u);
  assert.match(boards, /entry\.unclaimed \? null : claimedBadge\(\),\s*entry\.own \? el\("span", \{ class: "lb-you", text: "you" \}\) : null,/u);
  assert.doesNotMatch(boards, /text: "unclaimed"/u);                         // the old grey pill is gone
  assert.match(boards, /class: entry\.unclaimed \? "lb-who-name is-unclaimed" : "lb-who-name", title: entry\.unclaimed \? UNCLAIMED_TEXT : null/u);
  assert.match(boards, /const UNCLAIMED_TEXT = "From a teammate's run\. Not claimed: no UID was recorded for this player with the run\.";/u);
  // the tables use the same marks: the claimed badge and the softer unclaimed name there too
  assert.match(boards, /class: entry\.unclaimed \? "lb-player is-unclaimed" : "lb-player", title: entry\.unclaimed \? UNCLAIMED_TEXT : null/u);
  assert.match(css, /\.lb-claimed \{[^}]*color: #2b7de9;/u);
  assert.match(css, /\.is-unclaimed \.lb-name, \.lb-player\.is-unclaimed \.lb-expand \{ color: color-mix\(in srgb, var\(--text\) 62%, transparent\);/u);
  // one line per player, its marks never wrapping away; only the name is cut
  assert.match(css, /\.lb-who-name \{ display: flex; flex-wrap: nowrap;/u);
  assert.match(css, /\.lb-who-name > \.lb-name \{ flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/u);
  assert.doesNotMatch(boards, /lb-sep|lb-team-names/u);                      // no "·" between names any more
});

test("a row has three columns: the updated calendar moved into the result's icons; the head row has no icon column", () => {
  assert.match(css, /\.lb-row \{ display: grid; grid-template-columns: 1\.6rem minmax\(0, 1fr\) auto; align-items: start;/u);
  assert.match(css, /\.lb-rows-head \{ display: grid; grid-template-columns: 1\.6rem minmax\(0, 1fr\) auto;/u);
  assert.doesNotMatch(css, /1\.4rem 4\.2rem|lb-rows-head-when/u);
  assert.doesNotMatch(boards, /lb-rows-head-when|lineIcon\("update"\)/u);
  // the right column: figure, stars, outcome, then check, pictures, link and calendar on one line
  assert.match(boards, /el\("span", \{ class: "lb-row-icons" \}, checkBadge\(rowCheck\(entry, ladder\)\), proof, link, updatedIcon\(updatedAt\)\)/u);
  assert.match(boards, /rowFigures\(entry, ladder, boss, entry\.updatedAt\)\)/u);
  assert.match(boards, /rowFigures\(lead, ladder, boss, teamUpdated\(members\)\)\)/u);
  // the link's words are a bubble over the button, so the row never moves
  assert.match(css, /\.lb-row-icons \.lb-link-label \{ position: absolute; right: 0; bottom: calc\(100% \+ 4px\);/u);
});

test("a team row lists its run's bots in their seats: the Ai mark, plain softer text, never a link, never claimed or you", () => {
  assert.match(boards, /const BOT_TEXT = "A bot the game added to fill the team\.";/u);
  assert.match(boards, /if \(item\.kind === "bot"\) return el\("span", \{ class: "lb-who-name lb-bot", title: BOT_TEXT \}, mark, el\("span", \{ class: "lb-name", text: item\.entry\.name \}\)\);/u);
  assert.match(boards, /const mark = seatMark\(item\.seat, item\.kind === "bot"\);/u);
  assert.match(boards, /el\("span", \{ class: "lb-ai", title: BOT_TEXT, text: "AI" \}\)/u);           // the text in the Ai picture's place
  assert.match(boards, /\.\.\.\(Array\.isArray\(lead\?\.bots\) \? lead\.bots : \[\]\)/u);             // an older answer without bots: as before
  // the Players view's rows have none: one name line each
  assert.match(boards, /el\("span", \{ class: "lb-who" \}, nameLine\(entry\)\),/u);
  assert.match(css, /\.lb-bot \.lb-name \{ color: color-mix\(in srgb, var\(--text\) 62%, transparent\);/u);
  // the legend: the blue badge, the Ai mark, the italic form, the green check
  assert.match(boards, /claimedBadge\(\), " claimed player"\),\s*el\("span", \{\}, seatMark\(null, true\), " a bot"\),\s*el\("span", \{\}, el\("span", \{ class: "lb-legend-also", text: "Name \(1st\)" \}\), " ranked with another run"\),\s*el\("span", \{\}, checkBadge\("verified"\), " verified run"\)/u);
});

test("the boards page is wider on a wide screen and leaves the docked sidebar its margin", () => {
  assert.match(css, /:root \{ --lb-page-width: min\(1560px, 94vw\); \}/u);
  assert.match(css, /@media \(min-width: 1644px\) \{\s*:root \{ --lb-page-width: max\(1180px, min\(1560px, 100vw - 464px\)\); \}\s*body \.site-sidebar\.is-docked \{ --site-margin: calc\(\(100vw - var\(--lb-page-width\)\) \/ 2\); \}/u);
  const page = read("leaderboard/index.html");
  assert.match(page, /leaderboard\.css\?v=0\.3\.16-board-rows/u);
  assert.match(page, /leaderboard\.js\?v=0\.3\.31-board-rows/u);
});
