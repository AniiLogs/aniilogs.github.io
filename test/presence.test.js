// "I was in this run" notes (kind interlink_presence, migration 0038) and the staff seat link (/api/admin/run-seat).
// Every player here is made up.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker, { presenceCard, presencePlayers } from "../src/index.js";

const ORIGIN = "https://aniilogs.github.io";
const API = "https://api.aniilogs.example";
const BOSS = { id: "80000100", name: "Omega Tucking", level: 60 };

async function tokenHash(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Buffer.from(digest).toString("base64url");
}

async function setup(extraEnv = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = resolve(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(resolve(dir, file), "utf8"));
  const statement = (sql, values = []) => ({
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  const DB = {
    prepare(sql) { return { ...statement(sql), bind: (...values) => statement(sql, values) }; },
    async batch(statements) { return Promise.all(statements.map((item) => item.run())); },
  };
  const ASSETS = { fetch: async () => new Response("Not found", { status: 404 }) };
  const env = { DB, ASSETS, PUBLIC_SITE_ORIGIN: ORIGIN, LEADERBOARD_PUBLIC: "true", ...extraEnv };
  return { env, sqlite };
}

function call(env, path, { session, token, method = "GET", body } = {}) {
  const headers = new Headers();
  if (session) { headers.set("authorization", `Bearer ${session}`); headers.set("origin", ORIGIN); }
  if (token) headers.set("authorization", `Bearer ${token}`);
  let payload;
  if (body !== undefined) { headers.set("content-type", "application/json"); payload = JSON.stringify(body); }
  return worker.fetch(new Request(`${API}${path}`, { method, headers, body: payload }), env);
}

let nextId = 0;
async function player(env, sqlite, name) {
  nextId += 1;
  const discordId = String(500000000000000000n + BigInt(nextId));
  const session = `p${String(nextId).padStart(3, "0")}`.padEnd(48, "y");
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare("INSERT INTO users VALUES (?, ?, ?, NULL, ?, ?)").run(discordId, name.toLowerCase(), name, now, now);
  sqlite.prepare("INSERT INTO profiles (discord_id, display_name, bio, is_public, public_id, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, ?, ?)")
    .run(discordId, name, `pub${nextId}`, now, now);
  sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(await tokenHash(session), discordId, now, now + 3600);
  const made = await call(env, "/api/leaderboard/tokens", { session, method: "POST", body: { label: "PC" } });
  const { token } = await made.json();
  const gameUid = String(303000000000 + nextId);
  assert.ok((await call(env, "/api/leaderboard/characters", { token, method: "POST", body: { gameUid, name } })).status < 300);
  return { name, token, session, gameUid, discordId, profileId: `pub${nextId}` };
}

// one copy of a run: cards in seat order, the sender marked self
async function send(env, who, id, { cards, instanceId = "inst-1", score = 30000, at = 0 }) {
  const players = cards.map(([name, avgDps]) => ({ name, ai: false, ...(name === who.name ? { self: true } : {}), ...(avgDps ? { avgDps } : {}) }));
  const response = await call(env, "/api/leaderboard/submissions", { token: who.token, method: "POST", body: {
    kind: "interlink_run", clientRunId: id, cycle: "3005", boss: BOSS, score, stars: 30, clearTimeS: 170, cleared: true, teamDps: 30000,
    gameUid: who.gameUid, playedAt: 1792700000 + at, players, extra: { instanceId, lineup: cards.map(([name], slot) => ({ slot, name })) } } });
  assert.ok([200, 201].includes(response.status), `sent ${id}: ${response.status}`);
}
const note = (env, who, extra, more = {}) => call(env, "/api/leaderboard/submissions", { token: who.token, method: "POST", body: {
  kind: "interlink_presence", clientRunId: `presence-${extra.instanceId}`, cycle: "3005", boss: BOSS, gameUid: who.gameUid,
  playedAt: 1792700000, clientVersion: "aLogs-0.1.38", ...more, extra } });
const stored = (sqlite, clientRunId) => JSON.parse(sqlite.prepare("SELECT players_json AS p FROM leaderboard_submissions WHERE client_run_id = ?").get(clientRunId).p);
const seatOf = (players, uid) => players.findIndex((slot) => slot?.uid === uid && slot.confirmed === true);

async function team() {
  const { env, sqlite } = await setup();
  const p = {};
  for (const name of ["Briar", "Ansel", "Corin"]) p[name] = await player(env, sqlite, name);
  return { env, sqlite, p };
}
const CARDS = [["Briar", 9000], ["Ansel", 8000], ["Corin", 7000], ["Delph", 6000]];

test("a note first, the copy later: the seat gets the note's UID and confirmed; the answer says nothing else", async () => {
  const { env, sqlite, p } = await team();
  const answer = await note(env, p.Ansel, { instanceId: "inst-1", slot: 1, name: "Ansel" });
  assert.equal(answer.status, 201);
  assert.deepEqual(await answer.json(), { ok: true });
  await send(env, p.Briar, "briar", { cards: CARDS });
  const players = stored(sqlite, "briar");
  assert.equal(seatOf(players, p.Ansel.gameUid), 1);
  assert.equal(players[1].noted, true);
  // the row counts for Ansel's account: on the board, claimed
  const board = await (await call(env, `/api/leaderboard/interlink?cycle=3005&boss=${BOSS.id}&ladder=score&rows=teams&unlinked=1`)).json();
  const ansel = board.bosses[0].entries.find((e) => e.player === "Ansel");
  assert.equal(ansel.unclaimed, false);
  assert.equal(JSON.stringify(board).includes("noted"), false);
});

test("the copy first, the note later; by name without a slot; a second note updates the first", async () => {
  const { env, sqlite, p } = await team();
  await send(env, p.Briar, "briar", { cards: CARDS });
  assert.equal(seatOf(stored(sqlite, "briar"), p.Ansel.gameUid), -1);
  assert.equal((await note(env, p.Ansel, { instanceId: "inst-1" })).status, 201);           // no slot: by the character's name
  assert.equal(seatOf(stored(sqlite, "briar"), p.Ansel.gameUid), 1);
  // a second note for the same instance: still one note
  assert.equal((await note(env, p.Ansel, { instanceId: "inst-1", slot: 1 })).status, 201);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM interlink_presence").get().n, 1);
  assert.equal(seatOf(stored(sqlite, "briar"), p.Ansel.gameUid), 1);
  // another instance's copy is untouched
  await send(env, p.Briar, "briar-2", { cards: CARDS, instanceId: "inst-2", score: 20000, at: 900 });
  assert.equal(seatOf(stored(sqlite, "briar-2"), p.Ansel.gameUid), -1);
});

test("a slot whose card carries another name, or a card already confirmed for someone else: nothing happens", async () => {
  const { env, sqlite, p } = await team();
  await send(env, p.Briar, "briar", { cards: CARDS });
  // Ansel's note names seat 3 (Corin's card): not alike, nothing; the note stays for a copy that may fit later
  assert.equal((await note(env, p.Ansel, { instanceId: "inst-1", slot: 2, name: "Ansel" })).status, 201);
  assert.equal(seatOf(stored(sqlite, "briar"), p.Ansel.gameUid), -1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM interlink_presence").get().n, 1);
  // Corin sends their own copy: Corin's seat is Corin's by that copy; a note of another account naming it does nothing
  await send(env, p.Corin, "corin", { cards: CARDS, at: 5 });
  const before = stored(sqlite, "briar");
  assert.equal(seatOf(before, p.Corin.gameUid), 2);
  const players = [{ name: "Briar", self: true }, { name: "Corin", uid: "303000999999", confirmed: true }];
  assert.equal(presencePlayers(players, [{ gameUid: "303000000777", names: ["Corin"], name: "Corin", slot: null }])[1].uid, "303000999999");
});

test("presenceCard: by slot with an alike name (look-alike or near), by name alone, never the sender's own card", () => {
  const cards = [{ name: "Briar", self: true }, { name: "Anse1" }, { name: "Corin" }, { name: "Delph" }];
  assert.equal(presenceCard(cards, { slot: 1, names: ["Ansel"] }), 1);                 // 1 and l read alike
  assert.equal(presenceCard(cards, { slot: 1, names: ["Ansol"] }), 1);                 // near: 0.8
  assert.equal(presenceCard(cards, { slot: 1, names: ["Wexley"] }), -1);
  assert.equal(presenceCard(cards, { slot: null, names: ["Delph"] }), 3);
  assert.equal(presenceCard(cards, { slot: 0, names: ["Briar"] }), -1);                // the sender's own card
  assert.equal(presenceCard([{ name: "Briar", self: true }, { name: "Q", unsettled: true }, { name: "Corin" }, { name: "Delph" }], { slot: 1, names: ["Ansel"] }), 1);
  assert.equal(presenceCard(cards, { slot: 2, names: ["Ansel"], forced: true, addedBy: "x" }), 2);
});

test("a note is never a record: no board row, count, My runs or public answer; an unknown kind is still refused", async () => {
  const { env, sqlite, p } = await team();
  assert.equal((await note(env, p.Ansel, { instanceId: "inst-9", slot: 0, name: "Ansel" })).status, 201);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM leaderboard_submissions").get().n, 0);
  const board = await (await call(env, `/api/leaderboard/interlink?cycle=3005&boss=${BOSS.id}&ladder=score&rows=teams&unlinked=1`)).json();
  assert.deepEqual([board.bosses[0].entries.length, board.bosses[0].total ?? 0], [0, 0]);
  const mine = await (await call(env, "/api/leaderboard/me", { session: p.Ansel.session })).text();
  assert.equal(mine.includes("inst-9"), false);
  const unknown = await call(env, "/api/leaderboard/submissions", { token: p.Ansel.token, method: "POST", body: { kind: "interlink_nonsense", clientRunId: "x" } });
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: "Unknown submission kind." });
  // a note needs its instance
  assert.equal((await note(env, p.Ansel, {})).status, 400);
  assert.equal((await note(env, p.Ansel, { instanceId: "inst-9", slot: 7 })).status, 400);
});

test("staff link a seat by hand (the name check, force) and undo it; a non-staff account is refused like the other admin routes", async () => {
  const { env, sqlite } = await setup();
  const p = {};
  for (const name of ["Briar", "Ansel", "Staffy"]) p[name] = await player(env, sqlite, name);
  env.ADMIN_DISCORD_IDS = p.Staffy.discordId;                                // the owner
  await send(env, p.Briar, "briar", { cards: [["Briar", 9000], ["Ansel", 8000], ["Quill", 7000], ["Delph", 6000]] });
  const id = sqlite.prepare("SELECT submission_id AS id FROM leaderboard_submissions WHERE client_run_id = 'briar'").get().id;
  const seat = (body, session = p.Staffy.session, method = "POST") => call(env, "/api/admin/run-seat", { session, method, body });
  // permissions: a player gets what the other admin routes answer
  const denied = await seat({ submissionId: id, seat: 2, profileId: p.Ansel.profileId }, p.Ansel.session);
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Access denied." });
  assert.equal((await call(env, "/api/admin/run-checks/staff", { session: p.Ansel.session })).status, 403);
  // the name check: seat 3 is Quill's card, not one of Ansel's characters
  assert.equal((await seat({ submissionId: id, seat: 3, profileId: p.Ansel.profileId })).status, 409);
  assert.equal(seatOf(stored(sqlite, "briar"), p.Ansel.gameUid), -1);
  // seat 2: linked
  const linked = await seat({ submissionId: id, seat: 2, profileId: p.Ansel.profileId });
  assert.equal(linked.status, 200);
  assert.deepEqual(await linked.json(), { ok: true, seat: 2, copies: 1 });
  assert.equal(seatOf(stored(sqlite, "briar"), p.Ansel.gameUid), 1);
  assert.equal(sqlite.prepare("SELECT added_by AS by FROM interlink_presence").get().by, p.Staffy.discordId);
  // undo: the UID and confirmed it gave are taken back
  const undone = await seat({ submissionId: id, seat: 2, profileId: p.Ansel.profileId }, p.Staffy.session, "DELETE");
  assert.deepEqual(await undone.json(), { ok: true, undone: true, seat: 2, copies: 1 });
  const after = stored(sqlite, "briar");
  assert.equal(after.some((slot) => slot?.uid === p.Ansel.gameUid || slot?.noted), false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM interlink_presence").get().n, 0);
  // force: seat 3 for the staff account itself ("me"), past the name check
  const forced = await seat({ submissionId: id, seat: 3, profileId: "me", force: true });
  assert.deepEqual(await forced.json(), { ok: true, seat: 3, copies: 1 });
  assert.equal(seatOf(stored(sqlite, "briar"), p.Staffy.gameUid), 2);
  assert.equal((await seat({ submissionId: id, seat: 3, profileId: "me", undo: true })).status, 200);
  assert.equal(seatOf(stored(sqlite, "briar"), p.Staffy.gameUid), -1);
  // a UID that came from a real copy stays when a note on it is undone
  const own = await player(env, sqlite, "Delph");
  assert.equal((await seat({ submissionId: id, seat: 4, profileId: own.profileId })).status, 200);
  await send(env, own, "delph", { cards: [["Briar", 9000], ["Ansel", 8000], ["Quill", 7000], ["Delph", 6000]], at: 5 });
  assert.equal(seatOf(stored(sqlite, "briar"), own.gameUid), 3);
  assert.equal((await seat({ submissionId: id, seat: 4, profileId: own.profileId, undo: true })).status, 200);
  assert.equal(seatOf(stored(sqlite, "briar"), own.gameUid), 3);
  // the answers carry no names
  assert.equal(/Ansel|Briar|Delph|Quill/u.test(JSON.stringify(await (await seat({ submissionId: id, seat: 2, profileId: p.Ansel.profileId })).json())), false);
});
