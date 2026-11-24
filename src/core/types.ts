export type Status = 'NOT_STARTED' | 'IN_PROCESS' | 'WAITING' | 'DONE';

export interface Person {
  id: string;
  name: string;
  phone?: string;
  email?: string;
}

export interface Queue {
  id: string;
  name: string;
  processId: string;
  managers: Person[];
}

/** One person in one queue. */
export interface QueueEntry {
  id: string;
  queueId: string;
  status: Status;
  /** As ChMS returns it: a date ("2026-11-10") or a datetime with offset. */
  due: string | null;
  /** When they entered the queue (ISO datetime). */
  created: string;
  completed: string | null;
  assignee: Person | null;
  individual: Person;
}

export interface DataSource {
  listQueues(processId: string): Promise<Queue[]>;
  listEntries(queueId: string): Promise<QueueEntry[]>;
  /**
   * Optional: phone numbers for these individuals (id -> number), when queue rows carry none.
   * Called only for the viewing leader's own students in GET /api/me, never by the daily job or for
   * a whole-queue view (docs/DECISIONS.md, 24). Must never throw: a failed lookup just has no phone.
   */
  phonesFor?(individualIds: readonly string[]): Promise<Map<string, string>>;
}

export type DataSourceKind = 'fixture' | 'pushpay';

/** Who real data is released to: "staff" (is_admin rows only, the cautious first stage) or "everyone". */
export type Audience = 'staff' | 'everyone';

export interface HolyNudgeConfig {
  processId: string;
  /** Queues to ignore entirely; each item matches a queue id or an exact queue name. */
  excludedQueues: string[];
  /** IANA zone used for every calendar-date decision. */
  timeZone: string;
  /** Local hour (0-23) at which the daily job runs. */
  morningHour: number;
  /**
   * Days an assigned Not Started student with no due date has before they count as overdue (the
   * written process: the assigned person follows up within one week). Elapsed time from `created`.
   */
  followUpDays: number;
  /** Hours an unassigned student may wait (for the coordinators' first text) before the summary nudges daily. */
  firstTextHours: number;
  dataSource: DataSourceKind;
  /**
   * Who sees real data and is nudged once dataSource is not "fixture" (docs/DECISIONS.md, 25). Ignored
   * while the data is sample data. Absent in the file means "staff".
   */
  audience: Audience;
  /** Base URL for deep links into ChMS. */
  chmsBaseUrl: string;
  /**
   * Link to a queue in the ChMS web UI. Placeholders: {chmsBaseUrl}, {queueId}.
   * Optional; see DEFAULT_QUEUE_URL_TEMPLATE. UNVERIFIED: the real URL pattern is not documented.
   */
  queueUrlTemplate?: string;
  /** Admin-view link: one queue, one status, every assignee. Placeholders: {chmsBaseUrl} {queueId} {statusId}. */
  adminQueueUrlTemplate?: string;
}
