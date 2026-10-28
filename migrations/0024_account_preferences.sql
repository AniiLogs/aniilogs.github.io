-- Settings the website and the aLogs app share, kept with the account so both follow it: for now the theme (a preset
-- or Custom with its colours), as JSON. (Show my online status is profiles.show_presence.)
ALTER TABLE profiles ADD COLUMN preferences_json TEXT;
