#!/usr/bin/env node
// Turn off a leader's personal link (it returns 401 from then on) and delete their push subscriptions.
// To give them a working link again: npm run add-leader -- --name "..." --chms-id <id> --new-link (--local|--remote)
// Usage: node scripts/revoke-leader.mjs (--id N | --chms-id X) (--local | --remote)
import { parseArgs } from 'node:util';
import { d1, die, leaderWhere, target } from './lib/d1.mjs';

const S = 'revoke-leader';
const { values: a } = parseArgs({
  options: {
    id: { type: 'string' },
    'chms-id': { type: 'string' },
    local: { type: 'boolean', default: false },
    remote: { type: 'boolean', default: false },
  },
});
const where = target(S, a);
const w = leaderWhere(S, a);
const [rows] = d1(S, where, `SELECT id, name, is_owner FROM leaders WHERE ${w};`);
const row = rows[0];
if (!row) die(S, 'no such leader');
const now = new Date().toISOString();
d1(
  S,
  where,
  `UPDATE leaders SET revoked_at = '${now}', token_hash = NULL, token = NULL WHERE id = ${row.id}; ` +
    `DELETE FROM push_subscriptions WHERE leader_id = ${row.id};`,
);
console.log(`${row.name} (id ${row.id})${row.is_owner ? ' [owner]' : ''}: link turned off, notifications removed.`);
