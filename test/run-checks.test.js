import assert from "node:assert/strict";
import test from "node:test";

import { copiesAgree, copyAgreement, eggCheckLimits, eggMatchChecks, eggStandingChecks, interlinkVerdict, screenCheckLimits, screenChecks, staffReasons } from "../src/run-checks.js";

// made-up rows and limits only
const copy = (id, sender, score, stars = 20, extra = {}) => ({ id, sender, score, stars, clearTimeS: 180, players: [], ...extra });

test("copies: two senders agreeing verify; three copies keep what most agree on; two answers are for the reading", () => {
  const a = copy("a", "p1", 20000);
  const b = copy("b", "p2", 20000);
  const c = copy("c", "p3", 2000);
  assert.deepEqual(copyAgreement(a, [a, b]), { senders: 2, agreeing: 2, verified: true, oddOneOut: false, contradicted: false });
  // the odd one out is a misread, not a staff matter
  assert.equal(copyAgreement(a, [a, b, c]).verified, true);
  assert.deepEqual(copyAgreement(c, [a, b, c]), { senders: 3, agreeing: 1, verified: false, oddOneOut: true, contradicted: false });
  // two copies, two answers
  assert.deepEqual(copyAgreement(a, [a, c]), { senders: 2, agreeing: 1, verified: false, oddOneOut: false, contradicted: true });
  // two pairs that disagree: nobody wins
  const d = copy("d", "p4", 2000);
  assert.equal(copyAgreement(a, [a, b, c, d]).verified, false);
  // one sender's two copies are one copy
  assert.equal(copyAgreement(a, [a, copy("a2", "p1", 20000)]).verified, false);
  // time within a second; Battle Data cards equal for the players both list
  assert.equal(copiesAgree(a, { ...b, clearTimeS: 181 }), true);
  assert.equal(copiesAgree(a, { ...b, clearTimeS: 183 }), false);
  const card = { name: "Someone", avgDps: 100, breakValue: 1, damageTaken: 2, heal: 3 };
  assert.equal(copiesAgree({ ...a, players: [card] }, { ...b, players: [{ ...card, name: "some one" }] }), true);
  assert.equal(copiesAgree({ ...a, players: [card] }, { ...b, players: [{ ...card, avgDps: 101 }] }), false);
  assert.equal(copiesAgree({ ...a, players: [card] }, { ...b, players: [{ ...card, name: "Other", avgDps: 5 }] }), true);
  assert.equal(copiesAgree({ ...a, score: null }, { ...b, score: null }), false);
});

test("verdict: impossible values go to staff; misreads get nothing; a reading counts only when plausible and showing less", () => {
  const lone = { senders: 1, agreeing: 1, verified: false, oddOneOut: false, contradicted: false };
  // made-up numbers: what was sent, what the picture read, the run's star cap
  const reading = (sent, read, cap = 40) => {
    const differences = ["score", "stars"].filter((field) => read[field] != null && read[field] !== sent[field]).map((field) => ({ field, sent: sent[field], read: read[field] }));
    return { agreement: lone, reading: { checked: 3, differences }, read, sent, cap };
  };
  assert.equal(interlinkVerdict({ flags: [{ rule: "stars above the cap" }] }).state, "mismatch");
  assert.deepEqual(interlinkVerdict({ misread: [{ rule: "stars track score" }], ...reading({ score: 9000, stars: 9 }, { score: 4000, stars: 4 }) }), { state: null });
  assert.deepEqual(interlinkVerdict(reading({ score: 20000, stars: 20 }, { score: 20000, stars: 20 })), { state: "match", verifiedBy: "reading" });
  // the five shapes the reader produced by itself: no badge, no staff, and the reason recorded
  const harmless = [
    [{ score: 17391, stars: 17 }, { score: 71, stars: 0 }, "reading not plausible: fewer digits"],
    [{ score: 13258, stars: 13 }, { score: 0, stars: 13 }, "reading not plausible: fewer digits"],
    [{ score: 11347, stars: 11 }, { score: 615, stars: 3 }, "reading not plausible: fewer digits"],
    [{ score: 6301, stars: 6 }, { score: 89, stars: 6 }, "reading not plausible: fewer digits"],
    [{ score: 8215, stars: 8 }, { score: 8275, stars: 8 }, "sent lower than the picture"],
  ];
  for (const [sent, read, note] of harmless) assert.deepEqual(interlinkVerdict(reading(sent, read)), { state: null, note }, JSON.stringify(sent));
  // a reading whose own score and stars don't fit each other, or that read nothing for one of them
  assert.deepEqual(interlinkVerdict(reading({ score: 30000, stars: 30 }, { score: 21000, stars: 5 })), { state: null, note: "reading not plausible: its score and stars don't fit" });
  assert.deepEqual(interlinkVerdict(reading({ score: 30000, stars: 30 }, { score: 21000, stars: null })), { state: null, note: "reading not plausible: score or stars not read" });
  // a real mismatch: sent 99,000 with 40 stars, the picture 34,333 with 20 (on a boss whose cap is 20 those fit)
  const cheat = interlinkVerdict(reading({ score: 99000, stars: 40 }, { score: 34333, stars: 20 }, 20));
  assert.equal(cheat.state, "mismatch");
  assert.deepEqual(cheat.staff, [{ why: "picture shows less", differences: [{ field: "score", sent: 99000, read: 34333 }, { field: "stars", sent: 40, read: 20 }], shown: { score: 34333, stars: 20 } }]);
  // read once: a differing picture is never read a second time
  assert.equal(interlinkVerdict({ ...reading({ score: 99000, stars: 40 }, { score: 34333, stars: 20 }, 20), readable: true }).needs, undefined);
  assert.deepEqual(interlinkVerdict({ agreement: lone, reading: { checked: 0, differences: [] } }), { state: "unreadable" });
  assert.deepEqual(interlinkVerdict({ agreement: lone, reading: { checked: 3, differences: [{ field: "x Avg DPS", sent: 1, read: 2 }] }, read: { score: 1, stars: 0 }, sent: { score: 1, stars: 0 }, cap: 20 }), { state: null });
  assert.deepEqual(interlinkVerdict({ agreement: lone, wanted: true, readable: true }), { state: null, needs: "reading" });
  assert.deepEqual(interlinkVerdict({ agreement: lone, wanted: false, readable: true }), { state: null });
  // copies that contradict: the same test on the copy's own reading
  const contradicted = { ...lone, senders: 2, contradicted: true };
  assert.deepEqual(interlinkVerdict({ agreement: contradicted, readable: true }), { state: null, needs: "reading" });
  assert.equal(interlinkVerdict({ ...reading({ score: 21000, stars: 21 }, { score: 20000, stars: 20 }), agreement: contradicted }).state, "mismatch");
  assert.deepEqual(interlinkVerdict({ ...reading({ score: 19000, stars: 19 }, { score: 20000, stars: 20 }), agreement: contradicted }), { state: null, note: "sent lower than the picture" });
  assert.deepEqual(interlinkVerdict({ ...reading({ score: 19381, stars: 19 }, { score: 81, stars: 0 }), agreement: contradicted }), { state: null, note: "reading not plausible: fewer digits" });
  assert.deepEqual(interlinkVerdict({ ...reading({ score: 20000, stars: 20 }, { score: 20000, stars: 20 }), agreement: contradicted }), { state: "match", verifiedBy: "reading" });
  // the staff list's words: the picture against what was sent
  assert.deepEqual(staffReasons({ staff: cheat.staff }, "mismatch"), ["Its picture shows less than was sent: the picture shows score 34,333 and 20 stars; sent: score 99,000 and 40 stars."]);
});

