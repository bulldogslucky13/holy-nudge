# Holy Nudge

A small installable web app (PWA) that sends college-ministry servant leaders one friendly push each morning when students in their Pushpay ChMS process queues are waiting on them. Admins get a summary and a view of everyone unassigned or behind. Read-only: it never writes to ChMS. Push messages carry counts only; names and contact details appear only inside the app, behind each leader's personal link.

Product brief: `ORCHESTRATOR_PROMPT.md`. Technical shape and rules: `docs/ARCHITECTURE.md`. Pushpay API notes: `docs/chms-api-notes.md`.

## Hosting

All on Cloudflare's free plan:

- **Pages project `holy-nudge`**: the PWA (`public/`) and API (`functions/`). Production branch `master`. Live at https://holynudge.cameronbristol.xyz (also https://holy-nudge.pages.dev).
- **Worker `holy-nudge-cron`** (`cron-worker/`): the daily job. Cron fires at 13:00 and 14:00 UTC; the job runs only when it is `morningHour` in `America/Chicago`, so it is 8am Central all year.
- **D1 database `holy-nudge`**: leaders (with only a hash of each link token), push subscriptions, the Pushpay tokens (encrypted), job runs, rate-limit counters. No student data. See "Data handling".

Secrets live in Cloudflare, never in git:

| Secret | Pages | Cron worker |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | yes | yes |
| `OAUTH_SETUP_KEY` | yes | |
| `JOB_TRIGGER_KEY` | | yes |
| `CHMS_CLIENT_ID`, `CHMS_CLIENT_SECRET` (when Pushpay sends them) | yes | yes |
| `TOKEN_ENC_KEY` (same value on both; encrypts the Pushpay tokens) | yes | yes |

A copy of the generated values is in `.secrets.local` on Cameron's machine (gitignored, mode 600). `VAPID_SUBJECT` is optional; it defaults to the app URL. Changing the VAPID keys turns off everyone's notifications until they tap "Turn on notifications" again.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in:
npm run gen-vapid                # paste both lines into .dev.vars; add any JOB_TRIGGER_KEY
npm run gen-token-key            # paste the line into .dev.vars (needed only to try dataSource "pushpay")
chmod 600 .dev.vars
npm run db:migrate:local
npm run dev                      # app + API on http://localhost:8788
npm run dev:cron                 # cron worker on http://localhost:8787 (second terminal)
npm run add-leader -- --name "Test Leader" --chms-id L101 --admin --owner --local
curl -X POST 'http://localhost:8787/run?force=1' -H "X-Job-Trigger-Key: <JOB_TRIGGER_KEY from .dev.vars>"
npm test && npm run typecheck
```

Open the printed `http://localhost:8788/l/<token>` link (printed once; run `add-leader` again with `--new-link` for another). Push needs real Google Chrome (or Safari/Firefox); Playwright's bundled Chromium cannot subscribe. On localhost, `?mock=leader` or `?mock=admin` shows the views with built-in sample data and no API. Before-launch (non-staff) previews: `?mock=prelaunch` (starts at onboarding; add `&fake=1` to click through to the finished screen), `?mock=prelaunch-off` (notifications not on: the "finish setting up" screen) and `?mock=prelaunch-done` (the "you're all set" screen). `?mock=admin-sample` shows staff with the "sample data" note. `&sim=ios-safari`, `&sim=denied` etc. still override the device situation.

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

1. Set the client id and secret on both Pages and the cron worker (the cron worker refreshes the token too). `TOKEN_ENC_KEY` must already be set on both (see "Rolling out hashed links and encrypted tokens"); without it `/oauth/start` says "not configured" and nothing is stored:
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

6. Once the Master Admin has approved, remove or rotate `OAUTH_SETUP_KEY` so the setup link cannot be reused: `npx wrangler pages secret delete OAUTH_SETUP_KEY --project-name holy-nudge` (set a new one only when a re-approval is needed).

Until step 4 is done, `/oauth/start` shows "credentials are not configured yet" (or rejects a wrong key) and `/oauth/callback` shows a neutral "ready" page.

## If the connection is lost (re-approve)

Pushpay refresh tokens are single-use. If one is ever lost (a refresh response that never arrived, or a database write that failed), the owner gets the push "Holy Nudge lost its Pushpay connection. A Master Admin needs to approve it again." Until then the app shows "we couldn't load your list" and no nudges go out. Fix: the Master Admin opens the same `/oauth/start?key=...` link again and approves. The new token replaces the old one; nothing else to do. Other failures send a different alert ("could not read ChMS", "only got part of the ChMS data"); check `job_runs` and the Worker logs.

## Configuration

`config/holy-nudge.config.json` (bundled at deploy, so redeploy both after editing):

- `processId`: the ChMS process (College New Student is `"37"`).
- `excludedQueues`: queue names (exact) or ids to ignore, such as the "DONE- do not move here unless you have left a note" and "Not Interested" parking queues.
- `adminsByQueue`: queue name or id mapped to a list of ChMS individual ids who get that queue's admin summary. A queue that is missing or has an empty list falls back to its ChMS queue managers.
- `timeZone`, `morningHour`: when the nudge goes out.
- `chmsBaseUrl`, `queueUrlTemplate`: the "Open in ChMS" link (`{chmsBaseUrl}` and `{queueId}` are filled in). `adminQueueUrlTemplate` (optional) is the admin-view link: one queue, one status, every assignee (`{statusId}` is filled in).

## Adding leaders and sending links

The daily job creates a leader row for everyone it sees as an assignee or queue manager, but **without a link**. Staff (rows flagged `--admin`, which includes the owner) open the Team tab, find the leader under "Leader links" and tap **New link**: the link is shown once, with Copy and Email. Making a new link turns the old one off. **Turn off link** stops a link at once and removes that leader's notifications. Only the owner can change the owner's link, and nobody can turn off their own link from the app (make yourself a new one instead). Queue managers who are not staff see their queues' summary but have no link controls.

