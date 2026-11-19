import { describe, expect, it } from 'vitest';
import { computeNudges, isBehind, isUnassigned } from '../src/core/behind';
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

describe('isUnassigned (the Unassigned list)', () => {
  it('is every not-DONE entry with nobody assigned, however recently it arrived', () => {
    expect(isUnassigned(entry({ assignee: null, status: 'NOT_STARTED' }))).toBe(true);
    expect(isUnassigned(entry({ assignee: null, status: 'IN_PROCESS' }))).toBe(true);
    expect(isUnassigned(entry({ assignee: null, status: 'WAITING' }))).toBe(true);
    expect(isUnassigned(entry({ assignee: null, status: 'NOT_STARTED', created: '2099-01-01' }))).toBe(true);
  });
  it('assigned or DONE is never unassigned', () => {
    expect(isUnassigned(entry({ assignee: person('L1') }))).toBe(false);
    expect(isUnassigned(entry({ assignee: null, status: 'DONE' }))).toBe(false);
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
    expect(m2r.unassigned.map((x) => x.id)).toEqual(['4']);
    expect(m1r.unassigned).toEqual([]);
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
      { adminId: 'M1', name: 'Mgr One', queueIds: ['A'], unassigned: [], behindByLeader: [] },
    ]);
  });
});
