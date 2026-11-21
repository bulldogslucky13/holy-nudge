// The daily job: load -> sync and match leader rows -> compute behind -> decide who is due a push this
// morning (something new or overdue) -> one push per person -> record the run.
import { ChmsNotConfiguredError } from '../chms/oauth';
import { IncompleteDataError } from '../chms/pushpay';
import { ReauthorizationRequired, TokenPersistError } from '../chms/tokens';
import { computeNudges, FIRST_RUN_LOOKBACK_MS, isNewSinceLastRun, isOverdue, isPastFirstText, ownTriggered, summaryTriggered, type RunWindow } from '../core/behind';
import { isLive } from '../core/config';
import { HOUR_MS } from '../core/time';
import { errorClassName } from '../core/errors';
import type { DataSource, HolyNudgeConfig } from '../core/types';
import type { JobRunSummary, Store } from '../db';
import { addCounts, deliverToLeader, emptyCounts, type DeliveryCounts } from '../push/deliver';
import { adminPayload, alertPayload, combinedPayload, leaderPayload, type AlertReason } from '../push/payload';
import type { PushSender } from '../push/sender';
import { adminCounts, coordinatorScopes, globalAdminView, loadSnapshot, peopleSeen, syncLeaders, type Snapshot } from './load';

/** Local wall-clock hour (0-23) of an instant in an IANA zone. */
export function localHour(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(now)
    .find((p) => p.type === 'hour')?.value;
  return Number(h) % 24;
}

export interface JobDeps {
  config: HolyNudgeConfig;
  store: Store;
  sender: PushSender;
  /** Called inside the failure boundary, so a factory that throws counts as a data-source failure. */
  dataSource: () => DataSource;
  now: Date;
  /** Skip the morning-hour gate. */
  force?: boolean;
}

export type JobOutcome = { ran: false; reason: 'outside_morning_hour'; localHour: number } | { ran: true; summary: JobRunSummary };

/**
 * The job failed (run recorded, owners alerted). Carries only the stage, the alert reason and the
 * underlying error's CLASS NAME: never its message or the error itself, because upstream messages can
 * echo ChMS values. Deliberately no `cause`, so a runtime that prints cause chains has nothing to print.
 */
export class JobFailedError extends Error {
  readonly reason: AlertReason;
  readonly errorName: string;
  constructor(
    readonly stage: 'datasource' | 'job',
    cause: unknown,
  ) {
    const reason = alertReason(stage, cause);
    const errorName = errorClassName(cause);
    super(`Holy Nudge daily job failed at ${stage} (${reason}, ${errorName})`);
    this.name = 'JobFailedError';
    this.reason = reason;
    this.errorName = errorName;
  }
}

export { errorClassName };

/**
 * The one log line for a failed run: stage, reason and error class only. Anything that is not a
 * JobFailedError (failure before the run was recorded, e.g. missing VAPID keys) gets its class name only.
 */
export function describeFailure(err: unknown): string {
  if (err instanceof JobFailedError) return `holy-nudge job failed: stage=${err.stage} reason=${err.reason} error=${err.errorName}`;
  return `holy-nudge job failed before the run was recorded: error=${errorClassName(err)}`;
}

