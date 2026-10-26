import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker, { leaderboardSubmission } from "../src/index.js";

const ORIGIN = "https://aniilogs.github.io";
const IDS = { dev: "111111111111111111", dev2: "333333333333333333", user: "222222222222222222" };
const SESSIONS = { dev: "d".repeat(48), dev2: "e".repeat(48), user: "u".repeat(48) };

async function tokenHash(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Buffer.from(digest).toString("base64url");
}

// A D1-shaped wrapper over a real in-memory SQLite database with every migration applied,
// so the leaderboard SQL (window functions, upserts, filters) runs for real.
async function database() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = resolve(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(resolve(dir, file), "utf8"));
  }
  const statement = (sql, values = []) => ({
    async first() {
      return sqlite.prepare(sql).get(...values) ?? null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...values) };
    },
    async run() {
      const result = sqlite.prepare(sql).run(...values);
      return { meta: { changes: Number(result.changes) } };
    },
  });
  const DB = {
    prepare(sql) {
      return { ...statement(sql), bind: (...values) => statement(sql, values) };
    },
    async batch(statements) {
      return Promise.all(statements.map((item) => item.run()));
    },
  };
  const now = Math.floor(Date.now() / 1000);
  for (const [key, discordId] of Object.entries(IDS)) {
    sqlite.prepare("INSERT INTO users VALUES (?, ?, ?, NULL, ?, ?)").run(discordId, key, `${key} name`, now, now);
    sqlite.prepare("INSERT INTO profiles (discord_id, display_name, bio, is_public, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)").run(discordId, `${key} name`, now, now);
    sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(await tokenHash(SESSIONS[key]), discordId, now, now + 3600);
  }
  return { DB, sqlite };
}

function evidenceStore() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, options) {
      objects.set(key, { bytes: new Uint8Array(await new Response(body).arrayBuffer()), type: options?.httpMetadata?.contentType });
    },
    async get(key) {
      const object = objects.get(key);
      return object ? { body: object.bytes, writeHttpMetadata: (headers) => headers.set("content-type", object.type) } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

async function setup(extraEnv = {}) {
  const { DB, sqlite } = await database();
  const env = { DB, PUBLIC_SITE_ORIGIN: ORIGIN, DEVELOPER_DISCORD_IDS: `${IDS.dev},${IDS.dev2}`, ...extraEnv };
  return { env, sqlite };
}

// Website call (session + site origin) or desktop call (leaderboard token, no origin).
function call(env, path, { session, token, method = "GET", body, form } = {}) {
  const headers = new Headers();
  if (session) {
    headers.set("authorization", `Bearer ${session}`);
    headers.set("origin", ORIGIN);
  }
  if (token) headers.set("authorization", `Bearer ${token}`);
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  return worker.fetch(new Request(`https://api.aniilogs.example${path}`, { method, headers, body: payload }), env);
}

// A desktop token whose account has a character, as the app links one: the boards only list players with a name.
const TEST_CHARACTERS = { [SESSIONS.dev]: ["301000000001", "DevOne"], [SESSIONS.dev2]: ["301000000002", "DevTwo"], [SESSIONS.user]: ["301000000003", "UserOne"] };
async function namedToken(env, session = SESSIONS.dev) {
  const token = await desktopToken(env, session);
  const [gameUid, name] = TEST_CHARACTERS[session];
  await call(env, "/api/leaderboard/characters", { token, method: "POST", body: { gameUid, name } });
  return token;
}

async function desktopToken(env, session = SESSIONS.dev) {
  const response = await call(env, "/api/leaderboard/tokens", { session, method: "POST", body: { label: "PC" } });
  assert.equal(response.status, 201);
  const { token } = await response.json();
  assert.match(token, /^alb_[A-Za-z0-9_-]{40,}$/u);
  return token;
}

function run(id, overrides = {}) {
  return {
    kind: "interlink_run",
    clientRunId: id,
    cycle: "3005",
    boss: { id: "80000107", name: "Omega Infergon", level: 60 },
    score: 20000,
    stars: 20,
    clearTimeS: 180,
    cleared: false,
    teamDps: 40000,
    meterDps: 40100,
    players: [
      { name: "MinMax", stat: "Total Damage Dealt", value: 2457849, avgDps: 25913 },
      { name: "Leonard", avgDps: 3469, ai: true },
    ],
    playedAt: 1792700000,
    ...overrides,
  };
}

test("submission validation normalizes good records and rejects bad ones", () => {
  const { record } = leaderboardSubmission(run("a"));
  assert.equal(record.mode, "interlink");
  assert.equal(record.partySize, 2);
  assert.equal(JSON.parse(record.playersJson)[1].ai, true);
  assert.match(leaderboardSubmission({ ...run("a"), kind: "pvp" }).error, /kind/u);
  assert.match(leaderboardSubmission({ ...run("a"), clientRunId: "../x" }).error, /clientRunId/u);
  assert.match(leaderboardSubmission({ ...run("a"), score: -1 }).error, /score/u);
  assert.match(leaderboardSubmission({ ...run("a"), players: [{}, {}, {}, {}, {}] }).error, /players/u);
  assert.match(leaderboardSubmission({ ...run("a"), extra: { blob: "x".repeat(9000) } }).error, /extra/u);
});

test("leaderboards are gated to developers until made public", async () => {
  const { env } = await setup();
  assert.equal((await call(env, "/api/leaderboard/entries")).status, 401);
  assert.equal((await call(env, "/api/leaderboard/entries", { session: SESSIONS.user })).status, 403);
  const status = await (await call(env, "/api/leaderboard/status", { session: SESSIONS.user })).json();
  assert.equal(status.canRead, false);
  assert.equal(status.public, false);
  assert.equal((await call(env, "/api/leaderboard/tokens", { session: SESSIONS.user, method: "POST", body: {} })).status, 403);
  assert.equal((await call(env, "/api/leaderboard/entries", { session: SESSIONS.dev })).status, 200);

  const open = await setup({ LEADERBOARD_PUBLIC: "true" });
  assert.equal((await call(open.env, "/api/leaderboard/entries")).status, 200);
  const token = await desktopToken(open.env, SESSIONS.user);
  assert.equal((await call(open.env, "/api/leaderboard/submissions", { token, method: "POST", body: run("u1") })).status, 201);
});

test("desktop tokens submit without an origin, upsert by run id, and stop working once revoked", async () => {
  const { env } = await setup();
  const token = await namedToken(env);
  const first = await call(env, "/api/leaderboard/submissions", { token, method: "POST", body: run("fight-1") });
  assert.equal(first.status, 201);
  const again = await call(env, "/api/leaderboard/submissions", { token, method: "POST", body: run("fight-1", { score: 22652 }) });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).updated, true);
  const entries = await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0", { session: SESSIONS.dev })).json();
  assert.equal(entries.total, 1);
  assert.equal(entries.entries[0].score, 22652);

  const listed = await (await call(env, "/api/leaderboard/tokens", { session: SESSIONS.dev })).json();
  assert.equal(listed.tokens.length, 1);
  assert.notEqual(listed.tokens[0].lastUsedAt, null);
  assert.equal((await call(env, `/api/leaderboard/tokens/${listed.tokens[0].tokenId}`, { session: SESSIONS.dev, method: "DELETE" })).status, 200);
  assert.equal((await call(env, "/api/leaderboard/submissions", { token, method: "POST", body: run("fight-2") })).status, 401);

  const bad = await call(env, "/api/leaderboard/submissions", { session: SESSIONS.dev, method: "POST", body: { kind: "nope" } });
  assert.equal(bad.status, 400);
});

