// End to end through the Pages Functions with a real (node:sqlite) D1 and all migrations:
// hashed link tokens, the legacy plaintext fallback, minting and revoking, staff-only and owner
// protection, rate limits, last_seen_at, subscription takeover, and the /api/me privacy contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestPost as leaderLink } from '../functions/api/leader-link';
import { onRequestPost as leaderRevoke } from '../functions/api/leader-revoke';
import { onRequestGet as me } from '../functions/api/me';
import { onRequestPost as subscribe } from '../functions/api/subscribe';
import { onRequestPost as testPush } from '../functions/api/test-push';
import { RATE_LIMITS } from '../src/api/http';
import { CSP } from '../src/api/headers';
import { hashToken } from '../src/db';
import { createTestD1, type TestD1 } from './sqlite-d1';

const HOST = 'https://holynudge.cameronbristol.xyz';
const MIGRATIONS = ['migrations/0001_init.sql', 'migrations/0002_oauth.sql', 'migrations/0003_link_tokens.sql'];
const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };

let t: TestD1;
const tok = {
  owner: 'owner-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  staff: 'staff-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  leader: 'leader-token-cccccccccccccccccccccccccccc',
  manager: 'manager-token-dddddddddddddddddddddddddd',
  legacy: 'legacy-token-eeeeeeeeeeeeeeeeeeeeeeeeeeee',
};
const id = { owner: 1, staff: 2, leader: 3, manager: 4, legacy: 5 };

