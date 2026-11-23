import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker, { clientVersionRank, leaderboardSubmission, lineupDps, mergedLineup, playedAtLocalAsUtc, playedAtShifts, settledRun, simCheckLimits, simRunChecks, simRunHeld } from "../src/index.js";

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
      // like D1: at most 100 bound values a query (6 Nov: Show unlinked asked for more and failed)
      return { ...statement(sql), bind: (...values) => {
        if (values.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${values.length})`);
        return statement(sql, values);
      } };
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
  assert.ok(Number.isFinite(entries.updatedAt), "the board says when its newest run arrived");

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

test("Holo-Battle Sim boards: the game's 12 stages, each difficulty ranking Victory times, fastest first, best per player", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const send = async (session, body) => call(env, "/api/leaderboard/submissions", { token: await namedToken(env, session), method: "POST", body });
  const run = (id, trial, difficulty, time, cleared = true) => ({ kind: "sim_run", clientRunId: id, trial, difficulty, clearTimeS: time, cleared, partySize: 4 });
  // "Battle time 00:08:22 Training of Water - Hard" -> 502 s
  assert.equal((await send(SESSIONS.dev, run("a1", "Training of Water", "Hard", 502))).status, 201);
  assert.equal((await send(SESSIONS.dev, run("a2", "Training of Water", "Hard", 470))).status, 201);
  assert.equal((await send(SESSIONS.user, run("b1", "Training of Water", "Hard", 495))).status, 201);
  assert.equal((await send(SESSIONS.dev2, run("c1", "Training of Water", "Hard", 300, false))).status, 201);   // not a Victory
  assert.equal((await send(SESSIONS.dev, run("a3", "Training of Water", "Normal", 200))).status, 201);
  // "Trial of Fire - Challenge" on the Victory screen is the Crucible of Fire: the same board as "Crucible of Fire"
  assert.equal((await send(SESSIONS.user, run("b2", "Trial of Fire", "Challenge", 738))).status, 201);
  assert.equal((await send(SESSIONS.dev2, run("d1", "Crucible of Fire", "Challenge", 760))).status, 201);
  // not one of the game's stages
  assert.equal((await send(SESSIONS.dev, run("bad1", "<b>Water</b>", "Hard", 100))).status, 400);
  assert.equal((await send(SESSIONS.dev, run("bad2", "Training of Wind", "Hard", 100))).status, 400);
  assert.equal((await send(SESSIONS.dev, run("bad3", "Training of Water", "Nightmare", 100))).status, 400);
  const board = async (trial, difficulty) => (await (await call(env,
    `/api/leaderboard/entries?kind=sim_run&sort=clear_time_s&trial=${encodeURIComponent(trial)}&difficulty=${encodeURIComponent(difficulty)}`)).json()).entries;
  assert.deepEqual((await board("Water", "Hard")).map((e) => [e.rank, e.player, e.clearTimeS, e.trial, e.trialName, e.trialGroup]),
    [[1, "DevOne", 470, "Water", "Training of Water", "Basic Training"], [2, "UserOne", 495, "Water", "Training of Water", "Basic Training"]]);
  assert.deepEqual((await board("Crucible of Fire", "Challenge")).map((e) => [e.player, e.clearTimeS, e.trialName, e.trialGroup]),
    [["UserOne", 738, "Crucible of Fire", "Elemental Crucible"], ["DevTwo", 760, "Crucible of Fire", "Elemental Crucible"]]);
  assert.deepEqual((await board("Training of Water", "Normal")).map((e) => e.clearTimeS), [200]);
  const facets = await (await call(env, "/api/leaderboard/facets?mode=sim")).json();
  assert.deepEqual(facets.trials.map((t) => [t.name, t.difficulty, t.count]),
    [["Crucible of Fire", "Challenge", 2], ["Training of Water", "Hard", 4], ["Training of Water", "Normal", 1]]);
  assert.deepEqual(facets.trials.map((t) => t.season), ["1", "1", "1"]);
  // the rules the page builds its pickers from, newest season first. Season 1: 3 elements x (Easy, Normal, Hard) +
  // Challenge = 12 boards; Season 2: 3 elements x Easy to Trial = 15
  const [second, first] = facets.simRules.seasons;
  assert.deepEqual([first.season, first.elements, first.difficulties], [1, ["Grass", "Water", "Fire"], ["Easy", "Normal", "Hard", "Challenge"]]);
  assert.deepEqual([second.season, second.elements, second.difficulties], [2, ["Earth", "Lightning", "Dark"], ["Easy", "Normal", "Hard", "Challenge", "Trial"]]);
  assert.deepEqual(facets.simRules.seasons.map((season) => season.elements.length * season.difficulties.length), [15, 12]);
  assert.equal(facets.simRules.confirmed, true);
  assert.equal((await (await call(env, "/api/leaderboard/facets?mode=interlink")).json()).simRules, undefined);
});

test("Holo-Battle Sim Season 2: Earth, Lightning and Dark Training up to Trial, each season with its own boards", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const send = async (session, body) => call(env, "/api/leaderboard/submissions", { token: await namedToken(env, session), method: "POST", body });
  const run = (id, trial, difficulty, time, playedAt = 1793000000) => ({ kind: "sim_run", clientRunId: id, trial, difficulty, clearTimeS: time, cleared: true, partySize: 1, playedAt });
  // aLogs sends the stage as the game shows it: "Earth Training - Trial", and Season 1's Normal as "Common"
  assert.equal((await send(SESSIONS.dev, run("e1", "Earth Training", "Trial", 640))).status, 201);
  assert.equal((await send(SESSIONS.user, run("e2", "Earth", "Trial", 610))).status, 201);
  assert.equal((await send(SESSIONS.dev, run("l1", "Lightning Training", "Hard", 300))).status, 201);
  assert.equal((await send(SESSIONS.dev, run("w1", "Training of Water", "Common", 200, 1790000000))).status, 201);
  assert.equal((await send(SESSIONS.dev, run("bad1", "Training of Water", "Trial", 100))).status, 400);   // Season 1 had no Trial
  assert.equal((await send(SESSIONS.dev, run("bad2", "Dark Training", "Nightmare", 100))).status, 400);
  const stored = sqlite.prepare("SELECT client_run_id AS id, cycle, trial, difficulty FROM leaderboard_submissions WHERE kind = 'sim_run' ORDER BY client_run_id").all();
  assert.deepEqual(stored.map((row) => [row.id, row.cycle, row.trial, row.difficulty]),
    [["e1", "2", "Earth", "Trial"], ["e2", "2", "Earth", "Trial"], ["l1", "2", "Lightning", "Hard"], ["w1", "1", "Water", "Normal"]]);
  const board = async (query) => (await (await call(env, `/api/leaderboard/entries?kind=sim_run&sort=clear_time_s&${query}`)).json()).entries;
  assert.deepEqual((await board("cycle=2&trial=Earth&difficulty=Trial")).map((e) => [e.player, e.clearTimeS, e.cycle, e.trialName, e.trialGroup]),
    [["UserOne", 610, "2", "Earth Training", "Training"], ["DevOne", 640, "2", "Earth Training", "Training"]]);
  assert.deepEqual((await board("cycle=1&trial=Water&difficulty=Normal")).map((e) => [e.player, e.trialName]), [["DevOne", "Training of Water"]]);
  assert.deepEqual((await board("cycle=1&trial=Earth&difficulty=Trial")), []);
  const facets = await (await call(env, "/api/leaderboard/facets?mode=sim")).json();
  assert.deepEqual(facets.trials.map((t) => [t.season, t.name, t.difficulty, t.group]),
    [["2", "Earth Training", "Trial", "Training"], ["2", "Lightning Training", "Hard", "Training"], ["1", "Training of Water", "Normal", "Basic Training"]]);
});

test("Holo-Battle Sim setup (aLogs B5): team with the MVP, Training Style, transformation and gizmos on the boards, a board per style", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const send = async (session, body) => call(env, "/api/leaderboard/submissions", { token: await namedToken(env, session), method: "POST", body });
  const setupOf = (style) => ({
    team: [{ name: "Scorchhowl", level: 73, mvp: true, nickname: "Blaze" }, { name: "Somniwing", level: 70, nickname: "y".repeat(30) }, { name: "<b>x</b>".repeat(20), level: -4 }, { level: 9 }],
    mvpShares: { damage: 61.5, taken: 30, healing: 500 },
    style, core: "Fervor Mask", transform: "Scorchhowl", coins: 8550, secret: "dropped",
    gizmos: [{ series: "Energy", count: 6, picked: [{ name: "Blessing of Protection", rarity: "Uncommon" }, { rarity: "Rare" }] }, { series: "Valor", count: 2 }],
  });
  const run = (id, style, time, extraSetup = setupOf(style)) => ({ kind: "sim_run", clientRunId: id, trial: "Earth Training", difficulty: "Trial",
    clearTimeS: time, cleared: true, partySize: 1, playedAt: 1793000000, extra: { setup: extraSetup } });
  assert.equal((await send(SESSIONS.dev, run("v1", "Valor", 600))).status, 201);
  assert.equal((await send(SESSIONS.user, run("e1", "Energy", 580))).status, 201);
  assert.equal((await send(SESSIONS.dev2, run("u1", "Sneaky", 570, { style: "Sneaky", picked: [{ name: "Spark", series: "Surge", rarity: "Common" }] }))).status, 201);
  const board = async (query) => (await (await call(env, `/api/leaderboard/entries?kind=sim_run&sort=clear_time_s&cycle=2&trial=Earth&difficulty=Trial${query}`)).json()).entries;
  const all = await board("");
  assert.deepEqual(all.map((e) => e.player), ["DevTwo", "UserOne", "DevOne"]);
  assert.deepEqual(all[2].extra.setup, {
    team: [{ name: "Scorchhowl", nickname: "Blaze", level: 73, mvp: true }, { name: "Somniwing", nickname: "y".repeat(24), level: 70 }, { name: "<b>x</b>".repeat(20).slice(0, 40) }],
    mvpShares: { damage: 61.5, taken: 30 }, style: "Valor", core: "Fervor Mask", transform: "Scorchhowl",
    gizmos: [{ series: "Energy", count: 6, picked: [{ name: "Blessing of Protection", rarity: "Uncommon" }] }, { series: "Valor", count: 2 }], coins: 8550,
  });
  // a style that isn't one of the game's is left out; unmatched gizmo icons come as picked
  assert.deepEqual(all[0].extra.setup, { picked: [{ name: "Spark", series: "Surge", rarity: "Common" }] });
  assert.deepEqual((await board("&style=Valor")).map((e) => e.player), ["DevOne"]);
  assert.deepEqual((await board("&style=Sneaky")).map((e) => e.player), ["DevTwo", "UserOne", "DevOne"]);   // not a style: no filter
  // the Style, Player and Party headers re-order the board; a run without a style stays on it, last
  const styled = async (query) => (await (await call(env, `/api/leaderboard/entries?kind=sim_run&cycle=2&trial=Earth&difficulty=Trial&${query}`)).json()).entries;
  assert.deepEqual((await styled("sort=style")).map((e) => e.player), ["UserOne", "DevOne", "DevTwo"]);              // Energy, Valor, none
  assert.deepEqual((await styled("sort=style&order=desc")).map((e) => e.player), ["DevOne", "UserOne", "DevTwo"]);
  assert.deepEqual((await styled("sort=player")).map((e) => e.player), ["DevOne", "DevTwo", "UserOne"]);
  assert.equal((await styled("sort=party_size")).length, 3);
  const facets = await (await call(env, "/api/leaderboard/facets?mode=sim")).json();
  assert.deepEqual(facets.simRules.styles, ["Energy", "Surge", "Defense", "Vitality", "Ironclad", "Valor", "Wealth"]);
  assert.deepEqual(facets.styles.map((row) => [row.value, row.count]).sort(), [["Energy", 1], ["Valor", 1]]);
});

test("Holo-Battle Sim runs stored before seasons were kept get Season 1 by themselves", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  assert.equal((await call(env, "/api/leaderboard/submissions", { token, method: "POST",
    body: { kind: "sim_run", clientRunId: "old", trial: "Training of Fire", difficulty: "Hard", clearTimeS: 400, cleared: true } })).status, 201);
  sqlite.prepare("UPDATE leaderboard_submissions SET cycle = NULL WHERE client_run_id = 'old'").run();
  const fresh = { ...env, DB: Object.create(env.DB) };                             // a new worker: nothing filled yet
  const entries = (await (await call(fresh, "/api/leaderboard/entries?kind=sim_run&cycle=1&trial=Fire&difficulty=Hard")).json()).entries;
  assert.deepEqual(entries.map((e) => [e.cycle, e.trialName]), [["1", "Training of Fire"]]);
});

test("aLogs B2 sends the cropped proof and the whole screens: all four stored, served, and deleted with the run", async () => {
  const EVIDENCE = evidenceStore();
  const { env } = await setup({ EVIDENCE, LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev });
  const token = await namedToken(env, SESSIONS.user);
  const jpeg = (bytes, mark) => { const data = new Uint8Array(bytes); data.set([0xff, 0xd8, 0xff, mark]); return new Blob([data], { type: "image/jpeg" }); };
  const form = new FormData();
  // the app can't name the stored screens itself: its extra.proofFull is replaced
  form.set("submission", JSON.stringify(run("b2-run", { extra: { proofBoxes: { evidence: [0.13, 0.06, 0.88, 0.67] }, proofFull: { evidence: "evidence/someone-else.jpg" } } })));
  // a 4K crop and the screens it came from: ~3.6 MB together, more than the old two-picture limit
  form.set("evidence", jpeg(900 * 1024, 1), "result.jpg");
  form.set("evidence_full", jpeg(900 * 1024, 2), "result-full.jpg");
  form.set("battle", jpeg(900 * 1024, 3), "battle.jpg");
  form.set("battle_full", jpeg(900 * 1024, 4), "battle-full.jpg");
  const sent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
  assert.equal(sent.status, 201);
  const { submissionId } = await sent.json();
  assert.equal(EVIDENCE.objects.size, 4);
  const shot = async (name) => new Uint8Array(await (await call(env, `/api/leaderboard/submissions/${submissionId}/evidence${name ? `?shot=${name}` : ""}`)).arrayBuffer())[3];
  assert.deepEqual([await shot(""), await shot("full"), await shot("battle"), await shot("battle_full")], [1, 2, 3, 4]);   // the crop is the proof
  const entry = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run")).json()).entries[0];
  assert.deepEqual(entry.extra.proofBoxes, { evidence: [0.13, 0.06, 0.88, 0.67] });
  assert.deepEqual(entry.extra.hasFullScreens, ["evidence", "battle"]);
  assert.equal(entry.extra.proofFull, undefined);                                     // storage keys stay private
  // re-sent without the whole screens (an older app): the stored ones stay
  const again = new FormData();
  again.set("submission", JSON.stringify(run("b2-run")));
  again.set("evidence", jpeg(1024, 1), "result.jpg");
  assert.equal((await call(env, "/api/leaderboard/submissions", { token, method: "POST", form: again })).status, 200);   // updated
  assert.equal(await shot("full"), 2);
  // an older app: the crop alone, as before
  const old = new FormData();
  old.set("submission", JSON.stringify(run("old-run", { cycle: "3005", boss: { id: "80000109", name: "Omega Sherro", level: 60 } })));
  old.set("evidence", jpeg(1024, 9), "result.jpg");
  const oldSent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form: old });
  assert.equal(oldSent.status, 201);
  assert.equal((await call(env, `/api/leaderboard/submissions/${(await oldSent.json()).submissionId}/evidence?shot=full`)).status, 404);
  // deleting the run removes every picture of it
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { token, method: "DELETE" })).status, 403);   // not its sender
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { session: SESSIONS.dev, method: "DELETE" })).status, 200);   // the owner
  assert.equal(EVIDENCE.objects.size, 1);                                             // only the older run's crop is left
});

test("Holo-Battle Sim's Gizmo views are stored with the run, listed in order, served, and deleted with it", async () => {
  const EVIDENCE = evidenceStore();
  const { env } = await setup({ EVIDENCE, LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev });
  const token = await namedToken(env, SESSIONS.user);
  const jpeg = (mark) => { const data = new Uint8Array(2048); data.set([0xff, 0xd8, 0xff, mark]); return new Blob([data], { type: "image/jpeg" }); };
  const sim = { kind: "sim_run", clientRunId: "sim-1", trial: "Training of Fire", difficulty: "Hard", clearTimeS: 400, cleared: true, partySize: 1,
    extra: { proofGizmos: ["evidence/someone-else.jpg"] } };                         // the app can't name stored pictures
  const form = new FormData();
  form.set("submission", JSON.stringify(sim));
  form.set("evidence", jpeg(1), "victory.jpg");
  for (const [i, mark] of [[1, 11], [2, 12], [3, 13]]) form.set(`gizmo${i}`, jpeg(mark), `gizmo${i}.jpg`);
  const sent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
  assert.equal(sent.status, 201);
  const { submissionId } = await sent.json();
  const base = `/api/leaderboard/submissions/${submissionId}/evidence`;
  assert.deepEqual((await (await call(env, `${base}?shot=list`)).json()).shots, ["summary", "gizmo1", "gizmo2", "gizmo3"]);
  const mark = async (shot) => new Uint8Array(await (await call(env, `${base}?shot=${shot}`)).arrayBuffer())[3];
  assert.deepEqual([await mark("gizmo1"), await mark("gizmo2"), await mark("gizmo3")], [11, 12, 13]);
  assert.equal((await call(env, `${base}?shot=gizmo4`)).status, 404);
  const entry = (await (await call(env, "/api/leaderboard/entries?kind=sim_run&trial=Fire&difficulty=Hard")).json()).entries[0];
  assert.equal(entry.extra?.proofGizmos, undefined);                                  // storage keys stay private
  // a re-send with fewer views replaces them (the extra one is deleted)
  const again = new FormData();
  again.set("submission", JSON.stringify({ ...sim, extra: {} }));
  again.set("evidence", jpeg(1), "victory.jpg");
  again.set("gizmo1", jpeg(21), "gizmo1.jpg");
  assert.equal((await call(env, "/api/leaderboard/submissions", { token, method: "POST", form: again })).status, 200);
  assert.deepEqual((await (await call(env, `${base}?shot=list`)).json()).shots, ["summary", "gizmo1"]);
  assert.equal(await mark("gizmo1"), 21);
  assert.equal(EVIDENCE.objects.size, 2);
  // an Interlink run lists its Battle Data after the result screen
  const run = new FormData();
  run.set("submission", JSON.stringify({ kind: "interlink_run", clientRunId: "il-1", cycle: "3005", boss: { id: "80000109", name: "Omega Sherro", level: 60 },
    score: 20000, stars: 20, clearTimeS: 180, partySize: 2, buffs: [{ name: "Overtime", level: 2 }], teamDps: 9000,
    players: [{ name: "MinMax", self: true, ai: false, avgDps: 9000, breakValue: 10, damageTaken: 20, heal: 0 }],
    extra: { lineup: [{ slot: 0, name: "MinMax", self: true, aniimo: "Pawney", aniimoLevel: 60, cp: 41000,
      team: [{ aniimo: "Pawney", aniimoLevel: 60, cp: 41000 }, { aniimo: "Emberpup" }] }, { slot: 1, name: "Bot", ai: true }] } }));
  run.set("evidence", jpeg(2), "result.jpg");
  run.set("battle", jpeg(3), "battle.jpg");
  const runSent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form: run });
  assert.ok([200, 201].includes(runSent.status), String(runSent.status));
  const runId = (await runSent.json()).submissionId;
  const details = await (await call(env, `/api/leaderboard/submissions/${runId}/evidence?shot=list`)).json();
  assert.deepEqual(details.shots, ["summary", "battle"]);
  assert.deepEqual(details.buffs, [{ name: "Overtime", level: 2 }]);                  // what the party went in with
  assert.deepEqual(details.lineup.map((p) => [p.name, p.aniimo ?? null, (p.team || []).map((m) => m.aniimo)]),
    [["MinMax", "Pawney", ["Pawney", "Emberpup"]], ["Bot", null, []]]);
  // each player's Avg DPS off the Battle Data card (null: no card came for the AI), and the team's DPS
  assert.deepEqual(details.lineup.map((p) => p.avgDps), [9000, null]);
  assert.deepEqual(details.lineup.map((p) => p.slot), [0, 1]);                       // the first seat's slot 0 is kept
  assert.equal(details.teamDps, 9000);
  // a better best sent from the game's menu is shown beside the run's pictures, never instead of them
  const menu = new FormData();
  menu.set("submission", JSON.stringify({ kind: "interlink_best", clientRunId: "best-3005-80000109", cycle: "3005",
    boss: { id: "80000109", name: "Omega Sherro", level: 60 }, score: 21500, stars: 20 }));
  menu.set("evidence", jpeg(4), "menu.jpg");
  const menuSent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form: menu });
  assert.ok([200, 201].includes(menuSent.status), String(menuSent.status));
  const menuId = (await menuSent.json()).submissionId;
  const menuDetails = await (await call(env, `/api/leaderboard/submissions/${menuId}/evidence?shot=list`)).json();
  assert.equal(menuDetails.menu, true);
  assert.equal(menuDetails.runProof, runId);                                          // the run's pictures come with it
  assert.equal(details.menu, undefined);                                              // a result-screen run isn't menu proof
  // deleting the sim run removes every picture of it
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { token, method: "DELETE" })).status, 403);   // not its sender
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { session: SESSIONS.dev, method: "DELETE" })).status, 200);   // the owner
  assert.equal(EVIDENCE.objects.size, 3);                                             // the Interlink run's two and the menu's are left
});

test("the fight's pictures: stored in order, replaced or kept on a re-send, staff only, never cached, deleted with the run", async () => {
  const EVIDENCE = evidenceStore();
  // dev is the owner (logs.read); dev2 a developer (no logs.read); user sends the run
  const { env } = await setup({ EVIDENCE, LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev });
  const token = await namedToken(env, SESSIONS.user);
  const jpeg = (mark) => { const data = new Uint8Array(512); data.set([0xff, 0xd8, 0xff, mark]); return new Blob([data], { type: "image/jpeg" }); };
  const send = async (body, parts) => {
    const form = new FormData();
    form.set("submission", JSON.stringify(body));
    for (const [name, mark] of parts) form.set(name, jpeg(mark), `${name}.jpg`);
    return call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
  };
  // the app can't name stored pictures; its fightShots are kept, cleaned
  const body = run("fight-run", { extra: { proofFight: ["evidence/someone-else.jpg"], proofBoxes: { evidence: [0.1, 0.1, 0.9, 0.9] },
    fightShots: [{ n: 1, t: 12.44 }, { n: 2, t: 75.06, x: "dropped" }, { n: 3, t: -1 }, { n: 2, t: 9 }, { n: 7, t: 5 }, { n: 1.5, t: 3 },
      "junk", { n: 4, t: Infinity }, { n: 5, t: "60" }, { n: 6, t: 3600 }] } });
  // fight7 is ignored; a gap after fight3 would end the list
  const sent = await send(body, [["evidence", 1], ["battle", 2], ["party", 3], ["fight1", 31], ["fight2", 32], ["fight3", 33], ["fight7", 37]]);
  assert.equal(sent.status, 201);
  const { submissionId } = await sent.json();
  const base = `/api/leaderboard/submissions/${submissionId}/evidence`;
  const keys = () => [...EVIDENCE.objects.keys()].filter((key) => key.includes("-fight")).sort();
  assert.deepEqual(keys(), [1, 2, 3].map((n) => `evidence/${IDS.user}/${submissionId}-fight${n}.jpg`));
  const stored = JSON.parse((await env.DB.prepare("SELECT extra_json AS e FROM leaderboard_submissions WHERE submission_id = ?").bind(submissionId).first()).e);
  assert.deepEqual(stored.proofFight, keys());
  assert.deepEqual(stored.fightShots, [{ n: 1, t: 12.4 }, { n: 2, t: 75.1 }, { n: 3 }, { n: 4 }, { n: 5 }, { n: 6, t: 3600 }]);

  // the list: fight1..3 and their times for staff only; the sender, a developer and a visitor get today's answer
  const list = (session) => call(env, `${base}?shot=list`, { session });
  const staffList = await list(SESSIONS.dev);
  assert.equal(staffList.headers.get("cache-control"), "private, no-store");
  const staffDetails = await staffList.json();
  assert.deepEqual(staffDetails.shots, ["summary", "battle", "party", "fight1", "fight2", "fight3"]);
  assert.deepEqual(staffDetails.fightShots.slice(0, 2), [{ n: 1, t: 12.4 }, { n: 2, t: 75.1 }]);
  for (const session of [SESSIONS.user, SESSIONS.dev2, undefined]) {
    const answer = await list(session);
    assert.equal(answer.headers.get("cache-control"), "public, max-age=300");
    const details = await answer.json();
    assert.deepEqual(details.shots, ["summary", "battle", "party"]);
    assert.equal(details.fightShots, undefined);
  }
  // the pictures: staff get them, never cached; anyone else the answer a missing picture gets
  const picture = (shot, session) => call(env, `${base}?shot=${shot}`, { session });
  const staffPicture = await picture("fight2", SESSIONS.dev);
  assert.equal(staffPicture.status, 200);
  assert.equal(staffPicture.headers.get("cache-control"), "private, no-store");
  assert.equal(new Uint8Array(await staffPicture.arrayBuffer())[3], 32);
  assert.equal((await picture("fight4", SESSIONS.dev)).status, 404);
  assert.equal((await picture("fight7", SESSIONS.dev)).status, 404);
  const missing = await (await picture("fight4", SESSIONS.dev)).text();
  for (const session of [SESSIONS.user, SESSIONS.dev2, undefined]) {
    const answer = await picture("fight1", session);
    assert.equal(answer.status, 404);
    assert.equal(await answer.text(), missing);
  }
  assert.equal((await call(env, `${base}?shot=fight1`, { token })).status, 404);    // the sender's app too
  // the other pictures are as before: public and cached
  assert.equal((await picture("party")).headers.get("cache-control"), "public, max-age=86400");

  // the boards show neither the keys nor the times
  const entry = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run")).json()).entries[0];
  assert.equal(entry.extra.proofFight, undefined);
  assert.equal(entry.extra.fightShots, undefined);
  assert.deepEqual(entry.extra.proofBoxes, { evidence: [0.1, 0.1, 0.9, 0.9] });
  assert.ok(!JSON.stringify(entry).includes("-fight"));

  // a follow-up without fight pictures keeps them and their times
  assert.equal((await send(run("fight-run", { extra: { proofBoxes: { evidence: [0.1, 0.1, 0.9, 0.9] } } }), [["evidence", 1]])).status, 200);
  assert.equal(keys().length, 3);
  assert.deepEqual((await (await list(SESSIONS.dev)).json()).fightShots[0], { n: 1, t: 12.4 });
  // a follow-up with them replaces the set (fight3 is deleted)
  assert.equal((await send(run("fight-run", { extra: { fightShots: [{ n: 1, t: 1 }, { n: 2, t: 2 }] } }), [["evidence", 1], ["fight1", 41], ["fight2", 42]])).status, 200);
  assert.deepEqual(keys(), [1, 2].map((n) => `evidence/${IDS.user}/${submissionId}-fight${n}.jpg`));
  const replaced = await (await list(SESSIONS.dev)).json();
  assert.deepEqual(replaced.shots.filter((s) => s.startsWith("fight")), ["fight1", "fight2"]);
  assert.deepEqual(replaced.fightShots, [{ n: 1, t: 1 }, { n: 2, t: 2 }]);
  assert.equal(new Uint8Array(await (await picture("fight1", SESSIONS.dev)).arrayBuffer())[3], 41);
  // fight pictures without the result screen aren't taken
  assert.equal((await send(run("no-proof"), [["fight1", 51]])).status, 201);
  assert.equal(keys().length, 2);

  // deleting the run deletes its fight pictures
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { session: SESSIONS.dev, method: "DELETE" })).status, 200);
  assert.deepEqual(keys(), []);
});

test("the fight's pictures go with the whole screens after 14 days; a current best and a run under review keep them", async () => {
  const EVIDENCE = evidenceStore();
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true", EVIDENCE });
  const token = await namedToken(env, SESSIONS.dev);
  const sim = (id, clearTimeS) => ({ kind: "sim_run", clientRunId: id, trial: "Training of Fire", difficulty: "Hard", clearTimeS, cleared: true, partySize: 1,
    extra: { fightShots: [{ n: 1, t: 10 }] } });
  const screens = ["evidence", "evidence_full", "fight1", "fight2"];
  const id = (client) => sqlite.prepare("SELECT submission_id AS id FROM leaderboard_submissions WHERE client_run_id = ?").get(client).id;
  const pictures = (client) => [...EVIDENCE.objects.keys()].filter((key) => key.includes(id(client)))
    .map((key) => /-(full|fight\d)\.jpg$/u.exec(key)?.[1] || "crop").sort();
  const extra = (client) => JSON.parse(sqlite.prepare("SELECT extra_json AS e FROM leaderboard_submissions WHERE client_run_id = ?").get(client).e || "{}");
  await sendRun(env, token, sim("slow", 500), screens);
  await sendRun(env, token, sim("review", 450), screens);
  await sendRun(env, token, sim("best", 300), screens);
  assert.deepEqual(pictures("slow"), ["crop", "fight1", "fight2", "full"]);
  sqlite.prepare("UPDATE leaderboard_submissions SET created_at = created_at - 20 * 86400 WHERE client_run_id IN ('slow', 'review', 'best')").run();
  sqlite.prepare("UPDATE leaderboard_submissions SET verify_state = 'mismatch' WHERE client_run_id = 'review'").run();
  for (let i = 0; i < 2; i += 1) await sendRun(env, token, run(`trigger-${i}`));
  // the slower run: its whole screen and fight pictures gone, the crop kept (90 days), proofFight cleared
  assert.deepEqual(pictures("slow"), ["crop"]);
  assert.equal(extra("slow").proofFight, undefined);
  assert.equal(extra("slow").proofFull, undefined);
  for (const kept of ["best", "review"]) assert.deepEqual(pictures(kept), ["crop", "fight1", "fight2", "full"], kept);
  // after 90 days the crops go too, with anything left
  sqlite.prepare("UPDATE leaderboard_submissions SET created_at = created_at - 100 * 86400 WHERE client_run_id = 'slow'").run();
  await sendRun(env, token, run("trigger-x"));
  assert.deepEqual(pictures("slow"), []);
});

// A synthetic fight log (invented numbers): a look every 0.5 s, 1,000 damage a look, the game's countdown falling
// `rate` seconds a real second
function fightCsv(rows, rate = 1) {
  const lines = ["wall_s,timer_s,team_damage,note,break_phase"];
  for (let i = 0; i < rows; i += 1) lines.push(`${i * 0.5},${300 - rate * i * 0.5},${i * 1000},,`);
  return `${lines.join("\r\n")}\r\n`;
}
const gzipped = (text, type = "application/gzip") => new Blob([gzipSync(Buffer.from(text))], { type });

test("the fight log: kept for staff with its figures, flagged against the limits, replaced or kept on a re-send, never public", async () => {
  const EVIDENCE = evidenceStore();
  const { env, sqlite } = await setup({ EVIDENCE, LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev,
    INTERLINK_CHECK_LIMITS: JSON.stringify({ fight: { clockRate: { max: 1.1 } } }) });
  const token = await namedToken(env, SESSIONS.user);
  const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" });
  const send = (extra, log) => {
    const form = new FormData();
    form.set("submission", JSON.stringify(run("log-run", { extra })));
    form.set("evidence", jpeg(), "result.jpg");
    if (log) form.set("fightlog", log, "fight.csv.gz");
    return call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
  };
  const first = await send({ proofBoxes: { evidence: [0.1, 0.1, 0.9, 0.9] } });
  assert.equal(first.status, 201);
  const { submissionId } = await first.json();
  const base = `/api/leaderboard/submissions/${submissionId}/evidence`;
  const entries = async () => (await call(env, "/api/leaderboard/entries?kind=interlink_run")).text();
  const lists = async () => Promise.all([SESSIONS.user, SESSIONS.dev2, undefined].map(async (session) => (await call(env, `${base}?shot=list`, { session })).text()));
  const publicBefore = [await entries(), ...await lists()];

  // the log, with an app that tries to name its storage, figures and note itself
  const fastLog = gzipped(fightCsv(200, 1.5));
  const fastBytes = new Uint8Array(await fastLog.arrayBuffer());
  assert.equal((await send({ proofBoxes: { evidence: [0.1, 0.1, 0.9, 0.9] }, proofFightLog: "evidence/someone-else.gz", fightStats: { dps: 1 }, fightLogNote: "x" }, fastLog)).status, 200);
  const key = `evidence/${IDS.user}/${submissionId}-fightlog.csv.gz`;
  assert.deepEqual(EVIDENCE.objects.get(key).bytes, fastBytes);                       // kept as sent
  assert.equal(EVIDENCE.objects.get(key).type, "application/gzip");
  const stored = () => JSON.parse(sqlite.prepare("SELECT extra_json AS e FROM leaderboard_submissions WHERE submission_id = ?").get(submissionId).e);
  assert.equal(stored().proofFightLog, key);
  assert.equal(stored().fightStats.clockRate, 1.5);
  assert.equal(stored().fightStats.dps, 2000);
  assert.equal(stored().fightLogNote, undefined);
  // a review-only flag: the game's clock ran 1.5 times real time
  const reviewOnly = () => JSON.parse(sqlite.prepare("SELECT verify_json AS v FROM leaderboard_submissions WHERE submission_id = ?").get(submissionId).v || "{}").reviewOnly;
  assert.deepEqual(reviewOnly().flags, [{ rule: "fight log", figure: "clockRate", sent: 1.5, max: 1.1 }]);

  // public answers: as they were before the log
  assert.deepEqual([await entries(), ...await lists()], publicBefore);
  // staff: the figures in the list, the file to download
  const staffList = await call(env, `${base}?shot=list`, { session: SESSIONS.dev });
  assert.equal(staffList.headers.get("cache-control"), "private, no-store");
  const details = await staffList.json();
  assert.deepEqual(details.shots, ["summary"]);
  assert.equal(details.fightLog.stats.clockRate, 1.5);
  assert.equal(details.fightLog.note, undefined);
  const download = await call(env, `${base}?shot=fightlog`, { session: SESSIONS.dev });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/gzip");
  assert.equal(download.headers.get("content-disposition"), `attachment; filename="fight-${submissionId}.csv.gz"`);
  assert.equal(download.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), fastBytes);
  // anyone else: the answer a missing picture gets (the sender too)
  const missing = await (await call(env, `${base}?shot=fight1`, { session: SESSIONS.dev })).text();
  for (const session of [SESSIONS.user, SESSIONS.dev2, undefined]) {
    const answer = await call(env, `${base}?shot=fightlog`, { session });
    assert.equal(answer.status, 404);
    assert.equal(await answer.text(), missing);
  }
  assert.equal((await call(env, `${base}?shot=fightlog`, { token })).status, 404);
  // the limits preview counts the run's figures
  const preview = await (await call(env, "/api/admin/run-checks/limits", { session: SESSIONS.dev, method: "POST", body: { interlink: { fight: { clockRate: { max: 1.1 } } } } })).json();
  assert.equal(preview.interlink.fight.runs, 1);
  assert.deepEqual(preview.interlink.fight.flagged, { clockRate: 1 });

  // a follow-up without a log keeps file, figures and flag
  assert.equal((await send({})).status, 200);
  assert.equal(stored().proofFightLog, key);
  assert.equal(stored().fightStats.clockRate, 1.5);
  assert.equal(reviewOnly().flags.length, 1);
  // one with a log that can't be read keeps them too, and says why
  assert.equal((await send({}, new Blob([fightCsv(200)], { type: "application/gzip" }))).status, 200);
  assert.equal(stored().fightLogNote, "not gzip");
  assert.equal(stored().fightStats.clockRate, 1.5);
  assert.deepEqual((await (await call(env, `${base}?shot=list`, { session: SESSIONS.dev })).json()).fightLog, { stats: stored().fightStats, note: "not gzip" });
  // a steady log replaces them: the flag goes, the note too
  assert.equal((await send({}, gzipped(fightCsv(200)))).status, 200);
  assert.equal(stored().fightStats.clockRate, 1);
  assert.equal(stored().fightLogNote, undefined);
  assert.equal(reviewOnly(), undefined);

  // deleting the run deletes the log
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { session: SESSIONS.dev, method: "DELETE" })).status, 200);
  assert.equal(EVIDENCE.objects.has(key), false);
});

test("a fight log that is too big, isn't gzip or has too few rows is left out with a note; the run is stored all the same", async () => {
  const EVIDENCE = evidenceStore();
  const { env, sqlite } = await setup({ EVIDENCE, LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.user);
  const random = new Uint8Array(420 * 1024);
  for (let i = 0; i < random.length; i += 65536) crypto.getRandomValues(random.subarray(i, i + 65536));
  const cases = {
    "too large": new Blob([gzipSync(random, { level: 0 })], { type: "application/gzip" }),          // over 400 KB as sent
    "too large ": gzipped(fightCsv(200) + "9".repeat(3.2 * 1024 * 1024)),                         // over 3 MB unpacked
    "too large  ": gzipped(`wall_s,team_damage\n${"1,1\n".repeat(30001)}`),                        // over 30,000 lines
    "not gzip": new Blob([fightCsv(200)], { type: "application/gzip" }),
    "not gzip ": new Blob([gzipSync(Buffer.from(fightCsv(200)))], { type: "text/csv" }),
    "no rows": gzipped("wall_s,team_damage\n"),
    "too few rows": gzipped(fightCsv(19)),
  };
  let i = 0;
  for (const [note, log] of Object.entries(cases)) {
    const form = new FormData();
    form.set("submission", JSON.stringify(run(`bad-${i += 1}`)));
    form.set("evidence", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), "result.jpg");
    form.set("fightlog", log, "fight.csv.gz");
    const sent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
    assert.equal(sent.status, 201, note);
    const extra = JSON.parse(sqlite.prepare("SELECT extra_json AS e FROM leaderboard_submissions WHERE client_run_id = ?").get(`bad-${i}`).e);
    assert.deepEqual([extra.fightLogNote, extra.proofFightLog, extra.fightStats], [note.trim(), undefined, undefined], note);
  }
  // other accepted types; and without the result screen the part isn't read at all
  for (const type of ["application/x-gzip", "application/octet-stream"]) {
    const form = new FormData();
    form.set("submission", JSON.stringify(run(`ok-${type.length}`)));
    form.set("evidence", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), "result.jpg");
    form.set("fightlog", gzipped(fightCsv(30), type), "fight.csv.gz");
    assert.equal((await call(env, "/api/leaderboard/submissions", { token, method: "POST", form })).status, 201);
  }
  const alone = new FormData();
  alone.set("submission", JSON.stringify(run("no-evidence")));
  alone.set("fightlog", gzipped(fightCsv(30)), "fight.csv.gz");
  assert.equal((await call(env, "/api/leaderboard/submissions", { token, method: "POST", form: alone })).status, 201);
  assert.equal([...EVIDENCE.objects.keys()].filter((key) => key.endsWith("-fightlog.csv.gz")).length, 2);
  assert.equal(sqlite.prepare("SELECT extra_json AS e FROM leaderboard_submissions WHERE client_run_id = 'no-evidence'").get().e, null);
});

test("the fight log goes with the crops after 90 days; its figures stay", async () => {
  const EVIDENCE = evidenceStore();
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true", EVIDENCE });
  const token = await namedToken(env, SESSIONS.dev);
  const send = (id, clearTimeS) => {
    const form = new FormData();
    form.set("submission", JSON.stringify({ kind: "sim_run", clientRunId: id, trial: "Training of Fire", difficulty: "Hard", clearTimeS, cleared: true, partySize: 1 }));
    form.set("evidence", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), "result.jpg");
    form.set("fightlog", gzipped(fightCsv(40)), "fight.csv.gz");
    return call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
  };
  await send("slow", 500);
  await send("best", 300);
  const extra = (client) => JSON.parse(sqlite.prepare("SELECT extra_json AS e FROM leaderboard_submissions WHERE client_run_id = ?").get(client).e || "{}");
  const logs = () => [...EVIDENCE.objects.keys()].filter((key) => key.endsWith("-fightlog.csv.gz")).length;
  assert.equal(logs(), 2);
  // 20 days: the whole screens' group leaves the log alone
  sqlite.prepare("UPDATE leaderboard_submissions SET created_at = created_at - 20 * 86400").run();
  await sendRun(env, token, run("trigger-1"));
  assert.equal(logs(), 2);
  // 100 days: the slower run's log goes, its figures stay; the best keeps its log
  sqlite.prepare("UPDATE leaderboard_submissions SET created_at = created_at - 80 * 86400 WHERE client_run_id IN ('slow', 'best')").run();
  await sendRun(env, token, run("trigger-2"));
  assert.equal(logs(), 1);
  assert.equal(extra("slow").proofFightLog, undefined);
  assert.equal(extra("slow").fightStats.rows, 40);
  assert.ok(extra("best").proofFightLog);
});

test("second reading (shadow mode): Workers AI re-reads the whole screens; a mismatch is listed for review, never held", async () => {
  const EVIDENCE = evidenceStore();
  // a stand-in for Workers AI: the first result screen reads score 20000 / 20 stars / 3:00, the next 15000 / 15; the
  // Battle Data card MinMax 25913
  const AI = {
    calls: 0,
    results: 0,
    async run(model, input) {
      this.calls += 1;
      assert.equal(model, "@cf/meta/llama-3.2-11b-vision-instruct");
      assert.ok(Array.isArray(input.image) && input.image.length > 0);
      if (input.prompt.includes("Battle Data")) return { response: 'Here you go: {"cards": [{"name": "MinMax", "avgDps": "25,913", "break": null, "taken": null, "heal": null}]}' };
      this.results += 1;
      return { response: this.results === 1 ? '{"score": 20000, "stars": 20, "time": "3:00"}' : '{"score": 15000, "stars": 15, "time": "3:00"}' };
    },
  };
  const { env } = await setup({ EVIDENCE, AI, LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev });
  const token = await namedToken(env, SESSIONS.user);
  const send = (id, overrides) => {
    const form = new FormData();
    form.set("submission", JSON.stringify(run(id, overrides)));
    for (const part of ["evidence", "evidence_full", "battle", "battle_full"]) form.set(part, new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), `${part}.jpg`);
    return call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
  };
  assert.equal((await send("same")).status, 201);                                  // the run() defaults: 20000, 20 stars
  assert.equal((await send("differs", { score: 15500, stars: 15, boss: { id: "80000109", name: "Omega Sherro", level: 60 } })).status, 201);
  // two screens per run, each read once (the same picture read again gives the same answer)
  assert.equal(AI.calls, 4);
  const list = async (state, session = SESSIONS.dev) => call(env, `/api/admin/run-checks?state=${state}`, { session });
  assert.equal((await list("mismatch", SESSIONS.user)).status, 403);               // administrators and the owner only
  const mismatches = (await (await list("mismatch")).json()).runs;
  // sent 15,500, the picture shows 15,000 with 15 stars: a plausible reading that shows less than was sent
  assert.deepEqual(mismatches.map((r) => [r.score, r.check.differences, r.check.staff[0].why]), [[15500, [{ field: "score", sent: 15500, read: 15000 }], "picture shows less"]]);
  assert.equal(mismatches[0].check.reading2, undefined);
  assert.match(mismatches[0].proof.full, /\?shot=full$/u);
  const matched = (await (await list("match")).json()).runs;
  assert.deepEqual(matched.map((r) => [r.check.verifiedBy, r.check.reading.via]), [["reading", "prompt"]]);
  // the staff list: what the picture shows against what was sent, in words, with what Confirm does
  assert.equal((await call(env, "/api/admin/run-checks/staff", { session: SESSIONS.user })).status, 403);
  const staff = await (await call(env, "/api/admin/run-checks/staff", { session: SESSIONS.dev })).json();
  assert.equal(staff.count, 1);
  assert.equal(staff.runs[0].decides, "badge");
  assert.equal(staff.runs[0].reasons[0], "Its picture shows less than was sent: the picture shows score 15,000 and 15 stars; sent: score 15,500 and 15 stars.");
  assert.deepEqual((await (await call(env, "/api/admin/run-checks/staff?count=1", { session: SESSIONS.dev })).json()), { count: 1 });
  // public badges: the agreeing run is Verified; the one on the staff list shows nothing (never "mismatch" in public)
  const boardCheck = async (bossId) => (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json())
    .bosses.find((b) => String(b.id) === bossId).entries.find((e) => e.proofId)?.checks;
  assert.deepEqual(await boardCheck("80000107"), { score: "verified", teamDps: "verified" });
  assert.equal((await boardCheck("80000109")).score ?? null, null);
  const publicList = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json()).entries;
  assert.deepEqual(publicList.map((e) => e.check ?? "none").sort(), ["none", "verified"]);
  assert.equal(JSON.stringify(publicList).includes("mismatch"), false);
  // shadow mode: the mismatching run still stands on the boards
  assert.equal((await (await call(env, "/api/leaderboard/entries?kind=interlink_run")).json()).total, 2);
  // an administrator's review is recorded
  const reviewed = await call(env, `/api/admin/run-checks/${mismatches[0].submissionId}`, { session: SESSIONS.dev, method: "POST", body: { decision: "confirmed" } });
  assert.equal(reviewed.status, 200);
  const confirmed = (await (await list("confirmed")).json()).runs;
  assert.equal(confirmed[0].check.review.decision, "confirmed");
  // without the AI binding nothing is read
  const { env: plain } = await setup({ EVIDENCE: evidenceStore(), LEADERBOARD_PUBLIC: "true" });
  const form = new FormData();
  form.set("submission", JSON.stringify(run("no-ai")));
  form.set("evidence", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), "e.jpg");
  form.set("evidence_full", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), "f.jpg");
  assert.equal((await call(plain, "/api/leaderboard/submissions", { token: await namedToken(plain, SESSIONS.user), method: "POST", form })).status, 201);
});

test("second reading: times shown as \"180s\" are read, and a shifted Battle Data card is set aside, not a mismatch", async () => {
  // as measured on real runs: the time comes back as the screen shows it, and a card with a 0 row can come back shifted
  const AI = { async run(model, input) {
    return { response: input.prompt.includes("Battle Data")
      ? '{"cards": [{"name": "Best DPS", "avgDps": null, "break": null, "taken": 577441, "heal": 11397}]}'
      : '{"score": 20000, "stars": 20, "time": "180s"}' };
  } };
  const { env, sqlite } = await setup({ EVIDENCE: evidenceStore(), AI, LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.user);
  const form = new FormData();
  form.set("submission", JSON.stringify(run("timed", { cleared: true, clearTimeS: 180 })));
  for (const part of ["evidence", "evidence_full", "battle", "battle_full"]) form.set(part, new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), `${part}.jpg`);
  assert.equal((await call(env, "/api/leaderboard/submissions", { token, method: "POST", form })).status, 201);
  const row = sqlite.prepare("SELECT verify_state AS state, verify_json AS json FROM leaderboard_submissions WHERE client_run_id = 'timed'").get();
  const check = JSON.parse(row.json);
  assert.equal(row.state, "match");
  assert.deepEqual(check.differences, []);
  assert.equal(check.checked, 3);                                   // score, stars and the 3:00 time
  assert.deepEqual(check.suspect, ["MinMax"]);                      // the shifted card, matched by position
});

test("on the platform the checks run after the response (ctx.waitUntil), with every binding still in reach", async () => {
  const AI = { calls: 0, async run() { this.calls += 1; return { response: '{"score": 20000, "stars": 20, "time": "180s"}' }; } };
  const { env, sqlite } = await setup({ EVIDENCE: evidenceStore(), AI, LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.user);
  const form = new FormData();
  form.set("submission", JSON.stringify(run("later")));
  for (const part of ["evidence", "evidence_full"]) form.set(part, new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), `${part}.jpg`);
  const waiting = [];
  const response = await worker.fetch(new Request("https://api.aniilogs.example/api/leaderboard/submissions", {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: form }), env, { waitUntil: (promise) => waiting.push(promise) });
  assert.equal(response.status, 201);
  assert.equal(waiting.length, 2);                                   // answered first; the reading and picture retention left running
  await Promise.all(waiting);
  assert.equal(AI.calls, 1);
  assert.equal(sqlite.prepare("SELECT verify_state FROM leaderboard_submissions WHERE client_run_id = ?").get("later").verify_state, "match");
  // the rest of the API works the same through the scoped env
  assert.equal((await worker.fetch(new Request("https://api.aniilogs.example/api/leaderboard/interlink"), env, { waitUntil() {} })).status, 200);
});

test("free checks on every run; the AI reading only for runs that matter, and at most VERIFY_DAILY_LIMIT a day", async () => {
  const AI = { calls: 0, async run(model, input) { this.calls += 1; return { response: input.prompt.includes("Battle Data") ? '{"cards": []}' : '{"score": null}' }; } };
  const { env, sqlite } = await setup({ EVIDENCE: evidenceStore(), AI, LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev,
    VERIFY_DAILY_LIMIT: "2", VERIFY_TOP_RANK: "1" });
  const token = await namedToken(env, SESSIONS.user);
  const send = (id, overrides, screens = true) => {
    const form = new FormData();
    form.set("submission", JSON.stringify(run(id, overrides)));
    for (const part of screens ? ["evidence", "evidence_full", "battle", "battle_full"] : ["evidence"]) {
      form.set(part, new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), `${part}.jpg`);
    }
    return call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
  };
  const state = (id) => sqlite.prepare("SELECT verify_state AS state, verify_json AS json FROM leaderboard_submissions WHERE client_run_id = ?").get(id);
  // a sound run that's this player's first on the boss: a personal best, so it's read (2 screens)
  await send("pb", { score: 20000, stars: 20 });
  assert.equal(AI.calls, 2);
  assert.equal(JSON.parse(state("pb").json).reason, "personal best");
  // lower than their best and not top of the board: free checks only, passing (no state, the rules recorded)
  await send("ordinary", { score: 19000, stars: 19 });
  assert.equal(AI.calls, 2);
  assert.deepEqual([state("ordinary").state, JSON.parse(state("ordinary").json).rules.flags], [null, []]);
  // 36,230 with 6 stars: stars don't track score; Avg DPS far above the team's: misreads - no tick, no mark, not staff's
  await send("odd", { score: 36230, stars: 6, cycle: "4000", boss: { id: "80000098", name: "Alpha Scorchhowl", level: 60 },
    players: [{ name: "MinMax", avgDps: 1371292, self: true }] }, false);
  const odd = JSON.parse(state("odd").json).rules;
  assert.equal(state("odd").state, null);
  assert.deepEqual(odd.flags, []);
  assert.ok(["stars track score", "Avg DPS plausible", "Avg DPS add up to team DPS"].every((rule) => odd.misread.some((flag) => flag.rule === rule)));
  // more stars than the boss gives: impossible, so the staff list
  await send("over", { score: 45000, stars: 45, cycle: "4000", boss: { id: "80000098", name: "Alpha Scorchhowl", level: 60 }, players: [] }, false);
  assert.equal(state("over").state, "mismatch");
  assert.deepEqual(JSON.parse(state("over").json).staff.map((item) => item.rule), ["stars above the cap"]);
  // the daily cap (2 readings): a third run that matters waits in the queue ("pending", still on the boards)
  await send("pb2", { score: 15500, stars: 15, cycle: "3003", boss: { id: "80000099", name: "Alpha Irisal", level: 60 }, players: [] });
  await send("pb3", { score: 25500, stars: 25, cycle: "3003", boss: { id: "80000102", name: "Alpha Panpanta", level: 60 }, players: [] });
  assert.equal(AI.calls, 4);
  assert.deepEqual([state("pb3").state, JSON.parse(state("pb3").json).queued], ["pending", true]);
  assert.equal((await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json()).total, 6);   // shadow mode: the staff-listed run too
  // the cap raised: the next run that comes in also reads the oldest queued one
  env.VERIFY_DAILY_LIMIT = "10";
  await send("ordinary2", { score: 18000, stars: 18 });
  assert.equal(AI.calls, 6);
  assert.notEqual(state("pb3").state, "pending");
  // an administrator can drain the queue now (within the cap); here nothing is left
  assert.equal((await call(env, "/api/admin/run-checks/drain", { session: SESSIONS.user, method: "POST", body: {} })).status, 403);
  sqlite.prepare("UPDATE leaderboard_submissions SET verify_state = 'pending', verify_json = ? WHERE client_run_id = 'pb2'")
    .run(JSON.stringify({ rules: { flags: [] }, reason: "personal best", queued: true }));
  const drained = await (await call(env, "/api/admin/run-checks/drain", { session: SESSIONS.dev, method: "POST", body: { max: 5 } })).json();
  assert.deepEqual([drained.read, drained.queued], [1, 0]);
  assert.equal(AI.calls, 8);
});

test("anyone can see a shown entry's proof; a hidden entry's is its submitter's and developers' only", async () => {
  const EVIDENCE = evidenceStore();
  const { env } = await setup({ EVIDENCE, LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev });
  const userToken = await namedToken(env, SESSIONS.user);
  const form = new FormData();
  form.set("submission", JSON.stringify(run("with-shot")));
  form.set("evidence", new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "result.jpg");
  form.set("battle", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x01])], { type: "image/jpeg" }), "battle.jpg");
  const submitted = await call(env, "/api/leaderboard/submissions", { token: userToken, method: "POST", form });
  assert.equal(submitted.status, 201);
  const { submissionId, evidenceStored, battleEvidenceStored } = await submitted.json();
  assert.equal(evidenceStored, true);
  assert.equal(battleEvidenceStored, true);
  assert.equal(EVIDENCE.objects.size, 2);                                          // result screen + Battle Data
  const battle = await call(env, `/api/leaderboard/submissions/${submissionId}/evidence?shot=battle`);
  assert.equal(battle.status, 200);
  assert.equal((await battle.arrayBuffer()).byteLength, 4);
  const listed = await (await call(env, "/api/leaderboard/entries?kind=interlink_run")).json();
  assert.deepEqual([listed.entries[0].hasEvidence, listed.entries[0].hasBattleEvidence], [true, true]);

  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}/evidence`, { session: SESSIONS.user })).status, 200);
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}/evidence`, { session: SESSIONS.dev })).status, 200);
  // shown on the boards: anyone (no sign-in) can open its proof, and the boards point at it
  const shown = await call(env, `/api/leaderboard/submissions/${submissionId}/evidence`);
  assert.equal(shown.status, 200);
  assert.match(shown.headers.get("cache-control"), /public/u);
  const week = await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json();
  assert.deepEqual(week.bosses.flatMap((b) => b.entries).filter((e) => e.proofId).map((e) => e.proofId), [submissionId]);
  // too big: refused
  const huge = new FormData();
  huge.set("submission", JSON.stringify(run("huge-shot")));
  huge.set("evidence", new Blob([new Uint8Array(2 * 1024 * 1024)], { type: "image/jpeg" }), "result.jpg");
  assert.equal((await call(env, "/api/leaderboard/submissions", { token: userToken, method: "POST", form: huge })).status, 413);

  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { session: SESSIONS.user, method: "PATCH", body: { status: "hidden" } })).status, 403);
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { session: SESSIONS.dev, method: "PATCH", body: { status: "hidden" } })).status, 200);
  // hidden: only its submitter and developers
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}/evidence`)).status, 401);
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}/evidence`, { session: SESSIONS.dev2 })).status, 200);
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}/evidence`, { token: userToken })).status, 200);
  assert.equal((await (await call(env, "/api/leaderboard/entries?kind=interlink_run", { session: SESSIONS.user })).json()).total, 0);
  assert.equal((await (await call(env, "/api/leaderboard/entries?kind=interlink_run&hidden=1", { session: SESSIONS.dev })).json()).total, 1);

  // deleting: the owner and administrators only, not the sender nor a developer
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { token: userToken, method: "DELETE" })).status, 403);
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { session: SESSIONS.dev2, method: "DELETE" })).status, 403);
  assert.equal((await (await call(env, "/api/leaderboard/status", { session: SESSIONS.dev2 })).json()).canDeleteRuns, false);
  assert.equal((await (await call(env, "/api/leaderboard/status", { session: SESSIONS.dev })).json()).canDeleteRuns, true);
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { session: SESSIONS.dev, method: "DELETE" })).status, 200);
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

