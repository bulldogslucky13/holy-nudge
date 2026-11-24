// Live DataSource over the Pushpay ChMS v2 API (Process Queues). Read-only: GET requests only.
// Sources (fetched 2026-11-17): OpenAPI https://docs.pushpay.io/chms-v2/openapi/chms-api-specs.json,
// guide https://docs.pushpay.io/chms-v2/docs/process-queues-automating-workflows.md,
// rate limits and paging https://docs.pushpay.io/chms-v2/docs/general.md. See docs/chms-api-notes.md.
// Every assumption still to confirm is marked `SANDBOX:`; ones settled by the first real reads
// say "Confirmed against production 2026-11-24" (see docs/chms-api-notes.md).
// Logs carry ids and counts only: never names, phones, emails or tokens.
import type { DataSource, Person, Queue, QueueEntry, Status } from '../core/types';
import { ACCEPT_V2, apiHost, type OAuthEnv } from './oauth';
import { getAccessToken } from './tokens';

// ---------------------------------------------------------------------------
// Errors

/** A non-2xx answer from the API (after retries). `endpoint` is the path template, e.g. /queues/{id}. */
export class ChmsApiError extends Error {
  override name = 'ChmsApiError';
  constructor(
    readonly status: number,
    readonly endpoint: string,
    detail: string,
  ) {
    super(`Pushpay API ${endpoint}: ${status ? `HTTP ${status}` : 'no response'}. ${detail}`);
  }
}

/** The API answered, but with something we cannot map safely. */
export class ChmsDataError extends Error {
  override name = 'ChmsDataError';
}

/**
 * The entries fetched for a queue do not add up to the queue's own counts, so we may be
 * seeing only part of it (for example only what the authorizing user can see). The job
 * must treat this as a failure rather than nudge from partial data.
 */
export class IncompleteDataError extends Error {
  override name = 'IncompleteDataError';
  constructor(
    readonly queueId: string,
    readonly mismatches: string[],
  ) {
    super(
      `Queue ${queueId}: fetched entries do not match the queue's counts in ChMS (${mismatches.join('; ')}). ` +
        'The API may be returning only part of the queue.',
    );
  }
}

// ---------------------------------------------------------------------------
// Raw API shapes (only the fields we read; everything optional because nothing is verified yet)

interface RawPerson {
  id?: number | string | null;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  /** SANDBOX: seen on the update response in the PQ guide instead of `email`. */
  email_primary?: string | null;
  phone?: { mobile?: string | null; home?: string | null; work?: string | null } | null;
  preferred_number?: string | null;
}

interface RawQueueRow {
  id?: number | string;
  process_id?: number | string;
  name?: string;
  order_by?: number;
  managers?: RawPerson[] | null;
  queue_managers?: RawPerson[] | null;
  /** Not sent by the production API (confirmed 2026-11-24); kept in case a later version sends it. */
  assigned_count?: number | string | null;
  /** Confirmed against production 2026-11-24: a numeric string ("5") or null. null = not available. */
  unassigned_count?: number | string | null;
}

interface RawStatusCounts {
  done?: number;
  in_process?: number;
  not_started?: number;
  waiting?: number;
  unassigned?: number;
  overdue?: number;
}

interface RawQueueDetail {
  id?: number | string;
  name?: string;
  managers?: { id?: number | string; name?: string }[] | null;
  process?: { id?: number | string } | null;
  /** In the OpenAPI, but confirmed absent in production 2026-11-24; harmless if a later version sends it. */
  status_counts?: RawStatusCounts | null;
}

interface RawEntry {
  queue_individual_id?: number | string;
  queue_id?: number | string;
  individual_id?: number | string;
  status?: string;
  due?: string | null;
  created?: string | null;
  completed?: string | null;
  individual?: RawPerson | null;
  assignee?: RawPerson | null;
}

// ---------------------------------------------------------------------------
// Pure mapping helpers (exported for tests)

