-- The account's main character (a game UID it has linked): the profile's collection progress and name follow it.
-- NULL means automatic - the most recently seen character proven in the game menu (index.js: mainCharacter).
ALTER TABLE profiles ADD COLUMN main_game_uid TEXT CHECK (main_game_uid IS NULL OR length(main_game_uid) <= 24);
