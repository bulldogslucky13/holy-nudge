// D1 queries. The rest of the app talks to the Store interface so tests can use a fake.
import { base64urlEncode } from '../push/base64url';

export interface LeaderRow {
  id: number;
  chmsIndividualId: string | null;
  name: string;
  token: string;
  isAdmin: boolean;
  isOwner: boolean;
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
  /** Insert a leader (with a fresh token) for each ChMS person not yet known; refresh names of known ones. */
  upsertLeaders(people: { id: string; name: string }[]): Promise<void>;
  listLeaders(): Promise<LeaderRow[]>;
  leaderByToken(token: string): Promise<LeaderRow | null>;
  listSubscriptions(leaderId: number): Promise<SubscriptionRow[]>;
  saveSubscription(leaderId: number, sub: NewSubscription): Promise<void>;
  /** Delete by endpoint; when leaderId is given, only if it belongs to that leader. */
  deleteSubscription(endpoint: string, leaderId?: number): Promise<void>;
  markSubscriptionOk(endpoint: string, at: Date): Promise<void>;
  startJobRun(startedAt: Date): Promise<number>;
  finishJobRun(id: number, ok: boolean, summary: JobRunSummary, finishedAt: Date): Promise<void>;
}

/** 32 random bytes, base64url (43 chars). */
export function generateToken(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

interface LeaderDbRow {
  id: number;
  chms_individual_id: string | null;
  name: string;
  token: string;
  is_admin: number;
  is_owner: number;
  subscription_count: number;
}

const LEADER_SELECT = `
  SELECT l.id, l.chms_individual_id, l.name, l.token, l.is_admin, l.is_owner,
         (SELECT COUNT(*) FROM push_subscriptions s WHERE s.leader_id = l.id) AS subscription_count
  FROM leaders l`;

function toLeader(r: LeaderDbRow): LeaderRow {
  return {
    id: r.id,
    chmsIndividualId: r.chms_individual_id,
    name: r.name,
    token: r.token,
    isAdmin: r.is_admin === 1,
    isOwner: r.is_owner === 1,
    subscriptionCount: r.subscription_count,
  };
}

export function createD1Store(db: D1Database): Store {
  return {
    async upsertLeaders(people) {
      const unique = new Map(people.map((p) => [p.id, p.name]));
      if (unique.size === 0) return;
      const stmt = db.prepare(
        `INSERT INTO leaders (chms_individual_id, name, token) VALUES (?1, ?2, ?3)
         ON CONFLICT(chms_individual_id) DO UPDATE SET name = excluded.name WHERE leaders.name <> excluded.name`,
      );
      await db.batch([...unique].map(([id, name]) => stmt.bind(id, name, generateToken())));
    },

    async listLeaders() {
      const { results } = await db.prepare(`${LEADER_SELECT} ORDER BY l.name`).all<LeaderDbRow>();
      return results.map(toLeader);
    },

    async leaderByToken(token) {
      const r = await db.prepare(`${LEADER_SELECT} WHERE l.token = ?1`).bind(token).first<LeaderDbRow>();
      return r ? toLeader(r) : null;
    },

    async listSubscriptions(leaderId) {
      const { results } = await db
        .prepare(`SELECT id, leader_id, endpoint, p256dh, auth FROM push_subscriptions WHERE leader_id = ?1`)
        .bind(leaderId)
        .all<{ id: number; leader_id: number; endpoint: string; p256dh: string; auth: string }>();
      return results.map((r) => ({ id: r.id, leaderId: r.leader_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
    },

    async saveSubscription(leaderId, sub) {
      await db
        .prepare(
          `INSERT INTO push_subscriptions (leader_id, endpoint, p256dh, auth) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(endpoint) DO UPDATE SET leader_id = excluded.leader_id, p256dh = excluded.p256dh, auth = excluded.auth`,
        )
        .bind(leaderId, sub.endpoint, sub.p256dh, sub.auth)
        .run();
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
