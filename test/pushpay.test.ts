import { beforeEach, describe, expect, it } from 'vitest';
import { resolveMe } from '../src/api/me';
import {
  ChmsApiError,
  ChmsDataError,
  completenessMismatches,
  createPushpayDataSource,
  IncompleteDataError,
  mapDueDate,
  mapEntry,
  mapPerson,
  MAX_PHONE_LOOKUPS,
  pickPhone,
  PushpayDataSource,
  toCount,
  type PushpayOptions,
} from '../src/chms/pushpay';
import { dueToDate } from '../src/core/time';
import { runDailyJob } from '../src/job/daily';
import { loadSnapshot } from '../src/job/load';
import { importTokenKey, sealToken } from '../src/chms/tokenbox';
import { FakeSender, FakeStore } from './fakes';
import { config, TEST_TOKEN_KEY } from './helpers';
import { createTestD1 } from './sqlite-d1';

const TZ = 'America/Chicago';
const API = 'https://api.test';
type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// A fake Pushpay API, shaped like production on 2026-11-24. All names, emails and numbers are invented.

interface FakeApi {
  queues: Json[];
  details: Record<string, Json>;
  entries: Json[];
  individuals: Record<string, Json>;
  /** Ignore process_ids[] and queue_ids[] on /queues_individuals like a server that does not support them. */
  ignoreFilters: boolean;
  /** Hide entries assigned to anyone but this id (simulates "only what the user can see"). */
  visibleAssignee: string | null;
  pagingHeaders: boolean;
  /** Serve status_counts on GET /queues/{id} (the OpenAPI has it; production does not). */
  statusCounts: boolean;
  /** Rewrite the x-total header of a list response (n = request number). */
  xTotal: ((real: number, url: URL, n: number) => number) | null;
  requests: URL[];
  auth: string[];
  /** Per-request override; return undefined to fall through. */
  intercept: ((url: URL, n: number) => Response | undefined) | null;
}

let api: FakeApi;
let clockMs: number;
let sleeps: number[];
let logs: string[];

const OPEN = ['NOT_STARTED', 'IN_PROCESS', 'WAITING'];

function entryRow(i: number, queueId: number, status: string, over: Json = {}): Json {
  return {
    queue_individual_id: 900000 + i,
    queue_id: queueId,
    individual_id: 70000 + i,
    status,
    created: '2026-11-01',
    due: '2026-11-10',
    overdue: false,
    completed: status === 'DONE' ? '2026-11-12' : null,
    individual: {
      id: 70000 + i,
      name: `Student ${i}`,
      first_name: 'Student',
      last_name: String(i),
      email: `student${i}@example.com`,
      phone: {}, // production: always an empty object on queue rows
    },
    assignee: i % 3 === 0 ? null : { id: i % 2 ? 801 : 802, name: i % 2 ? 'Leader One' : 'Leader Two', phone: {} },
    ...over,
  };
}

/** A GET /individuals/{id} body stuffed with fields that must never leave the data source. */
function individualBody(id: number, phone: Json = {}): Json {
  return {
    id,
    first_name: 'Secret',
    last_name: 'Person',
    email: `secret${id}@example.com`,
    addresses: [{ street_address: '1 Secret Way', city: 'Hiddenville' }],
    giving_number: 'GIVING-SECRET',
    allergies: 'ALLERGY-SECRET',
    custom_fields: [{ label: 'Notes', value: 'CUSTOM-SECRET' }],
    phone: { emergency: '+15550191', fax: '+15550192', home: '', mobile: `+1555${String(id).slice(-6)}`, pager: '+15550193', work: '', ...phone },
    preferred_number: 'mobile',
  };
}

const SECRETS = /Secret Way|Hiddenville|GIVING-SECRET|ALLERGY-SECRET|CUSTOM-SECRET|secret\d+@|\+15550191|\+15550192|\+15550193|@example\.com/;

function countsFor(queueId: number): Json {
  const rows = api.entries.filter((e) => e.queue_id === queueId && OPEN.includes(String(e.status)));
  const n = (s: string) => rows.filter((e) => e.status === s).length;
  return {
    not_started: n('NOT_STARTED'),
    in_process: n('IN_PROCESS'),
    waiting: n('WAITING'),
    unassigned: rows.filter((e) => e.assignee === null).length,
    overdue: 0,
  };
}

function page<T>(rows: T[], url: URL): Response {
  const per = Number(url.searchParams.get('per_page') ?? 25);
  const p = Number(url.searchParams.get('page') ?? 1);
  const slice = rows.slice((p - 1) * per, p * per);
  const totalPages = Math.max(1, Math.ceil(rows.length / per));
  // As production sends them (2026-11-24): x-next-page only when there is a next page.
  const total = api.xTotal ? api.xTotal(rows.length, url, api.requests.length) : rows.length;
  const headers: Record<string, string> = api.pagingHeaders
    ? { 'x-total': String(total), 'x-total-pages': String(totalPages), 'x-page': String(p), 'x-per-page': String(per), ...(p < totalPages ? { 'x-next-page': String(p + 1) } : {}) }
    : {};
  return Response.json(slice, { headers });
}

