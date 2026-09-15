import assert from "node:assert/strict";
import test from "node:test";

await import("../public/explorer/progress-storage.js");

const storageApi = globalThis.AniiLogsProgressStorage;
const keys = {
  current: {
    tracking: "aniilogs:explorer:tracking:v1",
    completed: "aniilogs:explorer:completed:v1",
    preferences: "aniilogs:explorer:preferences:v1",
  },
  legacy: {
    tracking: "minmax-map:tracking:v1",
    completed: "minmax-map:completed:v1",
    preferences: "minmax-map:preferences:v1",
  },
};

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    value(key) {
      return values.get(key);
    },
  };
}

test("legacy browser progress migrates into AniiLogs keys without deleting the source", () => {
  const storage = memoryStorage({
    [keys.legacy.tracking]: JSON.stringify([{ id: "legacy-timer", started_at: 42 }]),
    [keys.legacy.completed]: JSON.stringify(["legacy-check"]),
    [keys.legacy.preferences]: JSON.stringify({ theme: "pawney" }),
  });
  const snapshot = storageApi.readLocalSnapshot(storage, keys);
  assert.equal(snapshot.shouldMigrate, true);
  assert.deepEqual(snapshot.migratedFamilies, ["tracking", "completed", "preferences"]);
  assert.equal(snapshot.present, true);
  storageApi.writeLocalSnapshot(storage, keys, snapshot);
  assert.deepEqual(JSON.parse(storage.value(keys.current.tracking)), snapshot.tracking);
  assert.deepEqual(JSON.parse(storage.value(keys.current.completed)), snapshot.completed);
  assert.deepEqual(JSON.parse(storage.value(keys.current.preferences)), snapshot.preferences);
  assert.notEqual(storage.value(keys.legacy.tracking), undefined);
});

test("current AniiLogs values win over legacy values independently by family", () => {
  const storage = memoryStorage({
    [keys.current.tracking]: JSON.stringify([{ id: "current" }]),
    [keys.legacy.tracking]: JSON.stringify([{ id: "legacy" }]),
    [keys.legacy.completed]: JSON.stringify(["legacy-check"]),
  });
  const snapshot = storageApi.readLocalSnapshot(storage, keys);
  assert.deepEqual(snapshot.tracking, [{ id: "current" }]);
  assert.deepEqual(snapshot.completed, ["legacy-check"]);
  assert.deepEqual(snapshot.migratedFamilies, ["completed"]);
});

test("first cloud hydration unions progress and lets local preferences and timer state win", () => {
  const merged = storageApi.mergeSnapshots(
    {
      tracking: [{ id: "shared", started_at: 1 }, { id: "remote", started_at: 2 }],
      completed: ["remote-check"],
      preferences: { theme: "meadow", language: "ja" },
    },
    {
      tracking: [{ id: "shared", started_at: 9 }, { id: "local", started_at: 3 }],
      completed: ["local-check"],
      preferences: { theme: "pawney" },
    },
    { mergeLocal: true },
  );
  assert.deepEqual(merged.tracking, [
    { id: "shared", started_at: 9 },
    { id: "remote", started_at: 2 },
    { id: "local", started_at: 3 },
  ]);
  assert.deepEqual(new Set(merged.completed), new Set(["remote-check", "local-check"]));
  assert.deepEqual(merged.preferences, { theme: "pawney", language: "ja" });
});

test("cloud-only hydration does not leak stale local progress into a new browser", () => {
  const merged = storageApi.mergeSnapshots(
    { tracking: [{ id: "remote" }], completed: ["remote-check"], preferences: { theme: "meadow" } },
    { tracking: [{ id: "local" }], completed: ["local-check"], preferences: { theme: "pawney" } },
    { mergeLocal: false },
  );
  assert.deepEqual(merged.tracking, [{ id: "remote" }]);
  assert.deepEqual(merged.completed, ["remote-check"]);
  assert.deepEqual(merged.preferences, { theme: "meadow" });
});
