import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker from "../src/index.js";

// ?profile=<game UID>: a character's UID opens its account's public profile, says "private" when that profile isn't
// public, and is "not found" when no account linked it. Profile ids keep working.
const ORIGIN = "https://aniilogs.github.io";
const OWNER = "111111111111111111", SESSION = "o".repeat(48), UID = "302000105986";
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
  const DB = { prepare: (sql) => ({ ...statement(sql), bind: (...values) => statement(sql, values) }), async batch(list) { return Promise.all(list.map((s) => s.run())); } };
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare("INSERT INTO users VALUES (?, ?, ?, NULL, ?, ?)").run(OWNER, "owner", "owner name", now, now);
  sqlite.prepare("INSERT INTO profiles (discord_id, display_name, bio, is_public, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)").run(OWNER, "owner name", now, now);
  sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(await tokenHash(SESSION), OWNER, now, now + 3600);
  sqlite.prepare("INSERT INTO game_characters (game_uid, discord_id, character_name, source, linked_at, last_seen_at) VALUES (?, ?, ?, 'meter', ?, ?)")
    .run(UID, OWNER, "MinMax", now, now);
  return { env: { DB, PUBLIC_SITE_ORIGIN: ORIGIN, LEADERBOARD_PUBLIC: "true", SESSION_SECRET: "s".repeat(40) }, sqlite };
}
const site = (env, path, session) => {
  const headers = new Headers({ origin: ORIGIN });
  if (session) headers.set("authorization", `Bearer ${session}`);
  return worker.fetch(new Request(`https://api.aniilogs.example${path}`, { headers }), env);
};

test("a game UID opens its account's public profile, or says it is private", async () => {
  const { env, sqlite } = await setup();
  // private profile: the UID says so (the page shows "This profile is private")
  const hidden = await site(env, `/api/profiles/${UID}`);
  assert.equal(hidden.status, 404);
  assert.equal((await hidden.json()).private, true);
  assert.equal((await (await site(env, `/api/profiles/${UID}/history`)).json()).private, true);
  // public: the UID and the profile id show the same profile
  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pub12345' WHERE discord_id = ?").run(OWNER);
  const byUid = await site(env, `/api/profiles/${UID}`);
  assert.equal(byUid.status, 200);
  const byId = await (await site(env, "/api/profiles/pub12345")).json();
  assert.deepEqual((await byUid.json()).profile, byId.profile);
  // a UID no account linked: not found (not "private")
  const unknown = await site(env, "/api/profiles/999999999999");
  assert.equal(unknown.status, 404);
  assert.notEqual((await unknown.json()).private, true);
  // the owner's own profile gives the UID as the link's address
  assert.equal((await (await site(env, "/api/profile", SESSION)).json()).profile.profileUid, UID);
  assert.equal((await (await site(env, "/api/profile/overview", SESSION)).json()).profile.profileUid, UID);
});
