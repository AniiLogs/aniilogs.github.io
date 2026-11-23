-- Short links to a set of map pins: https://aniilogs.app/m/<code> (src/map-links.js). Made the first time someone shares
-- those pins and kept for good, so the same pins always get the same code. No account is stored.
--   payload_hash    SHA-256 of selection_json: the same pins, the same link
--   selection_json  the pins as the map shares them ({ m, g }, the ?pins= payload), checked like the map checks it
--   pin_count       how many pins the sharer's map showed (for the preview's title)
--   points_json     where those pins are, 0..9999 across the map, at most 1500 of them (the preview card's dots)
--   ip_hash         a keyed hash of the sharer's network, for the hourly limit; wiped after a day
CREATE TABLE IF NOT EXISTS map_links (
  code TEXT PRIMARY KEY CHECK (length(code) = 5),
  payload_hash TEXT NOT NULL UNIQUE,
  map_id TEXT NOT NULL,
  selection_json TEXT NOT NULL CHECK (length(selection_json) <= 24576),
  pin_count INTEGER NOT NULL DEFAULT 0,
  points_json TEXT NOT NULL DEFAULT '[]' CHECK (length(points_json) <= 20000),
  ip_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS map_links_network ON map_links (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS map_links_created ON map_links (created_at);
