// POST /api/leader-match { leaderId, chmsId } (staff only): tie a leader to a Lead (ChMS) person by hand, or
// clear the tie with chmsId null (the link stays). Returns { ok: true, matched }.
import { apiError, authenticate, json, rateLimit, readJson } from '../../src/api/http';
import { MATCH_ERROR_STATUS, matchLeader } from '../../src/api/leaders';
import { createD1Store } from '../../src/db';
import type { Env } from '../../src/env';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const store = createD1Store(env.DB);
  const leader = await authenticate(request, store);
  if (!leader) return apiError('invalid_token', 401);
  if (!leader.isAdmin) return apiError('forbidden', 403);
  const limited = await rateLimit(store, leader.id, 'links', new Date());
  if (limited) return limited;
  const raw = await readJson(request);
  const body = typeof raw === 'object' && raw !== null ? (raw as { leaderId?: unknown; chmsId?: unknown }) : {};
  // A missing chmsId is not a request to clear (undefined is refused): only an explicit null clears.
  const r = await matchLeader(store, leader, body.leaderId, body.chmsId);
  if ('error' in r) return apiError(r.error, MATCH_ERROR_STATUS[r.error]);
  return json(r);
};
