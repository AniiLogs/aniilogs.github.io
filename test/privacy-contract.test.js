import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const accountMigration = await readFile(new URL("../migrations/0001_discord_accounts.sql", import.meta.url), "utf8");
const progressMigration = await readFile(new URL("../migrations/0002_progress_and_shares.sql", import.meta.url), "utf8");
const handoffMigration = await readFile(new URL("../migrations/0003_auth_handoffs.sql", import.meta.url), "utf8");
const explorer = await readFile(new URL("../public/explorer/app.js", import.meta.url), "utf8");
const progressStorage = await readFile(new URL("../public/explorer/progress-storage.js", import.meta.url), "utf8");
const explorerConfig = await readFile(new URL("../public/explorer/app-config.js", import.meta.url), "utf8");
const landing = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const landingApp = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const privacy = await readFile(new URL("../public/privacy.html", import.meta.url), "utf8");

test("profiles are public by default; their owner picks Private or Custom, and the server enforces it", () => {
  const migration0033 = readFileSync(new URL("../migrations/0033_battle_history.sql", import.meta.url), "utf8");
  assert.match(source, /INSERT OR IGNORE INTO profiles[\s\S]*VALUES \(\?, \?, NULL, 1, \?, \?, \?\)/u);   // new accounts: public
  assert.match(migration0033, /UPDATE profiles SET is_public = 1/u);                                    // existing ones too
  assert.ok(source.includes('const PROFILE_PARTS = Object.freeze(["standings", "history", "collection", "photos", "about", "directory"])'));
  assert.match(source, /WHERE public_id = \? AND is_public = 1/u);
  assert.doesNotMatch(source, /\/api\/profiles\/\(\d/u);
  assert.match(landing, /data-profile-editor hidden/u);
  assert.match(landingApp, /apiFetch\("\/profile"\)/u);
  assert.match(landingApp, /method: "PATCH"/u);
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
  assert.match(explorer, /AniiLogsProgressStorage\.readLocalSnapshot/u);
  assert.match(progressStorage, /current\[name\] \?\? legacy\[name\]/u);
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
  assert.match(privacy, /Profiles are public by default, and you choose who sees yours/u);
  assert.match(privacy, /A part you keep private is never sent to anyone else/u);
  assert.match(privacy, /Leaderboard entries are public/u);
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
  assert.match(source, /DELETE FROM game_characters WHERE discord_id = \?/u);
  assert.match(source, /DELETE FROM profile_photos WHERE discord_id = \?/u);
  assert.match(privacy, /permanently removes your account identity, profile and its settings, cloud progress, sessions, pending sign-in handoffs, active map shares, leaderboard entries and their screenshots, linked characters with their level, status and collection numbers, and your uploaded photos/u);
});
