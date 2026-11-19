// Staff link management: mint a fresh personal link, or turn one off.
// Only leaders flagged is_admin ("staff") may do this; queue coordinators may not.
// An owner's link can be rotated or turned off only by an owner. Nobody can turn off their own link
// from the app (that would lock them out); they can rotate it instead.
import { holdsLeadPerson } from '../core/match';
import type { LeaderRow, Store } from '../db';
import { generateToken, hashToken } from '../db';
import { canManageLink, personalLink } from './me';

export type LinkError = 'forbidden' | 'not_found' | 'owner_protected' | 'cannot_revoke_self';

export type LinkStore = Pick<Store, 'leaderById' | 'setLinkTokenHash' | 'revokeLink'>;

async function check(store: Pick<Store, 'leaderById'>, actor: LeaderRow, leaderId: unknown): Promise<{ target: LeaderRow } | { error: LinkError }> {
  if (!actor.isAdmin) return { error: 'forbidden' };
  if (typeof leaderId !== 'number' || !Number.isSafeInteger(leaderId) || leaderId <= 0) return { error: 'not_found' };
  const target = await store.leaderById(leaderId);
  if (!target) return { error: 'not_found' };
  if (!canManageLink(actor, target)) return { error: 'owner_protected' };
  return { target };
}

/**
 * Generate a new 32-byte token, store only its hash (replacing the previous link and clearing
 * revoked_at) and return the URL. This is the only time the URL exists anywhere.
 */
export async function mintLink(
  store: LinkStore,
  actor: LeaderRow,
  leaderId: unknown,
  baseUrl: string,
): Promise<{ url: string; self: boolean } | { error: LinkError }> {
  const c = await check(store, actor, leaderId);
  if ('error' in c) return c;
  const token = generateToken();
  if (!(await store.setLinkTokenHash(c.target.id, await hashToken(token)))) return { error: 'not_found' };
  return { url: personalLink(baseUrl, token), self: c.target.id === actor.id };
}

/** Turn the link off (401 from then on) and delete that leader's push subscriptions. */
export async function revokeLink(
  store: LinkStore,
  actor: LeaderRow,
  leaderId: unknown,
  now: Date,
): Promise<{ ok: true } | { error: LinkError }> {
  const c = await check(store, actor, leaderId);
  if ('error' in c) return c;
  if (c.target.id === actor.id) return { error: 'cannot_revoke_self' };
  if (!(await store.revokeLink(c.target.id, now))) return { error: 'not_found' };
  return { ok: true };
}

export type LeaderRole = 'leader' | 'staff';

export type AddLeaderError = 'forbidden' | 'invalid_role' | 'name_required' | 'name_too_short' | 'name_too_long' | 'invalid_name' | 'name_taken';

export const NAME_MIN = 2;
export const NAME_MAX = 60;

// C0/C1 controls (tabs and newlines included), line/paragraph separators, zero-width and bidi-control characters.
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/** Trim, collapse inner whitespace, NFC. Returns the cleaned name or the reason it is not acceptable. */
export function cleanLeaderName(input: unknown): { name: string } | { error: Exclude<AddLeaderError, 'forbidden' | 'invalid_role' | 'name_taken'> } {
  if (typeof input !== 'string') return { error: 'name_required' };
  if (BAD_NAME_CHARS.test(input)) return { error: 'invalid_name' };
  const name = input.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (name === '') return { error: 'name_required' };
  const length = Array.from(name).length;
  if (length < NAME_MIN) return { error: 'name_too_short' };
  if (length > NAME_MAX) return { error: 'name_too_long' };
  return { name };
}

/** `undefined` (omitted) means a servant leader; anything but "leader" or "staff" is refused. */
export function parseRole(input: unknown): LeaderRole | null {
  if (input === undefined) return 'leader';
  return input === 'leader' || input === 'staff' ? input : null;
}

/**
 * Staff add a person who is not in ChMS yet: a leader row with no ChMS id and a fresh personal link, either a
 * servant leader (default) or staff (same permissions as any staff member). Only the staff check, the name and
 * the role come from the caller; nothing in the request can make an owner or set a ChMS id. The URL exists
 * only in the returned value.
 */
