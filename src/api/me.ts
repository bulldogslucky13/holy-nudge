// Builds the GET /api/me response (docs/ARCHITECTURE.md "JSON contract").
import { computeNudges, queueIdsForKeys, type AdminResult } from '../core/behind';
import { availableLeadPeople } from '../core/match';
import { adminQueueUrl, individualUrl, isLive, leaderAccess, queueUrl } from '../core/config';
import { HOUR_MS, createdToInstant, dueToDate, zonedDate } from '../core/time';
import type { HolyNudgeConfig, Queue, QueueEntry, Status } from '../core/types';
import { errorClassName } from '../core/errors';
import type { LeaderRow, Store } from '../db';
import { coordinatorScopes, globalAdminView, peopleSeen, syncLeaders, type Snapshot } from '../job/load';

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

export interface UnassignedItemJson extends ItemJson {
  /** Whole hours since `created` (0 for a date-only `created` of today). */
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
  /** Tied to a Lead (ChMS) person, so once live they see that person's students. No bare id field is sent. */
  matched: boolean;
  /**
   * That person's Lead profile URL (it contains their Lead id: a deliberate, narrow exception, docs/DECISIONS.md, 26).
   * Present only when matched and real data is on; absent otherwise. Staff only, since only staff get `leaders`.
   */
  leadUrl?: string;
  /**
   * Names of the (non-excluded) queues this row coordinates, i.e. the whole queues they see, in queue order.
   * Keys that match no queue in the current data are left out: they grant nothing. Read-only.
   */
  coordinates: string[];
}

/** A Lead person staff may match a leader to (seen in Lead data, not held by another row in use). */
export interface LeadPersonJson {
  id: string;
  name: string;
}

