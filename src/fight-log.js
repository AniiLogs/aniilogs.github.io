// game-audit: n/a reads aLogs' own fight log (the meter's CSV), no game data
// An Interlink run's fight log: the CSV aLogs' meter writes for a fight (a header row, then a row per look at the
// boss's HP bar, about 9 a second), and the fixed set of figures the server keeps from it for the review-only checks
// (src/run-checks.js judges them; the limits are in a secret). Pure: no imports, no storage. Inlined into the worker by
// scripts/build-pages-api.mjs; tools/fight-log-stats.mjs prints the figures for a file.
//
// The figures are a port of the owner's reference implementation (fight_stats in Python): the same rows, the same
// percentile rule, the same rounding (Python's round: half to even, on the number's exact value) and the same sums
// (Python 3.12's compensated float sum), so both give the same numbers for the same file.

// Every figure, in the order fightStats returns them
export const FIGHT_FIGURES = Object.freeze(["rows", "wallS", "damage", "dps", "hits", "hitsPerS", "hitMedian", "hitP90", "hitMax",
  "secondsWithDamagePct", "clockRate", "clockSpanS", "clockRateP10", "clockRateP90", "breaks", "breaksPerMin", "drainMedianS", "drainMinS",
  "drainSpreadS", "brokenMedianS", "brokenSharePct", "dpsUnbroken"]);

// A CSV as Python's csv.DictReader reads it: the first record names the columns; each later record is an object of
// column -> text (a column the record is short of is missing; blank lines are skipped). Quoted fields may hold commas,
// line breaks and doubled quotes; lines end in \n, \r\n or \r. A byte-order mark before the header is dropped.
export function parseFightCsv(text) {
  const records = csvRecords(String(text ?? "").replace(/^﻿/u, ""));
  const header = records.shift();
  if (!header) return [];
  return records.map((record) => {
    const row = {};
    header.forEach((name, i) => { if (i < record.length) row[name] = record[i]; });   // a repeated column: the last one, as Python
    return row;
  });
}

function csvRecords(text) {
  const records = [];
  let record = [];
  let field = "";
  let state = "start";                                 // start (of a field), plain, quoted, quote (a quote in a quoted field)
  let started = false;                                 // the record has anything (a blank line has nothing)
  const endField = () => { record.push(field); field = ""; };
  const endRecord = () => {
    if (started) { endField(); records.push(record); }
    record = []; field = ""; state = "start"; started = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (state === "quoted") {
      if (ch === "\"") state = "quote";
      else field += ch;
      continue;
    }
    if (state === "quote") {
      if (ch === "\"") { field += "\""; state = "quoted"; continue; }
      state = "plain";                                 // after the closing quote: the rest of the field is plain text
    }
    if (ch === ",") { started = true; endField(); state = "start"; continue; }
    if (ch === "\n" || ch === "\r") {
      endRecord();
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      continue;
    }
    started = true;
    if (state === "start" && ch === "\"") { state = "quoted"; continue; }
    state = "plain";
    field += ch;
  }
  if (started || state === "quoted" || state === "quote") { started = true; endRecord(); }
  return records;
}

// A cell as a number the way Python's float() reads it (a decimal or exponent form, spaces round it), else null;
// NaN and infinities are null too
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;
function num(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!NUMBER.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

// Python's pct: the value at int(p * (n - 1)) of the sorted list
function pct(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.trunc(p * (sorted.length - 1)))] : null;
}

// Python's round(x, digits): the nearest number with that many decimals to x's exact value, a tie to the even one
export function pyRound(x, digits = 0) {
  if (!Number.isFinite(x)) return x;
  if (!digits) {
    const floor = Math.floor(x);
    const rest = x - floor;
    return rest < 0.5 ? floor : rest > 0.5 ? floor + 1 : (floor % 2 === 0 ? floor : floor + 1);
  }
  const a = Math.abs(x);
  if (a >= 1e21) return x;
  const sign = x < 0 ? -1 : 1;
  const [whole, fraction = ""] = a.toFixed(100).split(".");
  if (/^50*$/u.test(fraction.slice(digits))) {
    const kept = fraction.slice(0, digits);
    const evenNow = Number(kept.at(-1) ?? whole.at(-1)) % 2 === 0;
    return sign * (evenNow ? Number(`${whole}.${kept}`) : Number(a.toFixed(digits)));
  }
  return sign * Number(a.toFixed(digits));
}

// Python 3.12's sum() of floats (Neumaier's compensated sum)
function pySum(values) {
  let total = 0;
  let c = 0;
  for (const x of values) {
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) c += (total - t) + x;
    else c += (x - t) + total;
    total = t;
  }
  return c && Number.isFinite(c) ? total + c : total;
}

