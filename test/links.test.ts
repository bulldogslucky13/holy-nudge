// End to end through the Pages Functions with a real (node:sqlite) D1 and all migrations:
// hashed link tokens, the legacy plaintext fallback, minting and revoking, staff-only and owner
// protection, rate limits, last_seen_at, subscription takeover, and the /api/me privacy contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestPost as leaderAdd } from '../functions/api/leader-add';
import { onRequestPost as leaderLink } from '../functions/api/leader-link';
import { onRequestPost as leaderRevoke } from '../functions/api/leader-revoke';
import { onRequestGet as me } from '../functions/api/me';
import { onRequestPost as subscribe } from '../functions/api/subscribe';
import { onRequestPost as testPush } from '../functions/api/test-push';
import { RATE_LIMITS } from '../src/api/http';
import { cleanLeaderName } from '../src/api/leaders';
import { CSP } from '../src/api/headers';
import { createFixtureSource } from '../src/chms/fixture';
import { hashToken } from '../src/db';
import { createTestD1, type TestD1 } from './sqlite-d1';

// The bundled config is the sample-data one. A test can switch the endpoints to a live config (real
// Lead data, here still the made-up fixture people) by setting `mode.live`; it is reset before each test.
const mode = vi.hoisted(() => ({ live: false }));
vi.mock('../src/core/config', async (orig) => {
  const real = await orig<typeof import('../src/core/config')>();
  return { ...real, loadConfig: () => ({ ...real.loadConfig(), dataSource: mode.live ? ('pushpay' as const) : ('fixture' as const), audience: 'everyone' as const }) };
});
vi.mock('../src/chms/index', async (orig) => {
  const real = await orig<typeof import('../src/chms/index')>();
  return { ...real, createDataSource: (config: never, env: never, now: Date) => (mode.live ? createFixtureSource(now, 'America/Chicago') : real.createDataSource(config, env, now)) };
});