From the command line (prints a link only when it makes one, and only once):

```sh
npm run add-leader -- --name "Name" --chms-id <ChMS individual id> [--admin] [--owner] [--new-link] --remote
npm run revoke-leader -- (--id <leader id> | --chms-id <ChMS id>) --remote
npm run list-leaders -- [--stale-days 60] --remote      # no tokens; --stale-days lists links not used in N days
```

`add-leader` on someone who already exists updates their name and raises flags but keeps their link, unless you pass `--new-link`. `--admin` makes them staff (whole-process view and link management); `--owner` adds failure alerts. While `dataSource` is `fixture`, `--chms-id` may be left out (a real volunteer before launch) or must be one of the sample ids in `fixtures/people.json`; and only staff see sample data or get sample nudges. Everyone else is set up for notifications and sees a "you're all set" screen until real data is connected (`dataSource` is not `fixture`). Admin and owner rows keep the name you give them; other names follow ChMS.

Email each leader their link once. On iPhone: open it in Safari, tap Share, then "Add to Home Screen", open Holy Nudge from the Home Screen, and tap "Turn on notifications" (iOS 16.4 or later). The app walks them through it. The link is the only key, so treat it like a password. If someone gets a new link, an iPhone Home Screen copy made from the old link stops working: they delete it and add the new link to the Home Screen again (the app on that phone tells them their link is not valid any more).

## Data handling

What is stored (D1, the only database):
- Leaders: name, ChMS individual id, staff/owner flags, SHA-256 hash of their link token (never the link itself), when they last opened the app, whether the link was turned off.
- Push subscriptions: the browser's push endpoint and keys, per leader.
- Pushpay OAuth tokens: AES-256-GCM encrypted under `TOKEN_ENC_KEY` (a Cloudflare secret, not in D1).
- Job runs: counts, and on failure the stage, reason and error class name.
- Rate-limit counters: leader id, window start, count.

What is never stored or logged: student names, phones, emails or any other ChMS person data (fetched live for each page view and held only in memory and on the leader's screen), personal links or tokens in plaintext, ChMS error messages. Push messages carry counts only. Student email is not sent to the app at all. Logs carry counts, ids of queues, stage, reason and error class names.

Links: revoke or rotate from the Team tab (staff) or with `revoke-leader` / `add-leader --new-link`. A turned-off link answers 401 everywhere and the app forgets it on that device. Staff are added with `add-leader --admin` by the owner.

Setup key: remove or rotate `OAUTH_SETUP_KEY` after the Master Admin approves (see step 6 above).

**Do not use branch preview deployments.** Preview deployments of the Pages project are bound to the same production D1 database (real leader rows, real Pushpay tokens), with whatever code the branch has. Deploy only with `npm run deploy` (production branch `master`).

## Rolling out hashed links and encrypted tokens (migration 0003)

The owner's existing link and push subscription keep working throughout; nothing to do on the phone. In order:

```sh
npm test && npm run typecheck
npm run db:migrate:remote                       # applies 0003_link_tokens.sql
npx wrangler d1 execute holy-nudge --remote --command "SELECT id, is_owner, token IS NOT NULL AS legacy, token_hash IS NOT NULL AS hashed FROM leaders; SELECT COUNT(*) AS subs FROM push_subscriptions"
#   expect: the owner row with legacy=1, hashed=0, and the same subscription count as before
npm run -s gen-token-key                        # copy the value into .secrets.local; set it on BOTH:
npx wrangler pages secret put TOKEN_ENC_KEY --project-name holy-nudge
npx wrangler secret put TOKEN_ENC_KEY -c cron-worker/wrangler.toml
npm run deploy && npm run deploy:cron
#   open your personal link once: it still works, and the row is now hashed (legacy=0, hashed=1)
npm run hash-tokens -- --remote                 # converts any remaining plaintext rows; must end "0 plaintext token(s) remain"
curl -sI https://holynudge.cameronbristol.xyz/ | grep -i content-security-policy
```

When `hash-tokens --remote` reports 0 remaining, the legacy fallback in `src/db/index.ts` (`leaderByToken`, marked LEGACY) can be deleted, and a later migration can drop `leaders.token`. Keep the fallback until then: deleting it first would break any unhashed link.

## Workflows migration

Pushpay is replacing Process Queues with Workflows. Once the church migrates, the queue endpoints stop working: the job will fail loudly (owner alert, failed `job_runs` row) instead of going quiet. The fix is a new `DataSource` beside `src/chms/pushpay.ts` using the Workflows endpoints (not public as of October 2026), and probably a fresh Master Admin approval for the new scopes. Nothing outside `src/chms/` should need to change.

## Not yet verified

- Migration 0003, the security headers and the CSP were checked locally (wrangler pages dev, curl, and the desktop app's browser pane, which cannot register service workers at all). Not yet checked on the deployed site or on an iPhone Home Screen app: service worker registration, the manifest and notifications under the new CSP, and an installed app switching to a self-rotated link.
- Everything marked `SANDBOX:` in `src/chms/` (token endpoint body format, whether the API returns every assignee's people under the approving admin, paging headers, date formats, phone numbers on queue rows, rate-limit headers). Needs the sandbox credentials.
- The "Open in ChMS" link pattern (`queueUrlTemplate`) comes from real queue URLs, but it assumes the API queue id equals the web `step_id`; confirm by tapping a link once live data is on. The web status number for In Process (1) is inferred; Not Started (3), Waiting (0) and Done (2) come from real URLs.
