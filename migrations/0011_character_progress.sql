-- Map, Aniilog and Item-log progress per game character (UID), so characters on different servers keep their own
-- checklists. A character's copy starts as the account's progress the first time it is used (index.js:
-- progressScope); the account copy stays for pages that haven't picked a character, and for account-wide settings.
CREATE TABLE IF NOT EXISTS character_progress (
  game_uid TEXT PRIMARY KEY CHECK (length(game_uid) BETWEEN 1 AND 24),
  discord_id TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  data_json TEXT NOT NULL CHECK (length(data_json) <= 524288),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS character_progress_owner_idx ON character_progress(discord_id);
