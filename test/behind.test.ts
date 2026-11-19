import { describe, expect, it } from 'vitest';
import {
  allQueuesView,
  computeNudges,
  isBehind,
  isNewSinceLastRun,
  isOverdue,
  isPastFirstText,
  isUnassigned,
  ownTriggered,
  queueIdsForKeys,
  summaryTriggered,
} from '../src/core/behind';
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
    expect(allQueuesView([qA, qB, qParking], entries, config({ excludedQueues: ['Parking'] }), NOON).behindByLeader.flatMap((g) => g.entries).some((x) => x.id === '5')).toBe(false);
  });
  it('excluded queues can be matched by id', () => {
    const r = computeNudges([qA, qB, qParking], entries, config({ excludedQueues: ['P'] }), NOON);
    expect(r.leaders.map((l) => l.leader.id)).toEqual(['L1']);
  });
  it('without exclusion the parking queue shows up', () => {
    const r = computeNudges([qA, qB, qParking], entries, config(), NOON);
    expect(r.leaders.map((l) => l.leader.id)).toEqual(['L2', 'L1']); // sorted by name: Kim, Lee
  });
  it('Lead queue managers grant nothing: with no coordinators, nobody gets a whole-queue view', () => {
    const r = computeNudges([qA, qB], entries, config(), NOON);
    expect(r.coordinators).toEqual([]);
    expect(computeNudges([qA, qB], entries, config(), NOON, [])).toEqual(r);
  });
  it('a coordinator sees exactly their queues (by id or exact name), grouped by leader, unassigned last', () => {
    const r = computeNudges([qA, qB, qParking], entries, config(), NOON, [
      { leaderId: 7, queueKeys: ['A'] },
      { leaderId: 3, queueKeys: ['Beta'] },
    ]);
    expect(r.coordinators.map((c) => [c.leaderId, c.queueIds])).toEqual([[3, ['B']], [7, ['A']]]);
    const a = r.coordinators[1]!;
    expect(a.behindByLeader.map((g) => [g.leader?.id, g.entries.map((x) => x.id)])).toEqual([['L1', ['1']]]);
    expect(a.unassigned).toEqual([]);
    const b = r.coordinators[0]!;
    expect(b.behindByLeader.map((g) => [g.leader?.id ?? null, g.entries.map((x) => x.id)])).toEqual([
      ['L1', ['3']],
      [null, ['4']],
    ]);
    expect(b.unassigned.map((x) => x.id)).toEqual(['4']);
  });
  it('several keys (and the same row listed twice) give the union, in queue order', () => {
    const r = computeNudges([qA, qB], entries, config(), NOON, [
      { leaderId: 1, queueKeys: ['Beta'] },
      { leaderId: 1, queueKeys: ['A'] },
    ]);
    expect(r.coordinators.map((c) => [c.leaderId, c.queueIds])).toEqual([[1, ['A', 'B']]]);
    expect(r.coordinators[0]!.behindByLeader.flatMap((g) => g.entries.map((x) => x.id)).sort()).toEqual(['1', '3', '4']);
  });
  it('unknown keys, near-miss names and excluded queues grant nothing; such a coordinator is left out', () => {
    const r = computeNudges([qA, qB, qParking], entries, config({ excludedQueues: ['Parking'] }), NOON, [
      { leaderId: 1, queueKeys: ['alpha', 'Alpha ', 'Z', ''] },
      { leaderId: 2, queueKeys: ['Parking', 'P'] },
      { leaderId: 3, queueKeys: [] },
    ]);
    expect(r.coordinators).toEqual([]);
  });
  it('a key equal to a queue id matches that queue only, never another queue named like it', () => {
    const q5 = queue({ id: '5', name: 'Five' });
    const named5 = queue({ id: '9', name: '5' });
    expect(queueIdsForKeys([q5, named5], ['5'])).toEqual(['5']);
    expect(queueIdsForKeys([q5, named5], ['Five', '9'])).toEqual(['5', '9']);
    // An excluded queue's id does not fall through to a name match either.
    const r = computeNudges([q5, named5], [], config({ excludedQueues: ['Five'] }), NOON, [{ leaderId: 1, queueKeys: ['5'] }]);
    expect(r.coordinators).toEqual([]);
  });
  it('a coordinator with nothing to report is still listed with empty lists', () => {
    const r = computeNudges([qA], [e('2', 'A', { status: 'DONE' })], config(), NOON, [{ leaderId: 4, queueKeys: ['Alpha'] }]);
    expect(r.leaders).toEqual([]);
    expect(r.coordinators).toEqual([{ leaderId: 4, queueIds: ['A'], unassigned: [], behindByLeader: [] }]);
  });
  it('allQueuesView (staff) covers every non-excluded queue, whoever manages it', () => {
    const v = allQueuesView([qA, qB, qParking], entries, config({ excludedQueues: ['Parking'] }), NOON);
    expect(v.queueIds).toEqual(['A', 'B']);
    expect(v.behindByLeader.flatMap((g) => g.entries.map((x) => x.id)).sort()).toEqual(['1', '3', '4']);
  });
});