const ascending = (a, b) => a - b;
// Seconds of real time between two looks for the clock rate: each look is paired with the last look at least this
// long before it
const CLOCK_PAIR_S = 15;

// rows: parseFightCsv's. -> the figures (FIGHT_FIGURES), or null for fewer than 20 usable rows (a wall_s and a
// team_damage, wall_s not below 0) or a fight with no length.
export function fightStats(rows) {
  const points = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const wall = num(row?.wall_s);
    const damage = num(row?.team_damage);
    if (wall === null || damage === null) continue;
    points.push({ wall, damage, timer: num(row.timer_s), phase: typeof row.break_phase === "string" ? row.break_phase.trim() : "" });
  }
  const pts = points.filter((p) => p.wall >= 0);
  if (pts.length < 20) return null;
  const last = pts.at(-1);
  const wall = last.wall - pts[0].wall;
  if (!(wall > 0)) return null;
  // hits: rises of the team's damage between two looks
  const rises = [];
  for (let i = 1; i < pts.length; i += 1) if (pts[i].damage > pts[i - 1].damage) rises.push({ at: pts[i].wall, size: pts[i].damage - pts[i - 1].damage });
  const sizes = rises.map((rise) => rise.size).sort(ascending);
  const seconds = new Set(rises.map((rise) => Math.trunc(rise.at)));
  const out = {
    rows: pts.length,
    wallS: pyRound(wall, 1),
    damage: Math.trunc(last.damage),
    dps: pyRound(last.damage / wall),
    hits: rises.length,
    hitsPerS: pyRound(rises.length / wall, 2),
    hitMedian: pyRound(pct(sizes, 0.5) || 0),
    hitP90: pyRound(pct(sizes, 0.9) || 0),
    hitMax: sizes.length ? pyRound(sizes.at(-1)) : 0,
    secondsWithDamagePct: pyRound((100 * seconds.size) / Math.max(1, Math.trunc(wall)), 1),
  };
  // the game's clock against real time: the countdown's fall per real second, as the median over pairs 15 s apart
  const clock = pts.filter((p) => p.timer !== null && p.timer >= 0 && p.timer <= 600).map((p) => [p.wall, p.timer]);
  const rates = [];
  let j = 0;
  for (let i = 0; i < clock.length; i += 1) {
    while (clock[i][0] - clock[j][0] > CLOCK_PAIR_S) j += 1;
    if (j > 0) {
      const a = clock[j - 1];
      const dw = clock[i][0] - a[0];
      if (dw >= CLOCK_PAIR_S) rates.push((a[1] - clock[i][1]) / dw);
    }
  }
  rates.sort(ascending);
  out.clockRate = rates.length ? pyRound(pct(rates, 0.5), 3) : null;
  out.clockSpanS = clock.length > 1 ? pyRound(clock.at(-1)[0] - clock[0][0], 1) : 0;
  out.clockRateP10 = rates.length ? pyRound(pct(rates, 0.1), 3) : null;
  out.clockRateP90 = rates.length ? pyRound(pct(rates, 0.9), 3) : null;
  // break phases: runs of looks in one phase (a look with no phase doesn't end a run)
  const runs = [];
  for (const p of pts) {
    if (!p.phase) continue;
    const run = runs.at(-1);
    if (run && run.phase === p.phase) { run.t1 = p.wall; run.d1 = p.damage; } else runs.push({ phase: p.phase, t0: p.wall, t1: p.wall, d0: p.damage, d1: p.damage });
  }
  const broken = runs.filter((run) => run.phase === "broken");
  // a drain that ended in a break: the "drain" run right before a "broken" one
  const drains = runs.filter((run, i) => i + 1 < runs.length && run.phase === "drain" && runs[i + 1].phase === "broken");
  const drainS = drains.map((run) => run.t1 - run.t0).sort(ascending);
  const brokenS = broken.map((run) => run.t1 - run.t0).sort(ascending);
  const timeBroken = pySum(brokenS);
  const damageBroken = pySum(broken.map((run) => run.d1 - run.d0));
  Object.assign(out, {
    breaks: broken.length,
    breaksPerMin: pyRound(broken.length / (wall / 60), 2),
    drainMedianS: drainS.length ? pyRound(pct(drainS, 0.5), 1) : null,
    drainMinS: drainS.length ? pyRound(drainS[0], 1) : null,
    drainSpreadS: drainS.length > 1 ? pyRound(drainS.at(-1) - drainS[0], 1) : null,
    brokenMedianS: brokenS.length ? pyRound(pct(brokenS, 0.5), 1) : null,
    brokenSharePct: pyRound((100 * timeBroken) / wall, 1),
    dpsUnbroken: pyRound((last.damage - damageBroken) / Math.max(1, wall - timeBroken)),
  });
  return out;
}
