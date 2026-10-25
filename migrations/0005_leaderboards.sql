-- Leaderboards (Holo-Battle Interlink and Holo-Battle Sim).
-- Rows come from the desktop meter, which reads the game's own result screens. While the feature is gated
-- (LEADERBOARD_PUBLIC != "true") only developers can submit and read.

-- Long-lived tokens the desktop app uses to submit on behalf of a Discord account. Only the hash is stored;
-- the raw token is shown once when created.
CREATE TABLE IF NOT EXISTS leaderboard_tokens (
  token_hash TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS leaderboard_tokens_discord_idx ON leaderboard_tokens(discord_id);

-- One row per submitted record. kind:
--   interlink_run   one boss fight: result screen (+ Battle Data and meter numbers when present)
--   interlink_week  weekly best total across the cycle's bosses (Challenge Stats)
--   interlink_best  best score on one boss (battle prep screen)
--   sim_run         one Holo-Battle Sim run: final clear time, floors, rogue buffs taken
--   eggheist_match  one Egg Heist match: score and finishing placement (skeleton until the meter reads it)
CREATE TABLE IF NOT EXISTS leaderboard_submissions (
  submission_id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('interlink', 'sim', 'eggheist')),
  kind TEXT NOT NULL CHECK (kind IN ('interlink_run', 'interlink_week', 'interlink_best', 'sim_run', 'eggheist_match')),
  client_run_id TEXT NOT NULL,
  game_uid TEXT,
  cycle TEXT,
  boss_id TEXT,
  boss_name TEXT,
  boss_level INTEGER,
  score INTEGER,
  placement INTEGER,
  stars INTEGER,
  clear_time_s REAL,
  cleared INTEGER,
  floors INTEGER,
  team_dps INTEGER,
  meter_dps INTEGER,
  meter_damage INTEGER,
  party_size INTEGER,
  players_json TEXT,
  buffs_json TEXT,
  extra_json TEXT,
  evidence_key TEXT,
  client_version TEXT,
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  played_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE,
  UNIQUE (discord_id, kind, client_run_id)
);

CREATE INDEX IF NOT EXISTS leaderboard_submissions_board_idx
  ON leaderboard_submissions(mode, kind, status, cycle, boss_id);
CREATE INDEX IF NOT EXISTS leaderboard_submissions_discord_idx
  ON leaderboard_submissions(discord_id);
