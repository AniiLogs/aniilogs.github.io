-- Short links to a placement on an Interlink boss board: https://aniilogs-api.pages.dev/<code>. A link is one run on one
-- ladder (for a one-player ladder such as Avg DPS, one player's row of it). It is made the first time someone asks for
-- it and kept for good, so the same placement always gets the same code; what the link shows (the place, the figures)
-- is read from the board each time it is opened.
--   submission_id  the copy of the run the link was asked for (any copy of a team run finds the run)
--   ladder         score, stars, clear, teamDps, dps, break or heal
--   player         one-player ladders: the player's name as the board shows it, in lower case; '' for team ladders
CREATE TABLE IF NOT EXISTS placement_links (
  code TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  ladder TEXT NOT NULL,
  player TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS placement_links_target ON placement_links (submission_id, ladder, player);
