import { beforeEach, describe, expect, it } from 'vitest';
import {
  ChmsApiError,
  ChmsDataError,
  completenessMismatches,
  createPushpayDataSource,
  IncompleteDataError,
  mapDueDate,
  mapEntry,
  mapPerson,
  PushpayDataSource,
  type PushpayOptions,
} from '../src/chms/pushpay';
import { dueToDate } from '../src/core/time';
import { importTokenKey, sealToken } from '../src/chms/tokenbox';
import { TEST_TOKEN_KEY } from './helpers';
import { createTestD1 } from './sqlite-d1';

const TZ = 'America/Chicago';
const API = 'https://api.test';
type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// A fake Pushpay API. All names, emails and numbers are invented.

interface FakeApi {
  queues: Json[];
  details: Record<string, Json>;
  entries: Json[];
  individuals: Record<string, Json>;
  /** Ignore queue_ids[] like a server that does not support it. */
  ignoreQueueFilter: boolean;
  /** Hide entries assigned to anyone but this id (simulates "only what the user can see"). */
  visibleAssignee: string | null;
  pagingHeaders: boolean;
  requests: URL[];
  auth: string[];
  /** Per-request override; return undefined to fall through. */
  intercept: ((url: URL, n: number) => Response | undefined) | null;
}

let api: FakeApi;
let clockMs: number;
let sleeps: number[];
let logs: string[];

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
      phone: { mobile: `555-01${String(i % 100).padStart(2, '0')}`, home: '', work: '' },
      preferred_number: 'MOBILE',
    },
    assignee: i % 3 === 0 ? null : { id: i % 2 ? 801 : 802, name: i % 2 ? 'Leader One' : 'Leader Two' },
    ...over,
  };
}

function countsFor(queueId: number): Json {
  const rows = api.entries.filter((e) => e.queue_id === queueId);
  const n = (s: string) => rows.filter((e) => e.status === s).length;
  return {
    not_started: n('NOT_STARTED'),
    in_process: n('IN_PROCESS'),
    waiting: n('WAITING'),
    done: n('DONE'),
    unassigned: rows.filter((e) => e.assignee === null && e.status !== 'DONE').length,
    overdue: 0,
  };
}

function page<T>(rows: T[], url: URL): Response {
  const per = Number(url.searchParams.get('per_page') ?? 25);
  const p = Number(url.searchParams.get('page') ?? 1);
  const slice = rows.slice((p - 1) * per, p * per);
  const totalPages = Math.max(1, Math.ceil(rows.length / per));
  const headers: Record<string, string> = api.pagingHeaders
    ? { 'x-total': String(rows.length), 'x-total-pages': String(totalPages), 'x-page': String(p), 'x-per-page': String(per), 'x-next-page': p < totalPages ? String(p + 1) : '' }
    : {};
  return Response.json(slice, { headers });
}

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
    return d ? Response.json({ ...d, status_counts: d.status_counts ?? countsFor(Number(m[1])) }) : new Response('', { status: 404 });
  }
  if (path === '/queues_individuals') {
    expect(raw).toContain('statuses[]=NOT_STARTED&statuses[]=IN_PROCESS&statuses[]=WAITING&statuses[]=DONE');
    const statuses = url.searchParams.getAll('statuses[]');
    const qids = url.searchParams.getAll('queue_ids[]');
    let rows = api.entries.filter((e) => statuses.includes(String(e.status)));
    if (qids.length && !api.ignoreQueueFilter) rows = rows.filter((e) => qids.includes(String(e.queue_id)));
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
  for (let i = 0; i < 130; i++) entries.push(entryRow(i, 5001, statuses[i % 4]!));
  for (let i = 130; i < 140; i++) entries.push(entryRow(i, 5002, 'NOT_STARTED'));
  entries.push(entryRow(140, 6001, 'NOT_STARTED')); // another process
  api = {
    queues: [
      { id: 5002, process_id: 37, name: 'Outreach Team', order_by: 2, managers: [], assigned_count: 7 },
      {
        id: 5001,
        process_id: 37,
        name: 'Connect Card Coordinators',
        order_by: 1,
        managers: [{ id: 801, name: 'Leader One', email: 'leader1@example.com', phone: { mobile: '555-0199' } }],
      },
      { id: 6001, process_id: 99, name: 'Other process', order_by: 1 },
    ],
    details: {
      '5001': { id: 5001, name: 'Connect Card Coordinators', managers: [{ id: 801, name: 'Leader One' }, { id: 803, name: 'Leader Three' }] },
      '5002': { id: 5002, name: 'Outreach Team', managers: [] },
      '6001': { id: 6001, name: 'Other process', managers: [] },
    },
    entries,
    individuals: {},
    ignoreQueueFilter: false,
    visibleAssignee: null,
    pagingHeaders: true,
    requests: [],
    auth: [],
    intercept: null,
  };
});

