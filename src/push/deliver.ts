// Deliver one payload to every device a leader has subscribed, cleaning up dead subscriptions.
import type { Store } from '../db';
import type { PushPayload } from './payload';
import type { PushSender } from './sender';

export interface DeliveryCounts {
  sent: number;
  failed: number;
  removed: number;
}

export function emptyCounts(): DeliveryCounts {
  return { sent: 0, failed: 0, removed: 0 };
}

export function addCounts(a: DeliveryCounts, b: DeliveryCounts): DeliveryCounts {
  return { sent: a.sent + b.sent, failed: a.failed + b.failed, removed: a.removed + b.removed };
}

export async function deliverToLeader(
  store: Pick<Store, 'listSubscriptions' | 'deleteSubscription' | 'markSubscriptionOk'>,
  sender: PushSender,
  leaderId: number,
  payload: PushPayload,
  now: Date,
): Promise<DeliveryCounts> {
  const counts = emptyCounts();
  for (const sub of await store.listSubscriptions(leaderId)) {
    let r;
    try {
      r = await sender.send(sub, payload);
    } catch {
      // Bad stored keys etc.: count it, keep going for everyone else.
      counts.failed++;
      continue;
    }
    if (r.ok) {
      counts.sent++;
      await store.markSubscriptionOk(sub.endpoint, now);
    } else if (r.gone) {
      counts.removed++;
      await store.deleteSubscription(sub.endpoint);
    } else {
      counts.failed++;
    }
  }
  return counts;
}
