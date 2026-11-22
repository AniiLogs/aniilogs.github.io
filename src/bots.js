// game-audit: unaudited the Interlink bots' four names (Flora, Mario, Leonard, Tammy), from the owner's runs
// Who is a bot in an Interlink run: ONE rule for every answer the site gives (the owner, 21 Nov). The app's `ai` flag is
// read from the colour of a small mark and is sometimes wrong (11 real players flagged in 162 Party reads, 4 bots
// flagged as players), so the site doesn't pass it on. A slot is a bot only when its name is one of the game's four
// bot names (case and spaces folded) and nothing says it's a person: no UID, no account (the sender's own slot, a
// confirmed teammate), and no CP (a bot's Party card has a level and no CP). Everything else is a real player. Stored
// runs are never changed: this is how the site reads them.
export const BOT_NAMES = Object.freeze(["flora", "mario", "leonard", "tammy"]);
const fold = (name) => (typeof name === "string" ? name.normalize("NFKC").toLowerCase().replace(/\s+/gu, "") : "");

// slot: one of a run's players (players_json) or a Party entry (extra.lineup); party: the run's Party entries, where a
// slot's CP is found by its name
export function slotIsBot(slot, party = null) {
  if (!slot || typeof slot !== "object" || !BOT_NAMES.includes(fold(slot.name))) return false;
  if (slot.uid || slot.self === true || slot.confirmed === true || slot.confirmed === 1 || Number.isInteger(slot.cp)) return false;
  const entry = Array.isArray(party) ? party.find((other) => other && typeof other === "object" && fold(other.name) === fold(slot.name)) : null;
  return !(entry && (Number.isInteger(entry.cp) || entry.self === true));
}

// Solo / Duo / Trio: the real players of a run that had bots (1-3), else null (a full team, or no bots by the rule)
export function realPlayersOf(players, party = null) {
  const list = typeof players === "string" ? (() => { try { return JSON.parse(players); } catch { return null; } })() : players;
  if (!Array.isArray(list)) return null;
  const lineup = typeof party === "string" ? (() => { try { return JSON.parse(party); } catch { return null; } })() : party;
  const slots = list.filter((player) => player && typeof player === "object");
  const bots = slots.filter((player) => slotIsBot(player, lineup)).length;
  const real = slots.filter((player) => !slotIsBot(player, lineup) && player.name).length;
  return bots && real >= 1 && real <= 3 ? real : null;
}

const parsed = (value) => (typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value);

// The seats (1P-4P) a run's Party screen gives: folded name -> seat. aLogs stores the Party screen's slots 0-3
// (extra.lineup[].slot, alogs-meter payloads.rs), and the game marks them 1P-4P in that order, so seat = slot + 1. The
// stored players (players_json) carry no seat of their own, so a player's seat is the lineup slot whose name is theirs;
// a name the lineup has twice, or a slot outside 0-3, gives no seat (a seat is never guessed). Only for a run without
// cards: anything that has the run's cards takes each card's seat from cardSeats.
export function lineupSeats(party) {
  const lineup = parsed(party);
  if (!Array.isArray(lineup)) return new Map();
  const found = new Map();
  for (const item of lineup) {
    if (!item || typeof item !== "object" || !fold(item.name) || !Number.isInteger(item.slot) || item.slot < 0 || item.slot > 3) continue;
    const key = fold(item.name);
    found.set(key, found.has(key) ? null : item.slot + 1);
  }
  return new Map([...found].filter(([, seat]) => seat !== null));
}
export const seatKey = fold;
// nameSimilarity under a name of its own, for index.js (which has an older nameSimilarity, an LCS measure, of its own)
export const seatNameSimilarity = (a, b) => nameSimilarity(a, b);

// Near names (cardSeats step 4): the similarity of two names is 1 - (Levenshtein distance of their skeletons, in
// characters) / (the longer skeleton's length), 0..1; an empty name is 0. A card and a Party entry are the same player
// when they are each other's closest, at NEAR_FLOOR or more, and NEAR_MARGIN ahead of the card's next-best entry and
// of the entry's next-best card (a tie never matches). 0.75: one letter off in four, two in eight.
export const NEAR_FLOOR = 0.75;
export const NEAR_MARGIN = 0.2;
export function nameSimilarity(a, b) {
  const x = [...nameSkeleton(typeof a === "string" ? a : "")];
  const y = [...nameSkeleton(typeof b === "string" ? b : "")];
  if (!x.length || !y.length) return 0;
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= y.length; j += 1) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = next;
  }
  return 1 - row[y.length] / Math.max(x.length, y.length);
}

