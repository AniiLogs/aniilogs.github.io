import assert from "node:assert/strict";
import test from "node:test";

import {
  administratorAccountAllowed,
  browserWriteAllowed,
  developerAccountAllowed,
  parseCookies,
  progressPayload,
  safeClientReturnTo,
  safeReturnTo,
  sameOriginWrite,
  validShareSelection,
} from "../src/index.js";
import worker from "../src/index.js";

async function tokenHash(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Buffer.from(digest).toString("base64url");
}

async function authenticatedTestDatabase() {
  const tokens = { owner: "o".repeat(48), other: "x".repeat(48) };
  const discordIds = { owner: "111111111111111111", other: "222222222222222222" };
  const sessions = new Map([
    [await tokenHash(tokens.owner), discordIds.owner],
    [await tokenHash(tokens.other), discordIds.other],
  ]);
  const profiles = new Map([
    [discordIds.owner, { displayName: "Owner", bio: null, isPublic: 1, updatedAt: 1 }],
    [discordIds.other, { displayName: "Other", bio: null, isPublic: 0, updatedAt: 1 }],
  ]);
  const progress = new Map();
  const shares = new Map();
  const handoffs = new Set([discordIds.owner, discordIds.other]);
  const developers = new Set();
  const accounts = new Map([
    [discordIds.owner, { discordId: discordIds.owner, discordUsername: "owner", discordGlobalName: "Owner", discordAvatarHash: null }],
    [discordIds.other, { discordId: discordIds.other, discordUsername: "other", discordGlobalName: "Other", discordAvatarHash: null }],
  ]);
  const DB = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("FROM sessions")) {
                const discordId = sessions.get(values[0]);
                if (!discordId) return null;
                const account = accounts.get(discordId);
                const profile = profiles.get(discordId);
                return { ...account, displayName: profile?.displayName, isPublic: profile?.isPublic, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
              }
              if (sql.startsWith("SELECT revision, data_json")) {
                const row = progress.get(values[0]);
                return row ? { revision: row.revision, dataJson: row.dataJson, updatedAt: row.updatedAt } : null;
              }
              if (sql.startsWith("SELECT revision, updated_at")) {
                const row = progress.get(values[0]);
                return row ? { revision: row.revision, updatedAt: row.updatedAt } : null;
              }
              if (sql.startsWith("SELECT display_name")) return profiles.get(values[0]) || null;
              if (sql.includes("FROM developer_roles")) return developers.has(values[0]) ? { discordId: values[0] } : null;
              if (sql.startsWith("SELECT selection_json")) {
                const row = shares.get(values[0]);
                return row ? { selectionJson: row.selectionJson, expiresAt: row.expiresAt } : null;
              }
              throw new Error(`Unexpected first: ${sql}`);
            },
            async run() {
              if (sql.startsWith("INSERT INTO progress_snapshots")) {
                const prior = progress.get(values[0]);
                progress.set(values[0], { revision: (prior?.revision || 0) + 1, dataJson: values[1], updatedAt: values[3] });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("INSERT INTO developer_roles")) {
                developers.add(values[0]);
                return { meta: { changes: 1 } };
              }
              if (sql === "DELETE FROM developer_roles WHERE discord_id = ?") {
                const changed = developers.delete(values[0]);
                return { meta: { changes: changed ? 1 : 0 } };
              }
              if (sql.startsWith("UPDATE profiles SET")) {
                profiles.set(values[3], { displayName: values[0], bio: values[1], isPublic: 0, updatedAt: values[2] });
                return { meta: { changes: 1 } };
              }
              if (sql === "DELETE FROM map_shares WHERE expires_at <= ?") {
                for (const [id, row] of shares) if (row.expiresAt <= values[0]) shares.delete(id);
                return { meta: { changes: 0 } };
              }
              if (sql.startsWith("INSERT OR IGNORE INTO map_shares")) {
                if (shares.has(values[0])) return { meta: { changes: 0 } };
                shares.set(values[0], { creatorDiscordId: values[1], selectionJson: values[2], expiresAt: values[4] });
                return { meta: { changes: 1 } };
              }
              if (sql === "DELETE FROM map_shares WHERE share_id = ?") {
                const changed = shares.delete(values[0]);
                return { meta: { changes: changed ? 1 : 0 } };
              }
              if (sql === "DELETE FROM auth_handoffs WHERE discord_id = ?") {
                const changed = handoffs.delete(values[0]);
                return { meta: { changes: changed ? 1 : 0 } };
              }
              if (sql === "DELETE FROM map_shares WHERE creator_discord_id = ?") {
                let changes = 0;
                for (const [id, row] of shares) {
                  if (row.creatorDiscordId === values[0]) {
                    shares.delete(id);
                    changes += 1;
                  }
                }
                return { meta: { changes } };
              }
              if (sql === "DELETE FROM progress_snapshots WHERE discord_id = ?") {
                const changed = progress.delete(values[0]);
                return { meta: { changes: changed ? 1 : 0 } };
              }
              if (sql === "DELETE FROM profiles WHERE discord_id = ?") {
                const changed = profiles.delete(values[0]);
                return { meta: { changes: changed ? 1 : 0 } };
              }
              if (sql === "DELETE FROM sessions WHERE discord_id = ?") {
                let changes = 0;
                for (const [hash, discordId] of sessions) {
                  if (discordId === values[0]) {
                    sessions.delete(hash);
                    changes += 1;
                  }
                }
                return { meta: { changes } };
              }
              if (sql === "DELETE FROM users WHERE discord_id = ?") {
                const changed = accounts.delete(values[0]);
                return { meta: { changes: changed ? 1 : 0 } };
              }
              throw new Error(`Unexpected run: ${sql}`);
            },
          };
        },
      };
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return { DB, tokens, discordIds, accounts, sessions, profiles, progress, shares, handoffs, developers };
}

