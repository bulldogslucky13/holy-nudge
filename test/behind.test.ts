import { describe, expect, it } from 'vitest';
import { computeNudges, isBehind, isStaleUnassigned } from '../src/core/behind';
import type { Status } from '../src/core/types';
import { TZ, config, entry, person, queue } from './helpers';

// Tue 2026-06-16 12:00 Chicago (CDT, UTC-5)
const NOON = new Date('2026-06-16T17:00:00Z');
const behind = (status: Status, due: string | null, now = NOON) => isBehind(entry({ status, due }), now, TZ);

describe('isBehind: status x due matrix', () => {
  const past = '2026-06-15';
  const today = '2026-06-16';
  const future = '2026-06-17';

  it('NOT_STARTED is always behind', () => {
    for (const due of [past, today, future, null]) expect(behind('NOT_STARTED', due)).toBe(true);
  });
  it.each(['IN_PROCESS', 'WAITING'] as Status[])('%s: behind only when due is before today', (status) => {
    expect(behind(status, past)).toBe(true);
    expect(behind(status, today)).toBe(false);
    expect(behind(status, future)).toBe(false);
    expect(behind(status, null)).toBe(false);
  });
  it('DONE is never behind', () => {
    for (const due of [past, today, future, null]) expect(behind('DONE', due)).toBe(false);
  });
  it('Waiting with a future due date is not behind; due yesterday is', () => {
    expect(behind('WAITING', '2026-06-20')).toBe(false);
    expect(behind('IN_PROCESS', '2026-06-15')).toBe(true);
  });
});

describe('isBehind: Central midnight boundary', () => {
  it('already tomorrow in UTC but still the due date in Chicago: not behind', () => {
    // 2026-03-10T04:30Z = Mar 9 23:30 CDT
    const now = new Date('2026-03-10T04:30:00Z');
    expect(behind('IN_PROCESS', '2026-03-09', now)).toBe(false);
    expect(behind('IN_PROCESS', '2026-03-08', now)).toBe(true);
  });
  it('flips exactly at Chicago midnight', () => {
    expect(behind('IN_PROCESS', '2026-03-09', new Date('2026-03-10T04:59:59Z'))).toBe(false);
    expect(behind('IN_PROCESS', '2026-03-09', new Date('2026-03-10T05:00:00Z'))).toBe(true);
  });
  it('a due datetime whose UTC date is later than its Chicago date uses the Chicago date', () => {
    // 2026-03-10T02:00Z = Mar 9 21:00 CDT -> due date Mar 9
    const due = '2026-03-10T02:00:00Z';
    const midMar10 = new Date('2026-03-10T17:00:00Z'); // Mar 10 noon Chicago
    expect(behind('IN_PROCESS', due, midMar10)).toBe(true);
    expect(behind('IN_PROCESS', due, new Date('2026-03-10T04:30:00Z'))).toBe(false); // still Mar 9 in Chicago
  });
});

