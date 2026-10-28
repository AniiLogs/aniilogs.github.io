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
  const env = { DB, EVIDENCE, PUBLIC_SITE_ORIGIN: ORIGIN, DEVELOPER_DISCORD_IDS: IDS.dev, ADMIN_DISCORD_IDS: IDS.dev, SESSION_SECRET: "s".repeat(40) };
  return { env, sqlite, objects };
}

// The app: no cookie, its own origin, the client address as Cloudflare passes it.
function send(env, { uid = "302000105986", note = "HP number stuck", zip = ZIP, ip = "203.0.113.5", shots = [] } = {}) {
  const form = new FormData();
  if (uid !== null) form.set("uid", uid);
  if (note) form.set("note", note);
  form.set("app_version", "0.1.28+rc.15");
  if (zip) form.set("logs", new Blob([zip], { type: "application/zip" }), "logs.zip");
  for (const shot of shots) form.append("screenshot", new Blob([shot]), "shot");
  const headers = new Headers({ origin: "http://tauri.localhost", "cf-connecting-ip": ip });
  return worker.fetch(new Request("https://api.aniilogs.example/api/logs/reports", { method: "POST", headers, body: form }), env);
}

function admin(env, path, { session = SESSIONS.dev, method = "GET", body } = {}) {
  const headers = new Headers({ authorization: `Bearer ${session}`, origin: ORIGIN });
  if (body) headers.set("content-type", "application/json");
  return worker.fetch(new Request(`https://api.aniilogs.example${path}`, { method, headers, body: body && JSON.stringify(body) }), env);
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

test("developers list and download reports; players can't", async () => {
  const { env } = await setup();
  const { reportId } = await (await send(env)).json();
  await send(env, { uid: "302000000001", ip: "192.0.2.9" });
  assert.equal((await admin(env, "/api/admin/log-reports", { session: SESSIONS.user })).status, 403);
  const list = await (await admin(env, "/api/admin/log-reports")).json();
  assert.equal(list.reports.length, 2);
  const report = list.reports.find((r) => r.id === reportId);
  assert.equal(report.note, "HP number stuck");
  assert.deepEqual(report.notes, []);
  assert.ok(!("ipHash" in report) && !("ip_hash" in report));
  const zip = await admin(env, `/api/admin/log-reports/${reportId}`);
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get("content-type"), "application/zip");
  assert.deepEqual([...new Uint8Array(await zip.arrayBuffer())], [...ZIP]);
  assert.equal((await admin(env, `/api/admin/log-reports/${reportId}`, { session: SESSIONS.user })).status, 403);
});

test("developers leave notes; only administrators clear, and clearing keeps the report's line and notes", async () => {
  const { env, sqlite, objects } = await setup();
  sqlite.prepare("INSERT INTO developer_roles (discord_id, granted_by_discord_id, created_at) VALUES (?, ?, ?)").run(IDS.user, IDS.dev, 1);
  const { reportId } = await (await send(env)).json();
  const path = `/api/admin/log-reports/${reportId}`;
  // a developer who isn't an administrator: notes yes, clearing no
  assert.equal((await admin(env, `${path}/notes`, { session: SESSIONS.user, method: "POST", body: {} })).status, 400);
  assert.equal((await admin(env, `${path}/notes`, { session: SESSIONS.user, method: "POST",
    body: { note: "Bar read stalled after BREAK; fixed in PR #12" } })).status, 201);
  const refused = await admin(env, path, { session: SESSIONS.user, method: "DELETE" });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /leave a note/u);
  assert.equal(objects.size, 1);
  const [report] = (await (await admin(env, "/api/admin/log-reports")).json()).reports;
  assert.equal(report.notes.length, 1);
  assert.equal(report.notes[0].note, "Bar read stalled after BREAK; fixed in PR #12");
  assert.equal(report.notes[0].author, "user name");
  // the administrator clears it: the logs go, the line and notes stay (in ?all=1)
  assert.equal((await admin(env, path, { method: "DELETE" })).status, 200);
  assert.equal(objects.size, 0);
  assert.equal((await (await admin(env, "/api/admin/log-reports")).json()).reports.length, 0);
  const [kept] = (await (await admin(env, "/api/admin/log-reports?all=1")).json()).reports;
  assert.ok(kept.clearedAt);
  assert.equal(kept.notes[0].note, "Bar read stalled after BREAK; fixed in PR #12");
  assert.equal((await admin(env, path)).status, 410);
  assert.equal((await admin(env, path, { method: "DELETE" })).status, 404);
  // a note can't go on a report that doesn't exist
  assert.equal((await admin(env, "/api/admin/log-reports/nonexistent123/notes", { method: "POST", body: { note: "x" } })).status, 404);
});