function apiRequest(path, token, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("origin", "https://aniilogs.github.io");
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(`https://api.aniilogs.example${path}`, { ...options, headers });
}

test("safeReturnTo accepts same-origin paths", () => {
  assert.equal(safeReturnTo("/map?zone=idyll#markers"), "/map?zone=idyll#markers");
});
test("safeReturnTo rejects external and protocol-relative redirects", () => {
  assert.equal(safeReturnTo("https://example.com"), "/");
  assert.equal(safeReturnTo("//example.com/path"), "/");
  assert.equal(safeReturnTo("\\example.com"), "/");
});

test("safeClientReturnTo is pinned to the configured public site origin", () => {
  const request = new Request("https://api.aniilogs.example/api/auth/discord/start");
  const env = { PUBLIC_SITE_ORIGIN: "https://aniilogs.github.io" };
  assert.equal(
    safeClientReturnTo("https://aniilogs.github.io/explorer/?map=idyll", request, env),
    "https://aniilogs.github.io/explorer/?map=idyll",
  );
  assert.equal(
    safeClientReturnTo("https://evil.example/steal", request, env),
    "https://aniilogs.github.io/",
  );
});

test("parseCookies preserves values containing equals signs", () => {
  assert.deepEqual(parseCookies("a=one; session=abc==; theme=dark"), {
    a: "one",
    session: "abc==",
    theme: "dark",
  });
});

test("developer and administrator bootstrap allowlists are exact Discord IDs", () => {
  const env = {
    DEVELOPER_DISCORD_IDS: "111111111111111111, 222222222222222222",
    ADMIN_DISCORD_IDS: "333333333333333333",
  };
  assert.equal(developerAccountAllowed("111111111111111111", env), true);
  assert.equal(developerAccountAllowed("333333333333333333", env), true);
  assert.equal(administratorAccountAllowed("333333333333333333", env), true);
  assert.equal(administratorAccountAllowed("111111111111111111", env), false);
  assert.equal(developerAccountAllowed("111", env), false);
});

test("state-changing requests require an explicit same-origin browser origin", () => {
  assert.equal(sameOriginWrite(new Request("https://aniilogs.example/api/progress", {
    method: "PUT",
    headers: { origin: "https://aniilogs.example", "sec-fetch-site": "same-origin" },
  })), true);
  assert.equal(sameOriginWrite(new Request("https://aniilogs.example/api/progress", {
    method: "PUT",
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  })), false);
  assert.equal(sameOriginWrite(new Request("https://aniilogs.example/api/progress", {
    method: "PUT",
  })), false);
});

