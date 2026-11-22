import assert from "node:assert/strict";
import test from "node:test";

import { FIGHT_FIGURES, fightStats, parseFightCsv, pyRound } from "../src/fight-log.js";
import { CLOCK_SPAN_MIN_S, FIGHT_LOG_FIGURES, fightLogChecks, interlinkCheckLimits, limitPreview, staffReasons } from "../src/run-checks.js";

// A synthetic fight (invented numbers): a look every 0.5 s, 1,000 damage a look (broken looks: brokenStep), the game's
// countdown from 300 falling `rate` seconds a real second
function fight(rows, { rate = 1, phase = () => "", brokenStep = 1000 } = {}) {
  const lines = ["wall_s,timer_s,team_damage,note,break_phase"];
  let damage = 0;
  for (let i = 0; i < rows; i += 1) {
    const wall = i * 0.5;
    if (i) damage += phase(i) === "broken" ? brokenStep : 1000;
    lines.push(`${wall},${300 - rate * wall},${damage},,${phase(i)}`);
  }
  return `${lines.join("\r\n")}\r\n`;
}
const twoBreaks = (i) => (i < 40 ? "drain" : i < 60 ? "broken" : i < 120 ? "drain" : i < 140 ? "broken" : "");
const NO_BREAKS = { breaks: 0, breaksPerMin: 0, drainMedianS: null, drainMinS: null, drainSpreadS: null, brokenMedianS: null, brokenSharePct: 0 };

test("the fight CSV parser: quoted fields with commas, quotes and line breaks, CRLF, blank lines, short rows", () => {
  const text = '﻿wall_s,team_damage,note\r\n0.1,100,"a, quoted ""note""\r\nover two lines"\r\n\r\n0.2,200\n0.3,300,plain"quote\r0.4,"400"x,\n';
  assert.deepEqual(parseFightCsv(text), [
    { wall_s: "0.1", team_damage: "100", note: 'a, quoted "note"\r\nover two lines' },
    { wall_s: "0.2", team_damage: "200" },                                           // a short row: no note
    { wall_s: "0.3", team_damage: "300", note: 'plain"quote' },
    { wall_s: "0.4", team_damage: "400x", note: "" },
  ]);
  assert.deepEqual(parseFightCsv(""), []);
  assert.deepEqual(parseFightCsv("wall_s,team_damage\n"), []);
  // an older file: only the two required columns
  const old = ["wall_s,team_damage", ...Array.from({ length: 30 }, (_, i) => `${i},${i * 10}`)].join("\n");
  const stats = fightStats(parseFightCsv(old));
  assert.equal(stats.rows, 30);
  assert.equal(stats.clockRate, null);
  assert.equal(stats.clockSpanS, 0);
  assert.equal(stats.breaks, 0);
});

test("Python's rounding: half to even, on the number's exact value", () => {
  assert.deepEqual([pyRound(0.5), pyRound(1.5), pyRound(2.5), pyRound(-2.5), pyRound(2.4999)], [0, 2, 2, -2, 2]);
  assert.deepEqual([pyRound(0.125, 2), pyRound(0.375, 2), pyRound(2.675, 2), pyRound(1.25, 1), pyRound(1.35, 1)], [0.12, 0.38, 2.67, 1.2, 1.4]);
});

test("fight figures: a steady fight, one with two breaks, one whose game clock runs 1.5 times real time", () => {
  assert.deepEqual(Object.keys(fightStats(parseFightCsv(fight(200)))), FIGHT_FIGURES);
  assert.deepEqual([...FIGHT_FIGURES].sort(), [...FIGHT_LOG_FIGURES].sort());          // the checks know every figure
  // the same numbers as the reference implementation (worked out by hand: 199 rises of 1,000 over 99.5 s)
  assert.deepEqual(fightStats(parseFightCsv(fight(200))), { rows: 200, wallS: 99.5, damage: 199000, dps: 2000, hits: 199, hitsPerS: 2,
    hitMedian: 1000, hitP90: 1000, hitMax: 1000, secondsWithDamagePct: 101, clockRate: 1, clockSpanS: 99.5, clockRateP10: 1, clockRateP90: 1,
    ...NO_BREAKS, dpsUnbroken: 2000 });
  // drains of 19.5 s and 29.5 s, then 9.5 s broken twice at 3,000 a look
  assert.deepEqual(fightStats(parseFightCsv(fight(200, { phase: twoBreaks, brokenStep: 3000 }))), { rows: 200, wallS: 99.5, damage: 279000, dps: 2804,
    hits: 199, hitsPerS: 2, hitMedian: 1000, hitP90: 3000, hitMax: 3000, secondsWithDamagePct: 101, clockRate: 1, clockSpanS: 99.5, clockRateP10: 1,
    clockRateP90: 1, breaks: 2, breaksPerMin: 1.21, drainMedianS: 19.5, drainMinS: 19.5, drainSpreadS: 10, brokenMedianS: 9.5, brokenSharePct: 19.1,
    dpsUnbroken: 2050 });
  const fast = fightStats(parseFightCsv(fight(200, { rate: 1.5 })));
  assert.deepEqual([fast.clockRate, fast.clockRateP10, fast.clockRateP90, fast.clockSpanS], [1.5, 1.5, 1.5, 99.5]);
  // nothing for fewer than 20 usable rows (rows before the start and rows without the two numbers don't count)
  assert.equal(fightStats(parseFightCsv(fight(19))), null);
  assert.equal(fightStats(parseFightCsv(`${fight(19)}-1,5,1\r\nx,,\r\n`)), null);
  assert.notEqual(fightStats(parseFightCsv(fight(20))), null);
  assert.equal(fightStats(parseFightCsv(["wall_s,team_damage", ...Array.from({ length: 25 }, () => "3,10")].join("\n"))), null);   // no length
});

