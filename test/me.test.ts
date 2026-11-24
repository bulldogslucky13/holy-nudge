import { describe, expect, it } from 'vitest';
import { buildMe } from '../src/api/me';
import { createFixtureSource } from '../src/chms/fixture';
import { loadConfig } from '../src/core/config';
import type { LeaderRow } from '../src/db';
import { loadSnapshot } from '../src/job/load';
import { parseSubscription } from '../src/push/subscription';
import { config as baseConfig, entry, person, queue } from './helpers';

// Real data connected: the pre-launch gate is off, so these tests exercise the normal views.
const config = (over: Parameters<typeof baseConfig>[0] = {}) => baseConfig({ dataSource: 'pushpay', audience: 'everyone', ...over });

const NOW = new Date('2026-01-15T14:00:00Z');
const row = (over: Partial<LeaderRow>): LeaderRow => ({
  id: 1, chmsIndividualId: null, name: 'X', hasLink: true, isAdmin: false, isOwner: false, lastSeenAt: null, revokedAt: null, subscriptionCount: 0, matchByHand: false, coordinatorOf: [], ...over,
});

const lee = person('L1', 'Lee');
const snapshot = {
  queues: [queue({ id: 'q1', name: 'Outreach', managers: [person('M1', 'Mara')] })],
  entries: [
    entry({ id: 'e1', queueId: 'q1', status: 'IN_PROCESS', due: '2026-01-08', assignee: lee, individual: { id: 'S1', name: 'Pat Example', phone: '555-0101', email: 'pat@example.com' } }),
    entry({ id: 'e2', queueId: 'q1', status: 'NOT_STARTED', due: '2026-01-20', assignee: lee }),
    entry({ id: 'e3', queueId: 'q1', status: 'NOT_STARTED', assignee: null, created: '2026-01-12T14:00:00Z' }),
    entry({ id: 'e4', queueId: 'q1', status: 'IN_PROCESS', due: '2026-01-14T23:30:00-06:00', assignee: person('L2', 'Liv') }),
    // Unassigned but not behind (In Process, no due date): only on the Unassigned list.
    entry({ id: 'e5', queueId: 'q1', status: 'IN_PROCESS', assignee: null, created: '2026-01-15T13:00:00Z' }),
    entry({ id: 'e6', queueId: 'q1', status: 'IN_PROCESS', assignee: null, created: '2026-01-15' }),
  ],
};

