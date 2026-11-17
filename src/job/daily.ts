// The daily job: load -> compute behind -> push leaders and admins -> record the run.
import { computeNudges } from '../core/behind';
import type { DataSource, HolyNudgeConfig } from '../core/types';
import type { JobRunSummary, LeaderRow, Store } from '../db';
import { addCounts, deliverToLeader, emptyCounts, type DeliveryCounts } from '../push/deliver';
import { adminPayload, alertPayload, leaderPayload } from '../push/payload';
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

export class JobFailedError extends Error {
  constructor(
    readonly stage: 'datasource' | 'job',
    cause: unknown,
  ) {
    super(`Holy Nudge daily job failed at ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'JobFailedError';
  }
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

    for (const l of nudges.leaders) {
      const row = byChms.get(l.leader.id);
      if (!row || l.behind.length === 0) continue;
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
      if (row && !summaries.has(row.id)) summaries.set(row.id, { row, counts: adminCounts(a) });
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
    // Counts and error class only: messages could echo API data.
    const errorName = err instanceof Error ? err.name : 'unknown';
    await store.finishJobRun(runId, false, { stage, error: errorName }, new Date()).catch(() => undefined);
    await alertOwners(store, sender, stage, now).catch(() => undefined);
    throw new JobFailedError(stage, err);
  }
}

async function alertOwners(store: Store, sender: PushSender, stage: 'datasource' | 'job', now: Date): Promise<void> {
  for (const row of await store.listLeaders()) {
    if (row.isOwner) await deliverToLeader(store, sender, row.id, alertPayload(stage), now);
  }
}
