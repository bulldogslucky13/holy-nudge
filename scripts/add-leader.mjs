#!/usr/bin/env node
// Add (or update) a leader row. A new row gets a personal link, printed ONCE: only its SHA-256 is stored,
// so it cannot be shown again. Re-running for an existing person updates the name and raises flags but
// keeps their current link, unless you pass --new-link (which replaces it; the old link stops working).
// Usage: node scripts/add-leader.mjs --name "Sam Fakename" [--chms-id L101] [--admin] [--owner] [--new-link]
//        (--local | --remote) [--base-url https://holynudge.cameronbristol.xyz]
//   --admin  staff: sees every queue and can make or turn off anyone's link (except the owner's)
//   --owner  gets failure alerts; only an owner can change an owner's link
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { d1, die, LOCAL_BASE_URL, newToken, PROD_BASE_URL, q, root, target } from './lib/d1.mjs';

const S = 'add-leader';
const { values: a } = parseArgs({
  options: {
    name: { type: 'string' },
    'chms-id': { type: 'string' },
    admin: { type: 'boolean', default: false },
    owner: { type: 'boolean', default: false },
    'new-link': { type: 'boolean', default: false },
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
if (config.dataSource === 'fixture' && chmsId) {
  // --chms-id may be left out while on sample data (a real volunteer before launch has no sample identity;
  // non-staff see no sample data then anyway). If given, it must be a sample id.
  const fakeIds = JSON.parse(readFileSync(join(root, 'fixtures/people.json'), 'utf8')).map((p) => p.id);
  if (!fakeIds.includes(chmsId)) {
    die(S, `dataSource is "fixture": --chms-id must be one of the sample ids (or left out): ${fakeIds.join(', ')}`);
  }
}

const admin = a.admin ? 1 : 0;
const owner = a.owner ? 1 : 0;
const flags = `${a.admin ? ' [admin]' : ''}${a.owner ? ' [owner]' : ''}`;

let existing = null;
if (chmsId) {
  const [rows] = d1(S, where, `SELECT id, (revoked_at IS NULL AND (token_hash IS NOT NULL OR token IS NOT NULL)) AS has_link FROM leaders WHERE chms_individual_id = ${q(chmsId)};`);
  existing = rows[0] ?? null;
}

if (existing) {
  d1(S, where, `UPDATE leaders SET name = ${q(a.name)}, is_admin = max(is_admin, ${admin}), is_owner = max(is_owner, ${owner}) WHERE id = ${existing.id};`);
  if (existing.has_link && !a['new-link']) {
    console.log(`${a.name} (${chmsId})${flags}: updated. Their current link still works (pass --new-link to replace it).`);
    process.exit(0);
  }
  const { token, hash } = newToken();
  d1(S, where, `UPDATE leaders SET token_hash = ${q(hash)}, token = NULL, revoked_at = NULL WHERE id = ${existing.id};`);
  console.log(`${a.name} (${chmsId})${flags}: new link${existing.has_link ? ' (the old one no longer works)' : ''}.`);
  console.log(`Personal link (shown once, send it now): ${baseUrl}/l/${token}`);
} else {
  const { token, hash } = newToken();
  d1(S, where, `INSERT INTO leaders (chms_individual_id, name, token_hash, is_admin, is_owner) VALUES (${q(chmsId)}, ${q(a.name)}, ${q(hash)}, ${admin}, ${owner});`);
  console.log(`${a.name}${chmsId ? ` (${chmsId})` : ''}${flags}: added.`);
  console.log(`Personal link (shown once, send it now): ${baseUrl}/l/${token}`);
  if (!chmsId) console.log('Not matched to Lead yet: matched automatically if exactly one Lead person has this exact name, or by staff from the Team tab.');
}
