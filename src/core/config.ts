import raw from '../../config/holy-nudge.config.json';
import type { DataSourceKind, HolyNudgeConfig } from './types';

export class ConfigError extends Error {}

/** ChMS web UI queue page, pattern taken from real queue URLs (2026-11-17). Assumes the API queue id equals the web step_id; confirm with live data. */
export const DEFAULT_QUEUE_URL_TEMPLATE = '{chmsBaseUrl}/step_individuals.php?ax=my&step_id={queueId}';

/** Deep link to a queue in the ChMS web UI, from config.queueUrlTemplate (or the default). */
export function queueUrl(config: Pick<HolyNudgeConfig, 'chmsBaseUrl' | 'queueUrlTemplate'>, queueId: string): string {
  return (config.queueUrlTemplate ?? DEFAULT_QUEUE_URL_TEMPLATE)
    .replaceAll('{chmsBaseUrl}', config.chmsBaseUrl)
    .replaceAll('{queueId}', encodeURIComponent(queueId));
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

  const abq = o.adminsByQueue;
  if (typeof abq !== 'object' || abq === null || Array.isArray(abq)) fail('adminsByQueue must be an object');
  const adminsByQueue: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(abq)) {
    if (!isStringArray(v)) fail(`adminsByQueue["${k}"] must be an array of strings`);
    adminsByQueue[k] = v;
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

  if (o.dataSource !== 'fixture' && o.dataSource !== 'pushpay') fail('dataSource must be "fixture" or "pushpay"');

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

  return {
    processId: o.processId,
    excludedQueues: o.excludedQueues,
    adminsByQueue,
    timeZone: o.timeZone,
    morningHour: hour,
    dataSource: o.dataSource as DataSourceKind,
    chmsBaseUrl: o.chmsBaseUrl.replace(/\/+$/, ''),
    ...(queueUrlTemplate !== undefined ? { queueUrlTemplate } : {}),
  };
}

/** The bundled config/holy-nudge.config.json, validated. */
export function loadConfig(): HolyNudgeConfig {
  return parseConfig(raw);
}