// Every card's seat (1P-4P) on its run: players are the run's Battle Data cards (players_json), party its Party entries
// (extra.lineup, slot 0-3 = seat 1-4); the answer is one seat or null per card, in the cards' order. The boards show a
// card's seat from this alone, so it is the same on every line.
// The cards are the result screen's player columns, left to right, and the game prints each column's 1P-4P badge in
// that order: a run with four cards has its seats by position (1, 2, 3, 4), and the lineup isn't asked. Its slots come
// from the Party screen's name pills, which older app builds put on the wrong player (stored runs: where the two
// disagree, the position is right), so they are only the fallback for a run with fewer than four cards (a column
// wasn't read, so positions may have shifted). More than four: no seats. The fallback's steps each work only among the
// cards and entries still unassigned, and a seat goes to one card at most:
// 1. the same folded name (case and spaces), unique among both;
// 2. the card marked self with the entry marked self, when there is one of each;
// 3. the same skeleton (nameSkeleton: look-alike letters), unique among both;
// 4. near names (nameSimilarity, NEAR_FLOOR, NEAR_MARGIN): clearly each other's closest;
// 5. one card left and one entry left: that entry's seat. Two cards or more left, or no entry: no guess.
// An entry whose slot isn't an integer 0-3 is ignored, and so are two entries on one slot (that slot was read twice).
export function cardSeats(players, party = null) {
  const list = parsed(players);
  if (!Array.isArray(list)) return [];
  const isCard = (card) => Boolean(card && typeof card === "object");
  if (list.length === 4) return list.map((card, index) => (isCard(card) ? index + 1 : null));   // 0: by position
  if (list.length > 4) return list.map(() => null);
  const lineup = parsed(party);
  const ok = (Array.isArray(lineup) ? lineup : [])
    .filter((item) => item && typeof item === "object" && Number.isInteger(item.slot) && item.slot >= 0 && item.slot <= 3);
  const entries = ok.filter((item) => ok.filter((other) => other.slot === item.slot).length === 1);
  const seats = list.map(() => null);
  const cards = list.map((card, index) => ({ card, index })).filter(({ card }) => isCard(card));
  const used = new Set();
  const openCards = () => cards.filter(({ index }) => seats[index] === null);
  const openEntries = () => entries.filter((entry) => !used.has(entry));
  const give = ({ index }, entry) => { seats[index] = entry.slot + 1; used.add(entry); };
  const byKey = (key) => {
    const name = (value) => (typeof value === "string" && key(value) ? key(value) : null);
    const cs = openCards();
    const es = openEntries();
    const count = (items) => items.reduce((n, k) => (k ? n.set(k, (n.get(k) || 0) + 1) : n), new Map());
    const cardKeys = count(cs.map(({ card }) => name(card.name)));
    const entryKeys = count(es.map((entry) => name(entry.name)));
    for (const one of cs) {
      const k = name(one.card.name);
      if (k && cardKeys.get(k) === 1 && entryKeys.get(k) === 1) give(one, es.find((entry) => name(entry.name) === k));
    }
  };
  byKey(fold);                                                                   // 1
  const selfCards = openCards().filter(({ card }) => card.self === true);        // 2
  const selfEntries = openEntries().filter((entry) => entry.self === true);
  if (selfCards.length === 1 && selfEntries.length === 1) give(selfCards[0], selfEntries[0]);
  byKey(nameSkeleton);                                                           // 3
  {                                                                              // 4
    const cs = openCards();
    const es = openEntries();
    const sim = cs.map(({ card }) => es.map((entry) => nameSimilarity(card.name, entry.name)));
    const top = (values) => {
      const order = values.map((value, at) => ({ value, at })).sort((a, b) => b.value - a.value);
      return { at: order[0]?.at ?? -1, best: order[0]?.value ?? 0, next: order[1]?.value ?? 0 };
    };
    const pairs = [];
    cs.forEach((one, i) => {
      const forCard = top(sim[i]);
      if (forCard.at < 0 || forCard.best < NEAR_FLOOR || forCard.best - forCard.next < NEAR_MARGIN) return;
      const forEntry = top(cs.map((_, c) => sim[c][forCard.at]));
      if (forEntry.at !== i || forEntry.best - forEntry.next < NEAR_MARGIN) return;
      pairs.push([one, es[forCard.at]]);
    });
    for (const [one, entry] of pairs) give(one, entry);
  }
  const left = openCards();                                                      // 5
  if (left.length === 1 && openEntries().length === 1) give(left[0], openEntries()[0]);
  return seats;
}