test("entries rank best per player, sort by any board, and filter by the data", async () => {
  const { env } = await setup();
  const devToken = await namedToken(env, SESSIONS.dev);
  const dev2Token = await namedToken(env, SESSIONS.dev2);
  const submit = (token, body) => call(env, "/api/leaderboard/submissions", { token, method: "POST", body });
  await submit(devToken, run("a1", { score: 20000, teamDps: 30000 }));
  await submit(devToken, run("a2", { score: 22652, teamDps: 41000, cleared: true, clearTimeS: 150 }));
  await submit(dev2Token, run("b1", { score: 21000, teamDps: 50000, cleared: true, clearTimeS: 120, players: [{ name: "Solo" }] }));
  await submit(dev2Token, run("b2", { score: 30000, boss: { id: "80000100", name: "Omega Tucking", level: 60 } }));

  const get = async (query) => (await call(env, `/api/leaderboard/entries?${query}`, { session: SESSIONS.dev })).json();
  const byScore = await get("kind=interlink_run&boss=80000107");
  assert.deepEqual(byScore.entries.map((entry) => [entry.player, entry.score, entry.rank]), [["DevOne", 22652, 1], ["DevTwo", 21000, 2]]);   // their characters' names: never a party slot (the sender isn't always 1P) or an account name
  assert.equal(JSON.stringify(byScore).includes("name\""), true);
  assert.equal(/dev2? name|"dev"|"dev2"/u.test(JSON.stringify(byScore.entries.map((entry) => entry.player))), false);
  assert.equal(byScore.entries[0].own, true);
  assert.equal((await get("kind=interlink_run&boss=80000107&best=0")).total, 3);

  const byDps = await get("kind=interlink_run&boss=80000107&sort=team_dps");
  assert.equal(byDps.entries[0].teamDps, 50000);
  const fastest = await get("kind=interlink_run&sort=clear_time_s");
  assert.deepEqual(fastest.entries.map((entry) => entry.clearTimeS), [120, 150]);
  assert.equal(fastest.order, "asc");

  assert.equal((await get("kind=interlink_run&party=1")).total, 1);
  assert.equal((await get("kind=interlink_run&player=MinMax")).total, 2);
  assert.equal((await get("kind=interlink_run&player=%25")).total, 0);
  assert.equal((await get("kind=interlink_run&sort=score; DROP TABLE users")).sort, "score");

  const facets = await (await call(env, "/api/leaderboard/facets?mode=interlink", { session: SESSIONS.dev })).json();
  assert.deepEqual(facets.bosses.map((boss) => boss.name), ["Omega Infergon", "Omega Tucking"]);
  assert.deepEqual(facets.cycles.map((cycle) => cycle.value), ["3005"]);
});

test("sim runs rank by clear time and filter by rogue buffs", async () => {
  const { env } = await setup();
  const token = await namedToken(env);
  const sim = (id, time, buffs) => ({
    kind: "sim_run", clientRunId: id, clearTimeS: time, cleared: true, floors: 16,
    buffs: buffs.map((name, floor) => ({ name, floor: floor + 1 })),
  });
  for (const body of [sim("s1", 2400, ["Trick Bomb", "Multi-Cast"]), sim("s2", 1800, ["Multi-Cast"])]) {
    assert.equal((await call(env, "/api/leaderboard/submissions", { token, method: "POST", body })).status, 201);
  }
  const all = await (await call(env, "/api/leaderboard/entries?kind=sim_run&best=0", { session: SESSIONS.dev })).json();
  assert.deepEqual(all.entries.map((entry) => entry.clearTimeS), [1800, 2400]);
  const withBomb = await (await call(env, "/api/leaderboard/entries?kind=sim_run&best=0&buff=Trick%20Bomb", { session: SESSIONS.dev })).json();
  assert.equal(withBomb.total, 1);
  const facets = await (await call(env, "/api/leaderboard/facets?mode=sim", { session: SESSIONS.dev })).json();
  assert.deepEqual(facets.buffs, [{ name: "Multi-Cast", count: 2 }, { name: "Trick Bomb", count: 1 }]);
});

test("developers can hide entries; evidence is private to the submitter and developers", async () => {
  const EVIDENCE = evidenceStore();
  const { env } = await setup({ EVIDENCE, LEADERBOARD_PUBLIC: "true" });
  const userToken = await namedToken(env, SESSIONS.user);
  const form = new FormData();
  form.set("submission", JSON.stringify(run("with-shot")));
  form.set("evidence", new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "result.jpg");
  const submitted = await call(env, "/api/leaderboard/submissions", { token: userToken, method: "POST", form });
  assert.equal(submitted.status, 201);
  const { submissionId, evidenceStored } = await submitted.json();
  assert.equal(evidenceStored, true);
  assert.equal(EVIDENCE.objects.size, 1);

  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}/evidence`, { session: SESSIONS.user })).status, 200);
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}/evidence`, { session: SESSIONS.dev })).status, 200);
  const outsider = await setup({ EVIDENCE, LEADERBOARD_PUBLIC: "true" });
  assert.equal((await call(outsider.env, `/api/leaderboard/submissions/${submissionId}/evidence`)).status, 401);

  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { session: SESSIONS.user, method: "PATCH", body: { status: "hidden" } })).status, 403);
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { session: SESSIONS.dev, method: "PATCH", body: { status: "hidden" } })).status, 200);
  assert.equal((await (await call(env, "/api/leaderboard/entries?kind=interlink_run", { session: SESSIONS.user })).json()).total, 0);
  assert.equal((await (await call(env, "/api/leaderboard/entries?kind=interlink_run&hidden=1", { session: SESSIONS.dev })).json()).total, 1);

  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { token: userToken, method: "DELETE" })).status, 200);
  assert.equal(EVIDENCE.objects.size, 0);
});