export async function addLeader(
  store: Pick<Store, 'listLeaders' | 'createLeader'>,
  actor: Pick<LeaderRow, 'isAdmin'>,
  rawName: unknown,
  rawRole: unknown,
  baseUrl: string,
): Promise<{ url: string; leader: { id: number; name: string; role: LeaderRole } } | { error: AddLeaderError }> {
  if (!actor.isAdmin) return { error: 'forbidden' };
  const role = parseRole(rawRole);
  if (role === null) return { error: 'invalid_role' };
  const c = cleanLeaderName(rawName);
  if ('error' in c) return c;
  const lower = c.name.toLowerCase();
  // Unicode-aware duplicate check here; the insert itself also refuses (ASCII-case) duplicates atomically.
  if ((await store.listLeaders()).some((l) => l.name.toLowerCase() === lower)) return { error: 'name_taken' };
  const token = generateToken();
  const id = await store.createLeader(c.name, await hashToken(token), role === 'staff');
  if (id === null) return { error: 'name_taken' };
  return { url: personalLink(baseUrl, token), leader: { id, name: c.name, role } };
}

export const ADD_LEADER_ERROR_STATUS: Record<AddLeaderError, number> = {
  forbidden: 403,
  invalid_role: 400,
  name_required: 400,
  name_too_short: 400,
  name_too_long: 400,
  invalid_name: 400,
  name_taken: 409,
};

export const LINK_ERROR_STATUS: Record<LinkError, number> = {
  forbidden: 403,
  owner_protected: 403,
  cannot_revoke_self: 400,
  not_found: 404,
};

export type MatchError = LinkError | 'no_link' | 'invalid_person' | 'unknown_person' | 'person_taken';

const CHMS_ID_MAX = 64;

/**
 * Staff tie a leader to a Lead (ChMS) person by hand, or clear the tie (`chmsId` null). Either way the row is
 * marked as decided by hand, so automatic name matching never changes it again; the link, devices, role and
 * last-seen stay as they are. Same staff check and owner protection as the link routes. Only rows with a
 * working link can be matched (rows without one are Lead people's own automatic rows).
 *
 * The Lead person must already have a leader row (staff page views and the daily job create one for every
 * person seen), and that row must be a spare (no link, not staff or owner, no devices): it is deleted as the
 * person moves to this row. A person held by another row in use is refused with `person_taken`.
 */
export async function matchLeader(
  store: Pick<Store, 'leaderById' | 'listLeaders' | 'setMatch'>,
  actor: LeaderRow,
  leaderId: unknown,
  rawChmsId: unknown,
): Promise<{ ok: true; matched: boolean } | { error: MatchError }> {
  const c = await check(store, actor, leaderId);
  if ('error' in c) return c;
  const target = c.target;
  if (!target.hasLink) return { error: 'no_link' };

  if (rawChmsId === null) {
    if (!(await store.setMatch(target.id, null, null))) return { error: 'not_found' };
    return { ok: true, matched: false };
  }
  if (typeof rawChmsId !== 'string' || rawChmsId === '' || rawChmsId.length > CHMS_ID_MAX || rawChmsId.trim() !== rawChmsId) {
    return { error: 'invalid_person' };
  }
  const chmsId = rawChmsId;
  if (target.chmsIndividualId === chmsId) return { ok: true, matched: true };

  const holder = (await store.listLeaders()).find((l) => l.chmsIndividualId === chmsId);
  if (!holder) return { error: 'unknown_person' };
  if (holdsLeadPerson(holder)) return { error: 'person_taken' };
  if (!(await store.setMatch(target.id, chmsId, holder.id))) return { error: 'person_taken' };
  return { ok: true, matched: true };
}

export const MATCH_ERROR_STATUS: Record<MatchError, number> = {
  ...LINK_ERROR_STATUS,
  no_link: 400,
  invalid_person: 400,
  unknown_person: 404,
  person_taken: 409,
};
