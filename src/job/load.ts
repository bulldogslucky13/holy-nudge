// Read everything the job and views need from the data source, skipping excluded queues.
import { allQueuesView, filterExcludedQueues, type AdminResult, type BehindGroup, type CoordinatorScope } from '../core/behind';
import { planMatches } from '../core/match';
import type { DataSource, HolyNudgeConfig, Queue, QueueEntry } from '../core/types';
import type { LeaderRow, Store } from '../db';

export interface Snapshot {
  /** Non-excluded queues of the configured process. */
  queues: Queue[];
  entries: QueueEntry[];
}

export class EmptyProcessError extends Error {
  constructor(processId: string) {
    super(`Data source returned no usable queues for process ${processId}`);
    this.name = 'EmptyProcessError';
  }
}

export async function loadSnapshot(ds: DataSource, config: HolyNudgeConfig): Promise<Snapshot> {
  const all = await ds.listQueues(config.processId);
  // No queues at all almost certainly means the API changed (e.g. Workflows migration): fail loudly.
  if (all.length === 0) throw new EmptyProcessError(config.processId);
  const queues = filterExcludedQueues(all, config);
  const entries: QueueEntry[] = [];
  // Sequential on purpose: gentle on API rate limits.
  for (const q of queues) entries.push(...(await ds.listEntries(q.id)));
  return { queues, entries };
}

/**
 * Every assignee and queue manager in the snapshot, de-duplicated by ChMS id: the Lead people who get a leader
 * row and can be matched. Being a queue manager grants no access (see src/core/behind.ts, whole-queue scope).
 */
export function peopleSeen(s: Snapshot): { id: string; name: string }[] {
  const m = new Map<string, string>();
  for (const q of s.queues) for (const p of q.managers) m.set(p.id, p.name);
  for (const e of s.entries) if (e.assignee) m.set(e.assignee.id, e.assignee.name);
  return [...m].map(([id, name]) => ({ id, name }));
}

/**
 * Make sure every Lead person seen has a leader row, then tie leaders added by name (no ChMS id) to their
 * Lead person where the name rules in src/core/match.ts allow it, merging away the spare automatic row.
 * Used by the daily job and staff page views. Returns how many rows were matched (a count, never names).
 */
export async function syncLeaders(
  store: Pick<Store, 'upsertLeaders' | 'listLeaders' | 'applyMatches'>,
  people: { id: string; name: string }[],
): Promise<number> {
  await store.upsertLeaders(people);
  const merges = planMatches(await store.listLeaders(), people);
  return merges.length ? store.applyMatches(merges) : 0;
}

/** The admin view across every non-excluded queue (for leaders flagged is_admin, "staff"). */
export function globalAdminView(s: Snapshot, config: HolyNudgeConfig, now: Date): AdminResult {
  return allQueuesView(s.queues, s.entries, config, now);
}

/** Each leader row's coordinator keys, as computeNudges takes them (rows with none are left out). */
export function coordinatorScopes(rows: readonly Pick<LeaderRow, 'id' | 'coordinatorOf'>[]): CoordinatorScope[] {
  return rows.filter((r) => r.coordinatorOf.length > 0).map((r) => ({ leaderId: r.id, queueKeys: r.coordinatorOf }));
}

export interface AdminCounts {
  /** Distinct students who are behind or unassigned. */
  waiting: number;
  /** Leaders with at least one behind student. */
  leaders: number;
  /** Distinct waiting students with nobody assigned. */
  unassigned: number;
}

export function adminCounts(a: { unassigned: QueueEntry[]; behindByLeader: BehindGroup[] }): AdminCounts {
  const waiting = new Set<string>();
  const unassigned = new Set<string>();
  for (const e of [...a.unassigned, ...a.behindByLeader.flatMap((g) => g.entries)]) {
    waiting.add(e.id);
    if (!e.assignee) unassigned.add(e.id);
  }
  return { waiting: waiting.size, leaders: a.behindByLeader.filter((g) => g.leader !== null).length, unassigned: unassigned.size };
}