test("characters link to one account, show on the board, and protect submissions", async () => {
  const { env } = await setup();
  const devToken = await desktopToken(env, SESSIONS.dev);
  const dev2Token = await desktopToken(env, SESSIONS.dev2);
  const link = (token, body) => call(env, "/api/leaderboard/characters", { token, method: "POST", body });

  const claimed = await link(devToken, { gameUid: "302000105986", name: "MinMax" });
  assert.equal(claimed.status, 201);
  assert.equal((await claimed.json()).verified, false);                      // no game-menu proof sent
  assert.equal((await link(devToken, { gameUid: "302000105986", name: "MinMax2" })).status, 200);
  assert.equal((await link(dev2Token, { gameUid: "302000105986", name: "Thief" })).status, 409);
  assert.equal((await link(devToken, { gameUid: "abc" })).status, 400);

  const mine = await (await call(env, "/api/leaderboard/characters", { session: SESSIONS.dev })).json();
  assert.deepEqual(mine.characters.map((row) => [row.gameUid, row.name]), [["302000105986", "MinMax2"]]);

  // Someone else can't post scores as this character.
  const stolen = await call(env, "/api/leaderboard/submissions", { token: dev2Token, method: "POST", body: run("x", { gameUid: "302000105986" }) });
  assert.equal(stolen.status, 409);
  assert.equal((await call(env, "/api/leaderboard/submissions", { token: devToken, method: "POST", body: run("y", { gameUid: "302000105986" }) })).status, 201);
  const board = await (await call(env, "/api/leaderboard/entries?kind=interlink_run&player=MinMax2", { session: SESSIONS.dev })).json();
  assert.equal(board.entries[0].character, "MinMax2");

  // A developer settles a dispute by moving the UID; the old owner can no longer use it.
  const moved = await call(env, "/api/admin/characters/302000105986", { session: SESSIONS.dev2, method: "PUT", body: { discordId: IDS.dev2 } });
  assert.equal(moved.status, 200);
  assert.equal((await call(env, "/api/leaderboard/submissions", { token: devToken, method: "POST", body: run("z", { gameUid: "302000105986" }) })).status, 409);
  assert.equal((await call(env, "/api/admin/characters/302000105986", { session: SESSIONS.user, method: "PUT", body: { discordId: IDS.user } })).status, 403);
  assert.equal((await call(env, "/api/leaderboard/characters/302000105986", { token: dev2Token, method: "DELETE" })).status, 200);
});

// A link with the game menu's proof, as the desktop app sends it.
function proofForm(fields, bytes = [137, 80, 78, 71, 1, 2, 3]) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set("proof", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "menu.png");
  return form;
}

test("characters are linked from the app only; proof takes over an unproven link; proven ones only move by dispute", async () => {
  const { env } = await setup();
  const a = await desktopToken(env, SESSIONS.dev);
  const b = await desktopToken(env, SESSIONS.dev2);
  const link = (token, form) => call(env, "/api/leaderboard/characters", { token, method: "POST", form });
  const uid = "302000555555";

  // the website can't link one by hand
  assert.equal((await call(env, "/api/leaderboard/characters", { session: SESSIONS.dev, method: "POST", body: { gameUid: uid, name: "Typed" } })).status, 403);

  // an unproven link (an older app) is taken over by a proven one from another account
  assert.equal((await call(env, "/api/leaderboard/characters", { token: a, method: "POST", body: { gameUid: uid, name: "Troll" } })).status, 201);
  const proven = await link(b, proofForm({ gameUid: uid, name: "Kaela" }));
  assert.equal(proven.status, 201);
  assert.equal((await proven.json()).verified, true);

  // once proven, an unproven reading can't rename it and another account's proof can't take it: it may send a dispute
  assert.equal((await call(env, "/api/leaderboard/characters", { token: b, method: "POST", body: { gameUid: uid, name: "Typo" } })).status, 200);
  const held = await (await call(env, "/api/leaderboard/characters", { session: SESSIONS.dev2 })).json();
  assert.deepEqual(held.characters.map((c) => [c.name, Boolean(c.verified)]), [["Kaela", true]]);
  const refused = await link(a, proofForm({ gameUid: uid, name: "Kaela" }));
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).dispute, true);

  // a dispute needs proof, comes from the app, and changes nothing until a developer decides
  const dispute = (form) => call(env, "/api/leaderboard/characters/disputes", { token: a, method: "POST", form });
  const noProof = new FormData(); noProof.set("gameUid", uid); noProof.set("name", "Kaela");
  assert.equal((await dispute(noProof)).status, 400);
  const sent = await dispute(proofForm({ gameUid: uid, name: "Kaela", note: "My main" }));
  assert.equal(sent.status, 201);
  const { disputeId } = await sent.json();
  assert.equal((await call(env, "/api/admin/character-disputes", { session: SESSIONS.user })).status, 403);
  const list = await (await call(env, "/api/admin/character-disputes", { session: SESSIONS.dev })).json();
  assert.deepEqual(list.disputes.map((d) => [d.gameUid, d.status, d.holderId]), [[uid, "open", IDS.dev2]]);
  assert.equal((await call(env, `/api/admin/character-disputes/${disputeId}/proof`, { session: SESSIONS.dev })).headers.get("content-type"), "image/png");
  assert.equal((await call(env, `/api/admin/characters/${uid}/proof`, { session: SESSIONS.dev })).status, 200);
  assert.equal((await call(env, `/api/admin/character-disputes/${disputeId}`, { session: SESSIONS.dev, method: "PATCH", body: { action: "grant" } })).status, 200);
  const moved = await (await call(env, "/api/leaderboard/characters", { session: SESSIONS.dev })).json();
  assert.deepEqual(moved.characters.map((c) => [c.gameUid, c.name, Boolean(c.verified)]), [[uid, "Kaela", true]]);
  assert.equal((await call(env, `/api/admin/character-disputes/${disputeId}`, { session: SESSIONS.dev, method: "PATCH", body: { action: "grant" } })).status, 409);
});

