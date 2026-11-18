// Push payloads: counts only, never names or contact details (see ORCHESTRATOR_PROMPT.md "Privacy").
export type PushKind = 'leader' | 'admin' | 'test' | 'alert';

/**
 * The phone already labels every notification with the app name ("from Holy Nudge" on iOS),
 * so the title carries the message itself and the body adds the detail.
 */
export interface PushPayload {
  title: string;
  body: string;
  kind: PushKind;
  count: number;
}

const students = (n: number) => (n === 1 ? '1 student' : `${n} students`);

/** Title "3 students are waiting on you" / "1 student is waiting on you". */
export function leaderPayload(count: number): PushPayload {
  const title = count === 1 ? '1 student is waiting on you' : `${count} students are waiting on you`;
  return { title, body: 'Tap to see who could use a hello', kind: 'leader', count };
}

/** Title "12 students waiting", body "Across 4 leaders, 3 unassigned". */
export function adminPayload(waiting: number, leaders: number, unassigned: number): PushPayload {
  const parts: string[] = [];
  if (leaders > 0) parts.push(`across ${leaders === 1 ? '1 leader' : `${leaders} leaders`}`);
  if (unassigned > 0) parts.push(`${unassigned} unassigned`);
  const detail = parts.join(', ');
  const body = detail ? detail[0]!.toUpperCase() + detail.slice(1) : 'Tap to see the summary';
  return { title: `${students(waiting)} waiting`, body, kind: 'admin', count: waiting };
}

export function testPayload(): PushPayload {
  return { title: 'Notifications are on', body: "You're all set!", kind: 'test', count: 0 };
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

const ALERTS: Record<AlertReason, { title: string; body: string }> = {
  reauth: { title: 'Pushpay connection lost', body: 'A Master Admin needs to approve it again' },
  not_configured: { title: 'No Pushpay credentials yet', body: 'No nudges went out this morning' },
  incomplete: { title: 'Only part of the ChMS data came through', body: 'No nudges went out this morning' },
  datasource: { title: 'Could not read ChMS this morning', body: 'No nudges went out' },
  job: { title: 'Problem running this morning', body: 'Some nudges may not have gone out' },
};

export function alertPayload(reason: AlertReason): PushPayload {
  return { ...ALERTS[reason], kind: 'alert', count: 0 };
}
