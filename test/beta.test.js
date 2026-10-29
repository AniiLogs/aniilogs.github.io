import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker from "../src/index.js";

const ORIGIN = "https://aniilogs.github.io";
const IDS = { owner: "111111111111111111", tester: "222222222222222222", player: "333333333333333333", admin: "444444444444444444" };
const SESSIONS = { owner: "o".repeat(48), tester: "t".repeat(48), player: "p".repeat(48), admin: "a".repeat(48) };
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function tokenHash(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Buffer.from(digest).toString("base64url");
}

// In-memory SQLite with every migration, the owner (ADMIN_DISCORD_IDS), a tester (developer role), an administrator and
// a player, each with Developer Mode on unless `devMode` leaves them out, and an aLogs app token each.
async function setup({ devMode = ["owner", "tester", "admin", "player"] } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = resolve(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(resolve(dir, file), "utf8"));
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
    const progress = { schemaVersion: 1, tracking: [], completed: [], preferences: { developerMode: devMode.includes(key) } };
    sqlite.prepare("INSERT INTO progress_snapshots VALUES (?, 1, ?, ?, ?)").run(discordId, JSON.stringify(progress), now, now);
  }
  sqlite.prepare("INSERT INTO developer_roles (discord_id, role, granted_by_discord_id, created_at) VALUES (?, 'developer', ?, 1)").run(IDS.tester, IDS.owner);
  sqlite.prepare("INSERT INTO developer_roles (discord_id, role, granted_by_discord_id, created_at) VALUES (?, 'administrator', ?, 1)").run(IDS.admin, IDS.owner);
  const objects = new Map();
  const EVIDENCE = {
    objects,
    async put(key, body, options) { objects.set(key, { bytes: new Uint8Array(await new Response(body).arrayBuffer()), meta: options }); },
    async get(key) { const o = objects.get(key); return o ? { body: o.bytes } : null; },
    async delete(key) { objects.delete(key); },
  };
  const env = { DB, EVIDENCE, PUBLIC_SITE_ORIGIN: ORIGIN, ADMIN_DISCORD_IDS: IDS.owner, SESSION_SECRET: "s".repeat(40), LEADERBOARD_PUBLIC: "true" };
  const site = (session, path, method = "POST") => worker.fetch(new Request(`https://api.aniilogs.example${path}`, {
    method, headers: { authorization: `Bearer ${session}`, origin: ORIGIN },
  }), env);
  const tokens = {};
  for (const key of Object.keys(IDS)) tokens[key] = (await (await site(SESSIONS[key], "/api/leaderboard/tokens")).json()).token;
  return { env, sqlite, objects, tokens };
}

// The aLogs app: its token, its own origin.
function app(env, token, path, { method = "GET", body, form } = {}) {
  const headers = { authorization: `Bearer ${token}`, origin: "http://tauri.localhost" };
  if (body) headers["content-type"] = "application/json";
  return worker.fetch(new Request(`https://api.aniilogs.example${path}`, { method, headers, body: form || (body && JSON.stringify(body)) }), env);
}

function betaForm({ kind = "beta-tests", tests, bugs, zip = ZIP, shots = {} } = {}) {
  const form = new FormData();
  form.set("kind", kind);
  form.set("uid", "302000105986");
  form.set("app_version", "0.1.28+rc.43");
  form.set("build", "RC43");
  if (tests) form.set("tests", JSON.stringify(tests));
  if (bugs) form.set("bugs", JSON.stringify(bugs));
  if (zip) form.set("logs", new Blob([zip], { type: "application/zip" }), "logs.zip");
  for (const [name, bytes] of Object.entries(shots)) form.append(name, new Blob([bytes]), `${name}.png`);
  return form;
}

const SEED = {
  build: "RC43",
  items: [
    { id: "meter-hp", title: "HP bar follows the game", how: "Fight any Alpha and watch the HP bar." },
    { id: "send-logs", title: "Send logs works", how: "Settings → Send logs.", details: "Attach one screenshot." },
  ],
};

test("the app account says who is a beta tester and what they may manage", async () => {
  const { env, tokens } = await setup({ devMode: ["owner", "tester"] });
  const account = async (who) => (await (await app(env, tokens[who], "/api/auth/app/account")).json());
  const owner = await account("owner");
  assert.equal(owner.beta, true);
  assert.ok(owner.permissions.includes("beta.manage"));
  const tester = await account("tester");
  assert.equal(tester.beta, true);
  assert.deepEqual(tester.permissions, []);
  // the administrator has the role but Developer Mode is off; the player has no role
  assert.equal((await account("admin")).beta, false);
  assert.equal((await account("player")).beta, false);
});

