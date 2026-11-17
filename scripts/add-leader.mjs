#!/usr/bin/env node
// Add (or update) a leader row and print their personal link.
// Usage: node scripts/add-leader.mjs --name "Sam Fakename" [--chms-id L101] [--admin] [--owner]
//        [--local | --remote] [--base-url https://holynudge.cameronbristol.xyz]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: a } = parseArgs({
  options: {
    name: { type: 'string' },
    'chms-id': { type: 'string' },
    admin: { type: 'boolean', default: false },
    owner: { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },
    remote: { type: 'boolean', default: false },
    'base-url': { type: 'string' },
  },
});

function die(msg) {
  console.error(`add-leader: ${msg}`);
  process.exit(1);
}

if (!a.name) die('--name is required');
if (a.local === a.remote) die('pass exactly one of --local or --remote');
const chmsId = a['chms-id'] ?? null;
const baseUrl = (a['base-url'] ?? (a.local ? 'http://localhost:8788' : 'https://holynudge.cameronbristol.xyz')).replace(/\/+$/, '');

const config = JSON.parse(readFileSync(join(root, 'config/holy-nudge.config.json'), 'utf8'));
if (config.dataSource === 'fixture') {
  const fakeIds = JSON.parse(readFileSync(join(root, 'fixtures/people.json'), 'utf8')).map((p) => p.id);
  if (!chmsId || !fakeIds.includes(chmsId)) {
    die(`dataSource is "fixture": --chms-id must be one of the sample leaders so they see sample data: ${fakeIds.join(', ')}`);
  }
}

const q = (v) => (v === null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);
const token = randomBytes(32).toString('base64url');
const admin = a.admin ? 1 : 0;
const owner = a.owner ? 1 : 0;

// Re-running for an existing ChMS id keeps their token (and link) and only raises flags.
const insert = chmsId
  ? `INSERT INTO leaders (chms_individual_id, name, token, is_admin, is_owner) VALUES (${q(chmsId)}, ${q(a.name)}, ${q(token)}, ${admin}, ${owner})
     ON CONFLICT(chms_individual_id) DO UPDATE SET name = excluded.name,
       is_admin = max(leaders.is_admin, excluded.is_admin), is_owner = max(leaders.is_owner, excluded.is_owner);`
  : `INSERT INTO leaders (name, token, is_admin, is_owner) VALUES (${q(a.name)}, ${q(token)}, ${admin}, ${owner});`;
const select = chmsId
  ? `SELECT token FROM leaders WHERE chms_individual_id = ${q(chmsId)};`
  : `SELECT token FROM leaders WHERE token = ${q(token)};`;

function d1(sql) {
  const args = ['wrangler', 'd1', 'execute', 'holy-nudge', a.local ? '--local' : '--remote', '--json', '--command', sql];
  const r = spawnSync('npx', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) die(`wrangler d1 execute failed:\n${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

d1(insert);
const rows = d1(select)[0]?.results ?? [];
if (!rows[0]?.token) die('could not read the token back');
console.log(`${a.name}${chmsId ? ` (${chmsId})` : ''}${a.admin ? ' [admin]' : ''}${a.owner ? ' [owner]' : ''}`);
console.log(`Personal link: ${baseUrl}/l/${rows[0].token}`);
