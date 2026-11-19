# Pushpay ChMS v2 API: implementation notes

Written 2026-11-17 from the public docs only. No API call has been made. Tags: **CONFIRMED BY DOCS**, **INFERRED**, **UNKNOWN (needs sandbox)**, and **VERIFIED RAW** (re-checked against the raw primary source, see below).

**Re-verification, 2026-11-17 (OAuth worker).** The first pass was read through a summarising fetch tool. The OAuth worker then downloaded the raw sources and checked every OAuth and Process Queue claim against them:

- Raw guide markdown: `docs/getting-started.md` (page `updatedAt` 2026-10-16), `docs/general.md` (2026-10-07), `docs/process-queues-automating-workflows.md` (2026-11-17, updated the same day).
- Raw OpenAPI 3.0.3 JSON: **`https://docs.pushpay.io/chms-v2/openapi/chms-api-specs.json`**. Note `https://docs.pushpay.io/chms-v2/openapi` (cited below) is only an HTML index linking to that file.
- `reference/getaccesstoken.md` (page `updatedAt` 2026-04-20) embeds the `/oauth/token` OpenAPI fragment.

Corrections from that pass are marked **CORRECTED** inline; the implementation (`src/chms/oauth.ts`, `tokens.ts`, `pushpay.ts`) follows this file, and every guess in code carries a `// SANDBOX:` comment that matches an item in the open-questions list.

Doc URLs (all under `https://docs.pushpay.io/chms-v2/`):

- Index: `llms.txt`
- Getting started (OAuth): `docs/getting-started.md` (call it GS)
- General (rate limits, paging): `docs/general.md` (call it GEN)
- Process Queues guide: `docs/process-queues-automating-workflows.md` (call it PQ)
- Token reference: `reference/getaccesstoken.md` (TOK)
- `reference/getprocesses.md`, `reference/listqueues.md`, `reference/getprocessqueues.md` (deprecated), `reference/getqueue.md`, `reference/getstepindividuals.md` (`GET /queues_individuals`), `reference/getstepindividual.md`, `reference/getindividual.md`, `reference/getindividuals.md`
- Workflows: `reference/listworkflows.md`, `reference/getworkflowmanagers.md`

Note: the first pass read the doc pages through a summarising fetch tool. The raw OpenAPI JSON (URL above) and raw guide markdown were re-read before coding; see the re-verification note.

## 1. OAuth

| Item | Value | Status / source |
|---|---|---|
| Authorize URL (prod) | `https://oauth.ccbchurch.com/oauth/authorize` | CONFIRMED BY DOCS, GS, TOK |
| Authorize URL (sandbox) | `https://beta-oauth.ccbchurch.com/oauth/authorize` | CONFIRMED BY DOCS, GS |
| Token URL (prod) | `https://api.ccbchurch.com/oauth/token` | CONFIRMED BY DOCS, GS, TOK |
| Token URL (sandbox) | `https://api-beta.ccbchurch.com/oauth/token` | CONFIRMED BY DOCS, GS |
| API host | `https://api.ccbchurch.com` (sandbox `https://api-beta.ccbchurch.com`). Never call `[subdomain].ccbchurch.com` for API calls. | CONFIRMED BY DOCS, GS, TOK |
| Sandbox vs prod credentials | Separate; mixing gives `invalid_client` | CONFIRMED BY DOCS, GS |

Authorize query params (GET in browser; GS): `client_id` (required), `response_type=code` (required), `redirect_uri` (required, exact match including scheme, port, path, trailing slash, URL-encoded), `state` (recommended, returned unchanged; verify it), `subdomain` (optional, skips the subdomain prompt), `scope` (optional, space-separated subset of granted scopes; omitted = all granted), `resource_owner_auth=true` (Identity Auth only; omit for System Auth). CONFIRMED BY DOCS.

Who authorizes: a Master Administrator or a user allowed to edit system-wide settings; one time per church (System Auth, the default). CONFIRMED BY DOCS, GS.

Callback: `redirect_uri?code=...&state=...`. Code is short-lived and single-use. A `redirect_uri` mismatch at exchange fails AND burns the code. CONFIRMED BY DOCS, GS.