test("fight-log flags: a figure outside INTERLINK_CHECK_LIMITS' fight range, the clock only over 60 s or more", () => {
  const limits = interlinkCheckLimits({ INTERLINK_CHECK_LIMITS: JSON.stringify({ fight: {
    clockRate: { max: 1.1 }, hitMedian: { min: 10, max: 300000 }, drainMinS: { min: 5 }, nope: { max: 1 }, dps: {}, hits: { max: "9" } } }) });
  assert.deepEqual(limits.fight, { clockRate: { max: 1.1 }, hitMedian: { min: 10, max: 300000 }, drainMinS: { min: 5 } });
  assert.equal(limits.maxPlayerAvgDps, null);                                         // the fight part alone turns the checks on
  const fast = fightStats(parseFightCsv(fight(200, { rate: 1.5 })));
  assert.deepEqual(fightLogChecks(fast, limits), [{ rule: "fight log", figure: "clockRate", sent: 1.5, max: 1.1 }]);
  // the clock read over less than CLOCK_SPAN_MIN_S says nothing
  const short = fightStats(parseFightCsv(fight(100, { rate: 1.5 })));
  assert.ok(short.clockSpanS < CLOCK_SPAN_MIN_S);
  assert.deepEqual(fightLogChecks(short, limits), []);
  // a null figure (no drains) is never flagged; below a min is
  assert.equal(fast.drainMinS, null);
  assert.deepEqual(fightLogChecks({ ...fast, clockRate: 1, hitMedian: 512000 }, limits), [{ rule: "fight log", figure: "hitMedian", sent: 512000, min: 10, max: 300000 }]);
  assert.deepEqual(fightLogChecks({ ...fast, clockRate: 1, hitMedian: 5 }, limits).map((flag) => flag.sent), [5]);
  assert.deepEqual(fightLogChecks(fast, null), []);
  assert.deepEqual(fightLogChecks(null, limits), []);
  assert.deepEqual(fightLogChecks(fast, interlinkCheckLimits({ INTERLINK_CHECK_LIMITS: JSON.stringify({ maxTeamDps: 5 }) })), []);
  // staff sentences
  const reasons = staffReasons({ reviewOnly: { flags: [
    { rule: "fight log", figure: "clockRate", sent: 1.42, max: 1.1 },
    { rule: "fight log", figure: "hitMedian", sent: 512000, min: 10, max: 300000 },
    { rule: "fight log", figure: "drainMinS", sent: 2.5, min: 5 },
    { rule: "fight log", figure: "somethingNew", sent: 7, max: 3 },
  ] } }, null);
  assert.deepEqual(reasons, [
    "The fight log's clock ran at 1.42 times real time; the limit for review is at most 1.1.",
    "The fight log's median hit is 512,000; the limit for review is at most 300,000.",
    "The fight log's shortest drain before a break is 2.5 s; the limit for review is at least 5.",
    "The fight log's somethingNew is 7; the limit for review is at most 3.",
  ]);
});

test("the limits preview's fight part: runs with figures (each run once), spreads and what candidate limits would flag", () => {
  const steady = fightStats(parseFightCsv(fight(200)));
  const fast = fightStats(parseFightCsv(fight(200, { rate: 1.5 })));
  const row = (submissionId, extra, createdAt = 1) => ({ kind: "interlink_run", submissionId, createdAt, players: [], extra });
  const rows = [row("a", { fightStats: steady }), row("b", { fightStats: fast, instanceId: "x" }, 1), row("b2", { fightStats: fast, instanceId: "x" }, 2),
    row("c", {})];
  const preview = limitPreview(rows, { interlink: { fight: { clockRate: { max: 1.1 } } } }).interlink.fight;
  assert.equal(preview.runs, 2);
  assert.deepEqual(preview.figures.clockRate, { rows: 2, min: 1, p10: 1, p50: 1, p90: 1, p99: 1, max: 1.5 });
  assert.deepEqual(preview.flagged, { clockRate: 1 });
  assert.equal(preview.runsFlagged, 1);
  assert.deepEqual(limitPreview(rows, {}).interlink.fight.flagged, {});
});
