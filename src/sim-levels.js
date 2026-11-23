// game-audit: n/a reads aLogs' own record of a Holo-Battle Sim run's level counter, not game files
//
// The level record of a Holo-Battle Sim win (extra.stages, aLogs 0.1.37 B34 on) and the verification made from it.
//
// sanitizeStages(raw) keeps a bounded copy: at most MAX_VISITS visits (the newest), and per visit MAX_LEVELS levels,
// MAX_AREAS areas and MAX_FIGHTS fights; numbers and the record's own true/false fields only (a fight's boss id is kept
// when it is a short id); anything else is dropped, and `cut: true` says something was left out. null when nothing
// usable is left.
//
// simLevels(stages, clearTimeS) -> the verification:
//   { of, seen, backed, missing, complete, inOrder, jumps: [{from, to, visit, areas}], stretches: [{from, to, areas}],
//     lastBefore, watchedFromStart, areas, fights, fightsSeen, fightSeconds, visits, clearTimeS, cut, verdict }
// N (`of`) is stages.of, else the most common `of` among the levels. A level counts when 1 <= n <= N (and its own
// `of`, if sent, is N). `lastBefore` is the level seen just before N was first seen (null: N came first or never).
//
// The area starts are the second proof. The app reads the counter only between fights (about once a second, two reads
// in a row), so a short level, or one that is all fight, is never read; the game's log writes an area start for every
// level all the same. A rise of the counter from a (read at ta) to b (read at tb), in one visit or across visits, is
// BACKED when the record has at least b - a area starts with ta < t <= tb + AREA_SLACK_S (in a's visit after ta, every
// area of the visits between, in b's visit up to tb + slack). The levels a+1..b-1 of a backed rise that weren't read
// are `backed`; `stretches` lists every backed rise with its area count. The levels before the first read (1..f-1, f
// read at tf) are backed the same way, as a rise from level 0 at the record's start: at least f area starts up to
// tf + slack (stretch {from: 0}). `missing` = levels neither read nor backed; `complete` = none missing. A rise with
// fewer area starts than levels is unbacked; inside one visit it is a jump (with its area count in `jumps`).
// The verdict, checked in this order:
//   1. "none"       no usable record (an older app build, no levels, or N below 2).
//   2. "skip"       the skip cheat: N was reached and either an unbacked rise inside one visit ended at N (1, 2, 3
//                   then 16 with one area start), or the whole record read only [N] or only [1, N] (N >= 3; one visit
//                   or two) and the area starts don't cover the levels claimed: [N] needs N area starts up to N's
//                   read, [1, N] needs N-1 after 1's read; with that many the shape is backed and not a skip.
//   3. "jump"       inside one visit an unbacked rise of more than 1 to a level below N (3 then 7, one area start).
//   4. "verified"   every level 1..N read or backed, the counter never went down, no unbacked rise inside a visit.
//   5. "incomplete" anything else: levels missing across visit boundaries that the area starts don't back (played
//                   while the app wasn't watching), a record that starts mid-run (9..16), or a counter that went
//                   down. Not a cheat signal by itself.
// An unbacked rise across a visit boundary never makes "jump" or "skip", except the whole-record [N] / [1, N] shapes.
// A visit's first area start can be the level it resumes into, already counted before the quit; so a rise across a
// boundary can count one area too many a boundary.
//
// simLevelFlags(levels) -> the review-only flags for staff ("sim levels skipped", "sim level jump"); none otherwise.
// Nothing here holds or hides a run.

export const MAX_VISITS = 12;
export const MAX_LEVELS = 40;
export const MAX_AREAS = 80;
export const MAX_FIGHTS = 80;
const MAX_OF = 200;
const MAX_JUMP_FLAGS = 5;
// a level's area start comes before its counter is read (0 to 7 s in the first full run); the slack lets a log line
// stamped a little late still count, and stays well under the shortest gap seen from a read to the next level's area
// start (12 s)
export const AREA_SLACK_S = 5;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const time = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e11 ? Math.round(value * 10) / 10 : undefined);
const whole = (value, max) => (Number.isInteger(value) && value >= 0 && value <= max ? value : undefined);
const seconds = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e6 ? Math.round(value * 10) / 10 : undefined);
const flag = (value) => (typeof value === "boolean" ? value : undefined);
const bossId = (value) => (typeof value === "string" && /^[A-Za-z0-9_-]{1,24}$/u.test(value) ? value
  : Number.isInteger(value) && value >= 0 && value < 1e15 ? String(value) : undefined);
