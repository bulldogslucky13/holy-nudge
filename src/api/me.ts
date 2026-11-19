// Builds the GET /api/me response (docs/ARCHITECTURE.md "JSON contract").
import { computeNudges, type AdminResult } from '../core/behind';
import { availableLeadPeople } from '../core/match';
import { adminQueueUrl, isLive, queueUrl } from '../core/config';
import { HOUR_MS, createdToInstant, dueToDate, zonedDate } from '../core/time';
import type { HolyNudgeConfig, Queue, QueueEntry, Status } from '../core/types';
import { errorClassName } from '../core/errors';
import type { LeaderRow, Store } from '../db';
import { globalAdminView, peopleSeen, syncLeaders, type Snapshot } from '../job/load';

export interface ItemJson {
  entryId: string;
  queueId: string;
  queueName: string;
  queueUrl: string;
  status: Status;
  due: string | null;
  daysOverdue: number | null;
  /** Name and phone only: email is never sent (the app does not show it). */
  individual: { name: string; phone: string | null };
}

export interface StaleItemJson extends ItemJson {
  hoursWaiting: number;
}

/** One row of the staff link-management list. Never carries a link or token. */
export interface LeaderAdminJson {
  id: number;
  name: string;
  hasLink: boolean;
  lastSeenAt: string | null;
  notificationsOn: boolean;
  /** Staff (is_admin, which includes the owner): sees every queue and manages links. */
  isStaff: boolean;
  /** False for the owner's row unless the viewer is the owner (only the owner rotates or turns off an owner link). */
  canManage: boolean;
  isYou: boolean;
  /** Tied to a Lead (ChMS) person, so once live they see that person's students. The id itself is not sent. */
  matched: boolean;
}

/** A Lead person staff may match a leader to (seen in Lead data, not held by another row in use). */
export interface LeadPersonJson {
  id: string;
  name: string;
}

export interface MeJson {
  leader: { name: string; isAdmin: boolean; notificationsOn: boolean };
  /**
   * True when real church data is connected (config.dataSource is not "fixture"). When false, what
   * staff see is sample data, and everyone else gets an empty `behind` and no `admin` (pre-launch).
   */
  live: boolean;
  behind: ItemJson[];
  admin?: {
    staleUnassigned: StaleItemJson[];
    byLeader: { leader: { name: string } | null; notificationsOn: boolean; items: ItemJson[] }[];
    leadersWithoutNotifications: { name: string }[];
    /** Staff only (leaders flagged is_admin). Implicit queue admins never get this key. */
    leaders?: LeaderAdminJson[];
    /** Staff only, with `leaders`: who a leader can be matched to (POST /api/leader-match). */
    leadPeople?: LeadPersonJson[];
  };
  generatedAt: string;
}

