# Holy Nudge

A small installable web app (PWA) that sends college-ministry servant leaders a friendly morning push when a student in their Pushpay ChMS process queues is new or overdue (see "When nudges go out"). Admins get a summary and a view of everyone unassigned or behind. Read-only: it never writes to ChMS. Push messages carry counts only; names and contact details appear only inside the app, behind each leader's personal link.

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
npm run add-leader -- --name "Rowan Pemberton" --chms-id M201 --coordinator-of "Connect Card Coordinators" --local   # a sample coordinator: staff see it under Team (non-staff see nothing until live)
curl -X POST 'http://localhost:8787/run?force=1' -H "X-Job-Trigger-Key: <JOB_TRIGGER_KEY from .dev.vars>"
npm test && npm run typecheck
```

Open the printed `http://localhost:8788/l/<token>` link (printed once; run `add-leader` again with `--new-link` for another). Push needs real Google Chrome (or Safari/Firefox); Playwright's bundled Chromium cannot subscribe. On localhost, `?mock=leader` or `?mock=admin` shows the views with built-in sample data and no API. Before-launch (non-staff) previews: `?mock=prelaunch` (starts at onboarding; add `&fake=1` to click through to the finished screen), `?mock=prelaunch-off` (notifications not on: the "finish setting up" screen) and `?mock=prelaunch-done` (the "you're all set" screen). `?mock=admin-sample` shows staff with the "sample data" note, `?mock=manager` a queue coordinator who is not staff. With either, `&tab=team` opens the Team tab and `&match=17` opens the Lead chooser on a leader who is not matched yet (`&match=11` on one who is). `&sim=ios-safari`, `&sim=denied` etc. still override the device situation.

## Deploy

**Automatic.** Merging to `main` deploys by itself (`.github/workflows/ci.yml`): tests and typecheck run, then database migrations, the site, and the morning-job worker, in that order. Pull requests run tests and typecheck only. It needs two repository secrets on GitHub: `CLOUDFLARE_API_TOKEN` (a Cloudflare API token limited to this account with Pages: Edit, Workers Scripts: Edit and D1: Edit) and `CLOUDFLARE_ACCOUNT_ID`. App secrets (VAPID keys, Pushpay credentials, `TOKEN_ENC_KEY` and so on) stay in Cloudflare and are not touched by a deploy. The manual commands below still work.


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
   Remove them for production (the defaults are `oauth.ccbchurch.com` and `api.ccbchurch.com`). `CHMS_SUBDOMAIN = "wildwood"` is already set in `wrangler.toml` (the site builds the approval link), so the Master Admin is not asked for the church subdomain.
3. Redeploy both (`npm run deploy && npm run deploy:cron`) so the new secrets and vars are picked up.
4. Send the church's Master Admin to `https://holynudge.cameronbristol.xyz/oauth/start?key=<OAUTH_SETUP_KEY>` (the key is in `.secrets.local`). They approve in Pushpay and land on "Holy Nudge is connected". The redirect URI is fixed to `https://holynudge.cameronbristol.xyz/oauth/callback`, exactly as registered.
5. Set `"dataSource": "pushpay"` in `config/holy-nudge.config.json`, redeploy both, and force a run. If ChMS returns fewer people than its own queue counts, the run fails and you get an alert rather than nudges from partial data.

6. Once the Master Admin has approved, remove or rotate `OAUTH_SETUP_KEY` so the setup link cannot be reused: `npx wrangler pages secret delete OAUTH_SETUP_KEY --project-name holy-nudge` (set a new one only when a re-approval is needed).

Until step 4 is done, `/oauth/start` shows "credentials are not configured yet" (or rejects a wrong key) and `/oauth/callback` shows a neutral "ready" page.

## If the connection is lost (re-approve)

Pushpay refresh tokens are single-use. If one is ever lost (a refresh response that never arrived, or a database write that failed), the owner gets the push "Holy Nudge lost its Pushpay connection. A Master Admin needs to approve it again." Until then the app shows "we couldn't load your list" and no nudges go out. Fix: the Master Admin opens the same `/oauth/start?key=...` link again and approves. The new token replaces the old one; nothing else to do. Other failures send a different alert ("could not read ChMS", "only got part of the ChMS data"); check `job_runs` and the Worker logs.

## When nudges go out

The rules below were decided on purpose; the reasons, and the other standing decisions, are listed in [docs/DECISIONS.md](docs/DECISIONS.md). Check there before changing any of them.

The morning job decides, person by person, whether there is anything worth a push. It follows the church's written process: coordinators send a first text within 72 hours and assign the card, and the assigned leader follows up within a week.

