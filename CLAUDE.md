# Holy Nudge: notes for Claude

Installable web app that sends a college ministry's servant leaders a morning push when students in their Pushpay ChMS (Lead) queues need follow-up. See `README.md` for setup and operations, `docs/ARCHITECTURE.md` for the technical shape.

## Read first

**`docs/DECISIONS.md` lists what was decided on purpose.** Read it before changing behaviour, access rules or nudge timing. If something looks like a gap, check there before "fixing" it. Changing a listed decision needs Cameron's say-so. When Cameron makes a new product decision, add an entry in the same pull request as the code.

## Rules that never bend

- **Read-only.** Never write to Lead. Never change a setting on the church's Lead site or on Cameron's accounts without explicit approval.
- **Free.** No paid services.
- **Privacy.** Students are real people. Push payloads carry counts only. Student data is never stored or logged. No real names, Lead ids, phone numbers, personal links or secrets in the repo, in commits, in pull requests or in chat. Use invented people in fixtures, tests, docs and screenshots.
- **Tone.** An encouraging nudge, not a nag.

## Working here

- Changes go through pull requests; visual changes include screenshots.
- `npm run typecheck` and `npm test` before pushing.
- Files kept on Cameron's machine only and never committed: `.secrets.local`, `.dev.vars`, `docs/DATA_HANDLING.md`, everything under `.claude/`.
- The roster of real leaders, who coordinates which queue, and church-side notes live in a private notes vault outside this repo, not here.
