-- Log reports sent from the aLogs app's "Send logs" button: the meter's logs as one zip (kept privately in R2 under
-- logs/), the game UID that sent it, an optional note about what went wrong, and when. No account is needed.
-- Developers read them and clear them once the problem is fixed; any left are cleared after 30 days.
CREATE TABLE log_reports (
  report_id TEXT PRIMARY KEY,
  game_uid TEXT NOT NULL,
  note TEXT,
  app_version TEXT,
  size_bytes INTEGER NOT NULL,
  log_key TEXT NOT NULL,
  ip_hash TEXT NOT NULL,           -- rate limiting only (a salted hash, never the address)
  created_at INTEGER NOT NULL
);

CREATE INDEX log_reports_created ON log_reports (created_at);
CREATE INDEX log_reports_uid ON log_reports (game_uid, created_at);
CREATE INDEX log_reports_ip ON log_reports (ip_hash, created_at);
