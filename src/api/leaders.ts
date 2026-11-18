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

export const LINK_ERROR_STATUS: Record<LinkError, number> = {
  forbidden: 403,
  owner_protected: 403,
  cannot_revoke_self: 400,
  not_found: 404,
};
