-- What the game's Profile screen shows for a character, read by the aLogs meter when the player opens their own
-- Profile (the screen also shows their UID, so it's theirs): Collection Progress - Aniimo Point, Sparkling Aniimo,
-- Style Points and Prismana Aniimo - as JSON, and when it was read. Shown on the player's profile.
ALTER TABLE game_characters ADD COLUMN stats_json TEXT;
ALTER TABLE game_characters ADD COLUMN stats_at INTEGER;