const processOf = (queueId: unknown) => String(api.queues.find((q) => q.id === queueId)?.process_id);

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = String(input);
  const url = new URL(raw);
  api.requests.push(url);
  api.auth.push(new Headers(init?.headers).get('Authorization') ?? '');
  expect(new Headers(init?.headers).get('Accept')).toBe('application/vnd.ccbchurch.v2+json');
  expect(init?.method ?? 'GET').toBe('GET');
  const o = api.intercept?.(url, api.requests.length);
  if (o) return o;
  const path = url.pathname;
  let m: RegExpExecArray | null;
  if (path === '/queues') {
    const pid = url.searchParams.getAll('process_ids[]');
    return page(api.queues.filter((q) => pid.length === 0 || pid.includes(String(q.process_id))), url);
  }
  if ((m = /^\/queues\/(\d+)$/.exec(path))) {
    const d = api.details[m[1]!];
    if (!d) return new Response('', { status: 404 });
    return Response.json(api.statusCounts ? { ...d, status_counts: d.status_counts ?? countsFor(Number(m[1])) } : d);
  }
  if (path === '/queues_individuals') {
    // The snapshot asks for the open statuses only, never DONE.
    expect(raw).toContain('statuses[]=NOT_STARTED&statuses[]=IN_PROCESS&statuses[]=WAITING&per_page=');
    expect(raw).not.toContain('DONE');
    const statuses = url.searchParams.getAll('statuses[]');
    const qids = url.searchParams.getAll('queue_ids[]');
    const pids = url.searchParams.getAll('process_ids[]');
    let rows = api.entries.filter((e) => statuses.includes(String(e.status)));
    if (qids.length && !api.ignoreFilters) rows = rows.filter((e) => qids.includes(String(e.queue_id)));
    if (pids.length && !api.ignoreFilters) rows = rows.filter((e) => pids.includes(processOf(e.queue_id)));
    if (api.visibleAssignee) {
      rows = rows.filter((e) => e.assignee === null || String((e.assignee as Json).id) === api.visibleAssignee);
    }
    return page(rows, url);
  }
  if ((m = /^\/individuals\/(\d+)$/.exec(path))) {
    const p = api.individuals[m[1]!];
    return p ? Response.json(p) : new Response('', { status: 404 });
  }
  return new Response('', { status: 405 });
}) as typeof fetch;

let tokenRequests: (string | undefined)[];

function source(over: Partial<PushpayOptions> = {}): PushpayDataSource {
  let n = 0;
  return new PushpayDataSource({
    apiHost: API,
    accessToken: async (rejected) => {
      tokenRequests.push(rejected);
      return `access-${n++}`;
    },
    fetch: fakeFetch,
    clock: () => clockMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      clockMs += ms;
    },
    log: (m) => logs.push(m),
    rateLimit: { perSecond: 1, burst: 100 },
    ...over,
  });
}

beforeEach(() => {
  clockMs = Date.UTC(2026, 10, 17, 14);
  sleeps = [];
  logs = [];
  tokenRequests = [];
  const entries: Json[] = [];
  const statuses = ['NOT_STARTED', 'IN_PROCESS', 'WAITING', 'DONE'];
  // 5001: 180 rows, 45 DONE, 135 open (two pages of open rows on its own).
  for (let i = 0; i < 180; i++) entries.push(entryRow(i, 5001, statuses[i % 4]!));
  // 5002: 10 open rows, 3 of them unassigned.
  for (let i = 200; i < 210; i++) entries.push(entryRow(i, 5002, 'NOT_STARTED'));
  entries.push(entryRow(210, 6001, 'NOT_STARTED')); // another process
  api = {
    queues: [
      { id: 5002, process_id: 37, name: 'Outreach Team', order_by: 2, managers: [], queue_managers: [] },
      {
        id: 5001,
        process_id: 37,
        name: 'Connect Card Coordinators',
        order_by: 1,
        // As production sends them: `managers` is bare names, `queue_managers` is { id, name }.
        managers: ['Leader One'],
        queue_managers: [{ id: 801, name: 'Leader One', email: 'leader1@example.com', phone: {} }],
      },
      { id: 6001, process_id: 99, name: 'Other process', order_by: 1 },
    ],
    details: {
      '5001': { id: 5001, name: 'Connect Card Coordinators', managers: [{ id: 801, name: 'Leader One' }, { id: 803, name: 'Leader Three' }] },
      '5002': { id: 5002, name: 'Outreach Team', managers: [] },
      '6001': { id: 6001, name: 'Other process', managers: [{ id: 804, name: 'Leader Four' }] },
    },
    entries,
    individuals: {},
    ignoreFilters: false,
    visibleAssignee: null,
    pagingHeaders: true,
    statusCounts: false,
    xTotal: null,
    requests: [],
    auth: [],
    intercept: null,
  };
});