test("transfer everything: an administrator moves a whole account to a dispute's claimant and forces a reclaim", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev });
  const old = await desktopToken(env, SESSIONS.user);       // the player's second Discord account, aLogs signed in with it
  const fresh = await desktopToken(env, SESSIONS.dev2);     // the account they want to use
  const uid = "302000777777";
  const link = (token, form) => call(env, "/api/leaderboard/characters", { token, method: "POST", form });
  assert.equal((await link(old, proofForm({ gameUid: uid, name: "Kaela" }))).status, 201);
  for (const id of ["r1", "r2"]) {
    assert.equal((await call(env, "/api/leaderboard/submissions", { token: old, method: "POST", body: run(id, { gameUid: uid }) })).status < 300, true);
  }
  assert.equal((await call(env, "/api/leaderboard/submissions", { token: fresh, method: "POST", body: run("r2") })).status < 300, true);
  const sent = await call(env, "/api/leaderboard/characters/disputes", { token: fresh, method: "POST", form: proofForm({ gameUid: uid, name: "Kaela", note: "both mine" }) });
  const { disputeId } = await sent.json();
  const path = `/api/admin/character-disputes/${disputeId}`;

  // a developer can't (only administrators and the owner); the owner sees what would move
  assert.equal((await call(env, `${path}/transfer`, { session: SESSIONS.dev2 })).status, 403);
  assert.equal((await call(env, path, { session: SESSIONS.dev2, method: "PATCH", body: { action: "transfer", confirm: "TRANSFER" } })).status, 403);
  const preview = await (await call(env, `${path}/transfer`, { session: SESSIONS.dev })).json();
  assert.deepEqual([preview.from, preview.to, preview.characters, preview.runs, preview.appSignIns], ["user", "dev2", 1, 2, 1]);

  // TRANSFER has to be typed
  assert.equal((await call(env, path, { session: SESSIONS.dev, method: "PATCH", body: { action: "transfer" } })).status, 400);
  const done = await call(env, path, { session: SESSIONS.dev, method: "PATCH", body: { action: "transfer", confirm: "TRANSFER" } });
  assert.equal(done.status, 200);
  assert.equal((await done.json()).transferred.runs, 2);

  // everything is on the new account; the run it already had stays once (the old copy is left behind)
  const runs = (id) => sqlite.prepare("SELECT client_run_id AS r FROM leaderboard_submissions WHERE discord_id = ? ORDER BY r").all(id).map((row) => row.r);
  assert.deepEqual(runs(IDS.dev2), ["r1", "r2"]);
  assert.deepEqual(runs(IDS.user), ["r2"]);
  // the character is the new account's but unproven until its aLogs sees the game menu
  const character = sqlite.prepare("SELECT discord_id AS id, verified_at AS v FROM game_characters WHERE game_uid = ?").get(uid);
  assert.deepEqual([character.id, character.v], [IDS.dev2, null]);
  // the old account's aLogs is signed out
  assert.equal((await call(env, "/api/leaderboard/characters", { token: old })).status, 401);
  // the dispute is granted and can't be transferred twice
  assert.equal(sqlite.prepare("SELECT status FROM character_disputes WHERE dispute_id = ?").get(disputeId).status, "granted");
  assert.equal((await call(env, path, { session: SESSIONS.dev, method: "PATCH", body: { action: "transfer", confirm: "TRANSFER" } })).status, 409);
  // the reclaim: the new account's aLogs proves it again
  const reclaimed = await link(fresh, proofForm({ gameUid: uid, name: "Kaela" }));
  assert.equal((await reclaimed.json()).verified, true);
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
  const board = async (unlinked = "1") => (await (await call(env, `/api/leaderboard/interlink?cycle=3005&unlinked=${unlinked}`)).json()).bosses.find((x) => x.id === "80000109").entries;
  assert.deepEqual((await board()).map((e) => [e.player, e.score, e.uid, e.unclaimed]),
    [["MinMax", 14000, "302000000001", false], ["Kaela", 14000, null, true], ["Rook", 14000, null, true]]);   // no AI row
  // without "Show unlinked" the board lists linked players only
  assert.deepEqual((await board("0")).map((e) => e.player), ["MinMax"]);
  const linkedRuns = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json()).entries.map((e) => e.player);
  const allRuns = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0&unlinked=1")).json()).entries.map((e) => e.player);
  assert.deepEqual([linkedRuns.sort(), allRuns.sort()], [["MinMax"], ["Kaela", "MinMax", "Rook"]]);

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

  const entries = (await (await call(env, "/api/leaderboard/interlink?cycle=3005&unlinked=1")).json()).bosses.find((x) => x.id === "80000100").entries;
  // MinMax and Kaela once each (their teammate rows merged into their own), plus Rook's run with its unclaimed MinMax row
  assert.deepEqual(entries.map((e) => [e.player, e.score, e.unclaimed]).sort(),
    [["Kaela", 16064, false], ["MinMax", 15000, true], ["MinMax", 16064, false], ["Rook", 15000, false]].sort());
  const mine = await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0", { session: SESSIONS.dev })).json();
  const myRun = mine.entries.find((e) => e.submissionId && e.own && e.player === "MinMax" && e.score === 16064 && !e.teammate);
  assert.ok(myRun);
  assert.equal(JSON.stringify(mine).includes("302000000002\",\"confirmed"), false);              // recorded UIDs stay server-side  // more teammates' names than D1 takes in one query
  for (let i = 0; i < 40; i += 1) {
    await send(c, run(`many${i}`, { ...shared, score: 14000 - i, playedAt: 1792700100 + i, gameUid: "302000000003",
      players: [{ name: "Rook", ai: false, self: true }, { name: `Mate${i}a`, ai: false }, { name: `Mate${i}b`, ai: false }, { name: `Mate${i}c`, ai: false }] }));
  }
  for (const q of ["ladder=score&limit=10", "ladder=avg_dps&limit=10", "boss=80000100&ladder=score&limit=50"]) {
    const response = await call(env, `/api/leaderboard/interlink?cycle=3005&unlinked=1&${q}`);
    assert.equal(response.status, 200, `unlinked with ${q}: ${await response.clone().text()}`);
  }
});

test("a menu best that matches a run's score goes onto that run: the run keeps the row and opens with the menu picture", async () => {
  const { env } = await setup({ EVIDENCE: evidenceStore(), LEADERBOARD_PUBLIC: "true" });
  const token = await desktopToken(env, SESSIONS.dev);
  const jpeg = (mark) => { const data = new Uint8Array(2048); data.set([0xff, 0xd8, 0xff, mark]); return new Blob([data], { type: "image/jpeg" }); };
  await call(env, "/api/leaderboard/characters", { token, method: "POST", form: proofForm({ gameUid: "302000000001", name: "MinMax" }) });
  const sherro = { id: "80000109", name: "Omega Sherro", level: 60 };
  // the menu's best arrives first, then the run that made it: same stars, same score
  const menu = new FormData();
  menu.set("submission", JSON.stringify({ kind: "interlink_best", clientRunId: "best-3005-80000109", cycle: "3005", boss: sherro, score: 25000, stars: 20 }));
  menu.set("evidence", jpeg(4), "menu.jpg");
  const menuSent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form: menu });
  assert.ok([200, 201].includes(menuSent.status), String(menuSent.status));
  const menuId = (await menuSent.json()).submissionId;
  const tie = new FormData();
  tie.set("submission", JSON.stringify({ kind: "interlink_run", clientRunId: "il-tie", cycle: "3005", boss: sherro,
    score: 25000, stars: 20, clearTimeS: 150, cleared: true, partySize: 1, gameUid: "302000000001",
    players: [{ name: "MinMax", ai: false, self: true, avgDps: 9000 }] }));
  tie.set("evidence", jpeg(2), "result.jpg");
  tie.set("battle", jpeg(3), "battle.jpg");
  const tieSent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form: tie });
  assert.ok([200, 201].includes(tieSent.status), String(tieSent.status));
  const tieId = (await tieSent.json()).submissionId;
  const row = (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json()).bosses.find((x) => x.id === "80000109").entries
    .find((e) => e.player === "MinMax");
  assert.equal(row.score, 25000);
  assert.equal(row.proofId, tieId);                         // the run's row, though the menu best came first
  assert.equal(row.clearTimeS, 150);
  assert.equal(row.avgDps, 9000);
  assert.equal(row.menuProofId, menuId);                    // its pictures open with the menu's
  // a higher menu best gets a row of its own, with the run's pictures beside it
  const higher = new FormData();
  higher.set("submission", JSON.stringify({ kind: "interlink_best", clientRunId: "best-3005-80000109-b", cycle: "3005", boss: sherro, score: 26000, stars: 20 }));
  higher.set("evidence", jpeg(5), "menu.jpg");
  const higherSent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form: higher });
  assert.ok([200, 201].includes(higherSent.status), String(higherSent.status));
  const higherId = (await higherSent.json()).submissionId;
  const row2 = (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json()).bosses.find((x) => x.id === "80000109").entries
    .find((e) => e.player === "MinMax");
  assert.equal(row2.score, 26000);
  assert.equal(row2.proofId, higherId);
  assert.equal(row2.menuProofId, undefined);
  assert.equal(row2.proofIds.dps, tieId);                   // the DPS ladder: the run's figure and pictures
  const details = await (await call(env, `/api/leaderboard/submissions/${higherId}/evidence?shot=list`)).json();
  assert.equal(details.runProof, tieId);
});

test("a one-player ladder ranks a player's own best of that figure, from whichever run; the score board's row stays one run", async () => {
  const { env } = await setup({ EVIDENCE: evidenceStore(), LEADERBOARD_PUBLIC: "true" });
  const token = await desktopToken(env, SESSIONS.dev);
  const jpeg = (mark) => { const data = new Uint8Array(2048); data.set([0xff, 0xd8, 0xff, mark]); return new Blob([data], { type: "image/jpeg" }); };
  await call(env, "/api/leaderboard/characters", { token, method: "POST", form: proofForm({ gameUid: "302000000001", name: "MinMax" }) });
  const sherro = { id: "80000109", name: "Omega Sherro", level: 60 };
  const send = async (id, score, avgDps, breakValue, proof, extra = {}) => {
    const form = new FormData();
    form.set("submission", JSON.stringify({ kind: "interlink_run", clientRunId: id, cycle: "3005", boss: sherro, score, stars: 20, clearTimeS: 150, cleared: true, partySize: 1,
      gameUid: "302000000001", players: [{ name: "MinMax", ai: false, self: true, avgDps, breakValue, damageTaken: 5, heal: 1 }], ...extra }));
    if (proof) form.set("evidence", jpeg(2), "e.jpg");
    const sent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
    assert.ok([200, 201].includes(sent.status), String(sent.status));
    return (await sent.json()).submissionId;
  };
  const best = await send("own-a", 30000, 78448, 500, true);
  const dpsRun = await send("own-b", 20000, 108785, 400, true);
  const breakRun = await send("own-c", 21000, 90000, 900, false);
  const entry = async (query) => (await (await call(env, `/api/leaderboard/interlink?cycle=3005${query}`)).json()).bosses.find((x) => x.id === "80000109").entries.find((e) => e.player === "MinMax");
  const plain = await entry("&ladder=score");
  assert.equal(plain.score, 30000);
  assert.equal(plain.avgDps, 78448);                         // the score board's row: one run's figures
  const dps = await entry("&ladder=dps");
  assert.equal(dps.avgDps, 108785);                          // not the best score run's
  assert.equal(dps.proofIds.dps, dpsRun);
  assert.equal(dps.proofIds.score, best);
  const brk = await entry("&ladder=break");
  assert.equal(brk.breakValue, 900);
  assert.equal(brk.proofIds.break, undefined);               // that run has no picture: never another run's
  assert.equal("ownBests" in dps, false);
  // the rest, each from its own run
  const fast = await send("own-d", 19000, 100, 100, true, { clearTimeS: 90, cleared: true, teamDps: 777777, stars: 20 });
  const low = await send("own-e", 35000, 100, 100, true, { stars: 15, cleared: false, clearTimeS: 40 });
  assert.equal((await entry("&ladder=clear")).clearTimeS, 90);
  assert.equal((await entry("&ladder=clear")).proofIds.clear, fast);
  const team = await entry("&ladder=teamDps");
  assert.equal(team.teamDps, 777777);
  assert.equal(team.proofIds.teamDps, fast);
  const score = await entry("&ladder=score");
  assert.equal(score.score, 35000);                          // the highest score, though with fewer stars
  assert.equal(score.proofIds.score, low);
  assert.equal((await entry("")).score, 30000);              // no ladder asked: most stars, then score
});

test("a menu best's viewer shows the run a teammate's app sent for that player, as the boards do", async () => {
  const { env } = await setup({ EVIDENCE: evidenceStore(), LEADERBOARD_PUBLIC: "true" });
  const a = await desktopToken(env, SESSIONS.dev);
  const b = await desktopToken(env, SESSIONS.dev2);
  const jpeg = (mark) => { const data = new Uint8Array(2048); data.set([0xff, 0xd8, 0xff, mark]); return new Blob([data], { type: "image/jpeg" }); };
  await call(env, "/api/leaderboard/characters", { token: a, method: "POST", form: proofForm({ gameUid: "302000000001", name: "MinMax" }) });
  await call(env, "/api/leaderboard/characters", { token: b, method: "POST", form: proofForm({ gameUid: "302000000002", name: "Kaela" }) });
  const sherro = { id: "80000109", name: "Omega Sherro", level: 60 };
  const sendForm = async (token, body, marks) => {
    const form = new FormData();
    form.set("submission", JSON.stringify(body));
    for (const [field, mark] of marks) form.set(field, jpeg(mark), `${field}.jpg`);
    const sent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
    assert.ok([200, 201].includes(sent.status), String(sent.status));
    return (await sent.json()).submissionId;
  };
  const menuId = await sendForm(a, { kind: "interlink_best", clientRunId: "best-3005-80000109", cycle: "3005", boss: sherro, score: 25000, stars: 20 }, [["evidence", 4]]);
  // MinMax's own app missed the run; Kaela's sent it with MinMax in the party
  const runId = await sendForm(b, { kind: "interlink_run", clientRunId: "il-k", cycle: "3005", boss: sherro, score: 25000, stars: 20,
    clearTimeS: 150, cleared: true, partySize: 2, gameUid: "302000000002",
    players: [{ name: "Kaela", ai: false, self: true }, { name: "MinMax", ai: false, uid: "302000000001", avgDps: 9000 }] }, [["evidence", 2], ["battle", 3]]);
  const row = (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json()).bosses.find((x) => x.id === "80000109").entries
    .find((e) => e.player === "MinMax");
  assert.equal(row.proofId, runId);                         // the tying run a teammate's app sent keeps the row
  assert.equal(row.menuProofId, menuId);
  const details = await (await call(env, `/api/leaderboard/submissions/${menuId}/evidence?shot=list`)).json();
  assert.equal(details.runProof, runId);                    // the same run the clear ladder shows
});

test("only runs stored within five minutes of each other vouch, whatever their played time says; prep-screen scores and late runs never do", async () => {
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

  // the same numbers stored more than five minutes apart are another run, whatever playedAt says (here: the same second)
  sqlite.prepare("UPDATE leaderboard_submissions SET created_at = created_at - 600 WHERE client_run_id = 'm1'").run();
  await send(b, run("k-other", { ...shared, gameUid: "302000000002", playedAt: 1792700000,
    players: [{ name: "Kaela", ai: false, self: true }, { name: "MinMax", ai: false }] }));
  assert.equal(vouched(mine()), false);

  // played together, but sent more than five minutes after the first one: too late to vouch
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

test("a run sent without its score counts with the score its picture check read (2 Nov: Abzu's 15-star run)", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await namedToken(env, SESSIONS.dev);
  const send = (body) => call(env, "/api/leaderboard/submissions", { token: a, method: "POST", body });
  await send(run("lower", { score: 13430, stars: 13 }));
  await send(run("unscored", { score: null, stars: 15 }));
  const row = async () => (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json()).bosses
    .find((b) => b.id === "80000107").entries.find((e) => e.player === "DevOne");
  // most stars wins the row even before the score is known
  assert.deepEqual([(await row()).stars, (await row()).score], [15, null]);
  const reading = (stars) => JSON.stringify({ reading: { result: { score: 15218, stars, time: "180s" } } });
  sqlite.prepare("UPDATE leaderboard_submissions SET verify_state = 'match', verify_json = ? WHERE client_run_id = 'unscored'").run(reading(15));
  assert.deepEqual([(await row()).stars, (await row()).score], [15, 15218]);
  // a reading with other stars isn't taken
  sqlite.prepare("UPDATE leaderboard_submissions SET verify_json = ? WHERE client_run_id = 'unscored'").run(reading(14));
  assert.equal((await row()).score, null);
});

test("a row carries the name of the character that played the run, not the account's newest (2 Nov: Abzu shown as SanHao)", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await namedToken(env, SESSIONS.dev);
  await call(env, "/api/leaderboard/submissions", { token: a, method: "POST", body: run("best", { gameUid: TEST_CHARACTERS[SESSIONS.dev][0], score: 15000, stars: 15 }) });
  const { discord_id: who } = sqlite.prepare("SELECT discord_id FROM leaderboard_submissions WHERE client_run_id = 'best'").get();
  // the same account links a second character, seen later
  sqlite.prepare(`INSERT INTO game_characters (game_uid, discord_id, character_name, source, linked_at, last_seen_at)
    VALUES ('309999999999', ?, 'AltTwo', 'meter', 1, 9999999999)`).run(who);
  const entry = (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json()).bosses
    .find((b) => b.id === "80000107").entries[0];
  assert.equal(entry.player, "DevOne");
  assert.notEqual(entry.uid, "309999999999");
});

test("each player's row says when their best run reached the site, and only a new best moves it", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await namedToken(env, SESSIONS.dev);
  const send = (body) => call(env, "/api/leaderboard/submissions", { token: a, method: "POST", body });
  const at = (id, when) => sqlite.prepare("UPDATE leaderboard_submissions SET created_at = ? WHERE client_run_id = ?").run(when, id);
  const week = async () => (await call(env, "/api/leaderboard/interlink?cycle=3005")).json();
  const mine = (data) => data.bosses.find((b) => b.id === "80000107").entries.find((e) => e.player === "DevOne");
  await send(run("best", { score: 15000, stars: 15 })); at("best", 1000);
  await send(run("worse", { score: 9000, stars: 9 })); at("worse", 2000);
  assert.equal(mine(await week()).updatedAt, 1000);            // a worse run later doesn't count as an update
  await send(run("better", { score: 18000, stars: 18 })); at("better", 3000);
  const data = await week();
  assert.equal(mine(data).updatedAt, 3000);
  assert.equal(data.week.find((e) => e.player === "DevOne").updatedAt, 3000);
  const season = await (await call(env, "/api/leaderboard/interlink?season=1")).json();
  assert.equal(season.standings.find((e) => e.player === "DevOne").updatedAt, 3000);
});

