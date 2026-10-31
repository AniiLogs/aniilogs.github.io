import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker, { cleanCharacterStats } from "../src/index.js";

const ORIGIN = "https://aniilogs.github.io";
const IDS = { owner: "111111111111111111", other: "222222222222222222" };
const SESSIONS = { owner: "o".repeat(48), other: "x".repeat(48) };
async function tokenHash(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Buffer.from(digest).toString("base64url");
}

// A D1-shaped wrapper over in-memory SQLite with every migration applied (as in leaderboard.test.js).
async function setup() {
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
  }
  sqlite.prepare("INSERT INTO game_characters (game_uid, discord_id, character_name, source, linked_at, last_seen_at) VALUES (?, ?, ?, 'meter', ?, ?)")
    .run("302000105986", IDS.owner, "MinMax", now, now);
  const objects = new Map();
  const EVIDENCE = {
    objects,
    async put(key, body) { objects.set(key, new Uint8Array(await new Response(body).arrayBuffer())); },
    async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
    async delete(key) { objects.delete(key); },
  };
  const env = { DB, EVIDENCE, PUBLIC_SITE_ORIGIN: ORIGIN, LEADERBOARD_PUBLIC: "true", SESSION_SECRET: "s".repeat(40) };
  return { env, sqlite, objects };
}