const paths = () => api.requests.map((u) => u.pathname);
const entryReads = () => api.requests.filter((u) => u.pathname === '/queues_individuals');

// ---------------------------------------------------------------------------

describe('listQueues', () => {
  it('lists the process queues in ChMS order with managers from the list rows, id and name only', async () => {
    const queues = await source().listQueues('37');
    expect(queues.map((q) => [q.id, q.name, q.processId])).toEqual([
      ['5001', 'Connect Card Coordinators', '37'],
      ['5002', 'Outreach Team', '37'],
    ]);
    expect(queues[0]!.managers).toEqual([{ id: '801', name: 'Leader One' }]); // from `queue_managers`; the bare names in `managers` are ignored
    expect(queues[1]!.managers).toEqual([]);
    expect(String(api.requests[0])).toBe(`${API}/queues?process_ids[]=37&per_page=100&page=1`);
    expect(paths()).toEqual(['/queues']); // no GET /queues/{id}
    expect(api.auth.every((a) => a === 'Bearer access-0')).toBe(true);
  });

  it('uses queue_managers when managers is missing, and the detail only when neither is an array', async () => {
    api.queues = [
      { id: 5001, process_id: 37, name: 'A', order_by: 1, queue_managers: [{ id: 803, name: 'Leader Three' }] },
      { id: 5002, process_id: 37, name: 'B', order_by: 2, managers: null },
      { id: 6001, process_id: 37, name: 'C', order_by: 3 },
    ];
    const queues = await source().listQueues('37');
    expect(queues.map((q) => q.managers)).toEqual([[{ id: '803', name: 'Leader Three' }], [], [{ id: '804', name: 'Leader Four' }]]);
    expect(paths()).toEqual(['/queues', '/queues/5002', '/queues/6001']);
  });
});

describe('listEntries', () => {
  it('reads the open statuses once for the whole process, pages to the end, and maps every field', async () => {
    const ds = source();
    await ds.listQueues('37');
    const a = await ds.listEntries('5001');
    const b = await ds.listEntries('5002');
    expect(a).toHaveLength(135);
    expect(b).toHaveLength(10);
    expect(entryReads().map((u) => [u.searchParams.getAll('process_ids[]'), u.searchParams.get('page')])).toEqual([
      [['37'], '1'],
      [['37'], '2'],
    ]);
    expect(entryReads().some((u) => u.searchParams.has('queue_ids[]'))).toBe(false);
    expect(new Set(a.map((e) => e.status))).toEqual(new Set(OPEN));
    expect(paths()).toEqual(['/queues', '/queues_individuals', '/queues_individuals']); // 3 calls for the snapshot

    const first = a.find((e) => e.id === '900001')!;
    expect(first).toEqual({
      id: '900001',
      queueId: '5001',
      status: 'IN_PROCESS',
      due: '2026-11-10',
      created: '2026-11-01',
      completed: null,
      assignee: { id: '801', name: 'Leader One' },
      individual: { id: '70001', name: 'Student 1', email: 'student1@example.com' }, // phone: {} -> none
    });
    expect(a.find((e) => e.id === '900000')!.assignee).toBeNull();
  });

  it('stops on a short page when no paging headers are sent, including an exact-multiple last page', async () => {
    api.pagingHeaders = false;
    api.statusCounts = true; // the only thing left to verify against
    api.queues = api.queues.map((q) => ({ ...q, managers: null, queue_managers: null }));
    api.entries = api.entries.filter((e) => e.queue_id === 5001 && Number(e.queue_individual_id) < 900132); // 99 open
    api.entries.push(entryRow(300, 5001, 'WAITING')); // exactly 100 open rows in the process
    const ds = source();
    await ds.listQueues('37');
    expect(await ds.listEntries('5001')).toHaveLength(100);
    expect(entryReads().map((u) => u.searchParams.get('page'))).toEqual(['1', '2']); // page 2 is empty
  });

  it('reads one queue with queue_ids[] when no process is known', async () => {
    const rows = await source().listEntries('5002');
    expect(rows).toHaveLength(10);
    expect(entryReads().map((u) => u.searchParams.getAll('queue_ids[]'))).toEqual([['5002']]);
  });

  it('keeps only its own queue, verified against the whole read, when queue_ids[] is ignored', async () => {
    api.ignoreFilters = true;
    const rows = await source().listEntries('5002');
    expect(rows).toHaveLength(10);
    expect(rows.every((e) => e.queueId === '5002')).toBe(true);
  });

  it('throws IncompleteDataError when the rows do not add up to the queue counts', async () => {
    // Only status_counts can catch this: x-total counts what the server chose to return.
    // Production sends no status_counts (2026-11-24), so this guards a future API version;
    // production was seen returning rows assigned to other people (16 distinct open assignees).
    api.statusCounts = true;
    api.queues = api.queues.map((q) => ({ ...q, managers: null, queue_managers: null })); // detail calls, to get counts
    api.visibleAssignee = '801'; // the API hides rows assigned to other leaders
    const ds = source();
    await ds.listQueues('37');
    const err = await ds.listEntries('5001').catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteDataError);
    expect(err.queueId).toBe('5001');
    expect(err.message).toMatch(/not_started: expected 45, got \d+/);
    expect(err.message).not.toMatch(/Student|example\.com|555-/);
    // it re-read once before giving up, with a fresh detail since this API sends counts
    expect(api.requests.filter((u) => u.pathname === '/queues/5001')).toHaveLength(2);
  });

  it('refuses to verify against nothing', async () => {
    api.pagingHeaders = false;
    await expect(source().listEntries('5002')).rejects.toBeInstanceOf(IncompleteDataError);
  });

  it('rejects unknown statuses loudly', async () => {
    api.intercept = (url) =>
      url.pathname === '/queues_individuals' ? Response.json([entryRow(200, 5002, 'ARCHIVED')], { headers: { 'x-total': '1' } }) : undefined;
    await expect(source().listEntries('5002')).rejects.toBeInstanceOf(ChmsDataError);
  });

  it('never asks for a phone while reading the snapshot', async () => {
    const ds = source();
    await loadSnapshot(ds, config({ dataSource: 'pushpay', audience: 'everyone' }));
    expect(paths().some((p) => p.startsWith('/individuals/'))).toBe(false);
  });
});

