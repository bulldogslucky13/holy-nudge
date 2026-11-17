# Holy Nudge

A small installable web app (PWA) that sends college-ministry servant leaders one friendly push each morning when students in their Pushpay ChMS process queues are waiting on them. Admins get a summary and a view of everyone unassigned or behind. Read-only: it never writes to ChMS. Push messages carry counts only; names and contact details appear only inside the app, behind each leader's personal link.

Product brief: `ORCHESTRATOR_PROMPT.md`. Technical shape and rules: `docs/ARCHITECTURE.md`. Pushpay API notes: `docs/chms-api-notes.md`.

## Hosting

All on Cloudflare's free plan:

- **Pages project `holy-nudge`**: the PWA (`public/`) and API (`functions/`). Production branch `master`. Live at https://holynudge.cameronbristol.xyz (also https://holy-nudge.pages.dev).
- **Worker `holy-nudge-cron`** (`cron-worker/`): the daily job. Cron fires at 13:00 and 14:00 UTC; the job runs only when it is `morningHour` in `America/Chicago`, so it is 8am Central all year.
- **D1 database `holy-nudge`**: leaders and their link tokens, push subscriptions, the Pushpay token, job runs. No student data.

Secrets live in Cloudflare, never in git:

| Secret | Pages | Cron worker |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | yes | yes |
| `OAUTH_SETUP_KEY` | yes | |
| `JOB_TRIGGER_KEY` | | yes |
| `CHMS_CLIENT_ID`, `CHMS_CLIENT_SECRET` (when Pushpay sends them) | yes | yes |

A copy of the generated values is in `.secrets.local` on Cameron's machine (gitignored, mode 600). `VAPID_SUBJECT` is optional; it defaults to the app URL. Changing the VAPID keys turns off everyone's notifications until they tap "Turn on notifications" again.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in:
npm run gen-vapid                # paste both lines into .dev.vars; add any JOB_TRIGGER_KEY
npm run db:migrate:local
npm run dev                      # app + API on http://localhost:8788
npm run dev:cron                 # cron worker on http://localhost:8787 (second terminal)
npm run add-leader -- --name "Test Leader" --chms-id L101 --admin --owner --local
curl -X POST 'http://localhost:8787/run?force=1' -H "X-Job-Trigger-Key: <JOB_TRIGGER_KEY from .dev.vars>"
npm test && npm run typecheck
```

Open the printed `http://localhost:8788/l/<token>` link. Push needs real Google Chrome (or Safari/Firefox); Playwright's bundled Chromium cannot subscribe. On localhost, `?mock=leader` or `?mock=admin` shows the views with built-in sample data and no API.

## Deploy

```sh
npm test && npm run typecheck
npm run db:migrate:remote        # only when migrations/ changed
npm run deploy                   # Pages, production branch master
npm run deploy:cron              # the cron worker
```

Check a run by hand (prints counts only):

```sh
curl -X POST 'https://holy-nudge-cron.cameron-bristol28.workers.dev/run?force=1' -H "X-Job-Trigger-Key: <JOB_TRIGGER_KEY>"
npx wrangler d1 execute holy-nudge --remote --command "SELECT * FROM job_runs ORDER BY id DESC LIMIT 5"
```

## Connecting to Pushpay when the credentials arrive

1. Set the client id and secret on both Pages and the cron worker (the cron worker refreshes the token too):
   ```sh
   printf '%s' '<client id>'     | npx wrangler pages secret put CHMS_CLIENT_ID --project-name holy-nudge
   printf '%s' '<client secret>' | npx wrangler pages secret put CHMS_CLIENT_SECRET --project-name holy-nudge
   printf '%s' '<client id>'     | npx wrangler secret put CHMS_CLIENT_ID -c cron-worker/wrangler.toml
   printf '%s' '<client secret>' | npx wrangler secret put CHMS_CLIENT_SECRET -c cron-worker/wrangler.toml
   ```