test("every real teammate gets a row; only a UID recorded with the run claims it, never a name", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await desktopToken(env, SESSIONS.dev);
  const b = await desktopToken(env, SESSIONS.dev2);
  const c = await desktopToken(env, SESSIONS.user);
  const send = (token, body) => call(env, "/api/leaderboard/submissions", { token, method: "POST", body });
  const link = (token, gameUid, name) => call(env, "/api/leaderboard/characters", { token, method: "POST", form: proofForm({ gameUid, name }) });
  await link(a, "302000000001", "MinMax");
  const sherro = { id: "80000109", name: "Omega Sherro", level: 60 };
  // dev's run: dev (self), Kaela (real, her UID known), Rook (real, no UID), Tammy (AI)
  assert.equal((await send(a, run("t1", { gameUid: "302000000001", boss: sherro, score: 14000, stars: 14, players: [
    { name: "MinMax", self: true, ai: false }, { name: "Kaela", ai: false, uid: "302000000002" },
    { name: "Rook", ai: false }, { name: "Tammy", ai: true }] }))).status, 201);
  const board = async () => (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json()).bosses.find((x) => x.id === "80000109").entries;
  assert.deepEqual((await board()).map((e) => [e.player, e.score, e.uid, e.unclaimed]),
    [["MinMax", 14000, "302000000001", false], ["Kaela", 14000, null, true], ["Rook", 14000, null, true]]);   // no AI row

  // someone proves the name "Rook" later: a name alone claims nothing, so Rook's row stays where it is
  await link(c, "302000000099", "Rook");
  assert.deepEqual((await board()).filter((e) => e.player === "Rook").map((e) => e.unclaimed), [true]);

  // Kaela proves her UID: the row recorded with it becomes hers, with her UID on hover
  await link(b, "302000000002", "Kaela");
  const kaela = (await board()).find((e) => e.player === "Kaela");
  assert.deepEqual([kaela.unclaimed, kaela.uid], [false, "302000000002"]);

  // a lookalike of a claimed name is marked on unclaimed rows
  await send(a, run("t2", { gameUid: "302000000001", boss: sherro, score: 9000, stars: 9, players: [
    { name: "MinMax", self: true, ai: false }, { name: "Ka3la", ai: false }] }));
  assert.equal((await board()).find((e) => e.player === "Ka3la").lookalike, true);
  assert.equal((await board()).find((e) => e.player === "Rook").lookalike, false);
});

test("two app users sending the same run vouch for each other: each teammate slot gets the other's UID", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await desktopToken(env, SESSIONS.dev);
  const b = await desktopToken(env, SESSIONS.dev2);
  const c = await desktopToken(env, SESSIONS.user);
  const send = (token, body) => call(env, "/api/leaderboard/submissions", { token, method: "POST", body });
  // Kaela's app linked her character without menu proof (an older app): the vouching alone ties her slot to her
  await call(env, "/api/leaderboard/characters", { token: b, method: "POST", body: { gameUid: "302000000002", name: "Kaela" } });
  await call(env, "/api/leaderboard/characters", { token: a, method: "POST", form: proofForm({ gameUid: "302000000001", name: "MinMax" }) });
  await call(env, "/api/leaderboard/characters", { token: c, method: "POST", form: proofForm({ gameUid: "302000000003", name: "Rook" }) });
  const tucking = { id: "80000100", name: "Omega Tucking", level: 60 };
  const party = (me) => [{ name: "MinMax", ai: false, self: me === "MinMax" }, { name: "Kaela", ai: false, self: me === "Kaela" }, { name: "Tammy", ai: true }];
  const shared = { boss: tucking, score: 16064, stars: 15, clearTimeS: 150, cleared: true, playedAt: 1792700000 };
  await send(a, run("m1", { ...shared, gameUid: "302000000001", players: party("MinMax") }));
  await send(b, run("k1", { ...shared, gameUid: "302000000002", playedAt: 1792700060, players: party("Kaela") }));
  // a different run (another score) sent by someone else is not the same run
  await send(c, run("x1", { ...shared, score: 15000, gameUid: "302000000003", players: [{ name: "Rook", ai: false, self: true }, { name: "MinMax", ai: false }] }));

  const entries = (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json()).bosses.find((x) => x.id === "80000100").entries;
  // MinMax and Kaela once each (their teammate rows merged into their own), plus Rook's run with its unclaimed MinMax row
  assert.deepEqual(entries.map((e) => [e.player, e.score, e.unclaimed]).sort(),
    [["Kaela", 16064, false], ["MinMax", 15000, true], ["MinMax", 16064, false], ["Rook", 15000, false]].sort());
  const mine = await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0", { session: SESSIONS.dev })).json();
  const myRun = mine.entries.find((e) => e.submissionId && e.own && e.player === "MinMax" && e.score === 16064 && !e.teammate);
  assert.ok(myRun);
  assert.equal(JSON.stringify(mine).includes("302000000002\",\"confirmed"), false);              // recorded UIDs stay server-side
});

