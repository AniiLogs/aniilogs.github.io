import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../src/index.js";

// Explicit unit-only identities and credentials; production reads existing
// account/role/progress owners and has no identity or permission shortcuts.
const subject = "123456789012345678";
const other = "223456789012345678";
const bridge = "unit-only-source-uid-service-secret-at-least-32-characters";
const session = "S".repeat(40);
const root = "https://api.example/api/dev-preview/source-model-uid/";

function fixture() {
  const roles = new Set(), progress = new Map();
  const counters = { roles: 0, progress: 0, writes: 0, assets: 0 };
  let conflict = false;
  const sessionHash = createHash("sha256").update(session).digest("base64url");
  const DB = { prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; }, async first() {
      if (sql.includes("FROM sessions")) return args[0] === sessionHash ? {
        discordId: subject, discordUsername: "unit-owner", expiresAt: Math.floor(Date.now() / 1000) + 3600,
      } : null;
      if (sql.includes("FROM developer_roles")) {
        counters.roles++; return roles.has(args[0]) ? { discordId: args[0] } : null;
      }
      if (sql.includes("FROM progress_snapshots")) {
        counters.progress++; const row = progress.get(args[0]); return row ? { ...row } : null;
      }
      throw Error("Unexpected unit SQL read: " + sql);
    }, async run() {
      if (sql.startsWith("UPDATE progress_snapshots SET revision = revision + 1")) {
        const [dataJson, updatedAt, id, revision] = args, row = progress.get(id);
        if (conflict || !row || row.revision !== revision) return { meta: { changes: 0 } };
        progress.set(id, { revision: revision + 1, dataJson, updatedAt });
      } else if (sql.startsWith("INSERT OR IGNORE INTO progress_snapshots")) {
        const [id, dataJson, , updatedAt] = args;
        if (conflict || progress.has(id)) return { meta: { changes: 0 } };
        progress.set(id, { revision: 1, dataJson, updatedAt });
      } else throw Error("Unexpected unit SQL write: " + sql);
      counters.writes++; return { meta: { changes: 1 } };
    } };
  } };
  const env = { DB, QA_BRIDGE_SECRET: bridge, PUBLIC_SITE_ORIGIN: "https://site.example",
    CONTENT: { get() { counters.assets++; throw Error("No asset access in authorization"); } } };
  const setMode = (mode, revision = 3) => progress.set(subject, { revision, updatedAt: 0, dataJson: JSON.stringify({
    schemaVersion: 1, tracking: [{ fixture: "retained" }], completed: ["retained"],
    preferences: { developerMode: mode, retainedPreference: "unchanged" },
  }) });
  async function call(path, { method = "POST", body = { discordId: subject }, authorization = "Bearer " + bridge,
    origin, type = "application/json", selectedEnv = env } = {}) {
    return worker.fetch(new Request(root + path, { method,
      headers: { ...(type ? { "content-type": type } : {}), ...(authorization ? { authorization } : {}), ...(origin ? { origin } : {}) },
      ...(["GET", "HEAD"].includes(method) ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }), selectedEnv);
  }
  const sync = (body, options = {}) => call("mode", { body, authorization: "Bearer " + session, origin: "https://site.example", ...options });
  return { roles, progress, counters, env, setMode, call, sync, conflict: () => { conflict = true; } };
}

test("UID routes remain present while original OPTIONS and ordinary health stay unchanged", async () => {
  const f = fixture();
  for (const path of ["authorize", "mode"]) {
    assert.equal((await f.call(path, { method: "GET", authorization: null })).status, 405);
    assert.equal((await f.call(path, { method: "OPTIONS", authorization: null })).status, 204);
  }
  assert.deepEqual(f.counters, { roles: 0, progress: 0, writes: 0, assets: 0 });
  assert.equal((await worker.fetch(new Request("https://api.example/api/health"), f.env)).status, 200);
  assert.equal((await worker.fetch(new Request("https://api.example/api/content/releases/3535596/private/source-model-uid/catalog.json"), f.env)).status, 404);
  assert.equal(f.counters.assets, 0);
});

