-- Pushpay ChMS OAuth connection. Owned by src/chms/tokens.ts and src/chms/oauth.ts.
-- All times are epoch milliseconds (INTEGER). Token values are secrets: never select them into logs.
-- Plain CREATE TABLE (no IF NOT EXISTS) on purpose: a clash with another migration must fail loudly.

-- Exactly one row (id = 1), created here so the lock UPDATE always has a row to hit.
CREATE TABLE oauth_tokens (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token     TEXT,               -- single-use, rotates on every refresh; NULL = never connected
  access_token      TEXT,
  access_expires_at INTEGER,            -- epoch ms
  scope             TEXT,               -- scopes actually granted (may be fewer than requested)
  updated_at        INTEGER NOT NULL,   -- epoch ms of the last token write
  lock_owner        TEXT,               -- random id of the job currently refreshing; NULL = free
  lock_expires_at   INTEGER,            -- epoch ms; a crashed holder's lock is free after this
  needs_reauth_at   INTEGER             -- set when the token endpoint said invalid_grant; cleared by any new token
);

INSERT INTO oauth_tokens (id, updated_at) VALUES (1, 0);

-- CSRF state for /oauth/start -> /oauth/callback. Single use, 10 minute lifetime.
CREATE TABLE oauth_states (
  state      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL           -- epoch ms
);

CREATE INDEX oauth_states_created_at ON oauth_states (created_at);