test("Egg Heist and screen limits: only from their secrets, any part may be left out, nothing without them", () => {
  assert.equal(eggCheckLimits({}), null);
  assert.equal(eggCheckLimits({ EGG_CHECK_LIMITS: "{oops" }), null);
  assert.equal(eggCheckLimits({ EGG_CHECK_LIMITS: "{}" }), null);
  const limits = eggCheckLimits({ EGG_CHECK_LIMITS: JSON.stringify({ maxLoot: { Easy: 10, Hard: 30 }, minTimeS: { Easy: 50, Hard: 70 }, maxDefeats: 9 }) });
  const match = (over) => ({ score: 5, clearTimeS: 100, cleared: 1, difficulty: "Easy", defeats: 1, ...over });
  assert.deepEqual(eggMatchChecks(match(), limits), []);
  assert.deepEqual(eggMatchChecks(match({ score: 11 }), limits).map((f) => f.rule), ["egg loot"]);
  // an unknown difficulty takes the most lenient numbers
  assert.deepEqual(eggMatchChecks(match({ score: 29, difficulty: "New", clearTimeS: 55 }), limits), []);
  // a lost match isn't judged by the time floor
  assert.deepEqual(eggMatchChecks(match({ clearTimeS: 10, cleared: 0 }), limits), []);
  assert.deepEqual(eggMatchChecks(match({ defeats: 2.5 }), limits).map((f) => f.rule), ["egg defeats"]);
  const points = eggCheckLimits({ EGG_CHECK_LIMITS: JSON.stringify({ maxPointsPerMatch: 10, minMatchS: 100 }) });
  assert.deepEqual(eggStandingChecks({ score: 125, at: 1000 }, { score: 100, at: 990 }, 0, points).map((f) => f.rule), ["egg points"]);
  assert.deepEqual(eggStandingChecks({ score: 125, at: 1000 }, { score: 100, at: 990 }, 3, points), []);          // three matches sent
  assert.deepEqual(eggStandingChecks({ score: 125, at: 1300 }, { score: 100, at: 990 }, 0, points), []);         // time for four
  assert.equal(screenCheckLimits({ SCREEN_CHECK_LIMITS: "[]" }), null);
  const screen = screenCheckLimits({ SCREEN_CHECK_LIMITS: JSON.stringify({ maxOver40: 5, copyFailed: true }) });
  assert.deepEqual(screenChecks({ screenCheck: { result: { source: "window" } } }, screen), []);
  assert.deepEqual(screenChecks({ screenCheck: { result: { source: "screen", copy: "ok", over40: 5 } } }, screen), []);
  assert.deepEqual(screenChecks({ screenCheck: { result: { source: "screen", copy: "ok", over40: 6 }, battleData: { source: "screen", copy: "failed" } } }, screen)
    .map((f) => [f.rule, f.screen]), [["screen differs", "result"], ["screen copy failed", "battleData"]]);
});

test("staff read every reason as a sentence", () => {
  const reasons = staffReasons({ staff: [{ why: "impossible", rule: "stars above the cap", sent: 26, expected: 20 }],
    reviewOnly: { flags: [{ rule: "egg loot", sent: 90000, limit: 50000 }] } }, "mismatch");
  assert.deepEqual(reasons, ["26 stars sent; this boss gives at most 20.", "90,000 loot; a match at this difficulty gives at most 50,000."]);
  // a decided review-only flag is no longer a reason
  assert.deepEqual(staffReasons({ reviewOnly: { flags: [{ rule: "egg loot" }], decision: { decision: "confirmed" } } }, null), []);
  // checks stored before 21 Nov
  assert.match(staffReasons({ rules: { flags: [{ rule: "Avg DPS add up to the meter's DPS", sent: 1, expected: 2 }] } }, "mismatch")[0], /note only/u);
});
