// Builds the GET /api/me response (docs/ARCHITECTURE.md "JSON contract").
import { computeNudges, type AdminResult } from '../core/behind';
import { adminQueueUrl, queueUrl } from '../core/config';
import { HOUR_MS, createdToInstant, dueToDate, zonedDate } from '../core/time';
import type { HolyNudgeConfig, Queue, QueueEntry, Status } from '../core/types';
import type { LeaderRow } from '../db';
import { globalAdminView, type Snapshot } from '../job/load';

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
  /** False for the owner's row unless the viewer is the owner (only the owner rotates or turns off an owner link). */
  canManage: boolean;
  isYou: boolean;
}

export interface MeJson {
  leader: { name: string; isAdmin: boolean; notificationsOn: boolean };
  behind: ItemJson[];
  admin?: {
    staleUnassigned: StaleItemJson[];
    byLeader: { leader: { name: string } | null; notificationsOn: boolean; items: ItemJson[] }[];
    leadersWithoutNotifications: { name: string }[];
    /** Staff only (leaders flagged is_admin). Implicit queue admins never get this key. */
    leaders?: LeaderAdminJson[];
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
    canManage: canManageLink(viewer, l),
    isYou: l.id === viewer.id,
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

export function buildMe({ config, snapshot, leader, leaders, now }: BuildMeInput): MeJson {
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
    behind: (mine?.behind ?? []).map(item).sort(byUrgency),
    generatedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
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
    if (leader.isAdmin) out.admin.leaders = leaders.map((l) => leaderAdminJson(l, leader)).sort(byName);
  }
  return out;
}