const DAY_MS = 24 * HOUR_MS;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function personalLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/l/${token}`;
}

/** Whether `actor` (staff) may rotate or turn off `target`'s link: an owner's link only by an owner. */
export function canManageLink(actor: Pick<LeaderRow, 'isAdmin' | 'isOwner'>, target: Pick<LeaderRow, 'isOwner'>): boolean {
  return actor.isAdmin && (!target.isOwner || actor.isOwner);
}

export function leaderAdminJson(l: LeaderRow, viewer: LeaderRow): LeaderAdminJson {
  return {
    id: l.id,
    name: l.name,
    hasLink: l.hasLink,
    lastSeenAt: l.lastSeenAt,
    notificationsOn: l.subscriptionCount > 0,
    isStaff: l.isAdmin,
    canManage: canManageLink(viewer, l),
    isYou: l.id === viewer.id,
    matched: l.chmsIndividualId !== null,
  };
}

export interface BuildMeInput {
  config: HolyNudgeConfig;
  snapshot: Snapshot;
  leader: LeaderRow;
  /** All leader rows (only needed for admins; may be just [leader] otherwise). */
  leaders: LeaderRow[];
  now: Date;
}

/** True if this leader gets the admin view (flagged admin, or admin of some queue). */
export function isAdminFor(leader: LeaderRow, config: HolyNudgeConfig, snapshot: Snapshot, now: Date): boolean {
  if (leader.isAdmin) return true;
  if (!leader.chmsIndividualId) return false;
  return computeNudges(snapshot.queues, snapshot.entries, config, now).admins.some((a) => a.adminId === leader.chmsIndividualId);
}

/**
 * Pre-launch: real data is not connected yet and this person is not staff. They must never see (or
 * be nudged about) the made-up sample students, whatever their row happens to map to.
 */
export function isPreLaunchFor(config: Pick<HolyNudgeConfig, 'dataSource'>, leader: Pick<LeaderRow, 'isAdmin'>): boolean {
  return !isLive(config) && !leader.isAdmin;
}

export function buildMe({ config, snapshot, leader, leaders, now }: BuildMeInput): MeJson {
  const generatedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (isPreLaunchFor(config, leader)) {
    // Even if a snapshot was passed in, none of it is used.
    return {
      leader: { name: leader.name, isAdmin: false, notificationsOn: leader.subscriptionCount > 0 },
      live: false,
      behind: [],
      generatedAt,
    };
  }
  const tz = config.timeZone;
  const today = zonedDate(now, tz);
  const queueById = new Map<string, Queue>(snapshot.queues.map((q) => [q.id, q]));

  const item = (e: QueueEntry): ItemJson => {
    const due = e.due === null ? null : dueToDate(e.due, tz);
    const overdue = due !== null && due < today ? daysBetween(due, today) : null;
    return {
      entryId: e.id,
      queueId: e.queueId,
      queueName: queueById.get(e.queueId)?.name ?? '',
      queueUrl: queueUrl(config, e.queueId),
      status: e.status,
      due,
      daysOverdue: overdue,
      individual: { name: e.individual.name, phone: e.individual.phone ?? null },
    };
  };
  /** Admin items link to the queue filtered to that status, across every assignee. */
  const adminItem = (e: QueueEntry): ItemJson => ({ ...item(e), queueUrl: adminQueueUrl(config, e.queueId, e.status) });
  const byUrgency = (a: ItemJson, b: ItemJson) =>
    (b.daysOverdue ?? -1) - (a.daysOverdue ?? -1) || a.queueName.localeCompare(b.queueName) || a.entryId.localeCompare(b.entryId);

  const nudges = computeNudges(snapshot.queues, snapshot.entries, config, now);
  const mine = leader.chmsIndividualId ? nudges.leaders.find((l) => l.leader.id === leader.chmsIndividualId) : undefined;

  let adminView: AdminResult | undefined;
  if (leader.isAdmin) adminView = globalAdminView(snapshot, config, now);
  else if (leader.chmsIndividualId) adminView = nudges.admins.find((a) => a.adminId === leader.chmsIndividualId);

  const out: MeJson = {
    leader: { name: leader.name, isAdmin: adminView !== undefined, notificationsOn: leader.subscriptionCount > 0 },
    live: isLive(config),
    behind: (mine?.behind ?? []).map(item).sort(byUrgency),
    generatedAt,
  };

  if (adminView) {
    const rowByChms = new Map(leaders.filter((l) => l.chmsIndividualId).map((l) => [l.chmsIndividualId!, l]));
    const notificationsOn = (chmsId: string) => (rowByChms.get(chmsId)?.subscriptionCount ?? 0) > 0;
    const scope = new Set(adminView.queueIds);

    // Leaders in scope: everyone assigned to someone in the admin's queues.
    const scopeLeaders = new Map<string, string>();
    for (const e of snapshot.entries) if (e.assignee && scope.has(e.queueId)) scopeLeaders.set(e.assignee.id, e.assignee.name);
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

    out.admin = {
      staleUnassigned: adminView.staleUnassigned
        .map((e) => ({ ...adminItem(e), hoursWaiting: Math.floor((now.getTime() - createdToInstant(e.created, tz)) / HOUR_MS) }))
        .sort((a, b) => b.hoursWaiting - a.hoursWaiting || a.entryId.localeCompare(b.entryId)),
      byLeader: adminView.behindByLeader.map((g) => ({
        leader: g.leader ? { name: g.leader.name } : null,
        notificationsOn: g.leader ? notificationsOn(g.leader.id) : false,
        items: g.entries.map(adminItem).sort(byUrgency),
      })),
      leadersWithoutNotifications: [...scopeLeaders]
        .filter(([id]) => !notificationsOn(id))
        .map(([, name]) => ({ name }))
        .sort(byName),
    };
    // Link management is for staff (is_admin) only, never for implicit queue-manager admins.
    if (leader.isAdmin) {
      out.admin.leaders = leaders.map((l) => leaderAdminJson(l, leader)).sort(byName);
      out.admin.leadPeople = availableLeadPeople(leaders, peopleSeen(snapshot));
    }
  }
  return out;
}

export interface ResolveMeInput {
  store: Pick<Store, 'upsertLeaders' | 'listLeaders' | 'applyMatches'>;
  config: HolyNudgeConfig;
  leader: LeaderRow;
  now: Date;
  /** Reads the data source. Never called for a pre-launch (non-staff, not live) caller. */
  loadSnapshot: () => Promise<Snapshot>;
}

export type ResolveMeResult = { ok: true; me: MeJson } | { ok: false; errorName: string };

/** The whole GET /api/me after authentication and rate limiting: load what is needed, then build the response. */
export async function resolveMe({ store, config, leader, now, loadSnapshot }: ResolveMeInput): Promise<ResolveMeResult> {
  if (isPreLaunchFor(config, leader)) {
    // No snapshot, no leader list: nothing from the data source is read for this person.
    return { ok: true, me: buildMe({ config, snapshot: { queues: [], entries: [] }, leader, leaders: [leader], now }) };
  }
  let snapshot: Snapshot;
  try {
    snapshot = await loadSnapshot();
  } catch (err) {
    return { ok: false, errorName: errorClassName(err) };
  }

  let leaders = [leader];
  if (leader.isAdmin) {
    // Staff manage everyone's link: make sure every leader in ChMS has a row (with no link yet)
    // even before the first daily run, and tie leaders added by name to their Lead person where certain.
    await syncLeaders(store, peopleSeen(snapshot));
    leaders = await store.listLeaders();
    // The sync may have just matched the caller's own row: use the refreshed row, or "Mine" would be
    // built from the stale, unmatched one and show nothing until the next request.
    leader = leaders.find((l) => l.id === leader.id) ?? leader;
  } else if (isAdminFor(leader, config, snapshot, now)) {
    // Queue-manager admins see notification status for their leaders; no link features.
    leaders = await store.listLeaders();
  }
  return { ok: true, me: buildMe({ config, snapshot, leader, leaders, now }) };
}