type AnyFn = (ctx: never) => Response | Promise<Response>;
async function call(fn: AnyFn, path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const request = new Request(`${HOST}${path}`, { method: body === undefined && path === '/api/me' ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return fn({ request, env: { DB: t.db } } as never);
}
const raw = (leaderId: number) =>
  t.sqlite.prepare('SELECT token, token_hash, last_seen_at, revoked_at FROM leaders WHERE id = ?').get(leaderId) as Record<string, string | null>;

beforeEach(async () => {
  t = await createTestD1(...MIGRATIONS);
  const ins = t.sqlite.prepare('INSERT INTO leaders (id, chms_individual_id, name, token_hash, token, is_admin, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run(id.owner, 'L104', 'Owner Person', await hashToken(tok.owner), null, 1, 1);
  ins.run(id.staff, null, 'Staff Person', await hashToken(tok.staff), null, 1, 0);
  ins.run(id.leader, 'L101', 'Plain Leader', await hashToken(tok.leader), null, 0, 0);
  ins.run(id.manager, 'M201', 'Queue Manager', await hashToken(tok.manager), null, 0, 0);
  // A link issued before migration 0003: plaintext only (what production's owner row looks like today).
  ins.run(id.legacy, 'L102', 'Legacy Leader', null, tok.legacy, 0, 0);
  t.sqlite.prepare("INSERT INTO push_subscriptions (leader_id, endpoint, p256dh, auth) VALUES (?, 'https://web.push.apple.com/leader', ?, ?)").run(id.leader, KEYS.p256dh, KEYS.auth);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('personal-link tokens', () => {
  it('stores and looks up only SHA-256(token)', async () => {
    expect(raw(id.leader).token_hash).toBe(await hashToken(tok.leader));
    expect(raw(id.leader).token_hash).toMatch(/^[0-9a-f]{64}$/);
    const res = await call(me, '/api/me', tok.leader);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { leader: { name: string } }).leader.name).toBe('Plain Leader');
    // The hash itself is not a credential.
    expect((await call(me, '/api/me', raw(id.leader).token_hash!)).status).toBe(401);
  });

  it('a legacy plaintext link keeps working and is hashed (plaintext cleared) on first use', async () => {
    expect(raw(id.legacy)).toMatchObject({ token: tok.legacy, token_hash: null });
    expect((await call(me, '/api/me', tok.legacy)).status).toBe(200);
    expect(raw(id.legacy)).toMatchObject({ token: null, token_hash: await hashToken(tok.legacy) });
    // ...and keeps working through the hash afterwards.
    expect((await call(me, '/api/me', tok.legacy)).status).toBe(200);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM leaders WHERE token IS NOT NULL').get()).toEqual({ n: 0 });
  });

  it('unknown, malformed and missing tokens get 401 invalid_token', async () => {
    for (const bad of ['nope-nope-nope-nope-nope-nope', 'short', null]) {
      const res = await call(me, '/api/me', bad);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid_token' });
    }
  });

  it('records last_seen_at on /api/me, at most hourly', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-18T14:00:00Z'), toFake: ['Date'] });
    try {
      await call(me, '/api/me', tok.leader);
      expect(raw(id.leader).last_seen_at).toBe('2026-11-18T14:00:00.000Z');
      vi.setSystemTime(Date.parse('2026-11-18T14:30:00Z'));
      await call(me, '/api/me', tok.leader);
      expect(raw(id.leader).last_seen_at).toBe('2026-11-18T14:00:00.000Z');
      vi.setSystemTime(Date.parse('2026-11-18T15:00:01Z'));
      await call(me, '/api/me', tok.leader);
      expect(raw(id.leader).last_seen_at).toBe('2026-11-18T15:00:01.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('POST /api/leader-link and /api/leader-revoke', () => {
  it('minting returns a working URL once and invalidates the previous link', async () => {
    const res = await call(leaderLink, '/api/leader-link', tok.staff, { leaderId: id.leader });
    expect(res.status).toBe(200);
    const { url, self } = (await res.json()) as { url: string; self: boolean };
    expect(self).toBe(false);
    expect(url).toMatch(/^https:\/\/holynudge\.cameronbristol\.xyz\/l\/[A-Za-z0-9_-]{43}$/);
    const fresh = url.split('/l/')[1]!;
    expect(raw(id.leader)).toMatchObject({ token: null, token_hash: await hashToken(fresh), revoked_at: null });
    expect((await call(me, '/api/me', fresh)).status).toBe(200);
    expect((await call(me, '/api/me', tok.leader)).status).toBe(401);
    // Nothing usable is stored: not the token, not the URL.
    expect(JSON.stringify(t.sqlite.prepare('SELECT * FROM leaders').all())).not.toContain(fresh);
  });

  it('gives a row that was created automatically (no link) its first link', async () => {
    t.sqlite.exec("INSERT INTO leaders (id, chms_individual_id, name) VALUES (9, 'L103', 'No Link Yet')");
    const before = (await (await call(me, '/api/me', tok.owner)).json()) as { admin: { leaders: { id: number; hasLink: boolean }[] } };
    expect(before.admin.leaders.find((l) => l.id === 9)!.hasLink).toBe(false);
    const { url } = (await (await call(leaderLink, '/api/leader-link', tok.owner, { leaderId: 9 })).json()) as { url: string };
    expect((await call(me, '/api/me', url.split('/l/')[1]!)).status).toBe(200);
  });

  it('revoking turns the link off (401) and deletes that leader\'s push subscriptions', async () => {
    const res = await call(leaderRevoke, '/api/leader-revoke', tok.staff, { leaderId: id.leader });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await call(me, '/api/me', tok.leader)).status).toBe(401);
    expect(raw(id.leader)).toMatchObject({ token: null, token_hash: null, revoked_at: expect.any(String) });
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE leader_id = ?').get(id.leader)).toEqual({ n: 0 });
    // A revoked legacy link stops working too, and its plaintext is gone.
    await call(leaderRevoke, '/api/leader-revoke', tok.staff, { leaderId: id.legacy });
    expect((await call(me, '/api/me', tok.legacy)).status).toBe(401);
    expect(raw(id.legacy).token).toBeNull();
    // Minting again brings a revoked leader back with a new link.
    const { url } = (await (await call(leaderLink, '/api/leader-link', tok.staff, { leaderId: id.leader })).json()) as { url: string };
    expect(raw(id.leader).revoked_at).toBeNull();
    expect((await call(me, '/api/me', url.split('/l/')[1]!)).status).toBe(200);
  });

  it('is staff only: a plain leader and an implicit queue-manager admin get 403', async () => {
    // (An implicit admin's own view is covered in me.test.ts with live data; on the fixture, pre-launch,
    // a non-staff manager gets no admin view at all: see test/prelaunch.test.ts.)
    for (const who of [tok.leader, tok.manager]) {
      for (const fn of [leaderLink, leaderRevoke]) {
        const res = await call(fn, '/api/x', who, { leaderId: id.legacy });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'forbidden' });
      }
    }
    expect(raw(id.legacy).token).toBe(tok.legacy); // untouched
    expect((await call(leaderLink, '/api/leader-link', null, { leaderId: id.leader })).status).toBe(401);
  });

  it('protects the owner: other staff cannot rotate or revoke the owner; the owner can rotate their own link', async () => {
    for (const fn of [leaderLink, leaderRevoke]) {
      const res = await call(fn, '/api/x', tok.staff, { leaderId: id.owner });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'owner_protected' });
    }
    expect((await call(me, '/api/me', tok.owner)).status).toBe(200);

    const res = await call(leaderLink, '/api/leader-link', tok.owner, { leaderId: id.owner });
    const { url, self } = (await res.json()) as { url: string; self: boolean };
    expect(self).toBe(true);
    expect((await call(me, '/api/me', url.split('/l/')[1]!)).status).toBe(200);
    expect((await call(me, '/api/me', tok.owner)).status).toBe(401);
  });

  it('nobody can turn off their own link (no lockout), and unknown ids are 404', async () => {
    const res = await call(leaderRevoke, '/api/leader-revoke', tok.staff, { leaderId: id.staff });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'cannot_revoke_self' });
    expect((await call(me, '/api/me', tok.staff)).status).toBe(200);
    for (const bad of [999, '3', -1, 1.5, null]) {
      expect((await call(leaderLink, '/api/leader-link', tok.staff, { leaderId: bad })).status).toBe(404);
    }
  });
});

