// Staff link management: mint a fresh personal link, or turn one off.
// Only leaders flagged is_admin ("staff") may do this; implicit queue-manager admins may not.
// An owner's link can be rotated or turned off only by an owner. Nobody can turn off their own link
// from the app (that would lock them out); they can rotate it instead.
import type { LeaderRow, Store } from '../db';
import { generateToken, hashToken } from '../db';
import { canManageLink, personalLink } from './me';

export type LinkError = 'forbidden' | 'not_found' | 'owner_protected' | 'cannot_revoke_self';

export type LinkStore = Pick<Store, 'leaderById' | 'setLinkTokenHash' | 'revokeLink'>;

async function check(store: LinkStore, actor: LeaderRow, leaderId: unknown): Promise<{ target: LeaderRow } | { error: LinkError }> {
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

export type AddLeaderError = 'forbidden' | 'name_required' | 'name_too_short' | 'name_too_long' | 'invalid_name' | 'name_taken';

export const NAME_MIN = 2;
export const NAME_MAX = 60;

// C0/C1 controls (tabs and newlines included), line/paragraph separators, zero-width and bidi-control characters.
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/** Trim, collapse inner whitespace, NFC. Returns the cleaned name or the reason it is not acceptable. */
export function cleanLeaderName(input: unknown): { name: string } | { error: Exclude<AddLeaderError, 'forbidden' | 'name_taken'> } {
  if (typeof input !== 'string') return { error: 'name_required' };
  if (BAD_NAME_CHARS.test(input)) return { error: 'invalid_name' };
  const name = input.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (name === '') return { error: 'name_required' };
  const length = Array.from(name).length;
  if (length < NAME_MIN) return { error: 'name_too_short' };
  if (length > NAME_MAX) return { error: 'name_too_long' };
  return { name };
}

/**
 * Staff add a person who is not in ChMS yet: a plain (non-staff, non-owner) leader row with no ChMS id and a
 * fresh personal link. Only the staff check and the name come from the caller; nothing in the request can set
 * admin/owner/ChMS id. The URL exists only in the returned value.
 */
export async function addLeader(
  store: Pick<Store, 'listLeaders' | 'createLeader'>,
  actor: Pick<LeaderRow, 'isAdmin'>,
  rawName: unknown,
  baseUrl: string,
): Promise<{ url: string; leader: { id: number; name: string } } | { error: AddLeaderError }> {
  if (!actor.isAdmin) return { error: 'forbidden' };
  const c = cleanLeaderName(rawName);
  if ('error' in c) return c;
  const lower = c.name.toLowerCase();
  // Unicode-aware duplicate check here; the insert itself also refuses (ASCII-case) duplicates atomically.
  if ((await store.listLeaders()).some((l) => l.name.toLowerCase() === lower)) return { error: 'name_taken' };
  const token = generateToken();
  const id = await store.createLeader(c.name, await hashToken(token));
  if (id === null) return { error: 'name_taken' };
  return { url: personalLink(baseUrl, token), leader: { id, name: c.name } };
}

export const ADD_LEADER_ERROR_STATUS: Record<AddLeaderError, number> = {
  forbidden: 403,
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