const paths = () => api.requests.map((u) => u.pathname);

// ---------------------------------------------------------------------------

describe('listQueues', () => {
  it('lists the process queues in ChMS order with managers from the queue detail', async () => {
    const queues = await source().listQueues('37');
    expect(queues.map((q) => [q.id, q.name, q.processId])).toEqual([
      ['5001', 'Connect Card Coordinators', '37'],
      ['5002', 'Outreach Team', '37'],
    ]);
    expect(queues[0]!.managers).toEqual([
      { id: '801', name: 'Leader One', email: 'leader1@example.com', phone: '555-0199' },
      { id: '803', name: 'Leader Three' },
    ]);
    expect(queues[1]!.managers).toEqual([]);
    expect(String(api.requests[0])).toBe(`${API}/queues?process_ids[]=37&per_page=100&page=1`);
    expect(paths()).toEqual(['/queues', '/queues/5001', '/queues/5002']);
    expect(api.auth.every((a) => a === 'Bearer access-0')).toBe(true);
  });
});

describe('listEntries', () => {
  it('asks for all four statuses, pages to the end, and maps every field', async () => {
    const entries = await source().listEntries('5001');
    expect(entries).toHaveLength(130);
    const pages = api.requests.filter((u) => u.pathname === '/queues_individuals').map((u) => u.searchParams.get('page'));
    expect(pages).toEqual(['1', '2']);
    expect(String(api.requests.find((u) => u.pathname === '/queues_individuals'))).toContain('queue_ids[]=5001');
    expect(new Set(entries.map((e) => e.status))).toEqual(new Set(['NOT_STARTED', 'IN_PROCESS', 'WAITING', 'DONE']));

    const first = entries.find((e) => e.id === '900001')!;
    expect(first).toEqual({
      id: '900001',
      queueId: '5001',
      status: 'IN_PROCESS',
      due: '2026-11-10',
      created: '2026-11-01',
      completed: null,
      assignee: { id: '801', name: 'Leader One' },
      individual: { id: '70001', name: 'Student 1', email: 'student1@example.com', phone: '555-0101' },
    });
    expect(entries.find((e) => e.id === '900000')!.assignee).toBeNull();
    expect(entries.find((e) => e.id === '900003')!.completed).toBe('2026-11-12');
  });

  it('stops on a short page when no paging headers are sent, including an exact-multiple last page', async () => {
    api.pagingHeaders = false;
    api.entries = api.entries.filter((e) => e.queue_id !== 5001 || Number(e.queue_individual_id) < 900100);
    expect(await source().listEntries('5001')).toHaveLength(100);
    const pages = api.requests.filter((u) => u.pathname === '/queues_individuals').map((u) => u.searchParams.get('page'));
    expect(pages).toEqual(['1', '2']); // page 2 is empty
  });

  it('filters client-side and reads once per run when the server ignores queue_ids[]', async () => {
    api.ignoreQueueFilter = true;
    const ds = source();
    await ds.listQueues('37');
    const a = await ds.listEntries('5001');
    const b = await ds.listEntries('5002');
    expect(a.every((e) => e.queueId === '5001')).toBe(true);
    expect(a).toHaveLength(130);
    expect(b).toHaveLength(10);
    const listCalls = api.requests.filter((u) => u.pathname === '/queues_individuals');
    // first try with queue_ids[] (2 pages), then one process-wide read (2 pages), reused for 5002
    expect(listCalls.map((u) => u.searchParams.has('queue_ids[]'))).toEqual([true, true, false, false]);
    expect(listCalls[2]!.searchParams.getAll('process_ids[]')).toEqual(['37']);
    expect(logs.some((l) => l.includes('queue_ids[] filter was ignored'))).toBe(true);
  });

  it('throws IncompleteDataError when the rows do not add up to the queue counts', async () => {
    api.visibleAssignee = '801'; // the API hides rows assigned to other leaders
    const err = await source().listEntries('5001').catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteDataError);
    expect(err.queueId).toBe('5001');
    expect(err.message).toMatch(/not_started: expected 33, got \d+/);
    expect(err.message).not.toMatch(/Student|example\.com|555-/);
    // it re-read once before giving up
    expect(api.requests.filter((u) => u.pathname === '/queues/5001')).toHaveLength(2);
  });

  it('accepts counts that settle on the re-read (someone worked the queue mid-run)', async () => {
    let detailCalls = 0;
    api.intercept = (url) => {
      if (url.pathname === '/queues/5002' && ++detailCalls === 1) {
        return Response.json({ id: 5002, managers: [], status_counts: { not_started: 11, in_process: 0, waiting: 0, done: 0 } });
      }
      return undefined;
    };
    expect(await source().listEntries('5002')).toHaveLength(10);
  });

  it('refuses to verify against nothing', async () => {
    api.intercept = (url) => (url.pathname === '/queues/5002' ? Response.json({ id: 5002, managers: [] }) : undefined);
    api.details['5002']!.status_counts = undefined;
    await expect(source().listEntries('5002')).rejects.toBeInstanceOf(IncompleteDataError);
  });

  it('rejects unknown statuses loudly', async () => {
    api.intercept = (url) =>
      url.pathname === '/queues_individuals' ? Response.json([entryRow(200, 5002, 'ARCHIVED')]) : undefined;
    await expect(source().listEntries('5002')).rejects.toBeInstanceOf(ChmsDataError);
  });

  it('only fetches per-individual contacts when the option is on', async () => {
    for (const e of api.entries) if (e.queue_id === 5002) (e.individual as Json).phone = null;
    api.entries.push(entryRow(141, 5002, 'DONE', { individual: { id: 70141, name: 'Done Person' } }));
    for (let i = 130; i < 139; i++) api.individuals[String(70000 + i)] = { id: 70000 + i, phone: { mobile: '' } };
    api.individuals['70130'] = { id: 70130, name: 'Student 130', phone: { mobile: '', home: '555-0177' }, preferred_number: 'HOME' };
    // 70139 is missing (404): tolerated, the entry just has no phone.

    const off = await source().listEntries('5002');
    expect(off.every((e) => e.individual.phone === undefined)).toBe(true);
    expect(paths().some((p) => p.startsWith('/individuals/'))).toBe(false);

    api.requests = [];
    const on = await source({ fetchContactsPerIndividual: true }).listEntries('5002');
    expect(on.find((e) => e.individual.id === '70130')!.individual.phone).toBe('555-0177');
    expect(on.find((e) => e.individual.id === '70139')!.individual.phone).toBeUndefined();
    const individualCalls = paths().filter((p) => p.startsWith('/individuals/'));
    expect(individualCalls).toHaveLength(10); // the 10 open entries, not the DONE one
    expect(individualCalls).not.toContain('/individuals/70141');
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
    const ds = source({ rateLimit: { perSecond: 1, burst: 2 } });
    const start = clockMs;
    await ds.listQueues('37'); // /queues once, then /queues/{id} twice
    await ds.listEntries('5002'); // /queues/{id} cached, /queues_individuals once
    await ds.listEntries('5001'); // /queues_individuals twice more
    // /queues_individuals: 3 calls with burst 2 -> one wait of 1 s. /queues/{id}: 2 calls, no wait.
    expect(clockMs - start).toBe(1000);
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
  // SANDBOX: which of these formats the API really sends is unconfirmed.
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
  it('accepts unassigned counts with or without DONE entries', () => {
    const entries = [e('NOT_STARTED', false), e('DONE', false), e('WAITING', true)];
    const base = { not_started: 1, in_process: 0, waiting: 1, done: 1 };
    expect(completenessMismatches(entries, { ...base, unassigned: 1 })).toEqual([]);
    expect(completenessMismatches(entries, { ...base, unassigned: 2 })).toEqual([]);
    expect(completenessMismatches(entries, { ...base, unassigned: 3 })).toHaveLength(1);
    expect(completenessMismatches(entries, base, { assigned_count: 2 })).toHaveLength(1);
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
