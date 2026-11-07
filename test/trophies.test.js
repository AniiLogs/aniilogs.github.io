import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker from "../src/index.js";

// The profile's Trophies card: each personal best a board ranks, its place on that ladder, and its proof. Made-up
// players and UIDs only.
const ORIGIN = "https://aniilogs.github.io";
const IDS = { alpha: "711111111111111111", bravo: "722222222222222222" };
const SESSIONS = { alpha: "a".repeat(48), bravo: "b".repeat(48) };
const NAMES = { alpha: ["900000000001", "Alpha"], bravo: ["900000000002", "Bravo"] };
const INFERGON = { id: "80000107", name: "Omega Infergon" };
const SHERRO = { id: "80000109", name: "Omega Sherro" };
const TUCKING = { id: "80000100", name: "Omega Tucking" };

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
  const DB = { prepare: (sql) => ({ ...statement(sql), bind: (...values) => statement(sql, values) }), async batch(list) { return Promise.all(list.map((s) => s.run())); } };
  const now = Math.floor(Date.now() / 1000);
  for (const [key, discordId] of Object.entries(IDS)) {
    sqlite.prepare("INSERT INTO users VALUES (?, ?, ?, NULL, ?, ?)").run(discordId, key, `${key} name`, now, now);
    sqlite.prepare("INSERT INTO profiles (discord_id, display_name, bio, is_public, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)").run(discordId, `${key} name`, now, now);
    sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(await tokenHash(SESSIONS[key]), discordId, now, now + 3600);
    sqlite.prepare("INSERT INTO game_characters (game_uid, discord_id, character_name, source, linked_at, last_seen_at) VALUES (?, ?, ?, 'meter', ?, ?)")
      .run(NAMES[key][0], discordId, NAMES[key][1], now, now);
  }
  const objects = new Map();
  const EVIDENCE = {
    async put(key, body) { objects.set(key, new Uint8Array(await new Response(body).arrayBuffer())); },
    async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
    async delete(key) { objects.delete(key); },
  };
  const env = { DB, EVIDENCE, PUBLIC_SITE_ORIGIN: ORIGIN, LEADERBOARD_PUBLIC: "true", SESSION_SECRET: "s".repeat(40), ...extraEnv };
  let order = 0;
  // a stored submission, as the boards read it
  const add = (who, id, fields) => {
    const row = {
      submission_id: id, discord_id: IDS[who], client_run_id: id, game_uid: NAMES[who][0], status: "visible",
      created_at: now - 10000 + (order += 1), updated_at: now, ...fields,
    };
    for (const key of ["evidence_key", "battle_evidence_key"]) if (row[key]) objects.set(row[key], new Uint8Array([1, 2, 3]));
    const columns = Object.keys(row);
    sqlite.prepare(`INSERT INTO leaderboard_submissions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...columns.map((column) => row[column]));
  };
  const interlink = (who, id, boss, fields, self) => add(who, id, {
    mode: "interlink", kind: "interlink_run", cycle: "3005", boss_id: boss.id, boss_name: boss.name, boss_level: 60, party_size: 1,
    players_json: JSON.stringify([{ name: NAMES[who][1], ai: false, self: true, ...self }]), ...fields,
  });
  // Week 3005. Alpha: Infergon 20000 (Bravo 25000), Sherro 15000 with the best Avg DPS of the two (45000, but Bravo has 50000)
  interlink("alpha", "run-a-infergon", INFERGON, { score: 20000, stars: 20, clear_time_s: 150, cleared: 1, outcome: "cleared", team_dps: 50000,
    evidence_key: "evidence/a-inf.jpg", battle_evidence_key: "evidence/a-inf-b.jpg", verify_state: "match", played_at: 1792700000 },
  { avgDps: 30000, breakValue: 900, heal: 50 });
  interlink("alpha", "run-a-sherro", SHERRO, { score: 15000, stars: 15, clear_time_s: 170, cleared: 1, outcome: "cleared", team_dps: 40000,
    evidence_key: "evidence/a-sher.jpg", battle_evidence_key: "evidence/a-sher-b.jpg", played_at: 1792700500 },
  { avgDps: 45000, breakValue: 300, heal: 0 });
  interlink("bravo", "run-b-infergon", INFERGON, { score: 25000, stars: 20, clear_time_s: 140, cleared: 1, outcome: "cleared", team_dps: 60000,
    evidence_key: "evidence/b-inf.jpg" }, { avgDps: 20000 });
  interlink("bravo", "run-b-sherro", SHERRO, { score: 22000, stars: 10, clear_time_s: 180, cleared: 0, outcome: "time-up", team_dps: 30000 },
    { avgDps: 50000 });
  // never a trophy: a hidden run and an invalid one (quit), however high
  interlink("alpha", "run-a-hidden", INFERGON, { score: 99999, stars: 20, clear_time_s: 100, cleared: 1, outcome: "cleared", status: "hidden" }, { avgDps: 99999 });
  interlink("alpha", "run-a-quit", TUCKING, { score: 88888, stars: 5, clear_time_s: 40, cleared: 1, outcome: "invalid" }, { avgDps: 88888 });
  // Holo-Battle Sim (season 2): Alpha cleared Earth on Normal and Hard; the tile is Hard's (the harder one), Bravo is faster
  const sim = (who, id, difficulty, time, evidence) => add(who, id, { mode: "sim", kind: "sim_run", cycle: "2", trial: "Earth", difficulty,
    clear_time_s: time, cleared: 1, ...(evidence ? { evidence_key: evidence } : {}) });
  sim("alpha", "sim-a-normal", "Normal", 200, "evidence/sim-a-n.jpg");
  sim("alpha", "sim-a-hard", "Hard", 300, null);
  sim("bravo", "sim-b-hard", "Hard", 250, "evidence/sim-b-h.jpg");
  // Egg Heist: Bravo ranks higher this season and loots more; Alpha escapes faster and beats more
  const eggSeason = (who, id, tier, name, points) => add(who, id, { mode: "eggheist", kind: "eggheist_season", cycle: "S1", rank_tier: tier,
    rank_name: name, score: points, evidence_key: `evidence/${id}.jpg` });
  eggSeason("alpha", "egg-season-a", 4, "Gold Egg Hunter", 500);
  eggSeason("bravo", "egg-season-b", 5, "Diamond Egg Hunter", 100);
  const match = (who, id, loot, time, defeats) => add(who, id, { mode: "eggheist", kind: "eggheist_match", cycle: "S1", difficulty: "Hard",
    score: loot, clear_time_s: time, cleared: 1, defeats, evidence_key: `evidence/${id}.jpg` });
  match("alpha", "egg-match-a1", 900, 400, 3);
  match("alpha", "egg-match-a2", 500, 300, 7);
  match("bravo", "egg-match-b1", 1000, 350, 1);
  return { env, sqlite };
}

const call = (env, path, session) => {
  const headers = new Headers({ origin: ORIGIN });
  if (session) headers.set("authorization", `Bearer ${session}`);
  return worker.fetch(new Request(`https://api.aniilogs.example${path}`, { headers }), env);
};
const byId = (trophies) => new Map(trophies.map((trophy) => [trophy.id, trophy]));
const place = (trophy) => [trophy.value, trophy.placement.position, trophy.placement.players];

test("trophies: each personal best a board ranks, with its place on that ladder (each player's best)", async () => {
  const { env } = await setup();
  const { trophies } = await (await call(env, "/api/profile/overview", SESSIONS.alpha)).json();
  const got = byId(trophies);
  // Interlink: the best figure across every week and boss, placed on that boss's board for that ladder
  assert.deepEqual(place(got.get("interlink-score")), [20000, 2, 2]);                  // not the hidden 99999 nor the quit 88888
  assert.equal(got.get("interlink-score").context.boss.name, "Omega Infergon");
  assert.deepEqual(got.get("interlink-score").context.week, { cycle: "3005", start: 1792612800, end: 1793001599 });
  assert.equal(got.get("interlink-score").stars, 20);
  assert.deepEqual(place(got.get("interlink-clear")), [150, 2, 2]);
  assert.deepEqual(place(got.get("interlink-dps")), [45000, 2, 2]);                     // the higher figure, though only #2 there
  assert.equal(got.get("interlink-dps").context.boss.name, "Omega Sherro");
  assert.deepEqual(place(got.get("interlink-team-dps")), [50000, 2, 2]);
  assert.deepEqual(place(got.get("interlink-break")), [900, 1, 1]);
  assert.deepEqual(place(got.get("interlink-heal")), [50, 1, 1]);                      // Bravo sent no healing figure
  // the best week: 35000 against Bravo's 47000
  assert.deepEqual(place(got.get("interlink-week")), [35000, 2, 2]);
  assert.equal(got.get("interlink-week").proof, null);
  // the ladders link to the board with that boss and ladder open
  assert.deepEqual(got.get("interlink-dps").board, { mode: "interlink", kind: "interlink_boss", week: "3005", boss: SHERRO.id, ladder: "dps" });
  assert.equal(got.get("interlink-score").playedAt, 1792700000);
  // Holo-Battle Sim: one tile a trial, at the hardest difficulty cleared
  const sim = trophies.filter((trophy) => trophy.mode === "sim");
  assert.equal(sim.length, 1);
  assert.deepEqual(place(sim[0]), [300, 2, 2]);
  assert.equal(sim[0].label, "Fastest Earth Training");
  assert.deepEqual(sim[0].board, { mode: "sim", kind: "sim_run", cycle: "2", trial: "Earth", difficulty: "Hard" });
  assert.equal(sim[0].proof, null);                                                      // sent without pictures
  // Egg Heist
  assert.deepEqual([got.get("eggheist-season").value, got.get("eggheist-season").placement.position, got.get("eggheist-season").points], ["Gold Egg Hunter", 2, 500]);
  assert.deepEqual(got.get("eggheist-season").board, { mode: "eggheist", kind: "eggheist_season", cycle: "S1" });
  assert.deepEqual(place(got.get("eggheist-loot")), [900, 2, 2]);
  assert.deepEqual(place(got.get("eggheist-escape")), [300, 1, 2]);
  assert.deepEqual(got.get("eggheist-escape").board, { mode: "eggheist", kind: "eggheist_match", sort: "clear_time_s" });
  assert.deepEqual(place(got.get("eggheist-defeats")), [7, 1, 2]);
  // nothing for a mode the player has no records in
  const bravo = byId((await (await call(env, "/api/profile/overview", SESSIONS.bravo)).json()).trophies);
  assert.deepEqual(place(bravo.get("interlink-score")), [25000, 1, 2]);
  assert.equal(bravo.has("interlink-break"), false);                                     // never sent a BREAK figure
});

test("trophies: the proof is the run behind the figure; a Battle Data figure opens on that screen and says whose row it is", async () => {
  const { env } = await setup();
  const got = byId((await (await call(env, "/api/profile/overview", SESSIONS.alpha)).json()).trophies);
  assert.deepEqual(got.get("interlink-score").proof, { id: "run-a-infergon", shot: "summary", check: "verified" });
  assert.deepEqual(got.get("interlink-dps").proof, { id: "run-a-sherro", shot: "battle", check: null, slice: { figure: "Avg DPS", player: "Alpha" } });
  assert.equal(got.get("interlink-dps").submissionId, "run-a-sherro");
  assert.equal(got.get("eggheist-loot").proof.id, "egg-match-a1");
  // the picture it opens on is served to anyone, as on the boards
  const picture = await call(env, "/api/leaderboard/submissions/run-a-sherro/evidence?shot=battle");
  assert.equal(picture.status, 200);
});

test("trophies follow the profile's leaderboard standing: public, Custom without it, and closed boards", async () => {
  const { env, sqlite } = await setup();
  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pubtroph1' WHERE discord_id = ?").run(IDS.alpha);
  const shown = await (await call(env, "/api/profiles/pubtroph1")).json();
  assert.ok(shown.trophies.length > 5);
  assert.equal(JSON.stringify(shown.trophies).includes("90000000000"), false);         // never a UID
  // Custom without "leaderboard standing": no trophies for visitors; the owner still has theirs
  sqlite.prepare(`UPDATE profiles SET preferences_json = '{"visibility":{"mode":"custom","parts":["about","collection"]}}' WHERE discord_id = ?`).run(IDS.alpha);
  const custom = await (await call(env, "/api/profiles/pubtroph1")).json();
  assert.equal(custom.trophies, null);
  assert.equal(custom.leaderboards, null);
  assert.ok((await (await call(env, "/api/profile/overview", SESSIONS.alpha)).json()).trophies.length > 5);
  // with it: back
  sqlite.prepare(`UPDATE profiles SET preferences_json = '{"visibility":{"mode":"custom","parts":["standings"]}}' WHERE discord_id = ?`).run(IDS.alpha);
  assert.ok((await (await call(env, "/api/profiles/pubtroph1")).json()).trophies.length > 5);
  // boards still a developer preview: nobody's trophies show (not even the owner, who isn't a developer)
  env.LEADERBOARD_PUBLIC = "false";
  assert.equal((await (await call(env, "/api/profiles/pubtroph1")).json()).trophies, null);
  assert.equal((await (await call(env, "/api/profile/overview", SESSIONS.alpha)).json()).trophies, null);
});

test("the Trophies card: a profile panel of tiles, placement linking to the board, the shared proof viewer", () => {
  const read = (path) => readFileSync(resolve(import.meta.dirname, "..", path), "utf8").replaceAll("\r\n", "\n");
  const home = read("public/index.html");
  const app = read("public/app.js");
  const viewer = read("public/proof-viewer.js");
  // one of the grid's cards (so Arrange cards takes it in), hidden until there is a trophy
  assert.match(home, /<div class="profile-overview-grid">\s*<article class="profile-panel profile-trophies" data-overview-panel="trophies" hidden>/u);
  assert.match(app, /renderTrophies\(overview\.leaderboards \? overview\.trophies : null\);/u);
  assert.match(app, /panel\.hidden = !list\.length;/u);
  assert.match(app, /link\.href = `\/leaderboard\/\?\$\{new URLSearchParams\(trophy\.board \|\| \{\}\)\}`;/u);
  assert.match(app, /window\.AniilogsProof\.button\(proof\.id, proof\.check \|\| null, proof\.menuId \|\| null, \{ shot: proof\.shot, note \}\)/u);
  // the viewer opens on the picture asked for, with the note over it
  assert.match(viewer, /async function openProof\(submissionId, check = null, menuId = null, options = \{\}\)/u);
  assert.match(viewer, /picture\.shot === options\.shot/u);
  assert.match(viewer, /class: "lb-proof-note"/u);
  // no inline styles (CSP)
  assert.doesNotMatch(home.slice(home.indexOf('data-overview-panel="trophies"'), home.indexOf('data-overview-panel="interlink"')), /style=/u);
});
