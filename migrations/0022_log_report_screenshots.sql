-- Screenshots a player adds to a log report (optional, up to 5): kept privately in R2 beside the report's logs and
-- deleted with them. A JSON list of {key, type, size}.
ALTER TABLE log_reports ADD COLUMN screenshots_json TEXT;