test("only runs played and sent within five minutes vouch; prep-screen scores and late runs never do", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await desktopToken(env, SESSIONS.dev);
  const b = await desktopToken(env, SESSIONS.dev2);
  const c = await desktopToken(env, SESSIONS.user);
  const send = (token, body) => call(env, "/api/leaderboard/submissions", { token, method: "POST", body });
  for (const [token, gameUid, name] of [[a, "302000000001", "MinMax"], [b, "302000000002", "Kaela"], [c, "302000000003", "Rook"]]) {
    await call(env, "/api/leaderboard/characters", { token, method: "POST", form: proofForm({ gameUid, name }) });
  }
  const sherro = { id: "80000109", name: "Omega Sherro", level: 60 };
  const shared = { boss: sherro, score: 24459, stars: 15, clearTimeS: 120, cleared: true };
  const vouched = (sqlRow) => (JSON.parse(sqlRow.players_json).find((p) => p.name === "Kaela") || {}).confirmed === true;
  await send(a, run("m1", { ...shared, gameUid: "302000000001", playedAt: 1792700000,
    players: [{ name: "MinMax", ai: false, self: true }, { name: "Kaela", ai: false }, { name: "Rook", ai: false }] }));

  // the same best score read off the prep screen (no run, no timer, no party) proves nothing
  await send(b, { kind: "interlink_best", clientRunId: "best-3005-80000109", cycle: "3005", boss: sherro, score: 24459, stars: 15 });
  const mine = () => sqlite.prepare("SELECT players_json FROM leaderboard_submissions WHERE client_run_id = 'm1'").get();
  assert.equal(vouched(mine()), false);

  // the same score from a run played more than five minutes apart is another run
  await send(b, run("k-other", { ...shared, gameUid: "302000000002", playedAt: 1792700000 + 6 * 60,
    players: [{ name: "Kaela", ai: false, self: true }, { name: "MinMax", ai: false }] }));
  assert.equal(vouched(mine()), false);

  // played together, but sent more than five minutes after the first one: too late to vouch
  sqlite.prepare("UPDATE leaderboard_submissions SET created_at = created_at - 600 WHERE client_run_id = 'm1'").run();
  await send(b, run("k-late", { ...shared, gameUid: "302000000002", playedAt: 1792700030,
    players: [{ name: "Kaela", ai: false, self: true }, { name: "MinMax", ai: false }] }));
  assert.equal(vouched(mine()), false);

  // played together and sent together: vouched (a run from another dungeon instance with everything else equal isn't)
  sqlite.prepare("UPDATE leaderboard_submissions SET created_at = created_at + 600, extra_json = '{\"instanceId\":\"at74A81j3-Zl0_Dm\"}' WHERE client_run_id = 'm1'").run();
  await send(b, run("k-elsewhere", { ...shared, gameUid: "302000000002", playedAt: 1792700030, extra: { instanceId: "zzOtherDungeon" },
    players: [{ name: "Kaela", ai: false, self: true }, { name: "MinMax", ai: false }] }));
  assert.equal(vouched(mine()), false);
  const listed = await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0", { session: SESSIONS.dev })).json();
  assert.equal(JSON.stringify(listed).includes("at74A81j3"), false);                        // the instance id stays private
  await send(b, run("k-now", { ...shared, gameUid: "302000000002", playedAt: 1792700030, extra: { instanceId: "at74A81j3-Zl0_Dm" },
    players: [{ name: "Kaela", ai: false, self: true }, { name: "MinMax", ai: false }] }));
  assert.equal(vouched(mine()), true);
});

test("the boards list only players with a name; a nameless account's records wait for its character", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const named = await namedToken(env, SESSIONS.dev);
  const nameless = await desktopToken(env, SESSIONS.dev2);            // its app never read a name: no character
  const send = (token, body) => call(env, "/api/leaderboard/submissions", { token, method: "POST", body });
  await send(named, run("n1", { score: 12000 }));
  await send(nameless, run("x1", { score: 16445, players: [{ name: null }, { name: "Mario", ai: true }] }));
  const board = async () => (await (await call(env, "/api/leaderboard/entries?kind=interlink_run")).json()).entries.map((e) => e.player);
  assert.deepEqual(await board(), ["DevOne"]);
  const week = await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json();
  assert.deepEqual(week.bosses.flatMap((b) => b.entries.map((e) => e.player)), ["DevOne"]);
  // their own list still shows it, and once their app links a character it appears under that name
  const own = await (await call(env, "/api/leaderboard/entries?kind=interlink_run&mine=1", { token: nameless })).json();
  assert.equal(own.entries.length, 1);
  await call(env, "/api/leaderboard/characters", { token: nameless, method: "POST", body: { gameUid: "301000000009", name: "LateName" } });
  assert.deepEqual(await board(), ["LateName", "DevOne"]);
});

test("boards filter by game server; runs from different servers never vouch for each other", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await namedToken(env, SESSIONS.dev);
  const b = await namedToken(env, SESSIONS.dev2);
  const send = (token, body) => call(env, "/api/leaderboard/submissions", { token, method: "POST", body });
  const shared = { score: 24459, stars: 15, clearTimeS: 120, cleared: true, playedAt: 1792700000 };
  await send(a, run("na", { ...shared, server: "Aniimo-Americas", players: [{ name: "DevOne", ai: false, self: true }, { name: "DevTwo", ai: false }] }));
  await send(b, run("eu", { ...shared, server: "Aniimo-Europe", players: [{ name: "DevTwo", ai: false, self: true }, { name: "DevOne", ai: false }] }));
  await send(b, run("old", { score: 9000, stars: 9 }));                                    // an older app: no server

  const facets = await (await call(env, "/api/leaderboard/facets?mode=interlink")).json();
  assert.deepEqual(facets.servers.map((x) => x.value).sort(), ["Aniimo-Americas", "Aniimo-Europe"]);
  const players = async (query) => (await (await call(env, `/api/leaderboard/entries?kind=interlink_run&best=0&${query}`)).json()).entries
    .filter((e) => !e.teammate).map((e) => [e.player, e.server]);
  assert.deepEqual(await players("server=Aniimo-Americas"), [["DevOne", "Aniimo-Americas"]]);
  assert.equal((await players("")).length, 3);                                            // all servers
  const week = await (await call(env, "/api/leaderboard/interlink?cycle=3005&server=Aniimo-Europe")).json();
  assert.equal(week.server, "Aniimo-Europe");
  assert.deepEqual(week.servers.map((x) => x.value).sort(), ["Aniimo-Americas", "Aniimo-Europe"]);
  assert.deepEqual(week.bosses.flatMap((x) => x.entries).filter((e) => !e.unclaimed).map((e) => e.player), ["DevTwo"]);

  // same week, boss, score, stars, time and moment - but two servers: not the same run, so nobody vouches
  const slots = (id) => JSON.parse(sqlite.prepare("SELECT players_json FROM leaderboard_submissions WHERE client_run_id = ?").get(id).players_json);
  assert.equal(slots("na").some((p) => p.confirmed), false);
  assert.equal(slots("eu").some((p) => p.confirmed), false);
});

