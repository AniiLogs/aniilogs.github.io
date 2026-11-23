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
  assert.deepEqual(levels.jumps, [{ from: 3, to: 7, visit: 1, areas: 1 }]);                // one area start for 4 levels
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
    "Sim levels: jump, N=8, seen 5, backed 0, jumps 3->7@v1, lastBefore 7, visits 1, areas 5, fights 5 (150 s), clear 300 s");
});

// The first full run through the live verification (numbers only): played from level 1 with one save-and-quit; levels 5,
// 6 and 15 never read (5 and 6 lasted 13 s and 6 s), but the game's log wrote an area start for every level.
// Times are seconds from each visit's start.
const V1 = 1795100000;
const V2 = 1795110000;
const firstRun = ({ drop = [] } = {}) => {
  const at = (start) => (s) => start + s;
  const reads2 = [[2, 6], [3, 802], [4, 826], [7, 914], [8, 947], [9, 966], [10, 1029], [11, 1062], [12, 1100], [13, 1115], [14, 1170], [16, 1214]];
  const areas2 = [0, 795, 822, 895, 908, 914, 947, 963, 1028, 1060, 1099, 1112, 1169, 1189, 1211].filter((s) => !drop.includes(s));
  return stages(16,
    { enteredAt: V1, leftAt: V1 + 60, fromStart: true, levels: [{ n: 1, of: 16, t: V1 + 14 }], areas: [0, 12, 57].map(at(V1)).map((t) => ({ t })), fights: [] },
    { enteredAt: V2, leftAt: V2 + 1230, fromStart: false, levels: reads2.map(([n, s]) => ({ n, of: 16, t: V2 + s })),
      areas: areas2.map(at(V2)).map((t) => ({ t })), fights: [] });
};

test("the first full run: 5, 6 and 15 never read but backed by their area starts: verified, no flag", () => {
  const levels = simLevels(firstRun(), 1250);
  assert.equal(levels.verdict, "verified");
  assert.deepEqual([levels.seen, levels.backed, levels.missing, levels.complete, levels.jumps], [[...range(1, 4), ...range(7, 14), 16], [5, 6, 15], [], true, []]);
  assert.deepEqual(levels.stretches, [{ from: 4, to: 7, areas: 3 }, { from: 14, to: 16, areas: 2 }]);
  assert.equal(levels.areas, 18);
  assert.deepEqual(simLevelFlags(levels), []);
  assert.match(simLevelsLogLine(levels), /^Sim levels: verified, N=16, seen 13, backed 3, jumps none,/u);
});

test("the first full run without the area starts of 5 and 6: a jump from 4 to 7", () => {
  const levels = simLevels(firstRun({ drop: [895, 908] }));
  assert.equal(levels.verdict, "jump");
  assert.deepEqual(levels.jumps, [{ from: 4, to: 7, visit: 2, areas: 1 }]);
  assert.deepEqual([levels.backed, levels.missing], [[15], [5, 6]]);
  assert.deepEqual(simLevelFlags(levels), [{ rule: "sim level jump", from: 4, to: 7, visit: 2, of: 16 }]);
});

test("the first full run without the area start of 15: 14 to 16 unbacked, a skip", () => {
  const levels = simLevels(firstRun({ drop: [1189] }));
  assert.equal(levels.verdict, "skip");
  assert.deepEqual(levels.jumps, [{ from: 14, to: 16, visit: 2, areas: 1 }]);
  assert.deepEqual([levels.backed, levels.missing, levels.lastBefore], [[5, 6], [15], 14]);
  assert.deepEqual(simLevelFlags(levels).map((flag) => flag.rule), ["sim levels skipped"]);
});

test("[1] then [16] in a later visit: backed by 15 area starts between, a skip with 2", () => {
  const record = (areaCount) => stages(16,
    { enteredAt: V1, fromStart: true, levels: [{ n: 1, of: 16, t: V1 + 20 }], areas: [{ t: V1 + 5 }, { t: V1 + 15 }], fights: [] },
    { enteredAt: V2, fromStart: false, levels: [{ n: 16, of: 16, t: V2 + 60 * areaCount + 3 }],
      areas: Array.from({ length: areaCount }, (_, i) => ({ t: V2 + 60 * (i + 1) })), fights: [] });
  const backed = simLevels(record(15));
  assert.equal(backed.verdict, "verified");
  assert.deepEqual([backed.backed, backed.missing, backed.stretches], [range(2, 15), [], [{ from: 1, to: 16, areas: 15 }]]);
  assert.deepEqual(simLevelFlags(backed), []);
  const few = simLevels(record(2));
  assert.equal(few.verdict, "skip");
  assert.deepEqual([few.backed, few.missing, few.stretches], [[], range(2, 15), []]);
  assert.deepEqual(simLevelFlags(few).map((flag) => flag.rule), ["sim levels skipped"]);
});

test("only [N]: backed by N area starts up to its read, a skip with fewer", () => {
  const record = (areaCount) => stages(8, { enteredAt: V1, fromStart: true, levels: [{ n: 8, of: 8, t: V1 + 500 }],
    areas: Array.from({ length: areaCount }, (_, i) => ({ t: V1 + 50 * i })), fights: [] });
  assert.equal(simLevels(record(8)).verdict, "verified");
  assert.deepEqual(simLevels(record(8)).stretches, [{ from: 0, to: 8, areas: 8 }]);
  assert.equal(simLevels(record(7)).verdict, "skip");
});

test("area starts: only those after the earlier read and up to 5 s after the later one count; a read without a time backs nothing", () => {
  const record = (areaTimes, t3 = V1 + 100) => stages(8, { enteredAt: V1, fromStart: true,
    levels: [{ n: 1, of: 8, t: V1 + 10 }, { n: 3, of: 8, t: t3 }, ...range(4, 8).map((n) => ({ n, of: 8, t: V1 + 100 + n }))],
    areas: areaTimes.map((s) => ({ t: V1 + s })), fights: [] });
  assert.equal(simLevels(record([60, 105])).verdict, "verified");     // 105 is within 5 s of 3's read
  assert.equal(simLevels(record([60, 106])).verdict, "jump");         // 6 s after: the next level's
  assert.equal(simLevels(record([10, 100])).verdict, "jump");         // 10 is 1's own read: not after it
  assert.equal(simLevels(record([60, 100], null)).verdict, "jump");
});
