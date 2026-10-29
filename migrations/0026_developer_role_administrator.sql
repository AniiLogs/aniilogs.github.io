-- Private roles: "developer" (a tester with Developer Mode) or "administrator" (who also manages the developer role).
-- Existing rows stay developers. The owner is the ADMIN_DISCORD_IDS secret, not a row.
ALTER TABLE developer_roles ADD COLUMN role TEXT NOT NULL DEFAULT 'developer' CHECK (role IN ('developer', 'administrator'));
