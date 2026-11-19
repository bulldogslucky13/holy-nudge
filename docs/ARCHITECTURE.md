# Holy Nudge architecture

Source of truth for product requirements: `ORCHESTRATOR_PROMPT.md`. This file fixes the technical shape so workers build compatible pieces.

## Hosting (decided)

Cloudflare free plan. DNS stays at GoDaddy (CNAME `holynudge` -> Pages project).

- **Cloudflare Pages** project `holy-nudge`: static PWA from `public/`, API via Pages Functions in `functions/`.
- **Cron Worker** `holy-nudge-cron` in `cron-worker/`: `scheduled` handler runs the daily job. Pages has no cron, hence the separate Worker.
- **D1** database `holy-nudge` bound as `DB` to both. Schema in `migrations/`.
- Secrets (`CHMS_CLIENT_SECRET`, `VAPID_PRIVATE_KEY`, `TOKEN_ENC_KEY` etc.) via `wrangler secret` / Pages secrets. Never in git. `.dev.vars` is gitignored (mode 600).

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
public/        PWA: index.html, app.js, styles.css (brand tokens), sw.js, manifest.webmanifest, icons,
               og.png (link preview), sprig.svg, fonts/ (Montserrat + OFL), brand/ (Wildwood College logo)
scripts/       one-off CLIs; gen-brand-assets.mjs regenerates the icon / preview PNGs (README "Brand")
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

- `leaders(id, chms_individual_id UNIQUE, name, token UNIQUE NULL, token_hash UNIQUE NULL, is_admin, is_owner, created_at, last_seen_at, revoked_at)` (migration 0003):
  - The personal link is `/l/<token>`, token = 32 random bytes, base64url. Only `token_hash` = SHA-256(token), lowercase hex, is stored; lookups are by hash. No row ever holds a usable link the server could show again.
  - `token` is the LEGACY plaintext column from before 0003. New code never writes it. A legacy link still works: the lookup falls back to it, writes the hash and clears the plaintext on first use; `scripts/hash-tokens.mjs` converts the rest. Remove the fallback and drop the column once that script reports 0 left in production.
  - Rows created automatically (daily job, staff page views) have no link (`token_hash` NULL) until staff mint one.
  - `revoked_at`: link turned off by staff (hash and plaintext cleared, push subscriptions deleted). `last_seen_at`: last authenticated `GET /api/me`, written at most hourly.
  - `is_admin` = staff (whole-process view, link management). `is_owner` = gets failure alerts; only an owner can rotate or turn off an owner's link.
- `push_subscriptions(id, leader_id, endpoint UNIQUE, p256dh, auth, created_at, last_ok_at)`. An endpoint already stored for another leader moves only if the same `p256dh`/`auth` come with it (one browser switching links); otherwise `409 subscription_conflict`.
- `rate_limits(leader_id, bucket, window_start, count)`: fixed-window counters (`me` 30/5 min, `test-push` 5/10 min, `links` 30/10 min). Leader id, window and count only.
- `oauth_tokens(id=1, refresh_token, access_token, access_expires_at, scope, updated_at, lock_owner, lock_expires_at, needs_reauth_at)`: both token columns are AES-256-GCM ciphertext (`v1.<iv>.<ciphertext>`, fresh 96-bit IV per write, column name bound as additional data) under the secret `TOKEN_ENC_KEY`, shared by Pages and the cron worker. No plaintext fallback: a missing or malformed key is `not_configured`; a value that will not decrypt means re-approval.
- `job_runs(id, started_at, finished_at, ok, summary)`: counts only, no student data. A failed run's summary is `{ stage, reason, error }` (error = class name).

Student data is never stored in D1; views fetch it live through the DataSource (short in-memory/Cache TTL is fine).

## Privacy rules for all code

- Push payloads: counts only. No student names, phones, or emails.
- Logs: counts, queue ids, stage, reason and error class names only. Never error messages from upstream (they can echo ChMS values), never names, contact details, tokens or secrets. The cron worker catches every failure and logs one fixed line; `/api/*` and `/oauth/*` have an error-boundary middleware that logs the route and error class only.
- `GET /api/me` sends student name and phone only (no email).
- Fixtures: invented names, `555-01xx` phone numbers, `example.com` emails.

## Routes (Pages Functions)

