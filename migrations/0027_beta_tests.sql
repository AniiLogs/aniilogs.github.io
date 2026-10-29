-- The aLogs Beta Menu. beta_tests is the shared list of things to test in the current build (the owner adds, rewords
-- and retires them); beta_test_marks is each tester's latest Working / Not working per test, from the results they send.
CREATE TABLE beta_tests (
  test_id TEXT PRIMARY KEY,
  build TEXT NOT NULL,
  title TEXT NOT NULL,
  how TEXT NOT NULL,
  details TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  retired_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE beta_test_marks (
  discord_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  working INTEGER NOT NULL CHECK (working IN (0, 1)),
  report_id TEXT,
  marked_at INTEGER NOT NULL,
  PRIMARY KEY (discord_id, test_id)
);

CREATE INDEX beta_test_marks_test ON beta_test_marks (test_id);

-- Beta results and bug reports arrive as log reports: what kind they are, their content and a one-line summary, and
-- the tester who sent them (signed in to aLogs). Plain "Send logs" reports keep kind 'logs' and no account.
ALTER TABLE log_reports ADD COLUMN kind TEXT NOT NULL DEFAULT 'logs';
ALTER TABLE log_reports ADD COLUMN body_json TEXT;
ALTER TABLE log_reports ADD COLUMN summary TEXT;
ALTER TABLE log_reports ADD COLUMN discord_id TEXT;
