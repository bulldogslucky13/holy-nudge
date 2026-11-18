-- 0003: personal-link tokens are stored hashed, can be turned off, and are minted on demand.
--
-- leaders.token_hash  = SHA-256(token), lowercase hex. The only form of a link token kept from now on.
-- leaders.token       = LEGACY plaintext token, now nullable. Cleared the first time a legacy link is
--                       used (src/db/index.ts leaderByToken) or by scripts/hash-tokens.mjs. Drop it in a
--                       later migration once `SELECT COUNT(*) FROM leaders WHERE token IS NOT NULL` is 0.
-- leaders.last_seen_at = last authenticated GET /api/me (written at most hourly).
-- leaders.revoked_at   = link turned off by staff; token_hash and token are cleared at the same time.
--
-- SQLite cannot drop NOT NULL in place, so leaders is rebuilt. D1 always enforces foreign keys and
-- DROP TABLE leaders would cascade-delete every push subscription, so they are copied aside first
-- and restored afterwards (same ids). Nobody has to turn notifications on again.

CREATE TABLE push_subscriptions_keep AS SELECT * FROM push_subscriptions;

CREATE TABLE leaders_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  chms_individual_id TEXT UNIQUE,                       -- null for someone with no ChMS record
  name               TEXT NOT NULL,
  token              TEXT UNIQUE,                       -- LEGACY plaintext; NULL once hashed (never written by new code)
  token_hash         TEXT UNIQUE,                       -- SHA-256(token) hex; NULL = no working link
  is_admin           INTEGER NOT NULL DEFAULT 0,        -- staff: sees every queue, manages links
  is_owner           INTEGER NOT NULL DEFAULT 0,        -- gets failure alerts; only the owner can rotate/revoke an owner
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at       TEXT,
  revoked_at         TEXT
);

INSERT INTO leaders_new (id, chms_individual_id, name, token, is_admin, is_owner, created_at)
  SELECT id, chms_individual_id, name, token, is_admin, is_owner, created_at FROM leaders;

DROP TABLE leaders;
ALTER TABLE leaders_new RENAME TO leaders;

INSERT OR IGNORE INTO push_subscriptions (id, leader_id, endpoint, p256dh, auth, created_at, last_ok_at)
  SELECT id, leader_id, endpoint, p256dh, auth, created_at, last_ok_at FROM push_subscriptions_keep;
DROP TABLE push_subscriptions_keep;

-- Fixed-window request counters per leader (GET /api/me, POST /api/test-push, link changes).
-- One row per leader and bucket, overwritten each window: leader id, window start and a count only.
CREATE TABLE rate_limits (
  leader_id    INTEGER NOT NULL REFERENCES leaders(id) ON DELETE CASCADE,
  bucket       TEXT NOT NULL,                           -- 'me' | 'test-push' | 'links'
  window_start INTEGER NOT NULL,                        -- epoch ms
  count        INTEGER NOT NULL,
  PRIMARY KEY (leader_id, bucket)
);
