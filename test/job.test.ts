import { describe, expect, it, vi } from 'vitest';
import { OAuthTokenError } from '../src/chms/oauth';
import { ChmsApiError, IncompleteDataError } from '../src/chms/pushpay';
import { ReauthorizationRequired, TokenPersistError, TokenRefreshError } from '../src/chms/tokens';
import { alertPayload } from '../src/push/payload';
import { createTestD1 } from './sqlite-d1';
import { createDataSource } from '../src/chms/index';
import type { DataSource, QueueEntry } from '../src/core/types';
import { JobFailedError, alertReason, describeFailure, localHour, runDailyJob } from '../src/job/daily';
import { FakeSender, FakeStore } from './fakes';
import { config, entry, person, queue, TEST_TOKEN_KEY } from './helpers';

const cfg = config({ excludedQueues: ['Not Interested'] });
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

  it('runs end to end on the fixture data source', async () => {
    const store = new FakeStore();
    store.addLeader({ name: 'Owner', isAdmin: true, isOwner: true }, 1);
    const sender = new FakeSender();
    const real = { ...cfg, excludedQueues: ['DONE- do not move here unless you have left a note', 'Not Interested'] };
    const out = await runDailyJob({ config: real, store, sender, dataSource: () => createDataSource(real, {} as never, NOW), now: NOW });
    expect(out.ran && out.summary.queues).toBe(10);
    expect(sender.sent.map((s) => s.payload.kind)).toEqual(['admin']);
    expect(store.leaders.length).toBeGreaterThan(5);
  });
});
