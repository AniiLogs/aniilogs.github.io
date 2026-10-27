-- Egg Heist matches (kind eggheist_match), read from the game's end screen: score = Loot This Match,
-- clear_time_s = match time, cleared = escaped (Adventure Successful) or not (Adventure Failed), cycle = season.
-- Two values of their own: the difficulty (Normal, Hard, ...) and Total Defeats (Opponents beaten in battles).
-- SQLite can't widen a CHECK in place, so the table is rebuilt with the new kind allowed: same columns, rows,
-- constraints and indexes, plus the two new columns.
PRAGMA defer_foreign_keys = true;

CREATE TABLE leaderboard_submissions_new (
  submission_id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('interlink', 'sim', 'eggheist')),
  kind TEXT NOT NULL CHECK (kind IN ('interlink_run', 'interlink_week', 'interlink_best', 'sim_run', 'eggheist_season', 'eggheist_match')),
  client_run_id TEXT NOT NULL,
  game_uid TEXT,
  cycle TEXT,
  boss_id TEXT,
  boss_name TEXT,
  boss_level INTEGER,
  score INTEGER,
  rank_tier INTEGER,
  rank_subtier INTEGER,
  rank_name TEXT,
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
  server TEXT CHECK (server IS NULL OR length(server) <= 40),
  battle_evidence_key TEXT,
  difficulty TEXT,
  defeats INTEGER,
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE,
  UNIQUE (discord_id, kind, client_run_id)
);

INSERT INTO leaderboard_submissions_new (
  submission_id, discord_id, mode, kind, client_run_id, game_uid, cycle, boss_id, boss_name, boss_level, score,
  rank_tier, rank_subtier, rank_name, stars, clear_time_s, cleared, floors, team_dps, meter_dps, meter_damage,
  party_size, players_json, buffs_json, extra_json, evidence_key, client_version, status, played_at, created_at,
  updated_at, server, battle_evidence_key
)
SELECT
  submission_id, discord_id, mode, kind, client_run_id, game_uid, cycle, boss_id, boss_name, boss_level, score,
  rank_tier, rank_subtier, rank_name, stars, clear_time_s, cleared, floors, team_dps, meter_dps, meter_damage,
  party_size, players_json, buffs_json, extra_json, evidence_key, client_version, status, played_at, created_at,
  updated_at, server, battle_evidence_key
FROM leaderboard_submissions;

DROP TABLE leaderboard_submissions;
ALTER TABLE leaderboard_submissions_new RENAME TO leaderboard_submissions;

CREATE INDEX IF NOT EXISTS leaderboard_submissions_board_idx ON leaderboard_submissions(mode, kind, status, cycle, boss_id);
CREATE INDEX IF NOT EXISTS leaderboard_submissions_discord_idx ON leaderboard_submissions(discord_id);
CREATE INDEX IF NOT EXISTS leaderboard_submissions_server_idx ON leaderboard_submissions(server, kind);