describe('GET /api/me response', () => {
  it('leader view matches the contract shape', () => {
    const leader = row({ chmsIndividualId: 'L1', name: 'Lee', subscriptionCount: 1 });
    const me = buildMe({ config: config(), snapshot, leader, leaders: [leader], now: NOW });
    expect(me).toEqual({
      leader: { name: 'Lee', isAdmin: false, notificationsOn: true },
      live: true,
      behind: [
        {
          entryId: 'e1', queueId: 'q1', queueName: 'Outreach',
          queueUrl: 'https://example.com/step_individuals.php?ax=my&step_id=q1',
          status: 'IN_PROCESS', due: '2026-01-08', daysOverdue: 7,
          individual: { name: 'Pat Example', phone: '555-0101' },
        },
        {
          entryId: 'e2', queueId: 'q1', queueName: 'Outreach',
          queueUrl: 'https://example.com/step_individuals.php?ax=my&step_id=q1',
          status: 'NOT_STARTED', due: '2026-01-20', daysOverdue: null,
          individual: { name: 'Sam', phone: null },
        },
      ],
      generatedAt: '2026-01-15T14:00:00Z',
    });
    // Student email never leaves the server, even though the data source has it.
    expect(JSON.stringify(me)).not.toMatch(/email|@example\.com/);
  });

  it('a Lead queue manager who is not marked as coordinator sees only their own students: no admin view', () => {
    const mara = row({ id: 3, chmsIndividualId: 'M1', name: 'Mara' });
    const me = buildMe({ config: config(), snapshot, leader: mara, leaders: [mara], now: NOW });
    expect(me.leader.isAdmin).toBe(false);
    expect('admin' in me).toBe(false);
    // Her own students still show (here she has none in the queue she manages).
    const lee = row({ id: 1, chmsIndividualId: 'L1', name: 'Lee' });
    expect(buildMe({ config: config(), snapshot, leader: lee, leaders: [lee], now: NOW }).behind.map((i) => i.entryId)).toEqual(['e1', 'e2']);
  });

  it('a coordinator sees exactly their queues (by id or exact name), never sibling queues; works before matching', () => {
    const two = {
      queues: [...snapshot.queues, queue({ id: 'q2', name: 'Service', managers: [] })],
      entries: [...snapshot.entries, entry({ id: 's1', queueId: 'q2', status: 'NOT_STARTED', assignee: null, created: '2026-01-14T14:00:00Z' })],
    };
    const view = (coordinatorOf: string[], chmsIndividualId: string | null = null) => {
      const leader = row({ id: 7, chmsIndividualId, name: 'Cleo', coordinatorOf });
      return buildMe({ config: config(), snapshot: two, leader, leaders: [leader], now: NOW });
    };
    const ids = (me: ReturnType<typeof view>) => me.admin?.unassigned.map((i) => i.entryId).sort() ?? null;
    expect(ids(view(['q1']))).toEqual(['e3', 'e5', 'e6']);
    expect(ids(view(['Outreach']))).toEqual(['e3', 'e5', 'e6']);
    expect(ids(view(['Service']))).toEqual(['s1']);
    expect(ids(view(['Outreach', 'q2']))).toEqual(['e3', 'e5', 'e6', 's1']);
    expect(view(['q2'], 'L1').behind.map((i) => i.entryId)).toEqual(['e1', 'e2']); // own list from the Lead id, scope from the row
    for (const keys of [[], ['outreach'], ['Outreach '], ['q3'], ['M1']]) {
      const me = view(keys);
      expect([keys, me.leader.isAdmin, 'admin' in me]).toEqual([keys, false, false]);
    }
  });

  it('coordinator view: unassigned, by leader (unassigned last), missing notifications, NO leader list', () => {
    const leaders = [
      row({ id: 1, chmsIndividualId: 'L1', name: 'Lee', subscriptionCount: 1 }),
      row({ id: 2, chmsIndividualId: 'L2', name: 'Liv' }),
      row({ id: 3, chmsIndividualId: 'M1', name: 'Mara', coordinatorOf: ['Outreach'] }),
    ];
    const me = buildMe({ config: config(), snapshot, leader: leaders[2]!, leaders, now: NOW });
    expect(me.leader.isAdmin).toBe(true);
    expect(me.behind).toEqual([]);
    const a = me.admin!;
    // Every unassigned student, longest wait first: no longer only those waiting more than a day.
    // A date-only `created` of today counts from the end of the day, so it shows 0 hours, never negative.
    expect(a.unassigned.map((i) => [i.entryId, i.hoursWaiting, i.daysOverdue])).toEqual([['e3', 72, null], ['e5', 1, null], ['e6', 0, null]]);
    expect(a.byLeader.map((g) => [g.leader, g.notificationsOn, g.items.map((i) => i.entryId)])).toEqual([
      [{ name: 'Lee' }, true, ['e1', 'e2']],
      [{ name: 'Liv' }, false, ['e4']],
      [null, false, ['e3']],
    ]);
    expect(a.byLeader[1]!.items[0]!.due).toBe('2026-01-14');
    expect(a.byLeader[1]!.items[0]!.daysOverdue).toBe(1);
    expect(a.leadersWithoutNotifications).toEqual([{ name: 'Liv' }]);
    // Coordinators get no link or match features at all.
    expect('leaders' in a).toBe(false);
    expect('leadPeople' in a).toBe(false);
    expect(JSON.stringify(me)).not.toMatch(/\/l\/|token/i);
    for (const i of [...a.unassigned, ...a.byLeader.flatMap((g) => g.items)]) expect(Object.keys(i.individual)).toEqual(['name', 'phone']);
  });

  it('staff (is_admin) see every queue and the leader list (no links); non-admins get no admin key', async () => {
    const cfg = { ...loadConfig(), dataSource: 'pushpay' as const, audience: 'everyone' as const }; // live, but with the fixture snapshot as sample rows
    const snap = await loadSnapshot(createFixtureSource(NOW, cfg.timeZone), cfg);
    const owner = row({ id: 9, name: 'Owner', isAdmin: true, isOwner: true, lastSeenAt: '2026-01-15T13:00:00.000Z', subscriptionCount: 1 });
    const staff = row({ id: 4, name: 'Staffer', isAdmin: true });
    const plainLeader = row({ id: 5, name: 'Ava', hasLink: false, coordinatorOf: ['Service Team', '4', 'No Such Queue', 'Not Interested'] });
    const leaders = [owner, staff, plainLeader];
    const me = buildMe({ config: cfg, snapshot: snap, leader: owner, leaders, now: NOW });
    expect(me.admin!.byLeader.length).toBeGreaterThan(1);
    expect(me.admin!.leaders).toEqual([
      // Coordinated queues by name, in queue order; unknown and excluded keys grant nothing and are not shown.
      { id: 5, name: 'Ava', hasLink: false, lastSeenAt: null, notificationsOn: false, isStaff: false, canManage: true, isYou: false, matched: false, coordinates: ['Outreach Team', 'Service Team'] },
      { id: 9, name: 'Owner', hasLink: true, lastSeenAt: '2026-01-15T13:00:00.000Z', notificationsOn: true, isStaff: true, canManage: true, isYou: true, matched: false, coordinates: [] },
      { id: 4, name: 'Staffer', hasLink: true, lastSeenAt: null, notificationsOn: false, isStaff: true, canManage: true, isYou: false, matched: false, coordinates: [] },
    ]);
    // No row is matched, so no Lead profile URL for anyone.
    expect(JSON.stringify(me.admin!.leaders)).not.toMatch(/leadUrl|goto/);
    // Every Lead person seen is free to match here (no row holds any of them).
    expect(me.admin!.leadPeople!.length).toBeGreaterThan(5);
    for (const p of me.admin!.leadPeople!) expect(Object.keys(p)).toEqual(['id', 'name']);
    // Staff who are also marked coordinators: the mark is shown, the view stays the whole process.
    const staffCoord = row({ id: 4, name: 'Staffer', isAdmin: true, coordinatorOf: ['Service Team'] });
    const both = buildMe({ config: cfg, snapshot: snap, leader: staffCoord, leaders: [owner, staffCoord, plainLeader], now: NOW });
    expect(both.admin!.unassigned).toEqual(me.admin!.unassigned);
    expect(both.admin!.byLeader).toEqual(me.admin!.byLeader);
    expect(both.admin!.leaders!.find((l) => l.id === 4)).toMatchObject({ isStaff: true, coordinates: ['Service Team'] });
    expect(both.admin!.leadPeople).toBeDefined();
    // Sample data: the key is still there, but empty (no invented people to match to).
    const sample = buildMe({ config: { ...cfg, dataSource: 'fixture' }, snapshot: snap, leader: owner, leaders, now: NOW });
    expect(sample.admin!.leadPeople).toEqual([]);
    // A non-owner staff member cannot manage the owner's row.
    const asStaff = buildMe({ config: cfg, snapshot: snap, leader: staff, leaders, now: NOW });
    expect(asStaff.admin!.leaders!.find((l) => l.id === 9)!.canManage).toBe(false);
    expect(JSON.stringify(me)).not.toMatch(/\/l\/|token|"email"|@example\.com/i); // a queue may be called "Welcome Email": check the key, not the word
    const plain = buildMe({ config: cfg, snapshot: snap, leader: row({ chmsIndividualId: 'L101' }), leaders: [], now: NOW });
    expect('admin' in plain).toBe(false);
  });
});

