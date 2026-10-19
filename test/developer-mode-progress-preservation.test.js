import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";

test("actual progress UPSERT preserves explicit server mode atomically against stale tabs", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE progress_snapshots(discord_id TEXT PRIMARY KEY, revision INTEGER, data_json TEXT, created_at INTEGER, updated_at INTEGER)");
  const subject = "123456789012345678", token = "unit-session-" + "s".repeat(40),
    hash = createHash("sha256").update(token).digest("base64url");
  let role = true;
  const DB = { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; },
    async first() {
      if (sql.includes("FROM sessions")) return args[0] === hash ? { discordId: subject, discordUsername: "unit-owner", expiresAt: Math.floor(Date.now() / 1000) + 3600 } : null;
      if (sql.includes("FROM developer_roles")) return role ? { discordId: subject } : null;
      return db.prepare(sql).get(...args) || null;
    }, async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
  }; } };
  const env = { DB, PUBLIC_SITE_ORIGIN: "https://site.example" };
  const call = (path, body, method = "POST") => worker.fetch(new Request("https://api.example/api/" + path, {
    method, headers: { authorization: "Bearer " + token, origin: "https://site.example", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env);
  const read = () => JSON.parse(db.prepare("SELECT data_json FROM progress_snapshots WHERE discord_id = ?").get(subject).data_json);
  const stale = { tracking: [{ id: "new-tracking" }], completed: ["new-completion"], preferences: { theme: "idyll", developerMode: true } };
  try {
    assert.equal((await call("progress", { progress: stale }, "PUT")).status, 200);
    assert.equal(Object.hasOwn(read().preferences, "developerMode"), false, "generic save cannot initialize permission");
    for (const enabled of [true, false]) {
      assert.equal((await call("dev-preview/source-model-uid/mode", { enabled })).status, 200);
      for (const preferences of [{ developerMode: !enabled, theme: "dark" }, { theme: "light" }]) {
        assert.equal((await call("progress", { progress: { ...stale, preferences } }, "PUT")).status, 200);
        assert.equal(read().preferences.developerMode, enabled);
        assert.equal(typeof read().preferences.developerMode, "boolean");
        assert.equal(read().preferences.theme, preferences.theme);
        assert.deepEqual(read().tracking, stale.tracking); assert.deepEqual(read().completed, stale.completed);
      }
    }
    role = false;
    assert.equal((await call("dev-preview/source-model-uid/mode", { enabled: true })).status, 403);
    assert.equal((await call("dev-preview/source-model-uid/mode", { enabled: false })).status, 200);
    assert.equal((await call("progress", { progress: stale }, "PUT")).status, 200);
    assert.equal(read().preferences.developerMode, false, "stale true cannot undo role-revoked owner's off");
  } finally { db.close(); }
});