describe('listEntries against production-shaped responses (2026-11-24)', () => {
  // No status_counts, no assigned_count, unassigned_count a string or null, x-total on every page.
  const realQueues = (unassigned: Record<string, string | null>) => {
    api.queues = api.queues.map((q) => ({ ...q, unassigned_count: unassigned[String(q.id)] ?? null }));
  };

  it('passes on a multi-page read verified by x-total and a string unassigned_count (open reading)', async () => {
    realQueues({ '5001': '45', '5002': '3' });
    const ds = source();
    await ds.listQueues('37');
    expect(await ds.listEntries('5001')).toHaveLength(135);
    expect(await ds.listEntries('5002')).toHaveLength(10);
    expect(logs).toEqual([]);
  });

  it('re-reads once when fewer rows arrive than x-total, then fails closed with counts only', async () => {
    realQueues({});
    api.xTotal = (real, url) => (url.pathname === '/queues_individuals' ? real + 1 : real);
    const ds = source();
    await ds.listQueues('37');
    const err = await ds.listEntries('5001').catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteDataError);
    expect(err.message).toContain('process-wide read: x-total 146, received 145');
    expect(err.message).not.toMatch(/Student|example\.com|555-|900\d{3}|70\d{3}/);
    expect(entryReads()).toHaveLength(4); // two pages, twice
    expect(logs.some((l) => l.includes('re-reading once'))).toBe(true);
  });

  it('recovers when the re-read adds up, and later queues use the fresh read', async () => {
    realQueues({});
    let reads = 0;
    api.xTotal = (real, url) => {
      if (url.pathname !== '/queues_individuals') return real;
      return url.searchParams.get('page') === '1' && ++reads === 1 ? real + 1 : real;
    };
    const ds = source();
    await ds.listQueues('37');
    expect(await ds.listEntries('5002')).toHaveLength(10);
    expect(await ds.listEntries('5001')).toHaveLength(135);
    expect(entryReads()).toHaveLength(4);
  });

  it('treats x-total changing between pages as a mismatch', async () => {
    realQueues({});
    api.xTotal = (real, url) => (url.pathname === '/queues_individuals' && url.searchParams.get('page') === '2' ? real + 1 : real);
    const ds = source();
    await ds.listQueues('37');
    const err = await ds.listEntries('5001').catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteDataError);
    expect(err.message).toContain('x-total changed between pages');
  });

  it('catches a row seen twice across pages even when the row count matches x-total', async () => {
    realQueues({});
    // The list shifted by one between pages: page 2 repeats the last row of page 1.
    api.intercept = (url) => {
      if (url.pathname !== '/queues_individuals' || url.searchParams.get('page') !== '2') return undefined;
      const rows = api.entries.filter((e) => processOf(e.queue_id) === '37' && OPEN.includes(String(e.status)));
      return Response.json(rows.slice(99, 144), { headers: { 'x-total': '145', 'x-total-pages': '2', 'x-per-page': '100', 'x-page': '2' } });
    };
    const ds = source();
    await ds.listQueues('37');
    const err = await ds.listEntries('5001').catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteDataError);
    expect(err.message).toContain('process-wide read: 1 duplicate rows across pages');
  });

  it('still fails closed with unassigned_count null, no paging header and no counts', async () => {
    realQueues({ '5002': null });
    api.pagingHeaders = false;
    const ds = source();
    await ds.listQueues('37');
    const err = await ds.listEntries('5002').catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteDataError);
    expect(err.message).toContain('no counts available to verify against');
  });

  it('reads unassigned_count "5" as a number and reports it when the open rows disagree', async () => {
    realQueues({ '5002': '5' }); // the rows have 3 open unassigned
    const ds = source();
    await ds.listQueues('37');
    const err = await ds.listEntries('5002').catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteDataError);
    expect(err.message).toContain('unassigned_count: expected 5, got 3 open');
    // the re-read refreshed the queue list once
    expect(paths().filter((p) => p === '/queues')).toHaveLength(2);
  });

  it('refreshes the queue list on the re-read so a card assigned mid-run is not a failure', async () => {
    realQueues({ '5002': '4' }); // stale: someone assigned a card after the list was read
    const ds = source();
    await ds.listQueues('37');
    api.queues = api.queues.map((q) => (q.id === 5002 ? { ...q, unassigned_count: '3' } : q));
    expect(await ds.listEntries('5002')).toHaveLength(10);
    expect(paths().filter((p) => p === '/queues')).toHaveLength(2);
  });

  it('verifies the process-wide read against its own total, never a single queue', async () => {
    realQueues({});
    api.ignoreFilters = true; // process_ids[] ignored too: the read also holds process 99's row
    const ds = source();
    await ds.listQueues('37');
    expect(await ds.listEntries('5001')).toHaveLength(135); // x-total of the read is 146, the whole read
    expect(await ds.listEntries('5002')).toHaveLength(10);
    expect(entryReads()).toHaveLength(2);
  });
});

