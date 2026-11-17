import { authenticate, apiError, json, readJson } from '../../src/api/http';
import { createD1Store } from '../../src/db';
import type { Env } from '../../src/env';
import { parseSubscription } from '../../src/push/subscription';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const store = createD1Store(env.DB);
  const leader = await authenticate(request, store);
  if (!leader) return apiError('invalid_token', 401);
  const body = (await readJson(request)) as { subscription?: unknown } | undefined;
  const sub = parseSubscription(body?.subscription);
  if (!sub) return apiError('invalid_subscription', 400);
  await store.saveSubscription(leader.id, sub);
  return json({ ok: true });
};
