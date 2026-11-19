#!/usr/bin/env node
// List leaders (no tokens, ever): id, name, flags, link state, Lead match, devices, last seen, and the queue
// keys each one coordinates (as stored: a queue id or exact name; set with add-leader --coordinator-of).
// --stale-days N lists only leaders with a working link who have not opened the app in N days (or never),
// as candidates to turn off with scripts/revoke-leader.mjs. Nothing is changed.
// Usage: node scripts/list-leaders.mjs [--stale-days N] (--local | --remote)
import { parseArgs } from 'node:util';
import { d1, die, target } from './lib/d1.mjs';

const S = 'list-leaders';
const { values: a } = parseArgs({
  options: {
    'stale-days': { type: 'string' },
    local: { type: 'boolean', default: false },
    remote: { type: 'boolean', default: false },
  },
});
const where = target(S, a);
let filter = '';
if (a['stale-days'] !== undefined) {
  if (!/^\d+$/.test(a['stale-days'])) die(S, '--stale-days must be a whole number');
  const cutoff = new Date(Date.now() - Number(a['stale-days']) * 86_400_000).toISOString();
  filter = `WHERE l.revoked_at IS NULL AND (l.token_hash IS NOT NULL OR l.token IS NOT NULL) AND (l.last_seen_at IS NULL OR l.last_seen_at < '${cutoff}')`;
}
const [rows] = d1(
  S,
  where,
  `SELECT l.id, l.chms_individual_id AS chms_id, l.name, l.is_admin AS admin, l.is_owner AS owner,
     CASE WHEN l.revoked_at IS NOT NULL THEN 'off' WHEN l.token_hash IS NOT NULL THEN 'yes'
          WHEN l.token IS NOT NULL THEN 'yes (legacy, unhashed)' ELSE 'none' END AS link,
     CASE WHEN l.chms_individual_id IS NOT NULL THEN 'yes' ELSE 'no' END AS matched,
     (SELECT COUNT(*) FROM push_subscriptions s WHERE s.leader_id = l.id) AS devices,
     COALESCE(l.last_seen_at, 'never') AS last_seen,
     COALESCE((SELECT group_concat(c.queue_key, ' | ') FROM queue_coordinators c WHERE c.leader_id = l.id), '') AS coordinates
   FROM leaders l ${filter} ORDER BY l.name;`,
);
console.table(rows);
if (a['stale-days'] !== undefined) {
  console.log(`${rows.length} leader(s) with a working link not seen in ${a['stale-days']} days. Turn one off with:`);
  console.log(`  npm run revoke-leader -- --id <id> ${where}`);
}