// The Party entry that describes each card of a four-card run, by seat: [entry | null] in the cards' order, or null
// when the run hasn't exactly four cards (then nothing here applies: callers keep their name rules). Older app builds
// put the Party screen's NAMES on the wrong slots (rotated, swapped, spelt otherwise, left out), while each slot's own
// Party data (lead, level, CP, team) is that seat's; the result screen's cards are right about who sat where
// (cardSeats). So card s takes the one entry whose slot is s - 1, whatever its name. When no entry holds that slot, or
// two do, an entry without a usable slot (not an integer 0-3) may still be the card's by its name: the one such entry of
// the same folded name, else of the same skeleton. Each entry describes one card at most.
export function partyBySeat(players, party = null) {
  const list = parsed(players);
  if (!Array.isArray(list) || list.length !== 4) return null;
  const lineup = parsed(party);
  if (lineupBelongs(list, lineup) === false) return list.map(() => null);    // another lobby's Party: nothing from it
  const entries = (Array.isArray(lineup) ? lineup : []).filter((item) => item && typeof item === "object");
  const usable = (slot) => Number.isInteger(slot) && slot >= 0 && slot <= 3;
  const loose = entries.filter((entry) => !usable(entry.slot));
  const used = new Set();
  const byName = (card, key) => {
    const name = card && typeof card === "object" && typeof card.name === "string" ? key(card.name) : "";
    if (!name) return null;
    const same = loose.filter((entry) => !used.has(entry) && typeof entry.name === "string" && key(entry.name) === name);
    return same.length === 1 ? same[0] : null;
  };
  const out = list.map((card, index) => {
    const held = entries.filter((entry) => entry.slot === index);
    return held.length === 1 ? held[0] : null;
  });
  out.forEach((entry) => { if (entry) used.add(entry); });
  for (const key of [fold, nameSkeleton]) {
    list.forEach((card, index) => {
      if (out[index] || entries.filter((entry) => entry.slot === index).length === 1) return;
      const entry = byName(card, key);
      if (entry) { out[index] = entry; used.add(entry); }
    });
  }
  return out;
}

// Whether a stored lineup is its run's own Party at all. Old app builds sometimes sent the Party of the lobby before
// (stored runs: 12 four-card runs whose lineup had at most one name on the result cards, one with CP on the entries of
// three bot cards' seats); placed by seat, it would put strangers' leads, levels and CP under this run's players. A
// lineup vouches for its run when at least LINEUP_MIN_MATCHES of its named entries have a name (nameSkeleton) found
// among the cards' names: one name alone can be a player who stayed for the next lobby. -> true, false (another
// lobby's), or null when the lineup has no named entry at all (nothing to judge; nothing to show from it either).
export const LINEUP_MIN_MATCHES = 2;
export function lineupBelongs(players, party = null) {
  const list = parsed(players);
  const lineup = parsed(party);
  const key = (item) => (item && typeof item === "object" && typeof item.name === "string" && item.name.trim() ? nameSkeleton(item.name) : "");
  const named = (Array.isArray(lineup) ? lineup : []).map(key).filter(Boolean);
  if (!named.length) return null;
  const cards = new Set((Array.isArray(list) ? list : []).map(key).filter(Boolean));
  return named.filter((name) => cards.has(name)).length >= LINEUP_MIN_MATCHES;
}

// The seat's CP on its card: on a four-card run whose lineup is its own (lineupBelongs true), each card without an
// integer cp of its own takes the integer CP of the Party entry at its own seat (partyBySeat), when that entry has one.
// A bot's Party card has no CP, so a bot's card stays without; a card's own cp is never changed. Both twins of the bot
// rule (slotIsBot and botSql) already call a card with a CP a person, so a bot-named card whose own seat shows CP is a
// person in JS and SQL alike, without either changing. Written when a copy is stored and whenever its players are
// rewritten (corroborateRun); server-only: the public answers leave a card's cp out. -> a new list, or the input.
export function withSeatCp(players, party = null) {
  const list = parsed(players);
  if (!Array.isArray(list) || list.length !== 4) return list;
  const lineup = parsed(party);
  if (lineupBelongs(list, lineup) !== true) return list;
  const found = partyBySeat(list, lineup);
  let changed = false;
  const out = list.map((card, index) => {
    if (!card || typeof card !== "object" || Number.isInteger(card.cp)) return card;
    const cp = found[index]?.cp;
    if (!Number.isInteger(cp) || cp < 0 || cp > 10000000) return card;
    changed = true;
    return { ...card, cp };
  });
  return changed ? out : list;
}

