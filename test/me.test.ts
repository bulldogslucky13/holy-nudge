import { describe, expect, it } from 'vitest';
import { buildMe } from '../src/api/me';
import { createFixtureSource } from '../src/chms/fixture';
import { loadConfig } from '../src/core/config';
import type { LeaderRow } from '../src/db';
import { loadSnapshot } from '../src/job/load';
import { parseSubscription } from '../src/push/subscription';
import { config as baseConfig, entry, person, queue } from './helpers';

// Real data connected: the pre-launch gate is off, so these tests exercise the normal views.
const config = (over: Parameters<typeof baseConfig>[0] = {}) => baseConfig({ dataSource: 'pushpay', ...over });

const NOW = new Date('2026-01-15T14:00:00Z');
const row = (over: Partial<LeaderRow>): LeaderRow => ({
  id: 1, chmsIndividualId: null, name: 'X', hasLink: true, isAdmin: false, isOwner: false, lastSeenAt: null, revokedAt: null, subscriptionCount: 0, ...over,
});

const lee = person('L1', 'Lee');
const snapshot = {
  queues: [queue({ id: 'q1', name: 'Outreach', managers: [person('M1', 'Mara')] })],
  entries: [
    entry({ id: 'e1', queueId: 'q1', status: 'IN_PROCESS', due: '2026-01-08', assignee: lee, individual: { id: 'S1', name: 'Pat Example', phone: '555-0101', email: 'pat@example.com' } }),
    entry({ id: 'e2', queueId: 'q1', status: 'NOT_STARTED', due: '2026-01-20', assignee: lee }),
    entry({ id: 'e3', queueId: 'q1', status: 'NOT_STARTED', assignee: null, created: '2026-01-12T14:00:00Z' }),
    entry({ id: 'e4', queueId: 'q1', status: 'IN_PROCESS', due: '2026-01-14T23:30:00-06:00', assignee: person('L2', 'Liv') }),
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

  it('queue-manager admin view: stale unassigned, by leader (unassigned last), missing notifications, NO leader list', () => {
    const leaders = [
      row({ id: 1, chmsIndividualId: 'L1', name: 'Lee', subscriptionCount: 1 }),
      row({ id: 2, chmsIndividualId: 'L2', name: 'Liv' }),
      row({ id: 3, chmsIndividualId: 'M1', name: 'Mara' }),
    ];
    const me = buildMe({ config: config(), snapshot, leader: leaders[2]!, leaders, now: NOW });
    expect(me.leader.isAdmin).toBe(true);
    expect(me.behind).toEqual([]);
    const a = me.admin!;
    expect(a.staleUnassigned.map((i) => [i.entryId, i.hoursWaiting, i.daysOverdue])).toEqual([['e3', 72, null]]);
    expect(a.byLeader.map((g) => [g.leader, g.notificationsOn, g.items.map((i) => i.entryId)])).toEqual([
      [{ name: 'Lee' }, true, ['e1', 'e2']],
      [{ name: 'Liv' }, false, ['e4']],
      [null, false, ['e3']],
    ]);
    expect(a.byLeader[1]!.items[0]!.due).toBe('2026-01-14');
    expect(a.byLeader[1]!.items[0]!.daysOverdue).toBe(1);
    expect(a.leadersWithoutNotifications).toEqual([{ name: 'Liv' }]);
    // Implicit (queue-manager) admins get no link features at all.
    expect('leaders' in a).toBe(false);
    expect(JSON.stringify(me)).not.toMatch(/\/l\/|"url"|token/i);
    for (const i of [...a.staleUnassigned, ...a.byLeader.flatMap((g) => g.items)]) expect(Object.keys(i.individual)).toEqual(['name', 'phone']);
  });

  it('staff (is_admin) see every queue and the leader list (no links); non-admins get no admin key', async () => {
    const cfg = { ...loadConfig(), dataSource: 'pushpay' as const }; // live, but with the fixture snapshot as sample rows
    const snap = await loadSnapshot(createFixtureSource(NOW, cfg.timeZone), cfg);
    const owner = row({ id: 9, name: 'Owner', isAdmin: true, isOwner: true, lastSeenAt: '2026-01-15T13:00:00.000Z', subscriptionCount: 1 });
    const staff = row({ id: 4, name: 'Staffer', isAdmin: true });
    const plainLeader = row({ id: 5, name: 'Ava', hasLink: false });
    const leaders = [owner, staff, plainLeader];
    const me = buildMe({ config: cfg, snapshot: snap, leader: owner, leaders, now: NOW });
    expect(me.admin!.byLeader.length).toBeGreaterThan(1);
    expect(me.admin!.leaders).toEqual([
      { id: 5, name: 'Ava', hasLink: false, lastSeenAt: null, notificationsOn: false, isStaff: false, canManage: true, isYou: false },
      { id: 9, name: 'Owner', hasLink: true, lastSeenAt: '2026-01-15T13:00:00.000Z', notificationsOn: true, isStaff: true, canManage: true, isYou: true },
      { id: 4, name: 'Staffer', hasLink: true, lastSeenAt: null, notificationsOn: false, isStaff: true, canManage: true, isYou: false },
    ]);
    // A non-owner staff member cannot manage the owner's row.
    const asStaff = buildMe({ config: cfg, snapshot: snap, leader: staff, leaders, now: NOW });
    expect(asStaff.admin!.leaders!.find((l) => l.id === 9)!.canManage).toBe(false);
    expect(JSON.stringify(me)).not.toMatch(/\/l\/|"url"|token|email/i);
    const plain = buildMe({ config: cfg, snapshot: snap, leader: row({ chmsIndividualId: 'L101' }), leaders: [], now: NOW });
    expect('admin' in plain).toBe(false);
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