describe('isBehind: DST transitions 2026', () => {
  it('spring forward (Mar 8): date stays Mar 8 across 02:00->03:00', () => {
    const before = new Date('2026-03-08T07:59:00Z'); // 01:59 CST
    const after = new Date('2026-03-08T08:00:00Z'); // 03:00 CDT
    expect(behind('IN_PROCESS', '2026-03-08', before)).toBe(false);
    expect(behind('IN_PROCESS', '2026-03-08', after)).toBe(false);
  });
  it('spring forward: Mar 9 midnight is 05:00Z (CDT)', () => {
    expect(behind('IN_PROCESS', '2026-03-08', new Date('2026-03-09T04:59:00Z'))).toBe(false);
    expect(behind('IN_PROCESS', '2026-03-08', new Date('2026-03-09T05:00:00Z'))).toBe(true);
  });
  it('fall back (Nov 1): Nov 2 midnight is 06:00Z (CST)', () => {
    expect(behind('IN_PROCESS', '2026-11-01', new Date('2026-11-02T05:59:00Z'))).toBe(false); // 23:59 CST
    expect(behind('IN_PROCESS', '2026-11-01', new Date('2026-11-02T06:00:00Z'))).toBe(true);
  });
  it('fall back: repeated 01:xx hour stays Nov 1', () => {
    expect(behind('IN_PROCESS', '2026-10-31', new Date('2026-11-01T06:30:00Z'))).toBe(true); // 01:30 CDT
    expect(behind('IN_PROCESS', '2026-11-01', new Date('2026-11-01T06:30:00Z'))).toBe(false);
    expect(behind('IN_PROCESS', '2026-11-01', new Date('2026-11-01T07:30:00Z'))).toBe(false); // 01:30 CST
  });
  it('due datetime across fall back converts with the offset in force at that instant', () => {
    // 2026-11-02T05:30Z = Nov 1 23:30 CST, so the due date is Nov 1 even though its UTC date is Nov 2
    const due = '2026-11-02T05:30:00Z';
    expect(behind('IN_PROCESS', due, new Date('2026-11-02T05:59:00Z'))).toBe(false); // Nov 1 23:59 CST
    expect(behind('IN_PROCESS', due, new Date('2026-11-02T06:30:00Z'))).toBe(true); // Nov 2 00:30 CST
  });
});

describe('isBehind: due formats', () => {
  it('date-only and ISO datetime with offset give the same answer for the same Chicago date', () => {
    const now = new Date('2026-06-16T17:00:00Z');
    expect(behind('IN_PROCESS', '2026-06-15', now)).toBe(true);
    expect(behind('IN_PROCESS', '2026-06-15T23:30:00-05:00', now)).toBe(true);
    expect(behind('IN_PROCESS', '2026-06-16T00:30:00-05:00', now)).toBe(false);
    expect(behind('IN_PROCESS', '2026-06-16', now)).toBe(false);
  });
  it('datetime with no offset is treated as local', () => {
    expect(behind('IN_PROCESS', '2026-06-15T23:59:00', NOON)).toBe(true);
    expect(behind('IN_PROCESS', '2026-06-16T23:59:00', NOON)).toBe(false);
  });
  it('rejects garbage', () => {
    expect(() => behind('IN_PROCESS', 'next tuesday')).toThrow();
  });
});