const HOST = 'https://holynudge.cameronbristol.xyz';
const MIGRATIONS = ['migrations/0001_init.sql', 'migrations/0002_oauth.sql', 'migrations/0003_link_tokens.sql', 'migrations/0004_lead_match.sql', 'migrations/0005_queue_coordinators.sql'];
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
  mode.live = false;
  t = await createTestD1(...MIGRATIONS);
  const ins = t.sqlite.prepare('INSERT INTO leaders (id, chms_individual_id, name, token_hash, token, is_admin, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run(id.owner, 'L104', 'Owner Person', await hashToken(tok.owner), null, 1, 1);
  ins.run(id.staff, null, 'Staff Person', await hashToken(tok.staff), null, 1, 0);
  ins.run(id.leader, 'L101', 'Plain Leader', await hashToken(tok.leader), null, 0, 0);
  ins.run(id.manager, 'M201', 'Queue Manager', await hashToken(tok.manager), null, 0, 0);
  // The queue manager is also marked as a coordinator: that gives a whole-queue view, never link or staff powers.
  t.sqlite.prepare("INSERT INTO queue_coordinators (leader_id, queue_key) VALUES (?, 'Connect Card Coordinators')").run(id.manager);
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

  it('is staff only: a plain leader and a coordinator get 403', async () => {
    // (A coordinator's own view is covered in me.test.ts with live data; on the fixture, pre-launch,
    // a non-staff coordinator gets no admin view at all: see test/prelaunch.test.ts.)
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

describe('POST /api/leader-add', () => {
  type AddBody = { url: string; leader: { id: number; name: string; role: string } };
  const add = (token: string | null, body?: unknown) => call(leaderAdd, '/api/leader-add', token, body);
  const rowByName = (name: string) =>
    t.sqlite.prepare('SELECT id, chms_individual_id, name, token, token_hash, is_admin, is_owner, revoked_at FROM leaders WHERE name = ?').get(name) as Record<string, unknown>;

  it('staff add a plain leader; the link works on /api/me with the pre-launch shape; only the hash is stored', async () => {
    const res = await add(tok.staff, { name: '  Pat   Volunteer ' });
    expect(res.status).toBe(200);
    const { url, leader } = (await res.json()) as AddBody;
    expect(leader.name).toBe('Pat Volunteer');
    expect(url).toMatch(/^https:\/\/holynudge\.cameronbristol\.xyz\/l\/[A-Za-z0-9_-]{43}$/);
    const fresh = url.split('/l/')[1]!;

    const row = rowByName('Pat Volunteer');
    expect(row).toMatchObject({ id: leader.id, chms_individual_id: null, is_admin: 0, is_owner: 0, token: null, token_hash: await hashToken(fresh), revoked_at: null });
    expect(JSON.stringify(t.sqlite.prepare('SELECT * FROM leaders').all())).not.toContain(fresh);

    const me2 = await call(me, '/api/me', fresh);
    expect(me2.status).toBe(200);
    const body = (await me2.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ leader: { name: 'Pat Volunteer', isAdmin: false, notificationsOn: false }, live: false, behind: [] });
    expect('admin' in body).toBe(false);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('appears in the staff leader list with a link and no notifications', async () => {
    const { leader } = (await (await add(tok.owner, { name: 'Riley Newperson' })).json()) as AddBody;
    const view = (await (await call(me, '/api/me', tok.owner)).json()) as { admin: { leaders: { id: number; name: string; hasLink: boolean; canManage: boolean; notificationsOn: boolean }[] } };
    expect(view.admin.leaders.find((l) => l.id === leader.id)).toMatchObject({ name: 'Riley Newperson', hasLink: true, canManage: true, notificationsOn: false });
  });

  it('is staff only: plain leaders and coordinators get 403, no token gets 401, and nothing is created', async () => {
    for (const who of [tok.leader, tok.manager]) {
      const res = await add(who, { name: 'Sneaky Person' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    }
    expect((await add(null, { name: 'Sneaky Person' })).status).toBe(401);
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM leaders WHERE name = 'Sneaky Person'").get()).toEqual({ n: 0 });
  });

  it('validates the name: trimmed, 2 to 60 characters, no control characters', async () => {
    const cases: [unknown, number, string][] = [
      [undefined, 400, 'name_required'],
      [null, 400, 'name_required'],
      [42, 400, 'name_required'],
      ['', 400, 'name_required'],
      ['    ', 400, 'name_required'],
      ['A', 400, 'name_too_short'],
      [' A ', 400, 'name_too_short'],
      ['x'.repeat(61), 400, 'name_too_long'],
      ['Bad\u0000Name', 400, 'invalid_name'],
      ['Line\nBreak', 400, 'invalid_name'],
      ['Tab\tName', 400, 'invalid_name'],
      ['Zero\u200bWidth', 400, 'invalid_name'],
    ];
    for (const [name, status, error] of cases) {
      const res = await add(tok.staff, { name });
      expect([name, res.status, ((await res.json()) as { error: string }).error]).toEqual([name, status, error]);
    }
    expect((await add(tok.staff)).status).toBe(400); // no body at all
    expect((await add(tok.staff, 'just a string')).status).toBe(400);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM leaders').get()).toEqual({ n: 5 });
    // Boundaries are fine.
    expect((await add(tok.staff, { name: 'Jo' })).status).toBe(200);
    expect((await add(tok.staff, { name: 'y'.repeat(60) })).status).toBe(200);
    expect(cleanLeaderName('  Mary \u00a0 Ann  ')).toEqual({ name: 'Mary Ann' });
  });

  it('refuses a duplicate name (case-insensitive, whitespace-collapsed) with 409 name_taken and creates nothing', async () => {
    for (const dupe of ['Plain Leader', 'plain leader', '  PLAIN   LEADER ', 'Staff Person']) {
      const res = await add(tok.staff, { name: dupe });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'name_taken' });
    }
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM leaders').get()).toEqual({ n: 5 });
    expect((await add(tok.staff, { name: 'Dana Once' })).status).toBe(200);
    expect((await add(tok.staff, { name: 'dana once' })).status).toBe(409);
    expect((await add(tok.staff, { name: 'ÉLISE Ünal' })).status).toBe(200);
    expect((await add(tok.staff, { name: 'élise ünal' })).status).toBe(409);
  });

  it('cannot create staff, owner or a ChMS-mapped row, whatever the body says', async () => {
    const res = await add(tok.staff, { name: 'Wannabe Admin', isAdmin: true, is_admin: 1, isOwner: true, is_owner: 1, chmsId: 'L101', chmsIndividualId: 'L101', chms_individual_id: 'L103' });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as AddBody;
    expect(rowByName('Wannabe Admin')).toMatchObject({ chms_individual_id: null, is_admin: 0, is_owner: 0 });
    const body = (await (await call(me, '/api/me', url.split('/l/')[1]!)).json()) as { leader: { isAdmin: boolean }; admin?: unknown };
    expect(body.leader.isAdmin).toBe(false);
    expect(body.admin).toBeUndefined();
    // The new person has no staff powers on any route.
    const fresh = url.split('/l/')[1]!;
    expect((await add(fresh, { name: 'Another One' })).status).toBe(403);
    expect((await call(leaderLink, '/api/leader-link', fresh, { leaderId: id.leader })).status).toBe(403);
  });

  it('role defaults to a servant leader and is reported back; isStaff shows in the staff list', async () => {
    for (const body of [{ name: 'Default Role' }, { name: 'Explicit Role', role: 'leader' }]) {
      const res = await add(tok.staff, body);
      expect(res.status).toBe(200);
      expect(((await res.json()) as AddBody).leader.role).toBe('leader');
    }
    expect(rowByName('Default Role')).toMatchObject({ is_admin: 0, is_owner: 0 });
    expect(rowByName('Explicit Role')).toMatchObject({ is_admin: 0, is_owner: 0 });
    const view = (await (await call(me, '/api/me', tok.owner)).json()) as { admin: { leaders: { id: number; name: string; isStaff: boolean }[] } };
    const staffById = Object.fromEntries(view.admin.leaders.map((l) => [l.id, l.isStaff]));
    expect(staffById).toMatchObject({ [id.owner]: true, [id.staff]: true, [id.leader]: false, [id.manager]: false });
    expect(view.admin.leaders.find((l) => l.name === 'Default Role')!.isStaff).toBe(false);
  });

  it('role "staff" creates a staff row (never an owner) that sees the admin view and can add people itself', async () => {
    const res = await add(tok.staff, { name: 'New Staffer', role: 'staff', isOwner: true, is_owner: 1, chmsId: 'L101' });
    expect(res.status).toBe(200);
    const { url, leader } = (await res.json()) as AddBody;
    expect(leader.role).toBe('staff');
    expect(rowByName('New Staffer')).toMatchObject({ id: leader.id, is_admin: 1, is_owner: 0, chms_individual_id: null, token: null, token_hash: await hashToken(url.split('/l/')[1]!) });

    const fresh = url.split('/l/')[1]!;
    const view = (await (await call(me, '/api/me', fresh)).json()) as { leader: { isAdmin: boolean }; live: boolean; admin?: { leaders: { name: string; isStaff: boolean; isYou: boolean; canManage: boolean }[] } };
    expect(view.leader.isAdmin).toBe(true);
    expect(view.live).toBe(false);
    expect(view.admin!.leaders.find((l) => l.isYou)).toMatchObject({ name: 'New Staffer', isStaff: true });
    // Same powers as any staff member...
    const again = await add(fresh, { name: 'Added By New Staffer' });
    expect(again.status).toBe(200);
    expect((await call(leaderLink, '/api/leader-link', fresh, { leaderId: id.leader })).status).toBe(200);
    // ...but the owner's row stays protected.
    const owner = await call(leaderLink, '/api/leader-link', fresh, { leaderId: id.owner });
    expect(owner.status).toBe(403);
    expect(await owner.json()).toEqual({ error: 'owner_protected' });
  });

  it('refuses any other role with 400 invalid_role and creates nothing', async () => {
    for (const role of ['owner', 'admin', 'Staff', ' staff', '', null, 1, true, ['staff'], { x: 1 }]) {
      const res = await add(tok.staff, { name: 'Bad Role', role });
      expect([role, res.status, await res.json()]).toEqual([role, 400, { error: 'invalid_role' }]);
    }
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM leaders').get()).toEqual({ n: 5 });
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM leaders WHERE is_owner = 1 AND id > 5').get()).toEqual({ n: 0 });
  });

  it('non-staff and coordinators still get 403, whatever role they ask for', async () => {
    for (const who of [tok.leader, tok.manager]) {
      for (const role of ['leader', 'staff', 'owner']) expect((await add(who, { name: 'Sneaky Person', role })).status).toBe(403);
    }
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM leaders WHERE name = 'Sneaky Person'").get()).toEqual({ n: 0 });
  });

  it(`shares the links rate limit: ${RATE_LIMITS.links.max} per window, then 429 with Retry-After`, async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-18T14:00:10Z'), toFake: ['Date'] });
    try {
      for (let i = 0; i < RATE_LIMITS.links.max; i++) expect((await add(tok.staff, { name: `Person Number ${i}` })).status).toBe(200);
      const res = await add(tok.staff, { name: 'One Too Many' });
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'rate_limited' });
      expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
      // Same bucket as New link / Turn off link.
      expect((await call(leaderLink, '/api/leader-link', tok.staff, { leaderId: id.leader })).status).toBe(429);
      expect(t.sqlite.prepare('SELECT bucket, count FROM rate_limits WHERE leader_id = ?').all(id.staff)).toEqual([{ bucket: 'links', count: RATE_LIMITS.links.max + 2 }]);
      // Non-staff are refused before they are counted.
      expect((await add(tok.leader, { name: 'Nope Person' })).status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GET /api/me before real data is connected (fixture)', () => {
  type MeBody = { leader: { name: string; isAdmin: boolean }; live: boolean; behind: unknown[]; admin?: unknown };
  const get = async (token: string) => (await (await call(me, '/api/me', token)).json()) as MeBody;

  it('non-staff rows mapped to a sample leader or sample queue manager (marked coordinator) get nothing: live false, empty behind, no admin', async () => {
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

describe('GET /api/me and the nudge window', () => {
  it('never writes job_runs, so page views cannot move "since the last successful run"', async () => {
    t.sqlite.prepare("INSERT INTO job_runs (started_at, finished_at, ok, summary) VALUES ('2026-01-14T14:00:00.000Z', '2026-01-14T14:00:05.000Z', 1, '{}')").run();
    const before = t.sqlite.prepare('SELECT * FROM job_runs').all();
    for (const token of [tok.owner, tok.staff, tok.leader, tok.manager]) expect((await call(me, '/api/me', token)).status).toBe(200);
    expect(t.sqlite.prepare('SELECT * FROM job_runs').all()).toEqual(before);
  });
});

describe('GET /api/me privacy contract', () => {
  it.each([{ live: false }, { live: true }])('never sends student email; staff get the leader list without any link or token (live: $live)', async ({ live }) => {
    mode.live = live;
    const rowsBefore = (t.sqlite.prepare('SELECT COUNT(*) AS n FROM leaders').get() as { n: number }).n;
    const owner = (await (await call(me, '/api/me', tok.owner)).json()) as Record<string, any>;
    const text = JSON.stringify(owner);
    expect(text).not.toMatch(/email|@example\.com/);
    expect(text).not.toMatch(/\/l\/|token/i);
    const items = [...owner.behind, ...owner.admin.unassigned, ...owner.admin.byLeader.flatMap((g: any) => g.items)];
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(Object.keys(i.individual).sort()).toEqual(['name', 'phone']);
    // Staff get the same fields for every row, plus `leadUrl` (their Lead profile link) only on matched rows
    // and only on real data. Never a bare id field (docs/DECISIONS.md, 26).
    const base = ['canManage', 'coordinates', 'hasLink', 'id', 'isStaff', 'isYou', 'lastSeenAt', 'matched', 'name', 'notificationsOn'];
    for (const l of owner.admin.leaders) {
      expect(Object.keys(l).sort()).toEqual(l.matched && live ? [...base, 'leadUrl'].sort() : base);
      expect(Object.keys(l).filter((k) => /chms|individual/i.test(k))).toEqual([]);
    }
    expect(owner.admin.leaders.some((l: any) => l.matched)).toBe(true);
    if (live) expect(owner.admin.leaders.find((l: any) => l.id === id.leader).leadUrl).toBe('https://wildwood.ccbchurch.com/goto/individuals/L101');
    else expect(JSON.stringify(owner)).not.toMatch(/goto|leadUrl/);
    // Staff see who coordinates what (queue names only, read from the coordinator rows).
    expect(owner.admin.leaders.find((l: any) => l.id === id.manager).coordinates).toEqual(['Connect Card Coordinators']);
    expect(owner.admin.leaders.find((l: any) => l.id === id.leader).coordinates).toEqual([]);
    const rowsAfter = (t.sqlite.prepare('SELECT COUNT(*) AS n FROM leaders').get() as { n: number }).n;
    if (live) {
      // Live: staff page views create rows for every ChMS leader, with no link.
      expect(owner.admin.leaders.length).toBeGreaterThan(5);
      const noLink = t.sqlite.prepare('SELECT COUNT(*) AS n FROM leaders WHERE token_hash IS NULL AND token IS NULL').get() as { n: number };
      expect(noLink.n).toBeGreaterThan(0);
    } else {
      // Sample data: only the real rows, no invented people.
      expect(rowsAfter).toBe(rowsBefore);
      expect(owner.admin.leaders).toHaveLength(rowsBefore);
    }
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
