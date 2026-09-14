PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  discord_username TEXT NOT NULL CHECK (length(discord_username) BETWEEN 1 AND 80),
  discord_global_name TEXT CHECK (discord_global_name IS NULL OR length(discord_global_name) <= 80),
  discord_avatar_hash TEXT CHECK (discord_avatar_hash IS NULL OR length(discord_avatar_hash) <= 128),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sessions (
  session_hash TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS sessions_discord_id_idx ON sessions (discord_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS profiles (
  discord_id TEXT PRIMARY KEY REFERENCES users(discord_id) ON DELETE CASCADE,
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) <= 80),
  bio TEXT CHECK (bio IS NULL OR length(bio) <= 500),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