describe('GET /api/me before real data is connected (fixture)', () => {
  type MeBody = { leader: { name: string; isAdmin: boolean }; live: boolean; behind: unknown[]; admin?: unknown };
  const get = async (token: string) => (await (await call(me, '/api/me', token)).json()) as MeBody;

  it('non-staff rows mapped to a sample leader or sample queue manager get nothing: live false, empty behind, no admin', async () => {
    for (const who of [tok.leader, tok.manager, tok.legacy]) {
      const body = await get(who);
      expect(body.live).toBe(false);
      expect(body.behind).toEqual([]);
      expect(body.leader.isAdmin).toBe(false);
      expect('admin' in body).toBe(false);
      expect(Object.keys(body).sort()).toEqual(['behind', 'generatedAt', 'leader', 'live']);
    }
    // Pre-launch callers do not make staff-style row creation happen either.
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM leaders').get()).toEqual({ n: 5 });
  });

  it('staff are unchanged: live false, sample data and the admin view', async () => {
    for (const who of [tok.owner, tok.staff]) {
      const body = await get(who);
      expect(body.live).toBe(false);
      expect(body.leader.isAdmin).toBe(true);
      expect(body.admin).toBeDefined();
    }
  });
});

describe('GET /api/me privacy contract', () => {
  it('never sends student email; staff get the leader list without any link or token', async () => {
    const owner = (await (await call(me, '/api/me', tok.owner)).json()) as Record<string, any>;
    const text = JSON.stringify(owner);
    expect(text).not.toMatch(/email|@example\.com/);
    expect(text).not.toMatch(/\/l\/|token/i);
    const items = [...owner.behind, ...owner.admin.staleUnassigned, ...owner.admin.byLeader.flatMap((g: any) => g.items)];
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(Object.keys(i.individual).sort()).toEqual(['name', 'phone']);
    expect(owner.admin.leaders.map((l: any) => Object.keys(l).sort())[0]).toEqual(
      ['canManage', 'hasLink', 'id', 'isYou', 'lastSeenAt', 'name', 'notificationsOn'],
    );
    // Staff page views create rows for every ChMS leader, with no link.
    expect(owner.admin.leaders.length).toBeGreaterThan(5);
    const noLink = t.sqlite.prepare('SELECT COUNT(*) AS n FROM leaders WHERE token_hash IS NULL AND token IS NULL').get() as { n: number };
    expect(noLink.n).toBeGreaterThan(0);
  });

  it('sends the security headers on API responses', async () => {
    const res = await call(me, '/api/me', tok.leader);
    expect(res.headers.get('Content-Security-Policy')).toBe(CSP);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('rate limits', () => {
  it(`/api/me: ${RATE_LIMITS.me.max} per window, then 429 with Retry-After; resets next window`, async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-18T14:00:10Z'), toFake: ['Date'] });
    try {
      for (let i = 0; i < RATE_LIMITS.me.max; i++) expect((await call(me, '/api/me', tok.leader)).status).toBe(200);
      const res = await call(me, '/api/me', tok.leader);
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'rate_limited' });
      expect(Number(res.headers.get('Retry-After'))).toBe(290);
      // Per leader: someone else is unaffected.
      expect((await call(me, '/api/me', tok.staff)).status).toBe(200);
      vi.setSystemTime(Date.parse('2026-11-18T14:05:00Z'));
      expect((await call(me, '/api/me', tok.leader)).status).toBe(200);
      // Only leader id, bucket, window and count are stored.
      expect(t.sqlite.prepare('SELECT * FROM rate_limits WHERE leader_id = ?').all(id.leader)).toEqual([
        { leader_id: id.leader, bucket: 'me', window_start: Date.parse('2026-11-18T14:05:00Z'), count: 1 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it(`/api/test-push: ${RATE_LIMITS['test-push'].max} per 10 minutes`, async () => {
    for (let i = 0; i < RATE_LIMITS['test-push'].max; i++) {
      expect((await call(testPush, '/api/test-push', tok.leader, {})).status).toBe(503); // no VAPID keys here: still counted
    }
    expect((await call(testPush, '/api/test-push', tok.leader, {})).status).toBe(429);
  });
});

describe('POST /api/subscribe', () => {
  const sub = (endpoint: string, keys = KEYS) => ({ subscription: { endpoint, keys } });

  it('lets the same leader re-subscribe and the same browser move between links, but refuses a silent takeover', async () => {
    expect((await call(subscribe, '/api/subscribe', tok.leader, sub('https://web.push.apple.com/leader'))).status).toBe(200);
    // Another leader presenting the same endpoint with different keys: refused, row unchanged.
    const otherKeys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw5', auth: 'BTBZMqHH6r4Tts7J_aSIgh' };
    const res = await call(subscribe, '/api/subscribe', tok.staff, sub('https://web.push.apple.com/leader', otherKeys));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'subscription_conflict' });
    expect(t.sqlite.prepare("SELECT leader_id FROM push_subscriptions WHERE endpoint = 'https://web.push.apple.com/leader'").get()).toEqual({ leader_id: id.leader });
    // The same browser (same subscription keys) opening another leader's link: allowed to move.
    expect((await call(subscribe, '/api/subscribe', tok.staff, sub('https://web.push.apple.com/leader'))).status).toBe(200);
    expect(t.sqlite.prepare("SELECT leader_id FROM push_subscriptions WHERE endpoint = 'https://web.push.apple.com/leader'").get()).toEqual({ leader_id: id.staff });
  });
});

describe('Pages error boundary (/api/*, /oauth/*)', () => {
  it('answers 500 and logs the route and error class only, never the message', async () => {
    const { errorBoundary } = await import('../src/api/http');
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    const res = await errorBoundary({
      request: new Request(`${HOST}/api/me?x=1`),
      next: async () => { throw new Error(`D1_ERROR near "${tok.legacy}": Pat Example`); },
    } as never);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'server_error' });
    expect(logged).toEqual(['pages: unhandled error on /api/me (Error)']);
  });
});
