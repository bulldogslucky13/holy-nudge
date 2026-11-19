// The heart of Holy Nudge: who is behind, who is waiting for a leader, and who gets told.
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
 * Waiting for a leader: nobody assigned and not DONE, however recently they arrived. This is the
 * Unassigned list and count; when it is worth a push is decided separately (see the nudge triggers).
 */
export function isUnassigned(entry: QueueEntry): boolean {
  return entry.assignee === null && entry.status !== 'DONE';
}

/* ---------------------------------------------------------------- when the push fires
 *
 * The lists and counts above say what is waiting. The rules below only decide whether that is worth a
 * push THIS morning, following the church's written process: coordinators send a first text within
 * `firstTextHours` (72) and assign the card; the assigned person follows up within `followUpDays` (7).
 * So a leader is nudged the first morning a student arrives, left alone during the grace week, then
 * nudged daily once the student is overdue, until done.
 *
 * "New" is stateless about students: it compares each entry's `created` with the start of the last
 * successful daily run. Nothing about any student is stored between runs.
 */

/** The morning being decided, and the start of the last successful daily run before it. */
export interface RunWindow {
  now: Date;
  /** `job_runs.started_at` of the latest successful daily run, or null when there has never been one. */
  lastRunAt: Date | null;
}

/** With no previous successful run, entries created this recently count as new. */
export const FIRST_RUN_LOOKBACK_MS = 24 * HOUR_MS;

/**
 * Entered the queue since the last successful daily run (`created` after its start), or within the last
 * 24 hours when there has been no successful run yet. Status and assignee are not considered here.
 *
 * A date-only `created` ("2026-11-17", as the Pushpay guide shows) is taken as the END of that calendar
 * day in the configured zone (createdToInstant). With one run each morning, a student who arrives on day D
 * is therefore new at the run on D+1, and also at the run on D itself if they were already in the queue
 * by then: at most two consecutive mornings, and never missed. The alternative (start of the day) could
 * miss someone added after that morning's run, because by the next run their day began before it. We
 * prefer one possible repeat to a miss. A failed run does not count (it never moves the window), so
 * entries are not missed across failures either; they are simply new at the next successful run.
 */
export function isNewSinceLastRun(entry: QueueEntry, w: RunWindow, tz: string): boolean {
  const created = createdToInstant(entry.created, tz);
  if (w.lastRunAt === null) return w.now.getTime() - created <= FIRST_RUN_LOOKBACK_MS;
  return created > w.lastRunAt.getTime();
}

/**
 * Not DONE and past its deadline. With a due date: the due calendar date is before today in the zone
 * (as isBehind). With none: Not Started and `created` more than `followUpDays` (elapsed time, a date-only
 * `created` counting from the end of its day) before `now`. In Process / Waiting with no due date never are.
 */
export function isOverdue(entry: QueueEntry, now: Date, config: Pick<HolyNudgeConfig, 'timeZone' | 'followUpDays'>): boolean {
  if (entry.status === 'DONE') return false;
  const tz = config.timeZone;
  if (entry.due !== null) return dueToDate(entry.due, tz) < zonedDate(now, tz);
  if (entry.status !== 'NOT_STARTED') return false;
  return now.getTime() - createdToInstant(entry.created, tz) > config.followUpDays * 24 * HOUR_MS;
}

/** Waited longer than the coordinators' first-text window (`firstTextHours`, elapsed time from `created`). */
export function isPastFirstText(entry: QueueEntry, now: Date, config: Pick<HolyNudgeConfig, 'timeZone' | 'firstTextHours'>): boolean {
  return now.getTime() - createdToInstant(entry.created, config.timeZone) > config.firstTextHours * HOUR_MS;
}

type TimingConfig = Pick<HolyNudgeConfig, 'timeZone' | 'followUpDays' | 'firstTextHours'>;

/** A leader's own push fires when one of their students is Not Started and new, or overdue. */
export function ownTriggered(entries: QueueEntry[], w: RunWindow, config: TimingConfig): boolean {
  return entries.some(
    (e) => (e.status === 'NOT_STARTED' && isNewSinceLastRun(e, w, config.timeZone)) || isOverdue(e, w.now, config),
  );
}

/**
 * A summary push fires when an unassigned student in scope is new or past the first-text window, or an
 * ASSIGNED student in scope is overdue. Someone else's new assignment alone never fires it.
 */
export function summaryTriggered(
  a: Pick<AdminResult, 'unassigned' | 'behindByLeader'>,
  w: RunWindow,
  config: TimingConfig,
): boolean {
  if (a.unassigned.some((e) => isNewSinceLastRun(e, w, config.timeZone) || isPastFirstText(e, w.now, config))) return true;
  return a.behindByLeader.some((g) => g.leader !== null && g.entries.some((e) => isOverdue(e, w.now, config)));
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
  /** Every unassigned, not-DONE entry in the admin's queues. */
  unassigned: QueueEntry[];
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
        unassigned: active.filter((e) => inScope(e) && isUnassigned(e)),
        behindByLeader,
      };
    });

  return { leaders, admins };
}