test("Egg Heist season standings rank by tier, then Emperor stars, then rank points", async () => {
  const { env } = await setup();
  const devToken = await namedToken(env, SESSIONS.dev);
  const dev2Token = await namedToken(env, SESSIONS.dev2);
  const standing = (id, season, tier, subtier, name, points, stars = null) => ({
    kind: "eggheist_season", clientRunId: id, cycle: season, rank: { tier, subtier, name }, score: points, stars,
  });
  const submit = async (token, body) => (await call(env, "/api/leaderboard/submissions", { token, method: "POST", body })).status;
  assert.equal(await submit(devToken, standing("eh-S1", "S1", 3, 2, "Pro Egg Snatcher III", 1277)), 201);
  assert.equal(await submit(devToken, standing("eh-S1", "S1", 7, 1, "Egg Emperor", 2900, 475)), 200);   // same season: updated
  assert.equal(await submit(dev2Token, standing("eh-S1", "S1", 7, 1, "Egg Emperor", 3100, 300)), 201);
  assert.equal(await submit(dev2Token, standing("eh-S0", "S0", 4, 1, "Elite Egg Seeker IV", 2400)), 201);
  assert.match(leaderboardSubmission(standing("bad", "S1", 8, 1, "Nope", 1)).error, /rankTier/u);

  const get = async (query) => (await call(env, `/api/leaderboard/entries?${query}`, { session: SESSIONS.dev })).json();
  const s1 = await get("kind=eggheist_season&cycle=S1");
  assert.equal(s1.sort, "standing");
  // Both Emperors; more stars first even though the other has more rank points.
  assert.deepEqual(s1.entries.map((entry) => [entry.player, entry.seasonRank.name, entry.stars]),
    [["DevOne", "Egg Emperor", 475], ["DevTwo", "Egg Emperor", 300]]);
  const all = await get("kind=eggheist_season");
  // One standing per player per season; Emperors above a lower tier with more points.
  assert.deepEqual(all.entries.map((entry) => [entry.player, entry.cycle, entry.seasonRank.tier]),
    [["DevOne", "S1", 7], ["DevTwo", "S1", 7], ["DevTwo", "S0", 4]]);
  const byPoints = await get("kind=eggheist_season&sort=score");
  assert.deepEqual(byPoints.entries.map((entry) => entry.score), [3100, 2900, 2400]);
  const facets = await (await call(env, "/api/leaderboard/facets?mode=eggheist", { session: SESSIONS.dev })).json();
  assert.deepEqual(facets.cycles.map((row) => row.value), ["S1", "S0"]);
});

test("completion flags merge by newest change, so stale copies cannot undo the desktop app", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const save = (progress) => call(env, "/api/progress", { session: SESSIONS.user, method: "PUT", body: { progress } });
  const read = async () => (await (await call(env, "/api/progress", { session: SESSIONS.user })).json()).progress;
  assert.equal((await save({ tracking: [], completed: ["old", "pin:a"], preferences: {} })).status, 200);

  const token = await desktopToken(env, SESSIONS.user);
  const patch = await call(env, "/api/progress/completed", { token, method: "PATCH", body: { set: ["aniimo:1:sparkling"], clear: ["old"] } });
  assert.equal(patch.status, 200);
  assert.deepEqual(await (await call(env, "/api/progress/completed", { token })).json().then((value) => value.completed.sort()),
    ["aniimo:1:sparkling", "pin:a"]);

  // A browser tab that loaded before the app's change saves its stale copy: the app's set and clear survive.
  assert.equal((await save({ tracking: [{ id: "timer" }], completed: ["old", "pin:a"], preferences: { theme: "x" } })).status, 200);
  let progress = await read();
  assert.deepEqual(progress.completed.sort(), ["aniimo:1:sparkling", "pin:a"]);
  assert.deepEqual(progress.tracking, [{ id: "timer" }]);
  assert.equal(progress.completedChanges.old[0], 0);

  // A newer clear from the website wins over the app's earlier set.
  const later = Date.now() + 1000;
  await save({ tracking: [], completed: ["pin:a"], completedChanges: { "aniimo:1:sparkling": [0, later] }, preferences: {} });
  progress = await read();
  assert.deepEqual(progress.completed, ["pin:a"]);

  const bad = await call(env, "/api/progress/completed", { token, method: "PATCH", body: { set: [42] } });
  assert.equal(bad.status, 400);
  assert.equal((await call(env, "/api/progress/completed", { method: "PATCH", body: { set: ["x"] } })).status, 401);
});

test("the profile overview gathers the owner's characters, board positions and collection progress", async () => {
  const checklist = {
    entries: [
      { category: "aniimo", completion_states: [{ id: "aniimo:1:standard" }, { id: "aniimo:1:sparkling" }] },
      { category: "aniimo", completion_states: [{ id: "aniimo:2:standard" }, { id: "aniimo:2:sparkling" }] },
      { category: "aniimo", counts_toward_total: false, completion_states: [{ id: "aniimo:3:standard" }] },
      { category: "ambers", completion_states: [{ id: "amber:overworld:a:collected", quantity: 1 }] },
      { category: "ambers", completion_states: [{ id: "amber:quest:b:collected", quantity: 3 }] },
    ],
    special_entries: [{ id: "aniimo-special:9" }],
  };
  const CONTENT = {
    async get(key) {
      return key.endsWith("/data/checklist_data.json") ? { body: JSON.stringify(checklist) } : null;
    },
  };
  const { env } = await setup({ CONTENT, CONTENT_RELEASE_ENABLED: "true" });
  const devToken = await desktopToken(env, SESSIONS.dev);
  const dev2Token = await desktopToken(env, SESSIONS.dev2);
  const submit = async (token, body) => (await call(env, "/api/leaderboard/submissions", { token, method: "POST", body })).status;
  await call(env, "/api/leaderboard/characters", { token: devToken, method: "POST", body: { gameUid: "302000105986", name: "MinMax" } });
  await submit(devToken, run("a1", { score: 20000, gameUid: "302000105986" }));
  await submit(devToken, run("a2", { score: 22000, gameUid: "302000105986" }));
  await submit(dev2Token, run("b1", { score: 25000 }));
  await submit(devToken, run("t1", { score: 9000, boss: { id: "80000100", name: "Omega Tucking", level: 60 } }));
  await submit(dev2Token, run("w1", { kind: "interlink_week", score: 70000 }));
  await submit(devToken, { kind: "sim_run", clientRunId: "s1", clearTimeS: 1800, cleared: true, floors: 16 });
  await submit(dev2Token, { kind: "sim_run", clientRunId: "s2", clearTimeS: 2400, cleared: true, floors: 16 });
  await submit(devToken, { kind: "eggheist_season", clientRunId: "eh", cycle: "S1", rank: { tier: 7, subtier: 1, name: "Egg Emperor" }, score: 2900, stars: 475 });
  await submit(dev2Token, { kind: "eggheist_season", clientRunId: "eh", cycle: "S1", rank: { tier: 7, subtier: 1, name: "Egg Emperor" }, score: 3100, stars: 500 });
  await call(env, "/api/progress/completed", {
    token: devToken,
    method: "PATCH",
    body: { set: ["aniimo:1:standard", "aniimo:1:sparkling", "aniimo:2:standard", "amber:quest:b:collected", "pin:m:1:c:collected", "pin:m:2:c:collected"] },
  });

  const response = await call(env, "/api/profile/overview", { session: SESSIONS.dev });
  assert.equal(response.status, 200);
  const overview = await response.json();
  assert.equal(overview.profile.displayName, "dev name");
  assert.equal(overview.profile.isPublic, false);
  assert.deepEqual(overview.characters.map((row) => [row.gameUid, row.name]), [["302000105986", "MinMax"]]);

  const { interlink_run: runs, interlink_week: weeks, sim_run: sims, eggheist_season: heists } = overview.leaderboards;
  // Best per boss, ranked among every player on that boss, as the board shows it.
  assert.deepEqual(runs.map((row) => [row.boss.name, row.score, row.position, row.players, row.character]),
    [["Omega Infergon", 22000, 2, 2, "MinMax"], ["Omega Tucking", 9000, 1, 1, null]]);
  assert.deepEqual(weeks, []);
  assert.deepEqual(sims.map((row) => [row.clearTimeS, row.position, row.players]), [[1800, 1, 2]]);
  assert.deepEqual(heists.map((row) => [row.cycle, row.seasonRank.name, row.stars, row.score, row.position, row.players]),
    [["S1", "Egg Emperor", 475, 2900, 2, 2]]);

  assert.deepEqual(overview.collection, {
    aniilog: { standard: 2, sparkling: 1, forms: 2, special: 0, specialTotal: 1 },
    lumens: { sources: 1, sourceTotal: 2, collected: 3, total: 4 },
    pins: { collected: 2 },
  });
});

