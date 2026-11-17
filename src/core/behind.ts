// The heart of Holy Nudge: who is behind, who is stale-unassigned, and who gets told.
// Pure functions. `now` is always passed in.
import { HOUR_MS, createdToInstant, dueToDate, zonedDate } from './time';
import type { HolyNudgeConfig, Person, Queue, QueueEntry } from './types';

/** NOT_STARTED, or (not DONE and the due calendar date is before today's date in `tz`). */
export function isBehind(entry: QueueEntry, now: Date, tz: string): boolean {
  if (entry.status === 'NOT_STARTED') return true;
  if (entry.status === 'DONE') return false;
  if (entry.due === null) return false;
  return dueToDate(entry.due, tz) < zonedDate(now, tz);
}

/**
 * Unassigned, not DONE, and created more than 24 elapsed hours before `now`.
 * A date-only `created` counts from the end of that calendar day in `tz`, so it never flags early.
 */
export function isStaleUnassigned(entry: QueueEntry, now: Date, tz: string): boolean {
  if (entry.assignee !== null || entry.status === 'DONE') return false;
  return now.getTime() - createdToInstant(entry.created, tz) > 24 * HOUR_MS;
}

/** Drop queues whose id or exact name is listed in config.excludedQueues. */
export function filterExcludedQueues(queues: Queue[], config: Pick<HolyNudgeConfig, 'excludedQueues'>): Queue[] {
  const excluded = new Set(config.excludedQueues);
  return queues.filter((q) => !excluded.has(q.id) && !excluded.has(q.name));
}

/** Admin ids for a queue: config mapping (by id, then by name) if non-empty, else the queue's managers. */
export function adminIdsForQueue(queue: Queue, config: Pick<HolyNudgeConfig, 'adminsByQueue'>): string[] {
  const mapped = config.adminsByQueue[queue.id] ?? config.adminsByQueue[queue.name];
  if (mapped && mapped.length > 0) return mapped;
  return queue.managers.map((m) => m.id);
}

export interface LeaderResult {
  leader: Person;
  behind: QueueEntry[];
}

export interface BehindGroup {
  /** null = behind but nobody is assigned. */
  leader: Person | null;
  entries: QueueEntry[];
}

export interface AdminResult {
  adminId: string;
  /** Known from queue managers or assignees; null if the id appears only in config. */
  name: string | null;
  queueIds: string[];
  staleUnassigned: QueueEntry[];
  behindByLeader: BehindGroup[];
}

export interface NudgeResults {
  /** One item per assignee with at least one behind entry, sorted by name. */
  leaders: LeaderResult[];
  /** One item per admin of any non-excluded queue (lists may be empty), sorted by adminId. */
  admins: AdminResult[];
}

/**
 * Compute who gets nudged. Excluded queues are removed first; entries in queues not
 * listed in `queues` are ignored.
 */
export function computeNudges(
  queues: Queue[],
  entries: QueueEntry[],
  config: HolyNudgeConfig,
  now: Date,
): NudgeResults {
  const tz = config.timeZone;
  const activeQueues = filterExcludedQueues(queues, config);
  const queueById = new Map(activeQueues.map((q) => [q.id, q]));
  const active = entries.filter((e) => queueById.has(e.queueId));

  const behindEntries = active.filter((e) => isBehind(e, now, tz));

  // Leaders: group behind entries by assignee id.
  const byLeader = new Map<string, LeaderResult>();
  for (const e of behindEntries) {
    if (!e.assignee) continue;
    let r = byLeader.get(e.assignee.id);
    if (!r) byLeader.set(e.assignee.id, (r = { leader: e.assignee, behind: [] }));
    r.behind.push(e);
  }
  const leaders = [...byLeader.values()].sort(
    (a, b) => a.leader.name.localeCompare(b.leader.name) || a.leader.id.localeCompare(b.leader.id),
  );

  // Admins: queues each administers, plus whatever name we can learn.
  const adminQueues = new Map<string, Set<string>>();
  const adminNames = new Map<string, string>();
  for (const q of activeQueues) {
    for (const id of adminIdsForQueue(q, config)) {
      let s = adminQueues.get(id);
      if (!s) adminQueues.set(id, (s = new Set()));
      s.add(q.id);
    }
    for (const m of q.managers) adminNames.set(m.id, m.name);
  }
  for (const e of active) if (e.assignee && !adminNames.has(e.assignee.id)) adminNames.set(e.assignee.id, e.assignee.name);

  const admins: AdminResult[] = [...adminQueues.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([adminId, qset]) => {
      const inScope = (e: QueueEntry) => qset.has(e.queueId);
      const groups = new Map<string, BehindGroup>();
      for (const e of behindEntries.filter(inScope)) {
        const key = e.assignee?.id ?? '';
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { leader: e.assignee, entries: [] }));
        g.entries.push(e);
      }
      const behindByLeader = [...groups.values()].sort((a, b) => {
        if (a.leader === null) return 1; // unassigned last
        if (b.leader === null) return -1;
        return a.leader.name.localeCompare(b.leader.name) || a.leader.id.localeCompare(b.leader.id);
      });
      return {
        adminId,
        name: adminNames.get(adminId) ?? null,
        queueIds: [...qset],
        staleUnassigned: active.filter((e) => inScope(e) && isStaleUnassigned(e, now, tz)),
        behindByLeader,
      };
    });

  return { leaders, admins };
}