test("UID authorization requires exact service credential and bounded subject before store reads", async () => {
  const f = fixture();
  for (const authorization of [null, "Bearer wrong", "Basic wrong"]) {
    assert.equal((await f.call("authorize", { authorization })).status, 403);
  }
  for (const body of [{}, { discordId: subject, enabled: true }, { discordId: 1 }, { discordId: "not-an-id" }]) {
    assert.equal((await f.call("authorize", { body })).status, body.discordId === "not-an-id" ? 403 : 400);
  }
  assert.equal((await f.call("authorize", { body: "{" })).status, 400);
  assert.equal((await f.call("authorize", { body: " ".repeat(257) })).status, 413);
  assert.equal((await f.call("authorize", { type: "text/plain" })).status, 415);
  assert.deepEqual(f.counters, { roles: 0, progress: 0, writes: 0, assets: 0 });
  assert.equal((await f.call("authorize", { selectedEnv: { ...f.env, QA_BRIDGE_SECRET: "short" } })).status, 503);
});

test("UID authorization rechecks live role and exact stored Dev Mode on every request", async () => {
  const f = fixture(); f.setMode(true);
  assert.equal((await f.call("authorize")).status, 403);
  f.roles.add(subject);
  for (const mode of [false, "true", 1, null]) { f.setMode(mode); assert.equal((await f.call("authorize")).status, 403); }
  f.progress.delete(subject); assert.equal((await f.call("authorize")).status, 403);
  f.setMode(true);
  const allowed = await f.call("authorize"); assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { authorized: true, purpose: "aniilogs-dev-source-model-uid", discordId: subject,
    developerRole: true, devModeEnabled: true, serverDevModeRevision: 3 });
  f.roles.delete(subject); assert.equal((await f.call("authorize")).status, 403);
  f.roles.add(subject); f.setMode(false); assert.equal((await f.call("authorize")).status, 403);
  f.progress.set(subject, { revision: 4, dataJson: "{", updatedAt: 0 });
  assert.equal((await f.call("authorize")).status, 503);
  assert.equal((await f.call("authorize", { selectedEnv: { ...f.env, DB: null } })).status, 503);
  assert.equal(f.counters.writes, 0); assert.equal(f.counters.assets, 0);
});

test("UID mode sync uses original authenticated owner, origin and revision protections", async () => {
  const f = fixture(); f.roles.add(subject); f.setMode(true);
  assert.equal((await f.sync({ enabled: true }, { origin: "https://untrusted.example" })).status, 403);
  assert.equal((await f.sync({ enabled: true }, { authorization: null })).status, 401);
  assert.equal((await f.sync({ enabled: true, discordId: other })).status, 400);
  assert.equal((await f.sync({ enabled: "true" })).status, 400); assert.equal(f.counters.writes, 0);
  const off = await f.sync({ enabled: false }); assert.equal(off.status, 200);
  assert.equal((await off.json()).devModeEnabled, false);
  const saved = JSON.parse(f.progress.get(subject).dataJson);
  assert.deepEqual(saved.tracking, [{ fixture: "retained" }]); assert.deepEqual(saved.completed, ["retained"]);
  assert.equal(saved.preferences.retainedPreference, "unchanged"); assert.equal(f.progress.has(other), false);
  assert.equal((await f.call("authorize")).status, 403);
  assert.equal((await f.sync({ enabled: true })).status, 200);
  f.roles.delete(subject); assert.equal((await f.sync({ enabled: true })).status, 403);
  assert.equal((await f.sync({ enabled: false })).status, 200);
  f.roles.add(subject); f.conflict(); assert.equal((await f.sync({ enabled: true })).status, 409);
  assert.equal(f.counters.assets, 0);
});