describe('phonesFor', () => {
  it('reads only the phone from a stuffed /individuals/{id} body, and fetches nothing else', async () => {
    api.individuals['70001'] = individualBody(70001);
    api.individuals['70002'] = individualBody(70002, { mobile: '', home: '+15550102' });
    (api.individuals['70002'] as Json).preferred_number = 'home';
    api.individuals['70003'] = individualBody(70003, { mobile: '' }); // preferred mobile, empty: none
    const phones = await source().phonesFor(['70001', '70002', '70003', '70001']);
    expect([...phones]).toEqual([
      ['70001', '+155570001'],
      ['70002', '+15550102'],
    ]);
    expect(paths()).toEqual(['/individuals/70001', '/individuals/70002', '/individuals/70003']);
  });

  it('never fails: 404, 500, non-JSON and network errors just mean no phone, logged without ids', async () => {
    api.individuals['70001'] = individualBody(70001);
    api.intercept = (url) => {
      if (url.pathname === '/individuals/70002') return new Response('', { status: 500 });
      if (url.pathname === '/individuals/70003') return new Response('not json', { status: 200 });
      if (url.pathname === '/individuals/70005') throw new TypeError('network down');
      return undefined;
    };
    const phones = await source().phonesFor(['70001', '70002', '70003', '70004', '70005']);
    expect([...phones.keys()]).toEqual(['70001']);
    expect(logs.join('\n')).not.toMatch(/700\d\d|Secret/);
    expect(logs.some((l) => l.includes('4 phone lookups failed'))).toBe(true);
  });

  it(`looks up at most ${MAX_PHONE_LOOKUPS} people; the rest get no phone`, async () => {
    const ids = Array.from({ length: 30 }, (_, i) => String(71000 + i));
    for (const id of ids) api.individuals[id] = individualBody(Number(id));
    const phones = await source().phonesFor(ids);
    expect(phones.size).toBe(MAX_PHONE_LOOKUPS);
    expect(paths()).toHaveLength(MAX_PHONE_LOOKUPS);
    expect(phones.has(ids[MAX_PHONE_LOOKUPS]!)).toBe(false);
  });
});