const site = (env, path, { session, method = "GET", body } = {}) => {
  const headers = new Headers({ origin: ORIGIN });
  if (session) headers.set("authorization", `Bearer ${session}`);
  if (body) headers.set("content-type", "application/json");
  return worker.fetch(new Request(`https://api.aniilogs.example${path}`, { method, headers, body: body && JSON.stringify(body) }), env);
};
async function appToken(env, session) {
  return (await (await site(env, "/api/leaderboard/tokens", { session, method: "POST", body: { label: "PC" } })).json()).token;
}
// the app: its own origin, its desktop token
function app(env, token, path, body) {
  return worker.fetch(new Request(`https://api.aniilogs.example${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, origin: "http://tauri.localhost", "content-type": "application/json" },
  }), env);
}
const STATS = { aniimoPoint: 206, sparklingAniimo: 77, stylePoints: 6115, prismanaAniimo: 27 };

test("stats are whole numbers in range, the four known ones only", () => {
  assert.deepEqual(cleanCharacterStats({ ...STATS, extra: 5 }), STATS);
  assert.deepEqual(cleanCharacterStats({ stylePoints: 3850 }), { stylePoints: 3850 });
  assert.equal(cleanCharacterStats({ aniimoPoint: 1.5 }), null);
  assert.equal(cleanCharacterStats({ aniimoPoint: -1 }), null);
  assert.equal(cleanCharacterStats({ aniimoPoint: "206" }), null);
  assert.equal(cleanCharacterStats({}), null);
  assert.equal(cleanCharacterStats(null), null);
});

test("the meter's Profile screen numbers go on the profile, for a proven character of this account only", async () => {
  const { env, sqlite } = await setup();
  const token = await appToken(env, SESSIONS.owner);
  // linked but not proven yet: refused
  assert.equal((await app(env, token, "/api/leaderboard/characters/stats", { gameUid: "302000105986", stats: STATS })).status, 409);
  sqlite.prepare("UPDATE game_characters SET verified_at = 1 WHERE game_uid = ?").run("302000105986");
  const sent = await app(env, token, "/api/leaderboard/characters/stats", { gameUid: "302000105986", stats: STATS });
  assert.equal(sent.status, 200);
  assert.equal((await app(env, token, "/api/leaderboard/characters/stats", { gameUid: "302000105986", stats: { aniimoPoint: 2.5 } })).status, 400);
  // someone else's character: refused
  const other = await appToken(env, SESSIONS.other);
  assert.equal((await app(env, other, "/api/leaderboard/characters/stats", { gameUid: "302000105986", stats: STATS })).status, 409);
  const own = await (await site(env, "/api/profile/overview", { session: SESSIONS.owner })).json();
  assert.deepEqual({ ...own.gameStats, seenAt: undefined }, { ...STATS, seenAt: undefined });
  assert.ok(own.gameStats.seenAt > 0);
  // a public profile shows them too
  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pub12345' WHERE discord_id = ?").run(IDS.owner);
  const shown = await (await site(env, "/api/profiles/pub12345")).json();
  assert.equal(shown.gameStats.stylePoints, 6115);
});

test("the character's level (from the EXP card) is kept beside the Profile numbers and shown with the character", async () => {
  const { env, sqlite } = await setup();
  const token = await appToken(env, SESSIONS.owner);
  sqlite.prepare("UPDATE game_characters SET verified_at = 1 WHERE game_uid = ?").run("302000105986");
  const send = (stats) => app(env, token, "/api/leaderboard/characters/stats", { gameUid: "302000105986", stats });
  assert.equal((await send(STATS)).status, 200);
  assert.equal((await send({ level: 64 })).status, 200);
  assert.equal((await send({ level: 0 })).status, 400);
  assert.equal((await send({ level: 201 })).status, 400);
  const own = await (await site(env, "/api/profile/overview", { session: SESSIONS.owner })).json();
  assert.equal(own.gameStats.stylePoints, 6115);                  // the level didn't replace the Profile numbers
  assert.equal(own.characters[0].level, 64);
  assert.equal((await send({ ...STATS, stylePoints: 7000 })).status, 200);
  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pub12345' WHERE discord_id = ?").run(IDS.owner);
  const shown = await (await site(env, "/api/profiles/pub12345")).json();
  assert.equal(shown.gameStats.stylePoints, 7000);
  assert.deepEqual(shown.characters, [{ name: "MinMax", level: 64 }]);    // and neither replaced the level
});

test("the EXP card's progress into the level (exp of expNeeded) goes with the level, only as a pair, and resets with a new level", async () => {
  const { env, sqlite } = await setup();
  const token = await appToken(env, SESSIONS.owner);
  sqlite.prepare("UPDATE game_characters SET verified_at = 1 WHERE game_uid = ?").run("302000105986");
  const send = (stats) => app(env, token, "/api/leaderboard/characters/stats", { gameUid: "302000105986", stats });
  const own = async () => (await (await site(env, "/api/profile/overview", { session: SESSIONS.owner })).json()).characters[0];
  assert.equal((await send({ level: 64, exp: 5085, expNeeded: 80000, server: "Aniimo-Americas" })).status, 200);
  assert.deepEqual([(await own()).level, (await own()).exp, (await own()).expNeeded], [64, 5085, 80000]);
  assert.equal((await send({ level: 64, exp: 90000, expNeeded: 80000 })).status, 400);    // more than the level needs
  assert.equal((await send({ level: 64, exp: 0, expNeeded: 0 })).status, 400);
  assert.equal((await send({ level: 64, exp: -1, expNeeded: 80000 })).status, 400);
  assert.equal((await send({ level: 64, exp: 5.5, expNeeded: 80000 })).status, 400);
  assert.equal((await send({ level: 64, exp: 6000 })).status, 200);                       // a lone one is dropped
  assert.equal((await own()).exp, 5085);
  assert.equal((await send({ level: 64, exp: 7000, expNeeded: 80000 })).status, 200);     // EXP went up
  assert.equal((await own()).exp, 7000);
  assert.equal((await send({ level: 65 })).status, 200);                                  // a new level without its EXP
  assert.deepEqual([(await own()).level, (await own()).exp, (await own()).expNeeded], [65, undefined, undefined]);
  assert.equal((await send({ level: 65, exp: 100, expNeeded: 82000 })).status, 200);
  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pub12345' WHERE discord_id = ?").run(IDS.owner);
  const shown = await (await site(env, "/api/profiles/pub12345")).json();
  assert.deepEqual(shown.characters, [{ name: "MinMax", level: 65, exp: 100, expNeeded: 82000, server: "Aniimo-Americas" }]);
});

test("the character's gender and server go beside it too; only female/male and a plain server name", async () => {
  const { env, sqlite } = await setup();
  const token = await appToken(env, SESSIONS.owner);
  sqlite.prepare("UPDATE game_characters SET verified_at = 1 WHERE game_uid = ?").run("302000105986");
  const send = (stats) => app(env, token, "/api/leaderboard/characters/stats", { gameUid: "302000105986", stats });
  assert.equal((await send({ ...STATS, gender: "female", server: "Aniimo-Americas" })).status, 200);
  assert.equal((await send({ level: 64, server: "Aniimo-Americas" })).status, 200);
  assert.equal((await send({ gender: "other" })).status, 400);
  assert.equal((await send({ server: "<b>x</b>" })).status, 400);
  assert.equal((await send({ server: "x".repeat(41) })).status, 400);
  const own = await (await site(env, "/api/profile/overview", { session: SESSIONS.owner })).json();
  assert.deepEqual({ ...own.characters[0], lastSeenAt: undefined },
    { gameUid: "302000105986", name: "MinMax", lastSeenAt: undefined, level: 64, gender: "female", server: "Aniimo-Americas" });
  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pub12345' WHERE discord_id = ?").run(IDS.owner);
  const shown = await (await site(env, "/api/profiles/pub12345")).json();
  assert.deepEqual(shown.characters, [{ name: "MinMax", level: 64, gender: "female", server: "Aniimo-Americas" }]);
});

test("Online / AFK from the app shows on the profile for 5 minutes; offline, stale or unproven shows nothing", async () => {
  const { env, sqlite } = await setup();
  const token = await appToken(env, SESSIONS.owner);
  const send = (state, gameUid = "302000105986") => app(env, token, "/api/leaderboard/characters/presence", { gameUid, state });
  const presence = async () => (await (await site(env, "/api/profile/overview", { session: SESSIONS.owner })).json()).presence;
  assert.equal((await send("online")).status, 409);                // not proven yet
  sqlite.prepare("UPDATE game_characters SET verified_at = 1 WHERE game_uid = ?").run("302000105986");
  assert.equal(await presence(), "offline");                        // a character, never heard from
  assert.equal((await send("online")).status, 200);
  assert.equal(await presence(), "online");
  assert.equal((await send("afk")).status, 200);
  assert.equal(await presence(), "afk");
  assert.equal((await send("asleep")).status, 400);
  const other = await appToken(env, SESSIONS.other);
  assert.equal((await app(env, other, "/api/leaderboard/characters/presence", { gameUid: "302000105986", state: "offline" })).status, 409);
  assert.equal(await presence(), "afk");                            // someone else can't change it
  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pub12345' WHERE discord_id = ?").run(IDS.owner);
  assert.equal((await (await site(env, "/api/profiles/pub12345")).json()).presence, "afk");
  sqlite.prepare("UPDATE game_characters SET presence_at = presence_at - 301").run();
  assert.equal(await presence(), "offline");                        // not heard from in 5 minutes
  await send("online");
  await send("offline");
  assert.equal(await presence(), "offline");
  // the owner turns it off (Edit profile): no status anywhere, and nothing sent afterwards is kept
  await send("online");
  const off = await site(env, "/api/profile", { session: SESSIONS.owner, method: "PATCH", body: { displayName: "owner name", showPresence: false } });
  assert.equal((await off.json()).profile.showPresence, false);
  assert.equal(await presence(), null);
  assert.equal((await (await site(env, "/api/profiles/pub12345")).json()).presence, null);
  assert.equal((await (await send("online")).json()).shown, false);
  assert.equal(sqlite.prepare("SELECT presence_state FROM game_characters").get().presence_state, null);
  await site(env, "/api/profile", { session: SESSIONS.owner, method: "PATCH", body: { displayName: "owner name", showPresence: true } });
  sqlite.prepare("DELETE FROM game_characters").run();
  assert.equal(await presence(), null);                              // no character: no status at all
});

test("the site and the app share Show my online status and the theme, through the account", async () => {
  const { env, sqlite } = await setup();
  const token = await appToken(env, SESSIONS.owner);
  const prefs = async (body) => (await (body
    ? await app(env, token, "/api/account/preferences", body)
    : await worker.fetch(new Request("https://api.aniilogs.example/api/account/preferences", {
      headers: { authorization: `Bearer ${token}`, origin: "http://tauri.localhost" } }), env)).json());
  assert.deepEqual(await prefs(), { showPresence: true, theme: null });            // defaults
  sqlite.prepare("UPDATE game_characters SET verified_at = 1, presence_state = 'online', presence_at = ? WHERE game_uid = ?")
    .run(Math.floor(Date.now() / 1000), "302000105986");
  assert.equal((await prefs({ showPresence: false })).showPresence, false);        // from the app
  assert.equal(sqlite.prepare("SELECT presence_state FROM game_characters").get().presence_state, null);
  assert.equal((await (await site(env, "/api/profile", { session: SESSIONS.owner })).json()).profile.showPresence, false);
  await site(env, "/api/profile", { session: SESSIONS.owner, method: "PATCH", body: { displayName: "owner name", showPresence: true } });
  assert.equal((await prefs()).showPresence, true);                                // changed on the site: the app sees it
  // the theme: set on the site, read by the app; Custom keeps its colours
  const fromSite = await site(env, "/api/account/preferences", { session: SESSIONS.owner, method: "POST", body: { theme: { id: "pawney" } } });
  assert.equal(fromSite.status, 200);
  assert.deepEqual((await prefs()).theme, { id: "pawney" });
  const custom = { id: "custom", custom: { surface: "#101820", accent: "#FF8800" } };
  assert.deepEqual((await prefs({ theme: custom })).theme, custom);
  assert.equal((await prefs()).showPresence, true);                                // the theme left the other alone
  for (const theme of [{ id: "Bad Id" }, { id: "custom", custom: { surface: "red" } }, "pawney"]) {
    assert.equal((await app(env, token, "/api/account/preferences", { theme })).status, 400);
  }
  assert.equal((await app(env, token, "/api/account/preferences", { showPresence: "no" })).status, 400);
  const response = await app(env, token, "/api/account/preferences", { theme: { id: "meadow" } });
  assert.equal(response.headers.get("access-control-allow-origin"), "*");          // the app's own origin may call it
});

test("the Profiles page's directory: public profiles only by name, private players online only counted", async () => {
  const { env, sqlite } = await setup();
  const directory = async () => (await (await site(env, "/api/profiles/directory")).json());
  assert.deepEqual(await directory(), { recent: [], online: { players: [], others: 0 } });
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare("UPDATE game_characters SET verified_at = 1, presence_state = 'online', presence_at = ?").run(now);
  sqlite.prepare("INSERT INTO game_characters (game_uid, discord_id, character_name, source, linked_at, last_seen_at, verified_at, presence_state, presence_at) VALUES (?, ?, ?, 'meter', ?, ?, 1, 'afk', ?)")
    .run("302000200001", IDS.other, "Hidden", now, now, now);
  assert.deepEqual((await directory()).online, { players: [], others: 2 });            // both private: a count, no names
  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pub12345' WHERE discord_id = ?").run(IDS.owner);
  const open = await directory();
  assert.deepEqual(open.recent.map((row) => [row.publicId, row.name]), [["pub12345", "MinMax"]]);   // the character, not the display name
  assert.deepEqual(open.online, { players: [{ publicId: "pub12345", name: "MinMax", state: "online" }], others: 1 });
  sqlite.prepare("UPDATE profiles SET findable_by_name = 1 WHERE discord_id = ?").run(IDS.owner);
  assert.equal((await directory()).recent[0].name, "owner name");                     // opted in: the display name
  sqlite.prepare("UPDATE game_characters SET presence_at = presence_at - 301").run();
  assert.deepEqual((await directory()).online, { players: [], others: 0 });            // nothing heard for 5 minutes
  assert.equal(JSON.stringify(await directory()).includes(IDS.owner), false);
});

test("the owner arranges the profile's cards; a card added later shows up without a server change", async () => {
  const { env, sqlite } = await setup();
  const layout = (body, session = SESSIONS.owner) => site(env, "/api/profile/layout", { session, method: "PUT", body });
  const overview = async () => (await (await site(env, "/api/profile/overview", { session: SESSIONS.owner })).json());
  assert.deepEqual((await overview()).layout, { order: [], hidden: [] });                // the site's default
  assert.equal((await layout({ order: ["sim", "interlink"], hidden: ["photos"] }, "")).status, 401);
  const saved = await layout({ order: ["sim", "interlink", "fake-new-card", "sim"], hidden: ["photos"] });
  assert.deepEqual((await saved.json()).layout, { order: ["sim", "interlink", "fake-new-card"], hidden: ["photos"] });
  assert.deepEqual((await overview()).layout, { order: ["sim", "interlink", "fake-new-card"], hidden: ["photos"] });
  assert.equal((await layout({ order: ["Bad Id"] })).status, 400);
  assert.equal((await layout({ order: "sim" })).status, 400);
  // the public view shows the owner's arrangement; "own" only for the owner
  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pub12345' WHERE discord_id = ?").run(IDS.owner);
  const asOwner = await (await site(env, "/api/profiles/pub12345", { session: SESSIONS.owner })).json();
  const asOther = await (await site(env, "/api/profiles/pub12345", { session: SESSIONS.other })).json();
  assert.equal(asOwner.own, true);
  assert.equal(asOther.own, undefined);
  assert.deepEqual(asOther.layout.hidden, ["photos"]);
  assert.equal((await overview()).profile.publicId, "pub12345");
  // the theme kept beside it; Reset puts the default back
  await site(env, "/api/account/preferences", { session: SESSIONS.owner, method: "POST", body: { theme: { id: "pawney" } } });
  assert.deepEqual((await (await layout({ order: [], hidden: [] })).json()).layout, { order: [], hidden: [] });
  assert.deepEqual((await overview()).layout, { order: [], hidden: [] });
  assert.equal(JSON.parse(sqlite.prepare("SELECT preferences_json FROM profiles WHERE discord_id = ?").get(IDS.owner).preferences_json).theme.id, "pawney");
});
