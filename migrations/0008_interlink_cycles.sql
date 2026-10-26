-- Interlink (boss rush) weeks uploaded by developer accounts' desktop apps, which read the schedule from the game's
-- own data after each patch. They extend (and override) the weeks built into the API.
CREATE TABLE IF NOT EXISTS interlink_cycles (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 12),
  season INTEGER,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  bosses_json TEXT NOT NULL CHECK (length(bosses_json) <= 2000),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
