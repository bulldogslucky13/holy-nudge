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
}

export type DataSourceKind = 'fixture' | 'pushpay';

export interface HolyNudgeConfig {
  processId: string;
  /** Queues to ignore entirely; each item matches a queue id or an exact queue name. */
  excludedQueues: string[];
  /** Queue id or exact name -> ChMS individual ids of admins. Missing or empty = use the queue's managers. */
  adminsByQueue: Record<string, string[]>;
  /** IANA zone used for every calendar-date decision. */
  timeZone: string;
  /** Local hour (0-23) at which the daily job runs. */
  morningHour: number;
  dataSource: DataSourceKind;
  /** Base URL for deep links into ChMS. */
  chmsBaseUrl: string;
  /**
   * Link to a queue in the ChMS web UI. Placeholders: {chmsBaseUrl}, {queueId}.
   * Optional; see DEFAULT_QUEUE_URL_TEMPLATE. UNVERIFIED: the real URL pattern is not documented.
   */
  queueUrlTemplate?: string;
}
