// game-audit: n/a server rules for the run checks; no game data
// The run checks' rules, apart from the database (src/index.js stores and reads; this decides). The checks work by
// themselves: a run that hangs together passes with nobody looking, and only a run that looks possibly cheated goes to
// staff. No limit of any check is in this file (the repository is public): they come from secrets.
//
// An Interlink run's check ends in one of these (verify_state):
// - "match": verified, shown with the tick. Either two or more players' copies of the run agree (verifiedBy "copies"),
//   or, for a run no second copy confirms, the second reading of its pictures agrees (verifiedBy "reading").
// - "pending": its check hasn't run yet (queued for the second reading). The only public "pending".
// - "mismatch": on the staff list (possibly cheated). No public mark of it.
// - "unreadable", or none: no tick, no mark (a misread, a picture the reading couldn't make out, or nothing to check).
// - "confirmed" / "rejected": a staff decision; the checks leave such a run alone.

const objectOf = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);
const whole = (value) => (Number.isInteger(value) && value > 0 && value <= 1e9 ? value : null);
const perName = (value) => Object.fromEntries(Object.entries(objectOf(value) || {}).filter(([, item]) => whole(item) !== null));
function parsedSecret(text) {
  try {
    return objectOf(JSON.parse(text || "null"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Egg Heist (review only)
// EGG_CHECK_LIMITS (a secret), JSON: {"maxLoot": {"<difficulty>": loot, ...}, "minTimeS": {"<difficulty>": seconds, ...},
// "maxDefeats": n, "maxPointsPerMatch": n, "minMatchS": seconds}. Any part can be left out (that rule is then off);
// without the secret, or with one that doesn't parse, nothing is checked. A difficulty without its own number takes the
// most lenient one given (the highest loot, the lowest time).
export function eggCheckLimits(env) {
  const sent = parsedSecret(env?.EGG_CHECK_LIMITS);
  if (!sent) return null;
  const limits = {
    maxLoot: perName(sent.maxLoot), minTimeS: perName(sent.minTimeS), maxDefeats: whole(sent.maxDefeats),
    maxPointsPerMatch: whole(sent.maxPointsPerMatch), minMatchS: whole(sent.minMatchS),
  };
  const any = Object.keys(limits.maxLoot).length || Object.keys(limits.minTimeS).length || limits.maxDefeats || limits.maxPointsPerMatch;
  return any ? limits : null;
}
const lenient = (table, key, pick) => {
  const values = Object.values(table);
  return table[key] ?? (values.length ? pick(...values) : null);
};
// One match (eggheist_match: score is the loot, clear_time_s the match time, cleared a success).
export function eggMatchChecks(row, limits) {
  const flags = [];
  if (!limits) return flags;
  const loot = Number(row.score);
  const cap = lenient(limits.maxLoot, row.difficulty, Math.max);
  if (cap !== null && row.score != null && Number.isFinite(loot) && loot > cap) flags.push({ rule: "egg loot", sent: loot, limit: cap });
  const time = Number(row.clearTimeS);
  const floor = lenient(limits.minTimeS, row.difficulty, Math.min);
  if (floor !== null && row.cleared === 1 && row.clearTimeS != null && Number.isFinite(time) && time < floor) {
    flags.push({ rule: "egg time", sent: time, limit: floor });
  }
  if (limits.maxDefeats && row.defeats != null && (!Number.isInteger(Number(row.defeats)) || Number(row.defeats) < 0 || Number(row.defeats) > limits.maxDefeats)) {
    flags.push({ rule: "egg defeats", sent: row.defeats, limit: limits.maxDefeats });
  }
  return flags;
}
// A season standing against the same record's previous standing (eggheist_season is one record a season, replaced as
// it changes): rank points gained since then, against what the matches in between could give. The matches in between
// are the more of those aLogs sent (matchesSince) and those that fit in the time between (minMatchS a match), so a
// player who played without aLogs running isn't flagged for it.
export function eggStandingChecks(row, previous, matchesSince, limits) {
  if (!limits?.maxPointsPerMatch || !previous) return [];
  const now = Number(row.score);
  const before = Number(previous.score);
  if (row.score == null || previous.score == null || !Number.isFinite(now) || !Number.isFinite(before)) return [];
  const gain = now - before;
  const elapsed = Math.max(0, Number(row.at) - Number(previous.at)) || 0;
  const matches = Math.max(1, Number(matchesSince) || 0, limits.minMatchS ? Math.ceil(elapsed / limits.minMatchS) : 0);
  const allowed = limits.maxPointsPerMatch * matches;
  return gain > allowed ? [{ rule: "egg points", sent: gain, matches, limit: allowed }] : [];
}

// ---------------------------------------------------------------- a result read off the screen (review only)
// aLogs sends extra.screenCheck with a run: per screen ("result", "battleData"), where its proof came from (source
// "window": the game window itself; "screen": a copy of the screen, with "copy" "ok" or "failed" for the game window's
// own copy taken beside it) and, with both copies, how far they differed ("worst", "over25", "over40").
// SCREEN_CHECK_LIMITS (a secret), JSON: {"maxWorst": n, "maxOver25": n, "maxOver40": n, "copyFailed": true}. Any part can
// be left out; without the secret, or with one that doesn't parse, nothing is checked.
export function screenCheckLimits(env) {
  const sent = parsedSecret(env?.SCREEN_CHECK_LIMITS);
  if (!sent) return null;
  const limit = (value) => (Number.isInteger(value) && value >= 0 && value <= 1e6 ? value : null);
  const limits = { worst: limit(sent.maxWorst), over25: limit(sent.maxOver25), over40: limit(sent.maxOver40), copyFailed: sent.copyFailed === true };
  return limits.worst !== null || limits.over25 !== null || limits.over40 !== null || limits.copyFailed ? limits : null;
}
export function screenChecks(extra, limits) {
  const flags = [];
  const checks = objectOf(objectOf(extra)?.screenCheck);
  if (!limits || !checks) return flags;
  for (const [screen, check] of Object.entries(checks)) {
    if (!objectOf(check) || check.source !== "screen") continue;
    if (check.copy === "failed") {
      if (limits.copyFailed) flags.push({ rule: "screen copy failed", screen });
      continue;
    }
    for (const field of ["worst", "over25", "over40"]) {
      const value = Number(check[field]);
      if (limits[field] !== null && Number.isFinite(value) && value > limits[field]) flags.push({ rule: "screen differs", screen, field, sent: value, limit: limits[field] });
    }
  }
  return flags;
}

// ---------------------------------------------------------------- players' copies of one Interlink run
const BATTLE_FIELDS = ["avgDps", "breakValue", "damageTaken", "heal"];
const withBattleData = (players) => (Array.isArray(players) ? players : [])
  .filter((player) => player && BATTLE_FIELDS.every((field) => Number.isFinite(player[field])) && player.avgDps > 0);
const fold = (name) => String(name || "").toLocaleLowerCase().replace(/\s+/gu, "");
// Two copies agree: score and stars equal, clear time within a second, and where both carry Battle Data, the cards'
// numbers equal for the players both list (the same UID, else the same name).
export function copiesAgree(a, b) {
  if (a.score == null || b.score == null || Number(a.score) !== Number(b.score) || Number(a.stars) !== Number(b.stars)) return false;
  if (a.clearTimeS != null && b.clearTimeS != null && Math.abs(Number(a.clearTimeS) - Number(b.clearTimeS)) > 1) return false;
  const theirs = withBattleData(b.players);
  for (const card of withBattleData(a.players)) {
    const other = theirs.find((item) => (card.uid && item.uid && String(card.uid) === String(item.uid)) || (fold(card.name) && fold(card.name) === fold(item.name)));
    if (other && BATTLE_FIELDS.some((field) => card[field] !== other[field])) return false;
  }
  return true;
}
// How one copy (me) stands among the copies of its run (copies: [{ id, sender, score, stars, clearTimeS, players }],
// me among them; one copy a sender). verified: me and at least one other sender agree, and no other group of senders is
// as large. oddOneOut: a larger group agrees on something else (me is the misread). contradicted: another sender's copy
// differs on score or stars and no group settles it (two copies, two answers): the picture re-check decides.
export function copyAgreement(me, copies) {
  const bySender = new Map();
  for (const copy of copies) if (copy.id === me.id || !bySender.has(copy.sender)) bySender.set(copy.sender, copy);
  bySender.set(me.sender, me);
  const list = [...bySender.values()];
  const support = (copy) => 1 + list.filter((other) => other !== copy && copiesAgree(copy, other)).length;
  const mine = support(me);
  const best = Math.max(...list.map(support));
  const leaders = list.filter((copy) => support(copy) === best);
  const tie = best >= 2 && leaders.some((copy) => copy !== leaders[0] && !copiesAgree(copy, leaders[0]));
  const verified = list.length >= 2 && mine >= 2 && mine === best && !tie;
  const oddOneOut = !verified && best >= 2 && !tie && mine < best;
  const differs = list.some((other) => other !== me && other.score != null && me.score != null
    && (Number(other.score) !== Number(me.score) || Number(other.stars) !== Number(me.stars)));
  return { senders: list.length, agreeing: mine, verified, oddOneOut, contradicted: !verified && !oddOneOut && differs };
}

// ---------------------------------------------------------------- the verdict
const KEY_FIELDS = new Set(["score", "stars"]);
const keyDifferences = (comparison) => (comparison?.differences || []).filter((item) => KEY_FIELDS.has(item.field));
// flags: values the game's rules make impossible (staff); misread: numbers that don't hang together in a way a misread
// explains (no tick, no staff); agreement: copyAgreement; reading / reading2: compareReading of the first reading and
// of a second reading of the result screen (null when not read); wanted: the run matters enough to be read; readable:
// it has a picture to read. Returns { state, verifiedBy?, staff?, needs? } - needs "reading" or "second reading" when a
// reading would decide it.
export function interlinkVerdict({ flags = [], misread = [], agreement = null, reading = null, reading2 = null, wanted = false, readable = false }) {
  if (flags.length) return { state: "mismatch", staff: flags.map((flag) => ({ ...flag, why: "impossible" })) };
  if (misread.length) return { state: null };
  if (agreement?.contradicted) {
    if (!reading) return readable ? { state: null, needs: "reading" } : { state: null };
    const against = keyDifferences(reading);
    if (against.length) return { state: "mismatch", staff: [{ why: "copies contradict", differences: against }] };
    // its own picture is on its side: judged by its reading, like a lone run
  }
  else if (agreement?.verified) return { state: "match", verifiedBy: "copies" };
  else if (agreement?.oddOneOut) return { state: null };
  if (!reading) return wanted && readable ? { state: null, needs: "reading" } : { state: null };
  if (!reading.checked) return { state: "unreadable" };
  const against = keyDifferences(reading);
  if (against.length) {
    if (!reading2) return readable ? { state: null, needs: "second reading" } : { state: null };
    const again = keyDifferences(reading2);
    if (again.length) return { state: "mismatch", staff: [{ why: "read twice", differences: against, again }] };
    return { state: null };
  }
  if (reading.differences?.length) return { state: null };
  return { state: "match", verifiedBy: "reading" };
}

// ---------------------------------------------------------------- what staff read
const n = (value) => (value === null || value === undefined ? "—" : Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US") : String(value));
const SCREEN_NAMES = Object.freeze({ result: "result screen", battleData: "Battle Data screen" });
const FIELD_WORDS = Object.freeze({ worst: "the largest difference", over25: "the parts that differ a lot", over40: "the parts that differ very much" });
function flagWords(flag) {
  switch (flag.rule) {
    case "stars above the cap": return `${n(flag.sent)} stars sent; this boss gives at most ${n(flag.expected)}.`;
    case "clear time possible for the difficulty": return `Cleared in ${n(flag.sent)} s; the fastest possible at this difficulty is ${n(flag.expected)} s.`;
    case "coins of a full run": return `${n(flag.sent)} coins; a full run collects at least ${n(flag.expected)}.`;
    case "gizmos of a full run": return `${n(flag.sent)} gizmos; a full run has at least ${n(flag.expected)}.`;
    case "egg loot": return `${n(flag.sent)} loot; a match at this difficulty gives at most ${n(flag.limit)}.`;
    case "egg time": return `Won in ${n(flag.sent)} s; the fastest possible at this difficulty is ${n(flag.limit)} s.`;
    case "egg defeats": return `${n(flag.sent)} defeats sent; that isn't a count a match can have.`;
    case "egg points": return `${n(flag.sent)} rank points gained since the last standing; ${n(flag.matches)} matches can give at most ${n(flag.limit)}.`;
    case "screen copy failed": return `The ${SCREEN_NAMES[flag.screen] || flag.screen} was taken from the screen, and the copy of the game window failed.`;
    case "screen differs": return `The ${SCREEN_NAMES[flag.screen] || flag.screen} was taken from the screen, and it differs from the game window (${FIELD_WORDS[flag.field] || flag.field}: ${n(flag.sent)}, the limit is ${n(flag.limit)}).`;
    // checks stored before 21 Nov
    case "stars track score": return `${n(flag.sent)} stars sent; the score says about ${n(flag.expected)} (old rule: a misread).`;
    case "Avg DPS add up to team DPS": return `The players' Avg DPS add up to ${n(flag.expected)}; the team DPS says ${n(flag.sent)} (old rule: a misread).`;
    case "Avg DPS add up to the meter's DPS": return `The players' Avg DPS add up to ${n(flag.expected)}; aLogs' own estimate says ${n(flag.sent)} (old rule: a note only).`;
    case "Avg DPS plausible": return `One player's Avg DPS (${n(flag.sent)}) is above what the team's (${n(flag.teamDps)}) allows (old rule: a misread).`;
    case "cleared needs full stars": return `Sent as cleared with ${n(flag.sent)} stars; a clear needs ${n(flag.expected)} (old rule: a misread).`;
    case "star cap matches the rules": return `aLogs read a star cap of ${n(flag.sent)}; the site's rules say ${n(flag.expected)} (old rule: a note only).`;
    default: return String(flag.rule || "A check failed.");
  }
}
const differenceWords = (items) => items.map((item) => `${item.field} ${n(item.sent)} sent, ${n(item.read)} on the picture`).join("; ");
// The reasons a run is on the staff list, as sentences: check is the stored verify_json, state its verify_state.
export function staffReasons(check, state) {
  const reasons = [];
  if (state === "mismatch") {
    for (const item of check?.staff || []) {
      if (item.why === "copies contradict") reasons.push(`Another player's copy of this run shows other numbers, and this copy's own picture disagrees with it: ${differenceWords(item.differences || [])}.`);
      else if (item.why === "read twice") reasons.push(`Its picture was read twice and both times showed other numbers: ${differenceWords(item.differences || [])}.`);
      else reasons.push(flagWords(item));
    }
    if (!check?.staff) {
      // checks stored before 21 Nov: the rule flags and the reading's differences as they were
      for (const flag of check?.rules?.flags || []) reasons.push(flagWords(flag));
      if (check?.differences?.length) reasons.push(`The picture was read once with other numbers: ${differenceWords(check.differences)}.`);
    }
  }
  for (const flag of (check?.reviewOnly && !check.reviewOnly.decision ? check.reviewOnly.flags : null) || []) reasons.push(flagWords(flag));
  return reasons;
}

// ---------------------------------------------------------------- choosing limits from the data
function spread(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { rows: 0 };
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  return { rows: sorted.length, min: sorted[0], p10: at(0.1), p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted.at(-1) };
}
const count = (flags) => flags.reduce((totals, flag) => ({ ...totals, [flag.rule]: (totals[flag.rule] || 0) + 1 }), {});
const tally = (lists) => lists.reduce((totals, flags) => {
  for (const [rule, value] of Object.entries(count(flags))) totals[rule] = (totals[rule] || 0) + value;
  return totals;
}, {});
// rows: stored rows ({ kind, score, clearTimeS, cleared, difficulty, defeats, extra }); limits: candidate limits as
// the secrets would hold them ({ egg, screen }). Counts and distributions only.
export function limitPreview(rows, limits = {}) {
  const egg = eggCheckLimits({ EGG_CHECK_LIMITS: JSON.stringify(limits.egg ?? null) });
  const screen = screenCheckLimits({ SCREEN_CHECK_LIMITS: JSON.stringify(limits.screen ?? null) });
  const matches = rows.filter((row) => row.kind === "eggheist_match");
  const byDifficulty = {};
  for (const row of matches) (byDifficulty[row.difficulty || "unknown"] ||= []).push(row);
  const standings = rows.filter((row) => row.kind === "eggheist_season");
  const parts = rows.flatMap((row) => Object.values(objectOf(objectOf(row.extra)?.screenCheck) || {}).filter(objectOf).map((part) => ({ kind: row.kind, part })));
  const fromScreen = parts.filter(({ part }) => part.source === "screen");
  const compared = fromScreen.filter(({ part }) => part.copy === "ok").map(({ part }) => part);
  const screenFlags = rows.map((row) => screenChecks(row.extra, screen));
  return {
    egg: {
      limits: egg,
      matches: matches.length,
      byDifficulty: Object.fromEntries(Object.entries(byDifficulty).map(([difficulty, list]) => [difficulty, {
        matches: list.length, won: list.filter((row) => row.cleared === 1).length,
        loot: spread(list.map((row) => row.score)), wonTimeS: spread(list.filter((row) => row.cleared === 1).map((row) => row.clearTimeS)),
        defeats: spread(list.map((row) => row.defeats)),
      }])),
      flagged: tally(matches.map((row) => eggMatchChecks(row, egg))),
      matchesFlagged: matches.filter((row) => eggMatchChecks(row, egg).length).length,
      standings: standings.length,
      // what one match gave (extra.lastGain, as aLogs read it): the basis for maxPointsPerMatch; a standing's history
      // isn't stored (each replaces the last), so the points rule can only be previewed on new standings
      lastGain: spread(standings.map((row) => objectOf(row.extra)?.lastGain).filter((value) => Number.isInteger(value))),
    },
    screen: {
      limits: screen,
      rowsWithCheck: rows.filter((row) => objectOf(objectOf(row.extra)?.screenCheck)).length,
      screens: parts.length,
      bySource: parts.reduce((totals, { part }) => {
        const key = part.source === "screen" ? `screen, copy ${part.copy || "unknown"}` : String(part.source || "unknown");
        return { ...totals, [key]: (totals[key] || 0) + 1 };
      }, {}),
      fromScreenByKind: fromScreen.reduce((totals, { kind }) => ({ ...totals, [kind]: (totals[kind] || 0) + 1 }), {}),
      worst: spread(compared.map((part) => part.worst)),
      over25: spread(compared.map((part) => part.over25)),
      over40: spread(compared.map((part) => part.over40)),
      flagged: tally(screenFlags),
      rowsFlagged: screenFlags.filter((flags) => flags.length).length,
    },
  };
}
