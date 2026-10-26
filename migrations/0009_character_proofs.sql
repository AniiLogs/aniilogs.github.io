-- Proof that a character is yours: the desktop app reads your name in the game menu (Esc / Start), right above your
-- UID, and sends that strip of the screen with the link. A proven link takes a UID over from an unproven one; a UID
-- already proven by another account can only change hands through a dispute the player sends, which a developer reads.
ALTER TABLE game_characters ADD COLUMN verified_at INTEGER;

-- The latest proof per character (a small image of the menu's name and UID), visible only to its owner and developers.
CREATE TABLE IF NOT EXISTS character_proofs (
  game_uid TEXT PRIMARY KEY CHECK (length(game_uid) BETWEEN 1 AND 24),
  discord_id TEXT NOT NULL,
  character_name TEXT NOT NULL CHECK (length(character_name) <= 40),
  image BLOB NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);

-- A player says a UID claimed by another account is theirs, with their own proof. Nothing happens on its own: a
-- developer looks at both proofs and gives the UID to the right account, or rejects the request.
CREATE TABLE IF NOT EXISTS character_disputes (
  dispute_id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_uid TEXT NOT NULL CHECK (length(game_uid) BETWEEN 1 AND 24),
  discord_id TEXT NOT NULL,
  character_name TEXT NOT NULL CHECK (length(character_name) <= 40),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  image BLOB NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'granted', 'rejected')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS character_disputes_status_idx ON character_disputes(status, created_at);

-- Every name a character has gone by (names can be bought; UIDs never change), and since when. A teammate's row on the
-- boards is keyed by the name on the result screen, so it goes to whoever held that name when the run was played.
CREATE TABLE IF NOT EXISTS character_names (
  game_uid TEXT NOT NULL CHECK (length(game_uid) BETWEEN 1 AND 24),
  character_name TEXT NOT NULL CHECK (length(character_name) <= 40),
  skeleton TEXT NOT NULL,                  -- the name with lookalike letters folded together (nameSkeleton in index.js)
  verified INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (game_uid, character_name)
);

CREATE INDEX IF NOT EXISTS character_names_name_idx ON character_names(character_name COLLATE NOCASE, first_seen_at);
CREATE INDEX IF NOT EXISTS character_names_skeleton_idx ON character_names(skeleton);

-- Names the characters already linked go by today (their skeleton is refined the next time the app links them).
INSERT OR IGNORE INTO character_names (game_uid, character_name, skeleton, verified, first_seen_at, last_seen_at)
  SELECT game_uid, character_name, lower(character_name), 0, linked_at, last_seen_at FROM game_characters
  WHERE character_name IS NOT NULL;
