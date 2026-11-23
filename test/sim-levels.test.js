import assert from "node:assert/strict";
import test from "node:test";

import { MAX_AREAS, MAX_FIGHTS, MAX_LEVELS, MAX_VISITS, sanitizeStages, simLevelFlags, simLevels, simLevelsLogLine } from "../src/sim-levels.js";

// made-up records: a visit with the given counter values, one area and one 30 s fight per level
let clock = 1795000000;
function visit(ns, of, { fromStart = true } = {}) {
  const enteredAt = clock;
  const levels = ns.map((n) => ({ n, of, t: (clock += 40) }));
  return { enteredAt, leftAt: (clock += 10), fromStart, levels,
    areas: levels.map((level) => ({ t: level.t - 1 })),
    fights: levels.map((level) => ({ t: level.t + 30, s: 30, damage: 100000, id: "90001", defeated: true, breaks: 1 })),
    reads: { made: 50, counter: 48 } };
}
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const stages = (of, ...visits) => ({ of, visits });

test("1..8 of 8 in one visit, watched from the start: verified", () => {
  const levels = simLevels(stages(8, visit(range(1, 8), 8)), 512);
  assert.equal(levels.verdict, "verified");
  assert.deepEqual([levels.of, levels.seen, levels.missing, levels.complete, levels.inOrder, levels.jumps], [8, range(1, 8), [], true, true, []]);
  assert.deepEqual([levels.watchedFromStart, levels.lastBefore, levels.visits, levels.areas, levels.fights, levels.fightsSeen, levels.fightSeconds, levels.clearTimeS],
    [true, 7, 1, 8, 8, 8, 240, 512]);
  assert.deepEqual(simLevelFlags(levels), []);
});

test("1..16 across three visits: verified", () => {
  const levels = simLevels(stages(16, visit(range(1, 5), 16), visit(range(6, 11), 16), visit(range(12, 16), 16)));
  assert.equal(levels.verdict, "verified");
  assert.equal(levels.visits, 3);
  assert.equal(levels.clearTimeS, null);
});

test("a record that starts at 9/16: incomplete, levels 1..8 missing, not a skip", () => {
  const levels = simLevels(stages(16, visit(range(9, 16), 16, { fromStart: false })));
  assert.equal(levels.verdict, "incomplete");
  assert.deepEqual(levels.missing, range(1, 8));
  assert.equal(levels.watchedFromStart, false);
  assert.deepEqual(simLevelFlags(levels), []);
});

test("1, 2, 3, 7, 8 of 8 in one visit: a jump from 3 to 7", () => {
  const levels = simLevels(stages(8, visit([1, 2, 3, 7, 8], 8)));
  assert.equal(levels.verdict, "jump");
  assert.deepEqual(levels.jumps, [{ from: 3, to: 7, visit: 1 }]);
  assert.deepEqual(levels.missing, [4, 5, 6]);
  assert.deepEqual(simLevelFlags(levels), [{ rule: "sim level jump", from: 3, to: 7, visit: 1, of: 8 }]);
});

test("1..4 in visit one, 6..8 in visit two: incomplete, no jump across the boundary", () => {
  const levels = simLevels(stages(8, visit(range(1, 4), 8), visit(range(6, 8), 8)));
  assert.equal(levels.verdict, "incomplete");
  assert.deepEqual(levels.jumps, []);
  assert.deepEqual(levels.missing, [5]);
});

test("the counter going down: not in order, so not verified", () => {
  const levels = simLevels(stages(8, visit([1, 2, 3, 4, 3, 4, 5, 6, 7, 8], 8)));
  assert.equal(levels.inOrder, false);
  assert.equal(levels.complete, true);
  assert.equal(levels.verdict, "incomplete");
});