- **Your own students.** A push the first morning a student assigned to you arrives Not Started, then quiet for their first week, then every morning once they are overdue, until Done. Overdue means past the Lead due date or, with no due date, still Not Started after 7 days (`followUpDays`). In Process or Waiting with no due date never triggers a push.
- **Unassigned students** (queue coordinators and staff). A push the morning one arrives, then every morning once they have waited more than 72 hours (`firstTextHours`) with nobody assigned.
- **Other leaders' students** (queue coordinators and staff). Only once one is overdue. Someone else getting a new student is not a reason to nudge you. This is a design decision, not a gap: an assigned student has an owner, who gets the day-one nudge and the first week to follow up. Coordinators and staff are pulled in by a push only when that week has run out; until then the student is on their Behind list in the app whenever they look.

Still at most one push per person, and when it goes out it carries the full counts, the same numbers the app shows, not just what triggered it. The app's lists are unchanged, except that the Unassigned tab now lists every unassigned student however recently they arrived.

"New" means the student entered the queue after the last successful morning run started (the very first run counts the last 24 hours). Nothing about students is kept to work this out, only the time of each run in `job_runs`. Lead may give only a date for when someone entered a queue; such a student counts from the end of that day, so they can be nudged two mornings running but are never missed. A failed run does not count, page views never move it, a push that was due but reached none of a person's devices is tried again the next morning for that person alone (the run summary keeps their leader row id and the window start in `retryFrom`, nothing about students), and each run's summary counts how many people were skipped for having nothing new or overdue (`skippedNothingNewOrOverdue`). Lead does not say when a card was assigned, so a student assigned to you days after they arrived is not "new" for you: they appear on your list at once, and the push follows once they are overdue.

## Configuration

`config/holy-nudge.config.json` (bundled at deploy, so redeploy both after editing):

- `processId`: the ChMS process (College New Student is `"37"`).
- `excludedQueues`: queue names (exact) or ids to ignore, such as the "DONE- do not move here unless you have left a note" and "Not Interested" parking queues.
- `timeZone`, `morningHour`: when the nudge goes out.
- `followUpDays` (default 7), `firstTextHours` (default 72): how long before a student counts as overdue for their leader, and how long one may wait unassigned, before the morning nudge repeats daily. See "When nudges go out".
- `chmsBaseUrl`, `queueUrlTemplate`: the "Open in ChMS" link (`{chmsBaseUrl}` and `{queueId}` are filled in). `adminQueueUrlTemplate` (optional) is the admin-view link: one queue, one status, every assignee (`{statusId}` is filled in).

## Adding leaders and sending links

Once real data is connected, the daily job creates a leader row for everyone it sees as an assignee or queue manager, but **without a link**. On sample data it creates none: the invented sample people never become leader rows, so the Team tab lists only people you have added yourself. Staff (rows flagged `--admin`, which includes the owner) can also add someone who is not in ChMS yet from the Team tab: type their name under **Add a leader** and the app makes their row and first link (shown once, with Copy and Email). Choose **Servant leader** (default: sees only students assigned to them) or **Staff** (sees every queue, can add people and manage links; the app asks you to confirm first). It never makes an owner, and a name already on the list is refused (use **New link** on that row). Link actions are in each row's **⋯** menu, next to the bell: staff open the Team tab, find the leader, tap **⋯** and **New link** (or **Make a link** for someone without one): the link is shown once, with Copy and Email. Making a new link turns the old one off. **Turn off link** in the same menu stops a link at once and removes that leader's notifications. Only the owner can change the owner's link (other staff see no menu on that row), and nobody can turn off their own link from the app (make yourself a new one instead). Each row shows a bell for notifications (a bell with a strike through it means off) and a Staff chip for staff. Queue coordinators who are not staff see their queues' summary and who has not turned on notifications, but have no link controls; staff see "Coordinates ..." under each coordinator.

**Queue coordinators.** Seeing a whole queue (its Unassigned, Behind and Team lists, and the morning summary) is for staff and for people marked as that queue's coordinator, nobody else. Being a queue manager in Lead does not count (every team member is one). The marks live in the database (table `queue_coordinators`), not in Lead or in this repo, and are set from the command line only (`--coordinator-of` below). They belong to the person's row, so they work before the row is matched to Lead and follow the row through a match. A queue is named by its Lead id or its exact name (case and spaces count); a name that matches no queue, or an excluded queue, grants nothing. With nobody marked, only staff see whole queues. Someone who is staff and a coordinator keeps staff access.

