-- Online / AFK for a character, sent by the aLogs app while the game runs (every 2 minutes and on each change, and
-- "offline" when the game closes). A profile only counts it for 5 minutes, so a PC that drops off shows offline.
ALTER TABLE game_characters ADD COLUMN presence_state TEXT;
ALTER TABLE game_characters ADD COLUMN presence_at INTEGER;
-- The player's choice (Edit profile > Show my online status): off hides it everywhere and stops it being kept.
ALTER TABLE profiles ADD COLUMN show_presence INTEGER NOT NULL DEFAULT 1;