test("cross-origin writes allow only the configured GitHub Pages origin", () => {
  const env = { PUBLIC_SITE_ORIGIN: "https://aniilogs.github.io" };
  assert.equal(browserWriteAllowed(new Request("https://api.aniilogs.example/api/progress", {
    method: "PUT",
    headers: { origin: "https://aniilogs.github.io", "sec-fetch-site": "cross-site" },
  }), env), true);
  assert.equal(browserWriteAllowed(new Request("https://api.aniilogs.example/api/progress", {
    method: "PUT",
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  }), env), false);
});

test("only private administrators can grant and revoke developer access", async () => {
  const state = await authenticatedTestDatabase();
  const env = {
    DB: state.DB,
    PUBLIC_SITE_ORIGIN: "https://aniilogs.github.io",
    ADMIN_DISCORD_IDS: state.discordIds.owner,
  };
  const grant = await worker.fetch(apiRequest(`/api/admin/developers/${state.discordIds.other}`, state.tokens.owner, {
    method: "PUT",
    body: "{}",
  }), env);
  assert.equal(grant.status, 200);
  assert.equal(state.developers.has(state.discordIds.other), true);

  const otherAccount = await worker.fetch(apiRequest("/api/auth/me", state.tokens.other), env);
  const otherPayload = await otherAccount.json();
  assert.equal(otherPayload.account.developerModeAvailable, true);
  assert.equal(otherPayload.account.developerAdminAvailable, false);

  const denied = await worker.fetch(apiRequest(`/api/admin/developers/${state.discordIds.owner}`, state.tokens.other, {
    method: "PUT",
    body: "{}",
  }), env);
  assert.equal(denied.status, 403);

  const revoke = await worker.fetch(apiRequest(`/api/admin/developers/${state.discordIds.other}`, state.tokens.owner, {
    method: "DELETE",
    body: "{}",
  }), env);
  assert.equal(revoke.status, 200);
  assert.equal(state.developers.has(state.discordIds.other), false);
});