test("the owner seeds and rewords the shared list; testers read it without retired tests or results", async () => {
  const { env, tokens } = await setup();
  assert.equal((await app(env, tokens.tester, "/api/beta/tests", { method: "POST", body: SEED })).status, 403);
  assert.equal((await app(env, tokens.admin, "/api/beta/tests", { method: "POST", body: SEED })).status, 403);
  assert.deepEqual(await (await app(env, tokens.owner, "/api/beta/tests", { method: "POST", body: SEED })).json(), { added: 2, updated: 0 });
  const reworded = { build: "RC44", items: [{ ...SEED.items[0], title: "HP bar matches the game" }, { id: "photos", title: "Photos upload", how: "Profile → add photo." }] };
  assert.deepEqual(await (await app(env, tokens.owner, "/api/beta/tests", { method: "POST", body: reworded })).json(), { added: 1, updated: 1 });
  assert.equal((await app(env, tokens.owner, "/api/beta/tests/send-logs/retire", { method: "POST", body: { retired: true } })).status, 200);
  assert.equal((await app(env, tokens.tester, "/api/beta/tests/photos/retire", { method: "POST", body: { retired: true } })).status, 403);
  // rewording a retired test leaves it retired
  await app(env, tokens.owner, "/api/beta/tests", { method: "POST", body: SEED });

  const tester = await (await app(env, tokens.tester, "/api/beta/tests")).json();
  assert.deepEqual(tester.items.map((item) => item.id).sort(), ["meter-hp", "photos"]);
  assert.ok(tester.items.every((item) => !("retired" in item) && !("results" in item)));
  const owner = await (await app(env, tokens.owner, "/api/beta/tests")).json();
  assert.deepEqual(Object.fromEntries(owner.items.map((item) => [item.id, item.retired])), { "meter-hp": false, "send-logs": true, photos: false });
  assert.deepEqual(owner.items.find((item) => item.id === "meter-hp").results, { working: 0, broken: 0 });
  assert.deepEqual(owner.items.find((item) => item.id === "send-logs").details, ["Attach one screenshot."]);
  assert.equal((await app(env, tokens.player, "/api/beta/tests")).status, 403);
});

test("testers send results with their logs: stored as a log report, with marks, summary and counts for the owner", async () => {
  const { env, sqlite, objects, tokens } = await setup();
  await app(env, tokens.owner, "/api/beta/tests", { method: "POST", body: SEED });
  const tests = [
    { id: "meter-hp", title: "HP bar follows the game", tested: true, working: false, note: "Stuck at 37%" },
    { id: "send-logs", title: "Send logs works", tested: true, working: true },
    { id: "photos", title: "Photos upload", tested: false, working: null },
  ];
  assert.equal((await app(env, tokens.tester, "/api/logs/beta", { method: "POST", form: betaForm({ tests, zip: null }) })).status, 400);
  assert.equal((await app(env, tokens.player, "/api/logs/beta", { method: "POST", form: betaForm({ tests }) })).status, 403);
  const sent = await app(env, tokens.tester, "/api/logs/beta", { method: "POST", form: betaForm({ tests }) });
  assert.equal(sent.status, 201);
  assert.equal(sent.headers.get("access-control-allow-origin"), "*");
  const { reportId } = await sent.json();
  const row = sqlite.prepare("SELECT kind, summary, discord_id AS discordId, body_json AS body FROM log_reports WHERE report_id = ?").get(reportId);
  assert.equal(row.kind, "beta-tests");
  assert.equal(row.summary, "RC43: 2 tested, 1 not working");
  assert.equal(row.discordId, IDS.tester);
  assert.equal(JSON.parse(row.body).tests[0].note, "Stuck at 37%");
  assert.ok(objects.has(`logs/${reportId}.zip`));

  const mine = (await (await app(env, tokens.tester, "/api/beta/tests")).json()).mine;
  assert.deepEqual(Object.keys(mine).sort(), ["meter-hp", "send-logs"]);
  assert.equal(mine["meter-hp"].working, false);
  assert.equal(mine["send-logs"].working, true);
  const owner = await (await app(env, tokens.owner, "/api/beta/tests")).json();
  assert.deepEqual(owner.items.find((item) => item.id === "meter-hp").results, { working: 0, broken: 1 });

  // the tester can't read the reports; an administrator and the owner can
  assert.equal((await app(env, tokens.tester, "/api/admin/log-reports")).status, 403);
  assert.equal((await app(env, tokens.admin, "/api/admin/log-reports")).status, 200);
  assert.equal((await app(env, tokens.owner, "/api/admin/log-reports")).status, 200);
});

