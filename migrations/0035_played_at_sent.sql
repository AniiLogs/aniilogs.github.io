-- The played time an app sent, kept when it was corrected: aLogs 0.1.37 betas B19 to B23 sent an Interlink run's start
-- in the PC's local time read as UTC. Set by POST /api/admin/played-times, then on arrival by the zone the sender's
-- corrected runs carry. NULL: the row holds what the app sent.
ALTER TABLE leaderboard_submissions ADD COLUMN played_at_sent INTEGER;
