// holy-nudge-cron: runs the daily job on a schedule, plus a guarded manual trigger.
import { createDataSource } from '../src/chms/index';
import { loadConfig } from '../src/core/config';
import { createD1Store } from '../src/db';
import { DEFAULT_APP_BASE_URL, type Env } from '../src/env';
import { localHour, runDailyJob, type JobOutcome } from '../src/job/daily';
import { senderFromEnv } from '../src/push/sender';

async function run(env: Env, now: Date, force: boolean): Promise<JobOutcome> {
  const config = loadConfig();
  const hour = localHour(now, config.timeZone);
  // Gate before building the sender so the off-hour cron is a quiet no-op.
  if (!force && hour !== config.morningHour) return { ran: false, reason: 'outside_morning_hour', localHour: hour };
  return runDailyJob({
    config,
    store: createD1Store(env.DB),
    sender: senderFromEnv(env, DEFAULT_APP_BASE_URL),
    dataSource: () => createDataSource(config, env, now),
    now,
    force,
  });
}

async function keyMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const out = await run(env, new Date(controller.scheduledTime), false);
    console.log('holy-nudge job', JSON.stringify(out));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const notFound = new Response('Not found', { status: 404 });
    if (request.method !== 'POST' || url.pathname !== '/run' || url.searchParams.get('force') !== '1') return notFound;
    const key = request.headers.get('X-Job-Trigger-Key');
    if (!env.JOB_TRIGGER_KEY || !key || !(await keyMatches(key, env.JOB_TRIGGER_KEY))) return notFound;
    try {
      const out = await run(env, new Date(), true);
      return Response.json(out);
    } catch (err) {
      console.error('holy-nudge manual run failed', err instanceof Error ? err.message : 'unknown');
      return Response.json({ error: 'job_failed' }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