describe('phones in /api/me and the daily job', () => {
  const liveCfg = config({ dataSource: 'pushpay', audience: 'everyone', excludedQueues: [] });
  const now = () => new Date(clockMs);
  const stuffAll = () => {
    for (const e of api.entries) {
      const id = Number((e.individual as Json).id);
      api.individuals[String(id)] = individualBody(id);
    }
  };

  it("a leader's page looks up phones for their own students only, and the payload carries nothing else", async () => {
    stuffAll();
    const store = new FakeStore();
    store.addLeader({ chmsIndividualId: '802', name: 'Leader Two' });
    const leader = (await store.listLeaders())[0]!;
    api.entries = api.entries.filter((e) => e.queue_id === 5002); // Leader Two: 4 own students in 5002
    const ds = source();
    const r = await resolveMe({ store, config: liveCfg, leader, now: now(), loadSnapshot: () => loadSnapshot(ds, liveCfg), loadPhones: (ids) => ds.phonesFor(ids) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.me.behind).toHaveLength(4);
    for (const item of r.me.behind) expect(Object.keys(item.individual).sort()).toEqual(['name', 'phone']);
    expect(r.me.behind.map((i) => i.individual.phone).sort()).toEqual(['+155570200', '+155570202', '+155570206', '+155570208']);
    expect(JSON.stringify(r.me)).not.toMatch(SECRETS);
    expect(paths().filter((p) => p.startsWith('/individuals/')).sort()).toEqual(['/individuals/70200', '/individuals/70202', '/individuals/70206', '/individuals/70208']);
    expect(r.me.admin).toBeUndefined();
  });

  it('caps one page view and returns the rest without a phone', async () => {
    stuffAll();
    const store = new FakeStore();
    store.addLeader({ chmsIndividualId: '801', name: 'Leader One' });
    const leader = (await store.listLeaders())[0]!;
    const ds = source();
    const r = await resolveMe({ store, config: liveCfg, leader, now: now(), loadSnapshot: () => loadSnapshot(ds, liveCfg), loadPhones: (ids) => ds.phonesFor(ids) });
    if (!r.ok) throw new Error('expected ok');
    expect(r.me.behind).toHaveLength(33);
    expect(r.me.behind.filter((i) => i.individual.phone)).toHaveLength(MAX_PHONE_LOOKUPS);
    expect(r.me.behind.slice(0, MAX_PHONE_LOOKUPS).every((i) => i.individual.phone)).toBe(true); // the top of the list
    expect(paths().filter((p) => p.startsWith('/individuals/'))).toHaveLength(MAX_PHONE_LOOKUPS);
  });

  it('a staff whole-queue view looks up no phones and its cards have none', async () => {
    stuffAll();
    const store = new FakeStore();
    store.addLeader({ name: 'Staff', isAdmin: true });
    const leader = (await store.listLeaders())[0]!;
    const ds = source();
    let asked: string[] | null = null;
    const r = await resolveMe({
      store, config: liveCfg, leader, now: now(), loadSnapshot: () => loadSnapshot(ds, liveCfg),
      loadPhones: async (ids) => { asked = ids; return ds.phonesFor(ids); },
    });
    if (!r.ok) throw new Error('expected ok');
    expect(asked).toBeNull();
    expect(r.me.admin!.unassigned.length).toBeGreaterThan(0);
    expect(r.me.admin!.unassigned.every((i) => i.individual.phone === null)).toBe(true);
    expect(r.me.admin!.byLeader.flatMap((g) => g.items).every((i) => i.individual.phone === null)).toBe(true);
    expect(paths().some((p) => p.startsWith('/individuals/'))).toBe(false);
  });

  it('a failed lookup never fails the page', async () => {
    const store = new FakeStore();
    store.addLeader({ chmsIndividualId: '802', name: 'Leader Two' });
    const leader = (await store.listLeaders())[0]!;
    const ds = source();
    const r = await resolveMe({ store, config: liveCfg, leader, now: now(), loadSnapshot: () => loadSnapshot(ds, liveCfg), loadPhones: async () => { throw new Error('boom'); } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.me.behind.every((i) => i.individual.phone === null)).toBe(true);
  });

  it('the daily job makes zero /individuals calls', async () => {
    stuffAll();
    const store = new FakeStore();
    store.addLeader({ chmsIndividualId: '801', name: 'Leader One' }, 1);
    store.addLeader({ name: 'Owner', isAdmin: true, isOwner: true }, 1);
    const out = await runDailyJob({ config: liveCfg, store, sender: new FakeSender(), dataSource: () => source(), now: now(), force: true });
    expect(out.ran).toBe(true);
    expect(paths()).toEqual(['/queues', '/queues_individuals', '/queues_individuals']);
  });
});

describe('toCount', () => {
  it('reads numbers and numeric strings; null and junk are "not available", not zero', () => {
    expect([5, '5', '0', ' 324 ', 0].map(toCount)).toEqual([5, 5, 0, 324, 0]);
    expect([null, undefined, '', 'n/a', '-1', '1.5', -1, 1.5, NaN].map(toCount)).toEqual(Array(9).fill(undefined));
  });
});

describe('HTTP behaviour', () => {
  it('honours 429 retry-after', async () => {
    api.intercept = (_url, n) =>
      n === 1 ? Response.json({ error: 'Rate limit exceeded', retry_after: 7 }, { status: 429, headers: { 'retry-after': '7' } }) : undefined;
    await source().listQueues('37');
    expect(sleeps).toContain(7000);
    expect(api.requests[0]!.href).toBe(api.requests[1]!.href);
  });

  it('gives up after repeated 429s', async () => {
    api.intercept = () => new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
    const err = await source({ maxRetries: 2 }).listQueues('37').catch((e) => e);
    expect(err).toBeInstanceOf(ChmsApiError);
    expect(err.status).toBe(429);
    expect(api.requests).toHaveLength(3);
  });

  it('throttles each endpoint to the documented 1 request per second after the burst', async () => {
    const ds = source({ rateLimit: { perSecond: 1, burst: 1 } });
    const start = clockMs;
    await ds.listQueues('37'); // /queues once (managers come from the list rows)
    await ds.listEntries('5002'); // the process-wide read: /queues_individuals twice (two pages)
    await ds.listEntries('5001'); // shared read, no request
    // /queues_individuals: 2 calls with burst 1 -> one wait of 1 s. /queues: 1 call, no wait.
    expect(clockMs - start).toBe(1000);
    expect(paths()).toEqual(['/queues', '/queues_individuals', '/queues_individuals']);
  });

  it('waits until x-ratelimit-reset when the server says nothing remains', async () => {
    const reset = Math.floor(clockMs / 1000) + 5;
    const full = Array.from({ length: 25 }, (_, i) => ({ id: 7000 + i, process_id: 37, name: `Q${i}` }));
    api.intercept = (url, n) => {
      if (n === 1) {
        return Response.json(full, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset), 'x-next-page': '2' } });
      }
      if (n === 2) {
        expect(url.searchParams.get('page')).toBe('2');
        expect(clockMs).toBeGreaterThanOrEqual(reset * 1000); // waited before asking for page 2
      }
      return url.pathname === '/queues' ? Response.json([]) : Response.json({ id: 1, managers: [] });
    };
    await source({ perPage: 25 }).listQueues('37');
    expect(api.requests[1]!.searchParams.get('page')).toBe('2');
  });

  it('refreshes the token once on 401, then fails with a typed error', async () => {
    api.intercept = (_url, n) => (n === 1 ? new Response('', { status: 401 }) : undefined);
    await source().listQueues('37');
    expect(tokenRequests).toEqual([undefined, 'access-0']);
    expect(api.auth.slice(0, 2)).toEqual(['Bearer access-0', 'Bearer access-1']);

    api.intercept = () => new Response('', { status: 401 });
    const err = await source().listQueues('37').catch((e) => e);
    expect(err).toBeInstanceOf(ChmsApiError);
    expect(err.status).toBe(401);
  });

  it('points at the Workflows migration when queue endpoints vanish', async () => {
    api.intercept = () => new Response('', { status: 404 });
    const err = await source().listQueues('37').catch((e) => e);
    expect(err).toBeInstanceOf(ChmsApiError);
    expect(err.endpoint).toBe('/queues');
    expect(err.message).toMatch(/Workflows/);
  });
});

