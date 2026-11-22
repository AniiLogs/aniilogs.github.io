// game-audit: n/a server rules for the run checks; no game data
// The run checks' rules, apart from the database (src/index.js stores and reads; this decides). The checks work by
// themselves: a run that hangs together passes with nobody looking, and only a run that looks possibly cheated goes to
// staff. No limit of any check is in this file (the repository is public): they come from secrets.
//
// An Interlink run's check ends in one of these (verify_state):
// - "match": verified, shown with the tick. Either two or more players' copies of the run agree (verifiedBy "copies"),
//   or, for a run no second copy confirms, the reading of its pictures agrees (verifiedBy "reading").
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

const fold = (name) => String(name || "").toLocaleLowerCase().replace(/\s+/gu, "");

// ---------------------------------------------------------------- Interlink (review only)
// A damage multiplier makes the game itself count the inflated damage, so the cheater's Battle Data card shows a real
// but far too high Avg DPS. INTERLINK_CHECK_LIMITS (a secret), JSON: {"maxPlayerAvgDps": n, "maxAvgDpsPerCp": x,
// "maxTeamDps": n} (maxAvgDpsPerCp may be a decimal). Any part can be left out (that rule is then off); without the
// secret, or with one that doesn't parse, nothing is checked. Review only: a flagged run is listed for staff, nothing
// else changes (not its place, visibility or badge). Who is a bot: isBot(card, lineup), which src/index.js passes as the
// site's one rule (bots.js slotIsBot; this file is inlined into the worker and can't import it); without one, the
// card's own ai flag.
const dpsLimit = (value) => (Number.isInteger(value) && value > 0 && value <= 1e12 ? value : null);
const ratioLimit = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e6 ? value : null);
export function interlinkCheckLimits(env) {
  const sent = parsedSecret(env?.INTERLINK_CHECK_LIMITS);
  if (!sent) return null;
  const fight = fightLimits(sent.fight);
  const limits = { maxPlayerAvgDps: dpsLimit(sent.maxPlayerAvgDps), maxAvgDpsPerCp: ratioLimit(sent.maxAvgDpsPerCp), maxTeamDps: dpsLimit(sent.maxTeamDps),
    ...(fight ? { fight } : {}) };
  return limits.maxPlayerAvgDps !== null || limits.maxAvgDpsPerCp !== null || limits.maxTeamDps !== null || fight ? limits : null;
}

// ---------------------------------------------------------------- Interlink: the fight log (review only)
// The figures the server keeps from an Interlink run's fight log (extra.fightStats; src/fight-log.js computes them, and
// lists the same names as FIGHT_FIGURES). INTERLINK_CHECK_LIMITS may hold "fight": {"<figure>": {"min": x, "max": y}, ...}:
// min and max each optional, finite numbers; a figure without either, or one not in this list, is left out. A figure
// outside its range gives { rule: "fight log", figure, sent, min?, max? } (the range as set); a figure the log has no
// value for (null) is never flagged.
export const FIGHT_LOG_FIGURES = Object.freeze(["rows", "wallS", "damage", "dps", "hits", "hitsPerS", "hitMedian", "hitP90", "hitMax",
  "secondsWithDamagePct", "clockRate", "clockSpanS", "clockRateP10", "clockRateP90", "breaks", "breaksPerMin", "drainMedianS", "drainMinS",
  "drainSpreadS", "brokenMedianS", "brokenSharePct", "dpsUnbroken"]);
