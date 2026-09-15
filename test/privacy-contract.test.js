import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const accountMigration = await readFile(new URL("../migrations/0001_discord_accounts.sql", import.meta.url), "utf8");
const progressMigration = await readFile(new URL("../migrations/0002_progress_and_shares.sql", import.meta.url), "utf8");
const handoffMigration = await readFile(new URL("../migrations/0003_auth_handoffs.sql", import.meta.url), "utf8");
const explorer = await readFile(new URL("../public/explorer/app.js", import.meta.url), "utf8");
const explorerConfig = await readFile(new URL("../public/explorer/app-config.js", import.meta.url), "utf8");
const landing = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const landingApp = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const privacy = await readFile(new URL("../public/privacy.html", import.meta.url), "utf8");

test("profiles are private by default and profile edits cannot publish them", () => {
  assert.match(accountMigration, /is_public INTEGER NOT NULL DEFAULT 0/u);
  assert.match(source, /INSERT OR IGNORE INTO profiles[\s\S]*VALUES \(\?, \?, NULL, 0, \?, \?\)/u);
  assert.match(source, /UPDATE profiles SET display_name = \?, bio = \?, is_public = 0/u);
  assert.doesNotMatch(source, /\/api\/profiles\//u);
  assert.match(landing, /data-profile-editor hidden/u);
  assert.match(landing, /Only you can access this profile\. Saving cannot publish it\./u);
  assert.match(landingApp, /apiFetch\("\/profile"\)/u);
  assert.match(landingApp, /method: "PATCH"/u);
  assert.match(landingApp, /payload\.profile\?\.isPublic !== false/u);
  assert.match(landingApp, /Nothing was published\./u);
});

test("cloud progress is owner-scoped and map shares expose only compact selections", () => {
  assert.match(source, /progress_snapshots WHERE discord_id = \?/u);
  assert.match(source, /bind\(account\.discordId\)/u);
  assert.match(progressMigration, /creator_discord_id TEXT REFERENCES users\(discord_id\)/u);
  assert.match(source, /SELECT selection_json AS selectionJson, expires_at AS expiresAt FROM map_shares/u);
  assert.doesNotMatch(source, /SELECT[\s\S]{0,120}creator_discord_id[\s\S]{0,120}FROM map_shares/u);
});

test("AniiLogs storage keys preserve read-only fallback from the old site", () => {
  assert.match(explorer, /aniilogs:explorer:tracking:v1/u);
  assert.match(explorer, /aniilogs:explorer:completed:v1/u);
  assert.match(explorer, /aniilogs:explorer:preferences:v1/u);
  assert.match(explorer, /currentTracking \?\? window\.localStorage\.getItem\(LEGACY_LOCAL_TRACKING_STORAGE_KEY\)/u);
  assert.match(explorer, /persistLocalTracking\(\{ sync: false \}\)/u);
});

test("Discord uses a one-time cross-origin handoff instead of third-party cookies", () => {
  assert.match(handoffMigration, /CREATE TABLE IF NOT EXISTS auth_handoffs/u);
  assert.match(handoffMigration, /discord_id TEXT NOT NULL REFERENCES users\(discord_id\) ON DELETE CASCADE/u);
  assert.match(source, /DELETE FROM auth_handoffs WHERE handoff_hash = \?/u);
  assert.match(source, /access-control-allow-origin/u);
  assert.match(source, /origin === configuredPublicSiteOrigin\(env\)/u);
  assert.match(explorer, /aniilogs:auth:session:v1/u);
  assert.match(explorer, /window\.history\.replaceState/u);
  assert.match(explorer, /headers\.set\("authorization", `Bearer \$\{token\}`\)/u);
  assert.doesNotMatch(explorer, /credentials: "include"/u);
  assert.match(explorerConfig, /https:\/\/aniilogs-api\.pages\.dev\/api/u);
  assert.doesNotMatch(explorerConfig, /minmax|workers\.dev/iu);
});

test("the public site discloses its unofficial status and links its privacy policy", () => {
  assert.match(landing, /unofficial, independent community project/u);
  assert.match(landing, /href="\/privacy\.html"/u);
  assert.match(privacy, /not affiliated with Aniimo or its developers/u);
  assert.match(privacy, /Discord sign-in requests only the <strong>identify<\/strong> scope/u);
  assert.match(privacy, /Profiles are private by default/u);
  assert.match(privacy, /Map share links expire after 3 hours/u);
});

test("account deletion is confirmed, comprehensive, and exposed through CORS", () => {
  assert.match(source, /body\.confirmation !== "DELETE"/u);
  assert.match(source, /DELETE FROM auth_handoffs WHERE discord_id = \?/u);
  assert.match(source, /DELETE FROM map_shares WHERE creator_discord_id = \?/u);
  assert.match(source, /DELETE FROM progress_snapshots WHERE discord_id = \?/u);
  assert.match(source, /DELETE FROM profiles WHERE discord_id = \?/u);
  assert.match(source, /DELETE FROM sessions WHERE discord_id = \?/u);
  assert.match(source, /DELETE FROM users WHERE discord_id = \?/u);
  assert.match(source, /GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE/u);
  assert.match(privacy, /permanently removes your account identity, profile, cloud progress, sessions, pending sign-in handoffs, and active map shares/u);
});