describe('admin.queues (the Follow-ups tab groups by these, in this order)', () => {
  const live = config();
  const three = {
    queues: [queue({ id: 'q1', name: 'Outreach' }), queue({ id: 'q2', name: 'Service' }), queue({ id: 'q3', name: 'Bible Study' })],
    entries: [entry({ id: 'a', queueId: 'q2', status: 'NOT_STARTED', assignee: lee })],
    // The excluded queue is dropped from `queues` by loadSnapshot; its id is reserved so no key can reach it.
    excludedQueueIds: ['qx'],
  };
  const adminQueues = (viewer: LeaderRow) => buildMe({ config: live, snapshot: three, leader: viewer, leaders: [viewer], now: NOW }).admin?.queues;

  it('staff get every non-excluded queue, in Lead order, with a whole-queue link', () => {
    const staff = row({ id: 1, name: 'Quinn', isAdmin: true });
    expect(adminQueues(staff)).toEqual([
      { id: 'q1', name: 'Outreach', url: 'https://example.com/step_individuals.php?ax=my&search_flag=1&step_id=q1&srch%5Bstatus_id%5D=&srch%5Bassigned%5D=all' },
      { id: 'q2', name: 'Service', url: 'https://example.com/step_individuals.php?ax=my&search_flag=1&step_id=q2&srch%5Bstatus_id%5D=&srch%5Bassigned%5D=all' },
      { id: 'q3', name: 'Bible Study', url: 'https://example.com/step_individuals.php?ax=my&search_flag=1&step_id=q3&srch%5Bstatus_id%5D=&srch%5Bassigned%5D=all' },
    ]);
  });

  it('a coordinator gets only their queues, still in Lead order; a key naming an excluded queue grants nothing', () => {
    const coordinator = (keys: string[]) => row({ id: 4, name: 'Cleo', coordinatorOf: keys });
    expect(adminQueues(coordinator(['Bible Study', 'q1']))!.map((q) => q.id)).toEqual(['q1', 'q3']);
    expect(adminQueues(coordinator(['Service']))!.map((q) => q.name)).toEqual(['Service']);
    expect(adminQueues(coordinator(['qx']))).toBeUndefined();
    expect(adminQueues(coordinator(['qx', 'q2']))!.map((q) => q.id)).toEqual(['q2']);
  });

  it('excluded queues are never listed, and a queue with nobody waiting is still listed', async () => {
    const cfg = { ...loadConfig(), dataSource: 'pushpay' as const, audience: 'everyone' as const };
    const snap = await loadSnapshot(createFixtureSource(NOW, cfg.timeZone), cfg);
    const staff = row({ id: 9, name: 'Owner', isAdmin: true, isOwner: true });
    const queues = buildMe({ config: cfg, snapshot: snap, leader: staff, leaders: [staff], now: NOW }).admin!.queues;
    expect(queues.map((q) => q.name)).toEqual(snap.queues.map((q) => q.name));
    expect(JSON.stringify(queues)).not.toMatch(/Not Interested|DONE/);
    // A listed queue need not have anyone waiting (the app then names it in "Nothing waiting in").
    expect(adminQueues(row({ id: 1, name: 'Quinn', isAdmin: true }))!.map((q) => q.id)).toContain('q1');
  });

  it('plain leaders and pre-launch callers get no admin key at all, so no queues', () => {
    expect('admin' in buildMe({ config: live, snapshot: three, leader: row({ id: 5, chmsIndividualId: 'L1', name: 'Lee' }), leaders: [], now: NOW })).toBe(false);
    const pre = buildMe({ config: config({ dataSource: 'fixture' }), snapshot: three, leader: row({ id: 6, name: 'Pat', coordinatorOf: ['Outreach'] }), leaders: [], now: NOW });
    expect('admin' in pre).toBe(false);
  });

  it('carries no people: only id, name and url', () => {
    for (const q of adminQueues(row({ id: 1, name: 'Quinn', isAdmin: true }))!) expect(Object.keys(q).sort()).toEqual(['id', 'name', 'url']);
  });
});