Authorization-code exchange (server-side POST to token URL), per GS:

- Headers: `Accept: application/vnd.ccbchurch.v2+json`, `Content-Type: application/x-www-form-urlencoded`.
- Body: `grant_type=authorization_code`, `code`, `redirect_uri` (identical to step 1), `client_id`, `client_secret`. Do not send `subdomain` here (GS).
- Response 200: `access_token`, `token_type` ("bearer"), `expires_in` (7200), `scope` (may be fewer than requested), `refresh_token`.

Refresh (GS): same URL and headers. Body `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`. `scope` is not accepted; scopes carry over. Response has a new `access_token` and a new `refresh_token`.

How client credentials are sent: GS says in the body, OR via a Basic `Authorization` header (`Basic base64(client_id:client_secret)`) as an alternative; with the header, `client_id`/`client_secret` are not needed in the body. VERIFIED RAW (GS). This is not a contradiction: they are documented alternatives, and GS's own curl examples use the body. **Implemented: credentials in the form body, no Basic header.**

**Doc conflict (TOK vs GS): real, not a summariser artefact.** VERIFIED RAW. The raw OpenAPI `getAccessToken` operation declares only an `application/json` request body whose `required` list is `client_id, client_secret, grant_type, subdomain`, with examples that send `subdomain` for both grants. The raw GS (newer: 2026-10-16 vs 2026-04-20) says `Content-Type: application/x-www-form-urlencoded`, gives `--data-urlencode` curl examples, and says "You don't send `subdomain` here, because the code already identifies the church." **Implemented: GS (form-encoded, no `subdomain`)**, because it is newer, explicit, and matches RFC 6749. If the sandbox rejects it, the JSON-with-subdomain variant is the fallback (one function, `requestToken` in `src/chms/oauth.ts`). Do not experiment with a live authorization code: a failed exchange may burn it. Test with a refresh token instead, which a 4xx does not rotate. UNKNOWN (needs sandbox).

Scopes: `read:process_queues`, `read:queue_individuals`, `read:individuals`, `read:forms`, `read:form_responses`, `read:individual_forms` all exist in the OpenAPI `oauth2` scheme's scope list. VERIFIED RAW. The authorize request sends all six (space-separated `scope`).

Lifetimes and rotation (GS):

- Access token 2 hours (`expires_in: 7200`). CONFIRMED BY DOCS.
- Refresh token has no fixed expiry but is single-use. Each successful refresh issues a new refresh token and revokes the previous access and refresh tokens. Reusing an old refresh token returns `invalid_grant`. Docs say: if several workers share a token, only one should refresh, and persist the new pair before anything else uses it. CONFIRMED BY DOCS. This matches the brief.
- Church removing app approval also makes refresh fail with `invalid_grant`. CONFIRMED BY DOCS.
- Whether a failed network response to a refresh (token rotated server-side but we never saw the response) is recoverable: UNKNOWN (needs sandbox). Assume not; hence the persist-then-use rule and a lock.

Required headers on API calls (GS, PQ): `Authorization: Bearer <access_token>` and `Accept: application/vnd.ccbchurch.v2+json`. Write calls also need a JSON `Content-Type`; we are read-only so not needed. CONFIRMED BY DOCS.

OAuth error shape (GS): JSON `{ "error": "...", "error_description": "..." }`, HTTP 401 for all of `invalid_request` (bad/used/expired code, redirect mismatch, missing church approval), `invalid_client` (bad credentials, prod/sandbox mix), `invalid_grant` (unknown, rotated or revoked refresh token; approval removed; individual no longer valid), `unsupported_grant_type`. CONFIRMED BY DOCS.

## 2. Getting everyone in every queue, with assignee

Facts:

