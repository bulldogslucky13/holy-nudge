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
- `isStaleUnassigned(entry, now, tz)`: `assignee === null`, status not `DONE`, and `created` more than 24 hours before `now` (elapsed time, not calendar days). The Pushpay guide shows `created` (and `due`) as date-only values: a date-only `created` is taken as the end of that calendar day in the configured zone (the next local midnight), so it never flags early. A `created` datetime with no offset is Central wall time; one with an offset is exact.
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

## Addendum: API contract and ownership (build phase 2)

### Personal link and iOS storage

iOS gives a Home Screen web app its own storage, separate from Safari, so a token saved in Safari's `localStorage` is lost on install. Therefore:

- The personal link is `https://holynudge.cameronbristol.xyz/l/<token>`.
- `functions/l/[token].ts` serves `public/index.html` with the manifest link rewritten (HTMLRewriter) to `/manifest.webmanifest?t=<token>`.
- `functions/manifest.webmanifest.ts` returns the manifest with `start_url` and `scope`-compatible `id` set to `/l/<token>` when `t` is present, so the installed app opens straight into the leader's view.
- The client reads the token from the path (`/l/<token>`), falls back to `localStorage`, and sends it as `Authorization: Bearer <token>` on every API call. Notification clicks open `/l/<token>` (the service worker gets the token from the client via `postMessage` and stores it in IndexedDB or Cache; payloads never contain it).
- `/` without a token shows a friendly "open your personal link" page.

### JSON contract

All API errors: `{ "error": "<code>" }` with 4xx/5xx. Invalid or missing token: 401 `invalid_token`.

`GET /api/me` ->
```json
{
  "leader": { "name": "Sam Fakename", "isAdmin": false, "notificationsOn": true },
  "behind": [ {
    "entryId": "e1", "queueId": "q3", "queueName": "Outreach Team",
    "queueUrl": "https://.../", "status": "NOT_STARTED",
    "due": "2026-11-10", "daysOverdue": 7,
    "individual": { "name": "Pat Example", "phone": "405-555-0101", "email": "pat@example.com" }
  } ],
  "admin": {
    "staleUnassigned": [ { "...item fields": "", "hoursWaiting": 60 } ],
    "byLeader": [ { "leader": { "name": "Sam Fakename" }, "notificationsOn": false, "items": [ ] } ],
    "leadersWithoutNotifications": [ { "name": "Sam Fakename" } ],
    "leaderLinks": [ { "name": "Sam Fakename", "url": "https://holynudge.cameronbristol.xyz/l/..." } ]
  },
  "generatedAt": "2026-11-17T14:00:00Z"
}
```
`admin` is present only for admins. `byLeader` entries with `leader: null` are behind-but-unassigned. `daysOverdue` is null when not overdue (for example Not Started with a future due date). `due` is normalised to a `YYYY-MM-DD` Central date or null.

- `GET /api/vapid-public-key` -> `{ "key": "<base64url>" }`
- `POST /api/subscribe` body `{ "subscription": <PushSubscription.toJSON()> }` -> `{ "ok": true }`
- `POST /api/unsubscribe` body `{ "endpoint": "..." }` -> `{ "ok": true }`
- `POST /api/test-push` -> `{ "ok": true, "sent": 1 }`

Push payload (JSON, counts only): `{ "title": "Holy Nudge", "body": "3 students are waiting on you", "kind": "leader" | "admin" | "test" | "alert", "count": 3 }`.

### `leaders` table additions

`is_owner` flag (gets failure alerts; Cameron). The daily job upserts a leader row (with a fresh token) for every assignee and queue manager it sees, so links exist before anyone asks.

### File ownership in phase 2

- Backend worker: `src/push/`, `src/job/`, `src/db/`, `src/env.ts`, `src/chms/index.ts` (data-source factory), `functions/` except `functions/oauth/`, `cron-worker/`, `migrations/0001_*.sql`, wrangler config, `scripts/`.
- Frontend worker: `public/` only.
- OAuth worker: `src/chms/pushpay.ts`, `src/chms/tokens.ts`, `src/chms/oauth.ts`, `functions/oauth/`, `migrations/0002_oauth.sql`, their tests.