test("boss boards show each player's one best run, its Battle Data and its pictures as proof", async () => {
  const EVIDENCE = evidenceStore();
  const { env } = await setup({ EVIDENCE, LEADERBOARD_PUBLIC: "true" });
  const a = await namedToken(env, SESSIONS.dev);
  const sherro = { id: "80000109", name: "Omega Sherro", level: 60 };
  const send = async (id, overrides, cards) => {
    const form = new FormData();
    form.set("submission", JSON.stringify(run(id, { boss: sherro, ...overrides, players: [
      { name: "DevOne", ai: false, self: true, ...cards[0] }, { name: "Kaela", ai: false, ...cards[1] }] })));
    form.set("evidence", new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "result.jpg");
    const response = await call(env, "/api/leaderboard/submissions", { token: a, method: "POST", form });
    return (await response.json()).submissionId;
  };
  // run 1: best score; run 2: a clear, and my best DPS; Kaela's numbers come from the runs she was in
  const high = await send("r1", { stars: 16, score: 20000 }, [{ avgDps: 15000, breakValue: 280000, damageTaken: 4000, heal: 0 }, { avgDps: 16000, heal: 900 }]);
  const fast = await send("r2", { stars: 15, score: 16000, cleared: true, clearTimeS: 140 }, [{ avgDps: 19000, breakValue: 200000, damageTaken: 6000, heal: 50 }, { avgDps: 12000, heal: 1200 }]);
  const week = await (await call(env, "/api/leaderboard/interlink?cycle=3005&unlinked=1")).json();
  const rows = week.bosses.find((b) => b.id === "80000109").entries;
  const me = rows.find((e) => e.player === "DevOne");
  // one run per row, the best (most stars, then score): all its figures and its pictures, never another run's
  assert.deepEqual([me.score, me.clearTimeS, me.avgDps, me.breakValue, me.damageTaken, me.heal], [20000, null, 15000, 280000, 4000, 0]);
  assert.deepEqual(me.proofIds, { score: high, teamDps: high, dps: high, break: high, taken: high, heal: high });
  const kaela = rows.find((e) => e.player === "Kaela");
  assert.deepEqual([kaela.avgDps, kaela.heal, kaela.proofIds.dps, kaela.proofIds.heal], [16000, 900, high, high]);

  // "All runs" ranks by those stats too: each player's own card, their best run for it
  const all = async (sort) => (await (await call(env, `/api/leaderboard/entries?kind=interlink_run&sort=${sort}&unlinked=1`)).json()).entries;
  assert.deepEqual((await all("p_dps")).map((e) => [e.player, e.avgDps]), [["DevOne", 19000], ["Kaela", 16000]]);
  assert.deepEqual((await all("p_heal")).map((e) => [e.player, e.heal]), [["Kaela", 1200], ["DevOne", 50]]);
  assert.deepEqual((await all("p_break")).map((e) => [e.player, e.breakValue, e.submissionId]), [["DevOne", 280000, high]]);
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
  // by rank points: Egg Emperors (maxed) first, by their stars, even one without points; then the others by points
  assert.equal(await submit(devToken, standing("eh-S0", "S0", 7, 1, "Egg Emperor", null, 600)), 201);
  const byPoints = await get("kind=eggheist_season&sort=score");
  assert.deepEqual(byPoints.entries.map((entry) => [entry.player, entry.cycle, entry.score]),
    [["DevOne", "S0", null], ["DevOne", "S1", 2900], ["DevTwo", "S1", 3100], ["DevTwo", "S0", 2400]]);
  const lowestFirst = await get("kind=eggheist_season&sort=score&order=asc");
  assert.deepEqual(lowestFirst.entries.map((entry) => entry.score), [2400, 3100, 2900, null]);
  const facets = await (await call(env, "/api/leaderboard/facets?mode=eggheist", { session: SESSIONS.dev })).json();
  assert.deepEqual(facets.cycles.map((row) => row.value), ["S1", "S0"]);

  // a standing has a season; ones early builds sent without it stay off the ladder (they'd be a second row)
  assert.equal(await submit(devToken, standing("eggheist-2026", null, 7, 1, "Egg Emperor", 2900, 475)), 400);
  await env.DB.prepare("UPDATE leaderboard_submissions SET cycle = NULL WHERE kind = 'eggheist_season' AND cycle = 'S0'").run();
  assert.deepEqual((await get("kind=eggheist_season")).entries.map((entry) => [entry.player, entry.cycle]), [["DevOne", "S1"], ["DevTwo", "S1"]]);
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

test("each character (UID) keeps its own progress, starting from the account's", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await desktopToken(env, SESSIONS.user);
  for (const [gameUid, name] of [["302000000011", "MainNA"], ["303000000022", "AltEU"]]) {
    await call(env, "/api/leaderboard/characters", { token, method: "POST", body: { gameUid, name } });
  }
  const save = (progress, uid = "") => call(env, `/api/progress${uid ? `?uid=${uid}` : ""}`, { session: SESSIONS.user, method: "PUT", body: { progress } });
  const read = async (uid = "") => (await (await call(env, `/api/progress${uid ? `?uid=${uid}` : ""}`, { session: SESSIONS.user })).json()).progress;
  await save({ tracking: [], completed: ["pin:before"], preferences: {} });          // tracked before characters existed

  // each character starts from the account's progress, then goes its own way
  assert.deepEqual((await read("302000000011")).completed, ["pin:before"]);
  assert.deepEqual((await read("303000000022")).completed, ["pin:before"]);
  assert.equal((await save({ tracking: [], completed: ["pin:before", "pin:na-only"], preferences: {} }, "302000000011")).status, 200);
  const patch = await call(env, "/api/progress/completed?uid=303000000022", { token, method: "PATCH", body: { set: ["aniimo:7:caught"] } });
  assert.equal(patch.status, 200);
  assert.deepEqual((await read("302000000011")).completed.sort(), ["pin:before", "pin:na-only"]);
  assert.deepEqual((await read("303000000022")).completed.sort(), ["aniimo:7:caught", "pin:before"]);
  assert.deepEqual((await read()).completed, ["pin:before"]);                             // the account copy is untouched

  // someone else's character, or a made-up UID, is refused
  const other = await desktopToken(env, SESSIONS.dev);
  await call(env, "/api/leaderboard/characters", { token: other, method: "POST", body: { gameUid: "302000000099", name: "Someone" } });
  assert.equal((await call(env, "/api/progress/completed?uid=302000000099", { token })).status, 404);
  assert.equal((await call(env, "/api/progress?uid=abc", { session: SESSIONS.user })).status, 400);
});

test("the profile follows a main character: automatic first, then the one picked", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await desktopToken(env, SESSIONS.user);
  await call(env, "/api/leaderboard/characters", { token, method: "POST", body: { gameUid: "302000000011", name: "MainNA" } });
  await call(env, "/api/leaderboard/characters", { token, method: "POST", form: proofForm({ gameUid: "303000000022", name: "AltEU" }) });
  await call(env, "/api/progress/completed?uid=302000000011", { token, method: "PATCH", body: { set: ["aniimo:1:standard"] } });
  await call(env, "/api/progress/completed?uid=303000000022", { token, method: "PATCH", body: { set: ["aniimo:2:standard", "aniimo:3:standard"] } });
  const overview = async () => (await call(env, "/api/profile/overview", { session: SESSIONS.user })).json();

  // automatic: the character proven in the game menu
  let o = await overview();
  assert.deepEqual([o.main.name, o.main.picked, o.collection.aniilog.standard], ["AltEU", false, 2]);
  // picked: the profile's collection follows it
  assert.equal((await call(env, "/api/profile/main", { session: SESSIONS.user, method: "PUT", body: { gameUid: "302000000011" } })).status, 200);
  o = await overview();
  assert.deepEqual([o.main.name, o.main.picked, o.collection.aniilog.standard], ["MainNA", true, 1]);
  const listed = await (await call(env, "/api/leaderboard/characters", { session: SESSIONS.user })).json();
  assert.deepEqual(listed.characters.filter((c) => c.main).map((c) => c.name), ["MainNA"]);
  // someone else's character can't be the main; null goes back to automatic
  assert.equal((await call(env, "/api/profile/main", { session: SESSIONS.user, method: "PUT", body: { gameUid: "302000000099" } })).status, 404);
  assert.equal((await call(env, "/api/profile/main", { session: SESSIONS.user, method: "PUT", body: { gameUid: null } })).status, 200);
  assert.equal((await overview()).main.name, "AltEU");
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
  await submit(devToken, { kind: "interlink_run", clientRunId: "r-noboss", score: 22000 });   // boss not recognised
  await submit(devToken, { kind: "sim_run", clientRunId: "s1", clearTimeS: 1800, cleared: true, floors: 16 });
  await submit(dev2Token, { kind: "sim_run", clientRunId: "s2", clearTimeS: 2400, cleared: true, floors: 16 });
  await submit(devToken, { kind: "eggheist_season", clientRunId: "eh", cycle: "S1", rank: { tier: 7, subtier: 1, name: "Egg Emperor" }, score: 2900, stars: 475,
    extra: { nextRankAt: 2370, lastGain: 18, bar: [1337, 1350], barAt: 1793167625, secret: "not for the profile" } });
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
  // Best per boss, placed as that week's board places it (its Score ladder, team rows). DevTwo's 25,000 isn't on the
  // board (no character linked), so it doesn't count against MinMax either (it did before the profile read the board).
  assert.deepEqual(runs.map((row) => [row.boss.name, row.score, row.position, row.players, row.counts, row.character]),
    [["Omega Infergon", 22000, 1, 1, "teams", "MinMax"], ["Omega Tucking", 9000, 1, 1, "teams", null]]);
  assert.deepEqual(weeks, []);
  assert.deepEqual(sims.map((row) => [row.clearTimeS, row.position, row.players]), [[1800, 1, 2]]);
  assert.deepEqual(heists.map((row) => [row.cycle, row.seasonRank.name, row.stars, row.score, row.position, row.players]),
    [["S1", "Egg Emperor", 475, 2900, 2, 2]]);
  // the profile's season progress: just these fields, nothing else from the app's extra
  assert.deepEqual(heists[0].seasonProgress, { nextRankAt: 2370, lastGain: 18, bar: [1337, 1350], barAt: 1793167625 });
  // ...and a match that lost points stays a loss
  await submit(devToken, { kind: "eggheist_season", clientRunId: "eh", cycle: "S1", rank: { tier: 7, subtier: 1, name: "Egg Emperor" }, score: 2900, stars: 475, extra: { lastGain: -12 } });
  const afterLoss = await (await call(env, "/api/profile/overview", { session: SESSIONS.dev })).json();
  assert.equal(afterLoss.leaderboards.eggheist_season[0].seasonProgress.lastGain, -12);

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

  // a misread boss (not one of the week's bosses) is refused, and a misread name of a real one takes the week's name
  assert.equal((await send(a, { kind: "interlink_best", clientRunId: "best-3005-x", cycle: "3005", boss: boss("80000999", "Omega Tuekin"), score: 9000, stars: 9 })).status, 400);
  assert.equal((await send(a, run("w4", { cycle: "3005", boss: boss("80000109", "Omega Sherr0"), score: 100 }))).status, 201);
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

test("Interlink from week 4000: a clear is 20 stars, and a two-boss middle fight's second boss counts as the middle", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const dev = await desktopToken(env, SESSIONS.dev);
  const bosses = [{ id: "80000110", name: "Omega Left" }, { id: "80000111", name: "Omega Middle" }, { id: "80000112", name: "Omega Right" }];
  const cycles = [
    { id: "4000", season: 2, start: 1793800000, end: 1794399999, bosses, bosses2: null },
    { id: "4003", season: 2, start: 1795600000, end: 1796199999, bosses, bosses2: { id: "80000119", name: "Omega Second" } },
    { id: "4004", season: 2, start: 1796200000, end: 1796799999, bosses, bosses2: [null, { id: "80000121", name: "Omega Other" }, null] },
    { id: "4005", season: 2, start: 1796800000, end: 1797399999, bosses },
  ];
  const upload = (body) => call(env, "/api/leaderboard/interlink/cycles", { token: dev, method: "POST", body });
  assert.equal((await upload({ cycles: [{ ...cycles[1], bosses2: { id: "x", name: "Bad" } }] })).status, 400);
  assert.equal((await upload({ cycles })).status, 200);
  const send = async (session, body) => call(env, "/api/leaderboard/submissions", { token: await namedToken(env, session), method: "POST", body });
  const boss = (id) => ({ id, name: "Misread", level: 60 });
  // week 4000: 15 stars and under the clock is no longer a clear - it was quit before it could count (invalid: on no
  // board, only in the player's history); 20 is
  assert.equal((await send(SESSIONS.dev, run("c1", { cycle: "4000", boss: boss("80000110"), stars: 15, score: 15000, clearTimeS: 120, cleared: true }))).status, 201);
  assert.equal((await send(SESSIONS.user, run("c2", { cycle: "4000", boss: boss("80000110"), stars: 20, score: 21000, clearTimeS: 150, cleared: true }))).status, 201);
  const week = await (await call(env, "/api/leaderboard/interlink?cycle=4000")).json();
  assert.deepEqual(week.bosses[0].entries.map((e) => [e.stars, e.clearTimeS]), [[20, 150]]);
  // the center boss is a kill only at its full 40 stars: 26 stars under the clock was quit (invalid)
  assert.equal((await send(SESSIONS.dev, run("k1", { cycle: "4000", boss: boss("80000111"), stars: 26, score: 26000, clearTimeS: 95, cleared: true }))).status, 201);
  assert.equal((await send(SESSIONS.user, run("k2", { cycle: "4000", boss: boss("80000111"), stars: 40, score: 44000, clearTimeS: 170, cleared: true }))).status, 201);
  const center = (await (await call(env, "/api/leaderboard/interlink?cycle=4000")).json());
  assert.deepEqual(center.bosses[1].entries.map((e) => [e.stars, e.clearTimeS]), [[40, 170]]);
  assert.deepEqual(center.rules.clearStars, [20, 40, 20]);
  // the same line for the "fastest clear" sort over every run
  const fastest = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run&sort=clear_time_s&cycle=4000&boss=80000111&best=0")).json()).entries;
  assert.deepEqual(fastest.map((e) => [e.stars, e.clearTimeS]), [[40, 170]]);
  // the second middle boss: from the upload (as one boss or a list), or the game's ids when the week has none
  for (const [cycle, id] of [["4003", "80000119"], ["4004", "80000121"], ["4005", "80000123"]]) {
    assert.equal((await send(SESSIONS.dev, run(`m${cycle}`, { cycle, boss: boss(id), score: 18000 }))).status, 201);
    const board = (await (await call(env, `/api/leaderboard/interlink?cycle=${cycle}`)).json()).bosses;
    assert.deepEqual(board.map((b) => [b.id, b.entries.length]), [["80000110", 0], ["80000111", 1], ["80000112", 0]]);
  }
  // only the middle: another week's second boss is still refused
  assert.equal((await send(SESSIONS.dev, run("m4000", { cycle: "4000", boss: boss("80000119") }))).status, 400);
  assert.equal((await send(SESSIONS.dev, run("m4003b", { cycle: "4003", boss: boss("80000121") }))).status, 400);
  // the game's own cap, read by aLogs (extra.starCap): if a patch raised a side boss to 25, a kill is 25 stars, and the
  // run gets a note so the rules get updated (a note is never a reason for staff or a badge)
  assert.equal((await send(SESSIONS.dev, run("cap1", { cycle: "4005", boss: boss("80000110"), stars: 22, score: 23000, clearTimeS: 100, cleared: true, extra: { starCap: 25 } }))).status, 201);
  assert.equal((await send(SESSIONS.user, run("cap2", { cycle: "4005", boss: boss("80000110"), stars: 25, score: 26000, clearTimeS: 140, cleared: true, extra: { starCap: 25 } }))).status, 201);
  const raised = await (await call(env, "/api/leaderboard/interlink?cycle=4005")).json();
  assert.deepEqual(raised.bosses[0].entries.map((e) => [e.stars, e.clearTimeS]), [[25, 140]]);   // 22 at 1:40: quit
  const rules = (id) => JSON.parse(sqlite.prepare("SELECT verify_json FROM leaderboard_submissions WHERE client_run_id = ?").get(id).verify_json).rules;
  const checked = (id) => [...rules(id).flags, ...rules(id).misread, ...rules(id).notes];
  assert.deepEqual(rules("cap2").notes.map((flag) => [flag.rule, flag.sent, flag.expected]), [["star cap matches the rules", 25, 20]]);
  assert.deepEqual(rules("cap2").flags, []);                                         // 25 stars under the game's own cap of 25
  assert.ok(rules("cap1").misread.some((flag) => flag.rule === "cleared needs full stars" && flag.expected === 25));
  // a cap that agrees with the rules, or none, or a silly one: judged by the rules, nothing about the cap
  assert.equal((await send(SESSIONS.dev, run("cap3", { cycle: "4005", boss: boss("80000112"), stars: 20, score: 21000, clearTimeS: 90, cleared: true, extra: { starCap: 20 } }))).status, 201);
  assert.equal((await send(SESSIONS.user, run("cap4", { cycle: "4005", boss: boss("80000112"), stars: 20, score: 21000, clearTimeS: 95, cleared: true, extra: { starCap: 5000 } }))).status, 201);
  assert.deepEqual([...checked("cap3"), ...checked("cap4")], []);
  const right = (await (await call(env, "/api/leaderboard/interlink?cycle=4005")).json()).bosses[2];
  assert.deepEqual(right.entries.map((e) => [e.stars, e.clearTimeS]), [[20, 90], [20, 95]]);
});

test("the desktop app signs in through the player's own browser: one-time code + PKCE secret, never the website's exchange", async () => {
  const { env } = await setup({ DISCORD_CLIENT_ID: "123", DISCORD_CLIENT_SECRET: "s", SESSION_SECRET: "x".repeat(40), LEADERBOARD_PUBLIC: "true" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes("/oauth2/token")
    ? Response.json({ access_token: "discord-access" })
    : Response.json({ id: IDS.user, username: "user", global_name: "User One" }));
  try {
    const verifier = "v".repeat(43);
    const challenge = await tokenHash(verifier);
    const start = await worker.fetch(new Request(`https://api.aniilogs.example/api/auth/discord/start?app_port=51234&app_challenge=${challenge}`), env);
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const cookie = start.headers.get("set-cookie").split(";")[0];
    assert.equal((await worker.fetch(new Request("https://api.aniilogs.example/api/auth/discord/start?app_port=80&app_challenge=x"), env)).status, 400);

    // Discord sends the browser back; the API hands it to the app on 127.0.0.1, not to the website
    const back = await worker.fetch(new Request(`https://api.aniilogs.example/api/auth/discord/callback?state=${state}&code=abc`, { headers: { cookie } }), env);
    const location = new URL(back.headers.get("location"));
    assert.equal(location.origin, "http://127.0.0.1:51234");
    const code = location.searchParams.get("code");

    const exchange = (body) => call(env, "/api/auth/app/exchange", { method: "POST", body });
    assert.equal((await call(env, "/api/auth/exchange", { session: "", method: "POST", body: { handoff: code } })).status, 403);   // no site origin
    const site = await worker.fetch(new Request("https://api.aniilogs.example/api/auth/exchange", {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ handoff: code }) }), env);
    assert.equal(site.status, 401);                                       // the website can't redeem an app code
    assert.equal((await exchange({ code, verifier: "w".repeat(43) })).status, 401);   // wrong secret
    const ok = await exchange({ code, verifier, device: "Gaming PC" });
    assert.equal(ok.status, 200);
    const { token, account } = await ok.json();
    assert.match(token, /^alb_/u);
    assert.equal(account.name, "User One");
    assert.equal((await exchange({ code, verifier })).status, 401);       // one use only
    assert.equal(ok.headers.get("access-control-allow-origin"), "*");

    // the token works like a copied desktop token, shows who it is, and signs the app's site view in
    assert.equal((await (await call(env, "/api/auth/app/account", { token })).json()).account.name, "User One");
    const { handoff } = await (await call(env, "/api/auth/app/site-handoff", { token, method: "POST" })).json();
    const session = await worker.fetch(new Request("https://api.aniilogs.example/api/auth/exchange", {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ handoff }) }), env);
    assert.equal(session.status, 200);
    assert.equal((await call(env, "/api/auth/app/site-handoff", { session: SESSIONS.user, method: "POST" })).status, 401);   // tokens only

    // signing out revokes it
    assert.equal((await call(env, "/api/auth/app/sign-out", { token, method: "POST" })).status, 200);
    assert.equal((await call(env, "/api/auth/app/account", { token })).status, 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Egg Heist matches: loot, time, escaped or not, difficulty and Total Defeats, best loot per player", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await namedToken(env, SESSIONS.dev);
  const b = await namedToken(env, SESSIONS.user);
  const match = (id, over) => ({ kind: "eggheist_match", clientRunId: id, cycle: "S1", score: 20000, clearTimeS: 224, cleared: true,
    difficulty: "Normal", defeats: 1, playedAt: Math.floor(Date.now() / 1000), ...over });
  const send = (token, body) => call(env, "/api/leaderboard/submissions", { token, method: "POST", body });
  const first = await send(a, match("m1", { score: 23733 }));
  assert.equal(first.status, 201, await first.clone().text());
  assert.equal((await send(a, match("m2", { score: 31000, difficulty: "Hard", defeats: 4, clearTimeS: 300 }))).status, 201);
  assert.equal((await send(b, match("m3", { score: 9000, cleared: false, defeats: 0 }))).status, 201);
  assert.equal((await send(a, match("bad", { difficulty: "<b>" }))).status, 400);

  const get = async (query) => (await (await call(env, `/api/leaderboard/entries?kind=eggheist_match&${query}`)).json()).entries;
  assert.deepEqual((await get("")).map((e) => [e.player, e.score, e.difficulty, e.defeats, e.cleared]),
    [["DevOne", 31000, "Hard", 4, true], ["UserOne", 9000, "Normal", 0, false]]);   // best loot per player
  assert.deepEqual((await get("difficulty=Normal")).map((e) => [e.player, e.score]), [["DevOne", 23733], ["UserOne", 9000]]);
  assert.deepEqual((await get("cleared=1&best=0")).map((e) => e.score), [31000, 23733]);   // escapes only
  // the Outcome and Season headers: escapes first (or failures, flipped), each player's row still their best loot
  assert.deepEqual((await get("sort=cleared")).map((e) => [e.player, e.cleared]), [["DevOne", true], ["UserOne", false]]);
  assert.deepEqual((await get("sort=cleared&order=asc")).map((e) => [e.player, e.cleared]), [["UserOne", false], ["DevOne", true]]);
  assert.deepEqual((await get("sort=cycle")).map((e) => [e.player, e.score]), [["DevOne", 31000], ["UserOne", 9000]]);
  const facets = await (await call(env, "/api/leaderboard/facets?mode=eggheist")).json();
  assert.deepEqual(facets.difficulties.map((d) => d.value), ["Hard", "Normal"]);
});

test("Matches sort by difficulty (Chaos > Nightmare > Hard > Normal), player name and date; each player's row stays their best loot", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await namedToken(env, SESSIONS.dev);
  const b = await namedToken(env, SESSIONS.user);
  const c = await namedToken(env, SESSIONS.dev2);
  const t = Math.floor(Date.now() / 1000);
  const send = (token, id, over) => call(env, "/api/leaderboard/submissions", { token, method: "POST", body: {
    kind: "eggheist_match", clientRunId: id, cycle: "S1", score: 10000, clearTimeS: 200, cleared: true, difficulty: "Normal", defeats: 1, playedAt: t, ...over } });
  await send(a, "a1", { score: 40000, difficulty: "Normal", playedAt: t - 300 });
  await send(a, "a2", { score: 15000, difficulty: "Chaos", playedAt: t - 10 });      // harder but less loot: not DevOne's row
  await send(b, "b1", { score: 20000, difficulty: "Nightmare", playedAt: t - 200 });
  await send(c, "c1", { score: 30000, difficulty: "Hard", playedAt: t - 100 });
  const get = async (q) => (await (await call(env, `/api/leaderboard/entries?kind=eggheist_match&${q}`)).json()).entries.map((e) => [e.player, e.difficulty]);
  assert.deepEqual(await get("sort=difficulty"), [["UserOne", "Nightmare"], ["DevTwo", "Hard"], ["DevOne", "Normal"]]);
  assert.deepEqual(await get("sort=difficulty&best=0"), [["DevOne", "Chaos"], ["UserOne", "Nightmare"], ["DevTwo", "Hard"], ["DevOne", "Normal"]]);
  assert.deepEqual(await get("sort=player"), [["DevOne", "Normal"], ["DevTwo", "Hard"], ["UserOne", "Nightmare"]]);
  assert.deepEqual(await get("sort=player&order=desc"), [["UserOne", "Nightmare"], ["DevTwo", "Hard"], ["DevOne", "Normal"]]);
  assert.deepEqual(await get("sort=played_at"), [["DevTwo", "Hard"], ["UserOne", "Nightmare"], ["DevOne", "Normal"]]);
});

test("profile search finds public profiles by character name or UID, and never private ones", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await namedToken(env, SESSIONS.dev);    // DevOne, UID 301000000001
  await namedToken(env, SESSIONS.user);   // UserOne, UID 301000000003
  const save = (session, body) => call(env, "/api/profile", { session, method: "PATCH", body });
  const dev = await (await save(SESSIONS.dev, { displayName: "Secret Discord Name", isPublic: true })).json();
  await save(SESSIONS.user, { displayName: "Private Person", isPublic: false });
  const find = async (q) => (await (await call(env, `/api/profiles/search?q=${encodeURIComponent(q)}`)).json()).results;

  assert.deepEqual(await find("devo"), [{ publicId: dev.profile.publicId, characters: [{ name: "DevOne", gameUid: "301000000001" }] }]);
  assert.deepEqual((await find("3010000000")).map((r) => r.characters[0].name), ["DevOne"]);   // UID start; UserOne is private
  assert.deepEqual(await find("UserOne"), []);                    // private profile: not findable
  assert.deepEqual(await find("Secret"), []);                     // display names only when their owner opts in
  const opted = await (await save(SESSIONS.dev, { displayName: "Secret Discord Name", isPublic: true, findableByName: true })).json();
  assert.equal(opted.profile.findableByName, true);
  assert.deepEqual(await find("secret disc"), [{ publicId: dev.profile.publicId, displayName: "Secret Discord Name",
    characters: [{ name: "DevOne", gameUid: "301000000001" }] }]);
  assert.equal((await (await call(env, `/api/profiles/${dev.profile.publicId}`)).json()).profile.displayName, "Secret Discord Name");
  await save(SESSIONS.user, { displayName: "Private Person", isPublic: false, findableByName: true });
  assert.deepEqual(await find("Private"), []);                    // opted in but private: still not findable
  await save(SESSIONS.dev, { displayName: "Secret Discord Name", isPublic: true, findableByName: false });
  assert.deepEqual(await find("Secret"), []);
  assert.equal((await (await call(env, `/api/profiles/${dev.profile.publicId}`)).json()).profile.displayName, "DevOne");
  assert.equal((await save(SESSIONS.dev, { displayName: "X", findableByName: "yes" })).status, 400);
  assert.deepEqual(await find("%"), []);                          // wildcards are plain text
  assert.deepEqual(await find("_"), []);
  assert.deepEqual(await find("d"), []);                          // too short
});

test("the profiles sitemap lists public profiles until their owner turns search listing off", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await namedToken(env, SESSIONS.dev);
  await namedToken(env, SESSIONS.user);
  const save = (session, body) => call(env, "/api/profile", { session, method: "PATCH", body });
  const dev = await (await save(SESSIONS.dev, { displayName: "Dev", isPublic: true })).json();
  await save(SESSIONS.user, { displayName: "Private Person", isPublic: false });
  const sitemap = async () => {
    const response = await call(env, "/api/sitemap/profiles.xml");
    assert.match(response.headers.get("content-type"), /application\/xml/u);
    return response.text();
  };

  assert.equal(dev.profile.listedInSearch, true);                 // on by default
  const listed = await sitemap();
  assert.equal((listed.match(/<url>/gu) || []).length, 1);         // the private profile isn't in it
  assert.ok(listed.includes(`/?profile=${dev.profile.publicId}</loc>`));
  assert.ok(!/30100000000|discord/iu.test(listed));               // never a UID or Discord id
  assert.equal((await (await call(env, `/api/profiles/${dev.profile.publicId}`)).json()).profile.listedInSearch, true);

  const off = await (await save(SESSIONS.dev, { displayName: "Dev", listedInSearch: false })).json();
  assert.equal(off.profile.listedInSearch, false);
  assert.equal(off.profile.isPublic, true);                       // still public, just not listed
  assert.equal(((await sitemap()).match(/<url>/gu) || []).length, 0);
  assert.equal((await (await call(env, `/api/profiles/${dev.profile.publicId}`)).json()).profile.listedInSearch, false);
  assert.equal((await save(SESSIONS.dev, { displayName: "Dev", listedInSearch: "no" })).status, 400);
});

test("Interlink Per Boss boards: slots, star caps, ladders, paging, one boss, and last updated", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await namedToken(env, SESSIONS.dev);
  const b = await namedToken(env, SESSIONS.user);
  const send = (token, body) => call(env, "/api/leaderboard/submissions", { token, method: "POST", body });
  // a developer's app uploads the new split's first week (the game data lists Scorchhowl, Glameep, Minespine)
  const bosses = [{ id: "80000098", name: "Alpha Scorchhowl" }, { id: "80000112", name: "Alpha Glameep" }, { id: "80000096", name: "Alpha Minespine" }];
  const start = 1793239200;
  assert.equal((await call(env, "/api/leaderboard/interlink/cycles", { token: a, method: "POST", body: { cycles: [{ id: "4000", season: 1, start, end: start + 4 * 86400, bosses }] } })).status, 200);
  const glameep = { id: "80000112", name: "Alpha Glameep", level: 60 };
  // dev: 34,000 and 40 stars cleared in 1:40; user: 36,000, 39 stars, timed out (more score, fewer stars)
  await send(a, run("g1", { cycle: "4000", boss: glameep, score: 34000, stars: 40, clearTimeS: 100, cleared: true, teamDps: 50000, playedAt: start + 100 }));
  await send(b, run("g2", { cycle: "4000", boss: glameep, score: 36000, stars: 39, clearTimeS: 180, cleared: false, teamDps: 61000, playedAt: start + 200 }));
  // 20 stars on the center boss used to count as a clear; under 20 / 40 / 20 it doesn't
  await send(a, run("g3", { cycle: "4000", boss: { id: "80000098", name: "Alpha Scorchhowl", level: 60 }, score: 15000, stars: 20, clearTimeS: 120, cleared: true, playedAt: start + 300 }));

  const week = await (await call(env, "/api/leaderboard/interlink?cycle=4000&ladder=score&limit=10")).json();
  assert.deepEqual(week.bosses.map((x) => [x.slot, x.name, x.starCap]), [["Left", "Alpha Scorchhowl", 20], ["Center", "Alpha Glameep", 40], ["Right", "Alpha Minespine", 20]]);
  assert.deepEqual(week.rules.starCaps, [20, 40, 20]);
  assert.equal(week.rules.slotsConfirmed, true);
  assert.equal(week.ladder, "score");
  // ranked by score: the timed-out 36,000 beats the cleared 34,000
  assert.deepEqual(week.bosses[1].entries.map((e) => [e.rank, e.score, e.clearTimeS]), [[1, 36000, null], [2, 34000, 100]]);
  assert.equal(week.bosses[1].total, 2);
  // the left boss at its full 20 stars is a clear
  assert.equal(week.bosses[0].entries[0].clearTimeS, 120);
  assert.ok(week.updatedAt > 0);
  // other ladders: fastest clear lists only clears; team DPS
  const fastest = await (await call(env, "/api/leaderboard/interlink?cycle=4000&ladder=clear")).json();
  assert.deepEqual(fastest.bosses[1].entries.map((e) => e.clearTimeS), [100]);
  const dps = await (await call(env, "/api/leaderboard/interlink?cycle=4000&ladder=teamDps")).json();
  assert.deepEqual(dps.bosses[1].entries.map((e) => e.teamDps), [61000, 50000]);
  assert.equal(dps.order, "desc");
  // "View all" with its column header clicked twice: the other way round, each row keeping its rank on the ladder
  const lowDps = await (await call(env, "/api/leaderboard/interlink?cycle=4000&boss=80000112&ladder=teamDps&order=asc")).json();
  assert.deepEqual(lowDps.bosses[0].entries.map((e) => [e.rank, e.teamDps]), [[2, 50000], [1, 61000]]);
  assert.equal(lowDps.order, "asc");
  assert.equal((await (await call(env, "/api/leaderboard/interlink?cycle=4000&ladder=clear&order=asc")).json()).order, "asc");   // its own direction
  assert.deepEqual((await (await call(env, "/api/leaderboard/interlink?cycle=4000&ladder=teamDps&order=sideways")).json()).bosses[1].entries
    .map((e) => e.teamDps), [61000, 50000]);
  // one boss, paged
  const page = await (await call(env, "/api/leaderboard/interlink?cycle=4000&boss=80000112&ladder=score&limit=1&offset=1")).json();
  assert.deepEqual(page.bosses.map((x) => x.id), ["80000112"]);
  assert.deepEqual(page.bosses[0].entries.map((e) => [e.rank, e.score]), [[2, 34000]]);
  assert.equal(page.bosses[0].total, 2);
  // an unknown ladder falls back to the old order (most stars first)
  const old = await (await call(env, "/api/leaderboard/interlink?cycle=4000&ladder=nope")).json();
  assert.deepEqual(old.bosses[1].entries.map((e) => e.score), [34000, 36000]);
});

test("Interlink Season Ladder: splits, combined score, total stars, best week", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await namedToken(env, SESSIONS.dev);
  const b = await namedToken(env, SESSIONS.user);
  const send = (token, body) => call(env, "/api/leaderboard/submissions", { token, method: "POST", body });
  const bosses = [{ id: "80000098", name: "Alpha Scorchhowl" }, { id: "80000112", name: "Alpha Glameep" }, { id: "80000096", name: "Alpha Minespine" }];
  const start = 1793239200;
  await call(env, "/api/leaderboard/interlink/cycles", { token: a, method: "POST", body: { cycles: [{ id: "4000", season: 1, start, end: start + 4 * 86400, bosses }] } });
  const sherro = { id: "80000109", name: "Omega Sherro", level: 60 };
  const glameep = { id: "80000112", name: "Alpha Glameep", level: 60 };
  // split 3 (weeks 3000-3005): dev 12,000; user 15,000. split 4 (week 4000): dev 30,000 + 10,000; user 20,000
  await send(a, run("s1", { cycle: "3005", boss: sherro, score: 12000, stars: 15 }));
  await send(b, run("s2", { cycle: "3005", boss: sherro, score: 15000, stars: 15 }));
  await send(a, run("s3", { cycle: "4000", boss: glameep, score: 30000, stars: 30 }));
  await send(a, run("s4", { cycle: "4000", boss: { id: "80000098", name: "Alpha Scorchhowl", level: 60 }, score: 10000, stars: 12 }));
  await send(b, run("s5", { cycle: "4000", boss: glameep, score: 20000, stars: 38 }));

  const split4 = await (await call(env, "/api/leaderboard/interlink?season=1&split=4")).json();
  assert.equal(split4.split, 4);
  assert.deepEqual(split4.standings.map((p) => [p.rank, p.player, p.total, p.stars, p.weeks, p.bestWeek]),
    [[1, "DevOne", 40000, 42, 1, 40000], [2, "UserOne", 20000, 38, 1, 20000]]);
  assert.deepEqual(split4.weeks.map((w) => w.id), ["4000"]);
  // by total stars instead
  const byStars = await (await call(env, "/api/leaderboard/interlink?season=1&split=4&sort=stars")).json();
  assert.deepEqual(byStars.standings.map((p) => [p.player, p.stars]), [["DevOne", 42], ["UserOne", 38]]);
  assert.equal(byStars.sort, "stars");
  // the earlier split, and the whole season adding both
  const split3 = await (await call(env, "/api/leaderboard/interlink?season=1&split=3")).json();
  assert.deepEqual(split3.standings.map((p) => [p.player, p.total]), [["UserOne", 15000], ["DevOne", 12000]]);
  const whole = await (await call(env, "/api/leaderboard/interlink?season=1")).json();
  assert.equal(whole.split, null);
  assert.deepEqual(whole.standings.map((p) => [p.player, p.total, p.weeks]), [["DevOne", 52000, 2], ["UserOne", 35000, 2]]);
  // the selector's list: Season 1 began with week 3000, so its splits are 3000-3005 (Split 1) and the 4000 reset
  // (Split 2), whatever season number the game data gave a week (it files week 1002 under season 1 and
  // 3000-3002 under season 3); earlier weeks are "Before Season 1"
  const season1 = whole.seasons.find((s) => s.season === 1);
  assert.deepEqual(season1.splits.map((s) => [s.id, s.label]), [[3, "Split 1"], [4, "Split 2"]]);
  assert.equal(season1.label, "Season 1");
  const before = whole.seasons.find((s) => s.season === 0);
  assert.equal(before.label, "Before Season 1");
  assert.ok(before.splits.some((s) => s.id === 1));                    // week 1002 now sits here
  const week = await (await call(env, "/api/leaderboard/interlink?cycle=3000")).json();
  assert.equal(week.cycle.season, 1);                                   // uploaded as season 3, filed under Season 1
  assert.equal(season1.splits.at(-1).start, start);
  assert.ok(whole.updatedAt > 0);
});

// ---------------------------------------------------------------- Battle History
const historyOf = async (env, path, session) => (await call(env, path, { session })).json();
const sendRun = (env, token, body, screens = []) => {
  if (!screens.length) return call(env, "/api/leaderboard/submissions", { token, method: "POST", body });
  const form = new FormData();
  form.set("submission", JSON.stringify(body));
  for (const part of screens) form.set(part, new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), `${part}.jpg`);
  return call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
};

