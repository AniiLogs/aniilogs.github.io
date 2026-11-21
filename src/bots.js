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