export async function runDailyJob(deps: JobDeps): Promise<JobOutcome> {
  const { config, store, sender, now } = deps;
  const hour = localHour(now, config.timeZone);
  if (!deps.force && hour !== config.morningHour) return { ran: false, reason: 'outside_morning_hour', localHour: hour };

  const runId = await store.startJobRun(now);
  let stage: 'datasource' | 'job' = 'datasource';
  try {
    const snapshot: Snapshot = await loadSnapshot(deps.dataSource(), config);
    stage = 'job';

    const people = peopleSeen(snapshot);
    // On sample data the people seen are invented: they get no leader rows (docs/DECISIONS.md, 22).
    const leadersMatched = isLive(config) ? await syncLeaders(store, people) : 0;
    const rows = await store.listLeaders();
    const byChms = new Map(rows.filter((r) => r.chmsIndividualId).map((r) => [r.chmsIndividualId!, r]));

    // "New" means entered a queue after the start of the last successful daily run (this run is still
    // ok = 0, so it is not that run). Only a timestamp of our own run: nothing about any student is kept.
    const window: RunWindow = { now, lastRunAt: await store.lastSuccessfulRunStart() };
    // A push that was due at the last run but reached none of that person's devices must not use up their
    // "new" window: for them alone, look back to where that window started. Carried in the run summary as
    // leader row id -> instant (our own ids and run times, nothing about a student). A hold older than
    // followUpDays is dropped: by then the overdue rule nudges anyway.
    const heldFrom = await store.lastRunRetryFrom();
    const retryFrom: Record<string, string> = {};
    const windowFor = (rowId: number): RunWindow => {
      const t = Date.parse(heldFrom[String(rowId)] ?? '');
      if (Number.isNaN(t) || now.getTime() - t > config.followUpDays * 24 * HOUR_MS) return window;
      return window.lastRunAt !== null && window.lastRunAt.getTime() <= t ? window : { now, lastRunAt: new Date(t) };
    };

    // Whole-queue summaries go only to staff and to rows marked as coordinators (queue_coordinators).
    const nudges = computeNudges(snapshot.queues, snapshot.entries, config, now, coordinatorScopes(rows), snapshot.excludedQueueIds);
    let delivery: DeliveryCounts = emptyCounts();
    /** People told about their own students (alone or in a combined push). */
    let leadersNudged = 0;
    /** People told about a queue summary (alone or in a combined push). */
    let adminsNudged = 0;
    /** People whose own count and summary went out as one push. */
    let combinedNudged = 0;
    /** People with something waiting whose own students include one new or overdue (push due on that account). */
    let ownTriggeredPeople = 0;
    /** People with a summary that includes a new or 72-hour unassigned student, or an overdue assigned one. */
    let summaryTriggeredPeople = 0;
    /** People with something waiting but nothing new or overdue this morning: no push. */
    let skippedNothingNewOrOverdue = 0;
    /** People whose push was due but reached none of their devices (temporary failure): retried next run. */
    let undelivered = 0;

    // Until real data is connected, everything computed above is about made-up sample students. Only the
    // owner may be nudged about it (docs/DECISIONS.md, 22): other staff, coordinators and volunteers must
    // never get "3 students are waiting on you" about invented people. Everyone is nudged once live.
    const live = isLive(config);
    const mayNudge = (row: { isOwner: boolean }) => live || row.isOwner;

    // Their own students waiting, per leader row, and whether any of them is due a push this morning.
    const own = new Map<number, { count: number; fires: boolean }>();
    type SummaryView = Parameters<typeof summaryTriggered>[0];
    for (const l of nudges.leaders) {
      const row = byChms.get(l.leader.id);
      if (!row || l.behind.length === 0) continue;
      if (!mayNudge(row)) continue;
      own.set(row.id, { count: l.behind.length, fires: ownTriggered(l.behind, windowFor(row.id), config) });
    }

    // Summaries: is_admin rows get the whole process; coordinators get the queues they coordinate. Keyed by
    // leader row, so a coordinator not yet matched to Lead still gets theirs. A Lead queue manager gets none.
    const summaries = new Map<number, { counts: ReturnType<typeof adminCounts>; view: SummaryView }>();
    const globalView = globalAdminView(snapshot, config, now);
    const globalCounts = adminCounts(globalView);
    const global = { counts: globalCounts, view: globalView };
    for (const row of rows) if (row.isAdmin && mayNudge(row)) summaries.set(row.id, global);
    const rowById = new Map(rows.map((r) => [r.id, r]));
    for (const a of nudges.coordinators) {
      const row = rowById.get(a.leaderId);
      if (!row || summaries.has(row.id)) continue;
      if (!mayNudge(row)) continue;
      summaries.set(row.id, { counts: adminCounts(a), view: a });
    }

    // One push per person per morning: their own count, their summary, or both in one. It goes out only
    // when their own students or their summary has something new or overdue, and then always carries the
    // full counts (everything waiting), exactly as the app shows them.
    for (const row of rows) {
      const mineOwn = own.get(row.id);
      const summary = summaries.get(row.id);
      const mine = mineOwn?.count ?? 0;
      const counts = summary?.counts;
      const waiting = counts?.waiting ?? 0; // a summary with nothing waiting is not worth a push
      if (mine === 0 && waiting === 0) continue;
      const ownFires = mine > 0 && mineOwn!.fires;
      const summaryFires = waiting > 0 && summaryTriggered(summary!.view, windowFor(row.id), config);
      if (ownFires) ownTriggeredPeople++;
      if (summaryFires) summaryTriggeredPeople++;
      if (!ownFires && !summaryFires) {
        skippedNothingNewOrOverdue++;
        continue;
      }
      const payload =
        mine > 0 && waiting > 0
          ? combinedPayload(mine, waiting, counts!.unassigned, row.isAdmin ? 'all' : 'yours')
          : mine > 0
            ? leaderPayload(mine)
            : adminPayload(waiting, counts!.leaders, counts!.unassigned);
      const r = await deliverToLeader(store, sender, row.id, payload, now);
      delivery = addCounts(delivery, r);
      // Due, but every device failed for now (not gone): keep this person's window open for the next run.
      if (r.sent === 0 && r.failed > 0) {
        const from = windowFor(row.id).lastRunAt ?? new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
        retryFrom[String(row.id)] = from.toISOString();
        undelivered++;
      }
      if (r.sent === 0) continue;
      if (mine > 0) leadersNudged++;
      if (waiting > 0) adminsNudged++;
      if (mine > 0 && waiting > 0) combinedNudged++;
    }

    const summary: JobRunSummary = {
      forced: !!deps.force,
      queues: snapshot.queues.length,
      entries: snapshot.entries.length,
      leadersSeen: people.length,
      leadersMatched,
      leadersBehind: nudges.leaders.length,
      behind: nudges.leaders.reduce((n, l) => n + l.behind.length, 0),
      unassignedWaiting: globalCounts.unassigned,
      ...triggerCounts(globalView, window, config),
      firstRunFallback: window.lastRunAt === null,
      ownTriggered: ownTriggeredPeople,
      summaryTriggered: summaryTriggeredPeople,
      skippedNothingNewOrOverdue,
      leadersNudged,
      adminsNudged,
      combinedNudged,
      pushesSent: delivery.sent,
      pushesFailed: delivery.failed,
      subscriptionsRemoved: delivery.removed,
      undelivered,
      retryFrom,
    };
    await store.finishJobRun(runId, true, summary, new Date());
    return { ran: true, summary };
  } catch (err) {
    // Stage, reason and error class only: messages could echo API data.
    const failed = new JobFailedError(stage, err);
    await store
      .finishJobRun(runId, false, { stage, reason: failed.reason, error: failed.errorName }, new Date())
      .catch(() => undefined);
    await alertOwners(store, sender, failed.reason, now).catch(() => undefined);
    throw failed;
  }
}

