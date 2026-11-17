import raw from '../../config/holy-nudge.config.json';
import type { DataSourceKind, HolyNudgeConfig } from './types';

export class ConfigError extends Error {}

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

  return {
    processId: o.processId,
    excludedQueues: o.excludedQueues,
    adminsByQueue,
    timeZone: o.timeZone,
    morningHour: hour,
    dataSource: o.dataSource as DataSourceKind,
    chmsBaseUrl: o.chmsBaseUrl.replace(/\/+$/, ''),
  };
}

/** The bundled config/holy-nudge.config.json, validated. */
export function loadConfig(): HolyNudgeConfig {
  return parseConfig(raw);
}
