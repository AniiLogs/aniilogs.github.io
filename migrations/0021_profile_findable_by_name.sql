-- A player can let others find their public profile by its display name (off by default). Search otherwise only
-- matches character names and UIDs, and a public profile only shows the display name when this is on.
ALTER TABLE profiles ADD COLUMN findable_by_name INTEGER NOT NULL DEFAULT 0;