test("Battle History: every record newest first, a page at a time, filtered by mode, boss and week", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  for (let i = 0; i < 23; i += 1) {
    const boss = i % 2 ? { id: "80000109", name: "Omega Sherro", level: 60 } : { id: "80000107", name: "Omega Infergon", level: 60 };
    assert.equal((await sendRun(env, token, run(`h${i}`, { boss, score: 10000 + i, stars: 10, playedAt: 1792700000 + i * 60 }))).status, 201);
  }
  await sendRun(env, token, { kind: "sim_run", clientRunId: "sim1", trial: "Training of Water", difficulty: "Hard", cleared: true, clearTimeS: 400, playedAt: 1792800000 });
  const first = await historyOf(env, "/api/profile/history", SESSIONS.dev);
  assert.equal(first.runs.length, 20);
  assert.equal(first.runs[0].kind, "sim_run");                                  // newest first
  assert.deepEqual(first.runs.slice(1, 3).map((r) => r.score), [10022, 10021]);
  assert.deepEqual(first.filters.modes.map((m) => [m.value, m.count]), [["interlink", 23], ["sim", 1]]);
  assert.deepEqual(first.filters.bosses.map((b) => b.name), ["Omega Infergon", "Omega Sherro"]);
  assert.deepEqual(first.filters.weeks.map((w) => w.value), ["3005"]);
  const second = await historyOf(env, `/api/profile/history?before=${encodeURIComponent(first.next)}`, SESSIONS.dev);
  assert.deepEqual(second.runs.map((r) => r.score), [10003, 10002, 10001, 10000]);
  assert.equal(second.next, null);
  assert.equal(second.filters, undefined);
  const sherro = await historyOf(env, "/api/profile/history?mode=interlink&boss=80000109&cycle=3005", SESSIONS.dev);
  assert.equal(sherro.runs.length, 11);
  assert.ok(sherro.runs.every((r) => r.boss.id === "80000109"));
  assert.equal((await call(env, "/api/profile/history")).status, 401);
});

test("Battle History follows the profile, credits teammates' copies by proven UID, and never shows a UID", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const devToken = await namedToken(env, SESSIONS.dev);       // DevOne, 301000000001
  const userToken = await namedToken(env, SESSIONS.user);     // UserOne, 301000000003
  // UserOne's app captured a run with DevOne in the party (UID shown), and one with a name only
  const party = [{ name: "UserOne", self: true, avgDps: 9000 }, { name: "DevOne", uid: "301000000001", ai: false, avgDps: 12000 },
    { name: "Mario", ai: true }];
  await sendRun(env, userToken, run("with-dev", { players: party, playedAt: 1792700100, extra: { instanceId: "inst-1" } }));
  await sendRun(env, userToken, run("name-only", { players: [{ name: "UserOne", self: true }, { name: "DevOne", ai: false }], playedAt: 1792700200 }));
  await sendRun(env, devToken, run("dev-own", { playedAt: 1792700000 }));
  const devHistory = async () => (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs;
  // not proven yet: only DevOne's own run
  assert.deepEqual((await devHistory()).map((r) => r.credited), [false]);
  sqlite.prepare("UPDATE game_characters SET verified_at = 1 WHERE game_uid = ?").run("301000000001");
  const proven = await devHistory();
  assert.deepEqual(proven.map((r) => [r.score, r.credited]), [[20000, true], [20000, false]]);
  assert.deepEqual(proven[0].players.map((p) => p.name), ["UserOne", "DevOne", "Mario"]);
  assert.equal(JSON.stringify(proven).includes("301000000"), false);           // no UID anywhere
  // DevOne's app sent the same game instance too: it shows once, as their own
  await sendRun(env, devToken, run("dev-same", { players: party.map((p) => ({ ...p, self: p.name === "DevOne" })), playedAt: 1792700100, extra: { instanceId: "inst-1" } }));
  assert.deepEqual((await devHistory()).map((r) => r.credited), [false, false]);
  // private profile: no public history; public: everyone sees it, hidden runs only in the owner's view
  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pubdev01', preferences_json = '{\"runsPublic\":true}' WHERE discord_id = ?").run(IDS.dev);
  sqlite.prepare("UPDATE leaderboard_submissions SET status = 'hidden' WHERE client_run_id = 'dev-own'").run();
  assert.equal((await historyOf(env, "/api/profiles/pubdev01/history")).runs.length, 1);
  assert.deepEqual((await devHistory()).map((r) => Boolean(r.hidden)), [false, true]);
  sqlite.prepare("UPDATE profiles SET is_public = 0 WHERE discord_id = ?").run(IDS.dev);
  assert.equal((await call(env, "/api/profiles/pubdev01/history")).status, 404);
});

test("My runs: numbered pages of 20, 30 or 50 with the total, and search as you type, on the owner's own view only", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  const userToken = await namedToken(env, SESSIONS.user);
  for (let i = 0; i < 55; i += 1) {
    const boss = i % 5 ? { id: "80000107", name: "Omega Infergon", level: 60 } : { id: "80000109", name: "Omega Sherro", level: 60 };
    const players = [{ name: "DevOne", self: true, avgDps: 9000 }, { name: i === 7 ? "Kirabelle" : "Pathmate", uid: "301000000003", ai: false, avgDps: 4000 }];
    assert.equal((await sendRun(env, token, run(`m${i}`, { boss, players, score: 10000 + i, playedAt: 1792700000 + i * 3600 }))).status, 201);
  }
  await sendRun(env, token, { kind: "sim_run", clientRunId: "sim1", trial: "Training of Water", difficulty: "Hard", cleared: true, clearTimeS: 400,
    playedAt: 1792900000, extra: { lineup: [{ slot: 1, name: "DevOne", self: true }, { slot: 2, name: "Lineupfriend" }] } });
  // another player's run: never in DevOne's list
  await sendRun(env, userToken, run("not-mine", { players: [{ name: "UserOne", self: true }], playedAt: 1792950000 }));
  const mine = (query) => historyOf(env, `/api/profile/history?${query}`, SESSIONS.dev);

  const first = await mine("page=1");
  assert.deepEqual([first.runs.length, first.total, first.pages, first.page, first.pageSize], [20, 56, 3, 1, 20]);
  assert.equal(first.runs[0].kind, "sim_run");
  assert.ok(first.filters);
  const third = await mine("page=3&limit=20");
  assert.deepEqual(third.runs.map((r) => r.score), [10015, ...Array.from({ length: 15 }, (_, i) => 10014 - i)]);
  assert.equal(third.filters, undefined);
  assert.equal((await mine("page=1&limit=30")).runs.length, 30);
  const fifty = await mine("page=2&limit=50");
  assert.deepEqual([fifty.runs.length, fifty.pages], [6, 2]);
  assert.equal((await mine("page=1&limit=1000")).pageSize, 20);          // only 20, 30 or 50
  assert.equal((await mine("page=9")).runs.length, 0);
  assert.ok((await mine("page=1")).runs.every((r) => r.players.every((p) => p.name !== "UserOne")));

  // search: boss, teammate (Battle Data or the Party screen), mode, date; every word has to match
  assert.equal((await mine("page=1&q=sherro")).total, 11);
  assert.equal((await mine("page=1&q=SHERRO%20omega")).total, 11);
  assert.deepEqual((await mine("page=1&q=kirab")).runs.map((r) => r.score), [10007]);
  assert.deepEqual((await mine("page=1&q=lineupfriend")).runs.map((r) => r.kind), ["sim_run"]);
  assert.equal((await mine("page=1&q=holo-battle%20sim")).total, 1);
  assert.equal((await mine("page=1&q=egg")).total, 0);
  const day = new Date(1792700000 * 1000).toISOString().slice(0, 10);
  const sameDay = (await mine(`page=1&q=${day}`)).runs;
  assert.ok(sameDay.length > 0 && sameDay.every((r) => new Date(r.playedAt * 1000).toISOString().slice(0, 10) === day));
  // the viewer's time zone moves a run across midnight
  const utcCount = (await mine(`page=1&q=${day}`)).total;
  assert.notEqual((await mine(`page=1&q=${day}&tz=600`)).total, utcCount);
  const month = new Date(1792700000 * 1000).toLocaleString("en", { month: "long", timeZone: "UTC" });
  assert.equal((await mine(`page=1&q=${month.slice(0, 3).toLowerCase()}`)).total > 0, true);
  // never a UID, and LIKE's wildcards are plain characters
  assert.equal((await mine("page=1&q=301000000003")).total, 0);
  assert.equal((await mine("page=1&q=%25")).total, 0);
  assert.equal((await mine("page=1&q=_")).total, 0);
  // filters still apply alongside
  assert.equal((await mine("page=1&mode=sim&q=sherro")).total, 0);

  // the column headers: Played newest first unless asked, then Mode, Fight, Result (score, empty last) and Party
  assert.deepEqual([first.sort, first.order], ["played", "desc"]);
  assert.ok(first.runs.every((r, i) => !i || first.runs[i - 1].playedAt >= r.playedAt));
  const oldest = await mine("page=1&sort=played&order=asc");
  assert.deepEqual([oldest.sort, oldest.order, oldest.runs[0].score], ["played", "asc", 10000]);
  assert.ok(oldest.runs.every((r, i) => !i || oldest.runs[i - 1].playedAt <= r.playedAt));
  assert.deepEqual((await mine("page=1&sort=result")).runs.slice(0, 3).map((r) => r.score), [10054, 10053, 10052]);
  assert.equal((await mine("page=3&sort=result")).runs.at(-1).kind, "sim_run");                     // no score: last
  assert.deepEqual((await mine("page=1&sort=result&order=asc")).runs.slice(0, 2).map((r) => r.score), [10000, 10001]);
  assert.equal((await mine("page=3&sort=result&order=asc")).runs.at(-1).kind, "sim_run");           // last either way
  assert.equal((await mine("page=1&sort=mode")).runs[0].mode, "interlink");
  assert.equal((await mine("page=1&sort=mode&order=desc")).runs[0].mode, "sim");
  assert.equal((await mine("page=1&sort=fight")).runs[0].boss.name, "Omega Infergon");
  const byFight = await mine("page=1&sort=fight");
  assert.ok(byFight.runs.filter((r) => r.boss?.name === "Omega Infergon").every((r, i, list) => !i || list[i - 1].playedAt >= r.playedAt));   // ties newest first
  assert.equal((await mine("page=1&sort=party")).total, 56);
  assert.deepEqual([(await mine("page=1&sort=nope;DROP")).sort, (await mine("page=1&order=sideways")).order], ["played", "desc"]);
  // the profile card (no page number) is always newest first
  assert.equal((await mine("limit=5&sort=result&order=asc")).runs[0].kind, "sim_run");

  // made public (My runs' switch), visitors get the same list: pages, search, the total; another player's own list
  // is theirs alone; logged out: nothing
  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pubdev01', preferences_json = '{\"runsPublic\":true}' WHERE discord_id = ?").run(IDS.dev);
  const shown = await historyOf(env, "/api/profiles/pubdev01/history?page=1&q=sherro", SESSIONS.user);
  assert.equal(shown.total, (await mine("page=1&q=sherro")).total);
  assert.ok(shown.runs.every((r) => r.boss?.name === "Omega Sherro"));
  assert.equal((await historyOf(env, "/api/profiles/pubdev01/history?page=1")).total, first.total);   // logged out too, once public
  const theirs = await historyOf(env, "/api/profile/history?page=1", SESSIONS.user);
  assert.deepEqual(theirs.runs.map((r) => r.score), [20000]);            // UserOne sees only their own
  assert.equal(theirs.total, 1);
  assert.equal((await call(env, "/api/profile/history?page=1&q=sherro")).status, 401);
});

test("My runs: menu bests have their own filter, and a run a menu best matches opens with the menu picture", async () => {
  const { env } = await setup({ EVIDENCE: evidenceStore(), LEADERBOARD_PUBLIC: "true" });
  const token = await desktopToken(env, SESSIONS.dev);
  const jpeg = (mark) => { const data = new Uint8Array(2048); data.set([0xff, 0xd8, 0xff, mark]); return new Blob([data], { type: "image/jpeg" }); };
  const sherro = { id: "80000109", name: "Omega Sherro", level: 60 };
  const send = async (submission, parts) => {
    const form = new FormData();
    form.set("submission", JSON.stringify(submission));
    for (const [name, mark] of parts) form.set(name, jpeg(mark), `${name}.jpg`);
    const sent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
    assert.ok([200, 201].includes(sent.status), String(sent.status));
    return (await sent.json()).submissionId;
  };
  const menuId = await send({ kind: "interlink_best", clientRunId: "best-3005-80000109", cycle: "3005", boss: sherro, score: 25000, stars: 20 }, [["evidence", 4]]);
  const tieId = await send({ kind: "interlink_run", clientRunId: "il-tie", cycle: "3005", boss: sherro, score: 25000, stars: 20, clearTimeS: 150,
    cleared: true, partySize: 1, players: [{ name: "MinMax", ai: false, self: true, avgDps: 9000 }] }, [["evidence", 2], ["battle", 3]]);
  const lowId = await send({ kind: "interlink_run", clientRunId: "il-low", cycle: "3005", boss: sherro, score: 20000, stars: 18, clearTimeS: 170,
    cleared: true, partySize: 1, players: [{ name: "MinMax", ai: false, self: true, avgDps: 8000 }] }, [["evidence", 5]]);
  const page = await historyOf(env, "/api/profile/history?page=1", SESSIONS.dev);
  const byId = new Map(page.runs.map((r) => [r.submissionId, r]));
  assert.equal(byId.get(tieId).menuProofId, menuId);
  assert.equal(byId.get(lowId).menuProofId, undefined);
  assert.equal(byId.get(menuId).kind, "interlink_best");
  assert.ok(page.filters.modes.some((m) => m.value === "menu" && m.count === 1));
  assert.deepEqual((await historyOf(env, "/api/profile/history?page=1&mode=menu", SESSIONS.dev)).runs.map((r) => r.submissionId), [menuId]);
  assert.deepEqual((await historyOf(env, "/api/profile/history?page=1&q=menu", SESSIONS.dev)).runs.map((r) => r.submissionId), [menuId]);
});

test("the profile's Interlink card: the current season part's weeks and bosses, its total alone, earlier parts with a link's filter", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const dev = await namedToken(env, SESSIONS.dev);
  const user = await namedToken(env, SESSIONS.user);
  // Season 1.1 begins: week 4000 started two days ago
  const bosses = [{ id: "80000098", name: "Alpha Scorchhowl" }, { id: "80000112", name: "Alpha Glameep" }, { id: "80000096", name: "Alpha Minespine" }];
  const start = Math.floor(Date.now() / 1000) - 2 * 86400;
  assert.equal((await call(env, "/api/leaderboard/interlink/cycles", { token: dev, method: "POST",
    body: { cycles: [{ id: "4000", season: 1, start, end: start + 6 * 86400, bosses }] } })).status, 200);
  const glameep = { id: "80000112", name: "Alpha Glameep", level: 60 };
  const scorch = { id: "80000098", name: "Alpha Scorchhowl", level: 60 };
  const sherro = { id: "80000109", name: "Omega Sherro", level: 60 };
  // Season 1.0 (week 3005): two runs of Infergon (the better counts) and one of Sherro
  await sendRun(env, dev, run("o1", { score: 20000, stars: 20 }));
  await sendRun(env, dev, run("o2", { score: 18000, stars: 18, playedAt: 1792700100 }));
  await sendRun(env, dev, run("o3", { boss: sherro, score: 15000, stars: 15, playedAt: 1792700200 }));
  // Season 1.1 (week 4000): Glameep and Scorchhowl; UserOne beats DevOne on Glameep
  await sendRun(env, dev, run("n1", { cycle: "4000", boss: glameep, score: 34000, stars: 40, clearTimeS: 100, cleared: true, playedAt: start + 100 }));
  await sendRun(env, dev, run("n2", { cycle: "4000", boss: scorch, score: 21000, stars: 20, clearTimeS: 120, cleared: true, playedAt: start + 200 }));
  await sendRun(env, user, run("u1", { cycle: "4000", boss: glameep, score: 90000, stars: 40, clearTimeS: 90, cleared: true, playedAt: start + 300 }));
  // quit under the clock without every star: invalid, in the owner's list only
  await sendRun(env, dev, run("n3", { cycle: "4000", boss: scorch, score: 9000, stars: 12, clearTimeS: 60, cleared: true, playedAt: start + 400 }));

  const { leaderboards } = await (await call(env, "/api/profile/overview", { session: SESSIONS.dev })).json();
  const parts = leaderboards.interlinkParts;
  assert.equal(parts.current.label, "Season 1.1");
  assert.deepEqual([parts.current.total, parts.current.stars, parts.current.weeksPlayed], [55000, 60, 1]);     // 1.0 doesn't count
  assert.deepEqual([parts.current.rank, parts.current.players], [2, 2]);
  assert.deepEqual(parts.current.weeks.map((w) => [w.cycle, w.total, w.current]), [["4000", 55000, true]]);
  assert.deepEqual(parts.current.weeks[0].bosses.map((b) => [b.name, b.score, b.stars]), [["Alpha Scorchhowl", 21000, 20], ["Alpha Glameep", 34000, 40]]);
  assert.ok(parts.current.weeks[0].bosses.every((b) => !b.proofId));                                     // no pictures sent
  assert.deepEqual(parts.previous.map((p) => [p.label, p.season, p.split, p.total, p.weeksPlayed]), [["Season 1.0", 1, 3, 35000, 1]]);
  assert.equal(JSON.stringify(parts).includes("30100000000"), false);                                    // never a UID

  // the earlier part's link: My runs filtered to its best runs
  const best = await historyOf(env, "/api/profile/history?page=1&split=3&best=1", SESSIONS.dev);
  assert.deepEqual(best.runs.map((r) => r.score).sort(), [15000, 20000]);
  assert.equal((await historyOf(env, "/api/profile/history?page=1&split=3", SESSIONS.dev)).total, 3);
  assert.equal((await historyOf(env, "/api/profile/history?page=1&split=4", SESSIONS.dev)).total, 3);

  // visitors (My runs made public) never see a hidden or an invalid run; the owner sees both
  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pubdev01', preferences_json = '{\"runsPublic\":true}' WHERE discord_id = ?").run(IDS.dev);
  sqlite.prepare("UPDATE leaderboard_submissions SET status = 'hidden' WHERE client_run_id = 'o3'").run();
  const owner = await historyOf(env, "/api/profile/history?page=1", SESSIONS.dev);
  assert.equal(owner.total, 6);
  assert.ok(owner.runs.some((r) => r.outcome === "invalid") && owner.runs.some((r) => r.hidden));
  const visitor = await historyOf(env, "/api/profiles/pubdev01/history?page=1");
  assert.equal(visitor.total, 4);
  assert.ok(visitor.runs.every((r) => r.outcome !== "invalid" && !r.hidden));
  // the public profile's card shows the same parts
  const shown = await (await call(env, "/api/profiles/pubdev01")).json();
  assert.equal(shown.leaderboards.interlinkParts.current.total, 55000);
});

test("at most DAILY_RUN_LIMIT new records an account a day; re-sends still go through", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true", DAILY_RUN_LIMIT: "3" });
  const token = await namedToken(env, SESSIONS.dev);
  for (const id of ["d1", "d2", "d3"]) assert.equal((await sendRun(env, token, run(id))).status, 201);
  const over = await sendRun(env, token, run("d4"));
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /00:00 UTC/u);
  assert.notEqual((await sendRun(env, token, run("d2", { score: 25000 }))).status, 429);   // the same record again
});

test("pictures: a better Interlink run replaces the older one's proof at once; bests and runs under review keep theirs", async () => {
  const EVIDENCE = evidenceStore();
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true", EVIDENCE });
  const devToken = await namedToken(env, SESSIONS.dev);
  const userToken = await namedToken(env, SESSIONS.user);
  sqlite.prepare("UPDATE game_characters SET verified_at = 1").run();
  const screens = ["evidence", "battle", "evidence_full", "battle_full"];
  const id = (client) => sqlite.prepare("SELECT submission_id AS id FROM leaderboard_submissions WHERE client_run_id = ?").get(client).id;
  const pictures = (client) => [...EVIDENCE.objects.keys()].filter((key) => key.includes(id(client)))
    .map((key) => (/-(battle-)?full\./u.test(key) ? "full" : "crop")).sort();
  const state = (client, value) => sqlite.prepare("UPDATE leaderboard_submissions SET verify_state = ? WHERE client_run_id = ?").run(value, client);
  let n = 0;
  const prune = async () => { for (let i = 0; i < 3; i += 1) await sendRun(env, devToken, run(`trigger-${n += 1}`, { cycle: "3004", boss: { id: "80000099", name: "Alpha Irisal", level: 1 } })); };

  // a run under review keeps its pictures, better runs or not (marked before the next run comes in)
  await sendRun(env, devToken, run("review", { score: 10000, stars: 10 }), screens);
  state("review", "mismatch");
  await sendRun(env, devToken, run("worse", { score: 20000, stars: 20 }), screens);
  // a better run that is itself under review doesn't replace anything yet
  await sendRun(env, devToken, run("best", { score: 30000, stars: 25 }), screens);
  state("best", "pending");
  await prune();
  assert.equal(pictures("worse").length, 4);
  // once it's through its check (and 5 minutes in), the older run's pictures go on the next submission (no 14 / 90
  // day wait); its numbers stay
  state("best", "match");
  sqlite.prepare("UPDATE leaderboard_submissions SET created_at = created_at - 600 WHERE client_run_id IN ('best', 'worse', 'review')").run();
  await prune();
  assert.deepEqual(pictures("worse"), []);
  const worse = sqlite.prepare("SELECT evidence_key, battle_evidence_key, proof_pruned_at, score FROM leaderboard_submissions WHERE client_run_id = 'worse'").get();
  assert.deepEqual([worse.evidence_key, worse.battle_evidence_key, worse.score], [null, null, 20000]);
  assert.ok(worse.proof_pruned_at > 0);
  const listed = (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs.find((r) => r.submissionId === id("worse"));
  assert.deepEqual([listed.hasEvidence, listed.hasFullScreens, Boolean(listed.proofPrunedAt)], [false, [], true]);

  // not UserOne's best, but better than anything DevOne (in the party, UID proven) sent: DevOne's best, so it stays
  await sendRun(env, userToken, run("user-best", { score: 40000, stars: 30 }), screens);
  await sendRun(env, userToken, run("teammates-best", { score: 35000, stars: 28,
    players: [{ name: "UserOne", self: true }, { name: "DevOne", uid: "301000000001", ai: false }] }), screens);
  state("user-best", "match");
  sqlite.prepare("UPDATE leaderboard_submissions SET created_at = created_at - 600 WHERE client_run_id IN ('user-best', 'teammates-best')").run();
  await prune();
  for (const kept of ["best", "user-best", "teammates-best", "review"]) assert.equal(pictures(kept).length, 4, kept);
});

test("the Party screen's details: every player's lead Aniimo, CP and team comp, the party's buffs", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  const lineup = [
    { slot: 1, name: "DevOne", ai: false, self: true, aniimo: "Emberpup", aniimoLevel: 60, cp: 12345,
      team: [{ aniimo: "Emberpup", aniimoLevel: 60, cp: 12345 }, { name: "Celestis", level: 58 }, "Irisalis"] },
    { slot: 2, name: "Mario", ai: true, aniimo: "Chirpi", aniimoLevel: 50 },
    { slot: 3, name: "Friend", ai: false, aniimo: "Celestis", aniimoLevel: 58, cp: 9999 },
  ];
  const buffs = [{ name: "Fire Resonance", level: 2 }, { name: "Swift Start" }];
  await sendRun(env, token, run("lineup", { buffs, extra: { lineup, newBests: [], title: "Pathfinder" } }));
  const [listed] = (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs;
  assert.deepEqual(listed.lineup, [
    { slot: 1, name: "DevOne", ai: false, self: true, aniimo: "Emberpup", aniimoLevel: 60, cp: 12345,
      team: [{ aniimo: "Emberpup", aniimoLevel: 60, cp: 12345 }, { aniimo: "Celestis", aniimoLevel: 58 }, { aniimo: "Irisalis" }] },
    { slot: 2, name: "Mario", ai: true, aniimo: "Chirpi", aniimoLevel: 50 },
    { slot: 3, name: "Friend", ai: false, aniimo: "Celestis", aniimoLevel: 58, cp: 9999 },   // teammates' details are public too
  ]);
  assert.deepEqual(listed.buffs, [{ name: "Fire Resonance", level: 2 }, { name: "Swift Start" }]);
  assert.equal(listed.title, undefined);
  assert.deepEqual(listed.newBests, []);                                   // no "New best" for a run that beat nothing
});

test("the Party screen's last capture is the lineup's proof: stored, replaced by a newer one, kept like the crops", async () => {
  const EVIDENCE = evidenceStore();
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true", EVIDENCE, ADMIN_DISCORD_IDS: IDS.dev });
  const token = await namedToken(env, SESSIONS.dev);
  const send = (body, parts) => {
    const form = new FormData();
    form.set("submission", JSON.stringify(body));
    for (const [part, byte] of parts) form.set(part, new Blob([new Uint8Array([0xff, 0xd8, 0xff, byte])], { type: "image/jpeg" }), `${part}.jpg`);
    return call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
  };
  assert.equal((await send(run("p1"), [["evidence", 1], ["party", 7]])).status, 201);
  const id = sqlite.prepare("SELECT submission_id AS id FROM leaderboard_submissions WHERE client_run_id = 'p1'").get().id;
  const shot = async () => new Uint8Array(await (await call(env, `/api/leaderboard/submissions/${id}/evidence?shot=party`)).arrayBuffer())[3];
  assert.equal(await shot(), 7);
  await send(run("p1", { score: 21000 }), [["party", 9]]);                  // the leader changed something: a newer capture
  assert.equal(await shot(), 9);
  await send(run("p1", { score: 21000, extra: { proofParty: "evidence/someone-else.jpg" } }), []);   // the app can't name one
  assert.equal(await shot(), 9);
  const [listed] = (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs;
  assert.equal(listed.hasPartyScreen, true);
  const entries = JSON.stringify(await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json());
  assert.equal(entries.includes("-party."), false);                       // never the storage key
  // deleting the run takes it too
  await call(env, `/api/leaderboard/submissions/${id}`, { token, method: "DELETE" });
  assert.equal([...EVIDENCE.objects.keys()].some((key) => key.includes(id)), false);
});

test("the sender in slot 2: self marks their section; slot 1's details stay slot 1's", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  const lineup = [
    { slot: 1, name: "Leader", ai: false, aniimo: "Glameep", aniimoLevel: 60, cp: 20000, team: ["Glameep", "Sherro"] },
    { slot: 2, name: "DevOne", ai: false, self: true, aniimo: "Emberpup", aniimoLevel: 55, cp: 11000, team: ["Emberpup", "Chirpi"] },
  ];
  await sendRun(env, token, run("p2", { extra: { lineup } }));
  const [listed] = (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs;
  assert.deepEqual(listed.lineup, [
    { slot: 1, name: "Leader", ai: false, aniimo: "Glameep", aniimoLevel: 60, cp: 20000, team: [{ aniimo: "Glameep" }, { aniimo: "Sherro" }] },
    { slot: 2, name: "DevOne", ai: false, self: true, aniimo: "Emberpup", aniimoLevel: 55, cp: 11000, team: [{ aniimo: "Emberpup" }, { aniimo: "Chirpi" }] },
  ]);
});

test("a shared run's lineup: each player's details from whichever copy read them, their own copy first", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const devToken = await namedToken(env, SESSIONS.dev);       // DevOne 301000000001
  const userToken = await namedToken(env, SESSIONS.user);     // UserOne 301000000003
  const at = Math.floor(Date.now() / 1000) - 60;
  const party = (self) => [{ name: "UserOne", ai: false, self: self === "UserOne" }, { name: "DevOne", ai: false, self: self === "DevOne" }];
  // UserOne's app read only UserOne; DevOne's read both, but misread UserOne's CP
  await sendRun(env, userToken, run("u-copy", { gameUid: "301000000003", playedAt: at, players: party("UserOne"), extra: { lineup: [
    { slot: 1, name: "UserOne", ai: false, self: true, aniimo: "Glameep", aniimoLevel: 60, cp: 20000 },
    { slot: 2, name: "DevOne", ai: false },
  ] } }));
  await sendRun(env, devToken, run("d-copy", { gameUid: "301000000001", playedAt: at + 20, players: party("DevOne"), extra: { lineup: [
    { slot: 1, name: "UserOne", ai: false, aniimo: "Glameep", aniimoLevel: 60, cp: 2000 },
    { slot: 2, name: "DevOne", ai: false, self: true, aniimo: "Emberpup", aniimoLevel: 55, cp: 11000, team: [{ aniimo: "Emberpup" }, { aniimo: "Chirpi" }] },
  ] } }));
  const expected = [
    { slot: 1, name: "UserOne", ai: false, aniimo: "Glameep", aniimoLevel: 60, cp: 20000 },
    { slot: 2, name: "DevOne", ai: false, aniimo: "Emberpup", aniimoLevel: 55, cp: 11000, team: [{ aniimo: "Emberpup" }, { aniimo: "Chirpi" }] },
  ];
  const lineupOf = async (session) => (await historyOf(env, "/api/profile/history", session)).runs[0].lineup.map(({ self: _self, ...entry }) => entry);
  assert.deepEqual(await lineupOf(SESSIONS.user), expected);              // DevOne's details filled in from DevOne's copy
  assert.deepEqual(await lineupOf(SESSIONS.dev), expected);               // UserOne's CP from UserOne's own copy, not the misread
});

test("copies of one shared run: a player's own copy is their row's proof and lineup, else the newest build's", async () => {
  const { env, sqlite } = await setup({ EVIDENCE: evidenceStore(), LEADERBOARD_PUBLIC: "true" });
  const devToken = await namedToken(env, SESSIONS.dev);       // DevOne 301000000001
  const userToken = await namedToken(env, SESSIONS.user);     // UserOne 301000000003
  const jpeg = (mark) => { const data = new Uint8Array(2048); data.set([0xff, 0xd8, 0xff, mark]); return new Blob([data], { type: "image/jpeg" }); };
  const at = Math.floor(Date.now() / 1000) - 600;
  const send = async (token, id, body, mark) => {
    const form = new FormData();
    form.set("submission", JSON.stringify(run(id, { cycle: "3005", score: 30000, stars: 30, clearTimeS: 200, playedAt: at, ...body })));
    form.set("evidence", jpeg(mark), "result.jpg");
    const sent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
    assert.ok([200, 201].includes(sent.status), String(sent.status));
    return (await sent.json()).submissionId;
  };
  const arrived = (id, seconds) => sqlite.prepare("UPDATE leaderboard_submissions SET created_at = ? WHERE submission_id = ?").run(seconds, id);
  const players = (self) => [{ name: "UserOne", ai: false, self: self === "UserOne", avgDps: 5000 }, { name: "DevOne", ai: false, self: self === "DevOne", avgDps: 7000 }];
  // UserOne's app sent first and misread DevOne's slot: another name, taken for AI, the wrong lead
  const userCopy = await send(userToken, "u-copy", { gameUid: "301000000003", clientVersion: "aLogs-0.1.37+rc.13", players: players("UserOne"), extra: { lineup: [
    { slot: 1, name: "UserOne", ai: false, self: true, aniimo: "Glameep", aniimoLevel: 60, cp: 20000 },
    { slot: 2, name: "Dawnlit", ai: true, aniimo: "Chirpi", cp: 100 },
  ] } }, 2);
  const devCopy = await send(devToken, "d-copy", { gameUid: "301000000001", clientVersion: "aLogs-0.1.37+rc.12", players: players("DevOne"), extra: { lineup: [
    { slot: 1, name: "UserOne", ai: false },
    { slot: 2, name: "DevOne", ai: false, self: true, aniimo: "Emberpup", aniimoLevel: 55, cp: 11000 },
  ] } }, 3);
  arrived(userCopy, at + 10);
  arrived(devCopy, at + 40);
  const shared = (id) => JSON.parse(sqlite.prepare("SELECT extra_json FROM leaderboard_submissions WHERE submission_id = ?").get(id).extra_json).sharedRun;
  assert.ok(shared(userCopy));
  assert.equal(shared(userCopy), shared(devCopy));
  const rowOf = async (name) => (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json()).bosses
    .flatMap((boss) => boss.entries).find((entry) => entry.player === name);
  // DevOne's row: their own copy (sent later, by an older build) is the proof of every figure on it
  const devRow = await rowOf("DevOne");
  assert.equal(devRow.proofId, devCopy);
  assert.equal(devRow.proofIds.dps, devCopy);
  assert.equal((await rowOf("UserOne")).proofId, userCopy);
  const entries = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run")).json()).entries;
  assert.equal(entries.find((entry) => entry.player === "DevOne").submissionId, devCopy);
  // the proof viewer's lineup: DevOne's slot from DevOne's own copy, on either copy's pictures
  const listOf = async (id) => (await (await call(env, `/api/leaderboard/submissions/${id}/evidence?shot=list`)).json()).lineup;
  const lineupOf = async (id) => (await listOf(id)).map(({ self: _self, avgDps: _dps, ...entry }) => entry);
  const expected = [
    { slot: 1, name: "UserOne", ai: false, aniimo: "Glameep", aniimoLevel: 60, cp: 20000 },
    { slot: 2, name: "DevOne", ai: false, aniimo: "Emberpup", aniimoLevel: 55, cp: 11000 },
  ];
  assert.deepEqual(await lineupOf(devCopy), expected);
  assert.deepEqual(await lineupOf(userCopy), expected);                    // the misread name, AI mark and lead are gone
  // each copy's own Battle Data card: the sender's by its mark, the teammate's by the name read the same
  assert.deepEqual((await listOf(devCopy)).map((entry) => entry.avgDps), [5000, 7000]);
  assert.deepEqual((await listOf(userCopy)).map((entry) => entry.avgDps), [5000, 7000]);
  assert.deepEqual(entries.find((entry) => entry.player === "UserOne").extra.lineup.map(({ self: _self, ...entry }) => entry), expected);

  // a third player who sent no copy: the newest build's copy, though the other arrived first
  const dev2Token = await namedToken(env, SESSIONS.dev2);    // DevTwo 301000000002
  sqlite.prepare("UPDATE game_characters SET verified_at = ? WHERE game_uid = '301000000002'").run(at);
  const trio = (self) => [...players(self), { name: "DevTwo", ai: false, uid: "301000000002", avgDps: 6000 }];
  const lineup3 = (self, devTwoLead) => [
    { slot: 1, name: "UserOne", ai: false, ...(self === "UserOne" ? { self: true } : {}) },
    { slot: 2, name: "DevOne", ai: false, ...(self === "DevOne" ? { self: true } : {}) },
    { slot: 3, name: "DevTwo", ai: false, aniimo: devTwoLead },
  ];
  const boss = { id: "80000109", name: "Omega Sherro", level: 60 };
  const older = await send(userToken, "u-trio", { boss, gameUid: "301000000003", clientVersion: "aLogs-0.1.37+rc.12", players: trio("UserOne"),
    extra: { lineup: lineup3("UserOne", "Tromber") } }, 4);
  const newer = await send(devToken, "d-trio", { boss, gameUid: "301000000001", clientVersion: "aLogs-0.1.37+rc.13", players: trio("DevOne"),
    extra: { lineup: lineup3("DevOne", "Somniwing") } }, 5);
  arrived(older, at + 10);
  arrived(newer, at + 40);
  assert.equal(shared(older), shared(newer));
  const devTwoRow = (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json()).bosses
    .find((x) => x.id === boss.id).entries.find((entry) => entry.player === "DevTwo");
  assert.equal(devTwoRow.proofId, newer);
  assert.equal(devTwoRow.proofIds.dps, newer);
  const [credited] = (await historyOf(env, "/api/profile/history", SESSIONS.dev2)).runs;
  assert.equal(credited.submissionId, newer);
  assert.equal(credited.lineup.find((entry) => entry.slot === 3).aniimo, "Somniwing");
  assert.ok(dev2Token);
});

test("client versions rank by release, then RC number", () => {
  assert.ok(clientVersionRank("aLogs-0.1.37+rc.13") > clientVersionRank("aLogs-0.1.37+rc.12"));
  assert.ok(clientVersionRank("aLogs-0.1.37") > clientVersionRank("aLogs-0.1.37+rc.13"));
  assert.ok(clientVersionRank("aLogs-0.1.38+rc.1") > clientVersionRank("aLogs-0.1.37"));
  assert.ok(clientVersionRank("aLogs-0.2.0+rc.1") > clientVersionRank("aLogs-0.1.99"));
  assert.equal(clientVersionRank(null), -1);
});

test("one party run sent by two players: Battle Data cards say who is who when a name was misread or on the wrong slot", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const devToken = await namedToken(env, SESSIONS.dev);       // DevOne 301000000001
  const userToken = await namedToken(env, SESSIONS.user);     // UserOne 301000000003
  const card = (n) => ({ avgDps: 1000 + n, breakValue: 2000 + n, damageTaken: 3000 + n, heal: n });
  const at = Math.floor(Date.now() / 1000) - 60;
  // UserOne's copy: DevOne misread (and taken for AI), and "DevOne" wrongly on a third player's card
  await sendRun(env, userToken, run("u-card", { gameUid: "301000000003", score: 100, stars: 10, playedAt: at, players: [
    { name: "UserOne", ai: false, self: true, ...card(1) },
    { name: "Xq7", ai: true, ...card(2) },
    { name: "DevOne", ai: false, ...card(3) },
  ] }));
  // DevOne's copy, with a different score read: only the cards tie the two together
  await sendRun(env, devToken, run("d-card", { gameUid: "301000000001", score: 900, stars: 4, playedAt: at + 20, players: [
    { name: "UserOne", ai: false, ...card(1) },
    { name: "DevOne", ai: false, self: true, ...card(2) },
    { name: "Third", ai: false, ...card(3) },
  ] }));
  const players = (id) => JSON.parse(sqlite.prepare("SELECT players_json FROM leaderboard_submissions WHERE client_run_id = ?").get(id).players_json);
  const shared = (id) => JSON.parse(sqlite.prepare("SELECT extra_json FROM leaderboard_submissions WHERE client_run_id = ?").get(id).extra_json).sharedRun;
  assert.ok(shared("u-card"));
  assert.equal(shared("u-card"), shared("d-card"));
  const mine = players("u-card");
  assert.deepEqual([mine[1].name, mine[1].uid, mine[1].ai], ["DevOne", "301000000001", false]);   // the card, not the name
  assert.equal(mine[2].uid ?? null, null);                                                          // the wrong slot gets no UID
  assert.equal(players("d-card")[0].uid, "301000000003");
});

