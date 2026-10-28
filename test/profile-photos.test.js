import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker from "../src/index.js";

const ORIGIN = "https://aniilogs.github.io";
const IDS = { owner: "111111111111111111", other: "222222222222222222" };
const SESSIONS = { owner: "o".repeat(48), other: "x".repeat(48) };
const WEBP = new Uint8Array([...new TextEncoder().encode("RIFF"), 9, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 "), 1, 2, 3]);
const META = { gamePhotoId: "45e8358546cfe140afeb86e6872a6ccb", gameUid: "302000105986", takenAt: 1790206240, sceneId: 3000,
  pos: { x: -809.5, y: 43.3, z: 837.3 }, aniimo: [1002500, 1016100, 1016100], width: 2560, height: 1440 };

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
function app(env, token, path, { method = "GET", form } = {}) {
  return worker.fetch(new Request(`https://api.aniilogs.example${path}`, {
    method, body: form, headers: { authorization: `Bearer ${token}`, origin: "http://tauri.localhost" },
  }), env);
}
function photoForm(meta = META, bytes = WEBP) {
  const form = new FormData();
  form.set("photo", new Blob([bytes], { type: "image/webp" }), "photo.webp");
  form.set("meta", JSON.stringify(meta));
  return form;
}

test("the app uploads a photo once: stored privately with what the game recorded; WebP only", async () => {
  const { env, objects } = await setup();
  const token = await appToken(env, SESSIONS.owner);
  const first = await app(env, token, "/api/profile/photos", { method: "POST", form: photoForm() });
  assert.equal(first.status, 201);
  assert.equal(first.headers.get("access-control-allow-origin"), "*");
  const { id } = await first.json();
  assert.equal(objects.size, 1);
  const again = await (await app(env, token, "/api/profile/photos", { method: "POST", form: photoForm() })).json();
  assert.deepEqual([again.id, again.duplicate], [id, true]);
  assert.equal(objects.size, 1);
  assert.equal((await app(env, token, "/api/profile/photos", { method: "POST", form: photoForm({ ...META, gamePhotoId: "aaaaaaaaaaaa" }, new TextEncoder().encode("\x89PNG....")) })).status, 400);
  assert.equal((await app(env, token, "/api/profile/photos", { method: "POST", form: photoForm({ ...META, gamePhotoId: "" }) })).status, 400);
  const { photos } = await (await app(env, token, "/api/profile/photos")).json();
  assert.equal(photos.length, 1);
  assert.deepEqual({ ...photos[0], id: undefined, url: undefined }, { id: undefined, url: undefined, takenAt: 1790206240, character: "MinMax",
    sceneId: 3000, pos: { x: -809.5, y: 43.3, z: 837.3 }, aniimo: [1002500, 1016100], width: 2560, height: 1440,
    gameUid: "302000105986", gamePhotoId: META.gamePhotoId });
});

test("a photo can't be filed under someone else's character", async () => {
  const { env } = await setup();
  const token = await appToken(env, SESSIONS.other);
  assert.equal((await app(env, token, "/api/profile/photos", { method: "POST", form: photoForm() })).status, 409);
});

test("photos follow the profile: owner only while private, everyone once public, never the UID in public", async () => {
  const { env, sqlite } = await setup();
  const token = await appToken(env, SESSIONS.owner);
  const { id } = await (await app(env, token, "/api/profile/photos", { method: "POST", form: photoForm() })).json();
  assert.equal((await site(env, `/api/photos/${id}`)).status, 404);                                // private: not for others
  assert.equal((await site(env, `/api/photos/${id}`, { session: SESSIONS.other })).status, 404);
  const own = await site(env, `/api/photos/${id}`, { session: SESSIONS.owner });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("cache-control"), "private, no-store");
  const overview = await (await site(env, "/api/profile/overview", { session: SESSIONS.owner })).json();
  assert.equal(overview.photos[0].gameUid, "302000105986");

  sqlite.prepare("UPDATE profiles SET is_public = 1, public_id = 'pubpubpub1' WHERE discord_id = ?").run(IDS.owner);
  const open = await site(env, `/api/photos/${id}`);
  assert.equal(open.status, 200);
  assert.equal(open.headers.get("content-type"), "image/webp");
  const shown = await (await site(env, "/api/profiles/pubpubpub1")).json();
  assert.equal(shown.photos.length, 1);
  assert.equal(shown.photos[0].character, "MinMax");
  assert.ok(!("gameUid" in shown.photos[0]) && !("gamePhotoId" in shown.photos[0]));
});

test("owners delete their photos; others can't", async () => {
  const { env, objects } = await setup();
  const token = await appToken(env, SESSIONS.owner);
  const other = await appToken(env, SESSIONS.other);
  const { id } = await (await app(env, token, "/api/profile/photos", { method: "POST", form: photoForm() })).json();
  assert.equal((await app(env, other, `/api/profile/photos/${id}`, { method: "DELETE" })).status, 403);
  assert.equal((await app(env, token, `/api/profile/photos/${id}`, { method: "DELETE" })).status, 200);
  assert.equal(objects.size, 0);
  assert.equal((await site(env, `/api/photos/${id}`, { session: SESSIONS.owner })).status, 404);
});
