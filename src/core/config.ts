import raw from '../../config/holy-nudge.config.json';
import type { Audience, DataSourceKind, HolyNudgeConfig, Status } from './types';

export class ConfigError extends Error {}

/** The church's written process: the assigned person follows up within one week. */
export const DEFAULT_FOLLOW_UP_DAYS = 7;
/** The church's written process: coordinators send a first text (and assign the card) within 72 hours. */
export const DEFAULT_FIRST_TEXT_HOURS = 72;

/** ChMS web UI queue page, pattern taken from real queue URLs (2026-11-17). Assumes the API queue id equals the web step_id; confirm with live data. */
export const DEFAULT_QUEUE_URL_TEMPLATE = '{chmsBaseUrl}/step_individuals.php?ax=my&step_id={queueId}';

/** Deep link to a queue in the ChMS web UI, from config.queueUrlTemplate (or the default). */
export function queueUrl(config: Pick<HolyNudgeConfig, 'chmsBaseUrl' | 'queueUrlTemplate'>, queueId: string): string {
  return (config.queueUrlTemplate ?? DEFAULT_QUEUE_URL_TEMPLATE)
    .replaceAll('{chmsBaseUrl}', config.chmsBaseUrl)
    .replaceAll('{queueId}', encodeURIComponent(queueId));
}

/** A person's profile page in the ChMS web UI (confirmed against production 2026-11-24: /goto/individuals/<id> redirects to the profile). */
export const DEFAULT_INDIVIDUAL_URL_TEMPLATE = '{chmsBaseUrl}/goto/individuals/{individualId}';

/** Link to one person's Lead profile, from config.individualUrlTemplate (or the default). Staff only; see docs/DECISIONS.md, 26. */
export function individualUrl(config: Pick<HolyNudgeConfig, 'chmsBaseUrl' | 'individualUrlTemplate'>, individualId: string): string {
  return (config.individualUrlTemplate ?? DEFAULT_INDIVIDUAL_URL_TEMPLATE)
    .replaceAll('{chmsBaseUrl}', config.chmsBaseUrl)
    .replaceAll('{individualId}', encodeURIComponent(individualId));
}

/** Web UI status_id values, read from real filtered queue URLs (2026-11-17). IN_PROCESS = 1 is inferred, not seen. */
const WEB_STATUS_ID: Record<Status, string> = { WAITING: '0', IN_PROCESS: '1', DONE: '2', NOT_STARTED: '3' };

/** Queue page filtered to one status and every assignee, for the admin view. Pattern from real URLs. */
export const DEFAULT_ADMIN_QUEUE_URL_TEMPLATE =
  '{chmsBaseUrl}/step_individuals.php?ax=my&search_flag=1&step_id={queueId}&srch%5Bstatus_id%5D={statusId}&srch%5Bassigned%5D=all';

export function adminQueueUrl(
  config: Pick<HolyNudgeConfig, 'chmsBaseUrl' | 'adminQueueUrlTemplate'>,
  queueId: string,
  status: Status,
): string {
  return (config.adminQueueUrlTemplate ?? DEFAULT_ADMIN_QUEUE_URL_TEMPLATE)
    .replaceAll('{chmsBaseUrl}', config.chmsBaseUrl)
    .replaceAll('{queueId}', encodeURIComponent(queueId))
    .replaceAll('{statusId}', WEB_STATUS_ID[status]);
}

/**
 * True once real church data is connected (anything but the made-up fixture). While false, only staff
 * (is_admin) may see sample students or get sample-data nudges; everyone else is "pre-launch".
 */
export function isLive(config: Pick<HolyNudgeConfig, 'dataSource'>): boolean {
  return config.dataSource !== 'fixture';
}

/**
 * The one rule for who may see data and be nudged right now (docs/DECISIONS.md, 22 and 25):
 *
 *   dataSource  audience   sees data (app)   gets push
 *   fixture     (ignored)  staff             owner only
 *   pushpay     staff      staff             staff
 *   pushpay     everyone   everyone          everyone
 *
 * "Staff" means is_admin rows (the owner included). A coordinator who is not staff is not staff here.
 * Real data being on at all (leader sync, matching) is `isLive`, not this.
 */
export function leaderAccess(
  config: Pick<HolyNudgeConfig, 'dataSource' | 'audience'>,
  row: { isAdmin: boolean; isOwner: boolean },
): { seesData: boolean; getsPush: boolean } {
  if (!isLive(config)) return { seesData: row.isAdmin, getsPush: row.isOwner };
  if (config.audience === 'everyone') return { seesData: true, getsPush: true };
  return { seesData: row.isAdmin, getsPush: row.isAdmin };
}