const STATUSES: readonly Status[] = ['NOT_STARTED', 'IN_PROCESS', 'WAITING', 'DONE'];

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/** ChMS writes "-0001-11-30 00:00:00" (PQ guide) or zeros for never-set dates. */
const isPlaceholderDate = (s: string) => s.startsWith('-') || s.startsWith('0000-');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MIDNIGHT = /^(\d{4}-\d{2}-\d{2})[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00(?::?00)?)?$/i;

/**
 * The one place a ChMS `due` value is interpreted. Output feeds core/time.ts `dueToDate`,
 * which keeps date-only values as calendar dates and converts offset datetimes to Central.
 *
 * Confirmed against production 2026-11-24: `due` is date-only ("YYYY-MM-DD"), as the PQ guide
 * says (the OpenAPI types it as date-time). The other shapes are still handled defensively:
 *   - null, "", "-0001-11-30 ..." placeholders -> null (no due date)
 *   - "2026-11-05" -> as-is (calendar date)
 *   - midnight, UTC or no zone ("2026-11-05T00:00:00Z", "...00:00:00.000Z", "2026-11-05 00:00:00")
 *     -> "2026-11-05": a calendar date serialised as a timestamp (the spec's own example for
 *     the date-typed `birthday` is "2011-10-27T00:00:00.000Z"). Converting it to Central
 *     would give Nov 4, 18:00 and mark people overdue a day early.
 *   - anything else (a real instant with a time or a non-zero offset) -> unchanged, so
 *     core converts it to the Central calendar date.
 */
export function mapDueDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new ChmsDataError('due is not a string');
  const s = raw.trim();
  if (s === '' || isPlaceholderDate(s)) return null;
  if (DATE_ONLY.test(s)) return s;
  const midnight = MIDNIGHT.exec(s);
  if (midnight?.[1]) return midnight[1];
  // No raw value in the message: error messages must never carry ChMS data.
  if (Number.isNaN(Date.parse(s.replace(' ', 'T')))) throw new ChmsDataError('Unrecognised due value');
  return s;
}

/** `completed`: raw value, or null when unset/placeholder. */
function mapOptionalTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s === '' || isPlaceholderDate(s) ? null : s;
}

/**
 * Phone for tap-to-text/call: mobile first, else the number `preferred_number` points at.
 * Confirmed against production 2026-11-24: queue rows' nested `individual` carries `phone`.
 * SANDBOX: the inner shape of `phone` ({mobile, home, work}) was not inspected, and
 * `preferred_number` was not among the observed `individual` keys.
 */
export function pickPhone(p: RawPerson | null | undefined): string | undefined {
  const phone = p?.phone;
  if (!phone || typeof phone !== 'object') return undefined;
  const mobile = nonEmpty(phone.mobile);
  if (mobile) return mobile;
  const pref = typeof p?.preferred_number === 'string' ? p.preferred_number.toUpperCase() : '';
  if (pref === 'HOME') return nonEmpty(phone.home);
  if (pref === 'WORK') return nonEmpty(phone.work);
  return undefined;
}

/** BasicIndividualProfileSerializer (or a bare {id, name}) -> Person; null when there is no id. */
export function mapPerson(p: RawPerson | null | undefined): Person | null {
  if (!p || typeof p !== 'object') return null;
  // SANDBOX: unassigned is `assignee: null` in the guide's example; also treat {} and id 0 as none.
  if (p.id === undefined || p.id === null || p.id === '' || p.id === 0 || p.id === '0') return null;
  const id = String(p.id);
  const name =
    nonEmpty(p.name) ?? nonEmpty([nonEmpty(p.first_name), nonEmpty(p.last_name)].filter(Boolean).join(' ')) ?? `Individual ${id}`;
  const person: Person = { id, name };
  const email = nonEmpty(p.email) ?? nonEmpty(p.email_primary);
  if (email) person.email = email;
  const phone = pickPhone(p);
  if (phone) person.phone = phone;
  return person;
}