// an object with only the fields that came through
const kept = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

export function sanitizeStages(raw) {
  if (!isObject(raw)) return null;
  let cut = raw.cut === true;
  const list = (value, max) => {
    if (!Array.isArray(value)) return [];
    if (value.length > max) cut = true;
    return value.slice(0, max);
  };
  let visitsSent = Array.isArray(raw.visits) ? raw.visits : [];
  if (visitsSent.length > MAX_VISITS) {
    visitsSent = visitsSent.slice(-MAX_VISITS);     // the newest, as the app keeps them
    cut = true;
  }
  const visits = [];
  for (const visit of visitsSent) {
    if (!isObject(visit)) { cut = true; continue; }
    const levels = list(visit.levels, MAX_LEVELS).filter(isObject)
      .map((level) => kept({ n: whole(level.n, MAX_OF), of: whole(level.of, MAX_OF), t: time(level.t) }))
      .filter((level) => level.n !== undefined);
    const areas = list(visit.areas, MAX_AREAS).filter(isObject).map((area) => kept({ t: time(area.t) }));
    const fights = list(visit.fights, MAX_FIGHTS).filter(isObject).map((fight) => kept({
      t: time(fight.t), s: seconds(fight.s), damage: whole(fight.damage, 1e15), id: bossId(fight.id),
      defeated: flag(fight.defeated), breaks: whole(fight.breaks, 1e6),
    }));
    const reads = isObject(visit.reads) ? kept({ made: whole(visit.reads.made, 1e9), counter: whole(visit.reads.counter, 1e9) }) : {};
    visits.push(kept({
      enteredAt: time(visit.enteredAt), leftAt: time(visit.leftAt), fromStart: flag(visit.fromStart),
      levels, areas, fights, ...(Object.keys(reads).length ? { reads } : {}),
    }));
  }
  const of = whole(raw.of, MAX_OF);
  if (!visits.length && of === undefined) return null;
  return kept({ of, cut: cut || undefined, visits });
}

function mostCommonOf(levels) {
  const counts = new Map();
  for (const level of levels) if (Number.isInteger(level?.of)) counts.set(level.of, (counts.get(level.of) || 0) + 1);
  let best = null;
  for (const [of, count] of counts) if (best === null || count > counts.get(best) || (count === counts.get(best) && of > best)) best = of;
  return best;
}

