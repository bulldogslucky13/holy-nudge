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

export function alertPayload(stage: 'datasource' | 'job'): PushPayload {
  const body =
    stage === 'datasource' ? 'Holy Nudge could not read ChMS this morning' : 'Holy Nudge hit a problem running this morning';
  return { title: 'Holy Nudge', body, kind: 'alert', count: 0 };
}
