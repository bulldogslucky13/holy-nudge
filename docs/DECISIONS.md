# Decisions

Things that were decided on purpose. If the app does something that looks like a gap or an oversight, check here first: it may be deliberate.

**Before changing anything listed here, ask Cameron.** A change to one of these is a product decision, not a bug fix. When a new decision is made, add an entry (newest at the bottom of its section) in the same pull request as the code.

Each entry says what was decided, why, and where it is enforced. No real people's names, ids or contact details belong in this file: the repo is public.

## Ground rules

### 1. Read-only against Lead
- **Decision:** The app never writes to Pushpay ChMS (Lead). It reads queues and people, nothing else.
- **Why:** Lead is the church's record. A side project must not be able to damage it, and read-only is what the Master Admin is asked to approve.
- **Where:** `src/chms/` makes only GET requests apart from the OAuth token exchange and refresh. Original brief.

### 2. Free to run
- **Decision:** No paid services. Cloudflare free plan, web push (VAPID).
- **Why:** There is no budget, and nothing here needs one.
- **Where:** README "Hosting". Original brief.

### 3. Push messages carry counts only
- **Decision:** A notification says how many students are waiting, never who. Names and phone numbers appear only inside the app, behind the leader's personal link.
- **Why:** These are real students. A lock screen is not private.
- **Where:** `src/push/`, `test/push.test.ts`, `test/job.test.ts`. Original brief.

### 4. Student data is never stored
- **Decision:** Student names, phones and queue details are read live from Lead for each page view and discarded. They are not in the database, the logs, or the phone's storage. Student email is dropped before it reaches the app.
- **Why:** What is not kept cannot leak. It also keeps the promise made in the data-handling summary given to the church.
- **Where:** README "Data handling", `docs/ARCHITECTURE.md` "Privacy rules for all code". This is why "new" is worked out from run times, not from a record of students (see 12).

### 5. No real personal data or secrets in the repo
- **Decision:** Fixtures, tests, docs, logs and commits use invented names, `555-01xx` numbers and `example.com` addresses. Secrets live in Cloudflare's secret store. The leader roster and who coordinates which queue live outside the repo.
- **Why:** The repo is public.
- **Where:** `docs/ARCHITECTURE.md` "Privacy rules for all code"; `scripts/add-leader.mjs` refuses real Lead ids while the data source is the sample data.

### 6. A personal link is the only way in
- **Decision:** Each leader gets a personal link issued by staff. Only a hash of it is stored. Staff can turn one off or replace it in one tap. There are no passwords or accounts.
- **Why:** Servant leaders are volunteers; a login is one more thing to lose. The link is a key, and the risk is accepted and stated in the data-handling summary.
- **Where:** `src/api/`, `test/links.test.ts`, README "Adding leaders and sending links".

### 7. An encouraging nudge, not a nag
- **Decision:** Wording and frequency should encourage. When in doubt, send less.
- **Why:** Leaders are volunteers. A tool that nags gets its notifications turned off. Most timing decisions below follow from this.
- **Where:** Original brief.

### 8. iPhone setup is walked through in the app
- **Decision:** Onboarding shows the Add to Home Screen steps before asking for notifications.
- **Why:** Web push on iOS works only from a Home Screen app opened from Safari (iOS 16.4+). Without the walk-through most iPhone users would never get a nudge.
- **Where:** `public/app.js` onboarding. Original brief.

## Who sees what

### 9. A whole-queue view is for staff and marked coordinators only
- **Decision:** Seeing everyone in a queue (Unassigned, Behind, Team, and the morning summary) is for staff (every queue) and people marked as that queue's coordinator (that queue). Everyone else sees only students assigned to them.
- **Why:** Least access. A servant leader needs their own students, not the whole list.
- **Where:** `src/core/behind.ts` "whole-queue scope", `src/api/me.ts`, `test/me.test.ts`. Decided 2026-11-19.

### 10. Being a queue manager in Lead grants nothing
- **Decision:** Lead's "queue manager" field is not used to decide access.
- **Why:** In Lead every team member is a manager of their own queue, so the field cannot tell a coordinator from a member. An earlier version used it as a fallback; that was removed on purpose.
- **Where:** `src/core/behind.ts`, `test/behind.test.ts`. Decided 2026-11-19.

### 11. Coordinators are marked in the database, by hand
- **Decision:** Coordinator marks live in the `queue_coordinators` table and are set only from the command line (`add-leader --coordinator-of`). They are not in Lead, not in the config file, and not in this repo. The mark belongs to the person's row in the app, so it works before that row is matched to Lead.
- **Why:** The list names real people, so it cannot be in a public repo, and Lead has no field that means it (see 10).
- **Where:** `migrations/0005_queue_coordinators.sql`, `scripts/add-leader.mjs`. Decided 2026-11-19.

### 12. Coordinating one queue does not open the queues it feeds
- **Decision:** The coordinators of the intake queue, who move students on to the team queues, do not see those team queues. Each team queue has its own coordinator.
- **Why:** The church's process hands responsibility on with the card. Once a student is moved, the next coordinator owns the follow-up.
- **Where:** Follows from 9 and 11: scope is exactly the queues a person is marked for. Decided 2026-11-19.

