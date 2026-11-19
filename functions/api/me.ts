import { authenticate, apiError, json, rateLimit } from '../../src/api/http';
import { resolveMe } from '../../src/api/me';
import { createDataSource } from '../../src/chms/index';
import { loadConfig } from '../../src/core/config';
import { HOUR_MS } from '../../src/core/time';
import { createD1Store } from '../../src/db';
import type { Env } from '../../src/env';
import { loadSnapshot } from '../../src/job/load';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const store = createD1Store(env.DB);
  const leader = await authenticate(request, store);
  if (!leader) return apiError('invalid_token', 401);

  const now = new Date();
  // Before any ChMS read: one leaked link must not drive unlimited reads.
  const limited = await rateLimit(store, leader.id, 'me', now);
  if (limited) return limited;
  if (!leader.lastSeenAt || Date.parse(leader.lastSeenAt) < now.getTime() - HOUR_MS) {
    await store.touchLastSeen(leader.id, now, HOUR_MS);
  }

  const config = loadConfig();
  const result = await resolveMe({
    store,
    config,
    leader,
    now,
    // createDataSource inside the closure so a pre-launch caller never even builds a data source.
    loadSnapshot: () => loadSnapshot(createDataSource(config, env, now), config),
  });
  if (!result.ok) {
    console.error(`api/me: data source failed (${result.errorName})`);
    return apiError('chms_unavailable', 503);
  }
  return json(result.me);
};
