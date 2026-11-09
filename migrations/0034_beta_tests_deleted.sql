-- The Beta Menu's retired tests are deleted 30 days after they were retired or last edited. What was deleted stays
-- listed here, so publishing a build's list with the same wording doesn't bring it back; a new wording does.
CREATE TABLE beta_tests_deleted (
  test_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  how TEXT NOT NULL,
  details TEXT,
  deleted_at INTEGER NOT NULL
);
