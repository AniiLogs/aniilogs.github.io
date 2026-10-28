import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker from "../src/index.js";

const ORIGIN = "https://aniilogs.github.io";
const IDS = { dev: "111111111111111111", user: "222222222222222222" };
const SESSIONS = { dev: "d".repeat(48), user: "u".repeat(48) };
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]);

async function tokenHash(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Buffer.from(digest).toString("base64url");
}

// A D1-shaped wrapper over in-memory SQLite with every migration applied (as in leaderboard.test.js).
async function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = resolve(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(resolve(dir, file), "utf8"));
  }
  const statement = (sql, values = []) => ({
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  const DB = { prepare: (sql) => ({ ...statement(sql), bind: (...values) => statement(sql, values) }) };
  const now = Math.floor(Date.now() / 1000);
  for (const [key, discordId] of Object.entries(IDS)) {
    sqlite.prepare("INSERT INTO users VALUES (?, ?, ?, NULL, ?, ?)").run(discordId, key, `${key} name`, now, now);
    sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(await tokenHash(SESSIONS[key]), discordId, now, now + 3600);
  }
  const objects = new Map();
  const EVIDENCE = {
    objects,
    async put(key, body, options) { objects.set(key, { bytes: new Uint8Array(await new Response(body).arrayBuffer()), meta: options }); },
    async get(key) { const o = objects.get(key); return o ? { body: o.bytes } : null; },
    async delete(key) { objects.delete(key); },
  };
  const env = { DB, EVIDENCE, PUBLIC_SITE_ORIGIN: ORIGIN, DEVELOPER_DISCORD_IDS: IDS.dev, SESSION_SECRET: "s".repeat(40) };
  return { env, sqlite, objects };
}

// The app: no cookie, its own origin, the client address as Cloudflare passes it.
function send(env, { uid = "302000105986", note = "HP number stuck", zip = ZIP, ip = "203.0.113.5" } = {}) {
  const form = new FormData();
  if (uid !== null) form.set("uid", uid);
  if (note) form.set("note", note);
  form.set("app_version", "0.1.28+rc.15");
  if (zip) form.set("logs", new Blob([zip], { type: "application/zip" }), "logs.zip");
  const headers = new Headers({ origin: "http://tauri.localhost", "cf-connecting-ip": ip });
  return worker.fetch(new Request("https://api.aniilogs.example/api/logs/reports", { method: "POST", headers, body: form }), env);
}

function admin(env, path, { session = SESSIONS.dev, method = "GET" } = {}) {
  const headers = new Headers({ authorization: `Bearer ${session}`, origin: ORIGIN });
  return worker.fetch(new Request(`https://api.aniilogs.example${path}`, { method, headers }), env);
}

test("the app sends a log report: stored privately with the UID, note and time, readable by the app's origin", async () => {
  const { env, sqlite, objects } = await setup();
  const response = await send(env);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const { reportId } = await response.json();
  const row = sqlite.prepare("SELECT * FROM log_reports WHERE report_id = ?").get(reportId);
  assert.equal(row.game_uid, "302000105986");
  assert.equal(row.note, "HP number stuck");
  assert.equal(row.app_version, "0.1.28+rc.15");
  assert.ok(Math.abs(row.created_at - Date.now() / 1000) < 5);
  assert.notEqual(row.ip_hash, "203.0.113.5");
  assert.deepEqual([...objects.get(row.log_key).bytes], [...ZIP]);
});

test("a report needs a UID and a zip of logs", async () => {
  const { env, objects } = await setup();
  assert.equal((await send(env, { uid: null })).status, 400);
  assert.equal((await send(env, { uid: "abc" })).status, 400);
  assert.equal((await send(env, { zip: null })).status, 400);
  assert.equal((await send(env, { zip: new TextEncoder().encode("not a zip") })).status, 400);
  assert.equal(objects.size, 0);
});

test("reports are rate limited per UID and per address", async () => {
  const { env } = await setup();
  for (let i = 0; i < 5; i += 1) assert.equal((await send(env, { ip: `198.51.100.${i}` })).status, 201);
  assert.equal((await send(env, { ip: "198.51.100.99" })).status, 429);                    // 6th from one UID
  for (let i = 0; i < 10; i += 1) assert.equal((await send(env, { uid: `3030000000${i}0`, ip: "192.0.2.1" })).status, 201);
  assert.equal((await send(env, { uid: "304000000000", ip: "192.0.2.1" })).status, 429);  // 11th from one address
});

test("developers list, download and clear reports; others can't", async () => {
  const { env, objects } = await setup();
  const { reportId } = await (await send(env)).json();
  await send(env, { uid: "302000000001", ip: "192.0.2.9" });
  assert.equal((await admin(env, "/api/admin/log-reports", { session: SESSIONS.user })).status, 403);
  const list = await (await admin(env, "/api/admin/log-reports")).json();
  assert.equal(list.reports.length, 2);
  assert.equal(list.reports.find((r) => r.id === reportId).note, "HP number stuck");
  assert.ok(!("ipHash" in list.reports[0]) && !("ip_hash" in list.reports[0]));
  const zip = await admin(env, `/api/admin/log-reports/${reportId}`);
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get("content-type"), "application/zip");
  assert.deepEqual([...new Uint8Array(await zip.arrayBuffer())], [...ZIP]);
  assert.equal((await admin(env, `/api/admin/log-reports/${reportId}`, { method: "DELETE", session: SESSIONS.user })).status, 403);
  assert.equal((await admin(env, `/api/admin/log-reports/${reportId}`, { method: "DELETE" })).status, 200);
  assert.equal(objects.size, 1);
  assert.deepEqual(await (await admin(env, "/api/admin/log-reports", { method: "DELETE" })).json(), { ok: true, cleared: 1 });
  assert.equal(objects.size, 0);
});

test("reports older than 30 days are cleared when a new one comes in", async () => {
  const { env, sqlite, objects } = await setup();
  const { reportId } = await (await send(env)).json();
  sqlite.prepare("UPDATE log_reports SET created_at = created_at - 31 * 86400 WHERE report_id = ?").run(reportId);
  await send(env, { uid: "302000000001" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM log_reports").get().n, 1);
  assert.equal(objects.size, 1);
});
