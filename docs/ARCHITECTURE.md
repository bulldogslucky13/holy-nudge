# Holy Nudge architecture

Source of truth for product requirements: `ORCHESTRATOR_PROMPT.md`. This file fixes the technical shape so workers build compatible pieces.

## Hosting (decided)

Cloudflare free plan. DNS stays at GoDaddy (CNAME `holynudge` -> Pages project).

- **Cloudflare Pages** project `holy-nudge`: static PWA from `public/`, API via Pages Functions in `functions/`.
- **Cron Worker** `holy-nudge-cron` in `cron-worker/`: `scheduled` handler runs the daily job. Pages has no cron, hence the separate Worker.
- **D1** database `holy-nudge` bound as `DB` to both. Schema in `migrations/`.
- Secrets (`CHMS_CLIENT_SECRET`, `VAPID_PRIVATE_KEY`, `ADMIN_ALERT_TOKEN` etc.) via `wrangler secret` / Pages secrets. Never in git. `.dev.vars` is gitignored.

## Stack

TypeScript, single npm package, Node 24, `vitest` for tests, `wrangler` for dev/deploy. No frontend framework: plain HTML/CSS/JS in `public/`. Keep dependencies minimal; everything in `src/` must run on the Workers runtime (WebCrypto, fetch; no Node built-ins).

## Layout

```
src/core/      pure logic, no I/O: types.ts, behind.ts, config.ts, time.ts
src/chms/      DataSource interface + implementations
                 datasource.ts   interface (the ONLY seam to ChMS)
                 fixture.ts      sample-data implementation
                 pushpay.ts      live v2 API implementation (later)
                 tokens.ts       refresh-token rotation with D1 lock (later)
src/push/      VAPID web push (aes128gcm) on WebCrypto, subscription store
src/job/       daily job: load -> compute behind -> send pushes -> alert on failure
src/db/        D1 queries
functions/     Pages Functions (thin; call into src/)
public/        PWA: index.html, app.js, sw.js, manifest.webmanifest, icons
cron-worker/   wrangler.toml + index.ts (thin; calls src/job)
migrations/    D1 SQL
fixtures/      fake sample data (JSON)
test/          vitest
config/        holy-nudge.config.json (process id, excluded queues, admin mapping, timezone, morning hour)
```

## Core types (`src/core/types.ts`)

```ts
type Status = 'NOT_STARTED' | 'IN_PROCESS' | 'WAITING' | 'DONE';
interface Person { id: string; name: string; phone?: string; email?: string }
interface Queue { id: string; name: string; processId: string; managers: Person[] }
interface QueueEntry {            // one person in one queue
  id: string; queueId: string;
  status: Status;
  due: string | null;             // as ChMS returns it (date or datetime)
  created: string;                // when they entered the queue
  completed: string | null;
  assignee: Person | null;
  individual: Person;
}
interface DataSource {
  listQueues(processId: string): Promise<Queue[]>;
  listEntries(queueId: string): Promise<QueueEntry[]>;
}
```

The live implementation maps Pushpay responses into these types; nothing outside `src/chms/` knows the API's shapes. A later Workflows implementation is another `DataSource`.

## Rules (`src/core/behind.ts`)

- `isBehind(entry, now, tz)`: `status === NOT_STARTED`, OR (`status !== DONE` AND due date has passed).
- "Due date has passed" = the due calendar date is strictly before today's calendar date in the configured time zone (`America/Chicago`). Due today is not behind. A due value with a time component is converted to a Central calendar date first.
- `WAITING` with a future (or today's) due date is not behind. `DONE` is never behind. Null due + not `NOT_STARTED` is not behind.
- `isStaleUnassigned(entry, now)`: `assignee === null`, status not `DONE`, and `created` more than 24 hours before `now` (elapsed time, not calendar days).
- Excluded queues (config, by queue id and/or exact name) are dropped before any rule runs.
- Output of the job computation: per leader (assignee id) list of behind entries; per admin: stale-unassigned entries plus behind entries grouped by leader, for the queues they administer. Admins for a queue = config mapping, defaulting to that queue's managers.

## Config (`config/holy-nudge.config.json`)

`processId` ("37"), `excludedQueues` (names: the "DONE- do not move here unless you have left a note" queue and "Not Interested"; welcome-email queues need no exclusion since all Done), `adminsByQueue` (queue name/id -> ChMS individual ids; empty = use managers), `timeZone`, `morningHour` (8), `dataSource` ("fixture" | "pushpay"), `chmsBaseUrl` for deep links (`https://wildwood.ccbchurch.com`).

## D1 tables

- `leaders(id, chms_individual_id UNIQUE, name, token UNIQUE, is_admin, created_at)`: token is a long random string; the personal link is `/?t=<token>` (stored client-side after first open).
- `push_subscriptions(id, leader_id, endpoint UNIQUE, p256dh, auth, created_at, last_ok_at)`
- `oauth_tokens(id=1, refresh_token, access_token, access_expires_at, updated_at, lock_owner, lock_expires_at)`
- `job_runs(id, started_at, finished_at, ok, summary)`: counts only, no student data.

Student data is never stored in D1; views fetch it live through the DataSource (short in-memory/Cache TTL is fine).

## Privacy rules for all code

- Push payloads: counts only. No student names, phones, or emails.
- Logs: ids and counts only.
- Fixtures: invented names, `555-01xx` phone numbers, `example.com` emails.

## Routes (Pages Functions)

- `GET /api/me?t=` -> leader info + their behind list (+ admin view data if admin)
- `POST /api/subscribe`, `POST /api/unsubscribe` (token-authenticated)
- `GET /api/vapid-public-key`
- `POST /api/test-push` (token-authenticated; sends a sample push to self)
- `GET /oauth/start` (admin-only), `GET /oauth/callback` (exact URI `https://holynudge.cameronbristol.xyz/oauth/callback`)

## Daily job

Cron fires at 13:00 and 14:00 UTC; job proceeds only when the Central local hour equals `morningHour` (handles DST). One push per leader with behind count; one summary push per admin. On data-source error: record failed run and push an alert to admins flagged as owner.