test("the profile overview is owner-only, follows the leaderboard gate and counts flags without a checklist", async () => {
  const { env } = await setup();
  assert.equal((await call(env, "/api/profile/overview")).status, 401);
  const devToken = await desktopToken(env, SESSIONS.dev);
  // A desktop token can't read the overview; it is the website's signed-in owner view.
  assert.equal((await call(env, "/api/profile/overview", { token: devToken })).status, 401);
  await call(env, "/api/progress", {
    session: SESSIONS.user,
    method: "PUT",
    body: { progress: { tracking: [], completed: ["aniimo:5:sparkling", "amber:quest:x:collected"], preferences: {} } },
  });
  const overview = await (await call(env, "/api/profile/overview", { session: SESSIONS.user })).json();
  assert.equal(overview.leaderboards, null);
  assert.deepEqual(overview.collection, {
    aniilog: { standard: 0, sparkling: 1, forms: null, special: 0, specialTotal: null },
    lumens: { sources: 1, sourceTotal: null, collected: null, total: null },
    pins: { collected: 0 },
  });
});

test("profiles are public only by opt-in; leaderboard entries show either way and link public profiles", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const save = (session, body) => call(env, "/api/profile", { session, method: "PATCH", body });
  // dev submits a run with user's character in the party, plus an AI teammate
  const devToken = await desktopToken(env, SESSIONS.dev);
  const userToken = await desktopToken(env, SESSIONS.user);
  assert.equal((await call(env, "/api/leaderboard/characters", { token: devToken, method: "POST", body: { gameUid: "111", name: "Lead", source: "meter" } })).status, 201);
  assert.equal((await call(env, "/api/leaderboard/characters", { token: userToken, method: "POST", body: { gameUid: "222", name: "Friend", source: "meter" } })).status, 201);
  const party = run("p1", { gameUid: "111", players: [{ name: "Lead", avgDps: 1 }, { name: "friend", avgDps: 2 }, { name: "Tammy", ai: true }] });
  assert.equal((await call(env, "/api/leaderboard/submissions", { token: devToken, method: "POST", body: party })).status, 201);

  const entries = async () => (await (await call(env, "/api/leaderboard/entries?kind=interlink_run")).json()).entries;
  let [entry] = await entries();
  assert.equal(entry.profileId, null);
  assert.deepEqual(entry.players.map((p) => p.profileId), [undefined, undefined, undefined]);

  // editing without isPublic keeps a profile private; opting in publishes it under a random id
  let saved = await (await save(SESSIONS.user, { displayName: "Friend", bio: "hi" })).json();
  assert.equal(saved.profile.isPublic, false);
  saved = await (await save(SESSIONS.user, { displayName: "Friend", bio: "hi", isPublic: true })).json();
  assert.equal(saved.profile.isPublic, true);
  assert.match(saved.profile.publicId, /^[A-Za-z0-9]{12}$/u);
  const id = saved.profile.publicId;
  // a later edit without the flag keeps it public and keeps the same link
  saved = await (await save(SESSIONS.user, { displayName: "Friend 2", bio: "" })).json();
  assert.equal(saved.profile.isPublic, true);
  assert.equal(saved.profile.publicId, id);

  const page = await call(env, `/api/profiles/${id}`);
  assert.equal(page.status, 200);
  const body = await page.json();
  assert.equal(body.profile.displayName, "Friend");                      // titled by the character, not the account name
  assert.deepEqual(body.characters, [{ name: "Friend" }]);
  assert.equal(JSON.stringify(body).includes(IDS.user), false);          // no Discord id anywhere

  [entry] = await entries();
  assert.deepEqual(entry.players.map((p) => p.profileId), [undefined, id, undefined]);   // AI and private stay plain

  // turning it off hides the page and the link; the entry itself still shows
  await save(SESSIONS.user, { displayName: "Friend 2", isPublic: false });
  assert.equal((await call(env, `/api/profiles/${id}`)).status, 404);
  [entry] = await entries();
  assert.equal(entry.players[1].profileId, undefined);
  assert.equal(entry.players[1].name, "friend");
  assert.equal((await save(SESSIONS.user, { displayName: "x", isPublic: "yes" })).status, 400);

  // a public profile shows its owner's board standing (no game UID), and the entry links its submitter
  const lead = await (await save(SESSIONS.dev, { displayName: "Lead", isPublic: true })).json();
  const leadPage = await (await call(env, `/api/profiles/${lead.profile.publicId}`)).json();
  assert.equal(leadPage.leaderboards.interlink_run[0].position, 1);
  assert.equal(leadPage.leaderboards.interlink_run[0].gameUid, undefined);
  [entry] = await entries();
  assert.equal(entry.profileId, lead.profile.publicId);
  assert.equal(entry.players[0].profileId, lead.profile.publicId);
});

