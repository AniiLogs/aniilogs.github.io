-- Battle History: a player's runs, newest first (and the daily run limit counts from the same index). A run that is
-- nobody's best keeps its pictures for a while only; proof_pruned_at records when its crops were let go, so the page
-- can say so instead of showing a broken picture.
ALTER TABLE leaderboard_submissions ADD COLUMN proof_pruned_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_leaderboard_submissions_history ON leaderboard_submissions (discord_id, created_at DESC);