- `GET /api/me` -> leader info + their behind list (+ admin view data if admin). Rate limited.
- `POST /api/subscribe`, `POST /api/unsubscribe` (token-authenticated)
- `GET /api/vapid-public-key`
- `POST /api/test-push` (token-authenticated; sends a sample push to self). Rate limited.
- `POST /api/leader-link`, `POST /api/leader-revoke`, `POST /api/leader-add` (staff only: `is_admin = 1`)
- `GET /oauth/start` (setup key), `GET /oauth/callback` (exact URI `https://holynudge.cameronbristol.xyz/oauth/callback`)

Security headers: `public/_headers` covers static files; Pages does not apply it to Functions responses, so `/l/<token>`, `/manifest.webmanifest`, `/api/*` and `/oauth/*` set the same headers in code (`src/api/headers.ts`). CSP: `default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` (no `'unsafe-inline'`: the app uses classes, not style attributes; the OAuth pages allow their one inline `<style>` by hash), plus HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.

## Daily job

Cron fires at 13:00 and 14:00 UTC; job proceeds only when the Central local hour equals `morningHour` (handles DST). One push per leader with behind count; one summary push per admin. While `dataSource` is `fixture` (not live) only staff rows (`is_admin = 1`) are nudged: a non-staff row, even one that maps to a sample leader or queue manager, gets nothing, and a row with no `chms_individual_id` never gets a leader nudge (nudges are matched by ChMS id; only staff get the global admin summary). On data-source error: record failed run and push an alert to admins flagged as owner.

## Addendum: API contract and ownership (build phase 2)

### Personal link and iOS storage

iOS gives a Home Screen web app its own storage, separate from Safari, so a token saved in Safari's `localStorage` is lost on install. Therefore:

