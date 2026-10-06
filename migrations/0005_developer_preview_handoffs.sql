PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS developer_preview_handoffs (
  ticket_hash TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS developer_preview_handoffs_expires_at_idx
  ON developer_preview_handoffs (expires_at);