### 13. Staff who also coordinate keep staff access
- **Decision:** A person who is staff and a coordinator sees every queue. The coordinator mark is kept so the Team tab shows what they coordinate.
- **Where:** `src/api/me.ts`. Decided 2026-11-19.

### 14. The DONE and Not Interested queues are ignored
- **Decision:** Queues listed in `excludedQueues` are dropped before anything is counted or shown.
- **Why:** Nobody in them is waiting on follow-up.
- **Where:** `config/holy-nudge.config.json`, `filterExcludedQueues` in `src/core/behind.ts`.

## When nudges go out

### 15. Nudge on day one, then only when overdue
- **Decision:** A leader gets a push the first morning a student assigned to them arrives Not Started, then nothing during the follow-up week, then one every morning once the student is overdue, until Done. Overdue means past the Lead due date or, with no due date, still Not Started after `followUpDays` (7). In Process or Waiting with no due date never triggers a push.
- **Why:** The church's process gives a leader a week. A daily reminder inside that week is a nag (see 7).
- **Where:** `ownTriggered`, `isOverdue` in `src/core/behind.ts`; `test/behind.test.ts`, `test/job.test.ts`. Decided 2026-11-19.

### 16. Unassigned students: at once, then daily after 72 hours
- **Decision:** Coordinators and staff get a push the morning an unassigned student arrives, then every morning once the student has waited more than `firstTextHours` (72) with nobody assigned. The Unassigned list in the app shows every unassigned student however recently they arrived.
- **Why:** The church's process: coordinators send a first text and assign the card within 72 hours.
- **Where:** `summaryTriggered`, `isPastFirstText`, `isUnassigned` in `src/core/behind.ts`. Decided 2026-11-19.

### 17. Summaries skip other people's new assignments
- **Decision:** A coordinator or staff member gets a summary push about an **assigned** student only once that student is overdue. A newly assigned, Not Started student triggers a push for the assignee alone.
- **Why:** An assigned student has an owner, who gets the day-one nudge and the week to follow up. Coordinators and staff are escalated to only when that week has run out. Until then the student is on their Behind list in the app whenever they look. This is not a gap; do not add a day-one summary trigger for assigned students.
- **Where:** `summaryTriggered` in `src/core/behind.ts`; `test/behind.test.ts` ("does not fire just because someone else got a new assignment"), `test/job.test.ts`. Decided 2026-11-20.

### 18. One push per person per morning
- **Decision:** At most one notification each morning, at 8am Central. Someone with their own students and a summary gets both in one message. When a push goes out it carries the full counts, the same numbers the app shows.
- **Why:** See 7.
- **Where:** `src/job/daily.ts`, `test/job.test.ts`.

### 19. "New" is worked out without remembering students
- **Decision:** A student is new if they entered the queue after the last successful morning run started (the first run ever looks back 24 hours). A date-only entry time counts as the end of that day, so a student can be "new" two mornings running but is never missed. A failed run does not move the window. A push that reached none of a person's devices is retried the next morning for that person alone.
- **Why:** Keeps 4 (no student data stored). One possible repeat is preferred to a miss.
- **Accepted limit:** Lead does not say when a card was assigned. A student assigned to a leader days after entering the queue is not "new" for that leader: they appear on the list at once and the push follows when overdue.
- **Where:** `isNewSinceLastRun` in `src/core/behind.ts`, `retryFrom` in `src/job/daily.ts`. Decided 2026-11-19.

## Connection to Pushpay

### 20. Refresh tokens are rotated carefully
- **Decision:** Pushpay refresh tokens are single-use. The new one is saved before the new access token is used, and two jobs never refresh at once. Tokens are stored encrypted.
- **Why:** Losing a rotated token means the Master Admin has to approve the app again.
- **Where:** `src/chms/`, `test/tokens.test.ts`, `test/oauth.test.ts`. Original brief.

### 21. Form access is requested but nothing uses it
- **Decision:** The approval asks for all six scopes, including form (Connect Card) read access kept for a possible later feature. That feature is not built and must not be started without Cameron asking for it.
- **Open:** The church may ask for the form access to be dropped before the Master Admin approves. Until then, keep all six.
- **Where:** `src/chms/oauth.ts` scopes. Original brief.

### 22. Sample data until the church approves
- **Decision:** `dataSource` stays `fixture` (invented sample data) until the Master Admin has approved the app and Cameron says to switch. While it is `fixture`, only staff are nudged and nobody else sees anything.
- **Where:** `config/holy-nudge.config.json`, `src/job/daily.ts`, `test/prelaunch.test.ts`.

## Operations

### 23. No branch preview deployments
- **Decision:** Deploy only to production. Do not use Cloudflare Pages preview deployments.
- **Why:** A preview is bound to the production database (real leader rows, real Pushpay tokens) and runs whatever code the branch has.
- **Where:** README "Data handling".