- The personal link is `https://holynudge.cameronbristol.xyz/l/<token>`.
- `functions/l/[token].ts` serves `public/index.html` with the manifest link rewritten (HTMLRewriter) to `/manifest.webmanifest?t=<token>`.
- `functions/manifest.webmanifest.ts` returns the manifest with `start_url` and `scope`-compatible `id` set to `/l/<token>` when `t` is present, so the installed app opens straight into the leader's view.
- The client reads the token from the path (`/l/<token>`), falls back to `localStorage`, and sends it as `Authorization: Bearer <token>` on every API call. It stores a token (in `localStorage`, and in the service worker's IndexedDB via `postMessage`) only after the server has accepted it. Notification clicks open `/l/<token>` from IndexedDB; payloads never contain it.
- On any 401 the client clears the token from `localStorage` and asks the service worker to delete its copy. Exception: if the path token is refused but this device holds a different, previously accepted token (staff rotated their own link inside an installed app, which keeps opening its original `start_url`), it switches to that one first.
- `/` without a token shows a friendly "open your personal link" page.

### JSON contract

All API errors: `{ "error": "<code>" }` with 4xx/5xx. Invalid, missing or turned-off token: 401 `invalid_token`. Over the rate limit: 429 `rate_limited` with `Retry-After`. Not staff: 403 `forbidden`. Unhandled: 500 `server_error`.

`GET /api/me` ->
```json
{
  "leader": { "name": "Sam Fakename", "isAdmin": false, "notificationsOn": true },
  "live": true,
  "behind": [ {
    "entryId": "e1", "queueId": "q3", "queueName": "Outreach Team",
    "queueUrl": "https://.../", "status": "NOT_STARTED",
    "due": "2026-11-10", "daysOverdue": 7,
    "individual": { "name": "Pat Example", "phone": "405-555-0101" }
  } ],
  "admin": {
    "staleUnassigned": [ { "...item fields": "", "hoursWaiting": 60 } ],
    "byLeader": [ { "leader": { "name": "Sam Fakename" }, "notificationsOn": false, "items": [ ] } ],
    "leadersWithoutNotifications": [ { "name": "Sam Fakename" } ],
    "leaders": [ {
      "id": 12, "name": "Sam Fakename", "hasLink": true, "lastSeenAt": "2026-11-17T14:03:11.000Z",
      "notificationsOn": false, "canManage": true, "isYou": false
    } ]
  },
  "generatedAt": "2026-11-17T14:00:00Z"
}
```
`live` is `true` when real church data is connected (`config.dataSource !== 'fixture'`), `false` while the app still runs on made-up sample data. **Pre-launch rule:** while `live` is `false`, a caller who is not staff (`is_admin` not set) always gets `behind: []` and no `admin` key, whatever their row maps to in the sample data, and the server does not load the sample snapshot for them at all (response keys are exactly `leader`, `live`, `behind`, `generatedAt`). Staff are unchanged (sample data and the admin view) and the client shows them a one-line "sample data" note. The client uses `live === false` with `leader.isAdmin === false` to show the setup-only flow: onboarding, then a "you're all set" screen with a test-notification button (or a "finish setting up" screen while notifications are not on). When `live` is `true` everything is as described below.

`admin` is present only for admins. `admin.leaders` is present only for staff (`is_admin = 1`, which includes the owner): every leader row, sorted by name, never with a link or token. Implicit queue-manager admins get no `leaders` key and no link features. `canManage` is false on an owner's row unless the viewer is an owner. `byLeader` entries with `leader: null` are behind-but-unassigned. `daysOverdue` is null when not overdue (for example Not Started with a future due date). `due` is normalised to a `YYYY-MM-DD` Central date or null.

- `GET /api/vapid-public-key` -> `{ "key": "<base64url>" }`
- `POST /api/subscribe` body `{ "subscription": <PushSubscription.toJSON()> }` -> `{ "ok": true }`
- `POST /api/unsubscribe` body `{ "endpoint": "..." }` -> `{ "ok": true }`
- `POST /api/test-push` -> `{ "ok": true, "sent": 1 }`
- `POST /api/leader-link` body `{ "leaderId": 12 }` (staff) -> `{ "url": "https://holynudge.cameronbristol.xyz/l/<token>", "self": false }`. Generates a fresh token, stores its hash, clears `revoked_at`; the previous link stops working. The URL exists only in this response. `self: true` means the caller rotated their own link (the client switches to it). Errors: 403 `forbidden` (not staff), 403 `owner_protected` (owner's row, caller not owner), 404 `not_found`.
- `POST /api/leader-add` body `{ "name": "Pat Volunteer" }` (staff) -> `{ "url": "https://holynudge.cameronbristol.xyz/l/<token>", "leader": { "id": 14, "name": "Pat Volunteer" } }`. Adds a person who is not in ChMS: a plain leader row (not staff, not owner, no ChMS id) with a first link (only its SHA-256 stored; the URL exists only in this response). `isAdmin`, `isOwner`, `chmsId` or any other body field is ignored, so this route can never create staff. Name: trimmed, inner whitespace collapsed, 2 to 60 characters, no control characters. Errors: 403 `forbidden` (not staff, including implicit queue-manager admins), 400 `name_required` / `name_too_short` / `name_too_long` / `invalid_name`, 409 `name_taken` (another leader already has that name, case-insensitive: use `leader-link` on their row instead), 429 `rate_limited` (shares the `links` bucket). Before real data connects such a person sees only setup and the "you're all set" screen; once live they need a ChMS id mapped to see students.
- `POST /api/leader-revoke` body `{ "leaderId": 12 }` (staff) -> `{ "ok": true }`. Sets `revoked_at`, clears the hash, deletes the leader's push subscriptions. Same errors, plus 400 `cannot_revoke_self`.

Push payload (JSON, counts only): `{ "title": "3 students are waiting on you", "body": "Tap to see who could use a hello", "kind": "leader" | "admin" | "test" | "alert", "count": 3 }`. The title carries the message (the phone already shows the app name); neither field repeats "Holy Nudge".

### `leaders` table additions

`is_owner` flag (gets failure alerts; Cameron). The daily job (and a staff page view) upserts a leader row for every assignee and queue manager it sees, with no link; staff mint links on demand from the Team tab (or `scripts/add-leader.mjs`).

### File ownership in phase 2

- Backend worker: `src/push/`, `src/job/`, `src/db/`, `src/env.ts`, `src/chms/index.ts` (data-source factory), `functions/` except `functions/oauth/`, `cron-worker/`, `migrations/0001_*.sql`, wrangler config, `scripts/`.
- Frontend worker: `public/` only.
- OAuth worker: `src/chms/pushpay.ts`, `src/chms/tokens.ts`, `src/chms/oauth.ts`, `functions/oauth/`, `migrations/0002_oauth.sql`, their tests.
