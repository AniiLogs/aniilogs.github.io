// Placement links (src/placement-links.js, migration 0037), the Solo / Duo / Trio label and the ?players= filter on
// the Interlink boards, and the share card (src/placement-card.js). Every player here is made up.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync, inflateSync } from "node:zlib";
import test from "node:test";

import worker, { lineupWithCards } from "../src/index.js";
import { cardPlayers, PLACEMENT_LADDERS, TEAM_TAGS } from "../src/placement-links.js";
import { botsOf, cardSeats, lineupSeats, nameSimilarity, NEAR_FLOOR, NEAR_MARGIN, realPlayersOf, slotIsBot } from "../src/bots.js";
import { CARD_ATLAS, CARD_ATLAS_BYTES, CARD_FONTS } from "../src/card-glyphs.js";
import { CARD_HEIGHT, CARD_TITLE_FONTS, CARD_WIDTH, cardTitleFont, drawPlacementCard, packBlocksFor } from "../src/placement-card.js";

const LETTERS = { atlas: CARD_ATLAS, atlasBytes: CARD_ATLAS_BYTES, fonts: CARD_FONTS };

const ORIGIN = "https://aniilogs.github.io";
const API = "https://api.aniilogs.example";
const BOSS = { id: "80000100", name: "Omega Tucking", level: 60 };
const DISCORD_UA = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

async function tokenHash(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Buffer.from(digest).toString("base64url");
}

