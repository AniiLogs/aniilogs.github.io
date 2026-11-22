import assert from "node:assert/strict";
import test from "node:test";

import { copiesAgree, copyAgreement, eggCheckLimits, eggMatchChecks, eggStandingChecks, interlinkCheckLimits, interlinkDpsChecks, interlinkVerdict, limitPreview, screenCheckLimits, screenChecks, staffReasons } from "../src/run-checks.js";
import { slotIsBot } from "../src/bots.js";

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

// ---------------------------------------------------------------- Interlink Avg DPS (review only), made-up limits
const LIMITS = { maxPlayerAvgDps: 1000, maxAvgDpsPerCp: 2.5, maxTeamDps: 1500 };
const secret = (value) => interlinkCheckLimits({ INTERLINK_CHECK_LIMITS: JSON.stringify(value) });
const dpsRow = (players, extra = {}) => ({
  players,
  lineup: [{ name: "Alpha", slot: 0, cp: 400 }, { name: "Beta", slot: 1, cp: 500 }, { name: "Flora", slot: 2 }],
  teamDps: players.reduce((total, card) => total + (Number(card.avgDps) || 0), 0),
  meterDps: null,
  ...extra,
});

// the site's one bot rule, as src/index.js passes it
const checks = (row, limits) => interlinkDpsChecks(row, limits, slotIsBot);

test("Interlink limits: from the secret only; any part can be left out; a missing or broken secret checks nothing", () => {
  assert.equal(interlinkCheckLimits({}), null);
  assert.equal(interlinkCheckLimits({ INTERLINK_CHECK_LIMITS: "{oops" }), null);
  assert.equal(interlinkCheckLimits({ INTERLINK_CHECK_LIMITS: "[1]" }), null);
  assert.equal(secret({}), null);
  assert.equal(secret({ maxPlayerAvgDps: -5, maxAvgDpsPerCp: "2", maxTeamDps: 1.5 }), null);
  assert.deepEqual(secret(LIMITS), LIMITS);
  assert.deepEqual(secret({ maxAvgDpsPerCp: 2.5 }), { maxPlayerAvgDps: null, maxAvgDpsPerCp: 2.5, maxTeamDps: null });
  assert.deepEqual(checks(dpsRow([{ name: "Alpha", avgDps: 99999 }]), null), []);
});

test("Interlink Avg DPS: each rule on and off, bots skipped, a card by its position only", () => {
  const players = [{ name: "Alpha", uid: "123456", avgDps: 1200 }, { name: "Beta", avgDps: 900 }, { name: "Flora", avgDps: 5000, ai: true }];
  const flags = checks(dpsRow(players), secret(LIMITS));
  assert.deepEqual(flags, [
    { rule: "player avg dps", card: 1, sent: 1200, limit: 1000 },
    { rule: "player avg dps per cp", card: 1, sent: 3, avgDps: 1200, cp: 400, limit: 2.5 },
    { rule: "team dps", sent: 7100, limit: 1500 },
  ]);
  // never a name or a UID in a flag, nor in its sentence
  const text = JSON.stringify(flags) + staffReasons({ reviewOnly: { flags } }, null).join(" ");
  for (const word of ["Alpha", "Beta", "Flora", "123456"]) assert.equal(text.includes(word), false);
  assert.deepEqual(staffReasons({ reviewOnly: { flags } }, null), [
    "Player 1's Avg DPS is 1,200; the limit for review is 1,000.",
    "Player 1's Avg DPS is 3 per point of CP (1,200 at CP 400); the limit for review is 2.5.",
    "The team's Avg DPS add up to 7,100; the limit for review is 1,500.",
  ]);
  // each rule alone
  assert.deepEqual(checks(dpsRow(players), secret({ maxPlayerAvgDps: 1000 })).map((f) => f.rule), ["player avg dps"]);
  assert.deepEqual(checks(dpsRow(players), secret({ maxAvgDpsPerCp: 2.5 })).map((f) => f.rule), ["player avg dps per cp"]);
  assert.deepEqual(checks(dpsRow(players), secret({ maxTeamDps: 1500 })).map((f) => f.rule), ["team dps"]);
  // at the limit is not above it; the ratio rounds to one decimal in the flag
  assert.deepEqual(checks(dpsRow([{ name: "Alpha", avgDps: 1000 }]), secret(LIMITS)), []);
  assert.deepEqual(checks(dpsRow([{ name: "Beta", avgDps: 1283 }]), secret({ maxAvgDpsPerCp: 2.5 })),
    [{ rule: "player avg dps per cp", card: 1, sent: 2.6, avgDps: 1283, cp: 500, limit: 2.5 }]);
  // a bot (one of the game's bot names, no CP on its Party card) is never flagged as a player, but counts in the team
  assert.deepEqual(checks(dpsRow([{ name: "Beta", avgDps: 10 }, { name: "Flora", avgDps: 5000 }]), secret(LIMITS)),
    [{ rule: "team dps", sent: 5010, limit: 1500 }]);
  // a real player with a bot's name (CP on the Party card) is checked
  assert.deepEqual(checks(dpsRow([{ name: "Flora", avgDps: 1200 }], { lineup: [{ name: "Flora", slot: 0, cp: 4000 }] }), secret(LIMITS)).map((f) => f.card), [1]);
  // without a bot rule passed in, the card's own ai flag decides
  assert.deepEqual(interlinkDpsChecks(dpsRow([{ name: "Gamma", avgDps: 5000, ai: true }]), secret({ maxPlayerAvgDps: 1000 })), []);
  assert.equal(interlinkDpsChecks(dpsRow([{ name: "Flora", avgDps: 5000 }]), secret({ maxPlayerAvgDps: 1000 })).length, 1);
});