export function mapEntry(r: RawEntry): QueueEntry {
  if (r.queue_individual_id === undefined || r.queue_id === undefined) {
    throw new ChmsDataError('Queue individual row without queue_individual_id or queue_id');
  }
  const id = String(r.queue_individual_id);
  if (!STATUSES.includes(r.status as Status)) throw new ChmsDataError('Entry with an unknown status');
  // Confirmed against production 2026-11-24: `created` and `completed` are date-only
  // ("2026-09-15"); passed through unchanged.
  const created = mapOptionalTimestamp(r.created);
  if (!created) throw new ChmsDataError('Entry with no created date');
  const individual = mapPerson(r.individual ?? null) ?? mapPerson({ id: r.individual_id ?? null });
  if (!individual) throw new ChmsDataError('Entry with no individual');
  return {
    id,
    queueId: String(r.queue_id),
    status: r.status as Status,
    due: mapDueDate(r.due),
    created,
    completed: mapOptionalTimestamp(r.completed),
    assignee: mapPerson(r.assignee ?? null),
    individual,
  };
}

/**
 * What one paged read saw. `scope` says what `total` covers: one queue (queue_ids[] read) or
 * the whole process (fallback read), so a per-queue slice is never compared to a process total.
 */
export interface PagingCheck {
  scope: 'queue' | 'process';
  /** `x-total` from the server; null when no page carried it. */
  total: number | null;
  /** `x-total` differed between pages of the same read (the list moved mid-read). */
  totalChanged: boolean;
  /** Rows received across all pages, before de-duplication. */
  received: number;
  /** Rows left after de-duplication by queue_individual_id. */
  unique: number;
}

