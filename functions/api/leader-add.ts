// POST /api/leader-add { name, role? } (staff only): add a leader (role "leader", the default, or "staff") with no
// ChMS id and a first personal link; returns { url, leader: { id, name, role } } once. Never an owner; any other
// field in the body is ignored.
import { apiError, authenticate, json, rateLimit, readJson } from '../../src/api/http';
import { ADD_LEADER_ERROR_STATUS, addLeader } from '../../src/api/leaders';
import { createD1Store } from '../../src/db';
import { appBaseUrl, type Env } from '../../src/env';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const store = createD1Store(env.DB);
  const leader = await authenticate(request, store);
  if (!leader) return apiError('invalid_token', 401);
  if (!leader.isAdmin) return apiError('forbidden', 403);
  const limited = await rateLimit(store, leader.id, 'links', new Date());
  if (limited) return limited;
  const body = (await readJson(request)) as { name?: unknown; role?: unknown } | null | undefined;
  const r = await addLeader(store, leader, body?.name, body?.role, appBaseUrl(env, request.url));
  if ('error' in r) return apiError(r.error, ADD_LEADER_ERROR_STATUS[r.error]);
  return json(r);
};
