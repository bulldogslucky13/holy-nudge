-- Holy Nudge initial schema. No student data is ever stored here.
-- oauth_tokens lives in 0002_oauth.sql.

-- Servant leaders and admins. The token is the secret in their personal link (/l/<token>).
CREATE TABLE leaders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  chms_individual_id TEXT UNIQUE,                       -- null for someone with no ChMS record
  name               TEXT NOT NULL,
  token              TEXT NOT NULL UNIQUE,
  is_admin           INTEGER NOT NULL DEFAULT 0,        -- sees every queue in the process
  is_owner           INTEGER NOT NULL DEFAULT 0,        -- gets failure alerts
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per browser/device push subscription.
CREATE TABLE push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  leader_id  INTEGER NOT NULL REFERENCES leaders(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_ok_at TEXT
);
CREATE INDEX idx_push_subscriptions_leader ON push_subscriptions(leader_id);

-- One row per daily job run. summary is JSON with counts only.
CREATE TABLE job_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER NOT NULL DEFAULT 0,
  summary     TEXT
);
