PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS progress_snapshots (
  discord_id TEXT PRIMARY KEY REFERENCES users(discord_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  data_json TEXT NOT NULL CHECK (length(data_json) <= 524288),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS map_shares (
  share_id TEXT PRIMARY KEY CHECK (length(share_id) = 8),
  creator_discord_id TEXT REFERENCES users(discord_id) ON DELETE SET NULL,
  selection_json TEXT NOT NULL CHECK (length(selection_json) <= 24576),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS map_shares_expires_at_idx ON map_shares (expires_at);
