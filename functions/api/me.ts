import { authenticate, apiError, json, rateLimit } from '../../src/api/http';
import { buildMe, isAdminFor } from '../../src/api/me';
import { createDataSource } from '../../src/chms/index';
import { loadConfig } from '../../src/core/config';
import { errorClassName } from '../../src/core/errors';
import { HOUR_MS } from '../../src/core/time';
import { createD1Store } from '../../src/db';
import type { Env } from '../../src/env';
import { loadSnapshot, peopleSeen, type Snapshot } from '../../src/job/load';

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
  let snapshot: Snapshot;
  try {
    snapshot = await loadSnapshot(createDataSource(config, env, now), config);
  } catch (err) {
    console.error(`api/me: data source failed (${errorClassName(err)})`);
    return apiError('chms_unavailable', 503);
  }

  let leaders = [leader];
  if (leader.isAdmin) {
    // Staff manage everyone's link: make sure every leader in ChMS has a row (with no link yet)
    // even before the first daily run.
    await store.upsertLeaders(peopleSeen(snapshot));
    leaders = await store.listLeaders();
  } else if (isAdminFor(leader, config, snapshot, now)) {
    // Queue-manager admins see notification status for their leaders; no link features.
    leaders = await store.listLeaders();
  }
  return json(buildMe({ config, snapshot, leader, leaders, now }));
};