test("Battle Data cards alone do not tie two runs together with fewer than two cards in common", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const devToken = await namedToken(env, SESSIONS.dev);
  const userToken = await namedToken(env, SESSIONS.user);
  const card = (n) => ({ avgDps: 1000 + n, breakValue: 2000 + n, damageTaken: 3000 + n, heal: n });
  const at = Math.floor(Date.now() / 1000) - 60;
  await sendRun(env, userToken, run("u-one", { gameUid: "301000000003", score: 100, stars: 10, playedAt: at, players: [{ name: "UserOne", ai: false, self: true, ...card(1) }, { name: "Other", ai: false, ...card(5) }] }));
  await sendRun(env, devToken, run("d-one", { gameUid: "301000000001", score: 900, stars: 4, playedAt: at + 20, players: [{ name: "DevOne", ai: false, self: true, ...card(2) }, { name: "Other", ai: false, ...card(5) }] }));
  const extra = JSON.parse(sqlite.prepare("SELECT extra_json FROM leaderboard_submissions WHERE client_run_id = ?").get("d-one").extra_json) || {};
  assert.equal(extra.sharedRun, undefined);
});

test("one party run sent by two players: matched by the Party screen's slots when a number was misread, shown once", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const devToken = await namedToken(env, SESSIONS.dev);       // DevOne 301000000001
  const userToken = await namedToken(env, SESSIONS.user);     // UserOne 301000000003
  const lineup = (self) => [
    { slot: 1, name: "UserOne", ai: false, ...(self === "UserOne" ? { self: true } : {}) },
    { slot: 2, name: "DevOne", ai: false, ...(self === "DevOne" ? { self: true } : {}) },
    { slot: 3, name: "Mario", ai: true }, { slot: 4, name: "Flora", ai: true },
  ];
  const party = (self) => [{ name: "UserOne", ai: false, self: self === "UserOne" }, { name: "DevOne", ai: false, self: self === "DevOne" }];
  const at = Math.floor(Date.now() / 1000) - 60;
  // UserOne's app read 34 stars, DevOne's misread 4: the numbers differ, the Party screens agree
  await sendRun(env, userToken, run("u-copy", { gameUid: "301000000003", score: 34324, stars: 34, playedAt: at, players: party("UserOne"), extra: { lineup: lineup("UserOne") } }));
  await sendRun(env, devToken, run("d-copy", { gameUid: "301000000001", score: 34324, stars: 4, playedAt: at + 20, players: party("DevOne"), extra: { lineup: lineup("DevOne") } }));
  const shared = (id) => (JSON.parse(sqlite.prepare("SELECT extra_json FROM leaderboard_submissions WHERE client_run_id = ?").get(id).extra_json) || {}).sharedRun;
  assert.ok(shared("u-copy"));
  assert.equal(shared("u-copy"), shared("d-copy"));
  // each vouched for the other: DevOne's slot in UserOne's copy now carries DevOne's UID (and the other way round)
  const slot = (id, name) => JSON.parse(sqlite.prepare("SELECT players_json FROM leaderboard_submissions WHERE client_run_id = ?").get(id).players_json).find((p) => p.name === name);
  assert.equal(slot("u-copy", "DevOne").uid, "301000000001");
  assert.equal(slot("d-copy", "UserOne").uid, "301000000003");
  // DevOne's history: the run once (their own copy), captured by 2
  const runs = (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs;
  assert.deepEqual(runs.map((r) => [r.credited, r.captures]), [[false, 2]]);
  // the app can't set the link itself, and the boards' API never shows it
  await sendRun(env, devToken, run("forged", { gameUid: "301000000001", playedAt: at - 3000, extra: { sharedRun: shared("u-copy") } }));
  assert.equal(shared("forged"), undefined);
  assert.equal(JSON.stringify(await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json()).includes("sharedRun"), false);
  // another party in the same minutes (a different player in slot 2) isn't the same run
  await sendRun(env, userToken, run("u-other", { gameUid: "301000000003", score: 30000, stars: 30, playedAt: at + 40, players: party("UserOne"),
    extra: { lineup: [{ slot: 1, name: "UserOne", ai: false, self: true }, { slot: 2, name: "Stranger", ai: false }] } }));
  assert.equal(shared("u-other"), undefined);
});

test("a newer but lower run never replaces the best on the boards; it's added to the history", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  await sendRun(env, token, run("high", { score: 30000, stars: 30, playedAt: 1792700000 }));
  await sendRun(env, token, run("low", { score: 12000, stars: 12, playedAt: 1792790000 }));
  const board = await (await call(env, "/api/leaderboard/entries?kind=interlink_run&cycle=3005")).json();
  assert.deepEqual(board.entries.map((e) => e.score), [30000]);
  const history = (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs;
  assert.deepEqual(history.map((r) => r.score), [12000, 30000]);          // both, newest first
});

test("how a run ended: cleared, ended early by the leader, time up, or invalid (quit: in the history, on no board)", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  const infergon = { boss: { id: "80000107", name: "Omega Infergon", level: 60 } };      // week 3005: 15 stars clear
  await sendRun(env, token, run("kill", { ...infergon, stars: 15, score: 18000, clearTimeS: 140, cleared: true, playedAt: 1792700400 }));
  await sendRun(env, token, run("leader-ended", { ...infergon, stars: 15, score: 16000, clearTimeS: 120, cleared: true, playedAt: 1792700300,
    extra: { endedByLeader: true } }));
  await sendRun(env, token, run("quit", { ...infergon, stars: 9, score: 9500, clearTimeS: 95, cleared: false, playedAt: 1792700200 }));
  await sendRun(env, token, run("timeout", { ...infergon, stars: 12, score: 12500, clearTimeS: 180, cleared: false, playedAt: 1792700100 }));
  // an app that said "cleared" for a quit run (up to 0.1.21): still invalid
  await sendRun(env, token, run("quit-said-cleared", { ...infergon, stars: 6, score: 26400, clearTimeS: 70, cleared: true, playedAt: 1792700000 }));
  const history = (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs;
  assert.deepEqual(history.map((r) => [r.score, r.outcome]),
    [[18000, "cleared"], [16000, "ended-early"], [9500, "invalid"], [12500, "time-up"], [26400, "invalid"]]);
  // no board has the invalid runs - not even the highest score (26,400), nor the player's own list
  const all = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json()).entries;
  assert.deepEqual(all.map((e) => e.score).sort(), [12500, 16000, 18000]);
  const best = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run")).json()).entries;
  assert.deepEqual(best.map((e) => e.score), [18000]);
  const mine = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0&mine=1", { session: SESSIONS.dev })).json()).entries;
  assert.equal(mine.some((e) => e.score === 26400), false);
});

test("runs stored before outcomes were kept get theirs by themselves: the first read fills them, with no sign-in", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  const infergon = { boss: { id: "80000107", name: "Omega Infergon", level: 60 } };
  await sendRun(env, token, run("old-kill", { ...infergon, stars: 15, score: 18000, clearTimeS: 140, cleared: true, playedAt: 1792700400 }));
  await sendRun(env, token, run("old-quit", { ...infergon, stars: 6, score: 26400, clearTimeS: 70, cleared: true, playedAt: 1792700000 }));
  sqlite.exec("UPDATE leaderboard_submissions SET outcome = NULL");       // as stored before 0033
  // a freshly started worker, and a signed-out visitor opening the boards
  const fresh = Object.assign(Object.create(env), { DB: Object.create(env.DB) });
  const best = (await (await call(fresh, "/api/leaderboard/entries?kind=interlink_run")).json()).entries;
  assert.deepEqual(best.map((e) => e.score), [18000]);                    // the old quit run is off the board at once
  assert.deepEqual(sqlite.prepare("SELECT client_run_id, outcome FROM leaderboard_submissions ORDER BY client_run_id").all().map((r) => [r.client_run_id, r.outcome]),
    [["old-kill", "cleared"], ["old-quit", "invalid"]]);
});

test("profile visibility: Public shows every part, Custom only the ticked ones, Private nothing - the owner always sees all", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  await sendRun(env, token, run("v1"));
  const save = (body) => call(env, "/api/profile", { session: SESSIONS.dev, method: "PATCH", body: { displayName: "Dev", bio: "about me", ...body } });
  const publicId = (await (await save({ visibility: "public" })).json()).profile.publicId;
  const view = async () => (await call(env, `/api/profiles/${publicId}`)).json();
  const listed = async () => (await (await call(env, "/api/profiles/directory")).json()).recent.map((row) => row.publicId);
  const found = async () => (await (await call(env, "/api/profiles/search?q=DevOne")).json()).results.map((row) => row.publicId);
  // Public: everything but My runs, which is private until its own switch says otherwise
  let shown = await view();
  assert.deepEqual(shown.parts, ["standings", "collection", "photos", "about", "directory"]);
  assert.equal(shown.profile.bio, "about me");
  assert.ok(shown.leaderboards);
  assert.equal((await call(env, `/api/profiles/${publicId}/history`)).status, 404);
  assert.deepEqual([await listed(), await found()], [[publicId], [publicId]]);
  // My runs public: the list for anyone
  const opened = await (await save({ visibility: "public", runsPublic: true })).json();
  assert.equal(opened.profile.runsPublic, true);
  assert.deepEqual((await view()).parts, ["standings", "history", "collection", "photos", "about", "directory"]);
  assert.equal((await call(env, `/api/profiles/${publicId}/history`)).status, 200);
  // Custom: everything private but leaderboard standing; My runs keeps its own switch (Battle History isn't on the list)
  const custom = await (await save({ visibility: "custom", publicParts: ["history", "standings"] })).json();
  assert.deepEqual([custom.profile.visibility, custom.profile.publicParts, custom.profile.runsPublic], ["custom", ["standings", "history"], true]);
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT preferences_json FROM profiles WHERE discord_id = ?").get(IDS.dev).preferences_json).visibility.parts, ["standings"]);
  shown = await view();
  assert.deepEqual(shown.parts, ["standings", "history"]);
  assert.equal(shown.profile.bio, null);                                   // about: private
  assert.deepEqual([shown.characters, shown.photos, shown.collection], [[], [], null]);
  assert.ok(shown.leaderboards);                                           // standings: public
  assert.equal((await call(env, `/api/profiles/${publicId}/history`)).status, 200);
  assert.deepEqual([await listed(), await found()], [[], []]);            // not in the directory or the search
  // My runs private again: its link is "not found"
  await save({ visibility: "custom", publicParts: ["standings"], runsPublic: false });
  assert.equal((await call(env, `/api/profiles/${publicId}/history`)).status, 404);
  // the owner still sees all of it
  assert.equal((await call(env, "/api/profile/history", { session: SESSIONS.dev })).status, 200);
  const own = await (await call(env, "/api/profile", { session: SESSIONS.dev })).json();
  assert.deepEqual([own.profile.visibility, own.profile.publicParts, own.profile.runsPublic], ["custom", ["standings"], false]);
  // Private: no page at all, My runs included, whatever its switch says
  await save({ visibility: "private", runsPublic: true });
  assert.equal((await call(env, `/api/profiles/${publicId}`)).status, 404);
  assert.equal((await call(env, `/api/profiles/${publicId}/history`)).status, 404);
  // back to Public: the same link, everything again, and the Custom list is gone
  await save({ visibility: "public" });
  assert.deepEqual((await view()).parts.length, 6);
  assert.equal(JSON.parse(sqlite.prepare("SELECT preferences_json FROM profiles WHERE discord_id = ?").get(IDS.dev).preferences_json || "{}").visibility, undefined);
  assert.equal((await save({ visibility: "secret" })).status, 400);
  assert.equal((await save({ visibility: "custom", publicParts: ["everything"] })).status, 400);
  assert.equal((await save({ runsPublic: "yes" })).status, 400);
  // a Custom list that ticked Battle History before the switch existed keeps it public
  sqlite.prepare("UPDATE profiles SET preferences_json = ? WHERE discord_id = ?")
    .run(JSON.stringify({ visibility: { mode: "custom", parts: ["standings", "history"] } }), IDS.dev);
  assert.deepEqual((await view()).parts, ["standings", "history"]);
});

test("aLogs B2's Party screen as sent: the lead with level and CP, teammates by name, Season Buffs and an unsure offering", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  const lineup = [{ slot: 1, name: "DevOne", ai: false, self: true, aniimo: "Emberpup", aniimoLevel: 60, cp: 12345,
    team: [{ aniimo: "Emberpup", aniimoLevel: 60, cp: 12345 }, { aniimo: "Somniwing" }, { aniimo: "Tromber" }] }];
  const buffs = [{ id: 6023, name: "Joint Defense", level: 3 }, { id: 6012, name: "Coordinated Offensive", level: 2 }, { name: "Spark Offering or Ember Offering" }];
  assert.equal((await sendRun(env, token, run("b2", { buffs, extra: { lineup } }))).status, 201);
  const [listed] = (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs;
  assert.deepEqual(listed.lineup[0].team, [{ aniimo: "Emberpup", aniimoLevel: 60, cp: 12345 }, { aniimo: "Somniwing" }, { aniimo: "Tromber" }]);
  assert.deepEqual(listed.buffs, [{ name: "Joint Defense", level: 3 }, { name: "Coordinated Offensive", level: 2 }, { name: "Spark Offering or Ember Offering" }]);
});

test("a boss board row says how its run ended, with the battle clock: Timed Out, Early Exit, Boss Killed", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  const infergon = { boss: { id: "80000107", name: "Omega Infergon", level: 60 } };      // week 3005: 15 stars clear
  const row = async () => {
    const e = (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json()).bosses.find((b) => b.id === "80000107").entries[0];
    return [e.outcome, e.runTimeS, e.clearTimeS];
  };
  await sendRun(env, token, run("timeout", { ...infergon, stars: 12, score: 12500, clearTimeS: 180, cleared: false }));
  assert.deepEqual(await row(), ["time-up", 180, null]);                  // no kill time, but the clock ran 3:00
  await sendRun(env, token, run("leader-ended", { ...infergon, stars: 15, score: 16000, clearTimeS: 120, cleared: true, extra: { endedByLeader: true } }));
  assert.deepEqual(await row(), ["ended-early", 120, 120]);
  await sendRun(env, token, run("kill", { ...infergon, stars: 15, score: 18000, clearTimeS: 140, cleared: true }));
  assert.deepEqual(await row(), ["cleared", 140, 140]);
});

test("Timed Out or quit goes by the run's own clock (Overtime: 4:00); every star at the clock's end is Timed Out", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  const infergon = { boss: { id: "80000107", name: "Omega Infergon", level: 60 } };      // week 3005: 15 stars clear
  const overtime = { extra: { timeLimitS: 240 } };
  await sendRun(env, token, run("ot-quit", { ...infergon, ...overtime, stars: 12, score: 12000, clearTimeS: 210, cleared: false, playedAt: 1792700300 }));
  await sendRun(env, token, run("ot-timeout", { ...infergon, ...overtime, stars: 13, score: 13000, clearTimeS: 240, cleared: false, playedAt: 1792700200 }));
  // an older app sent no clock: a run past 3:00 had Overtime (4:00), so every star at 3:20 is a kill
  await sendRun(env, token, run("old-kill", { ...infergon, stars: 15, score: 17000, clearTimeS: 200, cleared: false, playedAt: 1792700100 }));
  const history = (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs;
  assert.deepEqual(history.map((r) => [r.score, r.outcome]), [[12000, "invalid"], [13000, "time-up"], [17000, "cleared"]]);
  const row = (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json()).bosses.find((b) => b.id === "80000107").entries[0];
  assert.deepEqual([row.score, row.outcome, row.runTimeS], [17000, "cleared", 200]);     // Boss Killed: 3:20
});

test("every star at the clock's end is Timed Out (the team hit for score until time ran out); under the clock it's a kill", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  const infergon = { boss: { id: "80000107", name: "Omega Infergon", level: 60 } };      // week 3005: 15 stars clear
  await sendRun(env, token, run("full-3m", { ...infergon, stars: 15, score: 20062, clearTimeS: 180, cleared: false, playedAt: 1792700300 }));
  await sendRun(env, token, run("ot-kill", { ...infergon, stars: 15, score: 19000, clearTimeS: 200, cleared: true, extra: { timeLimitS: 240 }, playedAt: 1792700200 }));
  await sendRun(env, token, run("ot-full", { ...infergon, stars: 15, score: 18000, clearTimeS: 240, cleared: false, extra: { timeLimitS: 240 }, playedAt: 1792700100 }));
  const history = (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs;
  assert.deepEqual(history.map((r) => [r.score, r.outcome]), [[20062, "time-up"], [19000, "cleared"], [18000, "time-up"]]);
  const row = (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json()).bosses.find((b) => b.id === "80000107").entries[0];
  assert.deepEqual([row.score, row.outcome, row.runTimeS], [20062, "time-up", 180]);   // "Timed Out: 3:00"
});

test("Show me by: a board row carries the account's Discord name only when its player picked it", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  sqlite.prepare("UPDATE users SET discord_global_name = 'Dev On Discord' WHERE discord_id = ?").run(IDS.dev);
  sqlite.prepare("UPDATE users SET discord_global_name = 'User On Discord' WHERE discord_id = ?").run(IDS.user);
  assert.equal((await sendRun(env, await namedToken(env, SESSIONS.dev), run("name-dev", { score: 21000 }))).status, 201);
  assert.equal((await sendRun(env, await namedToken(env, SESSIONS.user), run("name-user", { score: 15000, players: [{ name: "UserOne" }] }))).status, 201);
  const boards = async () => [
    await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json(),
    await (await call(env, "/api/leaderboard/interlink?season=1")).json(),
    await (await call(env, "/api/leaderboard/entries?kind=interlink_run")).json(),
  ];
  const named = (rows) => rows.map((row) => [row.player, row.discordName || null]);
  // nobody picked it: the in-game names, and no Discord name anywhere
  assert.equal(JSON.stringify(await boards()).includes("On Discord"), false);
  // the dev picks their Discord name: their rows carry it (the character name stays), the other player's don't
  assert.equal((await call(env, "/api/profile", { session: SESSIONS.dev, method: "PATCH", body: { displayName: "Dev", nameShown: "discord" } })).status, 200);
  const [week, season, entries] = await boards();
  assert.deepEqual(named(week.bosses.find((boss) => boss.id === "80000107").entries), [["DevOne", "Dev On Discord"], ["UserOne", null]]);
  assert.deepEqual(named(week.week), [["DevOne", "Dev On Discord"], ["UserOne", null]]);
  assert.deepEqual(named(entries.entries), [["DevOne", "Dev On Discord"], ["UserOne", null]]);
  assert.deepEqual(named(season.standings), [["DevOne", "Dev On Discord"], ["UserOne", null]]);
  assert.equal(JSON.stringify(await boards()).includes("User On Discord"), false);
});

test("a run whose Party screen shows another party is hidden as it arrives; misread names aren't", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.user);
  const at = Math.floor(Date.now() / 1000) - 600;
  const people = (...names) => names.map((name, i) => ({ name, avgDps: 1000 + i, ai: false }));
  const lineup = (...names) => ({ lineup: names.map((name, slot) => ({ slot, name, ai: false })) });
  const status = (id) => sqlite.prepare("SELECT status, json_extract(extra_json, '$.autoHidden') AS why FROM leaderboard_submissions WHERE client_run_id = ?").get(id);
  // the earlier party, read right
  await sendRun(env, token, run("first", { playedAt: at, players: people("UserOne", "Brightfox", "Juniper", "Quillan"), extra: lineup("UserOne", "Brightfox", "Juniper", "Quillan") }));
  assert.equal(status("first").status, "visible");
  // a new party, but the Party screen still shows the earlier one: hidden
  const sent = await sendRun(env, token, run("stale", { playedAt: at + 300, players: people("Tarrow", "UserOne", "Vexley", "Hobnail"), extra: lineup("UserOne", "Brightfox", "Juniper", "Quillan") }));
  const body = await sent.json();
  assert.equal(body.hidden, "party");
  assert.deepEqual({ ...status("stale") }, { status: "hidden", why: "party" });
  // the Party screen read badly (names nobody has): not hidden
  await sendRun(env, token, run("garbled", { playedAt: at + 400, players: people("Tarrow", "UserOne", "Vexley", "Hobnail"), extra: lineup("UserOne", "ZzPnyru", "Vxqlrey", "TUN") }));
  assert.equal(status("garbled").status, "visible");
  // misreads of the same party (a letter off, lookalikes): not hidden
  await sendRun(env, token, run("misread", { playedAt: at + 500, players: people("Tarrow", "UserOne", "Vexley", "Hobnail"), extra: lineup("UserOne", "Tarr0w", "Vexly", "H0bnail") }));
  assert.equal(status("misread").status, "visible");
  // too few readable names to tell: not hidden
  await sendRun(env, token, run("unreadable", { playedAt: at + 550, players: people("UserOne", "002", "ㄴㄱ", "L"), extra: lineup("UserOne", "Brightfox", "Juniper", "Quillan") }));
  assert.equal(status("unreadable").status, "visible");
});

// The limits these tests use are made up for the tests: the real ones are a secret of the deployed API.
const TEST_SIM_LIMITS = { minTimeS: { Easy: 20, Normal: 20, Hard: 50, Challenge: 50, Trial: 50 }, minCoins: 100, minGizmos: 5 };

test("Holo-Battle Sim run checks: what a full run can't be is flagged, and held when it's clear", () => {
  const limits = simCheckLimits({ SIM_CHECK_LIMITS: JSON.stringify(TEST_SIM_LIMITS) });
  assert.deepEqual(limits, TEST_SIM_LIMITS);
  const row = (difficulty, clearTimeS, setup, cleared = 1) => ({ cleared, clearTimeS, difficulty, extraJson: setup ? JSON.stringify({ setup }) : null });
  const rules = (...args) => simRunChecks(row(...args), limits).map((flag) => flag.rule);
  const held = (...args) => simRunHeld(simRunChecks(row(...args), limits));
  const TIME = "clear time possible for the difficulty";
  const COINS = "coins of a full run";
  const GIZMOS = "gizmos of a full run";
  // a run under every limit: too fast, next to no coins, one gizmo (its count unread) and no core
  const spoofed = row("Trial", 40, { team: [{ name: "A", level: 65, mvp: true }], mvpShares: { damage: 98, taken: 29, healing: 0 }, coins: 25, gizmos: [{ series: "Surge", count: null }] });
  assert.deepEqual(simRunChecks(spoofed, limits), [{ rule: TIME, sent: 40, expected: 50, hold: true }, { rule: COINS, sent: 25, expected: 100 }, { rule: GIZMOS, sent: 1, expected: 5 }]);
  assert.equal(simRunHeld(simRunChecks(spoofed, limits)), true);
  // full runs, lean setups included
  assert.deepEqual(rules("Easy", 120, { coins: 3350, gizmos: [{ series: "Energy", count: 10 }, { series: "Defense", count: 2 }] }), []);
  assert.deepEqual(rules("Easy", 123, { coins: 3050, gizmos: [{ series: "Energy" }, { series: "Surge" }, { series: "Valor" }, { series: "Wealth" }, { series: "Defense" }] }), []);
  assert.deepEqual(rules("Normal", 211, { coins: 3500 }), []);
  assert.deepEqual(rules("Hard", 681, {}), []);
  assert.deepEqual(rules("Challenge", 809, null), []);
  assert.deepEqual(rules("Trial", 411, { team: [{ name: "A", level: 70 }] }), []);        // nothing else read: says nothing
  // each floor: at it passes, a second under is flagged
  for (const [difficulty, floor] of Object.entries(TEST_SIM_LIMITS.minTimeS)) {
    assert.deepEqual(rules(difficulty, floor, null), [], difficulty);
    assert.deepEqual(rules(difficulty, floor - 1, null), [TIME], difficulty);
  }
  assert.deepEqual(rules(null, 19, null), [TIME]);                                        // no difficulty sent: the lowest floor
  assert.deepEqual(rules(null, 20, null), []);
  assert.deepEqual(rules("Trial", 600, { coins: 99 }), [COINS]);
  assert.deepEqual(rules("Trial", 600, { coins: 100 }), []);
  assert.deepEqual(rules("Trial", 600, { coins: null, gizmos: [] }), []);                 // unread
  assert.deepEqual(rules("Trial", 600, { coins: "25" }), []);                             // not a number the app read
  assert.deepEqual(rules("Trial", 600, { gizmos: [{ series: "Surge", count: 4 }] }), [GIZMOS]);
  assert.deepEqual(rules("Trial", 600, { gizmos: [{ series: "Surge", count: 5 }] }), []);
  assert.deepEqual(rules("Trial", 600, { gizmos: [{ series: "Surge", count: 3 }, { series: "Energy" }, { series: "Valor" }] }), []);   // counts unread: one each
  // a run that isn't a Victory, or has no time, isn't ranked: not checked
  assert.deepEqual(rules("Trial", 10, { coins: 0 }, 0), []);
  assert.deepEqual(rules("Trial", null, { coins: 0 }), []);
  // one misread number is listed, not held; a time under the floor, or coins and gizmos together, are held
  assert.equal(held("Trial", 600, { coins: 12 }), false);
  assert.equal(held("Trial", 600, { gizmos: [{ series: "Surge", count: 1 }] }), false);
  assert.equal(held("Trial", 600, { coins: 25, gizmos: [{ series: "Surge", count: 1 }] }), true);
  assert.equal(held("Trial", 49, { coins: 12000 }), true);
  assert.equal(simRunHeld([]), false);
  // the secret: any part can be left out (that rule is off); none, or one that doesn't parse, and nothing is checked
  assert.deepEqual(simRunChecks(spoofed, simCheckLimits({ SIM_CHECK_LIMITS: '{"minCoins": 100}' })).map((flag) => flag.rule), [COINS]);
  assert.deepEqual(simCheckLimits({ SIM_CHECK_LIMITS: '{"minTimeS": {"Trial": 50, "Easy": -3, "Hard": "9"}, "minCoins": 0}' }), { minTimeS: { Trial: 50 }, minCoins: null, minGizmos: null });
  for (const value of [undefined, "", "not json", "[]", "{}", '{"minTimeS": {}}', '{"minCoins": "100"}']) {
    assert.equal(simCheckLimits({ SIM_CHECK_LIMITS: value }), null, String(value));
  }
  assert.deepEqual(simRunChecks(spoofed, null), []);
});

test("a Holo-Battle Sim run that fails its checks is held off the boards as it arrives, until staff review it", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev, SIM_CHECK_LIMITS: JSON.stringify(TEST_SIM_LIMITS) });
  const token = await namedToken(env, SESSIONS.user);
  const other = await namedToken(env, SESSIONS.dev2);
  const full = { coins: 9037, style: "Energy", core: "Energizing Bracer", gizmos: [{ series: "Energy", count: 10 }, { series: "Defense", count: 7 }] };
  const bare = { coins: 25, gizmos: [{ series: "Surge", count: null }] };
  const sim = (id, time, setupOf = full, more = {}) => ({ kind: "sim_run", clientRunId: id, trial: "Lightning Training", difficulty: "Trial", clearTimeS: time,
    cleared: true, partySize: 1, playedAt: 1794700000, extra: { setup: setupOf }, ...more });
  const stored = (id) => ({ ...sqlite.prepare(`SELECT status, verify_state AS state, json_extract(extra_json, '$.autoHidden') AS why,
    json_extract(verify_json, '$.held') AS held FROM leaderboard_submissions WHERE client_run_id = ?`).get(id) });
  const board = async () => (await (await call(env, "/api/leaderboard/entries?kind=sim_run&sort=clear_time_s&cycle=2&trial=Lightning&difficulty=Trial&best=0")).json())
    .entries.map((entry) => entry.clearTimeS);
  const review = (submissionId, decision, session = SESSIONS.dev) => call(env, `/api/admin/run-checks/${submissionId}`, { session, method: "POST", body: { decision } });
  // honest runs: stored, on the board, not listed
  const honest = await sendRun(env, other, sim("honest", 626));
  assert.equal(honest.status, 201);
  assert.equal((await honest.json()).hidden, undefined);
  assert.deepEqual(stored("honest"), { status: "visible", state: null, why: null, held: null });
  // a run under every limit: stored (201) but held, and never on the board
  const sent = await sendRun(env, token, sim("spoofed", 40, bare));
  assert.equal(sent.status, 201);
  const spoofed = await sent.json();
  assert.equal(spoofed.hidden, "check");
  assert.deepEqual(stored("spoofed"), { status: "hidden", state: "mismatch", why: "check", held: 1 });
  assert.deepEqual(await board(), [626]);
  // sent again (the same id, as the app re-sends): still held, the reason still on it
  assert.equal((await (await sendRun(env, token, sim("spoofed", 40, bare))).json()).hidden, "check");
  assert.deepEqual(stored("spoofed"), { status: "hidden", state: "mismatch", why: "check", held: 1 });
  // a plausible setup doesn't get a time under the floor through, and neither does a re-send over an accepted run's id
  assert.equal((await (await sendRun(env, token, sim("fast", 49))).json()).hidden, "check");
  assert.equal((await (await sendRun(env, token, sim("swap", 700))).json()).hidden, undefined);
  assert.equal((await (await sendRun(env, token, sim("swap", 30))).json()).hidden, "check");
  assert.deepEqual(await board(), [626]);
  // one odd number alone: listed for review, still on the board
  assert.equal((await (await sendRun(env, token, sim("misread", 800, { ...full, coins: 90 }))).json()).hidden, undefined);
  assert.deepEqual(stored("misread"), { status: "visible", state: "mismatch", why: null, held: 0 });
  assert.deepEqual(await board(), [626, 800]);
  // ... and when the app sends it again read right, the flag goes
  await sendRun(env, token, sim("misread", 800));
  assert.deepEqual(stored("misread"), { status: "visible", state: null, why: null, held: null });
  // the review list (administrators and the owner) has the held runs with their flags
  const listed = (await (await call(env, "/api/admin/run-checks?state=mismatch", { session: SESSIONS.dev })).json()).runs;
  assert.deepEqual(listed.map((item) => [item.kind, item.trial, item.difficulty, item.clearTimeS, item.status, item.check.held]).sort((a, b) => a[3] - b[3]),
    [["sim_run", "Lightning", "Trial", 30, "hidden", true], ["sim_run", "Lightning", "Trial", 40, "hidden", true], ["sim_run", "Lightning", "Trial", 49, "hidden", true]]);
  assert.deepEqual(listed.find((item) => item.clearTimeS === 40).check.rules.flags.map((flag) => [flag.rule, flag.sent]),
    [["clear time possible for the difficulty", 40], ["coins of a full run", 25], ["gizmos of a full run", 1]]);
  assert.equal((await review(spoofed.submissionId, "confirmed", SESSIONS.user)).status, 403);
  // rejected: stays off the boards, also when sent again
  assert.equal((await review(spoofed.submissionId, "rejected")).status, 200);
  assert.deepEqual(stored("spoofed"), { status: "hidden", state: "rejected", why: "check", held: 1 });
  await sendRun(env, token, sim("spoofed", 40, full));
  assert.equal(stored("spoofed").status, "hidden");
  assert.equal(stored("spoofed").state, "rejected");
  // confirmed (a real fast run): on the boards, and a re-send of the same run doesn't hold it again
  const fast = listed.find((item) => item.clearTimeS === 49);
  assert.equal((await review(fast.submissionId, "confirmed")).status, 200);
  assert.deepEqual(stored("fast"), { status: "visible", state: "confirmed", why: null, held: 1 });
  assert.equal((await (await sendRun(env, token, sim("fast", 49))).json()).hidden, undefined);
  assert.deepEqual(stored("fast"), { status: "visible", state: "confirmed", why: null, held: 1 });
  assert.deepEqual(await board(), [49, 626, 800]);
  // ... but new numbers under the same id are judged again
  assert.equal((await (await sendRun(env, token, sim("fast", 45))).json()).hidden, "check");
  assert.deepEqual(await board(), [626, 800]);
  // other modes aren't touched: an Interlink run's review stays shadow mode
  assert.equal((await sendRun(env, token, run("il", { score: 20000 }))).status, 201);
  assert.equal(stored("il").status, "visible");
});

test("without the limits secret no Holo-Battle Sim run is checked, and a run already held stays held", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true", SIM_CHECK_LIMITS: JSON.stringify(TEST_SIM_LIMITS) });
  const token = await namedToken(env, SESSIONS.user);
  const sim = (id, time) => ({ kind: "sim_run", clientRunId: id, trial: "Lightning Training", difficulty: "Trial", clearTimeS: time, cleared: true, partySize: 1 });
  const status = (id) => sqlite.prepare("SELECT status FROM leaderboard_submissions WHERE client_run_id = ?").get(id).status;
  assert.equal((await (await sendRun(env, token, sim("held", 10))).json()).hidden, "check");
  delete env.SIM_CHECK_LIMITS;
  assert.equal((await (await sendRun(env, token, sim("unchecked", 10))).json()).hidden, undefined);
  assert.equal(status("unchecked"), "visible");
  assert.equal((await (await sendRun(env, token, sim("held", 10))).json()).hidden, "check");
  assert.equal(status("held"), "hidden");
});

