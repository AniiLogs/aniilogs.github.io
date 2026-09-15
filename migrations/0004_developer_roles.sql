CREATE TABLE IF NOT EXISTS developer_roles (
  discord_id TEXT PRIMARY KEY,
  granted_by_discord_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by_discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS developer_roles_granted_by_idx
  ON developer_roles(granted_by_discord_id);