// What a Party entry says about the card on the Party screen (lead, nickname, level, CP, team...): everything but who
// the player is and where they sat, which on a four-card run come from the result screen's cards (lineupBySeat).
const NOT_PARTY_DATA = new Set(["slot", "name", "ai", "self", "unnamed", "avgDps", "fromBattleData", "skel", "uid", "confirmed", "unsettled"]);
// A four-card run's lineup rebuilt by seat: four entries in seat order, entry s = { slot: s - 1, name (card s's, or
// unnamed when the boards keep that name out), ai (the one bot rule), self (only when card s is the shown copy's
// sender), ...the Party data of that seat's entry (partyBySeat) }. Null when the run hasn't exactly four cards. A
// lineup that is another lobby's (lineupBelongs false): the four cards with no slot and no Party data, so the page
// takes nothing from the Party picture either (it is that other lobby's too).
export function lineupBySeat(players, party = null) {
  const list = parsed(players);
  const lineup = parsed(party);
  const found = partyBySeat(list, lineup);
  if (!found) return null;
  const stale = lineupBelongs(list, lineup) === false;
  return list.map((card, index) => {
    const isCard = Boolean(card && typeof card === "object");
    const named = isCard && typeof card.name === "string" && card.name.trim() && card.unsettled !== true;
    const data = Object.fromEntries(Object.entries(found[index] || {}).filter(([key]) => !NOT_PARTY_DATA.has(key)));
    return { ...(stale ? {} : { slot: index }), ...(named ? { name: String(card.name).slice(0, 40) } : { unnamed: true }),
      ai: isCard ? slotIsBot(card, Array.isArray(lineup) ? lineup : null) : false, ...(isCard && card.self === true ? { self: true } : {}), ...data };
  });
}

// The bots of a run, by the same rule: [{ name, seat? }] with each name as the run has it, in the stored players'
// order, and its seat when one is known (cardSeats); [] when there are none. The boards list them on a team row (never
// credited, ranked or counted).
export function botsOf(players, party = null) {
  const list = parsed(players);
  if (!Array.isArray(list)) return [];
  const lineup = parsed(party);
  const seats = cardSeats(list, lineup);
  return list.map((player, index) => ({ player, seat: seats[index] }))
    .filter(({ player }) => player && typeof player === "object" && slotIsBot(player, lineup))
    .map(({ player, seat }) => (seat ? { name: String(player.name), seat } : { name: String(player.name) }));
}

// The same rule in SQL, for a json_each row `slot` of a run `run`'s players_json (the boards' crediting)
export function botSql(slot, run) {
  const name = (value) => `replace(lower(json_extract(${value}, '$.name')), ' ', '')`;
  return `(${name(`${slot}.value`)} IN (${BOT_NAMES.map((bot) => `'${bot}'`).join(", ")})
    AND json_extract(${slot}.value, '$.uid') IS NULL AND COALESCE(json_extract(${slot}.value, '$.self'), 0) = 0
    AND COALESCE(json_extract(${slot}.value, '$.confirmed'), 0) = 0 AND json_extract(${slot}.value, '$.cp') IS NULL
    AND NOT EXISTS (SELECT 1 FROM json_each(${run}.extra_json, '$.lineup') party
      WHERE ${name("party.value")} = ${name(`${slot}.value`)}
        AND (json_extract(party.value, '$.cp') IS NOT NULL OR COALESCE(json_extract(party.value, '$.self'), 0) = 1)))`;
}

// Names that look the same: accents and width forms dropped, lookalike letters folded together (Cyrillic and Greek
// letters to Latin, 0/O, 1/l/I/|, rn/m, vv/w), after Unicode's confusable-skeleton idea (UTS #39). Two characters with
// one skeleton but different UIDs are lookalikes: the boards mark them, and only the UID tells them apart.
const CONFUSABLE_LETTERS = Object.freeze({
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "һ": "h", "ԁ": "d",
  "ӏ": "l", "к": "k", "м": "m", "н": "h", "т": "t", "в": "b", "ɡ": "g", "α": "a", "ο": "o", "ρ": "p", "ν": "v", "τ": "t",
  "κ": "k", "ι": "i", "υ": "u", "χ": "x", "ε": "e", "β": "b", "μ": "u", "0": "o", "1": "l", "|": "l", "!": "l", "5": "s",
  "$": "s", "@": "a", "3": "e", "ø": "o", "ł": "l", "đ": "d", "ß": "ss",
});
export function nameSkeleton(name) {
  const folded = String(name || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  return [...folded].map((letter) => CONFUSABLE_LETTERS[letter] ?? letter).join("")
    .replace(/i/gu, "l").replace(/rn/gu, "m").replace(/vv/gu, "w").replace(/cl/gu, "d")
    .replace(/[\s_.\-·•'`´]/gu, "");
}