**Matching to Lead.** What a leader sees comes from their ChMS ("Lead") identity, and someone added by name has none, so the app ties them to their Lead person. Automatically (every morning run and every staff page view, on real data only; on sample data nothing is created or matched): a row with no ChMS id is matched when its name equals a Lead person's name (ignoring case and extra spaces), nobody else without a ChMS id has that name, no other Lead person has that name, and that Lead person is not already held by a row in use (a working link, staff or owner, or devices). The row with the link keeps everything (link, notifications, role, last opened) and takes the ChMS id; the spare row the app had made for that person from Lead data is removed. Anything less certain is left alone, because a wrong match would show one leader another leader's students. Next to each name with a working link is a small status icon: a check in a circle (matched) or a dashed circle with a question mark (not matched). On an unmatched row the icon opens a chooser of Lead people nobody is matched to yet. At the top, up to three **Suggested** people whose names look like the leader's (scored in the browser by `public/name-match.js`: same name in any order, ignoring case, accents, punctuation, suffixes and middle initials; common nicknames such as Bill/William; short forms such as Sam/Samuel; going by a middle name; a first initial; small typos; one part of a hyphenated surname). A shared surname alone counts for little, since siblings and spouses share one. When one person clearly stands out (a high score and well ahead of the next), they carry a quiet "Likely match" tag; if two people look equally strong, neither does. This is only a hint for staff: nothing is preselected, and the automatic matching above never uses it. Below is a search box, starting with the leader's first name, that filters everyone else as you type (any part of a name, accents ignored, nicknames and small typos tolerated); clear it to see everyone, best guesses first. Tap a person, then **Match** (or **Change match**) to confirm. The icon on a matched row opens the chooser to change or clear the match; clearing keeps the link, and a row whose match staff set or cleared by hand is never changed automatically again. Only the owner can change the owner's match. A Lead person shows up only once they appear in Lead data (assigned a student, or managing a queue). While on sample data the list holds the sample people; any match made to one points at a made-up person, so clear it (or match again) once real data is connected.

From the command line (prints a link only when it makes one, and only once):

```sh
npm run add-leader -- --name "Name" --chms-id <ChMS individual id> [--admin] [--owner] [--new-link] [--coordinator-of "<queue id or exact name>" ...] [--clear-coordinator] --remote
npm run revoke-leader -- (--id <leader id> | --chms-id <ChMS id>) --remote
npm run list-leaders -- [--stale-days 60] --remote      # no tokens; shows Lead match and coordinated queues; --stale-days lists links not used in N days
```

`add-leader` on someone who already exists (found by `--chms-id`, or without it by name among people not yet matched to Lead) updates their name and raises flags but keeps their link, unless you pass `--new-link`. `--coordinator-of` (repeatable) sets, replacing what was there, the queues they coordinate, for example `--name "Sam Fakename" --coordinator-of "Service Team" --coordinator-of 4`; leave it out to keep what they have, or pass `--clear-coordinator` to remove them all. It warns about a name that grants nothing. `--admin` makes them staff (whole-process view and link management); `--owner` adds failure alerts. While `dataSource` is `fixture`, `--chms-id` may be left out (a real volunteer before launch) or must be one of the sample ids in `fixtures/people.json`; and only staff see sample data or get sample nudges. Everyone else is set up for notifications and sees a "you're all set" screen until real data is connected (`dataSource` is not `fixture`). Admin and owner rows keep the name you give them; other names follow ChMS.

Email each leader their link once. On iPhone: open it in Safari, tap Share, then "Add to Home Screen", open Holy Nudge from the Home Screen, and tap "Turn on notifications" (iOS 16.4 or later). The app walks them through it. The link is the only key, so treat it like a password. If someone gets a new link, an iPhone Home Screen copy made from the old link stops working: they delete it and add the new link to the Home Screen again (the app on that phone tells them their link is not valid any more).

## Data handling

What is stored (D1, the only database):
- Queue coordinators: leader row and queue id or name.
- Leaders: name, ChMS individual id, staff/owner flags, SHA-256 hash of their link token (never the link itself), when they last opened the app, whether the link was turned off, whether staff set their Lead match by hand.
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

## Brand

