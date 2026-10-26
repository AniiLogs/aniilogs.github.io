-- Opt-in public profiles. A profile stays private (is_public = 0) until its owner turns it public; it is then
-- reachable at a random public id, never the Discord id. Leaderboard entries show either way.
ALTER TABLE profiles ADD COLUMN public_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_public_id_idx ON profiles (public_id) WHERE public_id IS NOT NULL;
