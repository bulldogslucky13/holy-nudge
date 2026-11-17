// Read everything the job and views need from the data source, skipping excluded queues.
import { filterExcludedQueues, computeNudges, type AdminResult, type BehindGroup } from '../core/behind';
import type { DataSource, HolyNudgeConfig, Queue, QueueEntry } from '../core/types';

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

/** Every assignee and queue manager in the snapshot, de-duplicated by ChMS id. */
export function peopleSeen(s: Snapshot): { id: string; name: string }[] {
  const m = new Map<string, string>();
  for (const q of s.queues) for (const p of q.managers) m.set(p.id, p.name);
  for (const e of s.entries) if (e.assignee) m.set(e.assignee.id, e.assignee.name);
  return [...m].map(([id, name]) => ({ id, name }));
}

const GLOBAL_ADMIN = '\u0000all';

/** The admin view across every non-excluded queue (for leaders flagged is_admin). */
export function globalAdminView(s: Snapshot, config: HolyNudgeConfig, now: Date): AdminResult {
  const adminsByQueue = Object.fromEntries(s.queues.map((q) => [q.id, [GLOBAL_ADMIN]]));
  const r = computeNudges(s.queues, s.entries, { ...config, adminsByQueue }, now).admins.find((a) => a.adminId === GLOBAL_ADMIN);
  return r ?? { adminId: GLOBAL_ADMIN, name: null, queueIds: [], staleUnassigned: [], behindByLeader: [] };
}

export interface AdminCounts {
  /** Distinct students who are behind or stale-unassigned. */
  waiting: number;
  /** Leaders with at least one behind student. */
  leaders: number;
  /** Distinct waiting students with nobody assigned. */
  unassigned: number;
}

export function adminCounts(a: { staleUnassigned: QueueEntry[]; behindByLeader: BehindGroup[] }): AdminCounts {
  const waiting = new Set<string>();
  const unassigned = new Set<string>();
  for (const e of [...a.staleUnassigned, ...a.behindByLeader.flatMap((g) => g.entries)]) {
    waiting.add(e.id);
    if (!e.assignee) unassigned.add(e.id);
  }
  return { waiting: waiting.size, leaders: a.behindByLeader.filter((g) => g.leader !== null).length, unassigned: unassigned.size };
}
