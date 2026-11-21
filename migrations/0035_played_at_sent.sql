-- The played time an app sent, kept when POST /api/admin/played-times corrects it (aLogs 0.1.37 betas B19 to B23 sent
-- the PC's local time as UTC). NULL: the row holds what the app sent. A re-send of the record clears it again.
ALTER TABLE leaderboard_submissions ADD COLUMN played_at_sent INTEGER;
