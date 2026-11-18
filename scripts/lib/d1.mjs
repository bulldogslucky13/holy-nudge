// Shared helpers for the leader scripts: run SQL on the holy-nudge D1 (local or remote) via wrangler,
// and hash link tokens exactly like src/db/index.ts hashToken (SHA-256, lowercase hex).
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROD_BASE_URL = 'https://holynudge.cameronbristol.xyz';
export const LOCAL_BASE_URL = 'http://localhost:8788';

export function die(script, msg) {
  console.error(`${script}: ${msg}`);
  process.exit(1);
}

/** Exactly one of --local / --remote. */
export function target(script, a) {
  if (a.local === a.remote) die(script, 'pass exactly one of --local or --remote');
  return a.local ? '--local' : '--remote';
}

/** SQL string literal. */
export const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);

/** Run SQL; returns the results array of each statement. Never echoes the SQL on failure (it may hold a hash). */
export function d1(script, where, sql) {
  const args = ['wrangler', 'd1', 'execute', 'holy-nudge', where, '--json', '--command', sql];
  const r = spawnSync('npx', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) die(script, `wrangler d1 execute failed:\n${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout).map((x) => x.results ?? []);
}

/** A new personal-link token (32 random bytes, base64url) and its SHA-256 hex. */
export function newToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** WHERE clause for --id N or --chms-id X. */
export function leaderWhere(script, a) {
  if (a.id && a['chms-id']) die(script, 'pass --id or --chms-id, not both');
  if (a.id) {
    if (!/^\d+$/.test(a.id)) die(script, '--id must be a number');
    return `id = ${Number(a.id)}`;
  }
  if (a['chms-id']) return `chms_individual_id = ${q(a['chms-id'])}`;
  die(script, 'pass --id <leader id> or --chms-id <ChMS individual id> (see npm run list-leaders)');
}
