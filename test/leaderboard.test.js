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
  assert.equal((await send(SESSIONS.dev, run("bad2", "Training of Lightning", "Hard", 100))).status, 400);
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
  // the rules the page builds its pickers from: 3 elements x (Easy, Normal, Hard) + Challenge = 12 boards
  assert.deepEqual(facets.simRules.elements, ["Grass", "Water", "Fire"]);
  assert.deepEqual(facets.simRules.difficulties, ["Easy", "Normal", "Hard", "Challenge"]);
  assert.equal(facets.simRules.elements.length * facets.simRules.stages.reduce((n, stage) => n + stage.difficulties.length, 0), 12);
  assert.equal(facets.simRules.confirmed, true);
  assert.equal((await (await call(env, "/api/leaderboard/facets?mode=interlink")).json()).simRules, undefined);
});

test("aLogs B2 sends the cropped proof and the whole screens: all four stored, served, and deleted with the run", async () => {
  const EVIDENCE = evidenceStore();
  const { env } = await setup({ EVIDENCE, LEADERBOARD_PUBLIC: "true" });
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
  assert.equal((await call(env, `/api/leaderboard/submissions/${submissionId}`, { token, method: "DELETE" })).status, 200);
  assert.equal(EVIDENCE.objects.size, 1);                                             // only the older run's crop is left
});

