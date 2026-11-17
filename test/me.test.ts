import { describe, expect, it } from 'vitest';
import { buildMe } from '../src/api/me';
import { createFixtureSource } from '../src/chms/fixture';
import { loadConfig } from '../src/core/config';
import type { LeaderRow } from '../src/db';
import { loadSnapshot } from '../src/job/load';
import { parseSubscription } from '../src/push/subscription';
import { config, entry, person, queue } from './helpers';

const NOW = new Date('2026-01-15T14:00:00Z');
const row = (over: Partial<LeaderRow>): LeaderRow => ({
  id: 1, chmsIndividualId: null, name: 'X', token: 'tok', isAdmin: false, isOwner: false, subscriptionCount: 0, ...over,
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
    const me = buildMe({ config: config(), snapshot, leader, leaders: [leader], now: NOW, baseUrl: 'https://h.example' });
    expect(me).toEqual({
      leader: { name: 'Lee', isAdmin: false, notificationsOn: true },
      behind: [
        {
          entryId: 'e1', queueId: 'q1', queueName: 'Outreach',
          queueUrl: 'https://example.com/process_queue_list.php?queue_id=q1',
          status: 'IN_PROCESS', due: '2026-01-08', daysOverdue: 7,
          individual: { name: 'Pat Example', phone: '555-0101', email: 'pat@example.com' },
        },
        {
          entryId: 'e2', queueId: 'q1', queueName: 'Outreach',
          queueUrl: 'https://example.com/process_queue_list.php?queue_id=q1',
          status: 'NOT_STARTED', due: '2026-01-20', daysOverdue: null,
          individual: { name: 'Sam', phone: null, email: null },
        },
      ],
      generatedAt: '2026-01-15T14:00:00Z',
    });
  });

  it('admin view: stale unassigned, by leader (unassigned last), missing notifications, links', () => {
    const leaders = [
      row({ id: 1, chmsIndividualId: 'L1', name: 'Lee', token: 'tokLee', subscriptionCount: 1 }),
      row({ id: 2, chmsIndividualId: 'L2', name: 'Liv', token: 'tokLiv' }),
      row({ id: 3, chmsIndividualId: 'M1', name: 'Mara', token: 'tokMara' }),
    ];
    const me = buildMe({ config: config(), snapshot, leader: leaders[2]!, leaders, now: NOW, baseUrl: 'https://h.example/' });
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
    expect(a.leaderLinks).toEqual([
      { name: 'Lee', url: 'https://h.example/l/tokLee' },
      { name: 'Liv', url: 'https://h.example/l/tokLiv' },
    ]);
  });

  it('is_admin leaders see every queue and every leader link; non-admins get no admin key', async () => {
    const cfg = loadConfig();
    const snap = await loadSnapshot(createFixtureSource(NOW, cfg.timeZone), cfg);
    const owner = row({ id: 9, name: 'Owner', isAdmin: true, token: 'tokOwner' });
    const me = buildMe({ config: cfg, snapshot: snap, leader: owner, leaders: [owner], now: NOW, baseUrl: 'https://h.example' });
    expect(me.admin!.byLeader.length).toBeGreaterThan(1);
    expect(me.admin!.leaderLinks).toEqual([{ name: 'Owner', url: 'https://h.example/l/tokOwner' }]);
    const plain = buildMe({ config: cfg, snapshot: snap, leader: row({ chmsIndividualId: 'L101' }), leaders: [], now: NOW, baseUrl: 'x' });
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
