-- A best run's second proof picture: the Battle Data screen (each player's DPS, BREAK, damage taken and healing),
-- next to the result screen (evidence_key). Stored under evidence/ like the first; same visibility rules.
ALTER TABLE leaderboard_submissions ADD COLUMN battle_evidence_key TEXT;