test("API preflights expose CORS only to the exact configured site", async () => {
  const env = { PUBLIC_SITE_ORIGIN: "https://aniilogs.github.io" };
  const allowed = await worker.fetch(new Request("https://api.aniilogs.example/api/progress", {
    method: "OPTIONS",
    headers: { origin: "https://aniilogs.github.io" },
  }), env);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://aniilogs.github.io");
  assert.match(allowed.headers.get("access-control-allow-headers") || "", /authorization/u);

  const denied = await worker.fetch(new Request("https://api.aniilogs.example/api/progress", {
    method: "OPTIONS",
    headers: { origin: "https://evil.example" },
  }), env);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("release content is served from the private R2 binding without directory listing", async () => {
  const bytes = new TextEncoder().encode('{"release":3509129}');
  const requestedKeys = [];
  const storedObject = () => ({
    body: bytes,
    size: bytes.byteLength,
    httpEtag: '"test-etag"',
    writeHttpMetadata(headers) {
      headers.set("content-type", "application/json; charset=utf-8");
    },
  });
  const env = {
    PUBLIC_SITE_ORIGIN: "https://aniilogs.github.io",
    CONTENT_RELEASE_ENABLED: "true",
    CONTENT: {
      async get(key) {
        requestedKeys.push(["get", key]);
        return key.endsWith("data/map_site_data.json") ? storedObject() : null;
      },
      async head(key) {
        requestedKeys.push(["head", key]);
        return key.endsWith("data/map_site_data.json") ? storedObject() : null;
      },
    },
  };

  const getResponse = await worker.fetch(new Request(
    "https://api.aniilogs.example/api/content/releases/3509129/data/map_site_data.json",
    { headers: { origin: "https://aniilogs.github.io" } },
  ), env);
  assert.equal(getResponse.status, 200);
  assert.equal(await getResponse.text(), '{"release":3509129}');
  assert.equal(getResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(getResponse.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(requestedKeys[0], ["get", "releases/3509129/data/map_site_data.json"]);

  const headResponse = await worker.fetch(new Request(
    "https://api.aniilogs.example/api/content/releases/3509129/data/map_site_data.json",
    { method: "HEAD" },
  ), env);
  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), "");
  assert.deepEqual(requestedKeys[1], ["head", "releases/3509129/data/map_site_data.json"]);

  const listingResponse = await worker.fetch(new Request(
    "https://api.aniilogs.example/api/content/releases/3509129/",
  ), env);
  assert.equal(listingResponse.status, 404);
  const traversalResponse = await worker.fetch(new Request(
    "https://api.aniilogs.example/api/content/releases/3509129/data%5Csecret.json",
  ), env);
  assert.equal(traversalResponse.status, 404);
});

test("release content fails closed until an audited snapshot is explicitly enabled", async () => {
  let reads = 0;
  const response = await worker.fetch(new Request(
    "https://api.aniilogs.example/api/content/releases/3509129/data/map_site_data.json",
  ), {
    CONTENT: {
      async get() {
        reads += 1;
        return null;
      },
    },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Release content is unavailable pending review." });
  assert.equal(reads, 0);
});

test("Discord handoffs are one-time and mint an owner session", async () => {
  const handoff = "h".repeat(48);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(handoff)));
  const handoffHash = Buffer.from(digest).toString("base64url");
  const state = {
    handoff: { handoffHash, discordId: "123456789012345678", expiresAt: Math.floor(Date.now() / 1000) + 120 },
    sessions: [],
  };
  const DB = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (!sql.startsWith("SELECT discord_id AS discordId")) throw new Error(`Unexpected first: ${sql}`);
              if (!state.handoff || values[0] !== state.handoff.handoffHash) return null;
              return { discordId: state.handoff.discordId, expiresAt: state.handoff.expiresAt };
            },
            async run() {
              if (sql === "DELETE FROM auth_handoffs WHERE handoff_hash = ?") {
                if (!state.handoff || values[0] !== state.handoff.handoffHash) return { meta: { changes: 0 } };
                state.handoff = null;
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("INSERT INTO sessions")) {
                state.sessions.push(values);
                return { meta: { changes: 1 } };
              }
              if (sql === "DELETE FROM sessions WHERE expires_at <= ?") return { meta: { changes: 0 } };
              throw new Error(`Unexpected run: ${sql}`);
            },
          };
        },
      };
    },
  };
  const env = { DB, PUBLIC_SITE_ORIGIN: "https://aniilogs.github.io" };
  const makeRequest = () => new Request("https://api.aniilogs.example/api/auth/exchange", {
    method: "POST",
    headers: { origin: "https://aniilogs.github.io", "content-type": "application/json" },
    body: JSON.stringify({ handoff }),
  });
  const response = await worker.fetch(makeRequest(), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.match(payload.token, /^[A-Za-z0-9_-]{32,256}$/u);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0][1], "123456789012345678");

  const replay = await worker.fetch(makeRequest(), env);
  assert.equal(replay.status, 401);
});

test("progressPayload accepts the bounded browser snapshot shape", () => {
  assert.deepEqual(progressPayload({
    tracking: [{ id: "timer-1" }],
    completed: ["aniimo:1001100:standard"],
    preferences: { theme: "idyll" },
  }), {
    schemaVersion: 1,
    tracking: [{ id: "timer-1" }],
    completed: ["aniimo:1001100:standard"],
    preferences: { theme: "idyll" },
  });
});

test("progressPayload rejects malformed completion data", () => {
  assert.equal(progressPayload({ tracking: [], completed: [42], preferences: {} }), null);
});

test("validShareSelection accepts the compact map payload and rejects object groups", () => {
  assert.equal(validShareSelection({ m: "country-of-time", g: [["item-1"], ["item-2", "s", ["spawn-1"]]] }), true);
  assert.equal(validShareSelection({ m: "country-of-time", g: [{ i: "item-1" }] }), false);
});

test("cloud progress writes and reads only the authenticated owner snapshot", async () => {
  const state = await authenticatedTestDatabase();
  const env = { DB: state.DB, PUBLIC_SITE_ORIGIN: "https://aniilogs.github.io" };
  const snapshot = { tracking: [{ id: "owner-timer" }], completed: ["aniimo:1001100:standard"], preferences: { theme: "idyll" } };
  const put = await worker.fetch(apiRequest("/api/progress", state.tokens.owner, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ progress: snapshot }),
  }), env);
  assert.equal(put.status, 200);
  assert.equal((await put.json()).revision, 1);

  const other = await worker.fetch(apiRequest("/api/progress", state.tokens.other), env);
  assert.deepEqual(await other.json(), { revision: 0, progress: null, updatedAt: null });
  const owner = await worker.fetch(apiRequest("/api/progress", state.tokens.owner), env);
  const ownerPayload = await owner.json();
  assert.equal(ownerPayload.revision, 1);
  assert.deepEqual(ownerPayload.progress, { schemaVersion: 1, ...snapshot });
});

