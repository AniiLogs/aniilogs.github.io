-- In-game characters linked to Discord accounts. The desktop meter detects the character's UID from the game's own
-- log and its name from the result/prep screens, then claims it with the account's desktop token. A UID belongs to
-- one account; a claim on a UID already linked elsewhere is refused (developers can reassign it).
CREATE TABLE IF NOT EXISTS game_characters (
  game_uid TEXT PRIMARY KEY CHECK (length(game_uid) BETWEEN 1 AND 24),
  discord_id TEXT NOT NULL,
  character_name TEXT CHECK (character_name IS NULL OR length(character_name) <= 40),
  source TEXT NOT NULL CHECK (source IN ('meter', 'manual')),
  linked_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS game_characters_discord_idx ON game_characters(discord_id);
