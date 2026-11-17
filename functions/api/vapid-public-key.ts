import { apiError, json } from '../../src/api/http';
import type { Env } from '../../src/env';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.VAPID_PUBLIC_KEY) return apiError('push_not_configured', 503);
  return json({ key: env.VAPID_PUBLIC_KEY }, 200, { 'Cache-Control': 'public, max-age=3600' });
};