Holy Nudge wears the Wildwood College brand (from the ministry's Branding 2026 guide).

- **Colours.** The two brand primaries, Navy `#29303E` and Dark Sage `#68866F`, plus white. Everything else is a tint or shade of those, defined once as CSS custom properties at the top of `public/styles.css` (light, and dark under `prefers-color-scheme`). Raw sage is only about 4:1 against white, so it is used for outlines, rings, step circles, glyphs and the done mark, never for small text: primary buttons are navy with white text (light) and a light sage tint with navy text (dark). One muted clay (`#98522A` light, `#E6AD7E` dark) is the only attention colour: the "N days overdue" line, its card stripe, and real error messages. Every text/background pair passes WCAG AA (4.5:1 for text, 3:1 for outlines and marks) in both modes; the lowest are the clay on the sage notice panel (4.72:1, light) and chip labels (5.58:1 light, 5.98:1 dark). Recheck any new pair before using it. The OAuth pages' single inline `<style>` uses the same colours; if you change it, update `OAUTH_PAGE_STYLE_HASH` in `src/chms/oauth.ts` (`test/headers.test.ts` recomputes it).
- **Type.** The guide uses Gotham Black for headings and Gotham Book for text. Gotham is a commercial font and this repo and site are public, so it is not used anywhere here. **Montserrat** (SIL Open Font License 1.1, the closest free geometric match) stands in: one variable woff2, Latin subset, weights 100 to 900, `public/fonts/montserrat-latin-wght.woff2` (38 KB), from npm `@fontsource-variable/montserrat` 5.3.0 (Fontsource's build of the Google Fonts release, v31). Licence text: `public/fonts/OFL.txt`. Self-hosted because the CSP allows no external hosts; `font-display: swap` with a system fallback stack.
- **Holy Nudge wordmark.** Not an image: the app icon plus live text ("HOLY" heavy over "NUDGE" light, echoing the WILDWOOD / COLLEGE lockup), coloured by the stylesheet tokens, built by `wordmark()` in `public/app.js`.
- **App icon.** The smiling bell with a halo, on navy. Source: `public/icon.svg` (full bleed) and `public/favicon.svg` (rounded). The PNGs (`favicon-32`, `icon-192`, `icon-512`, `icon-maskable-512` with the artwork at 80% on a navy bleed, `apple-touch-icon` 180 opaque) are generated from them.
- **Link previews.** `public/og.png` (1200x630) is drawn in `scripts/brand/og.html` and rendered with headless Chrome. The Open Graph / Twitter tags in `public/index.html` are generic on purpose and are served unchanged on `/l/<token>`, so they must never contain a token, a name or a count.
- **Wildwood College logo.** The official secondary lockup (sprig + WILDWOOD COLLEGE), `SECONDARY LOGO/WC_SECONDARY_navy_2.png` and `WC_SECONDARY_white_2.png` from the Branding 2026 folder, resized and compressed only: `public/brand/wildwood-college-navy.png` (light) and `-white.png` (dark), swapped by the stylesheet. It sits small at the foot of each screen. Do not recolour, crop or redraw it.
- **Match icons.** `public/match-ok.svg` and `public/match-none.svg` are the Team tab's Lead match status icons (CSS masks like the bells: sage check in a circle when matched, clay dashed circle with a question mark when not).
- **Bells.** `public/bell.svg` and `public/bell-off.svg` are the Team tab's notification icons (CSS masks, sage when on, clay with a strike through when off, so status is never colour alone).
- **Sprig.** `public/sprig.svg` is a simple leaf sprig drawn for the empty states (a CSS mask, coloured sage). It is not cut from the Wildwood logo.

Regenerate the PNGs after editing a source (uses the `sharp` that wrangler already installs; `--og` needs Google Chrome):

```sh
node scripts/gen-brand-assets.mjs --og
# also refresh the Wildwood College logos from the official folder:
node scripts/gen-brand-assets.mjs --wildwood "/path/to/Branding 2026"
```

Bump `CACHE` in `public/sw.js` whenever a cached shell asset changes.

## Not yet verified

- Migration 0003, the security headers and the CSP were checked locally (wrangler pages dev, curl, and the desktop app's browser pane, which cannot register service workers at all). Not yet checked on the deployed site or on an iPhone Home Screen app: service worker registration, the manifest and notifications under the new CSP, and an installed app switching to a self-rotated link.
- Everything marked `SANDBOX:` in `src/chms/` (token endpoint body format, whether the API returns every assignee's people under the approving admin, paging headers, date formats, phone numbers on queue rows, rate-limit headers). Needs the sandbox credentials.
- The "Open in ChMS" link pattern (`queueUrlTemplate`) comes from real queue URLs, but it assumes the API queue id equals the web `step_id`; confirm by tapping a link once live data is on. The web status number for In Process (1) is inferred; Not Started (3), Waiting (0) and Done (2) come from real URLs.
