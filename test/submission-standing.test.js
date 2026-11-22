// The send's standing (submitLeaderboardRecord's `standing`): is the run the sender's best on its board now, and its
// place there as the boards state it. Every player here is made up.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker from "../src/index.js";

const ORIGIN = "https://aniilogs.github.io";
const API = "https://api.aniilogs.example";
const BOSS = { id: "80000100", name: "Omega Tucking", level: 60 };

async function tokenHash(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Buffer.from(digest).toString("base64url");
}

// A D1-shaped wrapper over an in-memory SQLite database with every migration applied. failOn: SQL matching it throws
// (a statement failing inside the standing code). statements: every statement prepared, in order.
async function setup(extraEnv = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = resolve(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(resolve(dir, file), "utf8"));
  const statement = (sql, values = []) => ({
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  const statements = [];
  const control = { failOn: null };
  const DB = {
    prepare(sql) {
      statements.push(sql);
      const check = () => { if (control.failOn && control.failOn.test(sql)) throw new Error("D1_ERROR: made-up failure"); };
      return {
        async first() { check(); return statement(sql).first(); },
        async all() { check(); return statement(sql).all(); },
        async run() { check(); return statement(sql).run(); },
        bind: (...values) => {
          if (values.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${values.length})`);
          const bound = statement(sql, values);
          return { first: async () => { check(); return bound.first(); }, all: async () => { check(); return bound.all(); }, run: async () => { check(); return bound.run(); } };
        },
      };
    },
    async batch(list) { return Promise.all(list.map((item) => item.run())); },
  };
  const objects = new Map();
  const EVIDENCE = {
    async put(key, body) { objects.set(key, new Uint8Array(await new Response(body).arrayBuffer())); },
    async get() { return null; },
    async delete(key) { objects.delete(key); },
  };
  const env = { DB, EVIDENCE, PUBLIC_SITE_ORIGIN: ORIGIN, LEADERBOARD_PUBLIC: "true", ...extraEnv };
  return { env, sqlite, statements, control };
}

function call(env, path, { session, token, method = "GET", body, form } = {}) {
  const headers = new Headers();
  if (session) { headers.set("authorization", `Bearer ${session}`); headers.set("origin", ORIGIN); }
  if (token) headers.set("authorization", `Bearer ${token}`);
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers.set("content-type", "application/json"); payload = JSON.stringify(body); }
  return worker.fetch(new Request(`${API}${path}`, { method, headers, body: payload }), env);
}

let nextId = 0;
async function player(env, sqlite, name) {
  nextId += 1;
  const discordId = String(500000000000000000n + BigInt(nextId));
  const session = `t${String(nextId).padStart(3, "0")}`.padEnd(48, "x");
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare("INSERT INTO users VALUES (?, ?, ?, NULL, ?, ?)").run(discordId, name.toLowerCase(), name, now, now);
  sqlite.prepare("INSERT INTO profiles (discord_id, display_name, bio, is_public, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)").run(discordId, name, now, now);
  sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(await tokenHash(session), discordId, now, now + 3600);
  const made = await call(env, "/api/leaderboard/tokens", { session, method: "POST", body: { label: "PC" } });
  const { token } = await made.json();
  const gameUid = String(303000000000 + nextId);
  assert.ok((await call(env, "/api/leaderboard/characters", { token, method: "POST", body: { gameUid, name } })).status < 300);
  return { name, token, gameUid, discordId };
}

async function sendBody(env, who, body) {
  const form = new FormData();
  form.set("submission", JSON.stringify(body));
  form.set("evidence", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), "result.jpg");
  const response = await call(env, "/api/leaderboard/submissions", { token: who.token, method: "POST", form });
  assert.ok(response.status === 201 || response.status === 200, `sent: ${response.status}`);
  return response.json();
}

// one Interlink run's copy. party: [name, ai?]; the sender is marked self
function send(env, who, id, { score, stars = 30, party, at = 0, lineup = null }) {
  const players = party.map(([name, ai = false]) => ({ name, ai, ...(name === who.name ? { self: true } : {}), avgDps: 5000 }));
  return sendBody(env, who, { kind: "interlink_run", clientRunId: id, cycle: "3005", boss: BOSS, score, stars, clearTimeS: 170, cleared: true,
    teamDps: 60000, gameUid: who.gameUid, playedAt: 1792700000 + at, players,
    extra: { lineup: (lineup || party).map(([name, ai = false], slot) => ({ slot, name, ai, ...(name === who.name ? { self: true } : {}) })) } });
}
const bots = [["Flora", true], ["Mario", true], ["Tammy", true]];
const board = async (env) => (await (await call(env, `/api/leaderboard/interlink?cycle=3005&boss=${BOSS.id}&ladder=score&rows=teams`)).json()).bosses[0];

// three Solo runs on the board: 30000, 20000, 10000
async function threeOnTheBoard() {
  const made = await setup();
  const p = {};
  for (const name of ["Aster", "Briar", "Cobalt", "Dorian", "Ember"]) p[name] = await player(made.env, made.sqlite, name);
  await send(made.env, p.Aster, "a1", { score: 30000, party: [["Aster"], ...bots], at: 0 });
  await send(made.env, p.Briar, "b1", { score: 20000, party: [["Briar"], ...bots], at: 100 });
  await send(made.env, p.Cobalt, "c1", { score: 10000, party: [["Cobalt"], ...bots], at: 200 });
  return { ...made, p };
}

test("a run that is the sender's best: best with its place, as the board ranks it (team rows)", async () => {
  const { env, p } = await threeOnTheBoard();
  const sent = await send(env, p.Dorian, "d1", { score: 25000, party: [["Dorian"], ...bots], at: 300 });
  assert.deepEqual(sent.standing, { best: true, position: 2, of: 4, counts: "teams" });
  const row = (await board(env)).entries.find((entry) => entry.player === "Dorian");
  assert.equal(row.rank, sent.standing.position);
  assert.equal((await board(env)).teams, sent.standing.of);
  // the first run on a board is #1 of 1... and the others' answers had their place when sent
  const first = await setup();
  const q = await player(first.env, first.sqlite, "Fenwick");
  assert.deepEqual((await send(first.env, q, "f1", { score: 9000, party: [["Fenwick"], ...bots] })).standing, { best: true, position: 1, of: 1, counts: "teams" });
});

test("a run that isn't the sender's best: best false and no place, with one statement for the standing", async () => {
  const { env, p, statements } = await threeOnTheBoard();
  const before = statements.length;
  const sent = await send(env, p.Aster, "a2", { score: 12000, party: [["Aster"], ...bots], at: 400 });
  assert.deepEqual(sent.standing, { best: false });
  // one statement told it: the week's board (interlinkBests) is read only for a best
  const notBest = statements.slice(before);
  assert.equal(notBest.filter((sql) => sql.includes("standingPick")).length, 1);
  assert.equal(notBest.filter((sql) => sql.includes("AS memberUid")).length, 0);
  // fewer stars but a higher score than the best: the Score ladder ranks the score, so it is the row's run
  const mark = statements.length;
  const higher = await send(env, p.Aster, "a3", { score: 40000, stars: 20, party: [["Aster"], ...bots], at: 500 });
  assert.deepEqual(higher.standing, { best: true, position: 1, of: 3, counts: "teams" });
  assert.equal(statements.slice(mark).filter((sql) => sql.includes("AS memberUid")).length, 1);
});

test("an update of the best run (the same run sent again): best with its place, the answer says updated", async () => {
  const { env, p } = await threeOnTheBoard();
  const again = await send(env, p.Briar, "b1", { score: 20000, party: [["Briar"], ...bots], at: 100 });
  assert.equal(again.updated, true);
  assert.deepEqual(again.standing, { best: true, position: 2, of: 3, counts: "teams" });
  // an update of a run that is no longer the best: best false
  await send(env, p.Briar, "b2", { score: 35000, party: [["Briar"], ...bots], at: 600 });
  assert.deepEqual((await send(env, p.Briar, "b1", { score: 20000, party: [["Briar"], ...bots], at: 100 })).standing, { best: false });
});

test("a team run whose copy a team-mate sent first: this run, one team row, the same place for both senders", async () => {
  const { env, p } = await threeOnTheBoard();
  const duo = [["Dorian"], ["Ember"], ["Flora", true], ["Mario", true]];
  const first = await send(env, p.Dorian, "duo-d", { score: 25000, party: duo, at: 700 });
  const second = await send(env, p.Ember, "duo-e", { score: 25000, party: duo, at: 710 });
  assert.deepEqual(first.standing, { best: true, position: 2, of: 4, counts: "teams" });
  assert.deepEqual(second.standing, { best: true, position: 2, of: 4, counts: "teams" });
  const entries = (await board(env)).entries;
  assert.deepEqual(entries.filter((entry) => ["Dorian", "Ember"].includes(entry.player)).map((entry) => [entry.rank, entry.team]), [[2, 2], [2, 2]]);
});

test("a run held back or hidden has no standing: another party's Party screen, a held Sim run, a hidden re-send", async () => {
  const { env, sqlite, p } = await threeOnTheBoard();
  // an earlier party, then a run whose Party screen still shows it: hidden as it arrives
  const team = [["Dorian"], ["Brightfox"], ["Juniper"], ["Quillan"]];
  await send(env, p.Dorian, "d-first", { score: 5000, party: team, at: 800 });
  const stale = await send(env, p.Dorian, "d-stale", { score: 50000, party: [["Tarrow"], ["Dorian"], ["Vexley"], ["Hobnail"]], lineup: team, at: 900 });
  assert.equal(stale.hidden, "party");
  assert.ok(!("standing" in stale));
  // staff hid a run: its re-send tells nothing
  sqlite.prepare("UPDATE leaderboard_submissions SET status = 'hidden' WHERE client_run_id = 'c1'").run();
  assert.ok(!("standing" in await send(env, p.Cobalt, "c1", { score: 10000, party: [["Cobalt"], ...bots], at: 200 })));
  // a Holo-Battle Sim run its checks hold
  const held = await setup({ SIM_CHECK_LIMITS: JSON.stringify({ minTimeS: { Trial: 50 } }) });
  const q = await player(held.env, held.sqlite, "Gorse");
  const sim = await sendBody(held.env, q, { kind: "sim_run", clientRunId: "s1", trial: "Lightning Training", difficulty: "Trial", clearTimeS: 30, cleared: true, partySize: 1, playedAt: 1794700000 });
  assert.equal(sim.hidden, "check");
  assert.ok(!("standing" in sim));
});

test("an error inside the standing code: the send still answers ok, without a standing", async () => {
  const { env, p, control } = await threeOnTheBoard();
  control.failOn = /standingPick/u;
  const sent = await send(env, p.Dorian, "d1", { score: 25000, party: [["Dorian"], ...bots], at: 300 });
  assert.equal(sent.ok, true);
  assert.ok(!("standing" in sent));
  // the run is stored and on the board
  control.failOn = null;
  assert.equal((await board(env)).entries.find((entry) => entry.player === "Dorian").rank, 2);
  // and the week's board failing after a best was told: no standing either
  control.failOn = /ownBests|AS memberUid/u;
  const later = await send(env, p.Ember, "e1", { score: 26000, party: [["Ember"], ...bots], at: 400 });
  assert.equal(later.ok, true);
  assert.ok(!("standing" in later));
});

test("Holo-Battle Sim and Egg Heist matches: best with the place a profile states, best false for a slower or poorer run", async () => {
  const { env, sqlite } = await setup();
  const [a, b] = [await player(env, sqlite, "Aster"), await player(env, sqlite, "Briar")];
  const sim = (who, id, time, difficulty = "Trial") => sendBody(env, who, { kind: "sim_run", clientRunId: id, trial: "Lightning Training", difficulty,
    clearTimeS: time, cleared: true, partySize: 1, playedAt: 1794700000 });
  assert.deepEqual((await sim(a, "s1", 400)).standing, { best: true, position: 1, of: 1, counts: "players" });
  assert.deepEqual((await sim(b, "s2", 300)).standing, { best: true, position: 1, of: 2, counts: "players" });
  assert.deepEqual((await sim(a, "s3", 500)).standing, { best: false });
  assert.deepEqual((await sim(a, "s4", 350)).standing, { best: true, position: 2, of: 2, counts: "players" });
  // another difficulty is another board
  assert.deepEqual((await sim(a, "s5", 900, "Hard")).standing, { best: true, position: 1, of: 1, counts: "players" });
  const egg = (who, id, score) => sendBody(env, who, { kind: "eggheist_match", clientRunId: id, cycle: "S1", score, clearTimeS: 224, cleared: true,
    difficulty: "Normal", defeats: 1, playedAt: 1794700000 });
  assert.deepEqual((await egg(a, "e1", 20000)).standing, { best: true, position: 1, of: 1, counts: "players" });
  assert.deepEqual((await egg(b, "e2", 30000)).standing, { best: true, position: 1, of: 2, counts: "players" });
  assert.deepEqual((await egg(a, "e3", 10000)).standing, { best: false });
  // the profile's trophies say the same place
  const profile = await (await call(env, `/api/leaderboard/entries?kind=eggheist_match`)).json();
  assert.deepEqual(profile.entries.map((entry) => [entry.player, entry.rank]), [["Briar", 1], ["Aster", 2]]);
});

test("Interlink menu bests and Egg Heist seasons get no standing (not asked for)", async () => {
  const { env, sqlite } = await setup();
  const a = await player(env, sqlite, "Aster");
  const season = await sendBody(env, a, { kind: "eggheist_season", clientRunId: "season-S1", cycle: "S1", rankTier: 3, rankName: "Gold", score: 500, playedAt: 1794700000 });
  assert.ok(!("standing" in season));
});
