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
 *
 * That last part is a design decision, not a gap: an assigned student has an owner, who gets the day-one
 * nudge and the follow-up week. Coordinators and staff are escalated to only when that week has run out;
 * until then the student is on their Behind list in the app, without a push.
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

/* ---------------------------------------------------------------- whole-queue scope
 *
 * Seeing a WHOLE queue (everyone unassigned or behind in it, and its morning summary) is granted only by:
 *  - staff (leaders.is_admin): every non-excluded queue (allQueuesView), or
 *  - a coordinator row (table queue_coordinators): the queues named by that leader row's keys.
 * Lead's queue managers grant nothing: in the real data every team member manages their own queue. Scope
 * attaches to the app's leader row (the person holding the personal link), never to a Lead id, so it works
 * before the row is matched to Lead. With no coordinator rows, nobody but staff has a whole-queue view.
 */

/** One leader row's coordinator keys (queue_coordinators.queue_key: queue ids or exact queue names). */
export interface CoordinatorScope {
  leaderId: number;
  queueKeys: readonly string[];
}

/**
 * Ids (in `queues` order) of the queues that `keys` name. A key equal to some queue's id matches that queue
 * only; any other key matches every queue with exactly that name (case and spacing count). A key that matches
 * nothing grants nothing.
 *
 * `reservedIds` are ids of queues that exist but are not in `queues` (the excluded ones, which the snapshot
 * drops before anything is computed). A key equal to one of them names that excluded queue and nothing else:
 * it must never fall through to another queue that happens to have that text as its name.
 */
export function queueIdsForKeys(queues: readonly Queue[], keys: readonly string[], reservedIds: readonly string[] = []): string[] {
  const ids = new Set(queues.map((q) => q.id));
  const reserved = new Set(reservedIds);
  const hit = new Set<string>();
  for (const k of keys) {
    if (ids.has(k)) hit.add(k);
    else if (reserved.has(k)) continue;
    else for (const q of queues) if (q.name === k) hit.add(q.id);
  }
  return queues.filter((q) => hit.has(q.id)).map((q) => q.id);
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

/** A whole-queue view: what a coordinator (their queues) or staff (every queue) sees and is summarised. */
export interface AdminResult {
  /** Non-excluded queues in scope, in queue order. */
  queueIds: string[];
  /** Every unassigned, not-DONE entry in those queues. */
  unassigned: QueueEntry[];
  behindByLeader: BehindGroup[];
}

export interface CoordinatorResult extends AdminResult {
  /** The app leader row (leaders.id) holding the coordinator rows. */
  leaderId: number;
}

export interface NudgeResults {
  /** One item per assignee with at least one behind entry, sorted by name. */
  leaders: LeaderResult[];
  /**
   * One item per coordinator whose keys match at least one non-excluded queue (lists may be empty), sorted
   * by leaderId. Coordinators whose keys match nothing are left out: they have no whole-queue view.
   */
  coordinators: CoordinatorResult[];
}

interface Active {
  queues: Queue[];
  entries: QueueEntry[];
  behind: QueueEntry[];
}

function activeData(queues: Queue[], entries: QueueEntry[], config: HolyNudgeConfig, now: Date): Active {
  const activeQueues = filterExcludedQueues(queues, config);
  const ids = new Set(activeQueues.map((q) => q.id));
  const active = entries.filter((e) => ids.has(e.queueId));
  return { queues: activeQueues, entries: active, behind: active.filter((e) => isBehind(e, now, config.timeZone)) };
}

function scopeView(a: Active, queueIds: string[]): AdminResult {
  const scope = new Set(queueIds);
  const inScope = (e: QueueEntry) => scope.has(e.queueId);
  const groups = new Map<string, BehindGroup>();
  for (const e of a.behind.filter(inScope)) {
    const key = e.assignee?.id ?? '';
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { leader: e.assignee, entries: [] }));
    g.entries.push(e);
  }
  const behindByLeader = [...groups.values()].sort((x, y) => {
    if (x.leader === null) return 1; // unassigned last
    if (y.leader === null) return -1;
    return x.leader.name.localeCompare(y.leader.name) || x.leader.id.localeCompare(y.leader.id);
  });
  return { queueIds, unassigned: a.entries.filter((e) => inScope(e) && isUnassigned(e)), behindByLeader };
}

/** The staff view: every non-excluded queue. */
export function allQueuesView(queues: Queue[], entries: QueueEntry[], config: HolyNudgeConfig, now: Date): AdminResult {
  const a = activeData(queues, entries, config, now);
  return scopeView(a, a.queues.map((q) => q.id));
}

/**
 * Compute who gets nudged. Excluded queues are removed first; entries in queues not listed in `queues` are
 * ignored. `coordinators` (from queue_coordinators) is the only source of whole-queue scope here; leave it
 * out and nobody gets one. Staff use allQueuesView instead.
 */
export function computeNudges(
  queues: Queue[],
  entries: QueueEntry[],
  config: HolyNudgeConfig,
  now: Date,
  coordinators: readonly CoordinatorScope[] = [],
  /** Ids of excluded queues already dropped from `queues` (Snapshot.excludedQueueIds). */
  reservedIds: readonly string[] = [],
): NudgeResults {
  const a = activeData(queues, entries, config, now);

  // Leaders: group behind entries by assignee id.
  const byLeader = new Map<string, LeaderResult>();
  for (const e of a.behind) {
    if (!e.assignee) continue;
    let r = byLeader.get(e.assignee.id);
    if (!r) byLeader.set(e.assignee.id, (r = { leader: e.assignee, behind: [] }));
    r.behind.push(e);
  }
  const leaders = [...byLeader.values()].sort(
    (x, y) => x.leader.name.localeCompare(y.leader.name) || x.leader.id.localeCompare(y.leader.id),
  );

  // Coordinators: the same leader row listed twice gets the union of its keys.
  const keysByLeader = new Map<number, string[]>();
  for (const c of coordinators) keysByLeader.set(c.leaderId, [...(keysByLeader.get(c.leaderId) ?? []), ...c.queueKeys]);
  const activeIds = new Set(a.queues.map((q) => q.id));
  const out: CoordinatorResult[] = [];
  for (const [leaderId, keys] of [...keysByLeader].sort(([x], [y]) => x - y)) {
    // Resolve against every queue given (so an excluded queue's id cannot fall through to a name match), then
    // keep only the non-excluded ones.
    const queueIds = queueIdsForKeys(queues, keys, reservedIds).filter((id) => activeIds.has(id));
    if (queueIds.length === 0) continue;
    out.push({ leaderId, ...scopeView(a, queueIds) });
  }

  return { leaders, coordinators: out };
}