describe('due dates', () => {
  // Confirmed against production 2026-11-24: `due` is date-only. The other shapes stay covered defensively.
  it.each([
    ['2026-11-05', '2026-11-05'],
    ['2026-11-05T00:00:00Z', '2026-11-05'],
    ['2026-11-05T00:00:00.000Z', '2026-11-05'],
    ['2026-11-05T00:00:00+00:00', '2026-11-05'],
    ['2026-11-05 00:00:00', '2026-11-05'],
  ])('reads midnight/date-only %s as the calendar date', (raw, date) => {
    expect(mapDueDate(raw)).toBe(date);
    expect(dueToDate(mapDueDate(raw)!, TZ)).toBe(date); // never shifted to Nov 4 in Central
  });

  it.each([
    ['2026-11-05T15:30:00-06:00', '2026-11-05'],
    ['2026-11-05T03:00:00Z', '2026-11-04'], // a real instant: 9 pm on Nov 4 in Chicago
    ['2026-11-05T00:00:00-06:00', '2026-11-05'],
  ])('keeps a real instant %s and lets core convert it', (raw, date) => {
    expect(mapDueDate(raw)).toBe(raw);
    expect(dueToDate(mapDueDate(raw)!, TZ)).toBe(date);
  });

  it('treats empty and placeholder values as no due date and rejects garbage', () => {
    for (const v of [null, undefined, '', '-0001-11-30 00:00:00', '0000-00-00']) expect(mapDueDate(v)).toBeNull();
    expect(() => mapDueDate('next tuesday')).toThrow(ChmsDataError);
    expect(() => mapDueDate(20261105)).toThrow(ChmsDataError);
  });
});