2. **Sandbox only:** add to `[vars]` in both `wrangler.toml` and `cron-worker/wrangler.toml`:
   ```toml
   [vars]
   CHMS_AUTH_HOST = "https://beta-oauth.ccbchurch.com"
   CHMS_API_HOST = "https://api-beta.ccbchurch.com"
   ```
   Remove them for production (the defaults are `oauth.ccbchurch.com` and `api.ccbchurch.com`). Optional `CHMS_SUBDOMAIN = "wildwood"` skips the church prompt on the approval page.
3. Redeploy both (`npm run deploy && npm run deploy:cron`) so the new secrets and vars are picked up.
4. Send the church's Master Admin to `https://holynudge.cameronbristol.xyz/oauth/start?key=<OAUTH_SETUP_KEY>` (the key is in `.secrets.local`). They approve in Pushpay and land on "Holy Nudge is connected". The redirect URI is fixed to `https://holynudge.cameronbristol.xyz/oauth/callback`, exactly as registered.
5. Set `"dataSource": "pushpay"` in `config/holy-nudge.config.json`, redeploy both, and force a run. If ChMS returns fewer people than its own queue counts, the run fails and you get an alert rather than nudges from partial data.

Until step 4 is done, `/oauth/start` shows "credentials are not configured yet" (or rejects a wrong key) and `/oauth/callback` shows a neutral "ready" page.

## If the connection is lost (re-approve)

Pushpay refresh tokens are single-use. If one is ever lost (a refresh response that never arrived, or a database write that failed), the owner gets the push "Holy Nudge lost its Pushpay connection. A Master Admin needs to approve it again." Until then the app shows "we couldn't load your list" and no nudges go out. Fix: the Master Admin opens the same `/oauth/start?key=...` link again and approves. The new token replaces the old one; nothing else to do. Other failures send a different alert ("could not read ChMS", "only got part of the ChMS data"); check `job_runs` and the Worker logs.

## Configuration

`config/holy-nudge.config.json` (bundled at deploy, so redeploy both after editing):

- `processId`: the ChMS process (College New Student is `"37"`).
- `excludedQueues`: queue names (exact) or ids to ignore, such as the "DONE- do not move here unless you have left a note" and "Not Interested" parking queues.
- `adminsByQueue`: queue name or id mapped to a list of ChMS individual ids who get that queue's admin summary. A queue that is missing or has an empty list falls back to its ChMS queue managers.
- `timeZone`, `morningHour`: when the nudge goes out.
- `chmsBaseUrl`, `queueUrlTemplate`: the "Open in ChMS" link (`{chmsBaseUrl}` and `{queueId}` are filled in).

## Adding leaders and sending links

The daily job creates a leader row and personal link for everyone it sees as an assignee or queue manager, so most leaders need nothing done. Admins can copy anyone's link from the Team tab. To add someone by hand, or to flag an admin (whole-process view) or owner (gets failure alerts):

```sh
npm run add-leader -- --name "Name" --chms-id <ChMS individual id> [--admin] [--owner] --remote
```

While `dataSource` is `fixture`, `--chms-id` must be one of the sample ids in `fixtures/people.json`. Admin and owner rows keep the name you give them; other names follow ChMS.

Email each leader their link once. On iPhone: open it in Safari, tap Share, then "Add to Home Screen", open Holy Nudge from the Home Screen, and tap "Turn on notifications" (iOS 16.4 or later). The app walks them through it. The link is the only key, so treat it like a password; to revoke one, delete or change that leader's `token` in D1.

## Workflows migration

Pushpay is replacing Process Queues with Workflows. Once the church migrates, the queue endpoints stop working: the job will fail loudly (owner alert, failed `job_runs` row) instead of going quiet. The fix is a new `DataSource` beside `src/chms/pushpay.ts` using the Workflows endpoints (not public as of October 2026), and probably a fresh Master Admin approval for the new scopes. Nothing outside `src/chms/` should need to change.

## Not yet verified

- Everything marked `SANDBOX:` in `src/chms/` (token endpoint body format, whether the API returns every assignee's people under the approving admin, paging headers, date formats, phone numbers on queue rows, rate-limit headers). Needs the sandbox credentials.
- The "Open in ChMS" queue link pattern (`queueUrlTemplate`) is a guess; ask a staff member to paste the URL from their browser while viewing a queue.
- Install and push on a real iPhone from the Home Screen. Push has been verified end to end in desktop Chrome only.