test("second reading (shadow mode): Workers AI re-reads the whole screens; a mismatch is listed for review, never held", async () => {
  const EVIDENCE = evidenceStore();
  // a stand-in for Workers AI: the result screen reads score 20000 / 20 stars / 3:00, the Battle Data card MinMax 25913
  const AI = {
    calls: 0,
    async run(model, input) {
      this.calls += 1;
      assert.equal(model, "@cf/meta/llama-3.2-11b-vision-instruct");
      assert.ok(Array.isArray(input.image) && input.image.length > 0);
      return { response: input.prompt.includes("Battle Data")
        ? 'Here you go: {"cards": [{"name": "MinMax", "avgDps": "25,913", "break": null, "taken": null, "heal": null}]}'
        : '{"score": 20000, "stars": 20, "time": "3:00"}' };
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
  assert.equal((await send("differs", { score: 23456, cycle: "3003", boss: { id: "80000099", name: "Alpha Irisal", level: 60 } })).status, 201);
  assert.equal(AI.calls, 4);                                                       // two screens per run
  const list = async (state, session = SESSIONS.dev) => call(env, `/api/admin/run-checks?state=${state}`, { session });
  assert.equal((await list("mismatch", SESSIONS.user)).status, 403);               // administrators and the owner only
  const mismatches = (await (await list("mismatch")).json()).runs;
  assert.deepEqual(mismatches.map((r) => [r.score, r.check.differences]), [[23456, [{ field: "score", sent: 23456, read: 20000 }]]]);
  assert.match(mismatches[0].proof.full, /\?shot=full$/u);
  assert.equal((await (await list("match")).json()).runs.length, 1);
  // public badges: the agreeing run is Verified, the disagreeing one only Pending (never "mismatch" in public)
  const boardCheck = async (cycle) => (await (await call(env, `/api/leaderboard/interlink?cycle=${cycle}`)).json())
    .bosses.flatMap((b) => b.entries).find((e) => e.proofId)?.checks;
  assert.deepEqual(await boardCheck("3005"), { score: "verified" });
  assert.equal((await boardCheck("3003")).score, "pending");
  const publicList = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json()).entries;
  assert.deepEqual(publicList.map((e) => e.check).sort(), ["pending", "verified"]);
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
  // 36,230 with 6 stars: stars don't track score; Avg DPS far above the team's: listed for review even without screens
  await send("odd", { score: 36230, stars: 6, cycle: "4000", boss: { id: "80000098", name: "Alpha Scorchhowl", level: 60 },
    players: [{ name: "MinMax", avgDps: 1371292, self: true }] }, false);
  const odd = JSON.parse(state("odd").json).rules.flags.map((flag) => flag.rule);
  assert.equal(state("odd").state, "mismatch");
  assert.ok(odd.includes("stars track score") && odd.includes("Avg DPS plausible") && odd.includes("Avg DPS add up to team DPS"));
  // the daily cap (2 readings): a third run that matters waits in the queue ("pending", still on the boards)
  await send("pb2", { score: 15500, stars: 15, cycle: "3003", boss: { id: "80000099", name: "Alpha Irisal", level: 60 }, players: [] });
  await send("pb3", { score: 25500, stars: 25, cycle: "3003", boss: { id: "80000102", name: "Alpha Panpanta", level: 60 }, players: [] });
  assert.equal(AI.calls, 4);
  assert.deepEqual([state("pb3").state, JSON.parse(state("pb3").json).queued], ["pending", true]);
  assert.equal((await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json()).total, 5);   // shadow mode
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
  const { env } = await setup({ EVIDENCE, LEADERBOARD_PUBLIC: "true" });
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

test("boss boards carry each player's own Battle Data bests, with the run behind each best as proof", async () => {
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
  const week = await (await call(env, "/api/leaderboard/interlink?cycle=3005")).json();
  const rows = week.bosses.find((b) => b.id === "80000109").entries;
  const me = rows.find((e) => e.player === "DevOne");
  assert.deepEqual([me.score, me.clearTimeS, me.avgDps, me.breakValue, me.damageTaken, me.heal], [20000, 140, 19000, 280000, 6000, 50]);
  assert.deepEqual(me.proofIds, { score: high, clear: fast, dps: fast, break: high, taken: fast, heal: fast });
  const kaela = rows.find((e) => e.player === "Kaela");
  assert.deepEqual([kaela.avgDps, kaela.heal, kaela.proofIds.dps, kaela.proofIds.heal], [16000, 1200, high, fast]);

  // "All runs" ranks by those stats too: each player's own card, their best run for it
  const all = async (sort) => (await (await call(env, `/api/leaderboard/entries?kind=interlink_run&sort=${sort}`)).json()).entries;
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
  // Best per boss, ranked among every player on that boss, as the board shows it.
  assert.deepEqual(runs.map((row) => [row.boss.name, row.score, row.position, row.players, row.character]),
    [["Omega Infergon", 22000, 2, 2, "MinMax"], ["Omega Tucking", 9000, 1, 1, null]]);
  assert.deepEqual(weeks, []);
  assert.deepEqual(sims.map((row) => [row.clearTimeS, row.position, row.players]), [[1800, 1, 2]]);
  assert.deepEqual(heists.map((row) => [row.cycle, row.seasonRank.name, row.stars, row.score, row.position, row.players]),
    [["S1", "Egg Emperor", 475, 2900, 2, 2]]);
  // the profile's season progress: just these fields, nothing else from the app's extra
  assert.deepEqual(heists[0].seasonProgress, { nextRankAt: 2370, lastGain: 18, bar: [1337, 1350], barAt: 1793167625 });

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
  // week 4000: 15 stars and under the clock is no longer a clear; 20 is
  assert.equal((await send(SESSIONS.dev, run("c1", { cycle: "4000", boss: boss("80000110"), stars: 15, score: 15000, clearTimeS: 120, cleared: true }))).status, 201);
  assert.equal((await send(SESSIONS.user, run("c2", { cycle: "4000", boss: boss("80000110"), stars: 20, score: 21000, clearTimeS: 150, cleared: true }))).status, 201);
  const week = await (await call(env, "/api/leaderboard/interlink?cycle=4000")).json();
  assert.deepEqual(week.bosses[0].entries.map((e) => [e.stars, e.clearTimeS]), [[20, 150], [15, null]]);
  // the center boss is a kill only at its full 40 stars: 26 stars under the clock is a run ended early, not a clear
  assert.equal((await send(SESSIONS.dev, run("k1", { cycle: "4000", boss: boss("80000111"), stars: 26, score: 26000, clearTimeS: 95, cleared: true }))).status, 201);
  assert.equal((await send(SESSIONS.user, run("k2", { cycle: "4000", boss: boss("80000111"), stars: 40, score: 44000, clearTimeS: 170, cleared: true }))).status, 201);
  const center = (await (await call(env, "/api/leaderboard/interlink?cycle=4000")).json());
  assert.deepEqual(center.bosses[1].entries.map((e) => [e.stars, e.clearTimeS]), [[40, 170], [26, null]]);
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
  // run is flagged so the rules get updated
  assert.equal((await send(SESSIONS.dev, run("cap1", { cycle: "4005", boss: boss("80000110"), stars: 22, score: 23000, clearTimeS: 100, cleared: true, extra: { starCap: 25 } }))).status, 201);
  assert.equal((await send(SESSIONS.user, run("cap2", { cycle: "4005", boss: boss("80000110"), stars: 25, score: 26000, clearTimeS: 140, cleared: true, extra: { starCap: 25 } }))).status, 201);
  const raised = await (await call(env, "/api/leaderboard/interlink?cycle=4005")).json();
  assert.deepEqual(raised.bosses[0].entries.map((e) => [e.stars, e.clearTimeS]), [[25, 140], [22, null]]);
  const checked = (id) => JSON.parse(sqlite.prepare("SELECT verify_json FROM leaderboard_submissions WHERE client_run_id = ?").get(id).verify_json).rules.flags;
  assert.deepEqual(checked("cap2").map((flag) => [flag.rule, flag.sent, flag.expected]), [["star cap matches the rules", 25, 20]]);
  assert.ok(checked("cap1").some((flag) => flag.rule === "cleared needs full stars" && flag.expected === 25));
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
  assert.deepEqual((await get("sort=defeats&best=0")).map((e) => e.defeats), [4, 1, 0]);
  assert.deepEqual((await get("cleared=1&best=0")).map((e) => e.score), [31000, 23733]);   // escapes only
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
  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pubdev01' WHERE discord_id = ?").run(IDS.dev);
  sqlite.prepare("UPDATE leaderboard_submissions SET status = 'hidden' WHERE client_run_id = 'dev-own'").run();
  assert.equal((await historyOf(env, "/api/profiles/pubdev01/history")).runs.length, 1);
  assert.deepEqual((await devHistory()).map((r) => Boolean(r.hidden)), [false, true]);
  sqlite.prepare("UPDATE profiles SET is_public = 0 WHERE discord_id = ?").run(IDS.dev);
  assert.equal((await call(env, "/api/profiles/pubdev01/history")).status, 404);
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

test("pictures: a run that's nobody's best keeps full screens 14 days and crops 90; bests and runs under review keep all", async () => {
  const EVIDENCE = evidenceStore();
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true", EVIDENCE });
  const devToken = await namedToken(env, SESSIONS.dev);
  const userToken = await namedToken(env, SESSIONS.user);
  sqlite.prepare("UPDATE game_characters SET verified_at = 1").run();
  const screens = ["evidence", "battle", "evidence_full", "battle_full"];
  await sendRun(env, devToken, run("best", { score: 30000, stars: 25 }), screens);
  await sendRun(env, devToken, run("worse", { score: 20000, stars: 20 }), screens);
  await sendRun(env, devToken, run("review", { score: 10000, stars: 10 }), screens);
  await sendRun(env, userToken, run("user-best", { score: 40000, stars: 30 }), screens);
  // not UserOne's best, but better than anything DevOne (in the party, UID proven) sent: DevOne's best, so it stays
  await sendRun(env, userToken, run("teammates-best", { score: 35000, stars: 28,
    players: [{ name: "UserOne", self: true }, { name: "DevOne", uid: "301000000001", ai: false }] }), screens);
  const id = (client) => sqlite.prepare("SELECT submission_id AS id FROM leaderboard_submissions WHERE client_run_id = ?").get(client).id;
  sqlite.prepare("UPDATE leaderboard_submissions SET verify_state = 'mismatch' WHERE client_run_id = 'review'").run();
  const age = (days) => sqlite.prepare("UPDATE leaderboard_submissions SET created_at = ?").run(Math.floor(Date.now() / 1000) - days * 86400);
  const pictures = (client) => [...EVIDENCE.objects.keys()].filter((key) => key.includes(id(client)))
    .map((key) => (/-(battle-)?full\./u.test(key) ? "full" : "crop")).sort();
  let n = 0;
  const prune = async () => { for (let i = 0; i < 3; i += 1) await sendRun(env, devToken, run(`trigger-${n += 1}`, { cycle: "3004", boss: { id: "80000099", name: "Alpha Irisal", level: 1 } })); };
  age(10);
  await prune();
  assert.equal(pictures("worse").length, 4);                              // under 14 days: everything
  age(20);
  await prune();
  assert.deepEqual(pictures("worse"), ["crop", "crop"]);                 // nobody's best: the full screens go
  for (const kept of ["best", "user-best", "teammates-best", "review"]) assert.equal(pictures(kept).length, 4, kept);
  age(100);
  await prune();
  assert.deepEqual(pictures("worse"), []);
  const worse = sqlite.prepare("SELECT evidence_key, battle_evidence_key, proof_pruned_at, score FROM leaderboard_submissions WHERE client_run_id = 'worse'").get();
  assert.deepEqual([worse.evidence_key, worse.battle_evidence_key, worse.score], [null, null, 20000]);   // the numbers stay
  assert.ok(worse.proof_pruned_at > 0);
  const listed = (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs.find((r) => r.submissionId === id("worse"));
  assert.deepEqual([listed.hasEvidence, listed.hasFullScreens, Boolean(listed.proofPrunedAt)], [false, [], true]);
  for (const kept of ["best", "user-best", "teammates-best", "review"]) assert.equal(pictures(kept).length, 4, kept);
});

test("the Party screen's details: the sender's lead Aniimo, CP and team comp, the party's buffs; nobody else's", async () => {
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
    { slot: 2, name: "Mario", ai: true },
    { slot: 3, name: "Friend", ai: false },                                 // a teammate's Aniimo and CP are theirs to send
  ]);
  assert.deepEqual(listed.buffs, [{ name: "Fire Resonance", level: 2 }, { name: "Swift Start" }]);
  assert.equal(listed.title, undefined);
  assert.deepEqual(listed.newBests, []);                                   // no "New best" for a run that beat nothing
  const entries = JSON.stringify(await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0")).json());
  assert.equal(entries.includes("9999"), false);                          // nor on the boards' API
});

test("the Party screen's last capture is the lineup's proof: stored, replaced by a newer one, kept like the crops", async () => {
  const EVIDENCE = evidenceStore();
  const { env, sqlite } = await setup({ LEADERBOARD_PUBLIC: "true", EVIDENCE });
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

test("the sender in slot 2: their own section of the Party screen, never slot 1's", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  const lineup = [
    { slot: 1, name: "Leader", ai: false, aniimo: "Glameep", aniimoLevel: 60, cp: 20000, team: ["Glameep", "Sherro"] },
    { slot: 2, name: "DevOne", ai: false, self: true, aniimo: "Emberpup", aniimoLevel: 55, cp: 11000, team: ["Emberpup", "Chirpi"] },
  ];
  await sendRun(env, token, run("p2", { extra: { lineup } }));
  const [listed] = (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs;
  assert.deepEqual(listed.lineup, [
    { slot: 1, name: "Leader", ai: false },
    { slot: 2, name: "DevOne", ai: false, self: true, aniimo: "Emberpup", aniimoLevel: 55, cp: 11000, team: [{ aniimo: "Emberpup" }, { aniimo: "Chirpi" }] },
  ]);
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

test("how a run ended: cleared, ended early (quit, the result screens still appear) or time up", async () => {
  const { env } = await setup({ LEADERBOARD_PUBLIC: "true" });
  const token = await namedToken(env, SESSIONS.dev);
  const infergon = { boss: { id: "80000107", name: "Omega Infergon", level: 60 } };      // week 3005: 15 stars clear
  await sendRun(env, token, run("kill", { ...infergon, stars: 15, score: 18000, clearTimeS: 140, cleared: true, playedAt: 1792700300 }));
  await sendRun(env, token, run("quit", { ...infergon, stars: 9, score: 9500, clearTimeS: 95, cleared: false, playedAt: 1792700200 }));
  await sendRun(env, token, run("timeout", { ...infergon, stars: 12, score: 12500, clearTimeS: 180, cleared: false, playedAt: 1792700100 }));
  // an app that said "cleared" for a quit run (up to 0.1.21): it's still a run ended early
  await sendRun(env, token, run("quit-said-cleared", { ...infergon, stars: 6, score: 6400, clearTimeS: 70, cleared: true, playedAt: 1792700000 }));
  const history = (await historyOf(env, "/api/profile/history", SESSIONS.dev)).runs;
  assert.deepEqual(history.map((r) => [r.score, r.outcome]), [[18000, "cleared"], [9500, "ended-early"], [12500, "time-up"], [6400, "ended-early"]]);
  const entries = (await (await call(env, "/api/leaderboard/entries?kind=interlink_run&best=0&sort=played_at")).json()).entries;
  assert.deepEqual(entries.map((e) => e.outcome).sort(), ["cleared", "ended-early", "ended-early", "time-up"]);
});