test("Interlink weeks: best per boss, week totals, every week kept, and season totals", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await namedToken(env, SESSIONS.dev);
  const b = await namedToken(env, SESSIONS.user);
  const send = (token, body) => call(env, "/api/leaderboard/submissions", { token, method: "POST", body });
  const boss = (id, name) => ({ id, name, level: 60 });
  // week 3005: Sherro, Infergon, Tucking. dev: two Sherro runs (best counts) + an Infergon prep-screen best
  assert.equal((await send(a, run("w1", { cycle: "3005", boss: boss("80000109", "Omega Sherro"), score: 11000 }))).status, 201);
  assert.equal((await send(a, run("w2", { cycle: "3005", boss: boss("80000109", "Omega Sherro"), score: 12000 }))).status, 201);
  assert.equal((await send(a, { kind: "interlink_best", clientRunId: "best-3005-80000107", cycle: "3005", boss: boss("80000107", "Omega Infergon"), score: 9000, stars: 9 })).status, 201);
  assert.equal((await send(b, run("u1", { cycle: "3005", boss: boss("80000109", "Omega Sherro"), score: 15000 }))).status, 201);
  // quit early: under the clock but short of 15 stars, which older apps sent as cleared
  assert.equal((await send(a, run("w3", { cycle: "3005", boss: boss("80000109", "Omega Sherro"), score: 408, stars: 0, clearTimeS: 23, cleared: true }))).status, 201);
  assert.equal((await send(b, run("u4", { cycle: "3005", boss: boss("80000109", "Omega Sherro"), score: 9000, stars: 11, clearTimeS: 90, cleared: true }))).status, 201);
  // 15 stars, then ended before the 3 minutes: its time shows on the boss board (fastest clear)
  assert.equal((await send(b, run("u3", { cycle: "3005", boss: boss("80000107", "Omega Infergon"), score: 5000, clearTimeS: 142, cleared: true }))).status, 201);
  // an older week of the same season
  assert.equal((await send(b, run("u2", { cycle: "3003", boss: boss("80000099", "Alpha Irisal"), score: 7000 }))).status, 201);

  // a misread boss on the prep screen (not one of the week's bosses) must not count
  assert.equal((await send(a, { kind: "interlink_best", clientRunId: "best-3005-x", cycle: "3005", boss: boss("80000999", "Omega Tuekin"), score: 9000, stars: 9 })).status, 201);
  const week = await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json();
  assert.equal(week.cycle.id, "3005");
  assert.deepEqual(week.bosses.map((x) => x.name), ["Omega Sherro", "Omega Infergon", "Omega Tucking"]);
  assert.deepEqual(week.bosses[0].entries.map((e) => [e.rank, e.score]), [[1, 15000], [2, 12000]]);
  assert.deepEqual(week.bosses[0].entries.map((e) => e.clearTimeS), [null, null]);           // time ups: no kill time
  assert.deepEqual(week.week.map((e) => [e.rank, e.total]), [[1, 21000], [2, 20000]]);   // 12000 + 9000 beats 15000 + 5000
  assert.deepEqual(week.bosses[1].entries.map((e) => [e.stars, e.score, e.clearTimeS]), [[20, 5000, 142], [9, 9000, null]]);   // stars first; clear time
  assert.equal(JSON.stringify(week).includes(IDS.dev), false);                              // no Discord ids
  assert.ok(week.weeks.some((w) => w.id === "3003"));                                       // past weeks listed

  const old = await (await call(env, "/api/leaderboard/interlink?cycle=3003")).json();
  assert.deepEqual(old.week.map((e) => e.total), [7000]);

  const season = await (await call(env, "/api/leaderboard/interlink?season=1")).json();
  assert.deepEqual(season.standings.map((e) => [e.total, e.weeks]), [[27000, 2], [21000, 1]]);
  assert.deepEqual(week.week.map((e) => e.stars), [29, 40]);                // best stars per boss, added up
  assert.deepEqual(week.week[0].bossStars, { 80000109: 20, 80000107: 9 });   // and per boss
  const profile = await (await call(env, "/api/profile/overview", { session: SESSIONS.dev })).json();
  assert.deepEqual(profile.leaderboards.interlinkSeason, { season: 1, total: 21000, stars: 29, weeks: 1, rank: 2, players: 2 });
  assert.equal((await call(env, "/api/leaderboard/interlink?season=99")).status, 404);
});

test("Interlink boss boards rank by stars, then score, then fastest clear", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const tucking = { id: "80000100", name: "Omega Tucking", level: 60 };
  const send = async (session, body) => call(env, "/api/leaderboard/submissions", { token: await namedToken(env, session), method: "POST", body });
  assert.equal((await send(SESSIONS.dev, run("t1", { boss: tucking, stars: 15, score: 16000, clearTimeS: 150, cleared: true }))).status, 201);
  assert.equal((await send(SESSIONS.user, run("t2", { boss: tucking, stars: 15, score: 16000, clearTimeS: 120, cleared: true }))).status, 201);
  assert.equal((await send(SESSIONS.dev2, run("t3", { boss: tucking, stars: 16, score: 15500, clearTimeS: 175, cleared: true }))).status, 201);
  const week = await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json();
  const board = week.bosses.find((boss) => boss.id === "80000100");
  assert.deepEqual(board.entries.map((e) => [e.rank, e.stars, e.score, e.clearTimeS]),
    [[1, 16, 15500, 175], [2, 15, 16000, 120], [3, 15, 16000, 150]]);
});

test("developer apps can add Interlink weeks from the game data; others can't", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const dev = await desktopToken(env, SESSIONS.dev);
  const user = await desktopToken(env, SESSIONS.user);
  const next = { id: "3006", season: 1, start: 1793217600, end: 1793606399,
    bosses: [{ id: "80000095", name: "Omega Geoclaw" }, { id: "80000096", name: "Omega Minespine" }, { id: "80000097", name: "Omega Tubster" }] };
  const upload = (token, cycles) => call(env, "/api/leaderboard/interlink/cycles", { token, method: "POST", body: { cycles } });
  assert.equal((await upload(user, [next])).status, 403);
  assert.equal((await upload(dev, [{ ...next, bosses: next.bosses.slice(0, 2) }])).status, 400);
  assert.equal((await upload(dev, [next])).status, 200);
  const week = await (await call(env, "/api/leaderboard/interlink?cycle=3006")).json();
  assert.equal(week.cycle.id, "3006");
  assert.deepEqual(week.bosses.map((b) => b.name), ["Omega Geoclaw", "Omega Minespine", "Omega Tubster"]);
  assert.ok(week.weeks.some((w) => w.id === "3006"));
  const season = await (await call(env, "/api/leaderboard/interlink?season=1")).json();
  assert.ok(season.weeks.some((w) => w.id === "3006"));
});
