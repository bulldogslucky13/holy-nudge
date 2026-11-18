// POST /api/leader-revoke { leaderId } (staff only): turn a leader's link off and delete their push subscriptions.
import { apiError, authenticate, json, rateLimit, readJson } from '../../src/api/http';
import { LINK_ERROR_STATUS, revokeLink } from '../../src/api/leaders';
import { createD1Store } from '../../src/db';
import type { Env } from '../../src/env';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const store = createD1Store(env.DB);
  const leader = await authenticate(request, store);
  if (!leader) return apiError('invalid_token', 401);
  if (!leader.isAdmin) return apiError('forbidden', 403);
  const now = new Date();
  const limited = await rateLimit(store, leader.id, 'links', now);
  if (limited) return limited;
  const body = (await readJson(request)) as { leaderId?: unknown } | undefined;
  const r = await revokeLink(store, leader, body?.leaderId, now);
  if ('error' in r) return apiError(r.error, LINK_ERROR_STATUS[r.error]);
  return json(r);
};
