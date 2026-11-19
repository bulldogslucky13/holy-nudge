import { describe, expect, it, vi } from 'vitest';
import { OAuthTokenError } from '../src/chms/oauth';
import { ChmsApiError, IncompleteDataError } from '../src/chms/pushpay';
import { ReauthorizationRequired, TokenPersistError, TokenRefreshError } from '../src/chms/tokens';
import { alertPayload } from '../src/push/payload';
import { createTestD1 } from './sqlite-d1';
import { createDataSource } from '../src/chms/index';
import type { DataSource, QueueEntry } from '../src/core/types';
import { JobFailedError, alertReason, describeFailure, localHour, runDailyJob } from '../src/job/daily';
import { resolveMe } from '../src/api/me';
import { FakeSender, FakeStore } from './fakes';
import { config, entry, person, queue, TEST_TOKEN_KEY } from './helpers';

// Live: the data source is injected below, and the pre-launch rules (fixture config) have their own tests.
const cfg = config({ excludedQueues: ['Not Interested'], dataSource: 'pushpay' });
const NOW = new Date('2026-01-15T14:00:00Z'); // 08:00 CST

const lee = person('L1', 'Lee');
const liv = person('L2', 'Liv');
const queues = [
  queue({ id: 'q1', name: 'Outreach', managers: [person('M1', 'Mara')] }),
  queue({ id: 'q2', name: 'Staff', managers: [person('M2', 'Milo')] }),
  queue({ id: 'qx', name: 'Not Interested', managers: [person('M1', 'Mara')] }),
];
const entries: QueueEntry[] = [
  entry({ id: 'e1', queueId: 'q1', status: 'NOT_STARTED', assignee: lee }),
  entry({ id: 'e2', queueId: 'q1', status: 'IN_PROCESS', due: '2026-01-10', assignee: lee }),
  entry({ id: 'e3', queueId: 'q2', status: 'NOT_STARTED', assignee: liv }),
  entry({ id: 'e4', queueId: 'q2', status: 'WAITING', due: '2026-01-20', assignee: liv }),
  entry({ id: 'e5', queueId: 'q1', status: 'NOT_STARTED', assignee: null, created: '2026-01-12T00:00:00Z' }),
  entry({ id: 'e6', queueId: 'qx', status: 'NOT_STARTED', assignee: person('L3', 'Lou') }),
];

function source(over: Partial<DataSource> = {}): DataSource {
  return {
    listQueues: async () => queues,
    listEntries: async (id) => entries.filter((e) => e.queueId === id),
    ...over,
  };
}

function setup() {
  const store = new FakeStore();
  const lee1 = store.addLeader({ chmsIndividualId: 'L1', name: 'Lee' }, 2);
  const mara = store.addLeader({ chmsIndividualId: 'M1', name: 'Mara' }, 1);
  const milo = store.addLeader({ chmsIndividualId: 'M2', name: 'Milo' }, 1);
  const owner = store.addLeader({ name: 'Owner', isAdmin: true, isOwner: true }, 1);
  const sender = new FakeSender([`https://push.example/${lee1}/1`]);
  return { store, sender, ids: { lee1, mara, milo, owner } };
}

const bodiesFor = (sender: FakeSender, leaderId: number) =>
  sender.sent.filter((s) => s.endpoint.startsWith(`https://push.example/${leaderId}/`)).map((s) => s.payload);