describe('isStaleUnassigned', () => {
  const created = '2026-06-10T12:00:00Z';
  const c = new Date(created).getTime();
  const min = 60 * 1000;
  const stale = (over: Parameters<typeof entry>[0], nowMs: number) =>
    isStaleUnassigned(entry({ assignee: null, created, ...over }), new Date(nowMs), TZ);

  it('23h59m is not stale, 24h01m is', () => {
    expect(stale({}, c + 24 * 60 * min - min)).toBe(false);
    expect(stale({}, c + 24 * 60 * min + min)).toBe(true);
  });
  it('exactly 24h is not stale ("more than")', () => {
    expect(stale({}, c + 24 * 60 * min)).toBe(false);
  });
  it('assigned or DONE is never stale-unassigned', () => {
    const now = c + 100 * 60 * min;
    expect(stale({ assignee: person('L1') }, now)).toBe(false);
    expect(stale({ status: 'DONE' }, now)).toBe(false);
    expect(stale({ status: 'NOT_STARTED' }, now)).toBe(true);
    expect(stale({ status: 'WAITING' }, now)).toBe(true);
  });
  it('uses elapsed time across spring-forward (wall-clock day later, only 23h elapsed)', () => {
    const createdLocal = '2026-03-07T12:00:00-06:00'; // noon CST Mar 7
    const e = entry({ assignee: null, created: createdLocal });
    expect(isStaleUnassigned(e, new Date('2026-03-08T12:00:00-05:00'), TZ)).toBe(false); // 23h elapsed
    expect(isStaleUnassigned(e, new Date('2026-03-08T12:59:00-05:00'), TZ)).toBe(false); // 23h59m
    expect(isStaleUnassigned(e, new Date('2026-03-08T13:01:00-05:00'), TZ)).toBe(true); // 24h01m
  });
  it('uses elapsed time across fall-back (25h of wall clock is still just 24h elapsed at the edge)', () => {
    const createdLocal = '2026-10-31T12:00:00-05:00'; // noon CDT Oct 31
    const e = entry({ assignee: null, created: createdLocal });
    expect(isStaleUnassigned(e, new Date('2026-11-01T10:59:00-06:00'), TZ)).toBe(false); // 23h59m
    expect(isStaleUnassigned(e, new Date('2026-11-01T11:01:00-06:00'), TZ)).toBe(true); // 24h01m
  });

  describe('date-only created (Pushpay guide shows "YYYY-MM-DD") counts from the end of that Central day', () => {
    const e = entry({ assignee: null, created: '2026-01-14' }); // ends at 2026-01-15 00:00 CST = 06:00Z
    it('is not stale during the day it was created, nor the whole next day', () => {
      expect(isStaleUnassigned(e, new Date('2026-01-14T23:30:00-06:00'), TZ)).toBe(false);
      expect(isStaleUnassigned(e, new Date('2026-01-15T08:00:00-06:00'), TZ)).toBe(false); // next morning: would be 38h from UTC midnight
      expect(isStaleUnassigned(e, new Date('2026-01-15T23:59:00-06:00'), TZ)).toBe(false);
      expect(isStaleUnassigned(e, new Date('2026-01-16T00:00:00-06:00'), TZ)).toBe(false); // exactly 24h
    });
    it('is stale just after the following midnight', () => {
      expect(isStaleUnassigned(e, new Date('2026-01-16T00:01:00-06:00'), TZ)).toBe(true);
      expect(isStaleUnassigned(e, new Date('2026-01-16T08:00:00-06:00'), TZ)).toBe(true);
    });
    it('uses the Central day, not the UTC day, in summer (CDT)', () => {
      const s = entry({ assignee: null, created: '2026-07-01' }); // ends 2026-07-02 00:00 CDT = 05:00Z
      expect(isStaleUnassigned(s, new Date('2026-07-03T04:59:00Z'), TZ)).toBe(false); // 23:59 CDT Jul 2
      expect(isStaleUnassigned(s, new Date('2026-07-03T05:01:00Z'), TZ)).toBe(true);
    });
    it('handles a created day that ends on a DST change', () => {
      // Mar 7 ends at Mar 8 00:00 CST (06:00Z); 24h later is 06:00Z Mar 9 = 01:00 CDT Mar 9.
      const s = entry({ assignee: null, created: '2026-03-07' });
      expect(isStaleUnassigned(s, new Date('2026-03-09T05:59:00Z'), TZ)).toBe(false);
      expect(isStaleUnassigned(s, new Date('2026-03-09T06:01:00Z'), TZ)).toBe(true);
    });
  });

  it('takes a datetime with no offset as Central wall time', () => {
    const e = entry({ assignee: null, created: '2026-01-14 09:00:00' }); // 15:00Z
    expect(isStaleUnassigned(e, new Date('2026-01-15T14:59:00Z'), TZ)).toBe(false);
    expect(isStaleUnassigned(e, new Date('2026-01-15T15:01:00Z'), TZ)).toBe(true);
  });

  it('rejects an unparseable created value', () => {
    expect(() => isStaleUnassigned(entry({ assignee: null, created: 'soon' }), new Date(), TZ)).toThrow(RangeError);
  });
});

