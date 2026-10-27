-- Two runs filed under bosses that were never on an Interlink week: "Omega Tuckin8" (a misread name with a made-up
-- id) and the overworld "Tucking". The server now refuses runs on any boss outside the week's three.
DELETE FROM leaderboard_submissions WHERE mode = 'interlink' AND boss_id IN ('11020700003', '1009207');