// The clock figures say nothing when the game's countdown was read over a short stretch (a few pairs 15 s apart, or
// none): they are only judged when the log read the clock over at least this many seconds (clockSpanS).
export const CLOCK_SPAN_MIN_S = 60;
const CLOCK_FIGURES = new Set(["clockRate", "clockRateP10", "clockRateP90"]);
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
function fightLimits(value) {
  const limits = {};
  for (const [figure, range] of Object.entries(objectOf(value) || {})) {
    if (!FIGHT_LOG_FIGURES.includes(figure) || !objectOf(range)) continue;
    const min = finite(range.min);
    const max = finite(range.max);
    if (min === null && max === null) continue;
    limits[figure] = { ...(min !== null ? { min } : {}), ...(max !== null ? { max } : {}) };
  }
  return Object.keys(limits).length ? limits : null;
}
// stats: a run's extra.fightStats; limits: interlinkCheckLimits(env) (its fight part)
export function fightLogChecks(stats, limits) {
  const ranges = limits?.fight;
  if (!ranges || !objectOf(stats)) return [];
  const flags = [];
  for (const figure of FIGHT_LOG_FIGURES) {
    const range = ranges[figure];
    const sent = finite(stats[figure]);
    if (!range || sent === null) continue;
    if (CLOCK_FIGURES.has(figure) && !(finite(stats.clockSpanS) >= CLOCK_SPAN_MIN_S)) continue;
    if ((range.min !== undefined && sent < range.min) || (range.max !== undefined && sent > range.max)) flags.push({ rule: "fight log", figure, sent, ...range });
  }
  return flags;
}
// A hint for staff, not a skip. The meter's own estimate from the boss's HP bar (meter_dps) is independent of the cards
// (team_dps isn't: the app sends it as the cards' sum). When the cards' sum is more than this factor away from it,
// either way, the run is still checked, and each flag carries meterDps and cardsSum so staff look at the Battle Data
// picture for a misread first. Skipping such runs would be a blind spot in a cheat's own direction: in the stored runs
// the meter was the one that under-read (it started following the fight late, which a player can cause on purpose),
// and the decimal-point misreads of the cards it was meant for only came from app builds that no longer send checks.
const MISREAD_FACTOR = 3;
const cardDps = (card) => (card && typeof card === "object" && typeof card.avgDps === "number" && Number.isFinite(card.avgDps) && card.avgDps >= 0 ? card.avgDps : null);
const aiFlag = (card) => Boolean(card.ai);
// row: { players, lineup, teamDps, meterDps } (players_json and extra.lineup parsed). -> { flags, read, meterFarOff,
// cards, sum }: read, whether any card's Avg DPS was read (an unread card is left out; with none read there is nothing
// to check); sum, the read cards' Avg DPS (bots included; a lower bound when a card is unread, so "above the limit"
// still holds); cards, the real players' { card, avgDps, cp }. A card is named by its 1-based position in the full
// players list (card), never by its name or UID. A card's CP: from partyOf(players, lineup) -> [entry | null] per card
// when it gives an answer (the site passes bots.js partyBySeat: on a four-card run, the Party entry of the card's own
// seat, whatever name it carries); else the one lineup entry of the card's name.
function interlinkDps(row, limits, isBot = aiFlag, partyOf = null) {
  const players = Array.isArray(row?.players) ? row.players : [];
  const readCards = players.map((card, index) => ({ card, index, avgDps: cardDps(card) })).filter((item) => item.avgDps !== null);
  if (!readCards.length) return { flags: [], read: false, meterFarOff: false, cards: [], sum: null };
  const sum = readCards.reduce((total, item) => total + item.avgDps, 0);
  const meter = Number(row.meterDps);
  const meterFarOff = row.meterDps != null && Number.isFinite(meter) && meter > 0 && (sum > meter * MISREAD_FACTOR || sum * MISREAD_FACTOR < meter);
  const lineup = (Array.isArray(row.lineup) ? row.lineup : []).filter(objectOf);
  const seated = typeof partyOf === "function" ? partyOf(players, lineup) : null;
  const cards = readCards.filter(({ card }) => !isBot(card, lineup)).map(({ card, index, avgDps }) => {
    const entries = Array.isArray(seated) ? (seated[index] ? [seated[index]] : [])
      : fold(card.name) ? lineup.filter((entry) => fold(entry.name) === fold(card.name)) : [];
    const cp = entries.length === 1 && entries[0].cp != null ? Number(entries[0].cp) : NaN;
    return { card: index + 1, avgDps, cp: Number.isFinite(cp) && cp > 0 ? cp : null };
  });
  const flags = [];
  if (limits) {
    for (const { card, avgDps, cp } of cards) {
      if (limits.maxPlayerAvgDps !== null && avgDps > limits.maxPlayerAvgDps) flags.push({ rule: "player avg dps", card, sent: avgDps, limit: limits.maxPlayerAvgDps });
      if (limits.maxAvgDpsPerCp !== null && cp !== null && avgDps / cp > limits.maxAvgDpsPerCp) {
        flags.push({ rule: "player avg dps per cp", card, sent: Math.round((avgDps / cp) * 10) / 10, avgDps, cp, limit: limits.maxAvgDpsPerCp });
      }
    }
    if (limits.maxTeamDps !== null && sum > limits.maxTeamDps) flags.push({ rule: "team dps", sent: sum, limit: limits.maxTeamDps });
  }
  return { flags: meterFarOff ? flags.map((flag) => ({ ...flag, meterDps: meter, cardsSum: sum })) : flags, read: true, meterFarOff, cards, sum };
}
export function interlinkDpsChecks(row, limits, isBot = aiFlag, partyOf = null) {
  return limits ? interlinkDps(row, limits, isBot, partyOf).flags : [];
}

