// D1 queries. The rest of the app talks to the Store interface so tests can use a fake.
import { base64urlEncode } from '../push/base64url';

export interface LeaderRow {
  id: number;
  chmsIndividualId: string | null;
  name: string;
  /** True if the leader has a working personal link (never the link itself: only its hash is stored). */
  hasLink: boolean;
  isAdmin: boolean;
  isOwner: boolean;
  /** Last authenticated GET /api/me (ISO), written at most hourly. */
  lastSeenAt: string | null;
  /** When staff turned the link off (ISO), or null. */
  revokedAt: string | null;
  /** Number of push subscriptions (devices with notifications on). */
  subscriptionCount: number;
}

export interface SubscriptionRow {
  id: number;
  leaderId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface NewSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface JobRunSummary {
  [key: string]: number | string | boolean | null;
}

export interface Store {
  /**
   * Insert a leader (with NO link: staff mint one on demand) for each ChMS person not yet known;
   * refresh names of known ones, except admins/owners, who keep the name given to scripts/add-leader.
   */
  upsertLeaders(people: { id: string; name: string }[]): Promise<void>;
  listLeaders(): Promise<LeaderRow[]>;
  leaderById(id: number): Promise<LeaderRow | null>;
  /** The leader whose link token this is (looked up by SHA-256), unless the link was turned off. */
  leaderByToken(token: string): Promise<LeaderRow | null>;
  /** Store the hash of a freshly minted token: replaces any previous link and clears revoked_at. */
  setLinkTokenHash(leaderId: number, tokenHash: string): Promise<boolean>;
  /**
   * Insert a NON-staff leader (no ChMS id, not admin, not owner) with an already-hashed link, unless another
   * leader has the same name (case-insensitive). Returns the new id, or null when the name is taken.
   */
  createLeader(name: string, tokenHash: string): Promise<number | null>;
  /** Turn the link off and delete the leader's push subscriptions. */
  revokeLink(leaderId: number, at: Date): Promise<boolean>;
  /** Record a visit, writing only if the stored value is older than minIntervalMs. */
  touchLastSeen(leaderId: number, at: Date, minIntervalMs: number): Promise<void>;
  /** Count one request in the fixed window starting at windowStart; returns the count so far. */
  hitRateLimit(leaderId: number, bucket: string, windowStart: number): Promise<number>;
  listSubscriptions(leaderId: number): Promise<SubscriptionRow[]>;
  /**
   * Insert or refresh a subscription. An endpoint already stored for ANOTHER leader moves only when
   * the same subscription keys are presented (same browser switching links); otherwise returns false.
   */
  saveSubscription(leaderId: number, sub: NewSubscription): Promise<boolean>;
  /** Delete by endpoint; when leaderId is given, only if it belongs to that leader. */
  deleteSubscription(endpoint: string, leaderId?: number): Promise<void>;
  markSubscriptionOk(endpoint: string, at: Date): Promise<void>;
  startJobRun(startedAt: Date): Promise<number>;
  finishJobRun(id: number, ok: boolean, summary: JobRunSummary, finishedAt: Date): Promise<void>;
}

/** 32 random bytes, base64url (43 chars). The personal-link secret; only its hash is stored. */
export function generateToken(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** SHA-256 of the token, lowercase hex. Same as scripts/lib/d1.mjs hashToken. */
export async function hashToken(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  let hex = '';
  for (const b of d) hex += b.toString(16).padStart(2, '0');
  return hex;
}

interface LeaderDbRow {
  id: number;
  chms_individual_id: string | null;
  name: string;
  has_link: number;
  is_admin: number;
  is_owner: number;
  last_seen_at: string | null;
  revoked_at: string | null;
  subscription_count: number;
}

// Never selects token or token_hash: callers only learn whether a link exists.
const LEADER_SELECT = `
  SELECT l.id, l.chms_individual_id, l.name, l.is_admin, l.is_owner, l.last_seen_at, l.revoked_at,
         (l.revoked_at IS NULL AND (l.token_hash IS NOT NULL OR l.token IS NOT NULL)) AS has_link,
         (SELECT COUNT(*) FROM push_subscriptions s WHERE s.leader_id = l.id) AS subscription_count
  FROM leaders l`;

function toLeader(r: LeaderDbRow): LeaderRow {
  return {
    id: r.id,
    chmsIndividualId: r.chms_individual_id,
    name: r.name,
    hasLink: r.has_link === 1,
    isAdmin: r.is_admin === 1,
    isOwner: r.is_owner === 1,
    lastSeenAt: r.last_seen_at,
    revokedAt: r.revoked_at,
    subscriptionCount: r.subscription_count,
  };
}

export function createD1Store(db: D1Database): Store {
  return {
    async upsertLeaders(people) {
      const unique = new Map(people.map((p) => [p.id, p.name]));
      if (unique.size === 0) return;
      const stmt = db.prepare(
        `INSERT INTO leaders (chms_individual_id, name) VALUES (?1, ?2)
         ON CONFLICT(chms_individual_id) DO UPDATE SET name = excluded.name
           WHERE leaders.name <> excluded.name AND leaders.is_admin = 0 AND leaders.is_owner = 0`,
      );
      await db.batch([...unique].map(([id, name]) => stmt.bind(id, name)));
    },

    async listLeaders() {
      const { results } = await db.prepare(`${LEADER_SELECT} ORDER BY l.name`).all<LeaderDbRow>();
      return results.map(toLeader);
    },

    async leaderById(id) {
      const r = await db.prepare(`${LEADER_SELECT} WHERE l.id = ?1`).bind(id).first<LeaderDbRow>();
      return r ? toLeader(r) : null;
    },

    async leaderByToken(token) {
      const hash = await hashToken(token);
      const r = await db
        .prepare(`${LEADER_SELECT} WHERE l.token_hash = ?1 AND l.revoked_at IS NULL`)
        .bind(hash)
        .first<LeaderDbRow>();
      if (r) return toLeader(r);

      // LEGACY (links issued before migration 0003): plaintext column. On a hit, store the hash and
      // clear the plaintext at once, so the link keeps working and the secret is no longer at rest.
      // Remove this fallback once scripts/hash-tokens.mjs --remote reports 0 plaintext rows (README).
      const legacy = await db
        .prepare(`${LEADER_SELECT} WHERE l.token = ?1 AND l.revoked_at IS NULL`)
        .bind(token)
        .first<LeaderDbRow>();
      if (!legacy) return null;
      await db
        .prepare(`UPDATE leaders SET token_hash = ?2, token = NULL WHERE id = ?1 AND token = ?3`)
        .bind(legacy.id, hash, token)
        .run();
      return toLeader(legacy);
    },

    async setLinkTokenHash(leaderId, tokenHash) {
      const r = await db
        .prepare(`UPDATE leaders SET token_hash = ?2, token = NULL, revoked_at = NULL WHERE id = ?1`)
        .bind(leaderId, tokenHash)
        .run();
      return r.meta.changes === 1;
    },

    async createLeader(name, tokenHash) {
      // One statement, so two quick taps cannot both pass the name check.
      const r = await db
        .prepare(
          `INSERT INTO leaders (name, token_hash, is_admin, is_owner)
           SELECT ?1, ?2, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM leaders WHERE lower(name) = lower(?1))
           RETURNING id`,
        )
        .bind(name, tokenHash)
        .first<{ id: number }>();
      return r?.id ?? null;
    },

    async revokeLink(leaderId, at) {
      const [upd] = await db.batch([
        db
          .prepare(`UPDATE leaders SET revoked_at = ?2, token_hash = NULL, token = NULL WHERE id = ?1`)
          .bind(leaderId, at.toISOString()),
        db.prepare(`DELETE FROM push_subscriptions WHERE leader_id = ?1`).bind(leaderId),
      ]);
      return (upd?.meta.changes ?? 0) === 1;
    },

    async touchLastSeen(leaderId, at, minIntervalMs) {
      await db
        .prepare(`UPDATE leaders SET last_seen_at = ?2 WHERE id = ?1 AND (last_seen_at IS NULL OR last_seen_at < ?3)`)
        .bind(leaderId, at.toISOString(), new Date(at.getTime() - minIntervalMs).toISOString())
        .run();
    },

    async hitRateLimit(leaderId, bucket, windowStart) {
      // In an upsert's SET, every expression sees the OLD row, so count resets exactly when the window moves.
      const r = await db
        .prepare(
          `INSERT INTO rate_limits (leader_id, bucket, window_start, count) VALUES (?1, ?2, ?3, 1)
           ON CONFLICT(leader_id, bucket) DO UPDATE SET
             count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
             window_start = excluded.window_start
           RETURNING count`,
        )
        .bind(leaderId, bucket, windowStart)
        .first<{ count: number }>();
      return r?.count ?? 1;
    },

    async listSubscriptions(leaderId) {
      const { results } = await db
        .prepare(`SELECT id, leader_id, endpoint, p256dh, auth FROM push_subscriptions WHERE leader_id = ?1`)
        .bind(leaderId)
        .all<{ id: number; leader_id: number; endpoint: string; p256dh: string; auth: string }>();
      return results.map((r) => ({ id: r.id, leaderId: r.leader_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
    },

    async saveSubscription(leaderId, sub) {
      const r = await db
        .prepare(
          `INSERT INTO push_subscriptions (leader_id, endpoint, p256dh, auth) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(endpoint) DO UPDATE SET leader_id = excluded.leader_id, p256dh = excluded.p256dh, auth = excluded.auth
             WHERE push_subscriptions.leader_id = excluded.leader_id
                OR (push_subscriptions.p256dh = excluded.p256dh AND push_subscriptions.auth = excluded.auth)`,
        )
        .bind(leaderId, sub.endpoint, sub.p256dh, sub.auth)
        .run();
      return r.meta.changes === 1;
    },

    async deleteSubscription(endpoint, leaderId) {
      if (leaderId === undefined) {
        await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?1`).bind(endpoint).run();
      } else {
        await db
          .prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?1 AND leader_id = ?2`)
          .bind(endpoint, leaderId)
          .run();
      }
    },

    async markSubscriptionOk(endpoint, at) {
      await db.prepare(`UPDATE push_subscriptions SET last_ok_at = ?2 WHERE endpoint = ?1`).bind(endpoint, at.toISOString()).run();
    },

    async startJobRun(startedAt) {
      const r = await db
        .prepare(`INSERT INTO job_runs (started_at, ok) VALUES (?1, 0) RETURNING id`)
        .bind(startedAt.toISOString())
        .first<{ id: number }>();
      if (!r) throw new Error('job_runs insert returned no id');
      return r.id;
    },

    async finishJobRun(id, ok, summary, finishedAt) {
      await db
        .prepare(`UPDATE job_runs SET finished_at = ?2, ok = ?3, summary = ?4 WHERE id = ?1`)
        .bind(id, finishedAt.toISOString(), ok ? 1 : 0, JSON.stringify(summary))
        .run();
    },
  };
}
