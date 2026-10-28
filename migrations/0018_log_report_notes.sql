-- Developers (and the AI agents they work with) leave notes on the log reports they work on: what they found, what
-- they changed, the PR. Clearing a report (administrators only) deletes its logs but keeps its row and notes, so the
-- history of what was reported and done stays readable; so does the 30-day expiry.
ALTER TABLE log_reports ADD COLUMN cleared_at INTEGER;

CREATE TABLE log_report_notes (
  note_id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX log_report_notes_report ON log_report_notes (report_id, created_at);
