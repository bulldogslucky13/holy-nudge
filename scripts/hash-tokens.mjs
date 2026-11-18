#!/usr/bin/env node
// One-off, after migration 0003 and the deploy that reads token_hash: convert every remaining legacy
// plaintext link token to its SHA-256 hash and clear the plaintext. Existing links keep working (the app
// looks links up by hash). Safe to re-run. Prints counts only, never tokens.
// When it reports "0 plaintext tokens remain" against --remote, the legacy fallback in
// src/db/index.ts leaderByToken can be deleted (and a later migration can drop leaders.token).
// Usage: node scripts/hash-tokens.mjs (--local | --remote)
import { parseArgs } from 'node:util';
import { d1, hashToken, target } from './lib/d1.mjs';

const S = 'hash-tokens';
const { values: a } = parseArgs({
  options: { local: { type: 'boolean', default: false }, remote: { type: 'boolean', default: false } },
});
const where = target(S, a);

const [rows] = d1(S, where, 'SELECT id, token FROM leaders WHERE token IS NOT NULL;');
if (rows.length > 0) {
  // Only hashes and ids go into the SQL; the condition makes a re-run (or a concurrent upgrade-on-use) harmless.
  const sql = rows
    .map((r) => `UPDATE leaders SET token_hash = '${hashToken(r.token)}', token = NULL WHERE id = ${Number(r.id)} AND token IS NOT NULL;`)
    .join(' ');
  d1(S, where, sql);
}
const [[left]] = d1(S, where, 'SELECT COUNT(*) AS n FROM leaders WHERE token IS NOT NULL;');
console.log(`hash-tokens: hashed ${rows.length} legacy token(s); ${left.n} plaintext token(s) remain.`);
if (left.n !== 0) process.exit(1);