test("the proof viewer's line over the pictures: which fight the run is, for every mode", async () => {
  const { env } = await setup({ EVIDENCE: evidenceStore(), LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  const jpeg = (mark) => { const data = new Uint8Array(2048); data.set([0xff, 0xd8, 0xff, mark]); return new Blob([data], { type: "image/jpeg" }); };
  const fightOf = async (submission, mark) => {
    const form = new FormData();
    form.set("submission", JSON.stringify(submission));
    form.set("evidence", jpeg(mark), "result.jpg");
    const sent = await call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
    assert.ok([200, 201].includes(sent.status), String(sent.status));
    const { submissionId } = await sent.json();
    return (await (await call(env, `/api/leaderboard/submissions/${submissionId}/evidence?shot=list`)).json()).fight;
  };
  const week = (await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json()).cycle;
  assert.deepEqual(await fightOf(run("il", { score: 34324, stars: 34, clearTimeS: 187 }), 2), {
    mode: "interlink", kind: "interlink_run", title: "Omega Infergon", level: 60, week: { start: week.start, end: week.end }, stars: 34, score: 34324, time: 187 });
  // a menu best: its score and stars, no time
  assert.deepEqual(await fightOf({ kind: "interlink_best", clientRunId: "best-3005-80000107", cycle: "3005",
    boss: { id: "80000107", name: "Omega Infergon", level: 60 }, score: 35000, stars: 35 }, 3), {
    mode: "interlink", kind: "interlink_best", title: "Omega Infergon", level: 60, week: { start: week.start, end: week.end }, stars: 35, score: 35000 });
  assert.deepEqual(await fightOf({ kind: "sim_run", clientRunId: "sim", trial: "Training of Water", difficulty: "Hard", clearTimeS: 502, cleared: true, partySize: 1 }, 4),
    { mode: "sim", kind: "sim_run", title: "Training of Water", difficulty: "Hard", time: 502 });
  assert.deepEqual(await fightOf({ kind: "eggheist_match", clientRunId: "egg", cycle: "S1", score: 20000, clearTimeS: 224, cleared: true, difficulty: "Normal", defeats: 1 }, 5),
    { mode: "eggheist", kind: "eggheist_match", title: "Normal", score: 20000, escaped: true, time: 224 });
  assert.deepEqual(await fightOf({ kind: "eggheist_season", clientRunId: "season", cycle: "S1", rank: { tier: 7, subtier: 1, name: "Egg Emperor" }, score: 2900, stars: 475 }, 6),
    { mode: "eggheist", kind: "eggheist_season", title: "Egg Emperor", season: "S1", points: 2900 });
});

test("the proof viewer's Avg DPS: a Battle Data card goes on a player's row only when it is surely theirs", () => {
  const slot = (n, name, extra = {}) => ({ slot: n, name, ...extra });
  const card = (name, avgDps, extra = {}) => ({ name, avgDps, breakValue: 1, damageTaken: 1, heal: 0, ...extra });
  const dps = (lineup, cards) => lineupDps(lineup, cards).map((entry) => entry.avgDps);
  // the sender's slot takes the sender's card, whatever its name was read as; others by the name read the same
  assert.deepEqual(dps([slot(0, "Player 1", { self: true }), slot(1, "Player 2"), slot(2, "Player 3", { ai: true }), slot(3, "Player 4")],
    [card("PIayer l", 4100, { self: true }), card("player 2", 3900), card("Player 3", 2500, { ai: true })]), [4100, 3900, 2500, null]);
  // a name on two slots or two cards: neither row gets a card
  assert.deepEqual(dps([slot(0, "Player 1"), slot(1, "Player 1"), slot(2, "Player 2")], [card("Player 1", 100), card("Player 2", 200)]), [null, null, 200]);
  assert.deepEqual(dps([slot(0, "Player 1"), slot(1, "Player 2")], [card("Player 1", 100), card("Player 1", 300)]), [null, null]);
  // the sender's slot name is on another card: not sure which is theirs, and that card isn't given to anyone else
  assert.deepEqual(dps([slot(0, "Player 1", { self: true }), slot(1, "Player 2")], [card("Player 2", 100, { self: true }), card("Player 1", 300)]),
    [null, null]);
  // the sender's card's name is another slot's: neither row gets it
  assert.deepEqual(dps([slot(0, "Player 1"), slot(1, "Player 2", { self: true })], [card("Player 1", 100, { self: true })]), [null, null]);
  // a lineup without the sender's mark (older builds): the card goes by its name
  assert.deepEqual(dps([slot(0, "Player 1"), slot(1, "Player 2")], [card("Player 1", 100, { self: true })]), [100, null]);
  // no name (left out by mergedLineup), no card, no Battle Data, or no DPS on the card: Not captured
  assert.deepEqual(dps([slot(0, undefined), slot(1, "Player 2")], [card("Player 2", 0)]), [null, null]);
  assert.deepEqual(dps([slot(0, "Player 1")], null), [null]);
  assert.equal(lineupDps(null, []), null);
});

test("a shared run's lineup: a copy that names someone twice is named again from the copies, the rest as before", () => {
  // 14 Nov: a teammate's copy read two players' names as one player's and shifted a third; the run showed one name twice
  const lead = (slot, name, cp, extra = {}) => ({ slot, name, cp, aniimo: "Irisalis", aniimoLevel: 70, ...extra });
  const misread = [lead(0, "Ann", 4234), lead(1, "Neo", 3775), lead(2, "Neo", 3931), lead(3, "Dax", 4148)];
  const right = [lead(0, "Ann", 4234, { self: true }), lead(1, "Kay", 3775), lead(2, "Dax", 3931), lead(3, "Neo", 4148)];
  assert.deepEqual(mergedLineup(misread, [right]).map((entry) => entry.name), ["Ann", "Kay", "Dax", "Neo"]);
  assert.deepEqual(mergedLineup(right, [misread]).map((entry) => entry.name), ["Ann", "Kay", "Dax", "Neo"]);
  // a player's own copy names them over any other read
  const theirs = [lead(0, "Ann", 4234), lead(1, "Kai", 3775), lead(2, "Dax", 3931), lead(3, "Neo", 4148, { self: true })];
  assert.equal(mergedLineup(misread, [theirs])[3].name, "Neo");
  // a lineup without a name twice stays as its copies give it
  assert.deepEqual(mergedLineup(right, [right]).map((entry) => entry.name), ["Ann", "Kay", "Dax", "Neo"]);
  // nothing settles a name: left out, not shown on two players
  const one = [lead(0, "Ann", 4234), lead(1, "Neo", 3775), lead(2, "Neo", 3931)];
  assert.deepEqual(mergedLineup(one, []).map((entry) => entry.name ?? null), ["Ann", "Neo", null]);
  // without CPs, slots still pair the copies
  assert.equal(mergedLineup([{ slot: 1, name: "X" }], [[{ slot: 1, name: "Y", self: true }]])[0].name, "Y");
});

// ---------------------------------------------------------------- team rows: one row per run on the team ladders
const TEAM_FIELDS = ["runGroup", "runFirst", "figureGroup", "figureFirst"];
const tuckingBoss = { id: "80000100", name: "Omega Tucking", level: 60 };
const interlinkBoard = async (env, query, bossId = tuckingBoss.id) => {
  const data = await (await call(env, `/api/leaderboard/interlink?cycle=3005&unlinked=1${query ? `&${query}` : ""}`)).json();
  return { data, boss: data.bosses.find((x) => x.id === bossId) };
};

test("team rows: one run sent by two of its four players is one team row; they all share its place", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await desktopToken(env, SESSIONS.dev);
  const b = await desktopToken(env, SESSIONS.dev2);
  const c = await desktopToken(env, SESSIONS.user);
  const send = (token, body) => call(env, "/api/leaderboard/submissions", { token, method: "POST", body });
  await call(env, "/api/leaderboard/characters", { token: a, method: "POST", form: proofForm({ gameUid: "302000000001", name: "Fennick" }) });
  await call(env, "/api/leaderboard/characters", { token: b, method: "POST", form: proofForm({ gameUid: "302000000002", name: "Marlowe" }) });
  await call(env, "/api/leaderboard/characters", { token: c, method: "POST", form: proofForm({ gameUid: "302000000003", name: "Quillon" }) });
  const party = (me) => ["Fennick", "Marlowe", "Brindle", "Oswin"].map((name) => ({ name, ai: false, self: name === me }));
  const shared = { boss: tuckingBoss, score: 16064, stars: 15, clearTimeS: 150, cleared: true, playedAt: 1792700000 };
  await send(a, run("tm1", { ...shared, gameUid: "302000000001", players: party("Fennick") }));
  await send(b, run("tm2", { ...shared, gameUid: "302000000002", playedAt: 1792700060, players: party("Marlowe") }));
  // another team's run, lower
  await send(c, run("tm3", { ...shared, score: 15000, gameUid: "302000000003", players: [{ name: "Quillon", ai: false, self: true }, { name: "Tamsin", ai: false }] }));

  const { boss } = await interlinkBoard(env, "ladder=score");
  const top = boss.entries.filter((e) => e.score === 16064);
  assert.deepEqual(top.map((e) => e.player).sort(), ["Brindle", "Fennick", "Marlowe", "Oswin"]);
  assert.deepEqual([...new Set(top.map((e) => [e.rank, e.team].join("|")))], ["1|1"]);
  assert.deepEqual(boss.entries.filter((e) => e.score === 15000).map((e) => [e.player, e.rank, e.team]).sort(), [["Quillon", 2, 2], ["Tamsin", 2, 2]]);
  assert.deepEqual([boss.teams, boss.total], [2, 6]);
  // the default order (most stars, then score) pools the same way
  const plain = (await interlinkBoard(env, "")).boss;
  assert.deepEqual([plain.teams, plain.total, plain.entries.filter((e) => e.score === 16064).every((e) => e.rank === 1 && e.team === 1)], [2, 6, true]);
});

// one sender, four runs of four teams: they share the sender, each run has a teammate of its own
// (sent a minute apart, so the tie lists the run that arrived first first)
async function fourRuns(env, sqlite) {
  const a = await namedToken(env, SESSIONS.dev);                    // DevOne
  const send = async (id, score, mate, at) => {
    await sendRun(env, a, run(id, { gameUid: "301000000001", boss: tuckingBoss, score, stars: 15, clearTimeS: 150 + at,
      cleared: true, playedAt: 1792700000 + at * 600, players: [{ name: "DevOne", ai: false, self: true }, { name: mate, ai: false }] }));
    sqlite.prepare("UPDATE leaderboard_submissions SET created_at = created_at - ? WHERE client_run_id = ?").run((5 - at) * 60, id);
  };
  await send("r1", 20000, "Ashgrove", 1);
  await send("r2", 18000, "Birchly", 2);
  await send("r3", 18000, "Cedarby", 3);
  await send("r4", 15000, "Duneworth", 4);
}

test("team rows: equal results share a place and the next place is skipped (1, 2, 2, 4)", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await fourRuns(env, sqlite);
  const { boss } = await interlinkBoard(env, "ladder=score");
  assert.deepEqual(boss.entries.map((e) => [e.player, e.rank, e.team]),
    [["DevOne", 1, 1], ["Ashgrove", 1, 1], ["Birchly", 2, 2], ["Cedarby", 2, 3], ["Duneworth", 4, 4]]);
  assert.deepEqual([boss.teams, boss.total], [4, 5]);
});

test("team rows: a teammate whose best is another run sits in that row; the run they were also on says so", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await fourRuns(env, sqlite);
  const { boss } = await interlinkBoard(env, "ladder=score");
  const row = (player) => boss.entries.find((e) => e.player === player);
  assert.equal(row("DevOne").team, row("Ashgrove").team);           // DevOne's best is the 20,000 run
  // the first entry of each other run's row names DevOne, at their place
  for (const player of ["Birchly", "Cedarby", "Duneworth"]) assert.deepEqual(row(player).also, [{ player: "DevOne", rank: 1, profileId: null }]);
  // the row DevOne is in names nobody else; only a row's first entry carries it
  assert.equal("also" in row("DevOne") || "also" in row("Ashgrove"), false);
});

test("team rows: two copies with different score reads: every player takes the higher read, two spellings of one name settle to one player, one team row", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const devToken = await namedToken(env, SESSIONS.dev);
  const userToken = await namedToken(env, SESSIONS.user);
  const lineup = (self) => [{ slot: 1, name: "UserOne", ai: false, ...(self === "UserOne" ? { self: true } : {}) },
    { slot: 2, name: "DevOne", ai: false, ...(self === "DevOne" ? { self: true } : {}) }, { slot: 3, name: "Mario", ai: true }];
  // the two copies read the third player's name differently, so each of those rows has one copy only
  const party = (self, third) => [{ name: "UserOne", ai: false, self: self === "UserOne" }, { name: "DevOne", ai: false, self: self === "DevOne" },
    { name: third, ai: false }];
  const at = Math.floor(Date.now() / 1000) - 60;
  await sendRun(env, userToken, run("u-read", { gameUid: "301000000003", score: 34324, stars: 34, playedAt: at, players: party("UserOne", "Pipwick"), extra: { lineup: lineup("UserOne") } }));
  await sendRun(env, devToken, run("d-read", { gameUid: "301000000001", score: 34234, stars: 34, playedAt: at + 20, players: party("DevOne", "P1pwick"), extra: { lineup: lineup("DevOne") } }));
  const shared = (id) => (JSON.parse(sqlite.prepare("SELECT extra_json FROM leaderboard_submissions WHERE client_run_id = ?").get(id).extra_json) || {}).sharedRun;
  assert.ok(shared("u-read") && shared("u-read") === shared("d-read"));   // one run
  const boss = (await (await call(env, "/api/leaderboard/interlink?cycle=3005&ladder=score&unlinked=1")).json()).bosses.find((x) => x.id === "80000107");
  // the players both copies credit take the higher read. The third player's two reads fold to one name, so since the
  // copies are settled together (settledRun) both copies credit one player under one spelling (which one: the newest
  // build's, then the first sent, then the lower id - random here), and the lower copy has no row of its own left.
  assert.deepEqual(boss.entries.map((e) => [e.player.replace("P1pwick", "Pipwick"), e.score, e.rank, e.team]).sort((x, y) => x[3] - y[3] || x[0].localeCompare(y[0])),
    [["DevOne", 34324, 1, 1], ["Pipwick", 34324, 1, 1], ["UserOne", 34324, 1, 1]]);
  assert.equal(boss.teams, 1);
});

test("team rows: a one-player ladder (Avg DPS) is never pooled", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await namedToken(env, SESSIONS.dev);
  await sendRun(env, a, run("solo-dps", { gameUid: "301000000001", boss: tuckingBoss, score: 20000, stars: 15, players: [
    { name: "DevOne", ai: false, self: true, avgDps: 9000 }, { name: "Larkspur", ai: false, avgDps: 7000 }, { name: "Mirefen", ai: false, avgDps: 7000 }] }));
  const { boss } = await interlinkBoard(env, "ladder=dps");
  assert.deepEqual(boss.entries.map((e) => [e.avgDps, e.rank, e.team]), [[9000, 1, 1], [7000, 2, 2], [7000, 2, 3]]);
  assert.equal("also" in boss.entries[0], false);
  assert.deepEqual([boss.teams, boss.total], [3, 3]);
  // the same run on the score ladder: one team row
  const score = (await interlinkBoard(env, "ladder=score")).boss;
  assert.deepEqual(score.entries.map((e) => [e.rank, e.team]), [[1, 1], [1, 1], [1, 1]]);
});

test("team rows: ?rows=teams pages by team rows, otherwise by players; the answer says which", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await fourRuns(env, sqlite);
  const byTeams = await interlinkBoard(env, "ladder=score&rows=teams&limit=1&offset=1");
  assert.equal(byTeams.data.rows, "teams");
  assert.deepEqual(byTeams.boss.entries.map((e) => e.player), ["Birchly"]);
  const first = await interlinkBoard(env, "ladder=score&rows=teams&limit=1");
  assert.deepEqual(first.boss.entries.map((e) => e.player), ["DevOne", "Ashgrove"]);    // every player of the team row
  const byPlayers = await interlinkBoard(env, "ladder=score&limit=1&offset=1");
  assert.equal(byPlayers.data.rows, "players");
  assert.deepEqual(byPlayers.boss.entries.map((e) => e.player), ["Ashgrove"]);
  // reversed: the team rows the other way round, a team row's players in their order
  const reversed = await interlinkBoard(env, "ladder=score&rows=teams&order=asc");
  assert.deepEqual(reversed.boss.entries.map((e) => [e.player, e.rank]),
    [["Duneworth", 4], ["Cedarby", 2], ["Birchly", 2], ["DevOne", 1], ["Ashgrove", 1]]);
  assert.deepEqual([byTeams.boss.teams, byTeams.boss.total], [4, 5]);
});

test("team rows: the run's grouping never leaves the API; the desktop app's week call still gets every player", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await fourRuns(env, sqlite);
  for (const query of ["", "ladder=score", "ladder=teamDps&rows=teams", "ladder=dps", "ladder=clear&limit=2"]) {
    const text = await (await call(env, `/api/leaderboard/interlink?cycle=3005&unlinked=1&${query}`)).text();
    for (const field of TEAM_FIELDS) assert.equal(text.includes(field), false, `${field} in ?${query}`);
  }
  const overview = await (await call(env, "/api/profile/overview", { session: SESSIONS.dev })).json();
  assert.ok(overview.trophies?.length);
  for (const field of TEAM_FIELDS) assert.equal(JSON.stringify(overview).includes(field), false, `${field} in the profile`);
  // the desktop app's call: no ladder, no limit, every per-player entry with its uid, stars and score
  const app = (await (await call(env, "/api/leaderboard/interlink?cycle=3005&unlinked=1")).json()).bosses.find((x) => x.id === tuckingBoss.id);
  assert.equal(app.entries.length, 5);
  assert.ok(app.entries.every((e) => "uid" in e && e.stars === 15 && Number.isInteger(e.score)));
  assert.equal(app.entries.find((e) => e.player === "DevOne").uid, "301000000001");
});

// one run sent by DevOne with three teammates; dps: each player's Avg DPS (undefined: none on their card)
async function dpsRun(env, id, score, dps, at = 1) {
  const a = await namedToken(env, SESSIONS.dev);
  const players = Object.entries(dps).map(([name, avgDps]) => ({ name, ai: false, ...(name === "DevOne" ? { self: true } : {}),
    ...(avgDps === undefined ? {} : { avgDps }) }));
  const sent = await sendRun(env, a, run(id, { gameUid: "301000000001", boss: tuckingBoss, score, stars: 15, clearTimeS: 150, cleared: true,
    playedAt: 1792700000 + at * 600, players }));
  assert.equal(sent.status, 201);
}
const names = (boss) => boss.entries.map((e) => e.player);

test("team rows: under rows=teams a team row's players come by their Avg DPS, highest first; none last", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await dpsRun(env, "carry", 20000, { DevOne: 5000, Kestrel: 9000, Lumen: 7000, Morrow: undefined });
  const teams = (await interlinkBoard(env, "ladder=score&rows=teams")).boss;
  assert.deepEqual(names(teams), ["Kestrel", "Lumen", "DevOne", "Morrow"]);
  assert.deepEqual(teams.entries.map((e) => [e.rank, e.team]), [[1, 1], [1, 1], [1, 1], [1, 1]]);
  // without rows=teams: the order as before (the sender's own row, then the teammates as the run lists them)
  assert.deepEqual(names((await interlinkBoard(env, "ladder=score")).boss), ["DevOne", "Kestrel", "Lumen", "Morrow"]);
});

test("team rows: players with the same Avg DPS keep the order they had", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await dpsRun(env, "even", 20000, { DevOne: 5000, Lumen: 7000, Kestrel: 7000, Morrow: 9000 });
  const before = names((await interlinkBoard(env, "ladder=score")).boss);
  assert.deepEqual(before, ["DevOne", "Kestrel", "Lumen", "Morrow"]);
  // Kestrel and Lumen tie on 7,000: in the order they had
  const tied = before.filter((name) => name === "Kestrel" || name === "Lumen");
  assert.deepEqual(names((await interlinkBoard(env, "ladder=score&rows=teams")).boss), ["Morrow", ...tied, "DevOne"]);
});

test("team rows: by Avg DPS, also stays on the row's first entry and the reversed order keeps each row's players", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await dpsRun(env, "lower", 20000, { DevOne: 5000, Kestrel: 9000, Lumen: 7000, Morrow: undefined }, 1);
  await dpsRun(env, "higher", 25000, { DevOne: 6000, Quillet: 8000 }, 2);         // DevOne's best: in this row
  const { boss } = await interlinkBoard(env, "ladder=score&rows=teams");
  assert.deepEqual(boss.entries.map((e) => [e.player, e.rank, e.team]),
    [["Quillet", 1, 1], ["DevOne", 1, 1], ["Kestrel", 2, 2], ["Lumen", 2, 2], ["Morrow", 2, 2]]);
  assert.deepEqual(boss.entries.filter((e) => "also" in e).map((e) => [e.player, e.also]), [["Kestrel", [{ player: "DevOne", rank: 1, profileId: null }]]]);
  assert.deepEqual([boss.teams, boss.total], [2, 5]);
  const reversed = (await interlinkBoard(env, "ladder=score&rows=teams&order=asc")).boss;
  assert.deepEqual(names(reversed), ["Kestrel", "Lumen", "Morrow", "Quillet", "DevOne"]);
  // paging by team rows: the second team row, its players by Avg DPS
  assert.deepEqual(names((await interlinkBoard(env, "ladder=score&rows=teams&limit=1&offset=1")).boss), ["Kestrel", "Lumen", "Morrow"]);
});

test("team rows, View all paging: 25 team rows a page, a team never split over two pages, both views counted right", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const a = await namedToken(env, SESSIONS.dev);
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const mate = (prefix, i) => `${prefix}${letters[i % 26]}${letters[Math.floor(i / 26)]}`;
  // 30 runs, one an hour: DevOne's best (the first) with two team-mates, then 29 runs of two team-mates each
  for (let i = 0; i < 30; i += 1) {
    const players = [...(i === 0 ? [{ name: "DevOne", ai: false, self: true }] : []), { name: mate("Ward", i), ai: false }, { name: mate("Vale", i), ai: false }];
    assert.equal((await sendRun(env, a, run(`page-${i}`, { gameUid: "301000000001", boss: tuckingBoss, score: 20000 - i * 10, stars: 15,
      clearTimeS: 150, cleared: true, playedAt: 1792700000 + i * 3600, players }))).status, 201);
    sqlite.prepare("UPDATE leaderboard_submissions SET created_at = created_at - ? WHERE client_run_id = ?").run((30 - i) * 3600, `page-${i}`);
  }
  const teamsOn = (boss) => [...new Set(boss.entries.map((e) => e.team))];
  const first = (await interlinkBoard(env, "ladder=score&rows=teams&limit=25")).boss;
  const second = (await interlinkBoard(env, "ladder=score&rows=teams&limit=25&offset=25")).boss;
  assert.deepEqual([first.teams, first.total, second.teams, second.total], [30, 61, 30, 61]);
  assert.deepEqual([teamsOn(first).length, first.entries.length, teamsOn(second).length, second.entries.length], [25, 51, 5, 10]);
  assert.equal(teamsOn(first).some((team) => teamsOn(second).includes(team)), false, "no team row on both pages");
  for (const team of teamsOn(second)) assert.equal(second.entries.filter((e) => e.team === team).length, 2, "every player of a team row on its page");
  assert.deepEqual(second.entries.map((e) => e.rank).filter((rank, i, all) => all.indexOf(rank) === i), [26, 27, 28, 29, 30]);
  // past the end: nothing
  assert.equal((await interlinkBoard(env, "ladder=score&rows=teams&limit=25&offset=50")).boss.entries.length, 0);
  // Players: by players
  const players = (await interlinkBoard(env, "ladder=score&limit=25&offset=50")).boss;
  assert.deepEqual([players.entries.length, players.total], [11, 61]);
  // reversed in Teams view: the last five team rows first, whole
  const reversed = (await interlinkBoard(env, "ladder=score&rows=teams&order=asc&limit=25&offset=25")).boss;
  assert.deepEqual([teamsOn(reversed).length, reversed.entries.length], [5, 11]);
  assert.equal(reversed.entries.filter((e) => e.player === "DevOne").length, 1);
});

test("team rows, proofs: each sender's entry points at their own copy of the run; a team-mate's at one of those copies; each opens that run", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true", EVIDENCE: evidenceStore() });
  const dev = await namedToken(env, SESSIONS.dev);
  const user = await namedToken(env, SESSIONS.user);
  const at = Math.floor(Date.now() / 1000) - 60;
  const players = (me) => [["DevOne", 0], ["UserOne", 1], ["Rook", 2]].map(([name, n]) => ({ name, ai: false, ...(name === me ? { self: true } : {}), ...copyCard(n) }));
  const body = (id, gameUid, me) => run(id, { gameUid, boss: tuckingBoss, score: 21000, stars: 21, clearTimeS: 170, playedAt: at, players: players(me) });
  const devId = (await (await sendRun(env, dev, body("proof-dev", "301000000001", "DevOne"), ["evidence"])).json()).submissionId;
  const userId = (await (await sendRun(env, user, body("proof-user", "301000000003", "UserOne"), ["evidence"])).json()).submissionId;
  // another run of DevOne's an hour before, lower: not this row's pictures
  await sendRun(env, dev, run("proof-old", { gameUid: "301000000001", boss: tuckingBoss, score: 15000, stars: 15, playedAt: at - 3600,
    players: [{ name: "DevOne", ai: false, self: true }, { name: "Larkspur", ai: false }] }), ["evidence"]);
  const { boss } = await interlinkBoard(env, "ladder=score&rows=teams");
  const row = (player) => boss.entries.find((e) => e.player === player);
  assert.deepEqual([row("DevOne").team, row("UserOne").team, row("Rook").team], [1, 1, 1]);
  assert.equal(row("DevOne").proofIds.score, devId);
  assert.equal(row("UserOne").proofIds.score, userId);
  assert.ok([devId, userId].includes(row("Rook").proofIds.score));
  for (const id of [devId, userId]) {
    const details = await (await call(env, `/api/leaderboard/submissions/${id}/evidence?shot=list`)).json();
    assert.deepEqual([details.fight?.score, details.fight?.stars], [21000, 21], "the row's run");
  }
});

test("team rows with the server filter: a run's copy from an app that sends no server still credits its players; another server's run is left out", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const dev = await namedToken(env, SESSIONS.dev);
  const user = await namedToken(env, SESSIONS.user);
  const dev2 = await namedToken(env, SESSIONS.dev2);
  const at = Math.floor(Date.now() / 1000) - 60;
  const players = (me) => [["DevOne", 0], ["UserOne", 1], ["Rook", 2]].map(([name, n]) => ({ name, ai: false, ...(name === me ? { self: true } : {}), ...copyCard(n) }));
  const body = (id, gameUid, me, server) => run(id, { gameUid, boss: tuckingBoss, score: 21000, stars: 21, clearTimeS: 170, playedAt: at, players: players(me),
    ...(server ? { server } : {}) });
  await sendRun(env, dev, body("srv-dev", "301000000001", "DevOne", "Aniimo-Americas"));
  await sendRun(env, user, body("srv-user", "301000000003", "UserOne", null));           // an older app: no server
  await sendRun(env, dev2, run("srv-eu", { gameUid: "301000000002", boss: tuckingBoss, score: 22000, stars: 21, clearTimeS: 160, playedAt: at,
    server: "Aniimo-Europe", players: [{ name: "DevTwo", ai: false, self: true }, { name: "Saffron", ai: false }] }));
  const shape = (boss) => boss.entries.map((e) => [e.player, e.rank, e.team]).sort((x, y) => x[2] - y[2] || x[0].localeCompare(y[0]));
  const americas = (await interlinkBoard(env, "ladder=score&rows=teams&server=Aniimo-Americas")).boss;
  assert.deepEqual(shape(americas), [["DevOne", 1, 1], ["Rook", 1, 1], ["UserOne", 1, 1]]);
  assert.deepEqual([americas.teams, americas.total], [1, 3]);
  const europe = (await interlinkBoard(env, "ladder=score&rows=teams&server=Aniimo-Europe")).boss;
  assert.deepEqual(shape(europe), [["DevTwo", 1, 1], ["Saffron", 1, 1]]);
  assert.equal(europe.entries.some((e) => "also" in e), false);
  const all = (await interlinkBoard(env, "ladder=score&rows=teams")).boss;
  assert.deepEqual([all.teams, all.total], [2, 5]);
});

test("team rows on a two-boss week: copies sent under the first and the second boss are one run on the middle board, one team row", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const week = { id: "4003", season: 2, start: Math.floor(Date.now() / 1000) - 86400, end: Math.floor(Date.now() / 1000) + 86400 * 5,
    bosses: [{ id: "80000109", name: "Omega Sherro" }, { id: "80000120", name: "Alpha Blazen", second: { id: "80000121", name: "Omega Tucking" } }, { id: "80000101", name: "Alpha Bouldus" }] };
  sqlite.prepare("INSERT INTO interlink_cycles (id, season, start_at, end_at, bosses_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(week.id, week.season, week.start, week.end, JSON.stringify(week.bosses), IDS.dev, week.start);
  const dev = await namedToken(env, SESSIONS.dev);
  const user = await namedToken(env, SESSIONS.user);
  const at = Math.floor(Date.now() / 1000) - 60;
  const players = (me) => [["DevOne", 0], ["UserOne", 1], ["Rook", 2]].map(([name, n]) => ({ name, ai: false, ...(name === me ? { self: true } : {}), ...copyCard(n) }));
  const body = (id, gameUid, me, boss) => run(id, { cycle: "4003", gameUid, boss: { ...boss, level: 60 }, score: 125120, stars: 40, clearTimeS: 300, playedAt: at, players: players(me) });
  assert.equal((await sendRun(env, dev, body("pair-dev", "301000000001", "DevOne", { id: "80000120", name: "Alpha Blazen" }))).status, 201);
  assert.equal((await sendRun(env, user, body("pair-user", "301000000003", "UserOne", { id: "80000121", name: "Omega Tucking" }))).status, 201);
  const data = await (await call(env, "/api/leaderboard/interlink?cycle=4003&unlinked=1&ladder=score&rows=teams")).json();
  const middle = data.bosses.find((boss) => boss.id === "80000120");
  assert.equal(data.bosses.some((boss) => boss.id === "80000121"), false, "no board of its own for the second boss");
  assert.deepEqual(middle.entries.map((e) => [e.player, e.rank, e.team]).sort((x, y) => x[0].localeCompare(y[0])), [["DevOne", 1, 1], ["Rook", 1, 1], ["UserOne", 1, 1]]);
  assert.deepEqual([middle.teams, middle.total], [1, 3]);
});

// Week 4003's Center: Alpha Blazen, then Omega Tucking when it falls, in one run. Every place that names a boss names
// that fight by both (its runs are stored under the first boss). The run here is shaped like the live ones: all 40
// stars at the full 180 s clock with the second boss still up (cleared false).
test("a two-boss week: the Center is named by both bosses on its board, the run viewer, the profile, My runs and the menus", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true", EVIDENCE: evidenceStore() });
  const now = Math.floor(Date.now() / 1000);
  const week = { id: "4003", season: 1, start: now - 86400, end: now + 86400 * 5,
    bosses: [{ id: "80000109", name: "Omega Sherro" }, { id: "80000120", name: "Alpha Blazen", second: { id: "80000119", name: "Omega Tucking" } }, { id: "80000101", name: "Alpha Bouldus" }] };
  sqlite.prepare("INSERT INTO interlink_cycles (id, season, start_at, end_at, bosses_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(week.id, week.season, week.start, week.end, JSON.stringify(week.bosses), IDS.dev, week.start);
  const token = await namedToken(env, SESSIONS.dev);
  const form = (body) => { const data = new FormData(); data.set("submission", JSON.stringify(body));
    const jpeg = new Uint8Array(2048); jpeg.set([0xff, 0xd8, 0xff, 7]); data.set("evidence", new Blob([jpeg], { type: "image/jpeg" }), "result.jpg"); return data; };
  const sent = await call(env, "/api/leaderboard/submissions", { token, method: "POST",
    form: form(run("pair-1", { cycle: "4003", boss: { id: "80000119", name: "Omega Tucking", level: 60 }, score: 52000, stars: 40, clearTimeS: 180, cleared: false, playedAt: now - 600 })) });
  assert.equal(sent.status, 201);
  const { submissionId } = await sent.json();
  assert.equal((await sendRun(env, token, run("side-1", { cycle: "4003", boss: { id: "80000109", name: "Omega Sherro", level: 60 }, score: 21000, stars: 20, clearTimeS: 150, cleared: true, playedAt: now - 300 }))).status, 201);

  // the board: the Center's entry carries its second boss; the sides don't; the run timed out at 3:00 (no clear time)
  const data = await (await call(env, "/api/leaderboard/interlink?cycle=4003&ladder=score&rows=teams")).json();
  assert.deepEqual(data.bosses.map((boss) => [boss.slot, boss.name, boss.second ?? null, boss.starCap]), [
    ["Left", "Omega Sherro", null, 20], ["Center", "Alpha Blazen", { id: "80000119", name: "Omega Tucking" }, 40], ["Right", "Alpha Bouldus", null, 20]]);
  assert.deepEqual(data.bosses[1].entries.map((e) => [e.stars, e.outcome, e.clearTimeS, e.runTimeS]), [[40, "time-up", null, 180]]);
  assert.equal("twoBossStarsConfirmed" in data.rules, false);
  // "View all" asks for one board: the same entry
  const one = await (await call(env, "/api/leaderboard/interlink?cycle=4003&boss=80000120&ladder=score&rows=teams&limit=25")).json();
  assert.deepEqual(one.bosses.map((boss) => [boss.name, boss.second?.name]), [["Alpha Blazen", "Omega Tucking"]]);

  // the run viewer's title line
  const fight = (await (await call(env, `/api/leaderboard/submissions/${submissionId}/evidence?shot=list`)).json()).fight;
  assert.equal(fight.title, "Alpha Blazen + Omega Tucking");

  // My runs / Battle History: the run's boss with its second; the boss menu by both; the search box finds it by either
  const mine = (q = "") => historyOf(env, `/api/profile/history?page=1${q ? `&q=${q}` : ""}`, SESSIONS.dev);
  const history = await mine();
  const pair = history.runs.find((r) => r.submissionId === submissionId);
  assert.deepEqual(pair.boss, { id: "80000120", name: "Alpha Blazen", level: 60, second: { id: "80000119", name: "Omega Tucking" } });
  assert.equal(pair.outcome, "time-up");
  assert.equal(history.runs.find((r) => r.submissionId !== submissionId).boss.second, undefined);
  assert.deepEqual(history.filters.bosses.map((b) => b.name).sort(), ["Alpha Blazen + Omega Tucking", "Omega Sherro"]);
  assert.deepEqual((await mine("tucking")).runs.map((r) => r.submissionId), [submissionId]);
  assert.deepEqual((await mine("blazen")).runs.map((r) => r.submissionId), [submissionId]);
  assert.equal((await mine("sherro")).runs.some((r) => r.submissionId === submissionId), false);

  // the runs page's boss menu and rows
  const facets = await (await call(env, "/api/leaderboard/facets?mode=interlink")).json();
  assert.deepEqual(facets.bosses.map((b) => b.name).sort(), ["Alpha Blazen + Omega Tucking", "Omega Sherro"]);
  const entries = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run&cycle=4003&boss=80000120")).json()).entries;
  assert.deepEqual(entries.map((e) => e.boss.second), [{ id: "80000119", name: "Omega Tucking" }]);

  // the profile: the week's tree, its board entry and the trophy that names the fight
  const overview = await (await call(env, "/api/profile/overview", { session: SESSIONS.dev })).json();
  const bosses = overview.leaderboards.interlinkParts.current.weeks[0].bosses;
  assert.deepEqual(bosses.map((b) => [b.name, b.second?.name ?? null]), [["Omega Sherro", null], ["Alpha Blazen + Omega Tucking", "Omega Tucking"]]);
  const entry = overview.leaderboards.interlink_run.find((e) => e.boss?.id === "80000120");
  assert.deepEqual(entry.boss.second, { id: "80000119", name: "Omega Tucking" });
  const best = overview.trophies.find((trophy) => trophy.id === "interlink-score");
  assert.equal(best.context.boss.name, "Alpha Blazen + Omega Tucking");
});

test("the boards page: the rules line under a two-boss week says only what live runs showed", () => {
  const page = readFileSync(resolve(import.meta.dirname, "..", "public", "leaderboard", "leaderboard.js"), "utf8");
  const source = page.match(/ {2}function rulesLine\([\s\S]*?\r?\n {2}\}\r?\n/u)?.[0];
  assert.ok(source, "rulesLine is in the page");
  const rulesLine = new Function(`${source}; return rulesLine;`)();
  const slots = ["Left", "Center", "Right"];
  const text = (parts) => parts.map((part) => `${part.label || ""}${part.text}${part.pair ? " [own line]" : ""}`);
  const single = [{ slot: "Left", slotIndex: 0, name: "Omega Sherro" }, { slot: "Center", slotIndex: 1, name: "Alpha Glameep" }, { slot: "Right", slotIndex: 2, name: "Alpha Bouldus" }];
  assert.deepEqual(text(rulesLine([20, 40, 20], [20, 40, 20], slots, single)), ["Max stars 20 / 40 / 20", "A kill is 20 / 40 / 20 stars"]);
  assert.deepEqual(text(rulesLine([15, 30, 15], [15, 15, 15], slots, single)), ["Max stars 15 / 30 / 15", "A kill is 15 stars"]);
  const paired = single.map((boss) => (boss.slotIndex === 1 ? { ...boss, name: "Alpha Blazen", second: { id: "80000119", name: "Omega Tucking" } } : boss));
  // the cap is confirmed (no "unconfirmed"); no word on what a Center kill is worth; one sentence for the two bosses
  assert.deepEqual(text(rulesLine([20, 40, 20], [20, 40, 20], slots, paired)), [
    "Max stars 20 / 40 / 20", "A kill is 20 stars on the Left and Right", "The Center is two bosses in one run: Alpha Blazen, then Omega Tucking. [own line]"]);
  assert.doesNotMatch(page, /unconfirmed\)|twoBossStarsConfirmed|How its stars add up/u);
  // the profile's week tree says "Both Killed" for a two-boss fight, as the boards do
  const app = readFileSync(resolve(import.meta.dirname, "..", "public", "app.js"), "utf8");
  assert.match(app, /const killed = boss\.second \? "Both Killed" : "Boss Killed";/u);
  assert.match(page, /const killed = boss\?\.second \? "Both Killed" : "Boss Killed";/u);
  // "View all"'s crumb: "Center bosses" on a two-boss board, "Left boss" on the others
  assert.match(page, /\$\{boss\.slot\} \$\{boss\.second \? "bosses" : "boss"\}/u);
});

test("a boss is named by both only where a week pairs it: an id a week lists alone stays one boss", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const now = Math.floor(Date.now() / 1000);
  const add = (id, start, bosses) => sqlite.prepare("INSERT INTO interlink_cycles (id, season, start_at, end_at, bosses_json, updated_by, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)")
    .run(id, start, start + 86400 * 6, JSON.stringify(bosses), IDS.dev, start);
  // made-up weeks: boss 80000150 is the paired Center of one week and a fight of its own in another
  add("4003", now - 86400 * 8, [{ id: "80000140", name: "Alpha One" }, { id: "80000150", name: "Alpha Two", second: { id: "80000151", name: "Omega Three" } }, { id: "80000160", name: "Alpha Four" }]);
  add("4004", now - 86400, [{ id: "80000140", name: "Alpha One" }, { id: "80000150", name: "Alpha Two" }, { id: "80000160", name: "Alpha Four" }]);
  const token = await namedToken(env, SESSIONS.dev);
  for (const [id, cycle] of [["w1", "4003"], ["w2", "4004"]]) {
    assert.equal((await sendRun(env, token, run(id, { cycle, boss: { id: "80000150", name: "Alpha Two", level: 60 }, score: 30000, stars: 30, playedAt: now - 600 }))).status, 201);
  }
  const history = await historyOf(env, "/api/profile/history?page=1", SESSIONS.dev);
  assert.deepEqual(history.runs.map((r) => [r.cycle, r.boss.second?.name ?? null]).sort(), [["4003", "Omega Three"], ["4004", null]]);
  assert.deepEqual(history.filters.bosses.map((b) => b.name), ["Alpha Two"]);           // one menu entry for both weeks
  const boards = await (await call(env, "/api/leaderboard/interlink?cycle=4004")).json();
  assert.equal(boards.bosses[1].second, undefined);
});

// ---------------------------------------------------------------- copies of one run: marks and names
// Three senders (the test accounts' characters) and a team-mate without the app.
const SENDERS = { DevOne: ["301000000001", SESSIONS.dev], DevTwo: ["301000000002", SESSIONS.dev2], UserOne: ["301000000003", SESSIONS.user] };
const copyCard = (n) => ({ avgDps: 5000 + n, breakValue: 600 + n, damageTaken: 7000 + n, heal: 80 + n });
// an env on the same database whose first statement matching `pattern` waits, once it is reached, until released
function heldAt(env, pattern) {
  let open; const opened = new Promise((resolve) => { open = resolve; });
  let arrive; const arrived = new Promise((resolve) => { arrive = resolve; });
  let used = false;
  const hold = (statement) => Object.fromEntries(["first", "all", "run"].map((method) => [method, async () => { arrive(); await opened; return statement[method](); }]));
  const DB = { ...env.DB, prepare(sql) {
    const prepared = env.DB.prepare(sql);
    if (used || !pattern.test(sql)) return prepared;
    used = true;
    return { ...hold(prepared), bind: (...values) => hold(prepared.bind(...values)) };
  } };
  return { env: { ...env, DB }, arrived, release: () => open() };
}
// the pause point: a copy's first write of a players_json (the old code's and the new code's both start so)
const HELD_WRITE = /^UPDATE leaderboard_submissions SET players_json/u;
async function threeSenders(env) {
  const tokens = {};
  for (const [name, [, session]] of Object.entries(SENDERS)) tokens[name] = await namedToken(env, session);
  const at = Math.floor(Date.now() / 1000) - 60;
  const body = (me, slots, offset = 0) => run(`copy-${me}`, { gameUid: SENDERS[me][0], score: 21000, stars: 21, clearTimeS: 170, playedAt: at + offset,
    players: slots.map(([name, card], index) => ({ name, ai: false, ...(name === me && index === slots.findIndex(([n]) => n === me) ? { self: true } : {}),
      ...(card == null ? {} : copyCard(card)) })) });
  const right = [["DevOne", 0], ["DevTwo", 1], ["UserOne", 2], ["Rook", 3]];
  return { tokens, body, right, send: (me, slots = right, onEnv = env, offset = 0) => sendRun(onEnv, tokens[me], body(me, slots, offset)) };
}
const storedCopies = (sqlite) => sqlite.prepare("SELECT client_run_id AS id, players_json AS players, extra_json AS extra FROM leaderboard_submissions WHERE kind = 'interlink_run' ORDER BY client_run_id").all()
  .map((row) => ({ id: row.id, players: JSON.parse(row.players), extra: JSON.parse(row.extra || "{}") || {} }));
