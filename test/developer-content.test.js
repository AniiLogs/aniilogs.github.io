import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import worker from "../src/index.js";

const ids = { developer: "111111111111111111", member: "222222222222222222" };
const tokens = { developer: "d".repeat(48), member: "m".repeat(48) };

async function tokenHash(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Buffer.from(digest).toString("base64url");
}

async function fixture({ developerMode = true, storedDeveloperMode = developerMode } = {}) {
  const sessions = new Map([[await tokenHash(tokens.developer), ids.developer], [await tokenHash(tokens.member), ids.member]]);
  const progress = new Map([[ids.developer, {
    revision: 3,
    dataJson: JSON.stringify({ schemaVersion: 1, tracking: [], completed: [], preferences: { developerMode: storedDeveloperMode } }),
    updatedAt: 1,
  }]]);
  const reads = [];
  const objects = new Map([
    ["releases/3535596/dev/map/overlay.json", '{"schema":"aniilogs.dev-overlay.v1","module":"map","records":[]}'],
    ["releases/3535596/dev/aniilog/assets/clip.mp4", "mp4-bytes"],
  ]);
  const env = {
    PUBLIC_SITE_ORIGIN: "https://aniilogs.github.io",
    CONTENT_RELEASE_ENABLED: "true",
    DEVELOPER_DISCORD_IDS: developerMode === null ? "" : ids.developer,
    DB: {
      prepare(sql) {
        return { bind(...values) { return { async first() {
          if (sql.includes("FROM sessions")) {
            const discordId = sessions.get(values[0]);
            return discordId ? { discordId, discordUsername: "u", discordGlobalName: null, discordAvatarHash: null,
              displayName: null, isPublic: 0, expiresAt: Math.floor(Date.now() / 1000) + 3600 } : null;
          }
          if (sql.includes("FROM developer_roles")) return null;
          if (sql.startsWith("SELECT revision, data_json")) return progress.get(values[0]) || null;
          throw new Error(`Unexpected first: ${sql}`);
        } }; } };
      },
    },
    CONTENT: {
      async get(key) { reads.push(key); return objects.has(key) ? { body: objects.get(key) } : null; },
      async head(key) { reads.push(key); return objects.has(key) ? { body: null } : null; },
    },
  };
  return { env, reads };
}

const request = (path, token) => new Request(`https://api.aniilogs.example${path}`, {
  headers: { origin: "https://aniilogs.github.io", ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

test("dev content needs a developer account with server-acknowledged Developer Mode", async () => {
  const on = await fixture();
  const ok = await worker.fetch(request("/api/dev-content/map/overlay.json", tokens.developer), on.env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.match(ok.headers.get("content-type"), /^application\/json/u);
  assert.equal(JSON.parse(await ok.text()).module, "map");
  assert.deepEqual(on.reads, ["releases/3535596/dev/map/overlay.json"]);

  const video = await worker.fetch(request("/api/dev-content/aniilog/assets/clip.mp4", tokens.developer), on.env);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get("content-type"), "video/mp4");

  for (const token of [undefined, tokens.member]) {
    const denied = await fixture();
    const response = await worker.fetch(request("/api/dev-content/map/overlay.json", token), denied.env);
    assert.equal(response.status, 403);
    assert.deepEqual(denied.reads, []);
  }
  const modeOff = await fixture({ storedDeveloperMode: false });
  assert.equal((await worker.fetch(request("/api/dev-content/map/overlay.json", tokens.developer), modeOff.env)).status, 403);
  assert.deepEqual(modeOff.reads, []);
});

test("dev content rejects other paths and the public relay never serves dev/", async () => {
  const f = await fixture();
  for (const path of ["/api/dev-content/map/../secret.json", "/api/dev-content/map/overlay.txt",
    "/api/dev-content/Map/overlay.json", "/api/dev-content/map/sub/overlay.json", "/api/dev-content/map%2Foverlay.json/x"]) {
    assert.equal((await worker.fetch(request(path, tokens.developer), f.env)).status, 404, path);
  }
  for (const path of ["dev/map/overlay.json", "data/dev/overlay.json", "assets/dev/x.png"]) {
    const response = await worker.fetch(request(`/api/content/releases/3535596/${path}`), f.env);
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(f.reads.filter((key) => key.includes("/dev/")), []);
});

const source = (await readFile(new URL("../public/explorer/app.js", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
function region(start, end) {
  const a = source.indexOf(start), z = source.indexOf(end, a + start.length);
  assert(a >= 0 && z > a, start);
  return source.slice(a, z);
}
const helpers = new Function(
  region("const DEVELOPER_OVERLAY_SCHEMA", "\nconst developerOverlays") + "\n"
  + region("function validDeveloperOverlay(", "\n// Resolves to") + "\n"
  + region("function applyDeveloperOverlay(", "\nfunction developerAvailabilityBadge") + "\n"
  + region("function mapDatasetWithDeveloperOverlay(", "\nfunction useMapDataset(") + "\n"
  + "return { validDeveloperOverlay, applyDeveloperOverlay, mapDatasetWithDeveloperOverlay };",
)();

test("overlay records append whole entries or patch array fields, tagged with availability", () => {
  const spawns = [{ item_id: "a", coordinate_key: "K1", detail_rows: [{ label: "Easy", value: "Lv 1" }] }];
  const out = helpers.applyDeveloperOverlay(spawns, [
    { op: "append", target: "spawns", availability: "unreleased", availability_note: "zone", value: { item_id: "b" } },
    { op: "patch", target: "spawns", availability: "unverified", match: { item_id: "a", coordinate_key: "K1" },
      append: { detail_rows: [{ label: "Tier 3", value: "Lv 65" }] } },
    { op: "patch", target: "spawns", availability: "unverified", match: { item_id: "missing" }, append: { detail_rows: [{}] } },
  ]);
  assert.equal(spawns[0].detail_rows.length, 1, "public data is never mutated");
  assert.deepEqual(out[0].detail_rows[1], { label: "Tier 3", value: "Lv 65", availability: "unverified", availability_note: "" });
  assert.deepEqual(out[1], { item_id: "b", availability: "unreleased", availability_note: "zone" });
  assert.equal(out.length, 2);
});

test("a map with no overlay records keeps its public dataset object; invalid overlays are refused", () => {
  const dataset = { items: [], spawns: [] };
  assert.equal(helpers.mapDatasetWithDeveloperOverlay("astra", dataset, null), dataset);
  assert.equal(helpers.mapDatasetWithDeveloperOverlay("astra", dataset,
    { records: [{ map_id: "whisperwake-isles", op: "append", target: "spawns", availability: "unreleased", value: {} }] }), dataset);
  assert.equal(helpers.validDeveloperOverlay({ schema: "aniilogs.dev-overlay.v1", module: "map", records: [] }, "map"), true);
  for (const bad of [{ schema: "x", module: "map", records: [] }, { schema: "aniilogs.dev-overlay.v1", module: "aniilog", records: [] },
    { schema: "aniilogs.dev-overlay.v1", module: "map", records: [{ op: "append", target: "spawns", availability: "public" }] }]) {
    assert.equal(helpers.validDeveloperOverlay(bad, "map"), false);
  }
});