// ---------------------------------------------------------------- players' copies of one Interlink run
const BATTLE_FIELDS = ["avgDps", "breakValue", "damageTaken", "heal"];
const withBattleData = (players) => (Array.isArray(players) ? players : [])
  .filter((player) => player && BATTLE_FIELDS.every((field) => Number.isFinite(player[field])) && player.avgDps > 0);
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
// The free checks' star rule: each star is worth about 1,000, so stars = min(floor(score / 1000), cap), give or take one.
export function starsFitScore(score, stars, cap) {
  if (!Number.isFinite(Number(score)) || !Number.isFinite(Number(stars)) || score === null || stars === null) return false;
  return Math.abs(Number(stars) - Math.min(Math.floor(Number(score) / 1000), Number(cap))) <= 1;
}
const digits = (value) => String(Math.trunc(Math.abs(Number(value)))).length;
// Whether a reading's score / stars differences count against the run (the owner, 22 Nov: a cheat sends more than its
// picture has; the reader misreads all by itself, and reading a picture twice gives the same answer). Both must hold:
// (a) the reading is a plausible reading of the same screen - its score has at least as many digits as the one sent,
//     and its score and stars fit each other by the star rule (starsFitScore, the run's own cap);
// (b) what was sent is better than what the picture shows: a higher score, or more stars.
// comparison: compareReading's answer; read: { score, stars } as read; sent: { score, stars }; cap: the run's star cap.
// -> { against: [differences] } or { against: [], note } (why a difference doesn't count; none when there was none)
export function readingAgainst(comparison, read, sent, cap) {
  const differences = keyDifferences(comparison);
  if (!differences.length) return { against: [] };
  if (read?.score == null || read?.stars == null) return { against: [], note: "reading not plausible: score or stars not read" };
  if (sent?.score != null && digits(read.score) < digits(sent.score)) return { against: [], note: "reading not plausible: fewer digits" };
  if (!starsFitScore(read.score, read.stars, cap)) return { against: [], note: "reading not plausible: its score and stars don't fit" };
  const higher = sent?.score != null && Number(sent.score) > Number(read.score);
  const more = sent?.stars != null && Number(sent.stars) > Number(read.stars);
  if (!higher && !more) return { against: [], note: "sent lower than the picture" };
  return { against: differences };
}
// flags: values the game's rules make impossible (staff); misread: numbers that don't hang together in a way a misread
// explains (no tick, no staff); agreement: copyAgreement; reading: compareReading of the reading of the run's pictures
// (null when not read), with read / sent / cap for readingAgainst; wanted: the run matters enough to be read; readable:
// it has a picture to read. Returns { state, verifiedBy?, staff?, needs?, note? } - needs "reading" when a reading would
// decide it; note: why a reading's difference didn't count. A picture is read once: the model gives the same answer for
// the same picture, so a second reading of it decides nothing.
export function interlinkVerdict({ flags = [], misread = [], agreement = null, reading = null, read = null, sent = null, cap = null, wanted = false, readable = false }) {
  if (flags.length) return { state: "mismatch", staff: flags.map((flag) => ({ ...flag, why: "impossible" })) };
  if (misread.length) return { state: null };
  const judged = reading ? readingAgainst(reading, read, sent, cap) : { against: [] };
  const shown = () => ({ score: read?.score ?? null, stars: read?.stars ?? null });
  if (agreement?.contradicted) {
    if (!reading) return readable ? { state: null, needs: "reading" } : { state: null };
    if (judged.against.length) return { state: "mismatch", staff: [{ why: "copies contradict", differences: judged.against, shown: shown() }] };
    // its own picture doesn't count against it: judged by its reading, like a lone run
  }
  else if (agreement?.verified) return { state: "match", verifiedBy: "copies" };
  else if (agreement?.oddOneOut) return { state: null };
  if (!reading) return wanted && readable ? { state: null, needs: "reading" } : { state: null };
  if (!reading.checked) return { state: "unreadable" };
  if (judged.against.length) return { state: "mismatch", staff: [{ why: "picture shows less", differences: judged.against, shown: shown() }] };
  if (judged.note) return { state: null, note: judged.note };
  if (reading.differences?.length) return { state: null };
  return { state: "match", verifiedBy: "reading" };
}