test("Interlink Avg DPS per CP: no CP, a name on two Party entries, or no Party entry is skipped", () => {
  const perCp = secret({ maxAvgDpsPerCp: 2.5 });
  const card = [{ name: "Gamma", avgDps: 1200 }];
  assert.deepEqual(checks(dpsRow(card), perCp), []);
  const twice = [{ name: "Gamma", slot: 0, cp: 100 }, { name: "gam ma", slot: 1, cp: 9000 }];
  assert.deepEqual(checks(dpsRow(card, { lineup: twice }), perCp), []);
  assert.deepEqual(checks(dpsRow(card, { lineup: [{ name: "Gamma", slot: 0 }] }), perCp), []);
  assert.deepEqual(checks(dpsRow(card, { lineup: [{ name: "Gamma", slot: 0, cp: 0 }] }), perCp), []);
  // the name is folded (case and spaces)
  assert.equal(checks(dpsRow(card, { lineup: [{ name: "GAM MA", slot: 0, cp: 100 }] }), perCp).length, 1);
});

test("Interlink Avg DPS: cards that don't hang together (a misread) give no flags at all", () => {
  const players = [{ name: "Alpha", avgDps: 12000 }, { name: "Beta", avgDps: 9000 }];
  // ten times the meter's figure: the old readers' dropped decimal point
  assert.deepEqual(checks(dpsRow(players, { meterDps: 2100 }), secret(LIMITS)), []);
  // a third of it the other way
  assert.deepEqual(checks(dpsRow(players, { meterDps: 70000 }), secret(LIMITS)), []);
  // within the factor: checked (team_dps isn't the guard: it is the same sum)
  assert.equal(checks(dpsRow(players, { meterDps: 15000, teamDps: 1 }), secret(LIMITS)).length, 5);
  // a card without a number
  assert.deepEqual(checks(dpsRow([...players, { name: "Gamma", avgDps: null }]), secret(LIMITS)), []);
  assert.deepEqual(checks(dpsRow([...players, { name: "Gamma", avgDps: -1 }]), secret(LIMITS)), []);
  assert.deepEqual(checks(dpsRow([]), secret(LIMITS)), []);
});

test("Interlink limit preview: each run once across its copies, misreads set aside, no names", () => {
  const card = (name, avgDps) => ({ name, avgDps });
  const lineup = [{ name: "Alpha", slot: 0, cp: 400 }, { name: "Beta", slot: 1, cp: 500 }];
  const rows = [
    // one run, sent by both team-mates (the newest copy stands for it)
    { kind: "interlink_run", submissionId: "a1", createdAt: 10, players: [card("Alpha", 1200), card("Beta", 900)], meterDps: 2000, extra: { instanceId: "x1", lineup } },
    { kind: "interlink_run", submissionId: "a2", createdAt: 11, players: [card("Alpha", 1200), card("Beta", 900)], meterDps: 2000, extra: { instanceId: "x1", lineup } },
    // a run of its own (no instance id)
    { kind: "interlink_run", submissionId: "b1", createdAt: 12, players: [card("Alpha", 500)], meterDps: 600, extra: { lineup } },
    // a misread: ten times the meter
    { kind: "interlink_run", submissionId: "c1", createdAt: 13, players: [card("Alpha", 9000)], meterDps: 900, extra: { instanceId: "x2", lineup } },
    { kind: "eggheist_match", score: 1, extra: {} },
  ];
  const preview = limitPreview(rows, { interlink: LIMITS }, slotIsBot).interlink;
  assert.deepEqual(preview.limits, LIMITS);
  assert.deepEqual([preview.copies, preview.runs, preview.runsChecked, preview.skippedAsMisread, preview.runsFlagged], [4, 3, 2, 1, 1]);
  assert.deepEqual(preview.flagged, { "player avg dps": 1, "player avg dps per cp": 1, "team dps": 1 });
  assert.deepEqual(preview.playerAvgDps, { rows: 3, min: 500, p10: 500, p50: 900, p90: 900, p99: 900, max: 1200 });
  assert.deepEqual(preview.avgDpsPerCp, { rows: 3, min: 1.3, p10: 1.3, p50: 1.8, p90: 1.8, p99: 1.8, max: 3 });
  assert.deepEqual(preview.teamDps, { rows: 2, min: 500, p10: 500, p50: 500, p90: 500, p99: 500, max: 2100 });
  assert.equal(/Alpha|Beta/u.test(JSON.stringify(preview)), false);
  // without candidate limits: the distributions, nothing flagged
  const none = limitPreview(rows, {}, slotIsBot).interlink;
  assert.deepEqual([none.limits, none.runsFlagged, none.flagged, none.runs], [null, 0, {}, 3]);
});
