#!/usr/bin/env node
// Add (or update) a leader row. A new row gets a personal link, printed ONCE: only its SHA-256 is stored,
// so it cannot be shown again. Re-running for an existing person updates the name and raises flags but
// keeps their current link, unless you pass --new-link (which replaces it; the old link stops working).
// The existing person is found by --chms-id, or without it by name (case-insensitive) among rows not yet
// matched to Lead (people added by name, e.g. from the Team tab).
// Usage: node scripts/add-leader.mjs --name "Sam Fakename" [--chms-id L101] [--admin] [--owner] [--new-link]
//        [--coordinator-of "<queue id or exact name>" ...] [--clear-coordinator]
//        (--local | --remote) [--base-url https://holynudge.cameronbristol.xyz]
//   --admin  staff: sees every queue and can make or turn off anyone's link (except the owner's)
//   --owner  gets failure alerts; only an owner can change an owner's link
//   --coordinator-of  repeatable: SETS (replaces) the queues this person coordinates, i.e. sees whole (every
//            unassigned and behind student in it) and gets the morning summary for. Leave it out to keep
//            what they have; --clear-coordinator removes them all.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { cleanQueueKeys, keyWarnings, replaceCoordinatorsSql } from './lib/coordinators.mjs';
import { d1, die, LOCAL_BASE_URL, newToken, PROD_BASE_URL, q, root, target } from './lib/d1.mjs';

const S = 'add-leader';
const { values: a } = parseArgs({
  options: {
    name: { type: 'string' },
    'chms-id': { type: 'string' },
    admin: { type: 'boolean', default: false },
    owner: { type: 'boolean', default: false },
    'new-link': { type: 'boolean', default: false },
    'coordinator-of': { type: 'string', multiple: true },
    'clear-coordinator': { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },
    remote: { type: 'boolean', default: false },
    'base-url': { type: 'string' },
  },
});

if (!a.name) die(S, '--name is required');
const where = target(S, a);
const chmsId = a['chms-id'] ?? null;
const baseUrl = (a['base-url'] ?? (a.local ? LOCAL_BASE_URL : PROD_BASE_URL)).replace(/\/+$/, '');

const config = JSON.parse(readFileSync(join(root, 'config/holy-nudge.config.json'), 'utf8'));
const fixture = config.dataSource === 'fixture';
if (fixture && chmsId) {
  // --chms-id may be left out while on sample data (a real volunteer before launch has no sample identity;
  // non-staff see no sample data then anyway). If given, it must be a sample id.
  const fakeIds = JSON.parse(readFileSync(join(root, 'fixtures/people.json'), 'utf8')).map((p) => p.id);
  if (!fakeIds.includes(chmsId)) {
    die(S, `dataSource is "fixture": --chms-id must be one of the sample ids (or left out): ${fakeIds.join(', ')}`);
  }
}

// Coordinator keys: null = leave as they are.
if (a['clear-coordinator'] && a['coordinator-of']) die(S, 'pass --coordinator-of or --clear-coordinator, not both');
let coordKeys = null;
if (a['clear-coordinator']) coordKeys = [];
else if (a['coordinator-of']) {
  const c = cleanQueueKeys(a['coordinator-of']);
  if (c.error) die(S, c.error);
  coordKeys = c.keys;
  const queues = fixture ? JSON.parse(readFileSync(join(root, 'fixtures/queues.json'), 'utf8')).queues : null;
  for (const w of keyWarnings(coordKeys, { queues, excluded: config.excludedQueues ?? [] })) console.warn(`${S}: warning: ${w}`);
}
const coordSql = (leaderIdSql) => (coordKeys === null ? '' : ` ${replaceCoordinatorsSql(leaderIdSql, coordKeys)}`);
const coordLine = () => {
  if (coordKeys === null) return;
  console.log(coordKeys.length ? `Coordinates: ${coordKeys.map((k) => `"${k}"`).join(', ')}.` : 'Coordinates no queues now.');
};

const admin = a.admin ? 1 : 0;
const owner = a.owner ? 1 : 0;
const flags = `${a.admin ? ' [admin]' : ''}${a.owner ? ' [owner]' : ''}`;
const who = `${a.name}${chmsId ? ` (${chmsId})` : ''}${flags}`;
const HAS_LINK = '(revoked_at IS NULL AND (token_hash IS NOT NULL OR token IS NOT NULL)) AS has_link';

let existing = null;
if (chmsId) {
  const [rows] = d1(S, where, `SELECT id, ${HAS_LINK} FROM leaders WHERE chms_individual_id = ${q(chmsId)};`);
  existing = rows[0] ?? null;
} else {
  const [rows] = d1(S, where, `SELECT id, ${HAS_LINK} FROM leaders WHERE chms_individual_id IS NULL AND lower(name) = lower(${q(a.name)});`);
  if (rows.length > 1) die(S, `${rows.length} leaders not matched to Lead are called "${a.name}" (ids ${rows.map((r) => r.id).join(', ')}): sort that out first (npm run list-leaders)`);
  existing = rows[0] ?? null;
}

if (existing) {
  d1(
    S,
    where,
    `UPDATE leaders SET name = ${q(a.name)}, is_admin = max(is_admin, ${admin}), is_owner = max(is_owner, ${owner}) WHERE id = ${existing.id};${coordSql(existing.id)}`,
  );
  if (existing.has_link && !a['new-link']) {
    console.log(`${who}: updated. Their current link still works (pass --new-link to replace it).`);
    coordLine();
    process.exit(0);
  }
  const { token, hash } = newToken();
  d1(S, where, `UPDATE leaders SET token_hash = ${q(hash)}, token = NULL, revoked_at = NULL WHERE id = ${existing.id};`);
  console.log(`${who}: new link${existing.has_link ? ' (the old one no longer works)' : ''}.`);
  coordLine();
  console.log(`Personal link (shown once, send it now): ${baseUrl}/l/${token}`);
} else {
  const { token, hash } = newToken();
  d1(
    S,
    where,
    `INSERT INTO leaders (chms_individual_id, name, token_hash, is_admin, is_owner) VALUES (${q(chmsId)}, ${q(a.name)}, ${q(hash)}, ${admin}, ${owner});` +
      coordSql(`(SELECT id FROM leaders WHERE token_hash = ${q(hash)})`),
  );
  console.log(`${who}: added.`);
  coordLine();
  console.log(`Personal link (shown once, send it now): ${baseUrl}/l/${token}`);
  if (!chmsId) console.log('Not matched to Lead yet: matched automatically if exactly one Lead person has this exact name, or by staff from the Team tab.');
}