function fail(msg: string): never {
  throw new ConfigError(`holy-nudge.config.json: ${msg}`);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Validate an unknown value as a HolyNudgeConfig. Throws ConfigError with a specific message. */
export function parseConfig(input: unknown): HolyNudgeConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('must be an object');
  const o = input as Record<string, unknown>;

  if (typeof o.processId !== 'string' || o.processId === '') fail('processId must be a non-empty string');
  if (!isStringArray(o.excludedQueues)) fail('excludedQueues must be an array of strings');

  // Removed on purpose, not ignored: whole-queue access now comes only from the queue_coordinators table
  // (migration 0005). A leftover key must not look as if it still grants anything.
  if ('adminsByQueue' in o) {
    fail('adminsByQueue is no longer supported: queue coordinators live in the database now (npm run add-leader -- --coordinator-of "<queue id or exact name>"). Remove the key.');
  }

  if (typeof o.timeZone !== 'string') fail('timeZone must be a string');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: o.timeZone });
  } catch {
    fail(`timeZone "${o.timeZone}" is not a valid IANA zone`);
  }

  const hour = o.morningHour;
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    fail('morningHour must be an integer 0-23');
  }

  const followUpDays = o.followUpDays ?? DEFAULT_FOLLOW_UP_DAYS;
  if (typeof followUpDays !== 'number' || !Number.isInteger(followUpDays) || followUpDays < 1) {
    fail('followUpDays must be a whole number of days, at least 1');
  }
  const firstTextHours = o.firstTextHours ?? DEFAULT_FIRST_TEXT_HOURS;
  if (typeof firstTextHours !== 'number' || !Number.isInteger(firstTextHours) || firstTextHours < 1) {
    fail('firstTextHours must be a whole number of hours, at least 1');
  }

  if (o.dataSource !== 'fixture' && o.dataSource !== 'pushpay') fail('dataSource must be "fixture" or "pushpay"');

  // Absent means the cautious value: real data reaches staff only until the owner says "everyone".
  const audience = o.audience === undefined ? 'staff' : o.audience;
  if (audience !== 'staff' && audience !== 'everyone') fail('audience must be "staff" or "everyone"');

  if (typeof o.chmsBaseUrl !== 'string') fail('chmsBaseUrl must be a string');
  try {
    new URL(o.chmsBaseUrl);
  } catch {
    fail('chmsBaseUrl must be an absolute URL');
  }

  let queueUrlTemplate: string | undefined;
  if (o.queueUrlTemplate !== undefined) {
    if (typeof o.queueUrlTemplate !== 'string' || !o.queueUrlTemplate.includes('{queueId}')) {
      fail('queueUrlTemplate must be a string containing {queueId}');
    }
    queueUrlTemplate = o.queueUrlTemplate;
  }
  let individualUrlTemplate: string | undefined;
  if (o.individualUrlTemplate !== undefined) {
    if (typeof o.individualUrlTemplate !== 'string' || !o.individualUrlTemplate.includes('{individualId}')) {
      fail('individualUrlTemplate must be a string containing {individualId}');
    }
    individualUrlTemplate = o.individualUrlTemplate;
  }
  let adminQueueUrlTemplate: string | undefined;
  if (o.adminQueueUrlTemplate !== undefined) {
    if (typeof o.adminQueueUrlTemplate !== 'string' || !o.adminQueueUrlTemplate.includes('{queueId}')) {
      fail('adminQueueUrlTemplate must be a string containing {queueId}');
    }
    adminQueueUrlTemplate = o.adminQueueUrlTemplate;
  }

  return {
    processId: o.processId,
    excludedQueues: o.excludedQueues,
    timeZone: o.timeZone,
    morningHour: hour,
    followUpDays,
    firstTextHours,
    dataSource: o.dataSource as DataSourceKind,
    audience: audience as Audience,
    chmsBaseUrl: o.chmsBaseUrl.replace(/\/+$/, ''),
    ...(queueUrlTemplate !== undefined ? { queueUrlTemplate } : {}),
    ...(individualUrlTemplate !== undefined ? { individualUrlTemplate } : {}),
    ...(adminQueueUrlTemplate !== undefined ? { adminQueueUrlTemplate } : {}),
  };
}

/** The bundled config/holy-nudge.config.json, validated. */
export function loadConfig(): HolyNudgeConfig {
  return parseConfig(raw);
}
