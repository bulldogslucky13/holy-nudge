// POST /api/leader-link { leaderId } (staff only): mint a fresh personal link; returns { url, self } once.
import { apiError, authenticate, json, rateLimit, readJson } from '../../src/api/http';
import { LINK_ERROR_STATUS, mintLink } from '../../src/api/leaders';
import { createD1Store } from '../../src/db';
import { appBaseUrl, type Env } from '../../src/env';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const store = createD1Store(env.DB);
  const leader = await authenticate(request, store);
  if (!leader) return apiError('invalid_token', 401);
  if (!leader.isAdmin) return apiError('forbidden', 403);
  const limited = await rateLimit(store, leader.id, 'links', new Date());
  if (limited) return limited;
  const body = (await readJson(request)) as { leaderId?: unknown } | undefined;
  const r = await mintLink(store, leader, body?.leaderId, appBaseUrl(env, request.url));
  if ('error' in r) return apiError(r.error, LINK_ERROR_STATUS[r.error]);
  return json(r);
};