export function simLevels(rawStages, clearTimeS = null) {
  const stages = sanitizeStages(rawStages);
  const clear = typeof clearTimeS === "number" && Number.isFinite(clearTimeS) ? clearTimeS
    : clearTimeS != null && Number.isFinite(Number(clearTimeS)) ? Number(clearTimeS) : null;
  const visits = stages?.visits || [];
  const allLevels = visits.flatMap((visit) => visit.levels);
  const of = Number.isInteger(stages?.of) ? stages.of : mostCommonOf(allLevels);
  const fightList = visits.flatMap((visit) => visit.fights);
  const totals = {
    areas: visits.reduce((sum, visit) => sum + visit.areas.length, 0),
    fights: fightList.length,
    fightsSeen: fightList.length,
    fightSeconds: Math.round(fightList.reduce((sum, fight) => sum + (fight.s || 0), 0) * 10) / 10,
    visits: visits.length,
    clearTimeS: clear,
    cut: Boolean(stages?.cut),
  };
  const usable = (level) => level.n >= 1 && level.n <= of && (level.of === undefined || level.of === of);
  // the counter's changes in order, each with its visit (1-based)
  const sequence = Number.isInteger(of) && of >= 2
    ? visits.flatMap((visit, index) => visit.levels.filter(usable).map((level) => ({ n: level.n, t: level.t, visit: index + 1 })))
    : [];
  if (!sequence.length) {
    return { of: Number.isInteger(of) ? of : null, seen: [], backed: [], missing: [], complete: false, inOrder: true, jumps: [], stretches: [],
      lastBefore: null, watchedFromStart: false, ...totals, verdict: "none" };
  }
  const seen = [...new Set(sequence.map((item) => item.n))].sort((a, b) => a - b);
  const backedSet = new Set();
  const stretches = [];
  // a rise from `from` (null: level 0 at the record's start) to `to` with at least as many area starts as levels
  const back = (from, to) => {
    const areas = areasBetween(visits, from, to);
    const fromN = from ? from.n : 0;
    if (areas < to.n - fromN) return { backed: false, areas };
    for (let n = fromN + 1; n < to.n; n += 1) backedSet.add(n);
    stretches.push({ from: fromN, to: to.n, areas });
    return { backed: true, areas };
  };
  if (sequence[0].n > 1) back(null, sequence[0]);
  let inOrder = true;
  const jumps = [];
  let skippedInVisit = false;
  for (let i = 1; i < sequence.length; i += 1) {
    const from = sequence[i - 1];
    const to = sequence[i];
    if (to.n < from.n) inOrder = false;
    if (to.n - from.n <= 1) continue;
    const { backed, areas } = back(from, to);
    if (backed || from.visit !== to.visit) continue;
    jumps.push({ from: from.n, to: to.n, visit: to.visit, areas });
    if (to.n === of) skippedInVisit = true;
  }
  const backedLevels = [...backedSet].filter((n) => !seen.includes(n)).sort((a, b) => a - b);
  const missing = [];
  for (let n = 1; n <= of; n += 1) if (!seen.includes(n) && !backedSet.has(n)) missing.push(n);
  const complete = missing.length === 0;
  const firstN = sequence.findIndex((item) => item.n === of);
  const lastBefore = firstN > 0 ? sequence[firstN - 1].n : null;
  const first = visits[0];
  const watchedFromStart = first?.fromStart === true && first.levels.find(usable)?.n === 1 && sequence[0].visit === 1;
  const shape = seen.join(",");
  // the whole-record shapes are a skip only while the area starts leave levels uncovered
  const skipShape = shape === String(of) || (of >= 3 && shape === `1,${of}`);
  const skipped = seen.includes(of) && ((skipShape && !complete) || skippedInVisit);
  const verdict = skipped ? "skip"
    : jumps.length ? "jump"
      : complete && inOrder ? "verified" : "incomplete";
  return { of, seen, backed: backedLevels, missing, complete, inOrder, jumps, stretches, lastBefore, watchedFromStart, ...totals, verdict };
}

// The area starts after `from` (a read {visit, t}; null: the record's start) up to AREA_SLACK_S after `to`'s read.
// 0 when a read has no time.
function areasBetween(visits, from, to) {
  if ((from && from.t === undefined) || to.t === undefined) return 0;
  let count = 0;
  for (let v = from ? from.visit : 1; v <= to.visit; v += 1) {
    for (const area of visits[v - 1].areas) {
      if (area.t === undefined) continue;
      if (from && v === from.visit && area.t <= from.t) continue;
      if (v === to.visit && area.t > to.t + AREA_SLACK_S) continue;
      count += 1;
    }
  }
  return count;
}

export function simLevelFlags(levels) {
  if (!levels) return [];
  if (levels.verdict === "skip") {
    return [{ rule: "sim levels skipped", of: levels.of, seen: levels.seen, lastBefore: levels.lastBefore, fightsSeen: levels.fightsSeen,
      fightSeconds: levels.fightSeconds, clearTimeS: levels.clearTimeS }];
  }
  if (levels.verdict === "jump") {
    return levels.jumps.slice(0, MAX_JUMP_FLAGS).map((jump) => ({ rule: "sim level jump", from: jump.from, to: jump.to, visit: jump.visit, of: levels.of }));
  }
  return [];
}

// One log line per stored Sim run: the verdict and its counts, no ids or names.
export function simLevelsLogLine(levels) {
  const jumps = levels.jumps.map((jump) => `${jump.from}->${jump.to}@v${jump.visit}`).join(" ") || "none";
  return `Sim levels: ${levels.verdict}, N=${levels.of ?? "?"}, seen ${levels.seen.length}, backed ${levels.backed.length}, jumps ${jumps}, lastBefore ${levels.lastBefore ?? "-"}, `
    + `visits ${levels.visits}, areas ${levels.areas}, fights ${levels.fightsSeen} (${levels.fightSeconds} s), clear ${levels.clearTimeS ?? "?"} s`;
}