describe('people', () => {
  it('reads the production /individuals/{id} phone shape: mobile, else the preferred number, never emergency/fax/pager', () => {
    const phone = (over: Json) => ({ emergency: '+15550191', fax: '+15550192', home: '', mobile: '', pager: '+15550193', work: '', ...over });
    expect(pickPhone({ phone: phone({ mobile: '+15550101', home: '+15550102' }), preferred_number: 'home' })).toBe('+15550101');
    expect(pickPhone({ phone: phone({ home: '+15550102' }), preferred_number: 'home' })).toBe('+15550102');
    expect(pickPhone({ phone: phone({ work: '+15550103' }), preferred_number: 'Work' })).toBe('+15550103');
    expect(pickPhone({ phone: phone({ home: '+15550102' }), preferred_number: 'mobile' })).toBeUndefined();
    expect(pickPhone({ phone: phone({}), preferred_number: 'emergency' })).toBeUndefined();
    expect(pickPhone({ phone: phone({}) })).toBeUndefined();
    expect(pickPhone({ phone: {} as never, preferred_number: 'mobile' })).toBeUndefined(); // queue rows
  });

  it('prefers mobile, then the preferred number, and omits empty contact fields', () => {
    expect(mapPerson({ id: 1, name: 'A', phone: { mobile: '555-0101', home: '555-0102' }, preferred_number: 'HOME' })!.phone).toBe('555-0101');
    expect(mapPerson({ id: 1, name: 'A', phone: { mobile: ' ', work: '555-0103' }, preferred_number: 'WORK' })!.phone).toBe('555-0103');
    expect(mapPerson({ id: 1, name: 'A', phone: { home: '555-0102' }, preferred_number: 'NONE' })).toEqual({ id: '1', name: 'A' });
    expect(mapPerson({ id: 2, first_name: 'Pat', last_name: 'Example', email: '' })).toEqual({ id: '2', name: 'Pat Example' });
    expect(mapPerson({ id: 3, email_primary: 'p@example.com' })).toEqual({ id: '3', name: 'Individual 3', email: 'p@example.com' });
  });

  it('reads null, empty and id-0 assignees as unassigned', () => {
    for (const assignee of [null, undefined, {}, { id: 0 }]) {
      expect(mapEntry({ ...entryRow(1, 1, 'WAITING'), assignee } as never).assignee).toBeNull();
    }
  });
});

describe('completenessMismatches', () => {
  const e = (status: string, assigned: boolean) =>
    mapEntry({ ...entryRow(Math.floor(Math.random() * 1e6), 1, status), assignee: assigned ? { id: 9, name: 'X' } : null } as never);
  it('reads every count as an open-only count (DONE is not fetched)', () => {
    const entries = [e('NOT_STARTED', false), e('DONE', false), e('WAITING', true)];
    const base = { not_started: 1, in_process: 0, waiting: 1, done: 99 }; // done is never compared
    expect(completenessMismatches(entries, { ...base, unassigned: 1 })).toEqual([]);
    expect(completenessMismatches(entries, { ...base, unassigned: 2 })).toEqual(['unassigned: expected 2, got 1 open']);
    expect(completenessMismatches(entries, base, { unassigned_count: '1', assigned_count: 1 })).toEqual([]);
    expect(completenessMismatches(entries, base, { assigned_count: 2 })).toHaveLength(1);
  });

  it('verifies against x-total alone, and fails closed with nothing to compare', () => {
    const entries = [e('NOT_STARTED', false), e('DONE', true)];
    const paging = { scope: 'queue' as const, total: 2, totalChanged: false, received: 2, unique: 2 };
    expect(completenessMismatches(entries, null, { unassigned_count: null }, paging)).toEqual([]);
    expect(completenessMismatches(entries, null, { unassigned_count: '1' }, paging)).toEqual([]);
    expect(completenessMismatches(entries, null, { unassigned_count: null }, { ...paging, total: null })).toEqual([
      'no counts available to verify against',
    ]);
  });
});

describe('createPushpayDataSource', () => {
  it('reads the access token from D1 and calls the configured API host', async () => {
    const t = await createTestD1('migrations/0002_oauth.sql');
    const key = await importTokenKey(TEST_TOKEN_KEY);
    t.sqlite
      .prepare('UPDATE oauth_tokens SET refresh_token = ?, access_token = ?, access_expires_at = ?')
      .run(await sealToken(key, 'refresh_token', 'r'), await sealToken(key, 'access_token', 'access-from-d1'), Date.now() + 3600_000);
    const ds = createPushpayDataSource(
      { DB: t.db, CHMS_CLIENT_ID: 'c', CHMS_CLIENT_SECRET: 's', CHMS_API_HOST: 'https://api-beta.ccbchurch.com/', TOKEN_ENC_KEY: TEST_TOKEN_KEY },
      { fetch: fakeFetch, sleep: async () => {}, log: () => {} },
    );
    await ds.listQueues('37');
    expect(api.requests[0]!.origin).toBe('https://api-beta.ccbchurch.com');
    expect(api.auth[0]).toBe('Bearer access-from-d1');
  });
});
