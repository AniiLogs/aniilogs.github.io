-- The game server (region) a record was played on, as the game names it (e.g. "Aniimo-Americas"), read by the desktop
-- app from the game's own settings. Boards can be filtered by it; records from older apps have none.
ALTER TABLE leaderboard_submissions ADD COLUMN server TEXT CHECK (server IS NULL OR length(server) <= 40);
CREATE INDEX IF NOT EXISTS leaderboard_submissions_server_idx ON leaderboard_submissions(server, kind);
