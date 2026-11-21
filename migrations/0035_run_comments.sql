-- Comments on runs, and notifications about them (the owner, 20 Nov). Only new tables: safe on the live data.
-- Every time in these tables is in milliseconds (Date.now()), so "news since the list was opened" never loses a comment
-- posted in the same second.
--
-- One thread per run: its key is the run's shared-run group (extra.sharedRun) when copies of a team run were linked,
-- else the submission id (src/comments.js threadOf). Every copy of a team run opens the same thread.

-- A comment: plain text, 1 to 500 characters (checked in src/comments.js). A deleted comment keeps its row without its
-- text (status 'deleted'), so the per-account limits still count it; a hidden one keeps its text for staff only.
CREATE TABLE IF NOT EXISTS run_comments (
  comment_id TEXT PRIMARY KEY,
  thread_key TEXT NOT NULL,
  run_id TEXT NOT NULL,                       -- the copy it was written on (a link to the run opens that copy)
  discord_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 500),
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden', 'deleted')),
  moderated_by TEXT,                          -- the staff account that hid or deleted it
  moderated_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS run_comments_thread_idx ON run_comments (thread_key, created_at);
CREATE INDEX IF NOT EXISTS run_comments_author_idx ON run_comments (discord_id, created_at);

-- One report per account per comment, with an optional short reason.
CREATE TABLE IF NOT EXISTS run_comment_reports (
  comment_id TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, discord_id),
  FOREIGN KEY (comment_id) REFERENCES run_comments(comment_id) ON DELETE CASCADE,
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS run_comment_reports_time_idx ON run_comment_reports (created_at);

-- Each account's place in a thread: on the run (2 sent a copy of it, 1 a team-mate tied to the account), commented,
-- turned off, when its notification entry was last opened, marked as unread, and since when its news counts (0 for the
-- run's players: every comment; the first comment's time for someone who only commented). Written when a comment is
-- posted, so the notifications are read from here without walking every run.
CREATE TABLE IF NOT EXISTS run_thread_members (
  discord_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  run_id TEXT NOT NULL,                       -- a copy of the run, for the entry's link and title
  on_run INTEGER NOT NULL DEFAULT 0 CHECK (on_run IN (0, 1, 2)),
  commented INTEGER NOT NULL DEFAULT 0 CHECK (commented IN (0, 1)),
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  read_at INTEGER,
  marked_unread INTEGER NOT NULL DEFAULT 0 CHECK (marked_unread IN (0, 1)),
  since_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (discord_id, thread_key),
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS run_thread_members_thread_idx ON run_thread_members (thread_key);

-- When each account last opened its notification list: the number counts threads with news since then.
CREATE TABLE IF NOT EXISTS notification_seen (
  discord_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL,
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);

-- Accounts staff stopped from commenting (until staff undo it).
CREATE TABLE IF NOT EXISTS comment_bans (
  discord_id TEXT PRIMARY KEY,
  banned_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (discord_id) REFERENCES users(discord_id) ON DELETE CASCADE
);
