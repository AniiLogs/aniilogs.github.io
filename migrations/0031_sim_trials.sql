-- Holo-Battle Sim runs (kind sim_run) from the Victory screen's "Battle time 00:08:22 Training of Water - Hard":
-- clear_time_s = the battle time, difficulty = the part after " - ", and the trial's name in a column of its own.
-- Boards rank each trial and difficulty separately, fastest first.
ALTER TABLE leaderboard_submissions ADD COLUMN trial TEXT CHECK (trial IS NULL OR length(trial) <= 40);

CREATE INDEX IF NOT EXISTS leaderboard_submissions_trial_idx ON leaderboard_submissions(kind, trial, difficulty, clear_time_s);