test("bug reports carry up to 3 screenshots per bug, named bug-<bug>-<n>", async () => {
  const { env, sqlite, objects, tokens } = await setup();
  const bugs = [{ title: "Overlay flickers", area: "Overlay", severity: "minor", text: "On alt-tab", screenshots: 2 }];
  const bad = await app(env, tokens.tester, "/api/logs/beta", { method: "POST", form: betaForm({ kind: "beta-bugs", bugs, shots: { "bug-2-1": PNG } }) });
  assert.equal(bad.status, 400);
  assert.equal((await app(env, tokens.tester, "/api/logs/beta", { method: "POST", form: betaForm({ kind: "beta-bugs", bugs, shots: { "bug-1-4": PNG } }) })).status, 400);
  const sent = await app(env, tokens.tester, "/api/logs/beta", { method: "POST", form: betaForm({ kind: "beta-bugs", bugs, shots: { "bug-1-1": PNG, "bug-1-2": PNG } }) });
  assert.equal(sent.status, 201);
  const { reportId } = await sent.json();
  assert.equal(sqlite.prepare("SELECT summary FROM log_reports WHERE report_id = ?").get(reportId).summary, "RC43: 1 bug");
  assert.ok(objects.has(`logs/${reportId}-bug-1-2.png`));
  // a website session can't send beta reports: the app's own sign-in only
  const viaSite = await worker.fetch(new Request("https://api.aniilogs.example/api/logs/beta", {
    method: "POST", headers: { authorization: `Bearer ${SESSIONS.tester}`, origin: ORIGIN }, body: betaForm({ kind: "beta-bugs", bugs }),
  }), env);
  assert.equal(viaSite.status, 401);
});

test("Developer Mode off means no beta access even with a private role", async () => {
  const { env, tokens } = await setup({ devMode: [] });
  for (const who of ["owner", "tester", "admin"]) {
    assert.equal((await app(env, tokens[who], "/api/beta/tests")).status, 403, who);
    assert.equal((await app(env, tokens[who], "/api/logs/beta", { method: "POST", form: betaForm({ tests: [{ id: "x", tested: true, working: true }] }) })).status, 403, who);
  }
});

test("publishing is upsert-only: the RC43 bundle's first 12 tests leave the other 14 seeded ones as they are", async () => {
  const { env, tokens } = await setup();
  const seed = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "scripts", "beta-seed-0.1.28-RC43.json"), "utf8"));
  assert.equal(seed.items.length, 26);
  assert.deepEqual(await (await app(env, tokens.owner, "/api/beta/tests", { method: "POST", body: seed })).json(), { added: 26, updated: 0 });
  const bundle = { build: "0.1.28-RC43", items: seed.items.slice(0, 12) };
  assert.deepEqual(await (await app(env, tokens.owner, "/api/beta/tests", { method: "POST", body: bundle })).json(), { added: 0, updated: 12 });
  const owner = await (await app(env, tokens.owner, "/api/beta/tests")).json();
  assert.equal(owner.build, "0.1.28-RC43");
  assert.equal(owner.items.length, 26);
  assert.ok(owner.items.every((item) => item.retired === false));
  const tester = await (await app(env, tokens.tester, "/api/beta/tests")).json();
  assert.deepEqual(tester.items.map((item) => item.id).sort(), seed.items.map((item) => item.id).sort());
  const attacked = tester.items.find((item) => item.id === "under-attack-hp-number");
  assert.deepEqual(attacked.details, seed.items[0].details);
  assert.equal(tester.items.find((item) => item.id === "alpha-56-60").details, undefined);
  // details over 4000 characters in all, or not a list of text, are refused
  const long = { build: "x", items: [{ id: "long", title: "t", how: "h", details: ["a".repeat(2500), "b".repeat(2500)] }] };
  assert.equal((await app(env, tokens.owner, "/api/beta/tests", { method: "POST", body: long })).status, 400);
  const odd = { build: "x", items: [{ id: "odd", title: "t", how: "h", details: [{ text: "no" }] }] };
  assert.equal((await app(env, tokens.owner, "/api/beta/tests", { method: "POST", body: odd })).status, 400);
});