describe("a leader's Lead profile URL (docs/DECISIONS.md, 26)", () => {
  const live = config({ chmsBaseUrl: 'https://church.example' });
  const sample = { ...live, dataSource: 'fixture' as const };
  const staff = row({ id: 1, name: 'Quinn', isAdmin: true, chmsIndividualId: 'P-1' });
  const matched = row({ id: 2, name: 'Casey', chmsIndividualId: 'P 2/x' });
  const unmatched = row({ id: 3, name: 'Drew' });
  const everyone = [staff, matched, unmatched];
  const forLeaders = (cfg: typeof live, viewer: LeaderRow) => buildMe({ config: cfg, snapshot, leader: viewer, leaders: everyone, now: NOW }).admin?.leaders;

  it('staff get it for matched rows on real data, built from the template and encoded; nothing else about the person', () => {
    const leaders = forLeaders(live, staff)!;
    expect(leaders.find((l) => l.id === 2)!.leadUrl).toBe('https://church.example/goto/individuals/P%202%2Fx');
    expect(leaders.find((l) => l.id === 1)!.leadUrl).toBe('https://church.example/goto/individuals/P-1');
    for (const l of leaders) {
      // No bare id field of any kind, only the URL.
      expect(Object.keys(l).filter((k) => /chms|individual/i.test(k))).toEqual([]);
      expect(Object.keys(l)).not.toContain('id' + 'Lead');
    }
    const custom = forLeaders({ ...live, individualUrlTemplate: '{chmsBaseUrl}/people/{individualId}' }, staff)!;
    expect(custom.find((l) => l.id === 2)!.leadUrl).toBe('https://church.example/people/P%202%2Fx');
  });

  it('is absent for unmatched rows and on sample data', () => {
    expect('leadUrl' in forLeaders(live, staff)!.find((l) => l.id === 3)!).toBe(false);
    for (const l of forLeaders(sample, staff)!) expect('leadUrl' in l).toBe(false);
    expect(JSON.stringify(forLeaders(sample, staff))).not.toMatch(/goto|P-1/);
  });

  it('never reaches coordinators or plain leaders (they get no admin.leaders), nor students', () => {
    const coordinator = row({ id: 4, name: 'Cleo', chmsIndividualId: 'P-4', coordinatorOf: ['Outreach'] });
    for (const viewer of [coordinator, matched]) {
      const me = buildMe({ config: live, snapshot, leader: viewer, leaders: [...everyone, coordinator], now: NOW });
      expect(me.admin?.leaders).toBeUndefined();
      expect(JSON.stringify(me)).not.toMatch(/goto|leadUrl|P-1|P-4/);
    }
    // Students: item json carries only a name and phone for the person.
    const me = buildMe({ config: live, snapshot, leader: staff, leaders: everyone, now: NOW });
    const items = [...me.admin!.unassigned, ...me.admin!.byLeader.flatMap((g) => g.items)];
    for (const i of items) expect(Object.keys(i.individual).sort()).toEqual(['name', 'phone']);
  });
});