async function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = resolve(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(resolve(dir, file), "utf8"));
  const statement = (sql, values = []) => ({
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  const DB = {
    prepare(sql) {
      return { ...statement(sql), bind: (...values) => {
        if (values.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${values.length})`);
        return statement(sql, values);
      } };
    },
    async batch(statements) { return Promise.all(statements.map((item) => item.run())); },
  };
  const objects = new Map();
  const EVIDENCE = {
    objects,
    async put(key, body, options) { objects.set(key, { bytes: new Uint8Array(await new Response(body).arrayBuffer()), type: options?.httpMetadata?.contentType }); },
    async get(key) {
      const object = objects.get(key);
      return object ? { body: object.bytes, writeHttpMetadata: (headers) => headers.set("content-type", object.type) } : null;
    },
    async delete(key) { objects.delete(key); },
  };
  const ASSETS = { fetch: async () => new Response("Not found", { status: 404 }) };      // the API root's static files
  const env = { DB, EVIDENCE, ASSETS, PUBLIC_SITE_ORIGIN: ORIGIN, LEADERBOARD_PUBLIC: "true" };
  return { env, sqlite };
}

function call(env, path, { session, token, method = "GET", body, form, ua, origin } = {}) {
  const headers = new Headers();
  if (session) { headers.set("authorization", `Bearer ${session}`); headers.set("origin", ORIGIN); }
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (origin) headers.set("origin", origin);
  if (ua) headers.set("user-agent", ua);
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers.set("content-type", "application/json"); payload = JSON.stringify(body); }
  return worker.fetch(new Request(`${API}${path}`, { method, headers, body: payload }), env);
}

// a made-up player: an account with a desktop token and a linked character
let nextId = 0;
async function player(env, sqlite, name) {
  nextId += 1;
  const discordId = String(400000000000000000n + BigInt(nextId));
  const session = `s${String(nextId).padStart(3, "0")}`.padEnd(48, "x");
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare("INSERT INTO users VALUES (?, ?, ?, NULL, ?, ?)").run(discordId, name.toLowerCase(), name, now, now);
  sqlite.prepare("INSERT INTO profiles (discord_id, display_name, bio, is_public, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)").run(discordId, name, now, now);
  sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(await tokenHash(session), discordId, now, now + 3600);
  const made = await call(env, "/api/leaderboard/tokens", { session, method: "POST", body: { label: "PC" } });
  assert.equal(made.status, 201);
  const { token } = await made.json();
  const gameUid = String(302000000000 + nextId);
  assert.equal((await call(env, "/api/leaderboard/characters", { token, method: "POST", body: { gameUid, name } })).status < 300, true);
  return { name, token, gameUid, discordId };
}

// one run's copy, sent with its proof picture. party: [name, ai?, avgDps]; the sender is marked self
async function send(env, who, id, { score, stars = 30, party, at = 0, clearTimeS = 170, lineup = true }) {
  const players = party.map(([name, ai = false, avgDps]) => ({ name, ai, ...(name === who.name ? { self: true } : {}), ...(avgDps ? { avgDps } : {}) }));
  const body = { kind: "interlink_run", clientRunId: id, cycle: "3005", boss: BOSS, score, stars, clearTimeS, cleared: true, teamDps: 60000,
    gameUid: who.gameUid, playedAt: 1792700000 + at, players,
    extra: Array.isArray(lineup) ? { lineup } : lineup ? { lineup: party.map(([name, ai = false], slot) => ({ slot, name, ai, ...(name === who.name ? { self: true } : {}) })) } : {} };
  const form = new FormData();
  form.set("submission", JSON.stringify(body));
  form.set("evidence", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), "result.jpg");
  const response = await call(env, "/api/leaderboard/submissions", { token: who.token, method: "POST", form });
  assert.ok(response.status === 201 || response.status === 200, `sent ${id}: ${response.status}`);
}
const idOf = (sqlite, clientRunId) => sqlite.prepare("SELECT submission_id AS id FROM leaderboard_submissions WHERE client_run_id = ?").get(clientRunId).id;

// The board: a Solo (place 1), a Duo sent by both its players (2), a full team of four (3), a Trio (4), another Solo (5)
async function board() {
  const { env, sqlite } = await setup();
  const p = {};
  for (const name of ["Aster", "Briar", "Cobalt", "Dorian", "Ember", "Fenwick"]) p[name] = await player(env, sqlite, name);
  await send(env, p.Aster, "solo", { score: 30000, party: [["Aster", false, 30000], ["Flora", true], ["Mario", true], ["Tammy", true]], at: 0 });
  const duo = [["Briar", false, 21000], ["Cobalt", false, 26000], ["Flora", true], ["Mario", true]];
  await send(env, p.Briar, "duo-b", { score: 25000, party: duo, at: 600 });
  await send(env, p.Cobalt, "duo-c", { score: 25000, party: duo, at: 610 });
  await send(env, p.Dorian, "four", { score: 20000, party: [["Dorian", false, 9000], ["Quill", false], ["Rowan", false], ["Sorrel", false]], at: 1200 });
  await send(env, p.Ember, "trio", { score: 15000, party: [["Ember", false, 7000], ["Tansy", false], ["Umber", false], ["Flora", true]], at: 1800 });
  await send(env, p.Fenwick, "solo-2", { score: 10000, party: [["Fenwick", false, 6000], ["Flora", true], ["Mario", true], ["Tammy", true]], at: 2400 });
  return { env, sqlite, p };
}
const interlink = async (env, query) => (await (await call(env, `/api/leaderboard/interlink?cycle=3005&boss=${BOSS.id}&${query}`)).json()).bosses[0];
const createLink = (env, body, origin = ORIGIN) => call(env, "/api/links", { method: "POST", body, origin });

test("the label rule: four real players none, three Trio, two Duo, one Solo; no bots, no label", () => {
  const person = (name) => ({ name, ai: false });
  const bot = (name) => ({ name, ai: true });
  assert.equal(realPlayersOf([person("Aster"), person("Briar"), person("Cobalt"), person("Dorian")]), null);
  assert.equal(realPlayersOf([person("Aster"), person("Briar"), person("Cobalt"), bot("Flora")]), 3);
  assert.equal(realPlayersOf(JSON.stringify([person("Aster"), person("Briar"), bot("Mario"), bot("Tammy")])), 2);
  assert.equal(realPlayersOf([person("Aster"), bot("Flora"), bot("Mario"), bot("Leonard")]), 1);
  assert.equal(realPlayersOf([person("Aster"), person("Briar")]), null);                 // nothing says bots were there
  assert.equal(realPlayersOf(null), null);
  assert.deepEqual([TEAM_TAGS[1], TEAM_TAGS[2], TEAM_TAGS[3]], ["Solo", "Duo", "Trio"]);
});

test("the bots of a run: their names as stored, in the stored order, by the one bot rule, with the Party screen's seat; none: an empty list", () => {
  const person = (name) => ({ name, ai: false });
  const bot = (name) => ({ name, ai: true });
  assert.deepEqual(botsOf([person("Aster"), bot("Flora"), bot("Mario"), bot("Leonard")]), [{ name: "Flora", seat: 2 }, { name: "Mario", seat: 3 }, { name: "Leonard", seat: 4 }]);   // four cards: by position
  assert.deepEqual(botsOf(JSON.stringify([bot("Tammy"), person("Aster"), bot("flora")])), [{ name: "Tammy" }, { name: "flora" }]);   // stored spelling
  assert.deepEqual(botsOf([person("Aster"), person("Briar"), person("Cobalt"), person("Dorian")]), []);
  // a real player who has a bot's name: a CP (on the slot or its Party card), a UID or an account says person
  assert.deepEqual(botsOf([person("Aster"), { name: "Leonard", ai: true, cp: 1840 }, bot("Mario")]), [{ name: "Mario" }]);
  assert.deepEqual(botsOf([person("Aster"), bot("Leonard"), bot("Mario")], [{ name: "Leonard", cp: 1840 }]), [{ name: "Mario" }]);
  assert.deepEqual(botsOf([{ name: "Flora", uid: "302000000777" }, bot("Tammy")]), [{ name: "Tammy" }]);
  assert.deepEqual(botsOf(null), []);
  assert.deepEqual(botsOf("not json"), []);
  // seats (cardSeats): four cards are the result screen's columns, 1P-4P in order, whatever the Party screen says
  const party = [{ slot: 0, name: "Aster" }, { slot: 2, name: "Flora" }, { slot: 1, name: "mario" }, { slot: 3, name: "Leonard" }];   // as aLogs stores it: 0-3
  assert.deepEqual(botsOf([person("Aster"), bot("Flora"), bot("Mario"), bot("Leonard")], party),
    [{ name: "Flora", seat: 2 }, { name: "Mario", seat: 3 }, { name: "Leonard", seat: 4 }]);
  // fewer cards: the Party screen's slot of the same name
  assert.deepEqual(botsOf([person("Aster"), bot("Flora"), bot("Mario")], party), [{ name: "Flora", seat: 3 }, { name: "Mario", seat: 2 }]);
  assert.deepEqual([...lineupSeats([{ slot: 0, name: "Aster" }, { slot: 1, name: "Aster" }, { slot: 9, name: "Briar" }, { name: "Cobalt" }])], []);
  // the stored slots 0-3 are the game's 1P-4P, in that order; a slot of 4 (or -1) is no seat
  assert.deepEqual([...lineupSeats([{ slot: 0, name: "Aster" }, { slot: 1, name: "Briar" }, { slot: 2, name: "Cobalt" }, { slot: 3, name: "Dorian" }])],
    [["aster", 1], ["briar", 2], ["cobalt", 3], ["dorian", 4]]);
  assert.deepEqual([...lineupSeats([{ slot: 4, name: "Ember" }, { slot: -1, name: "Fenwick" }])], []);
});

test("board rows list their run's bots: a Solo three, a Duo two, a Trio one, a full team none; places and counts unchanged", async () => {
  const { env } = await board();
  const all = await interlink(env, "ladder=score&rows=teams");
  const names = (bots) => (bots ? bots.map((bot) => bot.name) : null);
  assert.deepEqual(all.entries.map((e) => [e.player, e.rank, names(e.bots)]),
    [["Aster", 1, ["Flora", "Mario", "Tammy"]], ["Cobalt", 2, ["Flora", "Mario"]], ["Briar", 2, ["Flora", "Mario"]],
      ["Dorian", 3, null], ["Ember", 4, ["Flora"]], ["Fenwick", 5, ["Flora", "Mario", "Tammy"]]]);
  assert.ok(!("bots" in all.entries[3]));                                    // a full team: no bots key at all
  assert.deepEqual([all.teams, all.total], [5, 6]);                         // bots are never ranked or counted
  // Players view rows carry it too
  const players = await interlink(env, "ladder=score");
  assert.deepEqual(names(players.entries.find((e) => e.player === "Ember").bots), ["Flora"]);
});

test("seats: each row's place on its run's Party screen; a Solo's player and its three bots; a full team; none without a lineup", async () => {
  const { env, sqlite } = await board();
  const all = await interlink(env, "ladder=score&rows=teams&unlinked=1");
  const of = (name) => all.entries.find((e) => e.player === name);
  // the Solo: Aster in seat 1, the bots in seats 2-4
  assert.equal(of("Aster").seat, 1);
  assert.deepEqual(of("Aster").bots, [{ name: "Flora", seat: 2 }, { name: "Mario", seat: 3 }, { name: "Tammy", seat: 4 }]);
  // the Duo sent by both: Briar 1, Cobalt 2, its bots 3 and 4
  assert.deepEqual([of("Briar").seat, of("Cobalt").seat], [1, 2]);
  assert.deepEqual(of("Briar").bots, [{ name: "Flora", seat: 3 }, { name: "Mario", seat: 4 }]);
  // the full team: the sender and the three teammates the boards list, each in their seat
  const team = all.entries.filter((e) => e.team === of("Dorian").team);
  assert.deepEqual(team.map((e) => [e.player, e.seat]).sort(), [["Dorian", 1], ["Quill", 2], ["Rowan", 3], ["Sorrel", 4]]);
  // a four-card run sent without a Party screen: the result screen's columns still give every seat
  const p = await player(env, sqlite, "Gorse");
  await send(env, p, "no-lineup", { score: 9000, party: [["Gorse", false, 5000], ["Flora", true], ["Mario", true], ["Tammy", true]], at: 3000, lineup: false });
  const later = await interlink(env, "ladder=score&rows=teams");
  const gorse = later.entries.find((e) => e.player === "Gorse");
  assert.equal(gorse.seat, 1);
  assert.deepEqual(gorse.bots, [{ name: "Flora", seat: 2 }, { name: "Mario", seat: 3 }, { name: "Tammy", seat: 4 }]);
  // three cards and no Party screen: no seat anywhere
  const q = await player(env, sqlite, "Hollis");
  await send(env, q, "three-no-lineup", { score: 8000, party: [["Hollis", false, 5000], ["Flora", true], ["Mario", true]], at: 3600, lineup: false });
  const hollis = (await interlink(env, "ladder=score&rows=teams")).entries.find((e) => e.player === "Hollis");
  assert.ok(!("seat" in hollis));
  assert.deepEqual(hollis.bots, [{ name: "Flora" }, { name: "Mario" }]);
});

test("cardSeats: four cards are seats 1-4 by position; fewer fall back to the Party screen, step by step; never a guess", () => {
  const card = (name, more = {}) => ({ name, ...more });
  const entry = (slot, name, more = {}) => ({ slot, name, ...more });
  // four cards: by position, the lineup not asked (it disagrees here, has a gap, or is missing)
  assert.deepEqual(cardSeats([card("Aster"), card("Briar"), card("Cobalt"), card("Dorian")],
    [entry(0, "Briar"), entry(1, "Aster"), entry(2, "Cobalt"), entry(3, "Dorian")]), [1, 2, 3, 4]);
  assert.deepEqual(cardSeats([card("Aster"), card("Briar"), card("Cobalt"), card("Dorian")]), [1, 2, 3, 4]);
  // the owner's shapes: the sender's one-letter name, missing from the lineup, sits 2nd; a first card the lineup names otherwise
  assert.deepEqual(cardSeats([card("Aster"), card("Q", { self: true }), card("Cobalt"), card("Dorian")],
    [entry(0, "Aster"), entry(2, "Cobalt"), entry(3, "Dorian")]), [1, 2, 3, 4]);
  assert.deepEqual(cardSeats([card("Aster"), card("Briar"), card("Cobalt"), card("Dorian")],
    [entry(0, "Wexley"), entry(1, "Briar"), entry(2, "Cobalt"), entry(3, "Dorian")]), [1, 2, 3, 4]);
  // a column that isn't a card still counts as a position; five cards: no seats
  assert.deepEqual(cardSeats([card("Aster"), null, card("Cobalt"), card("Dorian")]), [1, null, 3, 4]);
  assert.deepEqual(cardSeats([card("A"), card("B"), card("C"), card("D"), card("E")], [entry(0, "A")]), [null, null, null, null, null]);
  // three cards: 1. exact names (case and spaces folded), as before
  assert.deepEqual(cardSeats([card("Aster"), card("briar"), card("Co balt")], [entry(2, "Aster"), entry(0, "Briar"), entry(3, "Cobalt")]), [3, 1, 4]);
  // A: the sender's own entry is missing: the one card left takes the one entry left
  assert.deepEqual(cardSeats([card("Aster"), card("Q", { self: true }), card("Cobalt")], [entry(0, "Aster"), entry(1, "Wexley"), entry(3, "Cobalt")]), [1, 2, 4]);
  // B: one entry carries another name altogether: elimination
  assert.deepEqual(cardSeats([card("Aster"), card("Briar"), card("Cobalt")], [entry(0, "Wexley"), entry(2, "Briar"), entry(3, "Cobalt")]), [1, 3, 4]);
  // 2. the self card with the self entry, whatever the names
  assert.deepEqual(cardSeats([card("Aster", { self: true }), card("Briar"), card("Cobalt")],
    [entry(1, "Wren", { self: true }), entry(0, "Wexley"), entry(2, "Yarrow")]), [2, null, null]);
  // 3. look-alike letters (skeleton); C: a near miss, then the last card by elimination
  assert.deepEqual(cardSeats([card("Briar"), card("Rowan")], [entry(3, "Brlar"), entry(1, "Rovvan")]), [4, 2]);
  assert.deepEqual(cardSeats([card("Aster"), card("Marigold"), card("Q", { self: true })],
    [entry(0, "Aster"), entry(1, "Marlgoxd"), entry(3, "Thorne")]), [1, 2, 4]);
  // duplicate names: nobody at that step; two cards left with two entries: nobody guessed
  assert.deepEqual(cardSeats([card("Aster"), card("Aster"), card("Cobalt")], [entry(0, "Aster"), entry(1, "Aster"), entry(2, "Cobalt")]), [null, null, 3]);
  assert.deepEqual(cardSeats([card("Aster"), card("Briar"), card("Cobalt")], [entry(0, "Wexley"), entry(1, "Yarrow"), entry(2, "Cobalt")]), [null, null, 3]);
  // one card left but no entry left: no guess by free seat
  assert.deepEqual(cardSeats([card("Aster"), card("Briar"), card("Cobalt")], [entry(0, "Aster"), entry(1, "Briar")]), [1, 2, null]);
  // bots match like anyone; slots outside 0-3, not integers, or read twice are ignored
  assert.deepEqual(cardSeats([card("Aster"), card("Flora", { ai: true }), card("Mario", { ai: true })],
    [entry(0, "Aster"), entry(3, "Flora"), entry(2, "Mario")]), [1, 4, 3]);
  assert.deepEqual(cardSeats([card("Aster"), card("Briar")], [entry(4, "Aster"), entry(1.5, "Briar")]), [null, null]);
  assert.deepEqual(cardSeats([card("Aster"), card("Briar")], [entry(0, "Aster"), entry(0, "Briar")]), [null, null]);
  // garbage
  assert.deepEqual(cardSeats(null, null), []);
  assert.deepEqual(cardSeats("not json", "[]"), []);
  assert.deepEqual(cardSeats(JSON.stringify([card("Aster"), "x"]), JSON.stringify([entry(2, "Aster")])), [3, null]);
  assert.deepEqual(cardSeats([card("Aster")], "not json"), [null]);
});

test("cardSeats near names: one or two letters off matches, an unrelated name or a tie doesn't", () => {
  assert.deepEqual([NEAR_FLOOR, NEAR_MARGIN], [0.75, 0.2]);
  assert.equal(nameSimilarity("Thistle", "Thistle"), 1);
  assert.equal(nameSimilarity("Dorian", "Dorlan"), 1);                    // i and l read alike (skeleton)
  assert.equal(nameSimilarity("Marigold", "Marigoxd"), 0.875);
  assert.equal(nameSimilarity("", "Aster"), 0);
  // two cards (one a stranger), entries: the names given, then a stranger's in slot 3
  const near = (cards, ...names) => cardSeats(cards.map((name) => ({ name })),
    names.map((name, slot) => ({ slot, name })).concat([{ slot: 3, name: "Kkkkkkkk" }]));
  assert.deepEqual(near(["Marigold", "Zzzzzzzz"], "Marigoxd"), [1, 4]);              // one off in eight: 0.875
  assert.deepEqual(near(["Aster", "Zzzzzzzz"], "Mabel"), [null, null]);              // an unrelated name
  assert.deepEqual(near(["Thistle", "Zzzzzzzz"], "Thixtxe"), [null, null]);          // two off in seven: 0.71, under the floor
  assert.deepEqual(near(["Marigold", "Zzzzzzzz"], "Marigoxd", "Marigoyd"), [null, null]);   // a tie between two entries
  // the entry's next-best card too close (0.875 against 0.75): no match
  assert.deepEqual(near(["Marigold", "Marigolf"], "Marigoxd"), [null, null]);
});

test("also on this run: a player whose best is another run gets their seat on this one and this run's own figures", async () => {
  const { env, sqlite } = await setup();
  const p = {};
  for (const name of ["Aster", "Briar"]) p[name] = await player(env, sqlite, name);
  // Aster's best is a Solo; Aster also played (seat 3) on Briar's lower run, with 12,000 Avg DPS there
  await send(env, p.Aster, "aster-best", { score: 30000, party: [["Aster", false, 30000], ["Flora", true], ["Mario", true], ["Tammy", true]], at: 0 });
  const shared = [["Briar", false, 20000], ["Mario", true], ["Aster", false, 12000], ["Flora", true]];
  await send(env, p.Briar, "briar-run", { score: 20000, party: shared, at: 600 });
  await send(env, p.Aster, "aster-copy", { score: 20000, party: shared, at: 610 });
  const all = await interlink(env, "ladder=score&rows=teams");
  const briar = all.entries.find((e) => e.player === "Briar");
  assert.deepEqual(briar.also?.map((a) => [a.player, a.rank, a.seat, a.avgDps ?? null]), [["Aster", 1, 3, 12000]]);
  assert.equal(briar.seat, 1);
  assert.deepEqual(briar.bots, [{ name: "Mario", seat: 2 }, { name: "Flora", seat: 4 }]);
  // a linked team-mate whose best is another run is in also only, never in unlinked; bots never are
  assert.equal("unlinked" in briar, false);
  assert.equal(all.entries.some((e) => "unlinked" in e), false);
});

test("board seats follow the result screen's columns on a four-card run, the Party screen on fewer: rows, also, unlinked and bots", async () => {
  const { env, sqlite } = await setup();
  const p = {};
  for (const name of ["Aster", "Briar", "Dorian", "Ember"]) p[name] = await player(env, sqlite, name);
  await send(env, p.Aster, "aster-best", { score: 30000, party: [["Aster", false, 30000], ["Flora", true], ["Mario", true], ["Tammy", true]], at: 0 });
  // A: Briar's Party read lost the one-letter name in seat 2 and put Aster and Flora on each other's slots
  const shared = [["Briar", false, 20000], ["Z", false, 5000], ["Aster", false, 12000], ["Flora", true]];
  await send(env, p.Briar, "briar-run", { score: 20000, party: shared, at: 600,
    lineup: [{ slot: 0, name: "Briar", self: true }, { slot: 3, name: "Aster" }, { slot: 2, name: "Flora", ai: true }] });
  await send(env, p.Aster, "aster-copy", { score: 20000, party: shared, at: 610 });
  // B: the first seat's Party name is another name altogether
  await send(env, p.Dorian, "dorian-run", { score: 15000, party: [["Dorian", false, 9000], ["Quill", false, 8000], ["Rowan", false, 7000], ["Sorrel", false, 6000]],
    at: 1200, lineup: [{ slot: 0, name: "Wexley" }, { slot: 1, name: "Quill" }, { slot: 2, name: "Rowan" }, { slot: 3, name: "Sorrel" }] });
  // three cards (a column wasn't read): the Party screen decides, a near name included
  await send(env, p.Ember, "ember-run", { score: 10000, party: [["Ember", false, 7000], ["Tansy", false, 3000], ["Flora", true]],
    at: 1800, lineup: [{ slot: 1, name: "Ember", self: true }, { slot: 0, name: "Tamsy" }, { slot: 3, name: "Flora", ai: true }] });
  const all = await interlink(env, "ladder=score&rows=teams");
  const of = (name) => all.entries.find((e) => e.player === name);
  const lines = (list) => (list || []).map((item) => [item.player ?? item.name, item.seat ?? null]);
  assert.equal(of("Briar").seat, 1);
  assert.deepEqual(lines(of("Briar").also), [["Aster", 3]]);
  assert.deepEqual(lines(of("Briar").unlinked), [["Z", 2]]);
  assert.deepEqual(lines(of("Briar").bots), [["Flora", 4]]);
  assert.equal(of("Dorian").seat, 1);
  assert.deepEqual(lines(of("Dorian").unlinked), [["Quill", 2], ["Rowan", 3], ["Sorrel", 4]]);
  assert.equal(of("Ember").seat, 2);
  assert.deepEqual(lines(of("Ember").unlinked), [["Tamsy", 1]]);              // the name as the settle rules gave it
  assert.deepEqual(lines(of("Ember").bots), [["Flora", 4]]);
  // Show unlinked: the unclaimed rows take the same seats
  const every = await interlink(env, "ladder=score&rows=teams&unlinked=1");
  assert.deepEqual(every.entries.filter((e) => ["Z", "Quill", "Tamsy"].includes(e.player)).map((e) => [e.player, e.seat ?? null]).sort(),
    [["Quill", 2], ["Tamsy", 1], ["Z", 2]]);
});

// A team row lists every team-mate of its run (the owner, 22 Nov): in the Teams view without Show unlinked, the players
// known only by their name are on the row's first entry as `unlinked`, unranked, with their seat and this run's figures.
async function unlinkedTeam() {
  const { env, sqlite } = await setup();
  const p = {};
  for (const name of ["Aster", "Briar", "Cobalt"]) p[name] = await player(env, sqlite, name);
  // a four-player run sent by one linked player, with three bare names (Sorrel's card had no Avg DPS)
  await send(env, p.Aster, "four", { score: 30000, party: [["Aster", false, 9000], ["Quill", false, 8000], ["Rowan", false, 7000], ["Sorrel", false]], at: 0 });
  // a lower, fully linked team: Briar and Cobalt both sent it, with two bots
  const duo = [["Briar", false, 21000], ["Cobalt", false, 26000], ["Flora", true], ["Mario", true]];
  await send(env, p.Briar, "duo-b", { score: 25000, party: duo, at: 600 });
  await send(env, p.Cobalt, "duo-c", { score: 25000, party: duo, at: 610 });
  return { env, sqlite, p };
}

test("team rows list their unlinked team-mates: seats and this run's figures, unranked; ranks, teams and the Players view unchanged", async () => {
  const { env } = await unlinkedTeam();
  const teams = await interlink(env, "ladder=score&rows=teams");
  const aster = teams.entries.find((e) => e.player === "Aster");
  assert.deepEqual(aster.unlinked, [{ player: "Quill", seat: 2, avgDps: 8000 }, { player: "Rowan", seat: 3, avgDps: 7000 }, { player: "Sorrel", seat: 4 }]);
  // nothing that ranks, links or names an account
  for (const item of aster.unlinked) for (const field of ["rank", "team", "profileId", "uid", "discordName", "unclaimed", "own"]) assert.equal(field in item, false, field);
  // only the row's first entry carries it; the fully linked team (two bots) has none
  assert.equal(teams.entries.filter((e) => "unlinked" in e).length, 1);
  assert.deepEqual(teams.entries.map((e) => [e.player, e.rank, e.team]), [["Aster", 1, 1], ["Cobalt", 2, 2], ["Briar", 2, 2]]);
  assert.deepEqual([teams.teams, teams.total], [2, 3]);
  // the Players view: as before, no list
  const players = await interlink(env, "ladder=score");
  assert.equal(players.entries.some((e) => "unlinked" in e), false);
  assert.deepEqual(players.entries.map((e) => [e.player, e.rank]).sort(), [["Aster", 1], ["Briar", 2], ["Cobalt", 2]]);
  // Show unlinked: the three are ranked entries as today, and there is no list
  const every = await interlink(env, "ladder=score&rows=teams&unlinked=1");
  assert.equal(every.entries.some((e) => "unlinked" in e), false);
  assert.deepEqual(every.entries.filter((e) => e.team === 1).map((e) => [e.player, e.rank, e.unclaimed]).sort(),
    [["Aster", 1, false], ["Quill", 1, true], ["Rowan", 1, true], ["Sorrel", 1, true]]);
  // the Solo / Duo / Trio filter is about bots: the four-player run is still the only full team, with its list
  const full = await interlink(env, "ladder=score&rows=teams&players=4");
  assert.deepEqual(full.entries.map((e) => [e.player, e.unlinked?.length]), [["Aster", 3]]);
  // a one-player ladder never has one
  const dps = await interlink(env, "ladder=dps&rows=teams");
  assert.equal(dps.entries.some((e) => "unlinked" in e), false);
  // no account data in the answer that wasn't there: the names' UIDs and profiles never appear for them
  const text = JSON.stringify(teams);
  assert.equal((text.match(/"uid"/gu) || []).length, teams.entries.length);
});

test("team rows' unlinked: a name no copy agrees on (unsettled) is listed without it, in its seat; the order is by seat", async () => {
  const { env, sqlite } = await unlinkedTeam();
  // as settledRun stores it: the slot keeps its read and is marked unsettled
  const row = sqlite.prepare("SELECT submission_id AS id, players_json AS players FROM leaderboard_submissions WHERE client_run_id = 'four'").get();
  const stored = JSON.parse(row.players).map((slot) => (slot.name === "Rowan" ? { ...slot, unsettled: true } : slot));
  sqlite.prepare("UPDATE leaderboard_submissions SET players_json = ? WHERE submission_id = ?").run(JSON.stringify(stored), row.id);
  const teams = await interlink(env, "ladder=score&rows=teams");
  assert.deepEqual(teams.entries.find((e) => e.player === "Aster").unlinked,
    [{ player: "Quill", seat: 2, avgDps: 8000 }, { player: null, seat: 3 }, { player: "Sorrel", seat: 4 }]);
  assert.equal(JSON.stringify(teams).includes("Rowan"), false);
});

test("?order=submitted lists rows newest first (a team row by its first copy), places kept; submitted_asc oldest first; pages that order", async () => {
  const { env, sqlite } = await board();
  sqlite.exec("UPDATE leaderboard_submissions SET created_at = played_at");     // each copy reached the site when it was played
  const newest = await interlink(env, "ladder=score&rows=teams&order=submitted");
  assert.deepEqual(newest.entries.map((e) => [e.player, e.rank]),
    [["Fenwick", 5], ["Ember", 4], ["Dorian", 3], ["Cobalt", 2], ["Briar", 2], ["Aster", 1]]);
  const oldest = await interlink(env, "ladder=score&rows=teams&order=submitted_asc");
  assert.deepEqual(oldest.entries.map((e) => e.player), ["Aster", "Cobalt", "Briar", "Dorian", "Ember", "Fenwick"]);
  const page = await interlink(env, "ladder=score&rows=teams&order=submitted&limit=2&offset=1");
  assert.deepEqual(page.entries.map((e) => [e.player, e.rank]), [["Ember", 4], ["Dorian", 3]]);
  const players = await interlink(env, "ladder=score&order=submitted&limit=2");
  assert.deepEqual(players.entries.map((e) => [e.player, e.rank]), [["Fenwick", 5], ["Ember", 4]]);
  const answer = await (await call(env, `/api/leaderboard/interlink?cycle=3005&boss=${BOSS.id}&ladder=score&order=submitted`)).json();
  assert.equal(answer.order, "submitted");
});

test("board rows carry the label; ?players= hides rows but every row keeps its overall place, and pages what's left", async () => {
  const { env } = await board();
  const all = await interlink(env, "ladder=score&rows=teams");
  assert.deepEqual(all.entries.map((e) => [e.player, e.rank, e.realPlayers ?? 4]),
    [["Aster", 1, 1], ["Cobalt", 2, 2], ["Briar", 2, 2], ["Dorian", 3, 4], ["Ember", 4, 3], ["Fenwick", 5, 1]]);
  assert.deepEqual([all.teams, all.total], [5, 6]);
  const duos = await interlink(env, "ladder=score&rows=teams&players=2");
  assert.deepEqual(duos.entries.map((e) => [e.player, e.rank]), [["Cobalt", 2], ["Briar", 2]]);
  assert.deepEqual([duos.teams, duos.total], [1, 2]);
  const solos = await interlink(env, "ladder=score&rows=teams&players=1");
  assert.deepEqual(solos.entries.map((e) => e.rank), [1, 5]);              // 1, 5: the places on the whole ladder
  const second = await interlink(env, "ladder=score&rows=teams&players=1&limit=1&offset=1");
  assert.deepEqual(second.entries.map((e) => [e.player, e.rank]), [["Fenwick", 5]]);
  assert.equal(second.teams, 2);                                              // "View all" counts what the filter leaves
  const four = await interlink(env, "ladder=score&players=4");
  assert.deepEqual(four.entries.map((e) => [e.player, e.rank]), [["Dorian", 3]]);
  // Players view and a one-player ladder filter the same way
  const dps = await interlink(env, "ladder=dps&players=1");
  assert.deepEqual(dps.entries.map((e) => [e.player, e.rank]), [["Aster", 1], ["Fenwick", 6]]);
  // no filter: the answer is as before
  assert.equal((await interlink(env, "ladder=score&players=7")).total, 6);
});

test("links: the same placement gives one code, from either copy of the run; a run not on a board gets none", async () => {
  const { env, sqlite } = await board();
  const first = await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "score" });
  assert.equal(first.status, 200);
  const { code, url } = await first.json();
  assert.match(code, /^[23456789abcdefghjkmnpqrstuvwxyz]{5}$/u);
  assert.equal(url, `${API}/${code}`);
  assert.equal((await (await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "score" })).json()).code, code);
  assert.equal((await (await createLink(env, { run: idOf(sqlite, "duo-c"), ladder: "score" })).json()).code, code);
  // another ladder is another placement
  const clear = (await (await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "clear" })).json()).code;
  assert.notEqual(clear, code);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM placement_links").get().n, 2);
  // a one-player ladder: one link per player of the run
  const briar = (await (await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "dps", player: "Briar" })).json()).code;
  const cobalt = (await (await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "dps", player: "cobalt" })).json()).code;
  assert.notEqual(briar, cobalt);
  assert.equal((await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "dps" })).status, 400);
  assert.equal((await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "dps", player: "Nobody" })).status, 404);
  // not on a board: unknown, hidden, or a teammate's name the default board leaves out
  assert.equal((await createLink(env, { run: "unknownrun123", ladder: "score" })).status, 404);
  sqlite.prepare("UPDATE leaderboard_submissions SET status = 'hidden' WHERE client_run_id = 'trio'").run();
  assert.equal((await createLink(env, { run: idOf(sqlite, "trio"), ladder: "score" })).status, 404);
  assert.equal((await createLink(env, { run: idOf(sqlite, "four"), ladder: "dps", player: "Quill" })).status, 404);
  // bad input and other sites
  assert.equal((await createLink(env, { run: "../x", ladder: "score" })).status, 400);
  assert.equal((await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "taken" })).status, 400);
  assert.equal((await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "score" }, "https://elsewhere.example")).status, 403);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM placement_links").get().n, 4);
});

test("a link on a two-boss Center: the preview and the card name both bosses; a run that timed out at 3:00 says so", async () => {
  const { env, sqlite } = await setup();
  const now = Math.floor(Date.now() / 1000);
  const bosses = [{ id: "80000109", name: "Omega Sherro" }, { id: "80000120", name: "Alpha Blazen", second: { id: "80000119", name: "Omega Tucking" } }, { id: "80000101", name: "Alpha Bouldus" }];
  sqlite.prepare("INSERT INTO interlink_cycles (id, season, start_at, end_at, bosses_json, updated_by, updated_at) VALUES ('4003', 1, ?, ?, ?, 'x', ?)")
    .run(now - 86400, now + 86400 * 5, JSON.stringify(bosses), now);
  const who = await player(env, sqlite, "Larkspur");
  const party = [["Larkspur", false, 30000], ["Flora", true], ["Mario", true], ["Tammy", true]];
  const body = { kind: "interlink_run", clientRunId: "pair", cycle: "4003", boss: { id: "80000120", name: "Alpha Blazen", level: 60 }, score: 52000, stars: 40,
    clearTimeS: 180, cleared: false, teamDps: 60000, gameUid: who.gameUid, playedAt: now - 600,
    players: party.map(([name, ai, avgDps]) => ({ name, ai, ...(name === who.name ? { self: true } : {}), ...(avgDps ? { avgDps } : {}) })),
    extra: { lineup: party.map(([name, ai], slot) => ({ slot: slot + 1, name, ai, ...(name === who.name ? { self: true } : {}) })) } };
  const form = new FormData();
  form.set("submission", JSON.stringify(body));
  form.set("evidence", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), "result.jpg");
  assert.equal((await call(env, "/api/leaderboard/submissions", { token: who.token, method: "POST", form })).status, 201);
  const { code } = await (await createLink(env, { run: idOf(sqlite, "pair"), ladder: "score" })).json();
  const html = await (await call(env, `/${code}`, { ua: DISCORD_UA })).text();
  const tag = (property) => html.match(new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)">`, "u"))?.[1];
  assert.match(tag("og:title"), /^#1 on Score · Alpha Blazen \+ Omega Tucking · Week of /u);
  assert.match(tag("og:description"), /Timed Out: 3:00\. .*Holo-Battle Interlink, Center boss\.$/u);
  // a person lands on that board, which names both bosses too
  const person = await call(env, `/${code}`, { ua: BROWSER_UA });
  const to = new URL(person.headers.get("location"));
  assert.deepEqual([to.searchParams.get("week"), to.searchParams.get("boss")], ["4003", "80000120"]);
  const landed = (await (await call(env, `/api/leaderboard/interlink?cycle=4003&boss=80000120`)).json()).bosses[0];
  assert.deepEqual([landed.name, landed.second?.name], ["Alpha Blazen", "Omega Tucking"]);
});

test("opening a link: a crawler gets the preview tags with the overall place; a person goes to the boards with the run open", async () => {
  const { env, sqlite } = await board();
  const duo = idOf(sqlite, "duo-c");
  const { code } = await (await createLink(env, { run: duo, ladder: "score" })).json();
  const page = await call(env, `/${code}`, { ua: DISCORD_UA });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/u);
  const html = await page.text();
  const tag = (property) => html.match(new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)">`, "u"))?.[1];
  assert.equal(tag("og:site_name"), "AniiLogs");
  assert.match(tag("og:title"), /^#2 on Score · Omega Tucking · Week of [A-Z][a-z]{2} \d{1,2} – [A-Z][a-z]{2} \d{1,2}$/u);
  assert.match(html, /<title>#2 on Score · Omega Tucking · .* · AniiLogs<\/title>/u);
  assert.equal(tag("og:description"), "Cobalt, Briar, Flora (AI) and Mario (AI): 25,000 with 30 stars. Duo: two players and two bots. Boss Killed: 2:50. Team DPS 60,000. Holo-Battle Interlink, Right boss.");
  assert.equal(tag("og:url"), `${API}/${code}`);
  assert.equal(tag("twitter:card"), "summary_large_image");
  assert.equal(tag("theme-color"), "#f5eecb");
  assert.match(tag("og:image"), new RegExp(`^${API}/api/links/${code}\\.png\\?p=2&amp;v=[0-9a-f]{16}$`, "u"));
  assert.equal(tag("og:image:width"), "1200");
  assert.equal(tag("og:image:height"), "630");
  // a person
  const person = await call(env, `/${code}`, { ua: BROWSER_UA });
  assert.equal(person.status, 302);
  const target = new URL(person.headers.get("location"));
  assert.equal(target.origin + target.pathname, `${ORIGIN}/leaderboard/`);
  assert.equal(target.searchParams.get("run"), duo);
  assert.equal(target.searchParams.get("ladder"), "score");
  assert.equal(target.searchParams.get("week"), "3005");
  assert.equal(target.searchParams.get("boss"), BOSS.id);
  assert.equal(target.searchParams.get("rows"), "teams");
  assert.equal(target.searchParams.get("link"), code);
  assert.equal(target.searchParams.has("offset"), false);
  // the place is the overall one, read when the link is opened: a better run sent later moves this one down
  const gale = await player(env, sqlite, "Gale");
  await send(env, gale, "better", { score: 40000, party: [["Gale", false, 40000], ["Flora", true], ["Mario", true], ["Tammy", true]], at: 3000 });
  const later = await (await call(env, `/${code}`, { ua: DISCORD_UA })).text();
  assert.match(later, /<meta property="og:title" content="#3 on Score/u);
  assert.match(later, /\.png\?p=3&amp;v=/u);
});

test("opening a link: an unknown code, a run gone from the boards and a malformed path", async () => {
  const { env, sqlite } = await board();
  const { code } = await (await createLink(env, { run: idOf(sqlite, "trio"), ladder: "score" })).json();
  for (const ua of [DISCORD_UA, BROWSER_UA]) {
    const unknown = await call(env, "/zzzzz", { ua });
    assert.equal(unknown.status, 404);
    const text = await unknown.text();
    assert.match(text, /This run isn't available/u);
    assert.match(text, /href="https:\/\/aniilogs\.github\.io\/leaderboard\/"/u);
    assert.doesNotMatch(text, /error|exception|stack/iu);
  }
  sqlite.prepare("UPDATE leaderboard_submissions SET status = 'hidden' WHERE client_run_id = 'trio'").run();
  assert.equal((await call(env, `/${code}`, { ua: BROWSER_UA })).status, 404);
  assert.equal((await call(env, `/api/links/${code}.png`)).status, 404);
  // look-alike letters and wrong lengths are never looked up; they aren't links
  for (const path of ["/abcd0", "/ABCDE", "/abcdef", "/a'b\"c"]) {
    const response = await call(env, path, { ua: DISCORD_UA }).catch(() => null);
    assert.ok(!response || response.status !== 200 || !(await response.text()).includes("og:title"), path);
  }
});

test("the crawler page escapes everything it writes", async () => {
  const { env, sqlite } = await setup();
  const odd = await player(env, sqlite, "Tom&Jerry");
  await send(env, odd, "odd", { score: 12000, party: [["Tom&Jerry", false, 5000], ["Flora", true], ["Mario", true], ["Tammy", true]] });
  sqlite.prepare("UPDATE game_characters SET character_name = ? WHERE character_name = 'Tom&Jerry'").run(`<script>alert("x")</script>'`);
  sqlite.prepare("UPDATE leaderboard_submissions SET extra_json = json_set(extra_json, '$.lineup[0].name', ?1), players_json = json_set(players_json, '$[0].name', ?1)").run(`<script>alert("x")</script>'`);
  const { code } = await (await createLink(env, { run: idOf(sqlite, "odd"), ladder: "score" })).json();
  const html = await (await call(env, `/${code}`, { ua: DISCORD_UA })).text();
  assert.doesNotMatch(html, /<script/iu);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;&#39;/u);
});

test("the card: a valid 1200x630 PNG, drawn once a look and kept, a new place drawn anew", async () => {
  const { env, sqlite } = await board();
  const { code } = await (await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "score" })).json();
  const html = await (await call(env, `/${code}`, { ua: DISCORD_UA })).text();
  const image = new URL(html.match(/<meta property="og:image" content="([^"]*)">/u)[1].replaceAll("&amp;", "&"));
  const response = await call(env, image.pathname + image.search);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(response.headers.get("cache-control"), /immutable/u);
  const png = new Uint8Array(await response.arrayBuffer());
  const info = pngInfo(png);
  assert.deepEqual([info.width, info.height, info.colourType, info.bitDepth], [1200, 630, 3, 8]);
  assert.equal(info.pixels.length, 630 * 1201);
  assert.ok(info.paletteSize > 8 && info.paletteSize <= 256);
  assert.deepEqual([...env.EVIDENCE.objects.keys()].filter((key) => key.startsWith("placement-cards/")), [`placement-cards/${code}/2-${image.searchParams.get("v")}.png`]);
  // kept: a second fetch reads the stored one
  env.EVIDENCE.objects.get(`placement-cards/${code}/2-${image.searchParams.get("v")}.png`).bytes = Uint8Array.from([1, 2, 3]);
  assert.deepEqual([...new Uint8Array(await (await call(env, image.pathname + image.search)).arrayBuffer())], [1, 2, 3]);
  // a new place: a new key
  const gale = await player(env, sqlite, "Gale");
  await send(env, gale, "better", { score: 40000, party: [["Gale", false, 40000], ["Flora", true], ["Mario", true], ["Tammy", true]], at: 3000 });
  const fresh = await call(env, `/api/links/${code}.png`);
  assert.equal(pngInfo(new Uint8Array(await fresh.arrayBuffer())).width, 1200);
  assert.equal([...env.EVIDENCE.objects.keys()].filter((key) => key.startsWith(`placement-cards/${code}/3-`)).length, 1);
});

test("the card drawing: every model shape draws, names in letters the card lacks become boxes", async () => {
  const base = { place: 12, ladder: "Fastest clear", figure: "1:58", boss: "Alpha Blazen + Omega Tucking", slot: "Center",
    week: "Week of Nov 18 – Nov 25", stars: 40, result: "Both Killed: 1:58", extra: "Score 96,200", tag: "Trio" };
  for (const players of [[], [{ name: "Ålvarö Ñuñez", dps: "12,000" }], [{ name: "テスト", dps: null }, { name: "x".repeat(80), dps: "1" }]]) {
    const info = pngInfo(await drawPlacementCard({ ...base, players }, LETTERS));
    assert.deepEqual([info.width, info.height], [CARD_WIDTH, CARD_HEIGHT]);
  }
});

test("the card's title: a boss name keeps the full size when it fits; a two-boss name steps down to fit, never cut", () => {
  const width = (text, font) => [...text].reduce((sum, char) => sum + CARD_FONTS[font].glyphs[char][0] / 16, 0);
  const room = (place) => CARD_WIDTH - 64 - (64 + width(`#${place}`, "place") + 34);      // drawPlacementCard's layout
  const pick = (name, place) => cardTitleFont((font) => width(name, font), room(place));
  // every single name the weeks have had fits at 54 even beside a three-digit place: those cards are unchanged
  for (const name of ["Alpha Scorchhowl", "Alpha Luminelle", "Alpha Sugartini", "Omega Infergon", "Alpha Magmarex"]) {
    for (const place of [1, 88, 125]) assert.equal(pick(name, place), "title", `${name} #${place}`);
  }
  // the stored two-boss weeks (4003-4005): 48 beside #1, 42 beside #88, 36 beside #125, and always in full
  for (const name of ["Alpha Blazen + Omega Tucking", "Alpha Glameep + Alpha Jabster", "Alpha Grizbo + Omega Jeburst"]) {
    assert.deepEqual([1, 88, 125].map((place) => pick(name, place)), ["title48", "title42", "title36"], name);
    for (const place of [1, 88, 125]) assert.ok(width(name, pick(name, place)) <= room(place), `${name} #${place} fits`);
  }
  // past the smallest size it stays at 36 (and is cut there)
  assert.equal(pick("Alpha Glameep + Alpha Jabster", 12345), "title36");
  assert.deepEqual(CARD_TITLE_FONTS.map((font) => CARD_FONTS[font].size), [54, 48, 42, 36]);
});

test("the card's name and text letter sets draw every printable ASCII character", () => {
  for (const font of ["title", "body", "small", "title48", "title42", "title36"]) {
    const missing = [];
    for (let code = 0x20; code <= 0x7e; code += 1) if (!CARD_FONTS[font].glyphs[String.fromCharCode(code)]) missing.push(String.fromCharCode(code));
    assert.deepEqual(missing, [], font);
  }
});

// a PNG's header, palette and inflated scanlines; throws on a bad signature or CRC
function pngInfo(png) {
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let at = 8; const idat = []; const info = {};
  while (at < png.length) {
    const length = view.getUint32(at); const type = String.fromCharCode(...png.slice(at + 4, at + 8));
    let crc = 0xffffffff;
    for (let i = at + 4; i < at + 8 + length; i += 1) crc = table[(crc ^ png[i]) & 0xff] ^ (crc >>> 8);
    assert.equal((crc ^ 0xffffffff) >>> 0, view.getUint32(at + 8 + length), `${type} CRC`);
    const data = png.slice(at + 8, at + 8 + length);
    if (type === "IHDR") Object.assign(info, { width: view.getUint32(at + 8), height: view.getUint32(at + 12), bitDepth: data[8], colourType: data[9] });
    if (type === "PLTE") info.paletteSize = length / 3;
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
    if (type === "IEND") break;
  }
  info.pixels = inflateSync(Buffer.concat(idat));                 // zlib: checks the Adler-32 too
  for (let row = 0; row < info.height; row += 1) assert.equal(info.pixels[row * (info.width + 1)], 0, "filter byte");
  return info;
}

test("the boards page: the link button and tag script before the boards, the Party filter, and run links that tidy up", () => {
  const read = (path) => readFileSync(resolve(import.meta.dirname, "..", "public", path), "utf8");
  const page = read("leaderboard/index.html");
  assert.ok(page.indexOf('<script src="/leaderboard/share.js') > 0 && page.indexOf('<script src="/leaderboard/share.js') < page.indexOf('<script src="/leaderboard/leaderboard.js'));
  assert.match(page, /<select data-party-select[^>]*><option value="">All<\/option><option value="4">Four players<\/option><option value="3">Trio<\/option><option value="2">Duo<\/option><option value="1">Solo<\/option><\/select>/u);
  const boards = read("leaderboard/leaderboard.js");
  assert.match(boards, /function openRunFromUrl\(\)/u);
  assert.match(boards, /\["comments"\]\.includes\(params\.get\("tab"\)\)/u);              // an unknown tab is ignored
  assert.match(boards, /for \(const key of \["run", "tab", "link"\]\) url\.searchParams\.delete\(key\)/u);
  assert.match(boards, /if \(state\.players\) ask\.set\("players", state\.players\)/u);
  const share = read("leaderboard/share.js");
  assert.match(share, /fetch\(`\$\{API_URL\}\/links`, \{ method: "POST", credentials: "omit"/u);
  assert.match(share, /"Link copied"/u);
  assert.doesNotMatch(share, /localStorage|sessionStorage/u);
});
test("every player of the run on the card: by Avg DPS, none last, a bot marked AI, a name the site leaves out as Player", () => {
  // the Party read gave three slots; the Battle Data cards had a fourth player (21 Nov)
  const lineup = lineupWithCards([
    { slot: 1, name: "Aster", self: true, avgDps: 30000 }, { slot: 2, name: "Briar", avgDps: 50000 }, { slot: 3, name: "Flora", ai: true, avgDps: null },
  ], [{ name: "Aster", self: true, avgDps: 30000 }, { name: "Briar", avgDps: 50000 }, { name: "Flora", ai: true }, { name: "Cobalt", avgDps: 40000 }]);
  assert.deepEqual(lineup.map((p) => [p.name, p.avgDps, p.fromBattleData === true]),
    [["Aster", 30000, false], ["Briar", 50000, false], ["Flora", null, false], ["Cobalt", 40000, true]]);
  const team = { ladder: PLACEMENT_LADDERS.score, lead: { player: "Aster" }, members: [] };
  assert.deepEqual(cardPlayers({ ...team, lineup }).map((p) => [p.name, p.dps, Boolean(p.ai), p.mark]),
    [["Briar", "50,000", false, false], ["Cobalt", "40,000", false, false], ["Aster", "30,000", false, false], ["Flora", null, true, false]]);
  // an unsettled name stays out: the row shows as "Player"; four slots already listed: no fifth; a slot's own card isn't added twice
  const hidden = lineupWithCards([{ slot: 1, name: "Aster", avgDps: 1000 }], [{ name: "Aster", avgDps: 1000 }, { name: "Dorian", unsettled: true, avgDps: 900 }]);
  assert.deepEqual(hidden[1], { unnamed: true, ai: false, avgDps: 900, fromBattleData: true });
  assert.equal(cardPlayers({ ...team, lineup: hidden })[1].name, "Player");
  const four = [1, 2, 3, 4].map((slot) => ({ slot, name: `P${slot}`, avgDps: slot }));
  assert.equal(lineupWithCards(four, [{ name: "Extra", avgDps: 99 }]).length, 4);
  assert.equal(lineupWithCards([{ slot: 1, name: "Aster", avgDps: 7 }], [{ name: "Astor", avgDps: 7 }]).length, 1);
  // no Party read and no cards: the board row's players, as before
  assert.deepEqual(cardPlayers({ ...team, lineup: null, members: [{ player: "Aster", avgDps: 5 }] }).map((p) => p.name), ["Aster"]);
});

test("a one-player ladder's card marks whose placement it is and lists the other three", () => {
  const lineup = [{ name: "Aster", avgDps: 9000 }, { name: "Briar", avgDps: 12000 }, { name: "Flora", ai: true, avgDps: null }, { name: "Cobalt", avgDps: 3000 }];
  const rows = cardPlayers({ ladder: PLACEMENT_LADDERS.dps, lead: { player: "Aster", avgDps: 9000 }, members: [], lineup });
  assert.deepEqual(rows.map((p) => [p.name, p.mark]), [["Briar", false], ["Aster", true], ["Cobalt", false], ["Flora", false]]);
  // a run whose list doesn't name them: they're added, marked
  const added = cardPlayers({ ladder: PLACEMENT_LADDERS.dps, lead: { player: "Dorian", avgDps: 1 }, members: [], lineup });
  assert.ok(added.some((p) => p.name === "Dorian" && p.mark));
  assert.equal(added.length, 4);
});

test("the run viewer lists a player only the Battle Data cards had, and the link's card and text follow the run's own list", async () => {
  const { env, sqlite } = await setup();
  const ash = await player(env, sqlite, "Ashwick");
  await send(env, ash, "missed", { score: 31000, party: [["Ashwick", false, 20000], ["Fernley", false, 15000], ["Gorse", false, 9000], ["Flora", true]] });
  // the Party read missed one player: its lineup has three slots, the Battle Data cards four
  sqlite.prepare("UPDATE leaderboard_submissions SET extra_json = json_remove(extra_json, '$.lineup[2]') WHERE client_run_id = 'missed'").run();
  const id = idOf(sqlite, "missed");
  const list = await (await call(env, `/api/leaderboard/submissions/${id}/evidence?shot=list`)).json();
  assert.deepEqual(list.lineup.map((p) => [p.name, p.avgDps ?? null, Boolean(p.ai)]),
    [["Ashwick", 20000, false], ["Fernley", 15000, false], ["Flora", null, true], ["Gorse", 9000, false]]);
  const { code } = await (await createLink(env, { run: id, ladder: "score" })).json();
  const html = await (await call(env, `/${code}`, { ua: DISCORD_UA })).text();
  assert.match(html, /<meta property="og:description" content="Ashwick, Fernley, Gorse and Flora \(AI\): 31,000 with 30 stars\. Trio: three players and a bot\./u);
  // the card shows the run's list, so a change to it is a new picture under a new key
  const image = new URL(html.match(/<meta property="og:image" content="([^"]*)">/u)[1].replaceAll("&amp;", "&"));
  assert.equal((await call(env, image.pathname + image.search)).status, 200);
  sqlite.prepare("UPDATE leaderboard_submissions SET players_json = json_set(players_json, '$[2].avgDps', 9500) WHERE client_run_id = 'missed'").run();
  const again = await (await call(env, `/${code}`, { ua: DISCORD_UA })).text();
  const fresh = new URL(again.match(/<meta property="og:image" content="([^"]*)">/u)[1].replaceAll("&amp;", "&"));
  assert.notEqual(fresh.searchParams.get("v"), image.searchParams.get("v"));
  assert.equal((await call(env, fresh.pathname + fresh.search)).status, 200);
  assert.equal([...env.EVIDENCE.objects.keys()].filter((key) => key.startsWith(`placement-cards/${code}/`)).length, 2);
});
test("one bot rule: the game's four bot names with nothing that says person; the app's ai flag alone decides nothing", () => {
  // a flagged slot with a normal name is a player; a bot's name with a CP, a UID, an account or as the sender is a person
  assert.equal(slotIsBot({ name: "Quillon", ai: true }), false);
  assert.equal(slotIsBot({ name: "Leonard", ai: true }, [{ name: "Leonard", cp: 1840 }]), false);
  assert.equal(slotIsBot({ name: "Mario", ai: false, uid: "302000000777" }), false);
  assert.equal(slotIsBot({ name: "Tammy", confirmed: 1 }), false);
  assert.equal(slotIsBot({ name: "Flora", self: true }), false);
  // an unflagged "Leonard" with no UID, no account and no CP is a bot; names are folded for case and spaces
  assert.equal(slotIsBot({ name: "Leonard", ai: false }), true);
  assert.equal(slotIsBot({ name: " le onard ", ai: false }, [{ name: "LEONARD", aniimoLevel: 60 }]), true);
  // the labels follow
  assert.equal(realPlayersOf([{ name: "Aster" }, { name: "Quillon", ai: true }, { name: "Briar" }, { name: "Leonard", ai: false }]), 3);
  assert.equal(realPlayersOf([{ name: "Aster" }, { name: "Mario", ai: true }], [{ name: "Mario", cp: 900 }]), null);
});

test("the bot rule in every answer: the viewer, the card's text, the boards' credit and the Party filter", async () => {
  const { env, sqlite } = await setup();
  const sender = await player(env, sqlite, "Hollin");
  // the app flagged a real teammate (Quillon) and missed a bot (Leonard); "Mario" here is a person with a CP
  const party = [["Hollin", false, 20000], ["Quillon", true, 15000], ["Mario", true, 9000], ["Leonard", false]];
  await send(env, sender, "flags", { score: 33000, party });
  sqlite.prepare("UPDATE leaderboard_submissions SET extra_json = json_set(extra_json, '$.lineup[2].cp', 2400) WHERE client_run_id = 'flags'").run();
  const id = idOf(sqlite, "flags");
  const list = await (await call(env, `/api/leaderboard/submissions/${id}/evidence?shot=list`)).json();
  assert.deepEqual(list.lineup.map((p) => [p.name, p.ai]), [["Hollin", false], ["Quillon", false], ["Mario", false], ["Leonard", true]]);
  const { code } = await (await createLink(env, { run: id, ladder: "score" })).json();
  const html = await (await call(env, `/${code}`, { ua: DISCORD_UA })).text();
  assert.match(html, /content="Hollin, Quillon, Mario and Leonard \(AI\): 33,000 with 30 stars\. Trio: three players and a bot\./u);
  // the boards: the wrongly flagged players are listed like any unlinked teammate, the bot never
  const unlinked = await interlink(env, "ladder=score&unlinked=1");
  assert.deepEqual(unlinked.entries.map((e) => e.player).sort(), ["Hollin", "Mario", "Quillon"]);
  assert.ok(unlinked.entries.every((e) => e.realPlayers === 3));
  assert.deepEqual((await interlink(env, "ladder=score&unlinked=1&players=3")).entries.length, 3);
  assert.deepEqual((await interlink(env, "ladder=score&unlinked=1&players=4")).entries.length, 0);
});
// A made-up letter pack in the build's format (scripts/build-card-script-packs.mjs): each letter a solid block, so
// the test can tell it was drawn
function madePack(codePoints) {
  const head = Buffer.alloc(8 + codePoints.length * 12);
  head.write("ACP1", 0, "latin1"); head[4] = 1; head[5] = 32; head.writeUInt16LE(codePoints.length, 6);
  const pictures = [];
  codePoints.forEach((cp, i) => {
    const at = 8 + i * 12;
    head[at] = cp & 0xff; head.writeUInt16LE(32 * 16, at + 2); head.writeInt8(2, at + 4); head.writeInt8(-24, at + 5);
    head[at + 6] = 26; head[at + 7] = 26; head.writeUInt32LE(i * 338, at + 8);
    pictures.push(Buffer.alloc(338, 0xff));
  });
  return deflateRawSync(Buffer.concat([head, ...pictures]));
}

test("which packs a name needs: none for the card's own letters and accents, one block per other script's letter", () => {
  assert.deepEqual(packBlocksFor(["Ålvarö", "Zoë Ñuñez", "Kestrel"], CARD_FONTS), []);
  assert.deepEqual(packBlocksFor(["Łukasz"], CARD_FONTS), ["0100"]);
  assert.deepEqual(packBlocksFor(["ミカ", "Ника", "하나", "Δέλτα", "王小明", "ＡＢ"], CARD_FONTS), ["0300", "0400", "3000", "5c00", "6600", "7300", "b000", "d500", "ff00"]);
});

test("the card without packs is as before (boxes, no error); with packs it draws the letters, and the picture is new", async () => {
  const { env, sqlite } = await setup();
  const ren = await player(env, sqlite, "Renwick");
  await send(env, ren, "cjk", { score: 21000, party: [["Renwick", false, 9000], ["一二", false, 7000], ["アイ", false, 5000], ["Flora", true]] });
  const { code } = await (await createLink(env, { run: idOf(sqlite, "cjk"), ladder: "score" })).json();
  const imageOf = async () => new URL((await (await call(env, `/${code}`, { ua: DISCORD_UA })).text())
    .match(/<meta property="og:image" content="([^"]*)">/u)[1].replaceAll("&amp;", "&"));
  const before = await imageOf();
  const boxes = await call(env, before.pathname + before.search);
  assert.equal(boxes.status, 200);
  const boxed = pngInfo(new Uint8Array(await boxes.arrayBuffer()));
  // a pack that isn't a pack is ignored too
  await env.EVIDENCE.put("card-glyphs/v1/3000.bin", new Uint8Array([1, 2, 3]));
  assert.equal((await imageOf()).searchParams.get("v"), before.searchParams.get("v"));
  // the packs arrive: a pack found missing is asked again after 5 minutes
  await env.EVIDENCE.put("card-glyphs/v1/4e00.bin", madePack([0x4e00, 0x4e8c]));
  assert.equal((await imageOf()).searchParams.get("v"), before.searchParams.get("v"));
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60 * 1000;
  let after;
  try { after = await imageOf(); } finally { Date.now = realNow; }
  assert.notEqual(after.searchParams.get("v"), before.searchParams.get("v"));
  const drawn = pngInfo(new Uint8Array(await (await call(env, after.pathname + after.search)).arrayBuffer()));
  assert.notDeepEqual(drawn.pixels, boxed.pixels);
});

test("mixed names line up and are cut with ... ; the AI pill and the placement mark still draw", async () => {
  const extra = new Map([[0x4e00, [32 * 16, 2, -24, 26, 26, 0, new Uint8Array(338).fill(0xff)]], [0x30a2, [32 * 16, 2, -24, 26, 26, 0, new Uint8Array(338).fill(0xff)]]]);
  const card = (players) => drawPlacementCard({ place: 4, ladder: "Score", figure: "1,000", boss: "Omega Tucking", slot: "Left", week: "Week of Nov 18 – Nov 25",
    stars: 30, result: "Timed Out: 3:00", extra: "Team DPS 1,000", tag: null, players }, { ...LETTERS, extra });
  for (const players of [[{ name: "Ren一", dps: "1" }, { name: "Zoëア", dps: "2", mark: true }, { name: `${"一".repeat(30)}x`, dps: "3" }, { name: "Mario", dps: null, ai: true }]]) {
    const info = pngInfo(await card(players));
    assert.deepEqual([info.width, info.height], [CARD_WIDTH, CARD_HEIGHT]);
  }
});

test("storing a letter pack: administrators only, a strict name, a size cap, and only a real pack", async () => {
  const { env, sqlite } = await setup();
  const plain = await player(env, sqlite, "Plainly");
  const admin = await player(env, sqlite, "Adminly");
  sqlite.prepare("INSERT INTO developer_roles (discord_id, granted_by_discord_id, created_at) VALUES (?, ?, ?)").run(admin.discordId, plain.discordId, 1);
  sqlite.prepare("UPDATE developer_roles SET role = 'administrator' WHERE discord_id = ?").run(admin.discordId);
  const put = (token, block, body) => worker.fetch(new Request(`${API}/api/admin/card-glyphs/${block}`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body }), env);
  assert.equal((await put(plain.token, "4e00", madePack([0x4e00]))).status, 403);
  assert.equal((await put(admin.token, "4e01", madePack([0x4e00]))).status, 400);          // not a pack's name
  assert.equal((await put(admin.token, "../x", madePack([0x4e00]))).status, 404);
  assert.equal((await put(admin.token, "4e00", new Uint8Array([1, 2, 3]))).status, 400);
  assert.equal((await put(admin.token, "4e00", new Uint8Array(600 * 1024))).status, 413);
  const stored = await put(admin.token, "4e00", madePack([0x4e00, 0x4e8c]));
  assert.equal(stored.status, 200);
  assert.deepEqual((await stored.json()).letters, 2);
  assert.ok(env.EVIDENCE.objects.has("card-glyphs/v1/4e00.bin"));
});