- `GET /queues_individuals`, scope `read:queue_individuals` ("Read individuals assigned to queues"). CONFIRMED BY DOCS (`getstepindividuals.md`).
- Query params listed in the reference spec: `per_page`, `page`, `statuses`, `assignment`. That is all. VERIFIED RAW. **CORRECTED detail:** the OpenAPI names the parameter `statuses` (no brackets) with `style: form, explode: true`, which by OpenAPI rules serialises as `statuses=A&statuses=B`. The PQ guide says array parameters must be sent as `statuses[]=A&statuses[]=B` and that a bare name returns 412. Implemented: literal `[]` (guide wins; it is newer and specific).
- `assignment` enum `ASSIGNED_TO_ME` | `UNASSIGNED`. Doc text: "If this param is not provided, both will be included." CONFIRMED BY DOCS. So omitting it returns assigned-to-me plus unassigned; the wording does NOT say "assigned to anyone". Whether people assigned to OTHER users are returned when the filter is omitted is UNKNOWN (needs sandbox). This is the biggest risk: the literal reading of the doc is that the result may be "mine + unassigned" only.
- **Contradiction inside the docs:** the PQ guide lists additional filters on `GET /queues_individuals`: `process_ids[]`, `queue_ids[]`, `campus_ids[]`, `search_term`, sorting. The reference page lists none of them. VERIFIED RAW (still true in the 2026-11-17 guide and the raw OpenAPI). Implemented: send `queue_ids[]`, always re-filter rows by `queue_id`, and if any foreign row appears, switch to one process-wide read per run (`process_ids[]`) grouped client-side. So a `queue_id` filter is documented in the guide but not in the reference spec. UNKNOWN (needs sandbox). Test `queue_ids[]=<id>` first; fallback is to fetch all pages and filter client-side by the `queue_id` field on each row (that field is in the response, CONFIRMED BY DOCS).
- PQ: array params MUST use `[]` (`statuses[]=...`); a bare param returns 412. CONFIRMED BY DOCS (PQ).
- PQ: if `statuses[]` is omitted, `DONE` entries are excluded (silently, can even give an empty list). VERIFIED RAW. **Decision changed:** the implementation passes all four statuses explicitly (`NOT_STARTED`, `IN_PROCESS`, `WAITING`, `DONE`), because the completeness check compares per-status row counts with `status_counts`, which includes `done`. DONE entries are still never behind; the core rules ignore them.
- Permissions: the only doc statement is generic, under Identity Auth: "Any permissions the authenticated individual has will be taken into account when API calls are made." The brief uses System Auth (church-level, Master Admin approves), where no individual permission filter is documented. Whether System Auth sees all queues regardless of queue manager membership: UNKNOWN (needs sandbox). `managed_by_me` exists on `/processes` and `/queues` (queues in processes managed by the requester); with System Auth it is probably irrelevant, INFERRED. Do NOT pass `managed_by_me`.
- A 403 on single-record endpoints means the caller lacks permission (`getstepindividual.md`). CONFIRMED BY DOCS.

Recommended calls (to test in sandbox in this order):

1. `GET /queues_individuals?statuses[]=NOT_STARTED&statuses[]=IN_PROCESS&statuses[]=WAITING&queue_ids[]=<id>&per_page=100&page=N`. If the `queue_ids[]` param is silently ignored, the response will contain other queues' rows (detect by comparing each row's `queue_id`).
2. Same without `queue_ids[]` and with `process_ids[]=37`; else no process filter and filter client-side by `queue.process_id` / `process.id` (both present on each row).
3. Compare counts against `GET /queues/{id}` `status_counts` (`not_started`, `in_process`, `waiting`, `unassigned`, `overdue`). That gives a built-in integrity check that we are seeing everyone: sum of rows per status must equal `status_counts`. Make the job alert if they disagree.
4. Compare `assigned_count` / `unassigned_count` on `GET /queues` rows too.

The `status_counts` check is the key safeguard against the "mine plus unassigned only" risk: if assigned-to-others rows are missing, counts will not match.

## 3. Queue individual response shape

`ProcessQueueIndividualDetail` (CONFIRMED BY DOCS, `getstepindividuals.md` and `getstepindividual.md`):