// on the board (Show unlinked) each sender once, as themselves (so no unclaimed row with a sender's name)
async function sendersOnce(env, senders) {
  const { boss } = await interlinkBoard(env, "", "80000107");
  for (const name of senders) {
    assert.deepEqual(boss.entries.filter((e) => e.player.toLowerCase() === name.toLowerCase()).map((e) => e.unclaimed), [false], `${name} once, as themselves`);
  }
  return boss;
}
// every copy: each other sender's slot carries their UID, confirmed; one sharedRun for all; the board as above
async function assertSettled(env, sqlite, senders = Object.keys(SENDERS)) {
  const rows = storedCopies(sqlite);
  for (const row of rows) {
    const me = row.id.replace(/^copy-/u, "");
    for (const other of senders.filter((name) => name !== me)) {
      const slot = row.players.find((player) => player.name === other && !player.self);
      assert.deepEqual([slot?.uid, slot?.confirmed], [SENDERS[other][0], true], `${other}'s slot in ${me}'s copy`);
    }
  }
  const groups = new Set(rows.map((row) => row.extra.sharedRun));
  assert.equal(groups.size, 1, "one sharedRun for every copy");
  assert.ok([...groups][0], "the copies are linked");
  return sendersOnce(env, senders);
}

test("copies of one run: a copy held between its read and its write loses no other copy's marks (B held while C completes)", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const s = await threeSenders(env);
  assert.equal((await s.send("DevOne")).status, 201);
  const held = heldAt(env, HELD_WRITE);
  const devTwo = s.send("DevTwo", s.right, held.env, 10);
  await Promise.race([held.arrived, devTwo]);
  assert.equal((await s.send("UserOne", s.right, env, 20)).status, 201);
  held.release();
  assert.equal((await devTwo).status, 201);
  await assertSettled(env, sqlite);
});

test("copies of one run: a copy held between its read and its write loses no other copy's marks (C held while B completes)", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const s = await threeSenders(env);
  assert.equal((await s.send("DevOne")).status, 201);
  const held = heldAt(env, HELD_WRITE);
  const userOne = s.send("UserOne", s.right, held.env, 20);
  await Promise.race([held.arrived, userOne]);
  assert.equal((await s.send("DevTwo", s.right, env, 10)).status, 201);
  held.release();
  assert.equal((await userOne).status, 201);
  await assertSettled(env, sqlite);
});

test("copies of one run: two copies both held after their reads, released one after the other, lose nothing", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const s = await threeSenders(env);
  assert.equal((await s.send("DevOne")).status, 201);
  const first = heldAt(env, HELD_WRITE);
  const second = heldAt(env, HELD_WRITE);
  const devTwo = s.send("DevTwo", s.right, first.env, 10);
  await Promise.race([first.arrived, devTwo]);
  const userOne = s.send("UserOne", s.right, second.env, 20);
  await Promise.race([second.arrived, userOne]);
  first.release();
  assert.equal((await devTwo).status, 201);
  second.release();
  assert.equal((await userOne).status, 201);
  await assertSettled(env, sqlite);
});

test("copies of one run: three copies sent at once (Promise.all) are all marked and linked", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const s = await threeSenders(env);
  const sent = await Promise.all([s.send("DevOne"), s.send("DevTwo", s.right, env, 10), s.send("UserOne", s.right, env, 20)]);
  assert.deepEqual(sent.map((r) => r.status), [201, 201, 201]);
  await assertSettled(env, sqlite);
});

test("copies of one run: a copy whose Battle Data cards are shifted against its names (three senders)", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const s = await threeSenders(env);
  // DevOne's app put each card one row up from DevTwo on: DevTwo carries UserOne's card, UserOne Rook's, Rook none
  assert.equal((await s.send("DevOne", [["DevOne", 0], ["DevTwo", 2], ["UserOne", 3], ["Rook", null]])).status, 201);
  assert.equal((await s.send("DevTwo", s.right, env, 10)).status, 201);
  assert.equal((await s.send("UserOne", s.right, env, 20)).status, 201);
  await sendersOnce(env, Object.keys(SENDERS));
});

test("copies of one run: a copy whose Battle Data cards are shifted against its names (two senders, two team-mates)", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const s = await threeSenders(env);
  // Kaela and Rook have no app; DevOne's copy put UserOne's card on Kaela's row and Rook's on UserOne's
  assert.equal((await s.send("DevOne", [["DevOne", 0], ["Kaela", 2], ["UserOne", 3], ["Rook", null]])).status, 201);
  assert.equal((await s.send("UserOne", [["DevOne", 0], ["Kaela", 1], ["UserOne", 2], ["Rook", 3]], env, 20)).status, 201);
  await sendersOnce(env, ["DevOne", "UserOne"]);
});

// settledRun on its own: copies as corroborateRun hands them over
const seat = (name, more = {}) => ({ name, ai: false, skel: name ? name.toLowerCase() : undefined, uid: null, ...more });
const copyOf = (id, gameUid, ownName, players, more = {}) => ({ id, gameUid, ownName, version: "aLogs-0.1.37+rc.30", at: 1000, players, lineup: null, ...more });
const asObject = (map) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)));
const feedBack = (copies, map) => copies.map((copy) => ({ ...copy, players: map.get(copy.id) }));
function threeCopies() {
  const card = (n) => copyCard(n);
  return [
    copyOf("aa", "900000000001", "Ashby", [seat("Ashby", { self: true, ...card(0) }), seat("Brenna", card(1)), seat("Corwin", card(2)), seat("Dorrit")]),
    copyOf("bb", "900000000002", "Brenna", [seat("Ashby", card(0)), seat("Brenna", { self: true, ...card(1) }), seat("Corwin", card(2)), seat("Dorrit", card(3))]),
    copyOf("cc", "900000000003", "Corwin", [seat("Ashbee", card(0)), seat("Brenna"), seat("Corwin", { self: true }), seat("Dorrat")], { version: "aLogs-0.1.36" }),
  ];
}

test("settledRun: every order of three copies gives the same answer, and its answer fed back in gives it again", () => {
  const copies = threeCopies();
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const answers = orders.map((order) => JSON.stringify(asObject(settledRun(order.map((i) => copies[i])))));
  assert.equal(new Set(answers).size, 1);
  const first = settledRun(copies);
  assert.deepEqual(asObject(settledRun(feedBack(copies, first))), asObject(first));
  assert.deepEqual(asObject(settledRun(feedBack(copies, settledRun(feedBack(copies, first))))), asObject(first));
  // what it settled: Ashby's misread in cc carries his card, so it is Ashby; each sender's slot is confirmed in the others
  const cc = first.get("cc");
  assert.deepEqual([cc[0].name, cc[0].uid, cc[0].confirmed, cc[0].read], ["Ashby", "900000000001", true, { name: "Ashbee" }]);
  assert.deepEqual(first.get("aa").map((p) => p.uid ?? null), [null, "900000000002", "900000000003", null]);
  // Corwin's card is on no copy of his own: two copies agree on the name, so that slot is his
  assert.deepEqual([first.get("bb")[2].uid, first.get("bb")[2].confirmed], ["900000000003", true]);
  // Dorrit: two copies read Dorrit; Dorrat (one copy, no card, no Party screen) is settled by nothing
  assert.deepEqual([cc[3].name, cc[3].unsettled, first.get("aa")[3].unsettled], ["Dorrat", true, undefined]);
  // the input is not changed
  assert.equal(copies[2].players[0].name, "Ashbee");
});

test("settledRun: two copies agree against a third; a sender's own name wins over what the others read", () => {
  const out = settledRun([
    copyOf("aa", "900000000001", "Ashby", [seat("Ashby", { self: true }), seat("Pellam", copyCard(4))]),
    copyOf("bb", "900000000002", "Brenna", [seat("Brenna", { self: true }), seat("Pellam", copyCard(4)), seat("Ashbee")]),
    copyOf("cc", "900000000003", "Corwin", [seat("Corwin", { self: true }), seat("Pellum", copyCard(4)), seat("Ashbee")]),
  ]);
  // one card: Pellum (one copy) against Pellam (two): Pellam, the read kept
  assert.deepEqual([out.get("cc")[1].name, out.get("cc")[1].read], ["Pellam", { name: "Pellum" }]);
  // two copies read Ashbee, but no card ties that slot to Ashby and his names are Ashby: Ashbee stays a name of its own
  assert.deepEqual(out.get("bb")[2].name, "Ashbee");
  // with Ashby's card on the slot, his own name wins over both reads
  const card = copyCard(7);
  const carded = settledRun([
    copyOf("aa", "900000000001", "Ashby", [seat("Ashby", { self: true, ...card })]),
    copyOf("bb", "900000000002", "Brenna", [seat("Brenna", { self: true }), seat("Xq7", { ai: true, ...card })]),
  ]);
  assert.deepEqual(carded.get("bb")[1], { ...seat("Ashby", { ...card }), uid: "900000000001", confirmed: true, skel: "ashby", read: { name: "Xq7", ai: true } });
});

test("settledRun: one copy - a result name not on its full Party screen takes the Party name by elimination; two left over are unsettled", () => {
  const lineup = [{ slot: 1, name: "DevOne", self: true }, { slot: 2, name: "Kaela" }, { slot: 3, name: "Rook" }];
  const one = settledRun([copyOf("aa", "301000000001", "DevOne", [seat("DevOne", { self: true }), seat("Xq7"), seat("Rook")], { lineup })]).get("aa");
  assert.deepEqual(one.map((p) => [p.name, p.read?.name ?? null, Boolean(p.unsettled)]), [["DevOne", null, false], ["Kaela", "Xq7", false], ["Rook", null, false]]);
  const two = settledRun([copyOf("aa", "301000000001", "DevOne", [seat("DevOne", { self: true }), seat("Xq7"), seat("Zz9")], { lineup })]).get("aa");
  assert.deepEqual(two.map((p) => [p.name, Boolean(p.unsettled)]), [["DevOne", false], ["Xq7", true], ["Zz9", true]]);
  // a copy without a Party screen, and one whose Party screen has fewer names than its result screen: as read
  for (const short of [null, [{ slot: 1, name: "DevOne", self: true }]]) {
    const players = [seat("DevOne", { self: true }), seat("Xq7"), seat("Zz9")];
    assert.deepEqual(settledRun([copyOf("aa", "301000000001", "DevOne", players, { lineup: short })]).get("aa"), players);
  }
});

test("settledRun: a sender's own slot outvoted by two other copies is placed by name (their own copy's cards shifted)", () => {
  const c = (n) => copyCard(n);
  const out = settledRun([
    // Ashby's app put Dorrit's card on Ashby's row and Ashby's on Dorrit's
    copyOf("aa", "900000000001", "Ashby", [seat("Ashby", { self: true, ...c(3) }), seat("Brenna", c(1)), seat("Corwin", c(2)), seat("Dorrit", c(0))]),
    copyOf("bb", "900000000002", "Brenna", [seat("Ashby", c(0)), seat("Brenna", { self: true, ...c(1) }), seat("Corwin", c(2)), seat("Dorrit", c(3))]),
    copyOf("cc", "900000000003", "Corwin", [seat("Ashby", c(0)), seat("Brenna", c(1)), seat("Corwin", { self: true, ...c(2) }), seat("Dorrit", c(3))]),
  ]);
  for (const id of ["bb", "cc"]) {
    const players = out.get(id);
    assert.deepEqual([players[0].name, players[0].uid, players[0].confirmed], ["Ashby", "900000000001", true], id);
    assert.deepEqual([players[3].name, players[3].uid ?? null, players[3].read], ["Dorrit", null, undefined], id);
  }
  // in Ashby's own copy nothing is called Ashby but his own slot
  assert.deepEqual(out.get("aa").filter((p) => p.name === "Ashby" && !p.unsettled).length, 1);
});

test("settledRun: two copies that misread a sender's name the same way on the sender's card don't outvote them", () => {
  const c = (n) => copyCard(n);
  const out = settledRun([
    copyOf("aa", "900000000001", "Ashby", [seat("Ashby", { self: true, ...c(0) }), seat("Brenna", c(1)), seat("Corwin", c(2))]),
    copyOf("bb", "900000000002", "Brenna", [seat("Ashbee", c(0)), seat("Brenna", { self: true, ...c(1) }), seat("Corwin", c(2))]),
    copyOf("cc", "900000000003", "Corwin", [seat("Ashbee", c(0)), seat("Brenna", c(1)), seat("Corwin", { self: true, ...c(2) })]),
  ]);
  for (const id of ["bb", "cc"]) {
    const slot = out.get(id)[0];
    assert.deepEqual([slot.name, slot.uid, slot.confirmed, slot.read], ["Ashby", "900000000001", true, { name: "Ashbee" }], id);
  }
  assert.equal([...out.values()].flat().some((p) => p.unsettled), false);
});

test("settledRun: two senders' own slots on one card: the card is neither's, both are placed by name", () => {
  const shared = copyCard(1);
  const out = settledRun([
    copyOf("aa", "900000000001", "Ashby", [seat("Ashby", { self: true, ...shared }), seat("Brenna", copyCard(2))]),
    copyOf("bb", "900000000002", "Brenna", [seat("Ashby", copyCard(3)), seat("Brenna", { self: true, ...shared })]),
  ]);
  assert.deepEqual([out.get("aa")[1].name, out.get("aa")[1].uid], ["Brenna", "900000000002"]);
  assert.deepEqual([out.get("bb")[0].name, out.get("bb")[0].uid], ["Ashby", "900000000001"]);
  assert.equal(JSON.stringify([...out.values()]).includes("read"), false);
});

// two senders' copies through the API; players: [name, { more }] per slot
async function twoCopies(env, devPlayers, userPlayers, { devExtra, userExtra, numbers = {} } = {}) {
  const dev = await namedToken(env, SESSIONS.dev);
  const user = await namedToken(env, SESSIONS.user);
  const at = Math.floor(Date.now() / 1000) - 60;
  const body = (id, gameUid, me, players, extra, offset) => run(id, { gameUid, score: 21000, stars: 21, clearTimeS: 170, playedAt: at + offset, ...numbers,
    players: players.map(([name, more = {}]) => ({ name, ai: false, ...(name === me ? { self: true } : {}), ...more })), ...(extra ? { extra } : {}) });
  assert.equal((await sendRun(env, dev, body("copy-DevOne", "301000000001", "DevOne", devPlayers, devExtra, 0))).status, 201);
  assert.equal((await sendRun(env, user, body("copy-UserOne", "301000000003", "UserOne", userPlayers, userExtra, 10))).status, 201);
}

test("copies of one run: a misread on one copy takes its Party screen's name, and both copies credit one player", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const lineup = [{ slot: 1, name: "UserOne", self: true }, { slot: 2, name: "DevOne" }, { slot: 3, name: "Dorrit" }];
  await twoCopies(env, [["DevOne"], ["UserOne"], ["Dorrit"]], [["UserOne"], ["DevOne"], ["Xq7"]], { userExtra: { lineup } });
  const userCopy = storedCopies(sqlite).find((row) => row.id === "copy-UserOne").players;
  assert.deepEqual([userCopy[2].name, userCopy[2].read], ["Dorrit", { name: "Xq7" }]);
  const boss = await sendersOnce(env, ["DevOne", "UserOne"]);
  assert.deepEqual(boss.entries.map((e) => e.player).sort(), ["DevOne", "Dorrit", "UserOne"]);
});

test("copies of one run: a name only one copy read, on no Party screen, is unsettled: on no board, still in the stored slot", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await twoCopies(env, [["DevOne"], ["UserOne"], ["Pellam"]], [["UserOne"], ["DevOne"]]);
  const devCopy = storedCopies(sqlite).find((row) => row.id === "copy-DevOne").players;
  assert.deepEqual([devCopy[2].name, devCopy[2].unsettled], ["Pellam", true]);
  const boss = await sendersOnce(env, ["DevOne", "UserOne"]);
  assert.deepEqual(boss.entries.map((e) => e.player).sort(), ["DevOne", "UserOne"]);
  const entries = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0&unlinked=1")).json()).entries;
  assert.equal(entries.some((e) => e.player === "Pellam"), false);
});

test("copies of one run: read and unsettled never leave the API (boards, entries, history)", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const lineup = [{ slot: 1, name: "UserOne", self: true }, { slot: 2, name: "DevOne" }, { slot: 3, name: "Dorrit" }, { slot: 4, name: "Mario", ai: true }];
  await twoCopies(env, [["DevOne"], ["UserOne"], ["Dorrit"], ["Pellam"]], [["UserOne"], ["DevOne"], ["Xq7"], ["Mario", { ai: true }]], { userExtra: { lineup } });
  const stored = JSON.stringify(storedCopies(sqlite));
  assert.ok(stored.includes("\"read\"") && stored.includes("\"unsettled\""));      // there is something to leak
  const answers = [
    await call(env, "/api/leaderboard/interlink?cycle=3005&unlinked=1"),
    await call(env, "/api/leaderboard/interlink?cycle=3005&unlinked=1&ladder=score&rows=teams"),
    await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0&unlinked=1"),
    await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0", { session: SESSIONS.dev }),
    await call(env, "/api/profile/history", { session: SESSIONS.dev }),
    await call(env, "/api/profile/history", { session: SESSIONS.user }),
  ];
  for (const response of answers) {
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes("\"read\"") || text.includes("\"unsettled\""), false, text.slice(0, 200));
  }
});

test("same run: equal score, stars and time with cards on both copies and none shared are two fights; without cards, one run", async () => {
  const carded = await setup({ LEADERBOARD_PUBLIC: "true" });
  await twoCopies(carded.env, [["DevOne", copyCard(1)], ["Kestrel", copyCard(2)]], [["UserOne", copyCard(5)], ["Lumen", copyCard(6)]]);
  assert.deepEqual(storedCopies(carded.sqlite).map((row) => row.extra.sharedRun ?? null), [null, null]);
  const plain = await setup({ LEADERBOARD_PUBLIC: "true" });
  await twoCopies(plain.env, [["DevOne"], ["UserOne"]], [["UserOne"], ["DevOne"]]);
  const linked = storedCopies(plain.sqlite).map((row) => row.extra.sharedRun);
  assert.ok(linked[0] && linked[0] === linked[1]);
});

test("copies of one run: a re-sent copy (players replaced, link dropped) gets its marks again and the others stay right", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const s = await threeSenders(env);
  for (const [me, offset] of [["DevOne", 0], ["DevTwo", 10], ["UserOne", 20]]) assert.equal((await s.send(me, s.right, env, offset)).status, 201);
  await assertSettled(env, sqlite);
  const before = storedCopies(sqlite).filter((row) => row.id !== "copy-DevTwo");
  const again = await s.send("DevTwo", s.right, env, 10);
  assert.equal(again.status, 200);
  await assertSettled(env, sqlite);
  assert.deepEqual(storedCopies(sqlite).filter((row) => row.id !== "copy-DevTwo"), before);
});

test("POST /api/admin/run-names: administrators only, a dry run by default, apply settles stored runs, and a second apply finds nothing", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev });
  const s = await threeSenders(env);
  for (const [me, offset] of [["DevOne", 0], ["DevTwo", 10], ["UserOne", 20]]) assert.equal((await s.send(me, s.right, env, offset)).status, 201);
  // stored the way they were before: no marks, no link (copies that overwrote each other)
  for (const row of storedCopies(sqlite)) {
    const players = row.players.map(({ confirmed: _c, read: _r, unsettled: _u, ...player }) => ({ ...player, uid: null }));
    sqlite.prepare("UPDATE leaderboard_submissions SET players_json = ?, extra_json = json_remove(extra_json, '$.sharedRun') WHERE client_run_id = ?").run(JSON.stringify(players), row.id);
  }
  const snapshot = () => JSON.stringify(sqlite.prepare("SELECT submission_id, players_json, extra_json FROM leaderboard_submissions ORDER BY submission_id").all());
  const before = snapshot();
  const names = (body, session = SESSIONS.dev) => call(env, "/api/admin/run-names", { session, method: "POST", body });
  assert.equal((await names({}, SESSIONS.user)).status, 403);
  const dry = await (await names({})).json();
  assert.deepEqual([dry.dryRun, dry.rows, dry.groups, dry.copies, dry.changed, dry.linked, dry.confirmed, dry.next], [true, 3, 1, 3, 3, 3, 6, null]);
  assert.equal(snapshot(), before);
  const text = JSON.stringify(dry);
  for (const secret of ["DevOne", "Rook", "301000000", "copy-"]) assert.equal(text.includes(secret), false);
  // a page at a time
  const page = await (await names({ max: 1 })).json();
  assert.deepEqual([page.rows, page.groups, typeof page.next], [1, 1, "string"]);
  assert.deepEqual((await (await names({ max: 5, after: page.next })).json()).rows, 2);
  const applied = await (await names({ apply: true })).json();
  assert.deepEqual([applied.dryRun, applied.changed, applied.linked, applied.confirmed], [false, 3, 3, 6]);
  await assertSettled(env, sqlite);
  const twice = await (await names({ apply: true })).json();
  assert.deepEqual([twice.changed, twice.linked, twice.renamed, twice.confirmed, twice.uidsRemoved, twice.unsettled, twice.settled], [0, 0, 0, 0, 0, 0, 0]);
});

// two senders' copies of one run (DevOne, UserOne), each with its own played time as the app sent it
async function copiesPlayedAt(env, devPlayedAt, userPlayedAt, { cards = true } = {}) {
  const dev = await namedToken(env, SESSIONS.dev);
  const user = await namedToken(env, SESSIONS.user);
  const players = (me) => [["DevOne", 0], ["UserOne", 1], ["Rook", 2]].map(([name, n]) => ({ name, ai: false, ...(name === me ? { self: true } : {}),
    ...(cards ? copyCard(n) : {}) }));
  const body = (id, gameUid, me, playedAt) => run(id, { gameUid, score: 21000, stars: 21, clearTimeS: 170, playedAt, players: players(me) });
  return {
    dev: () => sendRun(env, dev, body("copy-DevOne", "301000000001", "DevOne", devPlayedAt)),
    user: () => sendRun(env, user, body("copy-UserOne", "301000000003", "UserOne", userPlayedAt)),
  };
}
function assertOneRun(sqlite) {
  const rows = storedCopies(sqlite);
  const stored = sqlite.prepare("SELECT MAX(created_at) - MIN(created_at) AS gap FROM leaderboard_submissions WHERE kind = 'interlink_run'").get();
  assert.ok(stored.gap <= 2, "stored within 2 seconds");
  assert.ok(rows[0].extra.sharedRun && rows[0].extra.sharedRun === rows[1].extra.sharedRun, "one run");
  const slot = (id, name) => rows.find((row) => row.id === id).players.find((p) => p.name === name);
  assert.deepEqual([slot("copy-DevOne", "UserOne").uid, slot("copy-DevOne", "UserOne").confirmed], ["301000000003", true]);
  assert.deepEqual([slot("copy-UserOne", "DevOne").uid, slot("copy-UserOne", "DevOne").confirmed], ["301000000001", true]);
}

test("same run by the site's clock: copies stored seconds apart whose played times differ by an hour (a PC clock's time zone) are one run", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const at = Math.floor(Date.now() / 1000) - 60;
  const send = await copiesPlayedAt(env, at, at + 3600);
  assert.equal((await send.dev()).status, 201);
  assert.equal((await send.user()).status, 201);
  assertOneRun(sqlite);
});

test("same run by the site's clock: played times six hours apart the other way round are one run too", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const at = Math.floor(Date.now() / 1000) - 60;
  const send = await copiesPlayedAt(env, at, at - 6 * 3600);
  assert.equal((await send.dev()).status, 201);
  assert.equal((await send.user()).status, 201);
  assertOneRun(sqlite);
});

test("same run by the site's clock: equal score, stars and time stored 20 minutes apart are two runs; nobody vouches", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const at = Math.floor(Date.now() / 1000) - 60;
  const send = await copiesPlayedAt(env, at, at, { cards: false });
  assert.equal((await send.dev()).status, 201);
  sqlite.prepare("UPDATE leaderboard_submissions SET created_at = created_at - 1200 WHERE client_run_id = 'copy-DevOne'").run();
  assert.equal((await send.user()).status, 201);
  const rows = storedCopies(sqlite);
  assert.deepEqual(rows.map((row) => row.extra.sharedRun ?? null), [null, null]);
  assert.equal(rows.some((row) => row.players.some((p) => p.confirmed)), false);
});

// ---------------------------------------------------------------- played times sent by the builds that took local time as UTC
const H = 3600;
const T0 = 1795000000;                       // a run's true start (UTC)
// one Interlink run: played_at as the buggy build stored it (true start + the sender's UTC offset), stored `delay` s later
const timed = (id, sender, offsetH, delay = 200, version = "aLogs-0.1.37+rc.30", t = T0, kind = "interlink_run") => ({ id, sender, kind, version,
  playedAt: t + offsetH * H, createdAt: t + delay, sentPlayedAt: null });

test("played times: the builds that took local time as UTC are 0.1.37 RC26 to RC34; older and fixed builds aren't", () => {
  for (const version of ["aLogs-0.1.37+rc.26", "aLogs-0.1.37+rc.30", "aLogs-0.1.37+rc.32", "0.1.37+rc.34"]) assert.equal(playedAtLocalAsUtc(version), true, version);
  for (const version of ["aLogs-0.1.37+rc.25", "aLogs-0.1.37+rc.35", "aLogs-0.1.37+rc.36", "aLogs-0.1.37", "aLogs-0.1.36+rc.30", "0.1.38+rc.30", "", null]) {
    assert.equal(playedAtLocalAsUtc(version), false, String(version));
  }
});

test("played times: each side of UTC and a half-hour zone get their zone back; a late send follows its sender", () => {
  const rows = [
    // UTC-5: stored 5 h early; one of four went out 3 h 12 min after its start (queued)
    timed("w1", "west", -5), timed("w2", "west", -5, 540, "aLogs-0.1.37+rc.26", T0 + 2 * H), timed("w3", "west", -5, 60, "aLogs-0.1.37+rc.32", T0 + 5 * H),
    timed("w4", "west", -5, 3 * H + 12 * 60, "aLogs-0.1.37+rc.30", T0 + 9 * H),
    // UTC+2: stored 2 h late
    timed("e1", "east", 2), timed("e2", "east", 2, 30, "aLogs-0.1.37+rc.30", T0 + H),
    // UTC+5:30
    timed("i1", "india", 5.5), timed("i2", "india", 5.5, 400),
  ];
  const { shifts, senders, rows: counts } = playedAtShifts(rows);
  assert.deepEqual(Object.fromEntries(shifts), { w1: 5 * H, w2: 5 * H, w3: 5 * H, w4: 5 * H, e1: -2 * H, e2: -2 * H, i1: -5.5 * H, i2: -5.5 * H });
  const zoneOf = { w: -5, e: 2, i: 5.5 };
  for (const row of rows) assert.equal(row.playedAt + shifts.get(row.id), row.playedAt - zoneOf[row.id[0]] * H, `${row.id}: its true start`);
  assert.deepEqual([senders.total, senders.shifted, counts.change], [3, 3, 8]);
});

test("played times: only Interlink runs vote and move; the same builds' other records were on the real clock", () => {
  // UTC+2: three Egg Heist and Sim records sent at once (zone 0) must not outvote the two Interlink runs
  const other = (id, kind) => timed(id, "east", 0, 20, "aLogs-0.1.37+rc.30", T0, kind);
  const rows = [timed("r1", "east", 2), timed("r2", "east", 2, 100), other("g1", "eggheist_match"), other("g2", "eggheist_season"), other("s1", "sim_run"),
    other("b1", "interlink_best"), other("k1", "interlink_week")];
  const { shifts, rows: counts } = playedAtShifts(rows);
  assert.deepEqual(Object.fromEntries(shifts), { r1: -2 * H, r2: -2 * H });
  assert.equal(counts.affected, 2);
});

test("played times: a sender with nothing to go on, a split vote, too few agreeing or a zero zone is left alone; old and fixed builds never move", () => {
  const rows = [
    timed("d1", "doubtful", -6, 2 * H + 43 * 60),                                             // one run, stored 2 h 43 min after its start
    timed("s1", "split", -5), timed("s2", "split", -6),                                       // one run each of two zones
    timed("f1", "few", -5), timed("f2", "few", -5, 57 * 60, "aLogs-0.1.37+rc.30", T0 + H), timed("f3", "few", -5, 87 * 60, "aLogs-0.1.37+rc.30", T0 + 2 * H),
    timed("u1", "utc", 0), timed("u2", "utc", 0, 300),
    timed("far", "far", -15),                                                                 // no zone is 15 h off
    timed("old", "west", -5, 40, "aLogs-0.1.37+rc.25"), timed("new", "west", -5, 40, "aLogs-0.1.37+rc.35"), timed("py", "west", -5, 40, "aLogs-0.1.36"),
  ];
  const { shifts, senders, rows: counts } = playedAtShifts(rows);
  assert.equal(shifts.size, 0);
  assert.deepEqual(senders.left, { noNormalSend: 1, noAgreement: 1, tooFew: 1, over14h: 1 });
  assert.deepEqual([senders.total, senders.zero, counts.zero, counts.affected], [5, 1, 2, 9]);
});

test("played times: a shift that would put the run after it was stored is skipped", () => {
  // the vote says +5 h, but this run was stored before its own correction would land (a PC clock that moved)
  const rows = [timed("a", "west", -5), timed("b", "west", -5), timed("c", "west", -5), { ...timed("x", "west", -5), createdAt: T0 - 3 * H }];
  const { shifts, rows: counts } = playedAtShifts(rows);
  assert.deepEqual([shifts.size, shifts.has("x"), counts.laterThanSent], [3, false, 1]);
});

// the stored played time and the kept sent value of one record
const playedRow = (sqlite, id) => ({ ...sqlite.prepare("SELECT played_at AS playedAt, played_at_sent AS sent, created_at AS createdAt FROM leaderboard_submissions WHERE client_run_id = ?").get(id) });

test("played times on arrival: an affected Interlink run takes its sender's known zone, late or not; no history, other builds and other kinds as sent", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const tokens = { west: await namedToken(env, SESSIONS.dev), east: await namedToken(env, SESSIONS.dev2), fresh: await namedToken(env, SESSIONS.user) };
  const now = Math.floor(Date.now() / 1000);
  const send = (who, id, playedAt, clientVersion = "aLogs-0.1.37+rc.30", more = {}) => sendRun(env, tokens[who], run(id, { playedAt, clientVersion, ...more }));
  // history: two runs each already corrected (by the route), west of UTC by +5 h, east of UTC by -2 h
  for (const [who, shift] of [["west", 5 * H], ["east", -2 * H]]) {
    for (const n of [1, 2]) {
      const sent = now - n * 86400;
      assert.equal((await send(who, `hist-${who}-${n}`, sent)).status, 201);
      sqlite.prepare("UPDATE leaderboard_submissions SET played_at = ?, played_at_sent = ? WHERE client_run_id = ?").run(sent + shift, sent, `hist-${who}-${n}`);
    }
  }
  const normal = now - 150;                       // a run that started 2.5 min ago
  const late = now - 3 * H - 12 * 60;             // queued: sent 3 h 12 min after its start
  const cases = [
    ["west", "w-normal", normal, -5, true], ["west", "w-late", late, -5, true],
    ["east", "e-normal", normal, 2, true], ["east", "e-late", late, 2, true],
    ["fresh", "f-normal", normal, -5, false], ["fresh", "f-late", late, -5, false],
    ["fresh", "utc-late", late, 0, false],         // a PC on UTC, sent late: its own numbers would have said 3 h
  ];
  for (const [who, id, start, zone, corrected] of cases) {
    assert.equal((await send(who, id, start + zone * H)).status, 201, id);
    const row = playedRow(sqlite, id);
    assert.deepEqual([row.playedAt, row.sent], corrected ? [start, start + zone * H] : [start + zone * H, null], id);
  }
  // a re-send (Battle Data following) of a corrected run: the same correction, judged against its first arrival
  sqlite.prepare("UPDATE leaderboard_submissions SET created_at = created_at - 30 WHERE client_run_id = 'w-normal'").run();
  assert.equal((await send("west", "w-normal", normal - 5 * H, "aLogs-0.1.37+rc.30", { score: 20500 })).status, 200);
  assert.deepEqual([playedRow(sqlite, "w-normal").playedAt, playedRow(sqlite, "w-normal").sent], [normal, normal - 5 * H]);
  // a fixed build, an old Python build and another kind of an affected build, from a sender with a known zone: as sent
  for (const [id, clientVersion] of [["fixed", "aLogs-0.1.37+rc.35"], ["python", "aLogs-0.1.36"]]) {
    assert.equal((await send("west", id, normal, clientVersion)).status, 201);
    assert.deepEqual([playedRow(sqlite, id).playedAt, playedRow(sqlite, id).sent], [normal, null], id);
  }
  assert.equal((await sendRun(env, tokens.west, { kind: "sim_run", clientRunId: "sim", trial: "Training of Water", difficulty: "Hard", cleared: true, clearTimeS: 400,
    playedAt: normal, clientVersion: "aLogs-0.1.37+rc.30" })).status, 201);
  assert.deepEqual([playedRow(sqlite, "sim").playedAt, playedRow(sqlite, "sim").sent], [normal, null]);
});

test("POST /api/admin/played-times: administrators only, a dry run by default, apply keeps the value it replaced, a second run changes nothing", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev });
  const tokens = { west: await namedToken(env, SESSIONS.dev), east: await namedToken(env, SESSIONS.dev2), india: await namedToken(env, SESSIONS.user) };
  const t = Math.floor(Date.now() / 1000) - 10 * H;
  // id, sender, zone (h), delay (s), build, kind
  const records = [
    ["w-run", "west", -5, 200, "aLogs-0.1.37+rc.30", "interlink_run"], ["w-sim", "west", -5, 60, "aLogs-0.1.37+rc.30", "sim_run"],
    ["w-late", "west", -5, 3 * H + 12 * 60, "aLogs-0.1.37+rc.32", "interlink_run"], ["w-run2", "west", -5, 240, "aLogs-0.1.37+rc.26", "interlink_run"],
    ["e-run", "east", 2, 230, "aLogs-0.1.37+rc.28", "interlink_run"], ["e-run2", "east", 2, 250, "aLogs-0.1.37+rc.31", "interlink_run"],
    ["i-run", "india", 5.5, 245, "aLogs-0.1.37+rc.32", "interlink_run"],
    ["i-old", "india", 5.5, 245, "aLogs-0.1.37+rc.25", "interlink_run"], ["i-fixed", "india", 0, 245, "aLogs-0.1.37+rc.36", "interlink_run"],
  ];
  for (const [index, [id, sender, zone, delay, clientVersion, kind]] of records.entries()) {
    const at = t + index * 600;
    const body = kind === "sim_run"
      ? { kind, clientRunId: id, trial: "Training of Water", difficulty: "Hard", cleared: true, clearTimeS: 400, playedAt: at + zone * H, clientVersion }
      : run(id, { score: 10000 + index, playedAt: at + zone * H, clientVersion });
    assert.equal((await sendRun(env, tokens[sender], body)).status, 201, id);
    // stored as the builds stored them before the site corrected anything
    sqlite.prepare("UPDATE leaderboard_submissions SET created_at = ?, played_at = ?, played_at_sent = NULL WHERE client_run_id = ?").run(at + delay, at + zone * H, id);
  }
  const stored = () => Object.fromEntries(sqlite.prepare("SELECT client_run_id AS id, played_at AS playedAt, played_at_sent AS sent, created_at AS createdAt FROM leaderboard_submissions").all()
    .map((row) => [row.id, { ...row }]));
  const before = stored();
  const times = (body, session = SESSIONS.dev) => call(env, "/api/admin/played-times", { session, method: "POST", body });
  assert.equal((await times({}, SESSIONS.user)).status, 403);
  assert.equal((await times({}, SESSIONS.dev2)).status, 403);                     // a developer isn't an administrator
  const dry = await (await times({})).json();
  assert.equal(dry.dryRun, true);
  assert.deepEqual(stored(), before, "a dry run writes nothing");
  assert.deepEqual(dry.versions.filter((row) => row.affected).map((row) => [row.version, row.rows, row.interlinkRuns]),
    [["aLogs-0.1.37+rc.26", 1, 1], ["aLogs-0.1.37+rc.28", 1, 1], ["aLogs-0.1.37+rc.30", 2, 1], ["aLogs-0.1.37+rc.31", 1, 1], ["aLogs-0.1.37+rc.32", 2, 2]]);
  assert.deepEqual(dry.versions.filter((row) => !row.affected).map((row) => row.version), ["aLogs-0.1.37+rc.25", "aLogs-0.1.37+rc.36"]);
  assert.deepEqual([dry.rows.affected, dry.rows.change], [6, 6]);
  assert.deepEqual(dry.shiftsByHours, { "+5": 3, "-2": 2, "-5.5": 1 });
  assert.deepEqual([dry.senders.total, dry.senders.shifted], [3, 3]);
  const text = JSON.stringify(dry);
  for (const secret of ["DevOne", "301000000", "w-run", IDS.dev]) assert.equal(text.includes(secret), false);
  const applied = await (await times({ apply: true })).json();
  assert.deepEqual([applied.dryRun, applied.changed], [false, 6]);
  const after = stored();
  for (const [index, [id, , zone]] of records.entries()) {
    const at = t + index * 600;
    if (["i-old", "i-fixed", "w-sim"].includes(id)) { assert.deepEqual(after[id], before[id], `${id} untouched`); continue; }
    assert.equal(after[id].playedAt, at, `${id}: its true start`);
    assert.equal(after[id].sent, at + zone * H, `${id}: the value it replaced, kept`);
    assert.ok(after[id].playedAt <= after[id].createdAt);
  }
  const twice = await (await times({ apply: true })).json();
  assert.deepEqual([twice.changed, twice.rows.change, twice.rows.alreadyCorrected], [0, 0, 6]);
  assert.deepEqual(stored(), after);
});

