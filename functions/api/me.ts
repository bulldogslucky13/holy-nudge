import { authenticate, apiError, json } from '../../src/api/http';
import { buildMe, isAdminFor } from '../../src/api/me';
import { createDataSource } from '../../src/chms/index';
import { loadConfig } from '../../src/core/config';
import { createD1Store } from '../../src/db';
import type { Env } from '../../src/env';
import { loadSnapshot, peopleSeen, type Snapshot } from '../../src/job/load';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const store = createD1Store(env.DB);
  const leader = await authenticate(request, store);
  if (!leader) return apiError('invalid_token', 401);

  const config = loadConfig();
  const now = new Date();
  let snapshot: Snapshot;
  try {
    snapshot = await loadSnapshot(createDataSource(config, env, now), config);
  } catch (err) {
    console.error('api/me: data source failed', err instanceof Error ? err.name : 'unknown');
    return apiError('chms_unavailable', 503);
  }

  let leaders = [leader];
  if (isAdminFor(leader, config, snapshot, now)) {
    // Make sure every leader the admin can see has a personal link, even before the first daily run.
    await store.upsertLeaders(peopleSeen(snapshot));
    leaders = await store.listLeaders();
  }
  const baseUrl = env.APP_BASE_URL || new URL(request.url).origin;
  return json(buildMe({ config, snapshot, leader, leaders, now, baseUrl }));
};