| Field | Type | Notes |
|---|---|---|
| `queue_individual_id` | integer | entry id |
| `queue_id` | integer | |
| `individual_id` | integer | |
| `status` | enum string | exactly `NOT_STARTED`, `WAITING`, `IN_PROCESS`, `DONE` |
| `due` | string, `format: date-time` | no example in docs; time zone not stated. UNKNOWN (needs sandbox) |
| `created` | string, date-time | same caveat |
| `completed` | string, date-time | PQ says unset reads as `-0001-11-30 00:00:00` (that is on update calls/PQ narrative; treat that value as null) |
| `process` | BasicProcessSerializer | `id, campus_id, owner_id, name, hidden, archived, managers, process_managers, status` |
| `queue` | BasicQueueSerializer | `id, process_id, process_campus_id, children, name, order_by, description, note, automations, assigned_count, unassigned_count, process_name, queue_managers, managers, integrations` |
| `individual` | BasicIndividualProfileSerializer | see section 4 |
| `assignee` | BasicIndividualProfileSerializer | null/absent when unassigned (INFERRED; schema does not say) |

Status strings match `Status` in ARCHITECTURE.md exactly (`NOT_STARTED`, `IN_PROCESS`, `WAITING`, `DONE`). VERIFIED RAW (`ProcessQueueStatuses` enum).

**CORRECTED (PQ guide, raw, 2026-11-17):** the guide's example list row and its notes say "`created`, `completed` and `due` are dates only (`YYYY-MM-DD`), without a time" and "`completed` appears only once the entry is `DONE`". The OpenAPI still types all three as `date-time`. Rows in the guide also carry an `overdue` boolean that is not in the OpenAPI schema. The guide's example `assignee` is `{ "id": 222, "name": "Sam Lee" }` (no contact fields) and an unassigned add returns `"assignee": null`; the example `individual` has `email` but no `phone`. The OpenAPI's own example for the date-typed `birthday` is `"2011-10-27T00:00:00.000Z"`, i.e. this API does serialise calendar dates as midnight UTC in places.

Date handling (implemented in `mapDueDate`, `src/chms/pushpay.ts`): date-only values pass through; midnight values (`T00:00:00`, optional `.000`, `Z`/`+00:00`/no zone) become their date part (a calendar date, never shifted to the previous day in Central); anything else is a real instant left for `core/time.ts` to convert to the Central date; `-0001-11-30 ...` and empty values become null. `created` is passed through unchanged. **Resolved in core:** a date-only `created` is taken as the end of that Central day (`createdToInstant` in `src/core/time.ts`), so the elapsed-time rules never fire early and "new since the last run" never misses anyone (see `isNewSinceLastRun` in `src/core/behind.ts`).

Original first-pass reasoning: schema says date-time, but the PQ update call takes `due_date` as `YYYY-MM-DD` and queue detail examples use `...T00:00:00Z`. So `due` is probably a midnight timestamp (possibly with `Z` or an offset) representing a calendar date. INFERRED. Danger: parsing `2026-11-05T00:00:00Z` as an instant and converting to America/Chicago gives Nov 4 at 18:00, shifting the date by one day. Until the sandbox shows real values, the mapper should keep `due` as the raw string (as ARCHITECTURE says) and `time.ts` must decide; recommended rule for a literal `T00:00:00` (with `Z` or `.000Z`) value: treat the date portion as the calendar date, not convert zones. Add this as a sandbox question and a unit test.

Example (INVENTED names; shape adapted from the schema, since the docs give no example for this endpoint; `due` format is a guess):

```json
{
  "queue_individual_id": 900001,
  "queue_id": 5001,
  "individual_id": 70001,
  "status": "NOT_STARTED",
  "due": "2026-11-05T00:00:00.000Z",
  "created": "2026-10-28T15:04:11.000Z",
  "completed": null,
  "process": { "id": 37, "name": "Sample Process", "hidden": false, "archived": false, "status": "ACTIVE" },
  "queue": { "id": 5001, "process_id": 37, "name": "Sample Queue", "order_by": 3, "assigned_count": 4, "unassigned_count": 2 },
  "individual": {
    "id": 70001, "name": "Alex Sample", "first_name": "Alex", "last_name": "Sample",
    "email": "alex.sample@example.com",
    "phone": { "mobile": "555-0101", "home": "", "work": "" },
    "preferred_number": "MOBILE"
  },
  "assignee": { "id": 80001, "name": "Robin Leader", "first_name": "Robin", "last_name": "Leader" }
}
```

