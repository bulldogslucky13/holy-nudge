import { authenticate, apiError, json, readJson } from '../../src/api/http';
import { createD1Store } from '../../src/db';
import type { Env } from '../../src/env';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const store = createD1Store(env.DB);
  const leader = await authenticate(request, store);
  if (!leader) return apiError('invalid_token', 401);
  const body = (await readJson(request)) as { endpoint?: unknown } | undefined;
  if (typeof body?.endpoint !== 'string' || body.endpoint.length > 2048) return apiError('invalid_endpoint', 400);
  await store.deleteSubscription(body.endpoint, leader.id);
  return json({ ok: true });
};