test("profile updates force an authenticated public profile back to private", async () => {
  const state = await authenticatedTestDatabase();
  const env = { DB: state.DB, PUBLIC_SITE_ORIGIN: "https://aniilogs.github.io" };
  const response = await worker.fetch(apiRequest("/api/profile", state.tokens.owner, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "New Owner", bio: "Private achievements" }),
  }), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.profile.isPublic, false);
  assert.equal(state.profiles.get(state.discordIds.owner).isPublic, 0);
});

test("map shares are anonymous on read and never expose creator identity", async () => {
  const state = await authenticatedTestDatabase();
  const env = { DB: state.DB, PUBLIC_SITE_ORIGIN: "https://aniilogs.github.io" };
  const selection = { m: "country-of-time", g: [["item-1", "s", ["spawn-1"]]] };
  const created = await worker.fetch(apiRequest("/api/v1/shares", state.tokens.owner, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, selection }),
  }), env);
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const read = await worker.fetch(new Request(`https://api.aniilogs.example/api/v1/shares/${id}`), env);
  const payload = await read.json();
  assert.deepEqual(payload.selection, selection);
  assert.equal("creatorDiscordId" in payload, false);
  assert.equal("creator" in payload, false);
});

test("account deletion requires confirmation and removes only the authenticated owner's cloud data", async () => {
  const state = await authenticatedTestDatabase();
  const env = { DB: state.DB, PUBLIC_SITE_ORIGIN: "https://aniilogs.github.io" };
  state.progress.set(state.discordIds.owner, { revision: 1, dataJson: "{}", updatedAt: 1 });
  state.progress.set(state.discordIds.other, { revision: 1, dataJson: "{}", updatedAt: 1 });
  state.shares.set("OWNER123", { creatorDiscordId: state.discordIds.owner, selectionJson: "{}", expiresAt: 9999999999 });
  state.shares.set("OTHER123", { creatorDiscordId: state.discordIds.other, selectionJson: "{}", expiresAt: 9999999999 });

  const rejected = await worker.fetch(apiRequest("/api/account", state.tokens.owner, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "delete" }),
  }), env);
  assert.equal(rejected.status, 400);
  assert.equal(state.accounts.has(state.discordIds.owner), true);

  const deleted = await worker.fetch(apiRequest("/api/account", state.tokens.owner, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE" }),
  }), env);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  assert.equal(state.accounts.has(state.discordIds.owner), false);
  assert.equal(state.sessions.has(await tokenHash(state.tokens.owner)), false);
  assert.equal(state.profiles.has(state.discordIds.owner), false);
  assert.equal(state.progress.has(state.discordIds.owner), false);
  assert.equal(state.handoffs.has(state.discordIds.owner), false);
  assert.equal(state.shares.has("OWNER123"), false);
  assert.equal(state.accounts.has(state.discordIds.other), true);
  assert.equal(state.sessions.has(await tokenHash(state.tokens.other)), true);
  assert.equal(state.profiles.has(state.discordIds.other), true);
  assert.equal(state.progress.has(state.discordIds.other), true);
  assert.equal(state.handoffs.has(state.discordIds.other), true);
  assert.equal(state.shares.has("OTHER123"), true);
});

test("account deletion rejects a cross-origin request", async () => {
  const state = await authenticatedTestDatabase();
  const env = { DB: state.DB, PUBLIC_SITE_ORIGIN: "https://aniilogs.github.io" };
  const response = await worker.fetch(new Request("https://api.aniilogs.example/api/account", {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${state.tokens.owner}`,
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ confirmation: "DELETE" }),
  }), env);
  assert.equal(response.status, 403);
  assert.equal(state.accounts.has(state.discordIds.owner), true);
});