test("skips: only N, only 1 and N, or a rise straight to N inside one visit", () => {
  const only16 = simLevels(stages(16, visit([16], 16)), 95);
  assert.equal(only16.verdict, "skip");
  assert.equal(only16.lastBefore, null);
  assert.deepEqual(simLevelFlags(only16), [{ rule: "sim levels skipped", of: 16, seen: [16], lastBefore: null, fightsSeen: 1, fightSeconds: 30, clearTimeS: 95 }]);
  const oneVisit = simLevels(stages(16, visit([1, 16], 16)));
  assert.equal(oneVisit.verdict, "skip");
  assert.equal(oneVisit.lastBefore, 1);
  // 1 in visit one and 16 in visit two: the same shape, also a skip
  const twoVisits = simLevels(stages(16, visit([1], 16), visit([16], 16)));
  assert.equal(twoVisits.verdict, "skip");
  assert.deepEqual(twoVisits.jumps, []);
  const straight = simLevels(stages(16, visit([1, 2, 3, 16], 16)));
  assert.equal(straight.verdict, "skip");
  assert.equal(straight.lastBefore, 3);
  assert.deepEqual(simLevelFlags(straight).map((flag) => flag.rule), ["sim levels skipped"]);
  // 1..8, then 16 in a later visit: levels missing across a boundary, not a skip
  const later = simLevels(stages(16, visit(range(1, 8), 16), visit([16], 16)));
  assert.equal(later.verdict, "incomplete");
  assert.equal(later.lastBefore, 8);
  // 9..16: a record that starts mid-run
  assert.equal(simLevels(stages(16, visit(range(9, 16), 16))).verdict, "incomplete");
  // [1, 2] of 2 is a whole run
  assert.equal(simLevels(stages(2, visit([1, 2], 2))).verdict, "verified");
});

test("no stages, or none usable: none", () => {
  for (const value of [undefined, null, "x", [], {}, { visits: [] }, { of: 16, visits: [{ levels: [] }] }, { of: 1, visits: [visit([1], 1)] }]) {
    const levels = simLevels(value);
    assert.equal(levels.verdict, "none", JSON.stringify(value));
    assert.deepEqual(simLevelFlags(levels), []);
  }
  // of comes from the levels when stages.of is missing
  assert.equal(simLevels({ visits: [visit(range(1, 8), 8)] }).verdict, "verified");
});

test("malformed and oversize records are bounded and never throw", () => {
  const huge = {
    of: 16, extra: "dropped", visits: [
      ...Array.from({ length: 20 }, () => ({ enteredAt: "soon", fromStart: "yes", levels: "x", areas: [1, null, { t: -5 }], fights: [{ s: "long", id: "<script>" }] })),
      { enteredAt: 1, fromStart: true, name: "dropped",
        levels: Array.from({ length: 100 }, (_, i) => ({ n: (i % 16) + 1, of: 16, t: i, note: "dropped" })),
        areas: Array.from({ length: 200 }, (_, i) => ({ t: i })),
        fights: Array.from({ length: 200 }, (_, i) => ({ t: i, s: 1.25, damage: 1e20, id: 5, defeated: 1, breaks: 2 })),
        reads: { made: 3, counter: "2" } },
      null, 7,
    ],
  };
  let kept;
  assert.doesNotThrow(() => { kept = sanitizeStages(huge); });
  assert.equal(kept.cut, true);
  assert.ok(kept.visits.length <= MAX_VISITS);
  assert.equal(kept.extra, undefined);
  for (const item of kept.visits) {
    assert.ok(item.levels.length <= MAX_LEVELS && item.areas.length <= MAX_AREAS && item.fights.length <= MAX_FIGHTS);
    assert.equal(item.name, undefined);
    for (const level of item.levels) assert.deepEqual(Object.keys(level).sort(), ["n", "of", "t"]);
    for (const fight of item.fights) {
      assert.equal(fight.id === undefined || /^[A-Za-z0-9_-]+$/u.test(fight.id), true);
      assert.equal(fight.damage, undefined);                     // out of range: dropped
      assert.equal(fight.defeated, undefined);                   // not a true/false
    }
  }
  const big = kept.visits.find((item) => item.levels.length);
  assert.deepEqual(big.reads, { made: 3 });
  assert.equal(big.fights[0].id, "5");
  assert.equal(big.fights[0].s, 1.3);
  assert.doesNotThrow(() => simLevels(huge));
  assert.ok(simLevels(huge).fightsSeen <= MAX_VISITS * MAX_FIGHTS);
  assert.match(simLevelsLogLine(simLevels(huge)), /^Sim levels: \w+, N=16, seen \d+/u);
  assert.equal(sanitizeStages({ visits: [null] }), null);
});

test("the log line: verdict, N, seen, jumps", () => {
  assert.equal(simLevelsLogLine(simLevels(stages(8, visit([1, 2, 3, 7, 8], 8)), 300)),
    "Sim levels: jump, N=8, seen 5, jumps 3->7@v1, lastBefore 7, visits 1, areas 5, fights 5 (150 s), clear 300 s");
});
