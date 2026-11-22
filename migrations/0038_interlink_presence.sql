-- "I was in this run" notes (kind interlink_presence): an account whose app followed an Interlink fight to its end but
-- read no result screen has no copy of the run, so their seat in a team-mate's copy would stay unlinked. The note lets
-- the copies of that fight (the same instance) treat them like a sender whose own copy is missing: their seat gets their
-- UID and confirmed. A note is never a record: no board, count, My runs or public answer reads this table.
--   instance_id  the fight's instance as the app sends it (extra.instanceId), or "run:<id>" for a note staff add to a
--                run that has none (the copy's shared run id, else its own id); server-side only, as on the runs
--   slot         the sender's own Party seat (0-3) when the app knows it; a staff note's seat - 1
--   name         the sender's character name as the app knows it
--   added_by     the staff account that added the note by hand (POST /api/admin/run-seat); NULL for the app's own
--   forced       a staff note that skips the name check
--   extra_json   the rest of the note's extra (game: {...}), kept as sent
-- One note per account and instance: a second one updates it.
CREATE TABLE IF NOT EXISTS interlink_presence (
  discord_id TEXT NOT NULL,
  instance_id TEXT NOT NULL CHECK (length(instance_id) BETWEEN 1 AND 160),
  game_uid TEXT NOT NULL CHECK (length(game_uid) BETWEEN 1 AND 24),
  client_run_id TEXT,
  server TEXT,
  cycle TEXT,
  boss_id TEXT,
  boss_name TEXT,
  boss_level INTEGER,
  played_at INTEGER,
  client_version TEXT,
  slot INTEGER CHECK (slot IS NULL OR slot BETWEEN 0 AND 3),
  name TEXT CHECK (name IS NULL OR length(name) <= 40),
  extra_json TEXT,
  added_by TEXT,
  forced INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (discord_id, instance_id),
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS interlink_presence_instance ON interlink_presence (instance_id);
CREATE INDEX IF NOT EXISTS interlink_presence_created ON interlink_presence (discord_id, created_at);
