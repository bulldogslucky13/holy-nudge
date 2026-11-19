// Queue-coordinator helpers for the leader scripts (table queue_coordinators, migration 0005).
// A key is a queue id or a queue's exact name, matched at run time by src/core/behind.ts queueIdsForKeys.
import { q } from './d1.mjs';

/** Trim each key and drop repeats. Returns { keys } or { error } (an empty key is refused). */
export function cleanQueueKeys(list) {
  const keys = [];
  for (const raw of list) {
    const k = String(raw).trim();
    if (k === '') return { error: '--coordinator-of needs a queue id or exact queue name' };
    if (!keys.includes(k)) keys.push(k);
  }
  return { keys };
}

/**
 * SQL that sets (replaces) a leader row's coordinator keys. `leaderIdSql` is a number or a scalar subquery.
 * An empty list clears them. Run as one wrangler command.
 */
export function replaceCoordinatorsSql(leaderIdSql, keys) {
  const del = `DELETE FROM queue_coordinators WHERE leader_id = ${leaderIdSql};`;
  if (keys.length === 0) return del;
  return `${del} INSERT INTO queue_coordinators (leader_id, queue_key) VALUES ${keys.map((k) => `(${leaderIdSql}, ${q(k)})`).join(', ')};`;
}

/**
 * Warnings for keys that will grant nothing as things stand. `queues` (id and name) are the queues known
 * here (the sample ones while dataSource is "fixture"), or null when they cannot be checked from a script.
 */
export function keyWarnings(keys, { queues, excluded }) {
  const out = [];
  for (const k of keys) {
    if (excluded.includes(k)) {
      out.push(`"${k}" is an excluded queue (config excludedQueues): it grants nothing`);
    } else if (queues && !queues.some((x) => x.id === k || x.name === k)) {
      out.push(`"${k}" is not a sample queue id or exact name: it grants nothing until real data has a queue with exactly this id or name`);
    }
  }
  if (!queues && keys.length) out.push('queue keys are not checked against Lead from here: each must be a queue id or the exact queue name (case and spaces count); check the Team tab after the next page view');
  return out;
}