describe('computeNudges', () => {
  const lee = person('L1', 'Lee');
  const kim = person('L2', 'Kim');
  const m1 = person('M1', 'Mgr One');
  const m2 = person('M2', 'Mgr Two');
  const qA = queue({ id: 'A', name: 'Alpha', managers: [m1] });
  const qB = queue({ id: 'B', name: 'Beta', managers: [m2] });
  const qParking = queue({ id: 'P', name: 'Parking', managers: [m1] });
  const old = '2026-06-01T00:00:00Z';
  const e = (id: string, queueId: string, over = {}) =>
    entry({ id, queueId, created: old, due: '2026-06-01', ...over });

  const entries = [
    e('1', 'A', { assignee: lee }),
    e('2', 'A', { assignee: kim, status: 'DONE' }),
    e('3', 'B', { assignee: lee }),
    e('4', 'B', { assignee: null }),
    e('5', 'P', { assignee: kim, status: 'NOT_STARTED' }),
    e('6', 'A', { assignee: kim, status: 'WAITING', due: '2026-07-01' }),
  ];

  it('excluded queues (by name) are dropped before any rule runs; zero-behind leaders get no entry', () => {
    const r = computeNudges([qA, qB, qParking], entries, config({ excludedQueues: ['Parking'] }), NOON);
    expect(r.leaders.map((l) => l.leader.id)).toEqual(['L1']); // Kim has only DONE, waiting-future and excluded work
    expect(r.leaders[0]!.behind.map((x) => x.id)).toEqual(['1', '3']);
    expect(r.admins.flatMap((a) => a.behindByLeader.flatMap((g) => g.entries)).some((x) => x.id === '5')).toBe(false);
  });
  it('excluded queues can be matched by id', () => {
    const r = computeNudges([qA, qB, qParking], entries, config({ excludedQueues: ['P'] }), NOON);
    expect(r.leaders.map((l) => l.leader.id)).toEqual(['L1']);
  });
  it('without exclusion the parking queue shows up', () => {
    const r = computeNudges([qA, qB, qParking], entries, config(), NOON);
    expect(r.leaders.map((l) => l.leader.id)).toEqual(['L2', 'L1']); // sorted by name: Kim, Lee
  });
  it('falls back to queue managers as admins and groups by leader, unassigned last', () => {
    const r = computeNudges([qA, qB], entries, config(), NOON);
    expect(r.admins.map((a) => a.adminId)).toEqual(['M1', 'M2']);
    const m1r = r.admins[0]!;
    expect(m1r.queueIds).toEqual(['A']);
    expect(m1r.name).toBe('Mgr One');
    expect(m1r.behindByLeader.map((g) => [g.leader?.id, g.entries.map((x) => x.id)])).toEqual([['L1', ['1']]]);
    const m2r = r.admins[1]!;
    expect(m2r.behindByLeader.map((g) => [g.leader?.id ?? null, g.entries.map((x) => x.id)])).toEqual([
      ['L1', ['3']],
      [null, ['4']],
    ]);
    expect(m2r.staleUnassigned.map((x) => x.id)).toEqual(['4']);
    expect(m1r.staleUnassigned).toEqual([]);
  });
  it('config mapping overrides managers (by name or id); empty mapping falls back', () => {
    const cfg = config({ adminsByQueue: { Alpha: ['X9', 'M2'], B: [] } });
    const r = computeNudges([qA, qB], entries, cfg, NOON);
    expect(r.admins.map((a) => [a.adminId, a.queueIds])).toEqual([
      ['M2', ['A', 'B']],
      ['X9', ['A']],
    ]);
    const m2r = r.admins[0]!;
    expect(m2r.behindByLeader.flatMap((g) => g.entries.map((x) => x.id)).sort()).toEqual(['1', '3', '4']);
    expect(r.admins[1]!.name).toBeNull();
  });
  it('an admin with nothing to report is still listed with empty lists', () => {
    const r = computeNudges([qA], [e('2', 'A', { status: 'DONE' })], config(), NOON);
    expect(r.leaders).toEqual([]);
    expect(r.admins).toEqual([
      { adminId: 'M1', name: 'Mgr One', queueIds: ['A'], staleUnassigned: [], behindByLeader: [] },
    ]);
  });
});