export interface MeJson {
  leader: { name: string; isAdmin: boolean; notificationsOn: boolean };
  /**
   * True when real church data is connected (config.dataSource is not "fixture") and this person may see
   * it. When false, what staff see is sample data, and anyone who may not see data yet (non-staff on
   * sample data, or non-staff while real data is released to staff only) gets an empty `behind`, no
   * `admin` and `live: false` (pre-launch).
   */
  live: boolean;
  behind: ItemJson[];
  admin?: {
    /** Every unassigned, not-Done student in the admin's queues, longest waiting first. */
    unassigned: UnassignedItemJson[];
    byLeader: { leader: { name: string } | null; notificationsOn: boolean; items: ItemJson[] }[];
    leadersWithoutNotifications: { name: string }[];
    /** Staff only (leaders flagged is_admin). Coordinators never get this key. */
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

export function leaderAdminJson(
  l: LeaderRow,
  viewer: LeaderRow,
  config: HolyNudgeConfig,
  queues: readonly Queue[] = [],
  reservedIds: readonly string[] = [],
): LeaderAdminJson {
  const names = new Map(queues.map((q) => [q.id, q.name]));
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
    ...(l.chmsIndividualId !== null && isLive(config) ? { leadUrl: individualUrl(config, l.chmsIndividualId) } : {}),
    coordinates: queueIdsForKeys(queues, l.coordinatorOf, reservedIds).map((id) => names.get(id)!),
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

/**
 * The coordinator view for this leader row: the non-excluded queues its queue_coordinators keys name, or
 * undefined when they name none. Attached to the row, not to a Lead id, so it works before matching.
 * Being a Lead queue manager counts for nothing here.
 */
export function coordinatorView(leader: LeaderRow, config: HolyNudgeConfig, snapshot: Snapshot, now: Date): AdminResult | undefined {
  if (leader.coordinatorOf.length === 0) return undefined;
  return computeNudges(snapshot.queues, snapshot.entries, config, now, coordinatorScopes([leader]), snapshot.excludedQueueIds).coordinators[0];
}

/** True if this leader gets a whole-queue view: staff (is_admin), or a coordinator of some current queue. */
export function isAdminFor(leader: LeaderRow, config: HolyNudgeConfig, snapshot: Snapshot, now: Date): boolean {
  return leader.isAdmin || coordinatorView(leader, config, snapshot, now) !== undefined;
}

/**
 * Pre-launch for this person: they may not see data yet (sample data and not staff, or real data released
 * to staff only and they are not staff). They must never see, or be nudged about, students, whatever
 * their row happens to map to. See `leaderAccess`.
 */
export function isPreLaunchFor(config: Pick<HolyNudgeConfig, 'dataSource' | 'audience'>, leader: Pick<LeaderRow, 'isAdmin' | 'isOwner'>): boolean {
  return !leaderAccess(config, leader).seesData;
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

  const adminView: AdminResult | undefined = leader.isAdmin ? globalAdminView(snapshot, config, now) : coordinatorView(leader, config, snapshot, now);

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
      unassigned: adminView.unassigned
        // A date-only `created` counts from the end of its day, so today's arrivals would be negative.
        .map((e) => ({ ...adminItem(e), hoursWaiting: Math.max(0, Math.floor((now.getTime() - createdToInstant(e.created, tz)) / HOUR_MS)) }))
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
    // Link management is for staff (is_admin) only, never for coordinators.
    if (leader.isAdmin) {
      out.admin.leaders = leaders.map((l) => leaderAdminJson(l, leader, config, snapshot.queues, snapshot.excludedQueueIds)).sort(byName);
      // Empty on sample data: its people are invented and have no rows, so offering them would only fail (docs/DECISIONS.md, 22).
      out.admin.leadPeople = isLive(config) ? availableLeadPeople(leaders, peopleSeen(snapshot)) : [];
    }
  }
  return out;
}

export interface ResolveMeInput {
  store: Pick<Store, 'upsertLeaders' | 'listLeaders' | 'applyMatches'>;
  config: HolyNudgeConfig;
  leader: LeaderRow;
  now: Date;
  /** Reads the data source. Never called for a pre-launch caller (one who may not see data yet). */
  loadSnapshot: () => Promise<Snapshot>;
  /**
   * Phone lookups for the viewer's own students ("Mine") only, in the order shown; the data source
   * caps how many (MAX_PHONE_LOOKUPS). Never used for whole-queue views: those cards have no phone.
   */
  loadPhones?: (individualIds: string[]) => Promise<Map<string, string>>;
}

export type ResolveMeResult = { ok: true; me: MeJson } | { ok: false; errorName: string };

/** The whole GET /api/me after authentication and rate limiting: load what is needed, then build the response. */
export async function resolveMe({ store, config, leader, now, loadSnapshot, loadPhones }: ResolveMeInput): Promise<ResolveMeResult> {
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
    // Not on sample data: its people are invented and must not become leader rows (docs/DECISIONS.md, 22).
    if (isLive(config)) await syncLeaders(store, peopleSeen(snapshot));
    leaders = await store.listLeaders();
    // The sync may have just matched the caller's own row: use the refreshed row, or "Mine" would be
    // built from the stale, unmatched one and show nothing until the next request.
    leader = leaders.find((l) => l.id === leader.id) ?? leader;
  } else if (isAdminFor(leader, config, snapshot, now)) {
    // Coordinators see notification status for the leaders in their queues; no link features.
    leaders = await store.listLeaders();
  }
  const me = buildMe({ config, snapshot, leader, leaders, now });
  if (loadPhones && me.behind.length > 0) await addOwnPhones(me, snapshot, loadPhones);
  return { ok: true, me };
}

/**
 * Fill in phone numbers on the viewer's own list (`behind`) only, where the snapshot has none (Lead
 * sends no phones with queue rows). Whole-queue items are never touched, even for the same student.
 * A failed lookup leaves the card without a phone; it never fails the page.
 */
async function addOwnPhones(me: MeJson, snapshot: Snapshot, loadPhones: (ids: string[]) => Promise<Map<string, string>>): Promise<void> {
  const entryById = new Map(snapshot.entries.map((e) => [e.id, e]));
  const individualOf = new Map<ItemJson, string>();
  for (const item of me.behind) {
    const e = entryById.get(item.entryId);
    if (e && e.status !== 'DONE' && !item.individual.phone) individualOf.set(item, e.individual.id);
  }
  if (individualOf.size === 0) return;
  let phones: Map<string, string>;
  try {
    phones = await loadPhones([...new Set(individualOf.values())]);
  } catch {
    return;
  }
  // New objects, so nothing shared with whole-queue items can pick up the number.
  me.behind = me.behind.map((item) => {
    const id = individualOf.get(item);
    const phone = id === undefined ? undefined : phones.get(id);
    return phone ? { ...item, individual: { name: item.individual.name, phone } } : item;
  });
}