/** A count from the API: a non-negative integer or a numeric string. Anything else (null too) = not available. */
export function toCount(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : undefined;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/**
 * Compare fetched entries with what the API says should be there: the paging total of the
 * read (`x-total`), and the queue's own counts when the API sends any. Returns human-readable
 * mismatches (counts only), or ['no counts available to verify against'] when there is
 * nothing to compare with.
 */
export function completenessMismatches(
  entries: QueueEntry[],
  counts: RawStatusCounts | null | undefined,
  listRow?: Pick<RawQueueRow, 'assigned_count' | 'unassigned_count'>,
  paging?: PagingCheck | null,
): string[] {
  const got = (pred: (e: QueueEntry) => boolean) => entries.filter(pred).length;
  const out: string[] = [];
  let compared = 0;
  if (paging && (paging.total !== null || paging.totalChanged)) {
    compared++;
    const what = paging.scope === 'process' ? 'process-wide read' : 'rows';
    if (paging.totalChanged) {
      out.push(`${what}: x-total changed between pages`);
    } else if (paging.received !== paging.total) {
      out.push(`${what}: x-total ${paging.total}, received ${paging.received}`);
    }
    // A row seen twice means the list shifted between pages, so another row may have been skipped.
    if (paging.unique !== paging.received) out.push(`${what}: ${paging.received - paging.unique} duplicate rows across pages`);
  }
  const byStatus: [keyof RawStatusCounts, Status][] = [
    ['not_started', 'NOT_STARTED'],
    ['in_process', 'IN_PROCESS'],
    ['waiting', 'WAITING'],
    ['done', 'DONE'],
  ];
  for (const [field, status] of byStatus) {
    const expected = toCount(counts?.[field]);
    if (expected === undefined) continue;
    compared++;
    const actual = got((e) => e.status === status);
    if (actual !== expected) out.push(`${field}: expected ${expected}, got ${actual}`);
  }
  // SANDBOX: unknown whether unassigned/assigned counts include DONE entries; accept either reading.
  const either = (label: string, raw: unknown, all: number, open: number) => {
    const expected = toCount(raw);
    if (expected === undefined) return;
    compared++;
    if (expected !== all && expected !== open) out.push(`${label}: expected ${expected}, got ${open} open / ${all} total`);
  };
  const unassigned = (e: QueueEntry) => e.assignee === null;
  const open = (e: QueueEntry) => e.status !== 'DONE';
  either('unassigned', counts?.unassigned, got(unassigned), got((e) => unassigned(e) && open(e)));
  either('unassigned_count', listRow?.unassigned_count, got(unassigned), got((e) => unassigned(e) && open(e)));
  either('assigned_count', listRow?.assigned_count, got((e) => !unassigned(e)), got((e) => !unassigned(e) && open(e)));
  if (compared === 0) return ['no counts available to verify against'];
  return out;
}

// ---------------------------------------------------------------------------
// The data source

export interface PushpayOptions {
  /** e.g. https://api.ccbchurch.com (sandbox https://api-beta.ccbchurch.com). */
  apiHost: string;
  /** Returns a valid access token; `rejected` = a token the API just answered 401 to. */
  accessToken: (rejected?: string) => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Epoch ms; default Date.now. */
  clock?: () => number;
  /** 25, 50, 75 or 100 (docs). */
  perPage?: 25 | 50 | 75 | 100;
  /** Paging safety cap per list call. */
  maxPages?: number;
  /**
   * Off by default. When on, entries that are not DONE and whose individual has no phone
   * get one GET /individuals/{id} each (rate limited to 1/s with no burst, so slow).
   */
  fetchContactsPerIndividual?: boolean;
  /** Client-side throttle per endpoint. Docs: 1 req/s sustained, burst 60, shared by every church on our client. */
  rateLimit?: { perSecond: number; burst: number };
  /** 429 retries per request (docs suggest 5). */
  maxRetries?: number;
  /** Diagnostic sink (ids and counts only). Default console.warn. */
  log?: (message: string) => void;
}

interface QueueInfo {
  processId: string;
  row: RawQueueRow;
  detail: RawQueueDetail | null;
}

interface Bucket {
  tokens: number;
  updated: number;
  blockedUntil: number;
}

const MAX_RETRY_AFTER_MS = 120_000;
const MIGRATION_HINT = 'If Process Queues were turned off for the church (Workflows migration), these endpoints stop working.';

export class PushpayDataSource implements DataSource {
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;
  private readonly perPage: number;
  private readonly maxPages: number;
  private readonly rate: { perSecond: number; burst: number };
  private readonly maxRetries: number;
  private readonly log: (m: string) => void;
  private readonly buckets = new Map<string, Bucket>();
  private readonly queues = new Map<string, QueueInfo>();
  private readonly contactCache = new Map<string, Promise<Person | null>>();
  private token: string | null = null;
  /** false once /queues_individuals is seen to ignore queue_ids[] (production honours it, 2026-11-24). */
  private serverQueueFilter = true;
  private allRows: Promise<{ byQueue: Map<string, RawEntry[]>; paging: PagingCheck }> | null = null;

  constructor(private readonly opts: PushpayOptions) {
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.clock = opts.clock ?? (() => Date.now());
    this.perPage = opts.perPage ?? 100;
    this.maxPages = opts.maxPages ?? 50;
    // Default burst well under the documented 60: the bucket is shared with page views.
    this.rate = opts.rateLimit ?? { perSecond: 1, burst: 10 };
    this.maxRetries = opts.maxRetries ?? 5;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  /** Queues of a process, in ChMS order, with managers from GET /queues/{id}. */
  async listQueues(processId: string): Promise<Queue[]> {
    const rows = await this.getAll<RawQueueRow>('/queues', [['process_ids[]', processId]]);
    const seen = new Set<string>();
    const mine = rows.filter((r) => {
      if (r.id === undefined) return false;
      // Defensive: if process_ids[] were ignored, drop other processes' queues.
      if (r.process_id !== undefined && String(r.process_id) !== processId) return false;
      if (seen.has(String(r.id))) return false;
      seen.add(String(r.id));
      return true;
    });
    // PQ guide: order by order_by, not array order.
    mine.sort((a, b) => (a.order_by ?? 0) - (b.order_by ?? 0) || Number(a.id) - Number(b.id));

    const out: Queue[] = [];
    for (const row of mine) {
      const id = String(row.id);
      const detail = await this.getQueueDetail(id);
      this.queues.set(id, { processId, row, detail });
      out.push({ id, name: row.name ?? detail.name ?? `Queue ${id}`, processId, managers: this.managers(row, detail) });
    }
    return out;
  }

  /**
   * Every entry in the queue, all four statuses, verified against what the API says should
   * be there. Throws IncompleteDataError if the numbers still disagree after one re-read.
   *
   * Checks (completenessMismatches): the read's `x-total` against the rows received (and no
   * duplicates across pages); the list row's `unassigned_count` when it is a number; and
   * `status_counts` / `assigned_count` if a later API version sends them. Confirmed against
   * production 2026-11-24: `x-total` is sent, `unassigned_count` is a string or null, and
   * there is no `status_counts` or `assigned_count`. Strict: with nothing at all to compare it
   * fails rather than trusting the rows.
   *
   * On the re-read the /queues list is fetched again (one request) so `unassigned_count` is
   * current: the row from listQueues can be a minute old, and a coordinator assigning a card
   * in that minute must not fail the run. If the queue is missing from the fresh list the
   * comparison is skipped for that attempt; the paging total still applies.
   *
   * SANDBOX: the docs do not say whether, under System Auth, /queues_individuals returns
   * entries assigned to people other than the authorizing user (`assignment` omitted = "both"
   * of assigned-to-me and unassigned). `x-total` cannot show this (it counts what the server
   * chose to return) and `unassigned_count` covers only unassigned rows.
   */
  async listEntries(queueId: string): Promise<QueueEntry[]> {
    for (let attempt = 1; ; attempt++) {
      const cached = this.queues.get(queueId);
      const detail = attempt === 1 && cached?.detail ? cached.detail : await this.getQueueDetail(queueId);
      if (cached) cached.detail = detail;
      const { rows, paging } = await this.fetchQueueRows(queueId, attempt > 1);
      const listRow = attempt === 1 ? cached?.row : await this.refreshListRow(queueId);
      const entries = rows.map(mapEntry);
      const mismatches = completenessMismatches(entries, detail.status_counts, listRow, paging);
      if (mismatches.length === 0) {
        return this.opts.fetchContactsPerIndividual ? this.fillContacts(entries) : entries;
      }
      if (attempt >= 2) throw new IncompleteDataError(queueId, mismatches);
      // Counts can legitimately move while we read (someone working the queue): re-read once.
      this.log(`pushpay: queue ${queueId} counts disagree (${mismatches.join('; ')}); re-reading once`);
    }
  }

  // --- queues ---------------------------------------------------------------

  /** Re-reads the process's /queues list and returns this queue's fresh row (undefined if unknown or gone). */
  private async refreshListRow(queueId: string): Promise<RawQueueRow | undefined> {
    const info = this.queues.get(queueId);
    if (!info) return undefined;
    const rows = await this.getAll<RawQueueRow>('/queues', [['process_ids[]', info.processId]]);
    let fresh: RawQueueRow | undefined;
    for (const r of rows) {
      if (r.id === undefined || (r.process_id !== undefined && String(r.process_id) !== info.processId)) continue;
      const known = this.queues.get(String(r.id));
      if (known && known.processId === info.processId) known.row = r; // later queues get the fresh count too
      if (String(r.id) === queueId) fresh = r;
    }
    if (!fresh) this.log(`pushpay: queue ${queueId} missing from the refreshed queue list; skipping its unassigned_count check`);
    return fresh;
  }

  private async getQueueDetail(queueId: string): Promise<RawQueueDetail> {
    const { body } = await this.get<RawQueueDetail>(`/queues/${encodeURIComponent(queueId)}`, []);
    if (!body || typeof body !== 'object') throw new ChmsDataError(`Queue ${queueId}: detail is not an object`);
    return body;
  }

  /** Managers from the detail (ids + names), enriched with contact fields from the list row when it has them. */
  private managers(row: RawQueueRow, detail: RawQueueDetail): Person[] {
    const rich = new Map<string, Person>();
    for (const m of [...(row.managers ?? []), ...(row.queue_managers ?? [])]) {
      const p = mapPerson(m);
      if (p && !rich.has(p.id)) rich.set(p.id, p);
    }
    const fromDetail = (detail.managers ?? []).map((m) => mapPerson(m)).filter((p): p is Person => p !== null);
    if (fromDetail.length === 0) return [...rich.values()]; // SANDBOX: detail without managers
    return fromDetail.map((p) => ({ ...rich.get(p.id), ...p, ...pickContact(rich.get(p.id)) }));
  }

  // --- entries --------------------------------------------------------------

  private static statusParams(): [string, string][] {
    // DONE must be asked for explicitly or it is silently left out (PQ guide).
    return STATUSES.map((s) => ['statuses[]', s]);
  }

  private async fetchQueueRows(queueId: string, fresh: boolean): Promise<{ rows: RawEntry[]; paging: PagingCheck }> {
    if (this.serverQueueFilter) {
      // queue_ids[] is in the PQ guide but not in the OpenAPI parameter list. Confirmed against
      // production 2026-11-24: it is honoured. The fallback below stays for safety.
      const read = await this.getPaged<RawEntry>('/queues_individuals', [
        ['queue_ids[]', queueId],
        ...PushpayDataSource.statusParams(),
      ]);
      const foreign = read.rows.filter((r) => String(r.queue_id) !== queueId).length;
      if (foreign === 0) {
        const rows = dedupe(read.rows);
        return { rows, paging: { scope: 'queue', total: read.total, totalChanged: read.totalChanged, received: read.rows.length, unique: rows.length } };
      }
      this.serverQueueFilter = false;
      this.log(`pushpay: queue_ids[] filter was ignored (${foreign} rows from other queues); switching to one process-wide read`);
    }
    if (fresh || !this.allRows) {
      const processId = this.queues.get(queueId)?.processId;
      const query: [string, string][] = processId ? [['process_ids[]', processId]] : [];
      const pending = this.getPaged<RawEntry>('/queues_individuals', [...query, ...PushpayDataSource.statusParams()]).then(
        (read) => {
          const unique = dedupe(read.rows);
          const byQueue = new Map<string, RawEntry[]>();
          for (const r of unique) {
            const k = String(r.queue_id);
            const list = byQueue.get(k) ?? [];
            list.push(r);
            byQueue.set(k, list);
          }
          // x-total here covers the whole process, so it is checked against the whole read.
          const paging: PagingCheck = { scope: 'process', total: read.total, totalChanged: read.totalChanged, received: read.rows.length, unique: unique.length };
          return { byQueue, paging };
        },
      );
      this.allRows = pending;
      pending.catch(() => {
        if (this.allRows === pending) this.allRows = null;
      });
    }
    const all = await this.allRows!;
    return { rows: all.byQueue.get(queueId) ?? [], paging: all.paging };
  }

  private async fillContacts(entries: QueueEntry[]): Promise<QueueEntry[]> {
    const out: QueueEntry[] = [];
    for (const e of entries) {
      if (e.status === 'DONE' || e.individual.phone) {
        out.push(e);
        continue;
      }
      const id = e.individual.id;
      let pending = this.contactCache.get(id);
      if (!pending) {
        pending = this.get<RawPerson>(`/individuals/${encodeURIComponent(id)}`, []).then(
          ({ body }) => mapPerson(body),
          (err: unknown) => {
            // A merged or hidden profile should not sink the whole run: go without its phone.
            if (err instanceof ChmsApiError && (err.status === 403 || err.status === 404)) {
              this.log(`pushpay: an individual was not readable (HTTP ${err.status}); no phone`);
              return null;
            }
            throw err;
          },
        );
        this.contactCache.set(id, pending);
      }
      const full = await pending;
      out.push(full ? { ...e, individual: { ...e.individual, ...pickContact(full) } } : e);
    }
    return out;
  }

  // --- HTTP -----------------------------------------------------------------

  private async getAll<T>(path: string, query: [string, string][]): Promise<T[]> {
    return (await this.getPaged<T>(path, query)).rows;
  }

  /**
   * Every page of a list, with the server's `x-total`. If `x-total` differs between pages the
   * list moved mid-read: `totalChanged` is set and the caller treats it as a mismatch (re-read),
   * the stricter of the two options, since rows may have shifted past a page boundary.
   */
  private async getPaged<T>(
    path: string,
    query: [string, string][],
  ): Promise<{ rows: T[]; total: number | null; totalChanged: boolean }> {
    const out: T[] = [];
    let total: number | null = null;
    let totalChanged = false;
    for (let page = 1; ; page++) {
      if (page > this.maxPages) {
        throw new ChmsDataError(`${path}: more than ${this.maxPages} pages; refusing to continue`);
      }
      const { body, headers } = await this.get<unknown>(path, [
        ...query,
        ['per_page', String(this.perPage)],
        ['page', String(page)],
      ]);
      if (!Array.isArray(body)) throw new ChmsDataError(`${path}: expected a list`);
      out.push(...(body as T[]));
      const pageTotal = toInt(headers.get('x-total'));
      if (pageTotal !== null) {
        if (total !== null && total !== pageTotal) totalChanged = true;
        total = pageTotal;
      }
      // /queues_individuals documents no paging headers, but confirmed against production
      // 2026-11-24: x-page, x-per-page, x-total, x-total-pages on every page, and x-next-page
      // except on the last. Still stop on a short page if they ever go missing.
      const pageSize = toInt(headers.get('x-per-page')) ?? this.perPage;
      const next = headers.get('x-next-page');
      const totalPages = toInt(headers.get('x-total-pages'));
      if (body.length === 0 || body.length < pageSize) break;
      if (next !== null && next.trim() === '') break;
      if (totalPages !== null && page >= totalPages) break;
    }
    return { rows: out, total, totalChanged };
  }

  private async get<T>(path: string, query: [string, string][]): Promise<{ body: T; headers: Headers }> {
    // Array params must be sent as literal `key[]=v` (a bare key gets 412); built by hand so
    // the brackets are not percent-encoded, matching the guide's curl examples. The OpenAPI
    // declares `statuses` as a plain exploded form array (no []); the guide wins here, and
    // `statuses[]` was confirmed against production 2026-11-24 (DONE rows come back).
    const qs = query.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const url = `${this.opts.apiHost.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`;
    const endpoint = path.replace(/\/\d+(?=\/|$)/g, '/{id}');
    let token = this.token ?? (this.token = await this.opts.accessToken());
    let reauthorized = false;
    let rateLimited = 0;
    let serverErrors = 0;

    for (;;) {
      await this.throttle(endpoint);
      let res: Response;
      try {
        res = await this.doFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT_V2 } });
      } catch {
        if (serverErrors++ < 2) {
          await this.sleep(1000 * 2 ** serverErrors);
          continue;
        }
        throw new ChmsApiError(0, endpoint, 'Network error.');
      }
      this.noteRateHeaders(endpoint, res.headers);

      if (res.status === 429) {
        void res.body?.cancel().catch(() => {});
        if (rateLimited >= this.maxRetries) throw new ChmsApiError(429, endpoint, 'Still rate limited after retries.');
        const wait = retryAfterMs(res.headers, this.clock()) ?? 1000 * 2 ** rateLimited;
        rateLimited++;
        if (wait > MAX_RETRY_AFTER_MS) throw new ChmsApiError(429, endpoint, `Rate limited; retry-after ${Math.round(wait / 1000)} s is too long.`);
        this.log(`pushpay: 429 on ${endpoint}; waiting ${Math.ceil(wait / 1000)} s`);
        await this.sleep(wait);
        continue;
      }
      if (res.status === 401 && !reauthorized) {
        // Expired or revoked access token (SANDBOX: exact status/body undocumented): refresh once.
        void res.body?.cancel().catch(() => {});
        reauthorized = true;
        token = this.token = await this.opts.accessToken(token);
        continue;
      }
      if (res.status >= 500 && serverErrors < 2) {
        void res.body?.cancel().catch(() => {});
        serverErrors++;
        await this.sleep(1000 * 2 ** serverErrors);
        continue;
      }
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        throw new ChmsApiError(res.status, endpoint, explain(res.status));
      }
      let body: T;
      try {
        body = (await res.json()) as T;
      } catch {
        throw new ChmsDataError(`${endpoint}: response is not JSON`);
      }
      return { body, headers: res.headers };
    }
  }

  /** Token bucket per endpoint; also honours x-ratelimit-remaining: 0 until x-ratelimit-reset. */
  private async throttle(endpoint: string): Promise<void> {
    // /individuals/{id} has its own limit with no burst (docs).
    const { perSecond, burst } = endpoint === '/individuals/{id}' ? { perSecond: 1, burst: 1 } : this.rate;
    let b = this.buckets.get(endpoint);
    if (!b) {
      b = { tokens: burst, updated: this.clock(), blockedUntil: 0 };
      this.buckets.set(endpoint, b);
    }
    for (;;) {
      const now = this.clock();
      b.tokens = Math.min(burst, b.tokens + ((now - b.updated) / 1000) * perSecond);
      b.updated = now;
      const wait = Math.max(b.blockedUntil - now, b.tokens >= 1 ? 0 : ((1 - b.tokens) / perSecond) * 1000);
      if (wait <= 0) {
        b.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(wait));
    }
  }

  private noteRateHeaders(endpoint: string, headers: Headers): void {
    const remaining = toInt(headers.get('x-ratelimit-remaining'));
    const reset = toInt(headers.get('x-ratelimit-reset'));
    const b = this.buckets.get(endpoint);
    if (!b || remaining !== 0 || reset === null) return;
    const now = this.clock();
    b.blockedUntil = Math.min(reset * 1000, now + 60_000);
  }
}

