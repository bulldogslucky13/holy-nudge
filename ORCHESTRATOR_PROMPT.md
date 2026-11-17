# Holy Nudge: build brief

Act as orchestrator for this project: you plan, delegate implementation to worker subagents, review their work, and talk to me (Cameron). Work in `~/dev/holy-push` (empty folder; init a git repo there).

## First: start a DNS session

Before anything else, start a separate session whose only job is to walk me through DNS setup for `holynudge.cameronbristol.xyz`. It should be interactive and step by step: first find out where `cameronbristol.xyz`'s DNS is managed (ask me, or check with `dig NS`), then guide me through adding the subdomain record pointing at wherever this app ends up hosted. It must not change anything on my accounts itself; I click the buttons. It will need the hosting decision from you (see "Hosting"), so settle that early and pass it on.

## What we're building

Holy Nudge is a small installable web app (PWA) with free web push notifications for Wildwood Community Church's college ministry.

The problem: volunteer "servant leaders" process new-student Connect Cards through process queues in our church management system (Pushpay ChMS, formerly CCB, at wildwood.ccbchurch.com). They fall behind. The system only emails a "due soon" reminder; it sends nothing for overdue or untouched people, and the emails get ignored.

What the app does:

1. A daily morning job reads the queues and the people in them.
2. A person is **behind** if their status is Not Started, or their status is anything other than Done and their due date has passed.
3. Each leader with people behind gets one push: e.g. "Holy Nudge: 3 students are waiting on you". Tapping it opens their list, with tap-to-text, tap-to-call, and a link to the queue in ChMS for each person.
4. Admins (a staff member or team leader per queue) get a summary push. Their view shows everyone unassigned for more than 24 hours and everyone behind, grouped by leader. It also shows which leaders have not enabled notifications.
5. Leaders get in via a personal link emailed once; they add the app to their Home Screen and tap "Turn on notifications". No passwords.

## Hard constraints

- **Read-only.** The app never writes to ChMS. Never change any setting on wildwood.ccbchurch.com or on my accounts without my explicit approval.
- **Free.** No paid services. Web push (VAPID) costs nothing per message.
- **Privacy.** These are real students. Push payloads carry counts only, never student names or contact details; those appear only inside the app behind the leader's personal link. No real personal data in the repo, fixtures, logs, or commits. Secrets (client secret, refresh token, VAPID private key) live in the host's secret store, never in git.
- **iPhone.** Web push on iOS only works after the app is added to the Home Screen from Safari (iOS 16.4+). The onboarding screen must walk people through this, since most leaders are college students on iPhones.

## Data source: Pushpay ChMS v2 API

API access was requested on 2026-11-17 (request #802, app name "Holy Nudge", up to three business days). Credentials will be emailed to me; they have not arrived. Until they do, build against sample data behind a data-source interface, so the live connection is the only piece left.

- Docs index: https://docs.pushpay.io/chms-v2/llms.txt. Read the getting-started page and the "Process Queues - Automating Workflows" guide before designing the data layer.
- OAuth 2.0 authorization code flow. Redirect URI is registered as exactly `https://holynudge.cameronbristol.xyz/oauth/callback` and must match character for character.
- A church Master Admin approves the app once (I am not one; I'll arrange it). After that the app runs on refresh tokens.
- Access tokens last 2 hours. Refresh tokens are single-use and rotate: each refresh returns a new one and revokes the old. Persist the new refresh token atomically before using the access token, and never let two jobs refresh at once, or the connection is lost and the admin must re-approve.
- API base is `https://api.ccbchurch.com`. Sandbox uses `beta-oauth.ccbchurch.com` and `api-beta.ccbchurch.com`, with separate credentials.
- Scopes granted (assuming approval as requested): `read:process_queues`, `read:queue_individuals`, `read:individuals`, `read:forms`, `read:form_responses`, `read:individual_forms`. The form scopes are for a later feature (showing Connect Card answers); do not build that now.
- Useful endpoints: `GET /processes`, `GET /queues`, `GET /queues/{queue_id}` (includes managers), `GET /queues_individuals` (filters: `statuses`, `assignment`, paging). Queue individuals carry `status`, `due`, `created`, `completed`, `assignee`, and a nested `individual`.

Things I could not verify, which you should check against the docs and then the sandbox:

- `GET /queues_individuals` has an `assignment` filter of `ASSIGNED_TO_ME` or `UNASSIGNED`. It may return only what the authorizing user can see. We need every person in every queue with their assignee, so confirm how to get that.
- Whether phone numbers come back on queue individuals or need a separate individuals call.
- Rate limits.

**Workflows migration.** Pushpay is replacing Process Queues with Workflows (process = workflow, queue = step, queue manager = step guide), and our church plans to migrate soon. The docs say the queue endpoints stop working for a church once it migrates, and Workflows endpoints were not public as of October 2026. I asked Pushpay about the timeline in the request. Keep everything ChMS-specific behind one interface so swapping to Workflows endpoints is a contained change, and make the job fail loudly (notify me) if the API starts erroring.

## What the real data looks like

One process matters: **College New Student** (process id 37). Its queues as of 2026-11-17:

- Welcome Email - Campus, Welcome Email - Wildwood (automated, all Done)
- Connect Card Coordinators (10 unassigned and Not Started, 8-15 days overdue)
- Outreach Team, Staff, Bible Study Hosts & Events Team, Service Team, Sunday Morning Team (each has people Not Started; Staff has 31 In Process)
- Interested, Maybe Interested?
- "DONE- do not move here unless you have left a note" (319 Not Started, 318 unassigned) and Not Interested

The last two are parking queues. They must be excluded or every alert is noise. Make the excluded queues, the process ID, and the admin-per-queue mapping configuration, not code. I still owe you the admin mapping; ask me for it when you need it, and default to each queue's managers until then.

Statuses are Not Started, In Process, Waiting, Done. In ChMS, Waiting hides a person until their due date, so a Waiting person with a future due date is not behind.

## Hosting

Not decided. The app needs: static hosting for the PWA, a daily scheduled job, a small database (push subscriptions, leader tokens, the rotating refresh token), and a secret store. Cloudflare's free plan (Workers, Cron Triggers, D1 or KV) covers all of it and was my working assumption. My personal site is `cameronbristol.xyz` (possibly the repo at `~/dev/main-site`; look at how it's hosted, read-only). Recommend one option to me with a one-line reason, get my yes, then tell the DNS session what record to create.

## How to run this

- Start with a short written plan and the hosting recommendation, and wait for my OK before building.
- Sensible build order: data-source interface with realistic fake fixtures; the "who is behind" logic with unit tests (this is the heart of it; test the status and due-date edge cases and time zones, we're in US Central); push subscription and delivery; the leader and admin views; onboarding; the OAuth connection and token rotation; deployment.
- Verify with real signals: tests for the logic, and an actual push delivered to a browser from the deployed or locally running app. Tell me plainly what you could not verify, in particular anything that needs the real credentials or a real iPhone.
- Done means: deployed at `https://holynudge.cameronbristol.xyz` running on sample data, a push arrives on my phone after I install it, the OAuth callback route is live and ready for the Master Admin's approval, and a short README covers how to add credentials, configure queues and admins, and re-approve if the token is lost.

Keep the design simple and friendly; the name is playful and the tone of the notifications should be an encouraging nudge, not a nag.
