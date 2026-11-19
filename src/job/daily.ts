// The daily job: load -> compute behind -> push leaders and admins -> record the run.
import { ChmsNotConfiguredError } from '../chms/oauth';
import { IncompleteDataError } from '../chms/pushpay';
import { ReauthorizationRequired, TokenPersistError } from '../chms/tokens';
import { computeNudges } from '../core/behind';
import { isLive } from '../core/config';
import { errorClassName } from '../core/errors';
import type { DataSource, HolyNudgeConfig } from '../core/types';
import type { JobRunSummary, LeaderRow, Store } from '../db';
import { addCounts, deliverToLeader, emptyCounts, type DeliveryCounts } from '../push/deliver';
import { adminPayload, alertPayload, leaderPayload, type AlertReason } from '../push/payload';
import type { PushSender } from '../push/sender';
import { adminCounts, globalAdminView, loadSnapshot, peopleSeen, type Snapshot } from './load';

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
    await store.upsertLeaders(people);
    const rows = await store.listLeaders();
    const byChms = new Map(rows.filter((r) => r.chmsIndividualId).map((r) => [r.chmsIndividualId!, r]));

    const nudges = computeNudges(snapshot.queues, snapshot.entries, config, now);
    let delivery: DeliveryCounts = emptyCounts();
    let leadersNudged = 0;
    let adminsNudged = 0;

    // Until real data is connected, everything computed above is about made-up sample students. Only
    // staff (is_admin) may be nudged about it; a real volunteer whose row happens to map to a sample
    // leader or queue manager must never get "3 students are waiting on you".
    const live = isLive(config);

    for (const l of nudges.leaders) {
      const row = byChms.get(l.leader.id);
      if (!row || l.behind.length === 0) continue;
      if (!live && !row.isAdmin) continue;
      const r = await deliverToLeader(store, sender, row.id, leaderPayload(l.behind.length), now);
      delivery = addCounts(delivery, r);
      if (r.sent > 0) leadersNudged++;
    }

    // Admin summaries: is_admin rows get the whole process; other queue admins get their queues.
    const summaries = new Map<number, { row: LeaderRow; counts: ReturnType<typeof adminCounts> }>();
    const globalCounts = adminCounts(globalAdminView(snapshot, config, now));
    for (const row of rows) if (row.isAdmin) summaries.set(row.id, { row, counts: globalCounts });
    for (const a of nudges.admins) {
      const row = byChms.get(a.adminId);
      if (!row || summaries.has(row.id)) continue;
      if (!live && !row.isAdmin) continue;
      summaries.set(row.id, { row, counts: adminCounts(a) });
    }
    for (const { row, counts } of summaries.values()) {
      if (counts.waiting === 0) continue; // nothing to nudge about
      const r = await deliverToLeader(store, sender, row.id, adminPayload(counts.waiting, counts.leaders, counts.unassigned), now);
      delivery = addCounts(delivery, r);
      if (r.sent > 0) adminsNudged++;
    }

    const summary: JobRunSummary = {
      forced: !!deps.force,
      queues: snapshot.queues.length,
      entries: snapshot.entries.length,
      leadersSeen: people.length,
      leadersBehind: nudges.leaders.length,
      behind: nudges.leaders.reduce((n, l) => n + l.behind.length, 0),
      unassignedWaiting: globalCounts.unassigned,
      leadersNudged,
      adminsNudged,
      pushesSent: delivery.sent,
      pushesFailed: delivery.failed,
      subscriptionsRemoved: delivery.removed,
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
