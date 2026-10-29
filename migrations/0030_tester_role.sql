-- A "tester" role below developer: the aLogs Beta Menu only (no Developer Mode, unreleased content or log reports).
-- SQLite can't widen a CHECK in place, so developer_roles is rebuilt with 'tester' allowed: same columns, rows,
-- keys and index.
PRAGMA defer_foreign_keys = true;

CREATE TABLE developer_roles_new (
  discord_id TEXT PRIMARY KEY,
  granted_by_discord_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'developer' CHECK (role IN ('tester', 'developer', 'administrator')),
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by_discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);

INSERT INTO developer_roles_new (discord_id, granted_by_discord_id, created_at, role)
SELECT discord_id, granted_by_discord_id, created_at, role FROM developer_roles;

DROP TABLE developer_roles;
ALTER TABLE developer_roles_new RENAME TO developer_roles;

CREATE INDEX IF NOT EXISTS developer_roles_granted_by_idx ON developer_roles(granted_by_discord_id);
