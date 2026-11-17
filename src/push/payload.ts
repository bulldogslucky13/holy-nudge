// Push payloads: counts only, never names or contact details (see ORCHESTRATOR_PROMPT.md "Privacy").
export type PushKind = 'leader' | 'admin' | 'test' | 'alert';

export interface PushPayload {
  title: 'Holy Nudge';
  body: string;
  kind: PushKind;
  count: number;
}

const students = (n: number) => (n === 1 ? '1 student' : `${n} students`);

/** "3 students are waiting on you" / "1 student is waiting on you". */
export function leaderPayload(count: number): PushPayload {
  const body = count === 1 ? '1 student is waiting on you' : `${count} students are waiting on you`;
  return { title: 'Holy Nudge', body, kind: 'leader', count };
}

/** "12 students waiting across 4 leaders, 3 unassigned". */
export function adminPayload(waiting: number, leaders: number, unassigned: number): PushPayload {
  let body = `${students(waiting)} waiting`;
  if (leaders > 0) body += ` across ${leaders === 1 ? '1 leader' : `${leaders} leaders`}`;
  if (unassigned > 0) body += `, ${unassigned} unassigned`;
  return { title: 'Holy Nudge', body, kind: 'admin', count: waiting };
}

export function testPayload(): PushPayload {
  return { title: 'Holy Nudge', body: "Notifications are on. You're all set!", kind: 'test', count: 0 };
}

/**
 * Why the owner is being alerted. Each has its own plain message (no data, no error text).
 * - reauth: the Pushpay connection is gone (refresh token rejected or never stored); a Master Admin must approve again.
 * - not_configured: dataSource is "pushpay" but the client id/secret are not set.
 * - incomplete: ChMS returned fewer people than its own counts say (possibly partial visibility).
 * - datasource: any other failure reading ChMS (API errors, Workflows migration, timeouts).
 * - job: something after the data was read (database, push sending).
 */
export type AlertReason = 'reauth' | 'not_configured' | 'incomplete' | 'datasource' | 'job';

const ALERT_BODIES: Record<AlertReason, string> = {
  reauth: 'Holy Nudge lost its Pushpay connection. A Master Admin needs to approve it again.',
  not_configured: 'Holy Nudge has no Pushpay credentials yet, so no nudges went out',
  incomplete: 'Holy Nudge only got part of the ChMS data this morning, so no nudges went out',
  datasource: 'Holy Nudge could not read ChMS this morning',
  job: 'Holy Nudge hit a problem running this morning',
};

export function alertPayload(reason: AlertReason): PushPayload {
  return { title: 'Holy Nudge', body: ALERT_BODIES[reason], kind: 'alert', count: 0 };
}