// ---------------------------------------------------------------- what staff read
const n = (value) => (value === null || value === undefined ? "—" : Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US") : String(value));
const SCREEN_NAMES = Object.freeze({ result: "result screen", battleData: "Battle Data screen" });
const FIELD_WORDS = Object.freeze({ worst: "the largest difference", over25: "the parts that differ a lot", over40: "the parts that differ very much" });
// an Interlink Avg DPS flag whose cards are far from the meter's estimate (MISREAD_FACTOR): a misread to rule out first
const meterWords = (flag) => (flag.meterDps != null && flag.cardsSum != null
  ? ` aLogs' own estimate from the boss's HP bar is ${n(flag.meterDps)} for the team against the cards' ${n(flag.cardsSum)}: look at the Battle Data picture for a misread first.`
  : "");
// A fight-log figure as the start of a sentence ("{}" is the value)
const FIGHT_WORDS = Object.freeze({
  rows: "The fight log has {} usable rows",
  wallS: "The fight log covers {} s",
  damage: "The fight log's team damage is {}",
  dps: "The fight log's team DPS is {}",
  hits: "The fight log counts {} hits",
  hitsPerS: "The fight log counts {} hits a second",
  hitMedian: "The fight log's median hit is {}",
  hitP90: "The fight log's 90th-percentile hit is {}",
  hitMax: "The fight log's biggest hit is {}",
  secondsWithDamagePct: "The team's damage rose in {}% of the fight log's seconds",
  clockRate: "The fight log's clock ran at {} times real time",
  clockRateP10: "The fight log's clock ran at {} times real time at its slowest (10th percentile)",
  clockRateP90: "The fight log's clock ran at {} times real time at its fastest (90th percentile)",
  clockSpanS: "The fight log read the game's clock over {} s",
  breaks: "The fight log has {} breaks",
  breaksPerMin: "The fight log has {} breaks a minute",
  drainMedianS: "The fight log's median drain before a break is {} s",
  drainMinS: "The fight log's shortest drain before a break is {} s",
  drainSpreadS: "The fight log's drains before a break differ by up to {} s",
  brokenMedianS: "The fight log's median broken phase lasts {} s",
  brokenSharePct: "The boss was broken for {}% of the fight log",
  dpsUnbroken: "The fight log's team DPS outside broken phases is {}",
});
function fightLogWords(flag) {
  const start = (FIGHT_WORDS[flag.figure] || `The fight log's ${flag.figure} is {}`).replace("{}", n(flag.sent));
  const limit = flag.max !== undefined && flag.sent > flag.max ? `at most ${n(flag.max)}` : flag.min !== undefined ? `at least ${n(flag.min)}` : `at most ${n(flag.max)}`;
  return `${start}; the limit for review is ${limit}.`;
}
function flagWords(flag) {
  switch (flag.rule) {
    case "fight log": return fightLogWords(flag);
    case "stars above the cap": return `${n(flag.sent)} stars sent; this boss gives at most ${n(flag.expected)}.`;
    case "clear time possible for the difficulty": return `Cleared in ${n(flag.sent)} s; the fastest possible at this difficulty is ${n(flag.expected)} s.`;
    case "coins of a full run": return `${n(flag.sent)} coins; a full run collects at least ${n(flag.expected)}.`;
    case "gizmos of a full run": return `${n(flag.sent)} gizmos; a full run has at least ${n(flag.expected)}.`;
    case "egg loot": return `${n(flag.sent)} loot; a match at this difficulty gives at most ${n(flag.limit)}.`;
    case "egg time": return `Won in ${n(flag.sent)} s; the fastest possible at this difficulty is ${n(flag.limit)} s.`;
    case "egg defeats": return `${n(flag.sent)} defeats sent; that isn't a count a match can have.`;
    case "egg points": return `${n(flag.sent)} rank points gained since the last standing; ${n(flag.matches)} matches can give at most ${n(flag.limit)}.`;
    case "player avg dps": return `Player ${n(flag.card)}'s Avg DPS is ${n(flag.sent)}; the limit for review is ${n(flag.limit)}.${meterWords(flag)}`;
    case "player avg dps per cp": return `Player ${n(flag.card)}'s Avg DPS is ${n(flag.sent)} per point of CP (${n(flag.avgDps)} at CP ${n(flag.cp)}); the limit for review is ${n(flag.limit)}.${meterWords(flag)}`;
    case "team dps": return `The team's Avg DPS add up to ${n(flag.sent)}; the limit for review is ${n(flag.limit)}.${meterWords(flag)}`;
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
// "the picture shows score 34,333 and 20 stars; sent: score 99,000 and 40 stars"
function pictureWords(item) {
  const sent = Object.fromEntries((item.differences || []).map((d) => [d.field, d.sent]));
  const shown = item.shown || Object.fromEntries((item.differences || []).map((d) => [d.field, d.read]));
  const pair = (values, other) => ["score", "stars"].filter((field) => values[field] != null || other[field] != null)
    .map((field) => (field === "score" ? `score ${n(values.score ?? other.score)}` : `${n(values.stars ?? other.stars)} stars`)).join(" and ");
  return `the picture shows ${pair(shown, sent)}; sent: ${pair(sent, shown)}`;
}
// The reasons a run is on the staff list, as sentences: check is the stored verify_json, state its verify_state.
export function staffReasons(check, state) {
  const reasons = [];
  if (state === "mismatch") {
    for (const item of check?.staff || []) {
      if (item.why === "copies contradict") reasons.push(`Another player's copy of this run shows other numbers, and this copy's own picture shows less than was sent: ${pictureWords(item)}.`);
      else if (item.why === "picture shows less") reasons.push(`Its picture shows less than was sent: ${pictureWords(item)}.`);
      // checks stored on 21 Nov
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
  const sorted = values.filter((value) => value !== null && value !== undefined && value !== "").map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { rows: 0 };
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  return { rows: sorted.length, min: sorted[0], p10: at(0.1), p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted.at(-1) };
}
const count = (flags) => flags.reduce((totals, flag) => ({ ...totals, [flag.rule]: (totals[flag.rule] || 0) + 1 }), {});
const tally = (lists) => lists.reduce((totals, flags) => {
  for (const [rule, value] of Object.entries(count(flags))) totals[rule] = (totals[rule] || 0) + value;
  return totals;
}, {});
// One copy of each Interlink run: team-mates' copies share extra.instanceId, and the newest copy stands for the run
// (a row without one is a run by itself).
function oneCopyEach(rows) {
  const runs = new Map();
  rows.forEach((row, index) => {
    const instance = objectOf(row.extra)?.instanceId;
    const key = instance != null && String(instance) !== "" ? `i:${instance}` : `r:${row.submissionId ?? index}`;
    const held = runs.get(key);
    if (!held || (Number(row.createdAt) || 0) > (Number(held.createdAt) || 0)) runs.set(key, row);
  });
  return [...runs.values()];
}
// rows: stored rows ({ kind, score, clearTimeS, cleared, difficulty, defeats, extra }; an Interlink run also
// { submissionId, createdAt, players, teamDps, meterDps }); limits: candidate limits as the secrets would hold them
// ({ egg, screen, interlink }); isBot, partyOf: as for interlinkDpsChecks. Counts and distributions only.
export function limitPreview(rows, limits = {}, isBot = aiFlag, partyOf = null) {
  const egg = eggCheckLimits({ EGG_CHECK_LIMITS: JSON.stringify(limits.egg ?? null) });
  const screen = screenCheckLimits({ SCREEN_CHECK_LIMITS: JSON.stringify(limits.screen ?? null) });
  const interlink = interlinkCheckLimits({ INTERLINK_CHECK_LIMITS: JSON.stringify(limits.interlink ?? null) });
  const interlinkRows = rows.filter((row) => row.kind === "interlink_run");
  const runs = oneCopyEach(interlinkRows);
  const checked = runs.map((row) => interlinkDps({ players: row.players, lineup: objectOf(row.extra)?.lineup, teamDps: row.teamDps, meterDps: row.meterDps }, interlink, isBot, partyOf));
  const kept = checked.filter((result) => result.read);
  const cards = kept.flatMap((result) => result.cards);
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
    // each run counted once (one copy per extra.instanceId); runsChecked: runs with at least one card read (the
    // distributions come from those); noAvgDps: runs with no card read; meterFarOff: checked runs whose cards' sum is
    // more than MISREAD_FACTOR from the meter's estimate (their flags carry the hint for staff)
    interlink: {
      limits: interlink,
      copies: interlinkRows.length,
      runs: runs.length,
      runsChecked: kept.length,
      noAvgDps: checked.filter((result) => !result.read).length,
      meterFarOff: kept.filter((result) => result.meterFarOff).length,
      playerAvgDps: spread(cards.map((card) => card.avgDps)),
      avgDpsPerCp: spread(cards.filter((card) => card.cp !== null).map((card) => Math.round((card.avgDps / card.cp) * 10) / 10)),
      teamDps: spread(kept.map((result) => result.sum)),
      flagged: tally(checked.map((result) => result.flags)),
      runsFlagged: checked.filter((result) => result.flags.length).length,
      // the fight log's figures (extra.fightStats), for candidate interlink.fight limits: runs with stored figures, each
      // figure's spread, and how many runs each figure would flag
      fight: (() => {
        const stats = runs.map((row) => objectOf(objectOf(row.extra)?.fightStats)).filter(Boolean);
        const fightFlags = stats.map((item) => fightLogChecks(item, interlink));
        const flagged = {};
        for (const flags of fightFlags) for (const flag of flags) flagged[flag.figure] = (flagged[flag.figure] || 0) + 1;
        return { runs: stats.length, figures: Object.fromEntries(FIGHT_LOG_FIGURES.map((figure) => [figure, spread(stats.map((item) => item[figure]))])),
          flagged, runsFlagged: fightFlags.filter((flags) => flags.length).length };
      })(),
    },
  };
}