describe('when the push fires', () => {
  const cfg = config();
  const H = 3600_000;
  // Mornings at 08:00 Chicago (CST in January = 14:00Z).
  const morning = (day: number) => new Date(Date.UTC(2026, 0, day, 14));
  const win = (day: number, lastDay: number | null = day - 1) => ({ now: morning(day), lastRunAt: lastDay === null ? null : morning(lastDay) });

  describe('isNewSinceLastRun', () => {
    it('is new when created after the start of the last successful run, not at or before it', () => {
      const w = win(15);
      expect(isNewSinceLastRun(entry({ created: '2026-01-14T14:00:01Z' }), w, TZ)).toBe(true);
      expect(isNewSinceLastRun(entry({ created: '2026-01-14T14:00:00Z' }), w, TZ)).toBe(false);
      expect(isNewSinceLastRun(entry({ created: '2026-01-13T20:00:00Z' }), w, TZ)).toBe(false);
    });
    it('uses the last successful run, however long ago (a failed day in between misses nobody)', () => {
      const w = win(15, 12);
      expect(isNewSinceLastRun(entry({ created: '2026-01-12T20:00:00Z' }), w, TZ)).toBe(true);
    });
    it('with no previous run, the last 24 hours count as new', () => {
      const w = win(15, null);
      expect(isNewSinceLastRun(entry({ created: new Date(morning(15).getTime() - 24 * H + 60_000).toISOString() }), w, TZ)).toBe(true);
      expect(isNewSinceLastRun(entry({ created: new Date(morning(15).getTime() - 24 * H - 60_000).toISOString() }), w, TZ)).toBe(false);
      // Date-only yesterday ends at today's midnight (8h ago): new. The day before: 32h, not new.
      expect(isNewSinceLastRun(entry({ created: '2026-01-14' }), w, TZ)).toBe(true);
      expect(isNewSinceLastRun(entry({ created: '2026-01-13' }), w, TZ)).toBe(false);
    });

    describe('date-only created: never missed, new on at most two consecutive mornings', () => {
      // Arrived on Jan 14, recorded as "2026-01-14" (taken as the end of that day, Jan 15 00:00 CST).
      const e = entry({ created: '2026-01-14' });
      const newOn = (day: number) => isNewSinceLastRun(e, win(day), TZ);
      it('already in the queue at the Jan 14 run: new on Jan 14 and again on Jan 15 (the one accepted repeat)', () => {
        expect([newOn(14), newOn(15), newOn(16), newOn(17)]).toEqual([true, true, false, false]);
      });
      it('added after the Jan 14 run: not seen that morning, new on Jan 15, quiet after', () => {
        // The Jan 14 run could not see it; the first run that can is Jan 15, and it is new there.
        expect([newOn(15), newOn(16)]).toEqual([true, false]);
      });
      it('a datetime created is new exactly once', () => {
        const early = entry({ created: '2026-01-14T07:00:00-06:00' }); // before the Jan 14 run
        expect([14, 15, 16].map((day) => isNewSinceLastRun(early, win(day), TZ))).toEqual([true, false, false]);
        const late = entry({ created: '2026-01-14T10:00:00-06:00' }); // after it: first seen Jan 15
        expect([15, 16].map((day) => isNewSinceLastRun(late, win(day), TZ))).toEqual([true, false]);
      });
      it('after a missed morning (run failed on Jan 15), still new on Jan 16 and not after', () => {
        expect(isNewSinceLastRun(e, win(16, 14), TZ)).toBe(true);
        expect(isNewSinceLastRun(e, win(17, 16), TZ)).toBe(false);
      });
    });
  });

  describe('isOverdue', () => {
    const now = morning(15);
    const o = (over: Parameters<typeof entry>[0]) => isOverdue(entry(over), now, cfg);
    it('with a due date: overdue once the due calendar date is before today, whatever the status (not DONE)', () => {
      for (const status of ['NOT_STARTED', 'IN_PROCESS', 'WAITING'] as Status[]) {
        expect(o({ status, due: '2026-01-14' })).toBe(true);
        expect(o({ status, due: '2026-01-15' })).toBe(false);
      }
      expect(o({ status: 'DONE', due: '2026-01-01' })).toBe(false);
    });
    it('the due date wins over age: an old Not Started card due next week is not overdue', () => {
      expect(o({ status: 'NOT_STARTED', due: '2026-01-20', created: '2025-12-01T00:00:00Z' })).toBe(false);
    });
    it('no due date, Not Started: overdue only after followUpDays (7) of elapsed time', () => {
      const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
      expect(o({ status: 'NOT_STARTED', created: ago(7 * 24 * H - 60_000) })).toBe(false);
      expect(o({ status: 'NOT_STARTED', created: ago(7 * 24 * H) })).toBe(false);
      expect(o({ status: 'NOT_STARTED', created: ago(7 * 24 * H + 60_000) })).toBe(true);
      expect(isOverdue(entry({ status: 'NOT_STARTED', created: ago(4 * 24 * H) }), now, { ...cfg, followUpDays: 3 })).toBe(true);
    });
    it('no due date, In Process or Waiting: never overdue', () => {
      for (const status of ['IN_PROCESS', 'WAITING'] as Status[]) expect(o({ status, created: '2025-06-01T00:00:00Z' })).toBe(false);
    });
    it('a date-only created counts its week from the end of that day', () => {
      // Jan 7 ends Jan 8 00:00 CST; a week later is Jan 15 00:00, so the Jan 15 08:00 run is the first overdue morning.
      expect(isOverdue(entry({ status: 'NOT_STARTED', created: '2026-01-07' }), morning(14), cfg)).toBe(false);
      expect(isOverdue(entry({ status: 'NOT_STARTED', created: '2026-01-07' }), morning(15), cfg)).toBe(true);
    });
  });

  describe('isPastFirstText (72 hours)', () => {
    const created = '2026-01-12T14:00:00Z';
    const at = (ms: number) => new Date(Date.parse(created) + ms);
    it('more than 72 elapsed hours', () => {
      expect(isPastFirstText(entry({ created }), at(72 * H), cfg)).toBe(false);
      expect(isPastFirstText(entry({ created }), at(72 * H + 60_000), cfg)).toBe(true);
      expect(isPastFirstText(entry({ created }), at(49 * H), { ...cfg, firstTextHours: 48 })).toBe(true);
    });
    it('uses elapsed time across spring-forward (three wall-clock days are only 71 hours)', () => {
      const e = entry({ created: '2026-03-06T12:00:00-06:00' }); // noon CST Fri Mar 6
      expect(isPastFirstText(e, new Date('2026-03-09T12:00:00-05:00'), cfg)).toBe(false); // 71h
      expect(isPastFirstText(e, new Date('2026-03-09T13:01:00-05:00'), cfg)).toBe(true); // 72h01m
    });
    it('date-only created counts from the end of that Central day; no-offset datetimes are Central wall time', () => {
      const d = entry({ created: '2026-01-11' }); // ends Jan 12 00:00 CST = 06:00Z
      expect(isPastFirstText(d, new Date('2026-01-15T06:00:00Z'), cfg)).toBe(false);
      expect(isPastFirstText(d, new Date('2026-01-15T06:01:00Z'), cfg)).toBe(true);
      const l = entry({ created: '2026-01-12 09:00:00' }); // 15:00Z
      expect(isPastFirstText(l, new Date('2026-01-15T15:01:00Z'), cfg)).toBe(true);
      expect(isPastFirstText(l, new Date('2026-01-15T14:59:00Z'), cfg)).toBe(false);
    });
    it('rejects an unparseable created value', () => {
      expect(() => isPastFirstText(entry({ created: 'soon' }), new Date(), cfg)).toThrow(RangeError);
    });
  });

  describe('ownTriggered: a leader\'s own push', () => {
    const w = win(15);
    const hoursAgo = (h: number) => new Date(morning(15).getTime() - h * H).toISOString();
    const fires = (over: Parameters<typeof entry>[0]) => ownTriggered([entry(over)], w, cfg);
    it('fires for a new Not Started student, then is quiet through the grace week', () => {
      expect(fires({ status: 'NOT_STARTED', created: hoursAgo(2) })).toBe(true);
      expect(fires({ status: 'NOT_STARTED', created: hoursAgo(30) })).toBe(false);
      expect(fires({ status: 'NOT_STARTED', created: hoursAgo(6 * 24) })).toBe(false);
    });
    it('fires daily once overdue, by age or by due date', () => {
      expect(fires({ status: 'NOT_STARTED', created: hoursAgo(8 * 24) })).toBe(true);
      expect(fires({ status: 'IN_PROCESS', due: '2026-01-13', created: hoursAgo(30) })).toBe(true);
    });
    it('a new student already In Process does not fire; Done never does', () => {
      expect(fires({ status: 'IN_PROCESS', created: hoursAgo(2) })).toBe(false);
      expect(fires({ status: 'DONE', due: '2026-01-01', created: hoursAgo(2) })).toBe(false);
    });
    it('one firing student is enough', () => {
      expect(ownTriggered([entry({ status: 'NOT_STARTED', created: hoursAgo(30) }), entry({ status: 'NOT_STARTED', created: hoursAgo(1) })], w, cfg)).toBe(true);
    });
  });

  describe('summaryTriggered: a queue summary', () => {
    const m1 = person('M1', 'Mgr One');
    const qA = queue({ id: 'A', name: 'Alpha', managers: [m1] });
    const w = win(15);
    const hoursAgo = (h: number) => new Date(morning(15).getTime() - h * H).toISOString();
    const fires = (...es: Parameters<typeof entry>[0][]) => {
      const r = computeNudges([qA], es.map((over, i) => entry({ id: `x${i}`, queueId: 'A', ...over })), cfg, w.now, [{ leaderId: 1, queueKeys: ['A'] }]);
      return summaryTriggered(r.coordinators[0]!, w, cfg);
    };
    it('fires for a new unassigned student, any status', () => {
      expect(fires({ assignee: null, status: 'NOT_STARTED', created: hoursAgo(3) })).toBe(true);
      expect(fires({ assignee: null, status: 'IN_PROCESS', created: hoursAgo(3) })).toBe(true);
    });
    it('is quiet for an unassigned student 2 days old, fires again once past 72 hours', () => {
      expect(fires({ assignee: null, status: 'NOT_STARTED', created: hoursAgo(48) })).toBe(false);
      expect(fires({ assignee: null, status: 'NOT_STARTED', created: hoursAgo(96) })).toBe(true);
    });
    it('does not fire just because someone else got a new assignment', () => {
      expect(fires({ assignee: person('L1', 'Lee'), status: 'NOT_STARTED', created: hoursAgo(2) })).toBe(false);
    });
    it('fires when an assigned student in scope is overdue', () => {
      expect(fires({ assignee: person('L1', 'Lee'), status: 'NOT_STARTED', created: hoursAgo(8 * 24) })).toBe(true);
      expect(fires({ assignee: person('L1', 'Lee'), status: 'WAITING', due: '2026-01-10', created: hoursAgo(30) })).toBe(true);
    });
    it('Done students never fire it', () => {
      expect(fires({ assignee: null, status: 'DONE', created: hoursAgo(2) }, { assignee: null, status: 'DONE', created: hoursAgo(200) })).toBe(false);
    });
  });
});