// ---------------------------------------------------------------- run checks decide by themselves (21 Nov)
const shot = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" });
function sendWithScreens(env, token, body, parts = ["evidence", "evidence_full", "battle", "battle_full"]) {
  const form = new FormData();
  form.set("submission", JSON.stringify(body));
  for (const part of parts) form.set(part, shot(), `${part}.jpg`);
  return call(env, "/api/leaderboard/submissions", { token, method: "POST", form });
}
const stateOf = (sqlite, id) => {
  const row = sqlite.prepare("SELECT verify_state AS state, verify_json AS json FROM leaderboard_submissions WHERE client_run_id = ?").get(id);
  return { state: row.state, check: JSON.parse(row.json || "{}") };
};
const idOf = (sqlite, id) => sqlite.prepare("SELECT submission_id AS id FROM leaderboard_submissions WHERE client_run_id = ?").get(id).id;
const CARDS = [{ name: "UserOne", avgDps: 20000, breakValue: 300, damageTaken: 900, heal: 10 }, { name: "DevTwo", avgDps: 19000, breakValue: 200, damageTaken: 800, heal: 0 }];

test("run checks: two players' copies that agree verify each other with no reading", async () => {
  const { env, sqlite } = await setup({ EVIDENCE: evidenceStore(), LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev });
  const one = await namedToken(env, SESSIONS.user);
  const two = await namedToken(env, SESSIONS.dev2);
  assert.equal((await sendWithScreens(env, one, run("c1", { gameUid: "301000000003", players: CARDS, teamDps: 39000 }))).status, 201);
  // alone, with no AI binding: no tick and no mark
  assert.equal(stateOf(sqlite, "c1").state, null);
  assert.equal((await sendWithScreens(env, two, run("c2", { gameUid: "301000000002", players: CARDS, teamDps: 39000 }))).status, 201);
  for (const id of ["c1", "c2"]) {
    const { state, check } = stateOf(sqlite, id);
    assert.deepEqual([state, check.verifiedBy, check.copies], ["match", "copies", { senders: 2, agreeing: 2 }]);
  }
  const entries = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json()).entries;
  assert.ok(entries.length && entries.every((entry) => entry.check === "verified"));
  assert.equal((await (await call(env, "/api/admin/run-checks/staff", { session: SESSIONS.dev })).json()).count, 0);
});

test("run checks: copies that contradict go to staff only when the copy's own picture sides against it", async () => {
  // the result screen always reads 20000 / 20 stars: the copy that sent 20,900 is contradicted by its own picture
  const AI = { async run(model, input) {
    return { response: String(input.prompt || "").includes("Battle Data") ? '{"cards": []}' : '{"score": 20000, "stars": 20, "time": "3:00"}' };
  } };
  const { env, sqlite } = await setup({ EVIDENCE: evidenceStore(), AI, LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev, VERIFY_TOP_RANK: "0" });
  const one = await namedToken(env, SESSIONS.user);
  const two = await namedToken(env, SESSIONS.dev2);
  // two Battle Data cards in common: one fight, whatever the scores say
  await sendWithScreens(env, one, run("k1", { gameUid: "301000000003", players: CARDS, teamDps: 39000 }));
  await sendWithScreens(env, two, run("k2", { gameUid: "301000000002", players: CARDS, teamDps: 39000, score: 20900 }));
  const wrong = stateOf(sqlite, "k2");
  assert.equal(wrong.state, "mismatch");
  assert.equal(wrong.check.staff[0].why, "copies contradict");
  assert.equal(stateOf(sqlite, "k1").state, "match");                 // its own picture agrees with it
  const staff = await (await call(env, "/api/admin/run-checks/staff", { session: SESSIONS.dev })).json();
  assert.deepEqual(staff.runs.map((r) => [r.score, r.copies]), [[20900, 2]]);
  assert.match(staff.runs[0].reasons[0], /Another player's copy/u);
  // the staff-listed copy shows no mark in public
  const entries = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json()).entries;
  assert.equal(JSON.stringify(entries).includes("pending"), false);
});

test("run checks: re-checking stored runs moves old misread flags off the staff list and leaves staff decisions alone", async () => {
  const { env, sqlite } = await setup({ EVIDENCE: evidenceStore(), LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev, VERIFY_TOP_RANK: "0" });
  const token = await namedToken(env, SESSIONS.user);
  for (const [id, score] of [["decided", 20000], ["old-stars", 19000], ["old-meter", 18000]]) {
    assert.equal((await sendWithScreens(env, token, run(id, { score, stars: score / 1000 }), ["evidence"])).status, 201);
  }
  // as stored before 21 Nov: the meter rule and stars-against-score made a run "mismatch"
  const old = (rule) => JSON.stringify({ rules: { flags: [{ rule, sent: 1, expected: 2 }] } });
  sqlite.prepare("UPDATE leaderboard_submissions SET verify_state = 'mismatch', verify_json = ? WHERE client_run_id = 'old-meter'").run(old("Avg DPS add up to the meter's DPS"));
  sqlite.prepare("UPDATE leaderboard_submissions SET verify_state = 'mismatch', verify_json = ? WHERE client_run_id = 'old-stars'").run(old("stars track score"));
  sqlite.prepare("UPDATE leaderboard_submissions SET verify_state = 'confirmed', verify_json = ? WHERE client_run_id = 'decided'")
    .run(JSON.stringify({ rules: { flags: [] }, review: { by: IDS.dev, decision: "confirmed", at: 1 } }));
  const columns = () => sqlite.prepare("SELECT client_run_id, score, stars, status, players_json, extra_json FROM leaderboard_submissions ORDER BY client_run_id").all();
  const beforeColumns = columns();
  assert.equal((await (await call(env, "/api/admin/run-checks/staff?count=1", { session: SESSIONS.dev })).json()).count, 2);
  const recheck = (body, session = SESSIONS.dev) => call(env, "/api/admin/run-checks/recheck", { session, method: "POST", body });
  assert.equal((await recheck({}, SESSIONS.user)).status, 403);
  const dry = await (await recheck({})).json();
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.outcomes, { "no badge (nothing to check it by)": 2, "staff decided (left alone)": 1 });
  assert.deepEqual(dry.changes, { "mismatch -> none": 2 });
  assert.equal(stateOf(sqlite, "old-meter").state, "mismatch");            // a dry run writes nothing
  const applied = await (await recheck({ apply: true })).json();
  assert.equal(applied.changed, 2);
  assert.deepEqual(["old-meter", "old-stars", "decided"].map((id) => stateOf(sqlite, id).state), [null, null, "confirmed"]);
  assert.equal(stateOf(sqlite, "decided").check.review.decision, "confirmed");
  assert.deepEqual(stateOf(sqlite, "old-meter").check.rules.flags, []);
  assert.deepEqual(columns(), beforeColumns);                                // only the check's own columns change
  assert.equal((await (await call(env, "/api/admin/run-checks/staff?count=1", { session: SESSIONS.dev })).json()).count, 0);
  // misreads are counted per rule and app build
  sqlite.prepare("UPDATE leaderboard_submissions SET stars = 5, client_version = '0.1.37+rc.36' WHERE client_run_id = 'old-stars'").run();
  const counted = await (await recheck({})).json();
  assert.deepEqual(counted.misread, { "stars track score": { "0.1.37+rc.36": 1 } });
});

test("run checks: an unreadable reading records why, and one run can be read again on request", async () => {
  // the model answers in words when asked the old way, and with the JSON in the chat form
  const AI = { forms: [], async run(model, input) {
    this.forms.push(input.messages ? "messages" : "prompt");
    if (!input.messages) return { response: "I cannot see an image in this request." };
    assert.match(input.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/u);
    return { response: input.messages[0].content[0].text.includes("Battle Data") ? '{"cards": []}' : '{"score": 20000, "stars": 20, "time": "3:00"}' };
  } };
  const { env, sqlite } = await setup({ EVIDENCE: evidenceStore(), AI, LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev });
  const token = await namedToken(env, SESSIONS.user);
  await sendWithScreens(env, token, run("r1"));
  const read = stateOf(sqlite, "r1");
  assert.deepEqual([read.state, read.check.verifiedBy, read.check.reading.via], ["match", "reading", "messages"]);
  assert.deepEqual(AI.forms, ["prompt", "messages", "prompt", "messages"]);
  // nothing usable either way: unreadable, with the reasons
  AI.run = async (model, input) => ({ response: input.messages ? "" : "Sure! The score is high." });
  const id = idOf(sqlite, "r1");
  const again = await call(env, `/api/admin/run-checks/${id}/read`, { session: SESSIONS.dev, method: "POST", body: {} });
  assert.equal(again.status, 200);
  const answer = await again.json();
  assert.equal(answer.state, "unreadable");
  assert.deepEqual(answer.reading.why.result, { why: "no JSON in the answer", answer: "Sure! The score is high.", messages: { why: "the model's answer was empty" } });
  assert.deepEqual(answer.reading.why.battle, { why: "no JSON in the answer", messages: { why: "the model's answer was empty" } });
  // a picture missing from storage says so
  sqlite.prepare("UPDATE leaderboard_submissions SET extra_json = json_set(extra_json, '$.proofFull.evidence', 'evidence/none.jpg') WHERE client_run_id = 'r1'").run();
  const missing = await (await call(env, `/api/admin/run-checks/${id}/read`, { session: SESSIONS.dev, method: "POST", body: {} })).json();
  assert.deepEqual(missing.reading.why.result, { why: "no picture stored under its key" });
  assert.equal((await call(env, `/api/admin/run-checks/${id}/read`, { session: SESSIONS.user, method: "POST", body: {} })).status, 403);
  // inside the day's cap
  env.VERIFY_DAILY_LIMIT = "1";
  assert.equal((await call(env, `/api/admin/run-checks/${id}/read`, { session: SESSIONS.dev, method: "POST", body: {} })).status, 429);
});

// made-up limits (the real ones are secrets)
const EGG_LIMITS = JSON.stringify({ maxLoot: { Normal: 50000 }, minTimeS: { Normal: 60 }, maxDefeats: 30, maxPointsPerMatch: 100, minMatchS: 120 });
const SCREEN_LIMITS = JSON.stringify({ maxOver40: 10, copyFailed: true });
// the public answers, without what differs between two databases by chance (random ids, clocks)
function publicView(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => (/^(id|at|runProof)$|(Id|Ids|At)$/u.test(key) ? undefined : item)));
}
async function reviewOnlyWorld(extraEnv) {
  const { env, sqlite } = await setup({ EVIDENCE: evidenceStore(), LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev, ...extraEnv });
  const token = await namedToken(env, SESSIONS.user);
  const send = (body) => call(env, "/api/leaderboard/submissions", { token, method: "POST", body });
  const now = Math.floor(Date.now() / 1000);
  // a match over every made-up limit, and a normal one
  assert.equal((await send({ kind: "eggheist_match", clientRunId: "egg-big", cycle: "S1", score: 90000, clearTimeS: 30, cleared: true, difficulty: "Normal", defeats: 99, playedAt: now })).status, 201);
  assert.equal((await send({ kind: "eggheist_match", clientRunId: "egg-ok", cycle: "S1", score: 20000, clearTimeS: 224, cleared: true, difficulty: "Normal", defeats: 1, playedAt: now })).status, 201);
  // a standing, then the same standing 400 points higher a moment later (no match can give that)
  const standing = (score) => ({ kind: "eggheist_season", clientRunId: "eggheist-S1", cycle: "S1", rank: { tier: 3, subtier: 2, name: "Pro Egg Snatcher II" }, score, playedAt: now });
  assert.ok([200, 201].includes((await send(standing(1500))).status));
  assert.ok([200, 201].includes((await send(standing(1900))).status));
  // an Interlink run whose result screen came from the screen and differs from the game window
  assert.equal((await sendWithScreens(env, token, run("screen", { extra: { screenCheck: { result: { source: "screen", copy: "ok", worst: 90, over25: 60, over40: 50 } } } }), ["evidence"])).status, 201);
  const answers = async () => publicView({
    matches: await (await call(env, "/api/leaderboard/entries?kind=eggheist_match&best=0")).json(),
    matchBoard: await (await call(env, "/api/leaderboard/entries?kind=eggheist_match")).json(),
    standings: await (await call(env, "/api/leaderboard/entries?kind=eggheist_season")).json(),
    interlink: await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json(),
    runs: await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json(),
    profile: await (await call(env, "/api/profile/overview", { session: SESSIONS.user })).json(),
  });
  return { env, sqlite, answers };
}

test("review-only checks: a flagged Egg Heist or screen-read run is listed for staff, and nothing public changes", async () => {
  const plain = await reviewOnlyWorld({});
  const flagged = await reviewOnlyWorld({ EGG_CHECK_LIMITS: EGG_LIMITS, SCREEN_CHECK_LIMITS: SCREEN_LIMITS });
  const staff = async (world) => (await call(world.env, "/api/admin/run-checks/staff", { session: SESSIONS.dev })).json();
  // without the secrets nothing is checked
  assert.equal((await staff(plain)).count, 0);
  const listed = await staff(flagged);
  assert.equal(listed.count, 3);
  assert.deepEqual(listed.runs.map((r) => r.decides), ["nothing", "nothing", "nothing"]);
  const rules = (id) => stateOf(flagged.sqlite, id).check.reviewOnly.flags.map((flag) => flag.rule);
  assert.deepEqual(rules("egg-big"), ["egg loot", "egg time", "egg defeats"]);
  assert.deepEqual(rules("eggheist-S1"), ["egg points"]);
  assert.deepEqual(rules("screen"), ["screen differs"]);
  assert.equal(stateOf(flagged.sqlite, "egg-ok").check.reviewOnly, undefined);
  // the state the badge reads is untouched
  for (const id of ["egg-big", "eggheist-S1"]) assert.equal(stateOf(flagged.sqlite, id).state, null);
  assert.equal(stateOf(flagged.sqlite, "screen").state, stateOf(plain.sqlite, "screen").state);
  // every public answer is the same with and without the review flags ...
  assert.deepEqual(await flagged.answers(), await plain.answers());
  // ... and after staff decide them (the decision is recorded; nothing else moves)
  for (const item of listed.runs) {
    const decided = await call(flagged.env, `/api/admin/run-checks/${item.submissionId}`, { session: SESSIONS.dev, method: "POST", body: { decision: "rejected" } });
    assert.equal(decided.status, 200);
    assert.equal((await decided.json()).reviewOnly, true);
  }
  assert.equal((await staff(flagged)).count, 0);
  assert.equal(stateOf(flagged.sqlite, "egg-big").check.reviewOnly.decision.decision, "rejected");
  assert.deepEqual(await flagged.answers(), await plain.answers());
  // a secret that doesn't parse turns the checks off
  const broken = await reviewOnlyWorld({ EGG_CHECK_LIMITS: "{not json", SCREEN_CHECK_LIMITS: "[]" });
  assert.equal((await staff(broken)).count, 0);
});

test("limit previews: counts and distributions only, for candidate limits sent in the request", async () => {
  const world = await reviewOnlyWorld({});
  const preview = (body, session = SESSIONS.dev) => call(world.env, "/api/admin/run-checks/limits", { session, method: "POST", body });
  assert.equal((await preview({}, SESSIONS.user)).status, 403);
  const none = await (await preview({})).json();
  assert.deepEqual([none.egg.limits, none.egg.matchesFlagged, none.screen.limits, none.screen.rowsFlagged], [null, 0, null, 0]);
  assert.equal(none.egg.matches, 2);
  assert.deepEqual(none.egg.byDifficulty.Normal.loot, { rows: 2, min: 20000, p10: 20000, p50: 20000, p90: 20000, p99: 20000, max: 90000 });
  assert.deepEqual(none.screen.bySource, { "screen, copy ok": 1 });
  const some = await (await preview({ egg: JSON.parse(EGG_LIMITS), screen: { maxOver40: 100 } })).json();
  assert.deepEqual(some.egg.flagged, { "egg loot": 1, "egg time": 1, "egg defeats": 1 });
  assert.equal(some.screen.rowsFlagged, 0);                                     // 50 is under 100
  assert.equal(JSON.stringify(some).includes("UserOne"), false);
});

// made-up limits (the real ones are secrets)
const INTERLINK_LIMITS = JSON.stringify({ maxPlayerAvgDps: 20000 });
async function interlinkDpsWorld(extraEnv) {
  const { env, sqlite } = await setup({ EVIDENCE: evidenceStore(), LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev, ...extraEnv });
  const token = await namedToken(env, SESSIONS.user);
  const other = await namedToken(env, SESSIONS.dev);
  // one run over the made-up limit, sent by two team-mates; one whose cards are ten times the meter's figure (still
  // checked, with a hint for staff); one with no Avg DPS read (nothing to check)
  const big = run("dps-big", { extra: { instanceId: "inst-1" } });
  assert.equal((await sendWithScreens(env, token, big)).status, 201);
  assert.equal((await sendWithScreens(env, other, { ...big, clientRunId: "dps-big-2" })).status, 201);
  assert.equal((await sendWithScreens(env, token, run("dps-far", { meterDps: 2900 }))).status, 201);
  assert.equal((await sendWithScreens(env, token, run("dps-none", { players: [{ name: "MinMax" }, { name: "Leonard", ai: true }] }))).status, 201);
  // the two copies tie, and which of the two ranks first differs between two databases by chance: lists compared as
  // sets, without the tie's rank and team number
  const unordered = (value) => (Array.isArray(value) ? value.map(unordered).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "rank" && key !== "team").map(([key, item]) => [key, unordered(item)])) : value);
  const answers = async () => unordered(publicView({
    interlink: await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json(),
    runs: await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json(),
  }));
  return { env, sqlite, answers };
}

test("review-only Interlink Avg DPS: a run over the limit is listed for staff by card position, far from the meter with a hint; the public views are untouched", async () => {
  const plain = await interlinkDpsWorld({});
  const flagged = await interlinkDpsWorld({ INTERLINK_CHECK_LIMITS: INTERLINK_LIMITS });
  const staff = async (world) => (await call(world.env, "/api/admin/run-checks/staff", { session: SESSIONS.dev })).json();
  assert.equal((await staff(plain)).count, 0);
  const listed = await staff(flagged);
  assert.equal(listed.count, 3);                                                 // each sender's copy, and the far one
  assert.deepEqual(listed.runs.map((r) => r.decides), ["nothing", "nothing", "nothing"]);
  assert.deepEqual(listed.runs.map((r) => r.reasons.join(" ")).sort(), [
    "Player 1's Avg DPS is 25,913; the limit for review is 20,000.",
    "Player 1's Avg DPS is 25,913; the limit for review is 20,000.",
    "Player 1's Avg DPS is 25,913; the limit for review is 20,000. aLogs' own estimate from the boss's HP bar is 2,900 for the team against the cards' 29,382: look at the Battle Data picture for a misread first.",
  ]);
  assert.deepEqual(stateOf(flagged.sqlite, "dps-big").check.reviewOnly.flags, [{ rule: "player avg dps", card: 1, sent: 25913, limit: 20000 }]);
  assert.deepEqual(stateOf(flagged.sqlite, "dps-far").check.reviewOnly.flags,
    [{ rule: "player avg dps", card: 1, sent: 25913, limit: 20000, meterDps: 2900, cardsSum: 29382 }]);
  assert.equal(stateOf(flagged.sqlite, "dps-none").check.reviewOnly, undefined);
  for (const id of ["dps-big", "dps-big-2", "dps-far", "dps-none"]) assert.equal(stateOf(flagged.sqlite, id).state, stateOf(plain.sqlite, id).state);
  assert.deepEqual(await flagged.answers(), await plain.answers());
  // a broken secret checks nothing
  assert.equal((await staff(await interlinkDpsWorld({ INTERLINK_CHECK_LIMITS: "{nope" }))).count, 0);
  // the preview counts the run once across its two copies, the run without Avg DPS and the one far from the meter
  const preview = await (await call(plain.env, "/api/admin/run-checks/limits", { session: SESSIONS.dev, method: "POST", body: { interlink: JSON.parse(INTERLINK_LIMITS) } })).json();
  const { copies, runs, runsChecked, noAvgDps, meterFarOff, runsFlagged } = preview.interlink;
  assert.deepEqual({ copies, runs, runsChecked, noAvgDps, meterFarOff, runsFlagged }, { copies: 4, runs: 3, runsChecked: 2, noAvgDps: 1, meterFarOff: 1, runsFlagged: 2 });
  assert.deepEqual(preview.interlink.flagged, { "player avg dps": 2 });
  assert.equal(/MinMax|Leonard/u.test(JSON.stringify(preview)), false);
});

test("run checks: a re-check can set aside readings that read nothing, so those runs are read again", async () => {
  const AI = { async run() { return { response: "" }; } };
  const { env, sqlite } = await setup({ EVIDENCE: evidenceStore(), AI, LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev });
  const token = await namedToken(env, SESSIONS.user);
  await sendWithScreens(env, token, run("blank"));
  assert.equal(stateOf(sqlite, "blank").state, "unreadable");
  const recheck = async (body) => (await call(env, "/api/admin/run-checks/recheck", { session: SESSIONS.dev, method: "POST", body })).json();
  assert.deepEqual((await recheck({})).outcomes, { "no badge (picture unreadable)": 1 });
  assert.deepEqual((await recheck({ retryUnreadable: true })).outcomes, { "would be read": 1 });
  const applied = await recheck({ retryUnreadable: true, apply: true });
  assert.deepEqual(applied.outcomes, { "waiting for a reading": 1 });
  assert.deepEqual([stateOf(sqlite, "blank").state, stateOf(sqlite, "blank").check.queued], ["pending", true]);
});

test("run checks: the reader's own failures and a run sent lower than its picture get no badge and no staff entry", async () => {
  // made-up numbers: each run's result screen reads the next of these
  const reads = [[71, 0], [0, 13], [615, 3], [89, 6], [8275, 8], [15000, 15]];
  const AI = { results: 0, async run(model, input) {
    if (input.prompt.includes("Battle Data")) return { response: '{"cards": []}' };
    const [score, stars] = reads[this.results++];
    return { response: JSON.stringify({ score, stars, time: "3:00" }) };
  } };
  const { env, sqlite } = await setup({ EVIDENCE: evidenceStore(), AI, LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev });
  const token = await namedToken(env, SESSIONS.user);
  const sent = [[17391, 17], [13258, 13], [11347, 11], [6301, 6], [8215, 8], [15500, 15]];
  for (const [index, [score, stars]] of sent.entries()) {
    assert.equal((await sendWithScreens(env, token, run(`shape${index}`, { score, stars, players: [] }), ["evidence", "evidence_full"])).status, 201);
  }
  const notes = sent.slice(0, 5).map((_, index) => {
    const { state, check } = stateOf(sqlite, `shape${index}`);
    assert.equal(state, null);
    return check.readingNote;
  });
  assert.deepEqual(notes, [...Array(4).fill("reading not plausible: fewer digits"), "sent lower than the picture"]);
  // the last one sent 15,500 where its picture shows 15,000 with 15 stars: staff
  assert.equal(stateOf(sqlite, "shape5").state, "mismatch");
  const staff = await (await call(env, "/api/admin/run-checks/staff", { session: SESSIONS.dev })).json();
  assert.deepEqual(staff.runs.map((item) => item.score), [15500]);
  // the re-check counts why a reading's difference didn't count
  const recheck = await (await call(env, "/api/admin/run-checks/recheck", { session: SESSIONS.dev, method: "POST", body: {} })).json();
  assert.deepEqual(recheck.readingNotes, { "reading not plausible: fewer digits": 4, "sent lower than the picture": 1 });
  assert.deepEqual(recheck.staff, { "picture shows less": 1 });
  const entries = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json()).entries;
  assert.ok(entries.every((entry) => entry.check == null));
});

// ---------------------------------------------------------------- tied places: week total, Season Ladder, profiles
// Three runs on one boss in week 3005, each a team (made-up names; only DevOne, DevTwo and UserOne have accounts):
// 30,000 by DevOne with Ashby (a two-way tie at the top), 25,000 by DevTwo with Brisk and Corra (a three-way tie in the
// middle) and 20,000 by UserOne alone. Places on the week total and the Season Ladder: 1, 1, 3, 3, 3, 6. creditUser:
// UserOne sends nothing and is the third player of DevTwo's run instead, credited by UID.
async function tiedWeek(env, sqlite, { creditUser = false } = {}) {
  const dev = await namedToken(env, SESSIONS.dev);
  const dev2 = await namedToken(env, SESSIONS.dev2);
  const user = await namedToken(env, SESSIONS.user);
  const at = Math.floor(Date.now() / 1000) - 3600;
  const seat = (name, avgDps, more = {}) => ({ name, ai: false, avgDps, ...more });
  const send = async (token, id, gameUid, score, time, players, minutesAgo) => {
    assert.equal((await sendRun(env, token, run(id, { gameUid, score, stars: 20, clearTimeS: time, cleared: false, playedAt: at, players }))).status, 201, id);
    sqlite.prepare("UPDATE leaderboard_submissions SET created_at = ? WHERE client_run_id = ?").run(at - minutesAgo * 60, id);
  };
  await send(dev, "tie-top", "301000000001", 30000, 150, [seat("DevOne", 9000, { self: true }), seat("Ashby", 7000)], 50);
  // UserOne credited by UID in DevTwo's run (the game showed it; UserOne's character is proven), or a name-only Corra
  const third = creditUser ? seat("UserOne", 4000, { uid: "301000000003" }) : seat("Corra", 4000);
  await send(dev2, "tie-mid", "301000000002", 25000, 160, [seat("DevTwo", 7000, { self: true }), seat("Brisk", 5000), third], 40);
  if (!creditUser) await send(user, "tie-low", "301000000003", 20000, 170, [seat("UserOne", 6000, { self: true })], 30);
  if (creditUser) sqlite.prepare("UPDATE game_characters SET verified_at = ? WHERE game_uid = '301000000003'").run(at);
}
const placesOf = (rows) => rows.map((row) => [row.discordName || row.player, row.rank]).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

test("tied places: the week total and the Season Ladder give equal totals one place and skip the next (1, 1, 3, 3, 3, 6)", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await tiedWeek(env, sqlite);
  const week = (await (await call(env, "/api/leaderboard/interlink?cycle=3005&unlinked=1")).json()).week;
  assert.deepEqual(placesOf(week), [["Ashby", 1], ["DevOne", 1], ["Brisk", 3], ["Corra", 3], ["DevTwo", 3], ["UserOne", 6]]);
  const ladder = await (await call(env, "/api/leaderboard/interlink?season=1&split=all&unlinked=1")).json();
  assert.deepEqual(placesOf(ladder.standings), [["Ashby", 1], ["DevOne", 1], ["Brisk", 3], ["Corra", 3], ["DevTwo", 3], ["UserOne", 6]]);
  // equal rows are listed by who got there first, but the place doesn't say it
  assert.deepEqual(ladder.standings.map((row) => row.rank), [1, 1, 3, 3, 3, 6]);
  // by total stars (all 20): a tie on stars falls to the score, then the same places
  const byStars = await (await call(env, "/api/leaderboard/interlink?season=1&split=all&unlinked=1&sort=stars")).json();
  assert.deepEqual(byStars.standings.map((row) => row.rank), [1, 1, 3, 3, 3, 6]);
  // linked players only (the page's default): DevOne 1, DevTwo 2, UserOne 3
  const linked = await (await call(env, "/api/leaderboard/interlink?season=1&split=all")).json();
  assert.deepEqual(placesOf(linked.standings), [["DevOne", 1], ["DevTwo", 2], ["UserOne", 3]]);
});

test("tied places across a page: View all in Players view gives equal rows the same place on both pages", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await tiedWeek(env, sqlite);
  const page = async (offset) => (await (await call(env, `/api/leaderboard/interlink?cycle=3005&unlinked=1&boss=80000107&ladder=score&limit=3&offset=${offset}`)).json()).bosses[0];
  const first = await page(0);
  const second = await page(3);
  // place 2 is the second team row (DevTwo's run): its three players split 1 + 2 over the pages, place 2 on both
  assert.deepEqual(first.entries.map((e) => e.rank), [1, 1, 2]);
  assert.deepEqual(second.entries.map((e) => e.rank), [2, 2, 3]);
  // the Avg DPS ladder (one player's own), paged two a page: the two 7,000s are not equal on everything the ladder sorts
  // by (its next figure is the run's score: 30,000 against 25,000), so they don't share
  const dps = async (offset) => (await (await call(env, `/api/leaderboard/interlink?cycle=3005&unlinked=1&boss=80000107&ladder=dps&limit=2&offset=${offset}`)).json()).bosses[0].entries.map((e) => [e.avgDps, e.rank]);
  assert.deepEqual([...await dps(0), ...await dps(2), ...await dps(4)], [[9000, 1], [7000, 2], [7000, 3], [6000, 4], [5000, 5], [4000, 6]]);
});

// the profile's places against the board's, for one account
async function profileAgainstBoard(env, session, name) {
  const overview = await (await call(env, "/api/profile/overview", { session })).json();
  const trophy = (id) => overview.trophies.find((item) => item.id === id);
  const board = async (ladder, rows) => (await (await call(env, `/api/leaderboard/interlink?cycle=3005&boss=80000107&ladder=${ladder}${rows ? "&rows=teams" : ""}`)).json()).bosses[0];
  const score = await board("score", true);
  const dps = await board("dps", false);
  return {
    score: { profile: trophy("interlink-score")?.placement, board: { position: score.entries.find((e) => e.player === name)?.rank, players: score.teams, counts: "teams" } },
    dps: { profile: trophy("interlink-dps")?.placement, board: { position: dps.entries.find((e) => e.player === name)?.rank, players: dps.total, counts: "players" } },
    part: overview.leaderboards?.interlinkParts?.current,
    entry: overview.leaderboards?.interlink_run?.[0],
    ladder: (await (await call(env, "/api/leaderboard/interlink?season=1&split=all")).json()).standings.find((row) => row.player === name),
  };
}

test("profile places agree with the boards: a team ladder counts teams, a one-player ladder players, the season part the Season Ladder", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await tiedWeek(env, sqlite);
  for (const [session, name] of [[SESSIONS.dev, "DevOne"], [SESSIONS.dev2, "DevTwo"], [SESSIONS.user, "UserOne"]]) {
    const seen = await profileAgainstBoard(env, session, name);
    assert.deepEqual(seen.score.profile, seen.score.board, `${name}: score`);
    assert.deepEqual(seen.dps.profile, seen.dps.board, `${name}: Avg DPS`);
    assert.equal(seen.part?.rank, seen.ladder?.rank, `${name}: season part`);
    // the profile's board entry (leaderboards.interlink_run): the Score board's place and team count
    assert.deepEqual([seen.entry?.position, seen.entry?.players, seen.entry?.counts], [seen.score.board.position, seen.score.board.players, "teams"], `${name}: entry`);
  }
  // what the numbers are: DevTwo is the second team of three on Score, second of three players on Avg DPS
  const dev2 = await profileAgainstBoard(env, SESSIONS.dev2, "DevTwo");
  assert.deepEqual([dev2.score.profile, dev2.dps.profile], [{ position: 2, players: 3, counts: "teams" }, { position: 2, players: 3, counts: "players" }]);
});

test("profile places agree with the boards for a team-mate credited by UID from someone else's copy", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await tiedWeek(env, sqlite, { creditUser: true });
  const seen = await profileAgainstBoard(env, SESSIONS.user, "UserOne");
  assert.ok(seen.score.board.position, "UserOne is on the board from DevTwo's copy");
  assert.deepEqual(seen.score.profile, seen.score.board);
  assert.deepEqual(seen.dps.profile, seen.dps.board);
  assert.deepEqual([seen.score.profile.position, seen.part?.rank, seen.ladder?.rank], [2, 2, 2]);   // tied with DevTwo on the Season Ladder
  assert.equal((await (await call(env, "/api/leaderboard/interlink?season=1&split=all")).json()).standings.find((row) => row.player === "DevTwo").rank, 2);
});

test("the app's board check (board_has) reads the same shape: every player's row with uid, stars and score under bosses[].id, ties included", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true" });
  await tiedWeek(env, sqlite, { creditUser: true });
  // the call old and new aLogs builds make: ?cycle=&unlinked=1, no ladder, no limit, no rows
  const data = await (await call(env, "/api/leaderboard/interlink?cycle=3005&unlinked=1")).json();
  assert.ok(Array.isArray(data.bosses));
  const boss = data.bosses.find((item) => item.id === "80000107");
  assert.equal(typeof boss.id, "string");
  assert.equal(boss.entries.length, boss.total);                 // every player, not a page or team rows
  for (const entry of boss.entries) {
    assert.ok("uid" in entry, "uid on every row");
    assert.equal(typeof entry.stars, "number");
    assert.equal(typeof entry.score, "number");
  }
  const byUid = (uid) => boss.entries.find((entry) => entry.uid === uid);
  assert.deepEqual([byUid("301000000001").stars, byUid("301000000001").score], [20, 30000]);
  assert.deepEqual([byUid("301000000002").stars, byUid("301000000002").score], [20, 25000]);
  assert.deepEqual([byUid("301000000003").stars, byUid("301000000003").score], [20, 25000]);   // credited from DevTwo's copy
});

test("a Sim win's level record: kept, verified at store time, a skip or jump listed for staff, nothing held", async () => {
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true", ADMIN_DISCORD_IDS: IDS.dev });
  const token = await namedToken(env, SESSIONS.user);
  let t = 1794700000;
  const visit = (ns, of = 16) => ({ enteredAt: t, fromStart: true, levels: ns.map((n) => ({ n, of, t: (t += 30) })), areas: ns.map(() => ({ t })),
    fights: ns.map(() => ({ t, s: 25.5, damage: 50000, id: "90001", defeated: true, breaks: 1, note: "dropped" })), reads: { made: 40, counter: 39 } });
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const sim = (id, time, stages) => ({ kind: "sim_run", clientRunId: id, trial: "Lightning Training", difficulty: "Trial", clearTimeS: time, cleared: true,
    partySize: 1, playedAt: 1794700000, extra: { setup: { coins: 9000 }, ...(stages ? { stages } : {}) } });
  const stored = (id) => {
    const row = sqlite.prepare("SELECT status, verify_state AS state, extra_json AS extra, verify_json AS json FROM leaderboard_submissions WHERE client_run_id = ?").get(id);
    return { status: row.status, state: row.state, extra: JSON.parse(row.extra || "{}"), check: JSON.parse(row.json || "{}") };
  };
  const board = async () => (await (await call(env, "/api/leaderboard/entries?kind=sim_run&sort=clear_time_s&cycle=2&trial=Lightning&difficulty=Trial&best=0")).json())
    .entries.map((entry) => entry.clearTimeS);
  const staff = async () => (await call(env, "/api/admin/run-checks/staff", { session: SESSIONS.dev })).json();
  const logs = [];
  const log = console.log;
  console.log = (line) => logs.push(String(line));
  try {
    // a whole run in three visits, with a long record (over extra's own 8 KB once the fights are in): kept and verified
    const many = { of: 16, visits: [visit(range(1, 5)), visit(range(6, 11)), visit(range(12, 16))] };
    for (const item of many.visits) item.fights.push(...Array.from({ length: 40 }, () => ({ t, s: 1, damage: 1, id: "90002", defeated: false, breaks: 0 })));
    assert.ok(JSON.stringify(many).length > 8192);
    assert.equal((await sendRun(env, token, sim("whole", 700, many))).status, 201);
    const whole = stored("whole");
    assert.equal(whole.extra.stages.visits.length, 3);
    assert.equal(whole.extra.stages.visits[0].fights[0].note, undefined);
    assert.equal(whole.extra.setup.coins, 9000);
    assert.deepEqual([whole.status, whole.state, whole.check.levels.verdict, whole.check.levels.clearTimeS, whole.check.reviewOnly], ["visible", null, "verified", 700, undefined]);
    // a skip (1/16 then 16/16): listed for staff with what backs it, still on the boards
    assert.equal((await sendRun(env, token, sim("skip", 90, { of: 16, visits: [visit([1, 16])] }))).status, 201);
    const skip = stored("skip");
    assert.deepEqual([skip.status, skip.state, skip.extra.autoHidden, skip.check.levels.verdict], ["visible", null, undefined, "skip"]);
    assert.deepEqual(skip.check.reviewOnly.flags, [{ rule: "sim levels skipped", of: 16, seen: [1, 16], lastBefore: 1, fightsSeen: 2, fightSeconds: 51, clearTimeS: 90 }]);
    // a jump inside one visit: listed, not held
    assert.equal((await sendRun(env, token, sim("jump", 650, { of: 16, visits: [visit([...range(1, 3), ...range(7, 16)])] }))).status, 201);
    assert.deepEqual(stored("jump").check.reviewOnly.flags.map((flag) => [flag.rule, flag.from, flag.to]), [["sim level jump", 3, 7]]);
    assert.equal(stored("jump").status, "visible");
    // an older app's run, without a record: as before (nothing listed, nothing in extra), the verdict "none" only stored
    assert.equal((await sendRun(env, token, sim("old", 720))).status, 201);
    const old = stored("old");
    assert.deepEqual([old.status, old.state, old.extra, old.check], ["visible", null, { setup: { coins: 9000 } }, { levels: old.check.levels }]);
    assert.equal(old.check.levels.verdict, "none");
    assert.deepEqual(await board(), [90, 650, 700, 720]);
    // staff read the verification with the run's reasons; others are refused
    const listed = await staff();
    assert.equal(listed.count, 2);
    const skipRow = listed.runs.find((item) => item.clearTimeS === 90);
    assert.equal(skipRow.levels.verdict, "skip");
    assert.match(skipRow.reasons[0], /reached 16\/16 after level 1/u);
    assert.equal(listed.runs.find((item) => item.clearTimeS === 650).levels.verdict, "jump");
    assert.equal((await call(env, "/api/admin/run-checks/staff", { session: SESSIONS.user })).status, 403);
    // re-sent read right: the flag goes, the new verdict is stored
    await sendRun(env, token, sim("skip", 90, { of: 16, visits: [visit(range(1, 16))] }));
    assert.deepEqual([stored("skip").check.levels.verdict, stored("skip").check.reviewOnly], ["verified", undefined]);
    // one log line a stored run, no ids or names
    const lines = logs.filter((line) => line.startsWith("Sim levels: "));
    assert.equal(lines.length, 5);
    assert.ok(lines.every((line) => !/90001|DevOne|UserOne/u.test(line)));
  } finally {
    console.log = log;
  }
});
