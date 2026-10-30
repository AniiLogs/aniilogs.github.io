-- A second, independent reading of a run's whole screens (aLogs B2 sends them beside the cropped proof): Workers AI
-- reads the result screen (score, stars, time) and Battle Data (each card's Avg DPS, BREAK, Damage Taken, Healing) and
-- the server compares that with what the app sent. Shadow mode: the state is recorded and reviewed, never used to
-- hold a run. verify_state: pending, match, mismatch, unreadable, or an administrator's confirmed / rejected.
-- verify_json: the reading, the differences and any review.
ALTER TABLE leaderboard_submissions ADD COLUMN verify_state TEXT
  CHECK (verify_state IS NULL OR verify_state IN ('pending', 'match', 'mismatch', 'unreadable', 'confirmed', 'rejected'));
ALTER TABLE leaderboard_submissions ADD COLUMN verify_json TEXT;
ALTER TABLE leaderboard_submissions ADD COLUMN verify_at INTEGER;

CREATE INDEX IF NOT EXISTS leaderboard_submissions_verify_idx ON leaderboard_submissions(verify_state, verify_at);