describe('subscription validation', () => {
  const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  it('accepts real push services only', () => {
    expect(parseSubscription({ endpoint: 'https://web.push.apple.com/abc', keys })).not.toBeNull();
    expect(parseSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys })).not.toBeNull();
    expect(parseSubscription({ endpoint: 'https://evil.example/x', keys })).toBeNull();
    expect(parseSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys })).toBeNull();
    expect(parseSubscription({ endpoint: 'https://fcm.googleapis.com.evil.example/x', keys })).toBeNull();
    // Only FCM itself, not every googleapis.com host.
    expect(parseSubscription({ endpoint: 'https://storage.googleapis.com/x', keys })).toBeNull();
    expect(parseSubscription({ endpoint: 'https://android.googleapis.com/gcm/send/x', keys })).toBeNull();
    expect(parseSubscription({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys })).not.toBeNull();
    expect(parseSubscription({ endpoint: 'https://wns2-by3p.notify.windows.com/w/?token=x', keys })).not.toBeNull();
    expect(parseSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, auth: 'AA' } })).toBeNull();
  });
});

describe('appBaseUrl', () => {
  it('uses the custom domain for personal links, even on pages.dev', async () => {
    const { appBaseUrl } = await import('../src/env');
    expect(appBaseUrl({}, 'https://holy-nudge.pages.dev/api/me')).toBe('https://holynudge.cameronbristol.xyz');
    expect(appBaseUrl({}, 'https://abc123.holy-nudge.pages.dev/api/me')).toBe('https://holynudge.cameronbristol.xyz');
    expect(appBaseUrl({}, 'https://holynudge.cameronbristol.xyz/api/me')).toBe('https://holynudge.cameronbristol.xyz');
    expect(appBaseUrl({}, 'http://localhost:8788/api/me')).toBe('http://localhost:8788');
    expect(appBaseUrl({ APP_BASE_URL: 'https://example.test/' }, 'https://holy-nudge.pages.dev/api/me')).toBe('https://example.test');
  });
});