// ---------------------------------------------------------------------------

function pickContact(p: Person | undefined): Partial<Person> {
  const out: Partial<Person> = {};
  if (p?.email) out.email = p.email;
  if (p?.phone) out.phone = p.phone;
  return out;
}

function dedupe(rows: RawEntry[]): RawEntry[] {
  // Rows can shift between pages while we read (no documented sort); keep the first of each id.
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = String(r.queue_individual_id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function toInt(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function retryAfterMs(headers: Headers, now: number): number | null {
  const v = headers.get('retry-after');
  if (v === null) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function explain(status: number): string {
  switch (status) {
    case 401:
      return 'Access token rejected twice; the token may lack a scope for this endpoint.';
    case 403:
    case 404:
    case 410:
      return `Not allowed or not found. ${MIGRATION_HINT}`;
    case 405:
      return 'Method not allowed (path typo?).';
    case 412:
      return 'A filter was rejected (array parameters need []).';
    default:
      return status >= 500 ? 'Server error after retries.' : 'Unexpected status.';
  }
}

/**
 * Factory for the backend's data-source switch. Tokens come from D1 via getAccessToken,
 * which refreshes under the lock when needed.
 */
export function createPushpayDataSource(
  env: Pick<OAuthEnv, 'DB' | 'CHMS_CLIENT_ID' | 'CHMS_CLIENT_SECRET' | 'CHMS_API_HOST' | 'TOKEN_ENC_KEY'>,
  options: Omit<Partial<PushpayOptions>, 'apiHost' | 'accessToken'> = {},
): PushpayDataSource {
  return new PushpayDataSource({
    ...options,
    apiHost: apiHost(env),
    accessToken: (rejected) =>
      getAccessToken(env.DB, env, Date.now(), { fetch: options.fetch, rejectedAccessToken: rejected }),
  });
}
