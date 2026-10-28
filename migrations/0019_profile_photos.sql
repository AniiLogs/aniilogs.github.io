-- Photos players took in Aniimo, uploaded from the aLogs app to their profile (as WebP, kept privately in R2 under
-- photos/). Shown wherever the profile is shown: to the owner, and to everyone once the profile is public. Each keeps
-- what the game recorded with it: when, the character (UID) that took it, the Aniimo in it and where on the map.
CREATE TABLE profile_photos (
  photo_id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  game_photo_id TEXT NOT NULL,       -- the game's own id for the photo (its uuid), so one photo is uploaded once
  game_uid TEXT,
  taken_at INTEGER,
  scene_id INTEGER,
  pos_x REAL,
  pos_y REAL,
  pos_z REAL,
  aniimo_json TEXT,                  -- the Aniimo template ids the game recorded in it
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER NOT NULL,
  photo_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (discord_id, game_photo_id),
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);

CREATE INDEX profile_photos_owner ON profile_photos (discord_id, taken_at DESC);
