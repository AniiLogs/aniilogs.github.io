-- Battle History: a player's runs, newest first (and the daily run limit counts from the same index). A run that is
-- nobody's best keeps its pictures for a while only; proof_pruned_at records when its crops were let go, so the page
-- can say so instead of showing a broken picture.
ALTER TABLE leaderboard_submissions ADD COLUMN proof_pruned_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_leaderboard_submissions_history ON leaderboard_submissions (discord_id, created_at DESC);
-- How an Interlink run ended (cleared, ended-early, time-up, invalid): an invalid run (quit before it could count)
-- stays in its player's history and off every board.
ALTER TABLE leaderboard_submissions ADD COLUMN outcome TEXT;
-- Profiles are public by default now (the owner's decision): every profile becomes public, each with a random link id,
-- and its owner can pick Private or Custom (some parts public) in Edit profile.
UPDATE profiles SET is_public = 1, public_id = COALESCE(public_id, lower(hex(randomblob(8)))) WHERE is_public = 0 OR public_id IS NULL;