/**
 * Students (counts only) behind this morning's triggers across every non-excluded queue: assigned and new
 * (Not Started), unassigned and new, assigned and overdue, unassigned past the first-text window.
 */
function triggerCounts(view: ReturnType<typeof globalAdminView>, w: RunWindow, config: HolyNudgeConfig) {
  const tz = config.timeZone;
  const assigned = view.behindByLeader.filter((g) => g.leader !== null).flatMap((g) => g.entries);
  return {
    newAssigned: assigned.filter((e) => e.status === 'NOT_STARTED' && isNewSinceLastRun(e, w, tz)).length,
    newUnassigned: view.unassigned.filter((e) => isNewSinceLastRun(e, w, tz)).length,
    overdueAssigned: assigned.filter((e) => isOverdue(e, w.now, config)).length,
    unassignedPastFirstText: view.unassigned.filter((e) => isPastFirstText(e, w.now, config)).length,
  };
}

/** Map a failure to the owner alert it deserves. Re-approval gets its own message. */
export function alertReason(stage: 'datasource' | 'job', err: unknown): AlertReason {
  // A lost connection needs the same fix wherever it surfaces.
  if (err instanceof ReauthorizationRequired || err instanceof TokenPersistError) return 'reauth';
  if (stage === 'job') return 'job';
  if (err instanceof ChmsNotConfiguredError) return 'not_configured';
  if (err instanceof IncompleteDataError) return 'incomplete';
  return 'datasource'; // ChmsApiError, ChmsDataError, TokenRefreshError, EmptyProcessError, anything else
}

async function alertOwners(store: Store, sender: PushSender, reason: AlertReason, now: Date): Promise<void> {
  for (const row of await store.listLeaders()) {
    if (row.isOwner) await deliverToLeader(store, sender, row.id, alertPayload(reason), now);
  }
}