## 4. Phone and email

- The nested `individual` and `assignee` use `BasicIndividualProfileSerializer`, whose schema includes `email`, `phone` (`mobile`, `home`, `work`, `fax`, `pager`, `mobile_carrier_id`, all strings) and `preferred_number` (`HOME`|`MOBILE`|`WORK`|`NONE`). CONFIRMED BY DOCS (schema of `getindividuals.md`, `getstepindividuals.md`). So phones and emails are in the schema of the nested object. Whether they are actually populated inside queue rows (vs. omitted or blank for privacy) is UNKNOWN (needs sandbox); the docs for `GET /individuals` say the same ("confirm with a live call").
- Fallback: `GET /individuals/{id}`, scope `read:individuals`, returns the same fields plus `custom_fields`. CONFIRMED BY DOCS. Rate limit on that endpoint is 1 request/sec, shared (GEN), so 300 lookups would take 5 minutes; fine for a cron job but NOT for live page views. Cache per id with a short TTL, only fetch for leaders' behind lists.
- Better fallback: `GET /individuals?per_page=100` pages (scope `read:individuals`), also returns `email`/`phone`; `name` filter also searches phones and emails. No documented id-list filter; the guide "Search Individuals by ID Range" (`docs/search-individuals-by-id-range.md`) exists and is worth reading if the sandbox shows contact data missing from queue rows. Not read in this pass.
- Mapping (implemented, `pickPhone`): phone = `phone.mobile` if non-empty, else the number `preferred_number` points at (`HOME`/`WORK`), else none. No "first non-empty" guess. Email = `email`, else `email_primary` (seen on the guide's update response). INFERRED.
- Per-individual fallback is implemented behind `fetchContactsPerIndividual` (default **off**): one `GET /individuals/{id}` per open entry with no phone, cached per id, throttled to 1/s with no burst, and a 403/404 leaves that person without a phone instead of failing the run.

## 5. Queue managers

`GET /queues/{queue_id}`, scope `read:process_queues` (`getqueue.md`). CONFIRMED BY DOCS. `QueueDetail.managers` is an array of `{ "id": integer, "name": string }` only (no email or phone). VERIFIED RAW. **Implemented:** managers come from the detail (`listQueues` calls `GET /queues/{id}` for each queue), enriched with email/phone from the list row's `managers`/`queue_managers` when the same id appears there. Caveat: the 2026-11-17 PQ guide says the detail returns "`id`, `name`, `description`, `note`, `managers` and `process`" and does not mention `status_counts`, which only the OpenAPI shows. `GET /queues` and `GET /processes/{id}/queues` (deprecated) instead return `BasicQueueSerializer` with `managers` (array of full `BasicIndividualProfileSerializer`) and `queue_managers` (array of `ProcessQueueManagerDetail`, fields undocumented in the pages I read). Process-level managers are on `GET /processes` as `process_managers` (`id, first_name, last_name, name, email_primary, process_id, status_id`). CONFIRMED BY DOCS. Use `GET /queues?process_ids[]=37` for everything in one list (cheaper than per-queue detail), and `GET /queues/{id}` only if `managers` is empty there. Whether `GET /queues` populates `managers` for real: UNKNOWN (needs sandbox). PQ notes `automations` is empty on the list endpoint (CONFIRMED BY DOCS); we ignore it.

Queue detail also gives `status_counts` (`done, in_process, not_started, overdue, unassigned, waiting`) useful for the integrity check above, and `due_date_type`, `notify_queue_managers_days`, etc. (ignore).

## 6. Paging

- **CORRECTED:** the 2026-11-17 PQ guide says of `/queues_individuals` paging: "Read the `X-Total` and `X-Total-Pages` response headers", so they are probably sent even though the OpenAPI operation declares no headers. Implemented termination: stop on an empty or short page (page size from `x-per-page` when present), on an empty `x-next-page`, or at `x-total-pages`; hard cap 50 pages; dedupe rows by `queue_individual_id`.
- Params: `page` (default 1), `per_page` (default 25; allowed 25, 50, 75, 100; max 100). CONFIRMED BY DOCS (`getstepindividuals.md`, `listqueues.md`, `getprocesses.md`, GEN).
- Response headers (GEN): `x-total`, `x-total-pages`, `x-page`, `x-per-page`, `x-offset`, `x-next-page` (empty on the last page). CONFIRMED BY DOCS for the general case. But the reference page for `GET /queues_individuals` defines NO response headers, and `listqueues`/`getprocesses` list only `X-Offset`, `X-Per-Page`, `X-Total-Pages`, `X-Page`. So for `/queues_individuals` header presence is UNKNOWN (needs sandbox).
- Robust termination rule: loop `page=1..`; stop when the response array has fewer than `per_page` items, or `x-next-page` is empty, or `x-total-pages` reached, whichever is available; also hard cap pages (e.g. 50) and fail loudly. A response exactly filling the last page is handled by one extra request returning `[]`.
- Sorting for stable paging: the `/queues_individuals` reference has no sort param (the PQ guide mentions sorting). Rows may shift between pages if data changes mid-run; dedupe by `queue_individual_id`.

## 7. Rate limits and errors

- Rate limit (GEN): default 1 request/sec sustained and burst of 60, per endpoint, bucket shared per OAuth vendor (all churches on our client), no daily cap. Overrides: `/individuals/{id}` 1/sec with no burst; `/search/individuals/results` 1 per 5 sec; scheduling schedules 1 per 2 sec. CONFIRMED BY DOCS.
- Headers on 200: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` (UTC epoch seconds). On 429: `retry-after` (seconds, always honour), same ratelimit headers. 429 body: `{ "error": "Rate limit exceeded", "retry_after": 5 }`. CONFIRMED BY DOCS (GEN). Docs suggest exponential backoff (1,2,4,8,16 s, 5 tries). Abuse of 429s may lead to revocation, so we throttle to 1 req/sec. VERIFIED RAW (GEN). **Implemented:** a token bucket per endpoint template (`/queues/{id}` etc.), 1 req/s with a burst of 10 by default (below the documented 60 because the bucket is shared by the daily job and page views), `/individuals/{id}` at 1 req/s with no burst; when a response says `x-ratelimit-remaining: 0`, wait until `x-ratelimit-reset` (capped at 60 s); on 429 wait `retry-after` (else 1,2,4,8,16 s), at most 5 retries, and give up if `retry-after` exceeds 120 s.
- Our load: roughly 13 queues, 100 per page, maybe 5-10 calls per daily run; trivial.
- API error statuses (reference pages): 401 "not authenticated" (empty body), 403 "do not have permission", 404 not found. No error body schema documented. CONFIRMED BY DOCS. Extra from PQ: 401 with empty body can also mean the token lacks the needed scope; 405 = path typo; 412 = array param without `[]`; 400 on writes only.
- **Expired access token on an API call:** exact status/body NOT documented; expect 401 with empty body, INFERRED. Implemented: refresh proactively when `access_expires_at` is within 5 min; on a 401, call `getAccessToken` with `rejectedAccessToken` (refreshes under the lock unless another job already replaced that token) and retry once; a second 401 is a `ChmsApiError` (could be a scope problem).
- **Revoked / reused refresh token:** token endpoint returns HTTP 401 with `{ "error": "invalid_grant", "error_description": ... }`. VERIFIED RAW (GS). Implemented: `ReauthorizationRequired` (reason `invalid_grant`); the row is flagged `needs_reauth_at` (not deleted), so later calls fail fast without calling Pushpay until a new approval clears it.
- **Church migrated to Workflows:** PQ says only that "endpoints that previously worked now failing" may mean Process Queues were turned off for the church. The precise status code/body is NOT documented. UNKNOWN. Treat any persistent 4xx/5xx or 404 on `/queues`, `/queues_individuals` after a previously healthy run as a loud failure with the message "Process Queues may have been turned off; check Workflows migration". Do not auto-retry.

## 8. Workflows migration

- VERIFIED RAW (OpenAPI JSON): the spec now has `GET /workflows`, `GET /workflows/{workflow_id}`, `GET /workflows/{workflow_id}/managers` and `GET /workflows/{workflow_id}/steps`, and no step-individuals list endpoint. The scope list has `read:workflows` but no `read:workflow_managers`.
- PQ: Process Queues are being replaced by Workflows (released September 2026). Workflow endpoints "were not in the public API reference as of October 2026" per PQ, but the index now lists them: `GET /workflows` (`reference/listworkflows.md`, scope `read:workflows`), `GET /workflows/{id}`, `GET /workflows/{workflow_id}/managers` (scope `read:workflow_managers`, which is NOT in the spec's scope list; closest `read:workflows`). Index timestamps show these pages updated as late as 2026-11-03. CONFIRMED BY DOCS (existence); the step-individual (queue individual) equivalent endpoint is NOT visible in the index sections I read. UNKNOWN: whether a Workflows "step individuals" list endpoint exists yet. Check the index again for "step individual" before building the Workflows `DataSource`.
- Mapping: workflow = process, step = queue, step individual = queue individual, step guide = queue manager (PQ and brief). `GET /workflows` returns `id, name, public, archived, description, instructions, campus{id,name}, steps[{id,name}], managers[{id, first_name, last_name, name, images}]`.
- Once Process Queues are turned off for a church, the queue endpoints stop working for that church (PQ). CONFIRMED BY DOCS. No timeline is documented. The existing `getprocessqueues` endpoint is already marked deprecated; use `GET /queues?process_ids[]=` instead.
- Operationally: scopes `read:process_queues`, `read:queue_individuals` must be re-granted/extended for `read:workflows` (and possibly `read:workflow_managers`) via a fresh Master Admin approval; ask Pushpay in request #802 whether the existing approval can be widened. UNKNOWN.

## 9. Link to a queue in the ChMS web UI

Not documented anywhere I could read (OpenAPI page, PQ, GS, GEN). UNKNOWN (needs sandbox; or ask staff to paste the URL from the browser when viewing a queue). ARCHITECTURE has `chmsBaseUrl` (`https://wildwood.ccbchurch.com`); build the link as `${chmsBaseUrl}${path}` where `path` is a config template such as `/queues/{queueId}` filled in once someone confirms the real path. Do not guess it in code. The API's queue id is the numeric `queue_id`, but whether the UI uses the same id is also UNKNOWN.

## Mapping to DataSource

`listQueues(processId)`:

1. `GET /queues?process_ids[]={processId}&per_page=100&page=N` (paged per section 6). Scope `read:process_queues`. If `process_ids[]` is ignored, filter client-side on `process_id`.
2. For each queue row map:
   - `id` <- `String(id)`
   - `name` <- `name`
   - `processId` <- `String(process_id)`
   - `managers` <- `managers[]` mapped to `Person` (see below); if `managers` is empty and `queue_managers` is non-empty, use that; if both are empty, call `GET /queues/{id}` and map `managers[{id,name}]` (no contact info).
3. Person mapping from `BasicIndividualProfileSerializer`: `id` <- `String(id)`, `name` <- `name` (fallback `first_name + " " + last_name`), `email` <- `email` or undefined if empty, `phone` <- see section 4.

`listEntries(queueId)`:

1. `GET /queues_individuals?queue_ids[]={queueId}&statuses[]=NOT_STARTED&statuses[]=IN_PROCESS&statuses[]=WAITING&statuses[]=DONE&per_page=100&page=N` (as implemented: all four statuses). Scope `read:queue_individuals`. If `queue_ids[]` is not honoured, fetch once per run without it, cache, and group by `queue_id` (implement the fetch as a per-run cache so N queues cost one pass, and the 1 req/sec limit is respected).
2. Per row:
   - `id` <- `String(queue_individual_id)`
   - `queueId` <- `String(queue_id)`
   - `status` <- `status` (identical strings; throw on any unknown value)
   - `due` <- `due` raw string or null (null/empty/`-0001-...` placeholders -> null)
   - `created` <- `created` raw string
   - `completed` <- `completed` raw string, or null for empty/`-0001-11-30...`
   - `assignee` <- `assignee` mapped to `Person` or null (also null if `assignee.id` is missing/0)
   - `individual` <- `individual` mapped to `Person`
3. Check the integrity counts against `status_counts` from `GET /queues/{id}` (see section 2) and fail loudly on mismatch.
4. **CORRECTED:** DONE entries are fetched (all four statuses), so the per-status counts can be checked. On a count mismatch the queue is re-read once (people may be moving through it); a second mismatch throws `IncompleteDataError`.

`NOT_STARTED`/`WAITING`/`IN_PROCESS` rows for the two parking queues are excluded by config before any rule runs, so avoid even fetching them (skip those queue ids).

Contradictions with ARCHITECTURE.md or the brief:

- ARCHITECTURE says `listEntries(queueId)` takes a queue id as a filter. The reference spec for `/queues_individuals` has no `queue_ids` param; only the PQ guide mentions it.
- Brief says `assignment` omitted means everything. Docs say omitted = "both included" (assigned to me + unassigned), which may exclude people assigned to others.
- ARCHITECTURE `due` "date or datetime": docs say date-time everywhere; time-zone semantics unknown.
- Brief says OAuth credentials; GS allows body or Basic; TOK page shows a JSON body with `subdomain`, which conflicts with GS. Resolved in section 1: both come from the raw sources; implemented per GS (form body, credentials in body, no `subdomain`), sandbox to confirm.

## Open questions for the sandbox

Items 13 onwards were added with the live implementation; each matches a `// SANDBOX:` comment in `src/chms/`.

1. Does `GET /queues_individuals` (no `assignment`) return rows assigned to people other than the authorizing user? Compare against `status_counts` and `assigned_count`.
2. Is `queue_ids[]` (and `process_ids[]`) honoured on `/queues_individuals`?
3. Exact format and time zone of `due`, `created`, `completed` (and the unset placeholder); does `due` have a time component, `Z` or an offset?
4. Does `assignee` come back as `null`, absent, or an empty object when unassigned?
5. Are `email`/`phone` populated on nested `individual` and `assignee` in queue rows? Does the authorizing admin's privacy setting hide any?
6. Token endpoint: form-encoded without `subdomain` (GS) or JSON with `subdomain` (TOK)? Is Basic auth accepted?
7. If a refresh response is lost after rotation, is the old token still usable? (Assumed not; recovery is Master Admin re-approval. See the failure-window comment in `src/chms/tokens.ts`.)
8. Response headers on `/queues_individuals` (pagination, ratelimit); behaviour at an exact-multiple last page.
9. Exact status/body for an expired access token, a revoked token, and a church with Process Queues turned off.
10. Does `GET /queues` fill `managers` with contact info, and what is in `queue_managers`?
11. ChMS web UI URL for a queue (and whether it uses the API's queue id).
12. Is a Workflows step-individual list endpoint public yet, and can the existing approval be widened to `read:workflows`?
13. Token request body: does the form-encoded, no-`subdomain` request (GS) work, or is the OpenAPI's JSON body with required `subdomain` needed? (`requestToken`, `oauth.ts`)
14. Does every refresh response include `refresh_token` and `expires_in`? (If `refresh_token` is missing we keep the stored one; if `expires_in` is missing we assume 7200.)
15. Does the authorize request accept all six requested scopes as a `scope` parameter, or must it be trimmed to what was actually granted?
16. Is `due` date-only (`YYYY-MM-DD`, per the PQ guide), midnight UTC, or a real instant? Same for `created` (a date-only `created` is handled by counting from the end of that day; a real instant would make "new" and the 72-hour / 7-day windows exact; see section 3).
17. Does `GET /queues/{id}` include `status_counts` (OpenAPI) at all (the PQ guide does not mention it)? Without counts the live source refuses to return entries (`IncompleteDataError`).
18. Do `status_counts.unassigned`, `assigned_count` and `unassigned_count` include DONE entries? The check currently accepts either.
19. Are literal `[]` brackets required as the guide says, given the OpenAPI declares `statuses` as a plain exploded array? (We send literal `[]`.)
20. Does the detail's `managers` ever come back empty while the list row has managers? (We fall back to the list row's `managers`/`queue_managers`.)
21. Is `email` or `email_primary` the populated email field on nested individuals, and is the phone under `phone.mobile`, or under a `phones` array as in the guide's update response?
