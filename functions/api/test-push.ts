import { authenticate, apiError, json, rateLimit } from '../../src/api/http';
import { createD1Store } from '../../src/db';
import { DEFAULT_APP_BASE_URL, type Env } from '../../src/env';
import { deliverToLeader } from '../../src/push/deliver';
import { testPayload } from '../../src/push/payload';
import { senderFromEnv, type PushSender } from '../../src/push/sender';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const store = createD1Store(env.DB);
  const leader = await authenticate(request, store);
  if (!leader) return apiError('invalid_token', 401);
  const now = new Date();
  const limited = await rateLimit(store, leader.id, 'test-push', now);
  if (limited) return limited;
  let sender: PushSender;
  try {
    sender = senderFromEnv(env, DEFAULT_APP_BASE_URL);
  } catch {
    return apiError('push_not_configured', 503);
  }
  const r = await deliverToLeader(store, sender, leader.id, testPayload(), now);
  return json({ ok: true, sent: r.sent });
};