describe('daily job', () => {
  it('sends one nudge per behind leader and one summary per admin, counts only', async () => {
    const { store, sender, ids } = setup();
    const out = await runDailyJob({ config: cfg, store, sender, dataSource: () => source(), now: NOW });
    expect(out.ran).toBe(true);

    expect(bodiesFor(sender, ids.lee1)).toEqual([{ title: '2 students are waiting on you', body: 'Tap to see who could use a hello', kind: 'leader', count: 2 }]);
    expect(bodiesFor(sender, ids.mara).map((p) => `${p.title} | ${p.body}`)).toEqual(['3 students waiting | Across 1 leader, 1 unassigned']);
    expect(bodiesFor(sender, ids.milo).map((p) => `${p.title} | ${p.body}`)).toEqual(['1 student waiting | Across 1 leader']);
    expect(bodiesFor(sender, ids.owner)).toEqual([
      { title: '4 students waiting', body: 'Across 2 leaders, 1 unassigned', kind: 'admin', count: 4 },
    ]);
    // No payload ever carries a name.
    for (const s of sender.sent) expect(JSON.stringify(s.payload)).not.toMatch(/Lee|Liv|Mara|Sam/);

    // Upserts every assignee and manager of non-excluded queues; excluded-only Lou is not added.
    const chmsIds = store.leaders.map((l) => l.chmsIndividualId).filter(Boolean).sort();
    expect(chmsIds).toEqual(['L1', 'L2', 'M1', 'M2']);
    // Existing rows keep their token.
    expect(store.leaders.find((l) => l.id === ids.lee1)!.linkToken).toBe(`tok-${ids.lee1}`);

    // The 410 device was removed.
    expect(store.subs.filter((s) => s.leaderId === ids.lee1)).toHaveLength(1);

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.ok).toBe(true);
    expect(store.runs[0]!.summary).toMatchObject({
      queues: 2,
      entries: 5,
      leadersBehind: 2,
      behind: 3,
      leadersNudged: 1, // Liv has no device yet
      adminsNudged: 3,
      pushesSent: 4,
      subscriptionsRemoved: 1,
    });
    expect(JSON.stringify(store.runs[0]!.summary)).not.toMatch(/Lee|Liv|Mara/);
  });

  describe('one push per person per morning', () => {
    // Mara manages q1 and also has her own students behind there; the owner (staff) is also assigned students.
    const mara = person('M1', 'Mara');
    const owner = person('O1', 'Ozzie Owner');
    const both: QueueEntry[] = [
      ...entries,
      entry({ id: 'e7', queueId: 'q1', status: 'NOT_STARTED', assignee: mara }),
      entry({ id: 'e8', queueId: 'q2', status: 'NOT_STARTED', assignee: owner }),
      entry({ id: 'e9', queueId: 'q2', status: 'NOT_STARTED', assignee: owner }),
    ];
    const src = () => source({ listEntries: async (id) => both.filter((e) => e.queueId === id) });

    function setupBoth() {
      const s = setup();
      s.store.leaders.find((l) => l.id === s.ids.owner)!.chmsIndividualId = 'O1';
      return s;
    }

    it('own students + a summary: one combined push (title as the leader nudge, body the summary, opens their list)', async () => {
      const { store, sender, ids } = setupBoth();
      const out = await runDailyJob({ config: cfg, store, sender, dataSource: src, now: NOW });
      expect(bodiesFor(sender, ids.mara)).toEqual([{ title: '1 student is waiting on you', body: '4 waiting across your queues, 1 unassigned', kind: 'leader', count: 1 }]);
      expect(bodiesFor(sender, ids.owner)).toEqual([{ title: '2 students are waiting on you', body: '7 waiting across all queues, 1 unassigned', kind: 'leader', count: 2 }]);
      // Only own, or only a summary: unchanged.
      expect(bodiesFor(sender, ids.lee1)).toEqual([{ title: '2 students are waiting on you', body: 'Tap to see who could use a hello', kind: 'leader', count: 2 }]);
      expect(bodiesFor(sender, ids.milo)).toEqual([{ title: '3 students waiting', body: 'Across 2 leaders', kind: 'admin', count: 3 }]);
      // Exactly one push per device.
      const perEndpoint = new Map<string, number>();
      for (const s of sender.sent) perEndpoint.set(s.endpoint, (perEndpoint.get(s.endpoint) ?? 0) + 1);
      expect([...perEndpoint.values()].every((n) => n === 1)).toBe(true);
      expect(out.ran && out.summary).toMatchObject({ leadersNudged: 3, adminsNudged: 3, combinedNudged: 2, pushesSent: 4 });
    });

    it('drops the unassigned part when nobody is unassigned', async () => {
      const { store, sender, ids } = setupBoth();
      const noUnassigned = both.filter((e) => e.assignee !== null);
      await runDailyJob({ config: cfg, store, sender, dataSource: () => source({ listEntries: async (id) => noUnassigned.filter((e) => e.queueId === id) }), now: NOW });
      expect(bodiesFor(sender, ids.mara).map((p) => p.body)).toEqual(['3 waiting across your queues']);
      expect(bodiesFor(sender, ids.owner).map((p) => p.body)).toEqual(['6 waiting across all queues']);
    });

    it('before launch, a non-staff queue manager with own students still gets nothing; staff get the combined push', async () => {
      const { store, sender, ids } = setupBoth();
      await runDailyJob({ config: { ...cfg, dataSource: 'fixture' }, store, sender, dataSource: src, now: NOW });
      expect(bodiesFor(sender, ids.mara)).toEqual([]);
      expect(bodiesFor(sender, ids.lee1)).toEqual([]);
      expect(bodiesFor(sender, ids.owner).map((p) => p.kind)).toEqual(['leader']);
      expect(sender.sent).toHaveLength(1);
    });
  });

  describe('time gate (morningHour 8, America/Chicago)', () => {
    const cases: [string, string, boolean][] = [
      ['winter 13:00Z = 07:00 CST', '2026-01-15T13:00:00Z', false],
      ['winter 14:00Z = 08:00 CST', '2026-01-15T14:00:00Z', true],
      ['summer 13:00Z = 08:00 CDT', '2026-07-15T13:00:00Z', true],
      ['summer 14:00Z = 09:00 CDT', '2026-07-15T14:00:00Z', false],
      ['spring-forward day 13:00Z = 08:00 CDT', '2026-03-08T13:00:00Z', true],
      ['spring-forward day 14:00Z = 09:00 CDT', '2026-03-08T14:00:00Z', false],
      ['fall-back day 13:00Z = 07:00 CST', '2026-11-01T13:00:00Z', false],
      ['fall-back day 14:00Z = 08:00 CST', '2026-11-01T14:00:00Z', true],
    ];
    for (const [label, iso, runs] of cases) {
      it(`${label} -> ${runs ? 'runs' : 'skips'}`, async () => {
        const { store, sender } = setup();
        const out = await runDailyJob({ config: cfg, store, sender, dataSource: () => source(), now: new Date(iso) });
        expect(out.ran).toBe(runs);
        expect(store.runs).toHaveLength(runs ? 1 : 0);
      });
    }
    it('exactly one of the two daily crons passes, every day of 2026', () => {
      for (let d = 0; d < 365; d++) {
        const day = new Date(Date.UTC(2026, 0, 1 + d));
        const at = (h: number) => localHour(new Date(day.getTime() + h * 3600_000), 'America/Chicago') === 8;
        expect(Number(at(13)) + Number(at(14))).toBe(1);
      }
    });
    it('force runs at any hour', async () => {
      const { store, sender } = setup();
      const out = await runDailyJob({ config: cfg, store, sender, dataSource: () => source(), now: new Date('2026-01-15T09:00:00Z'), force: true });
      expect(out.ran).toBe(true);
    });
  });

  describe('failure path', () => {
    it('records a failed run, alerts only owners, and rethrows when the data source errors', async () => {
      const { store, sender, ids } = setup();
      const ds = source({ listEntries: async () => { throw new Error('HTTP 500 from ChMS'); } });
      await expect(runDailyJob({ config: cfg, store, sender, dataSource: () => ds, now: NOW })).rejects.toBeInstanceOf(JobFailedError);
      expect(store.runs[0]).toMatchObject({ ok: false, summary: { stage: 'datasource', reason: 'datasource', error: 'Error' } });
      expect(sender.sent).toEqual([
        { endpoint: `https://push.example/${ids.owner}/0`, payload: { title: 'Could not read ChMS this morning', body: 'No nudges went out', kind: 'alert', count: 0 } },
      ]);
    });
    it('treats an empty process (e.g. after a Workflows migration) as a data-source failure', async () => {
      const { store, sender } = setup();
      await expect(
        runDailyJob({ config: cfg, store, sender, dataSource: () => source({ listQueues: async () => [] }), now: NOW }),
      ).rejects.toThrow(/datasource/);
      expect(sender.sent.map((s) => s.payload.kind)).toEqual(['alert']);
    });
    it('treats pushpay without credentials as a data-source failure with its own alert', async () => {
      const { store, sender } = setup();
      const pp = config({ dataSource: 'pushpay' });
      await expect(
        runDailyJob({ config: pp, store, sender, dataSource: () => createDataSource(pp, {} as never, NOW), now: NOW }),
      ).rejects.toThrow(/not_configured, ChmsNotConfiguredError/);
      expect(store.runs[0]!.summary).toEqual({ stage: 'datasource', reason: 'not_configured', error: 'ChmsNotConfiguredError' });
      expect(sender.sent.map((s) => s.payload.title)).toEqual(['No Pushpay credentials yet']);
    });

    it('sends the re-approval alert when pushpay has never been approved (no refresh token in D1)', async () => {
      const { store, sender, ids } = setup();
      const t = await createTestD1('migrations/0002_oauth.sql');
      const pp = config({ dataSource: 'pushpay' });
      const env = { DB: t.db, CHMS_CLIENT_ID: 'c', CHMS_CLIENT_SECRET: 's', TOKEN_ENC_KEY: TEST_TOKEN_KEY };
      const calls: string[] = [];
      vi.stubGlobal('fetch', async (u: RequestInfo | URL) => {
        calls.push(String(u));
        return new Response('{}', { status: 500 });
      });
      try {
        await expect(
          runDailyJob({ config: pp, store, sender, dataSource: () => createDataSource(pp, env as never, NOW), now: NOW }),
        ).rejects.toBeInstanceOf(JobFailedError);
      } finally {
        vi.unstubAllGlobals();
      }
      expect(calls).toEqual([]); // no API or token call without a stored refresh token
      expect(store.runs[0]).toMatchObject({ ok: false, summary: { stage: 'datasource', reason: 'reauth', error: 'ReauthorizationRequired' } });
      expect(sender.sent).toEqual([
        {
          endpoint: `https://push.example/${ids.owner}/0`,
          payload: { title: 'Pushpay connection lost', body: 'A Master Admin needs to approve it again', kind: 'alert', count: 0 },
        },
      ]);
    });

    const cases: [string, unknown, string][] = [
      ['ReauthorizationRequired (invalid_grant)', new ReauthorizationRequired('invalid_grant'), 'reauth'],
      ['TokenPersistError', new TokenPersistError('x'), 'reauth'],
      ['IncompleteDataError', new IncompleteDataError('q1', ['not_started: expected 3, got 2']), 'incomplete'],
      ['ChmsApiError', new ChmsApiError(410, '/queues', 'gone'), 'datasource'],
      ['TokenRefreshError', new TokenRefreshError(new OAuthTokenError(503, 'http_error')), 'datasource'],
      ['a plain Error', new Error('boom'), 'datasource'],
    ];
    for (const [label, err, reason] of cases) {
      it(`maps ${label} to the "${reason}" owner alert and records a failed run`, async () => {
        const { store, sender, ids } = setup();
        const ds = source({ listQueues: async () => { throw err; } });
        await expect(runDailyJob({ config: cfg, store, sender, dataSource: () => ds, now: NOW })).rejects.toBeInstanceOf(JobFailedError);
        expect(store.runs[0]).toMatchObject({ ok: false, summary: { stage: 'datasource', reason } });
        expect(sender.sent).toHaveLength(1);
        expect(sender.sent[0]!.endpoint).toBe(`https://push.example/${ids.owner}/0`);
        expect(sender.sent[0]!.payload).toEqual(alertPayload(reason as Parameters<typeof alertPayload>[0]));
      });
    }

    it('treats pushpay with credentials but no valid TOKEN_ENC_KEY as not configured (never plaintext)', async () => {
      const pp = config({ dataSource: 'pushpay' });
      for (const key of [undefined, '', 'short', 'a'.repeat(44)]) {
        const { store, sender } = setup();
        const env = { DB: {} as D1Database, CHMS_CLIENT_ID: 'c', CHMS_CLIENT_SECRET: 's', TOKEN_ENC_KEY: key };
        await expect(
          runDailyJob({ config: pp, store, sender, dataSource: () => createDataSource(pp, env as never, NOW), now: NOW }),
        ).rejects.toBeInstanceOf(JobFailedError);
        expect(store.runs[0]!.summary).toEqual({ stage: 'datasource', reason: 'not_configured', error: 'ChmsNotConfiguredError' });
      }
    });

    it('never puts upstream error messages in the thrown error, the log line or job_runs', async () => {
      const secret = 'Pat Example 405-555-0101 due "2026-13-45" status "WEIRD" entry 98765';
      const { store, sender } = setup();
      const ds = source({ listEntries: async () => { throw new TypeError(secret); } });
      const err = await runDailyJob({ config: cfg, store, sender, dataSource: () => ds, now: NOW }).catch((e) => e);
      expect(err).toBeInstanceOf(JobFailedError);
      expect(err.cause).toBeUndefined();
      const line = describeFailure(err);
      expect(line).toBe('holy-nudge job failed: stage=datasource reason=datasource error=TypeError');
      for (const text of [err.message, String(err.stack), line, JSON.stringify(store.runs)]) {
        expect(text).not.toMatch(/Pat|555|2026-13|WEIRD|98765/);
      }
      // Anything else (failure before the run is recorded) logs only its class name.
      expect(describeFailure(new Error(secret))).toBe('holy-nudge job failed before the run was recorded: error=Error');
      const odd = new Error('x');
      odd.name = 'Pat Example';
      expect(describeFailure(odd)).toBe('holy-nudge job failed before the run was recorded: error=unknown');
    });

    it('alert titles are distinct, plain, and carry no data', () => {
      const reasons = ['reauth', 'not_configured', 'incomplete', 'datasource', 'job'] as const;
      const titles = reasons.map((r) => alertPayload(r).title);
      expect(new Set(titles).size).toBe(reasons.length);
      for (const r of reasons) expect(alertPayload(r)).toMatchObject({ kind: 'alert', count: 0 });
      expect(alertReason('job', new ReauthorizationRequired('invalid_grant'))).toBe('reauth');
      expect(alertReason('job', new Error('x'))).toBe('job');
    });
  });

  describe('when the push fires (something new or overdue)', () => {
    // NOW is Thu Jan 15 08:00 CST; the last successful run was Wed Jan 14 08:00 CST.
    const LAST = new Date('2026-01-14T14:00:00Z');
    const H = 3600_000;
    const ago = (h: number, from = NOW) => new Date(from.getTime() - h * H).toISOString();
    const outreach = [queue({ id: 'q1', name: 'Outreach', managers: [person('M1', 'Mara')] })];
    const lee = person('L1', 'Lee');

    function world(list: QueueEntry[], lastRun: Date | null = LAST) {
      const store = new FakeStore();
      const ids = {
        lee: store.addLeader({ chmsIndividualId: 'L1', name: 'Lee' }, 1),
        mara: store.addLeader({ chmsIndividualId: 'M1', name: 'Mara' }, 1),
        owner: store.addLeader({ name: 'Owner', isAdmin: true, isOwner: true }, 1),
      };
      if (lastRun) store.addRun(lastRun, true);
      const sender = new FakeSender();
      const ds = () => source({ listQueues: async () => outreach, listEntries: async (id) => list.filter((e) => e.queueId === id) });
      const run = async (now = NOW) => {
        const out = await runDailyJob({ config: cfg, store, sender, dataSource: ds, now, force: true });
        if (!out.ran) throw new Error('did not run');
        return out.summary;
      };
      const pushed = () => {
        const who = new Set(sender.sent.map((x) => Number(x.endpoint.split('/')[3])));
        return (Object.keys(ids) as (keyof typeof ids)[]).filter((k) => who.has(ids[k]));
      };
      return { store, sender, ids, run, pushed };
    }

    it('a new assigned student: the assignee is nudged; the manager and staff are not (someone else\'s new assignment)', async () => {
      const w = world([entry({ id: 'n1', status: 'NOT_STARTED', assignee: lee, created: ago(6) })]);
      const summary = await w.run();
      expect(w.pushed()).toEqual(['lee']);
      expect(bodiesFor(w.sender, w.ids.lee)).toEqual([{ title: '1 student is waiting on you', body: 'Tap to see who could use a hello', kind: 'leader', count: 1 }]);
      expect(summary).toMatchObject({
        firstRunFallback: false, newAssigned: 1, newUnassigned: 0, overdueAssigned: 0, unassignedPastFirstText: 0,
        ownTriggered: 1, summaryTriggered: 0, skippedNothingNewOrOverdue: 2, leadersNudged: 1, adminsNudged: 0, pushesSent: 1,
      });
    });

    it('the grace week is silent for everyone, though the app still counts the student', async () => {
      const w = world([entry({ id: 'g1', status: 'NOT_STARTED', assignee: lee, created: ago(3 * 24) })]);
      const summary = await w.run();
      expect(w.sender.sent).toEqual([]);
      expect(summary).toMatchObject({ leadersBehind: 1, behind: 1, ownTriggered: 0, summaryTriggered: 0, skippedNothingNewOrOverdue: 3, pushesSent: 0 });
    });

    it('overdue by age (no due date, more than 7 days) or by due date: assignee, manager and staff are all nudged', async () => {
      for (const e of [
        entry({ id: 'o1', status: 'NOT_STARTED', assignee: lee, created: ago(8 * 24) }),
        entry({ id: 'o2', status: 'IN_PROCESS', due: '2026-01-13', assignee: lee, created: ago(4 * 24) }),
      ]) {
        const w = world([e]);
        const summary = await w.run();
        expect(w.pushed()).toEqual(['lee', 'mara', 'owner']);
        expect(summary).toMatchObject({ overdueAssigned: 1, ownTriggered: 1, summaryTriggered: 2, skippedNothingNewOrOverdue: 0 });
      }
    });

    it('In Process with no due date never fires, however old', async () => {
      const w = world([entry({ id: 'p1', status: 'IN_PROCESS', assignee: lee, created: ago(30 * 24) })]);
      await w.run();
      expect(w.sender.sent).toEqual([]);
    });

    it('unassigned: nudged when new, quiet at 2 days, nudged again past 72 hours', async () => {
      const cases: [number, string[]][] = [[3, ['mara', 'owner']], [48, []], [96, ['mara', 'owner']]];
      for (const [hours, expected] of cases) {
        const w = world([entry({ id: 'u1', status: 'NOT_STARTED', assignee: null, created: ago(hours) })]);
        await w.run();
        expect([hours, w.pushed()]).toEqual([hours, expected]);
        if (expected.length) expect(bodiesFor(w.sender, w.ids.mara).map((p) => `${p.title} | ${p.body}`)).toEqual(['1 student waiting | 1 unassigned']);
      }
    });

    it('a merged push still carries the full counts, including quiet students', async () => {
      const list = [
        entry({ id: 'm1', status: 'NOT_STARTED', assignee: person('M1', 'Mara'), created: ago(5) }), // Mara's own, new: fires
        entry({ id: 'm2', status: 'NOT_STARTED', assignee: lee, created: ago(3 * 24) }), // Lee's, grace week
        entry({ id: 'm3', status: 'NOT_STARTED', assignee: null, created: ago(48) }), // unassigned, quiet
      ];
      const w = world(list);
      const summary = await w.run();
      expect(w.pushed()).toEqual(['mara']);
      expect(bodiesFor(w.sender, w.ids.mara)).toEqual([{ title: '1 student is waiting on you', body: '3 waiting across your queues, 1 unassigned', kind: 'leader', count: 1 }]);
      expect(summary).toMatchObject({ ownTriggered: 1, summaryTriggered: 0, combinedNudged: 1, skippedNothingNewOrOverdue: 2 });
    });

    it('with no previous successful run, the last 24 hours count as new', async () => {
      const fresh = world([entry({ id: 'f1', status: 'NOT_STARTED', assignee: lee, created: ago(20) })], null);
      expect(await fresh.run()).toMatchObject({ firstRunFallback: true, newAssigned: 1 });
      expect(fresh.pushed()).toEqual(['lee']);
      const older = world([entry({ id: 'f2', status: 'NOT_STARTED', assignee: lee, created: ago(30) })], null);
      expect(await older.run()).toMatchObject({ firstRunFallback: true, newAssigned: 0 });
      expect(older.sender.sent).toEqual([]);
    });

    it('a failed run does not move the window: students from that day are still new at the next good run', async () => {
      const w = world([entry({ id: 'x1', status: 'NOT_STARTED', assignee: lee, created: ago(30) })], new Date('2026-01-13T14:00:00Z'));
      w.store.addRun(LAST, false);
      await w.run();
      expect(w.pushed()).toEqual(['lee']);
    });

    it('a completed run moves the window: the same new student is not new the next morning', async () => {
      const w = world([entry({ id: 'r1', status: 'NOT_STARTED', assignee: lee, created: ago(6) })]);
      await w.run();
      expect(w.pushed()).toEqual(['lee']);
      expect((await w.store.lastSuccessfulRunStart())?.toISOString()).toBe(NOW.toISOString());
      w.sender.sent.length = 0;
      await w.run(new Date(NOW.getTime() + 24 * H));
      expect(w.sender.sent).toEqual([]);
    });

    it('date-only created: nudged on the day (if already there) and the next morning, then quiet until overdue', async () => {
      // Recorded as "2026-01-14"; already in the queue for the Jan 14 run.
      const w = world([entry({ id: 'd1', status: 'NOT_STARTED', assignee: lee, created: '2026-01-14' })], new Date('2026-01-13T14:00:00Z'));
      const mornings = ['2026-01-14', '2026-01-15', '2026-01-16', '2026-01-17', '2026-01-21', '2026-01-22'];
      const nudged: string[] = [];
      for (const d of mornings) {
        w.sender.sent.length = 0;
        await w.run(new Date(`${d}T14:00:00Z`));
        if (w.pushed().includes('lee')) nudged.push(d);
      }
      // A week counts from the end of Jan 14, so Jan 22 is the first overdue morning.
      expect(nudged).toEqual(['2026-01-14', '2026-01-15', '2026-01-22']);
    });

    it('GET /api/me (staff or leader) never moves the window; only a completed daily run does', async () => {
      const list = [entry({ id: 'a1', status: 'NOT_STARTED', assignee: lee, created: ago(6) })];
      const w = world(list);
      const snapshot = { queues: outreach, entries: list };
      for (const leader of await w.store.listLeaders()) {
        const r = await resolveMe({ store: w.store, config: cfg, leader, now: NOW, loadSnapshot: async () => snapshot });
        expect(r.ok).toBe(true);
      }
      expect(w.store.runs).toHaveLength(1);
      expect((await w.store.lastSuccessfulRunStart())?.toISOString()).toBe(LAST.toISOString());
      // So the morning run still sees the student as new.
      await w.run();
      expect(w.pushed()).toEqual(['lee']);
    });
  });

  it('runs end to end on the fixture data source', async () => {
    const store = new FakeStore();
    store.addLeader({ name: 'Owner', isAdmin: true, isOwner: true }, 1);
    const sender = new FakeSender();
    const real = { ...cfg, dataSource: 'fixture' as const, excludedQueues: ['DONE- do not move here unless you have left a note', 'Not Interested'] };
    const out = await runDailyJob({ config: real, store, sender, dataSource: () => createDataSource(real, {} as never, NOW), now: NOW });
    expect(out.ran && out.summary.queues).toBe(10);
    expect(sender.sent.map((s) => s.payload.kind)).toEqual(['admin']);
    expect(store.leaders.length).toBeGreaterThan(5);
  });
});