test("developers use their aLogs app sign-in too; players' app sign-ins are refused", async () => {
  const { env } = await setup();
  const { reportId } = await (await send(env)).json();
  const appToken = async (session) => (await (await admin(env, "/api/leaderboard/tokens", { session, method: "POST" })).json()).token;
  const app = (token, path, method = "GET", body) => worker.fetch(new Request(`https://api.aniilogs.example${path}`, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, origin: "http://tauri.localhost", ...(body ? { "content-type": "application/json" } : {}) },
  }), env);
  const devToken = await appToken(SESSIONS.dev);
  const userToken = await appToken(SESSIONS.user);
  assert.match(devToken, /^alb_/u);
  assert.equal((await app(userToken, "/api/admin/log-reports")).status, 403);
  const list = await app(devToken, "/api/admin/log-reports");
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("access-control-allow-origin"), "*");
  assert.equal((await list.json()).reports[0].id, reportId);
  assert.equal((await app(devToken, `/api/admin/log-reports/${reportId}`)).status, 200);
  assert.equal((await app(userToken, `/api/admin/log-reports/${reportId}/notes`, "POST", { note: "hi" })).status, 403);
  assert.equal((await app(devToken, `/api/admin/log-reports/${reportId}/notes`, "POST", { note: "looked at it" })).status, 201);
  assert.equal((await app(devToken, `/api/admin/log-reports/${reportId}`, "DELETE")).status, 200);    // dev is also admin
});

test("a developer role granted on the site counts, not just the built-in developers", async () => {
  const { env, sqlite } = await setup();
  await send(env);
  assert.equal((await admin(env, "/api/admin/log-reports", { session: SESSIONS.user })).status, 403);
  sqlite.prepare("INSERT INTO developer_roles (discord_id, granted_by_discord_id, created_at) VALUES (?, ?, ?)").run(IDS.user, IDS.dev, 1);
  assert.equal((await admin(env, "/api/admin/log-reports", { session: SESSIONS.user })).status, 200);
});

test("reports older than 30 days lose their logs when a new one comes in; their line stays", async () => {
  const { env, sqlite, objects } = await setup();
  const { reportId } = await (await send(env)).json();
  sqlite.prepare("UPDATE log_reports SET created_at = created_at - 31 * 86400 WHERE report_id = ?").run(reportId);
  await send(env, { uid: "302000000001" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM log_reports WHERE cleared_at IS NULL").get().n, 1);
  assert.ok(sqlite.prepare("SELECT cleared_at FROM log_reports WHERE report_id = ?").get(reportId).cleared_at);
  assert.equal(objects.size, 1);
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = new Uint8Array([...new TextEncoder().encode("RIFF"), 9, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 "), 1, 2]);

test("players add up to 5 screenshots; developers download them; clearing deletes them", async () => {
  const { env, objects } = await setup();
  const sent = await send(env, { shots: [PNG, JPEG, WEBP] });
  assert.equal(sent.status, 201);
  const { reportId, screenshots } = await sent.json();
  assert.equal(screenshots, 3);
  assert.equal(objects.size, 4);                                   // the zip and three pictures
  const report = (await (await admin(env, "/api/admin/log-reports")).json()).reports.find((r) => r.id === reportId);
  assert.equal(report.screenshots, 3);
  assert.ok(!("shotsJson" in report));
  assert.equal((await admin(env, `/api/admin/log-reports/${reportId}/screenshots/1`, { session: SESSIONS.user })).status, 403);
  const first = await admin(env, `/api/admin/log-reports/${reportId}/screenshots/1`);
  assert.equal(first.headers.get("content-type"), "image/png");
  assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [...PNG]);
  assert.equal((await admin(env, `/api/admin/log-reports/${reportId}/screenshots/3`)).headers.get("content-type"), "image/webp");
  assert.equal((await admin(env, `/api/admin/log-reports/${reportId}/screenshots/4`)).status, 404);
  assert.equal((await admin(env, `/api/admin/log-reports/${reportId}`, { method: "DELETE" })).status, 200);
  assert.equal(objects.size, 0);
  assert.equal((await admin(env, `/api/admin/log-reports/${reportId}/screenshots/1`)).status, 410);
});

test("screenshots must be pictures, at most 5, each at most 4 MB; a bad one sends nothing", async () => {
  const { env, objects } = await setup();
  assert.equal((await send(env, { shots: [PNG, new TextEncoder().encode("<svg>not a picture</svg>")] })).status, 400);
  assert.equal((await send(env, { shots: [PNG, PNG, PNG, PNG, PNG, PNG] })).status, 400);
  const big = new Uint8Array(4 * 1024 * 1024 + 1); big.set(PNG);
  assert.equal((await send(env, { shots: [big] })).status, 413);
  assert.equal(objects.size, 0);
  assert.equal((await send(env)).status, 201);                     // and none at all is fine
});
