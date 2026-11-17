import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig, queueUrl } from '../src/core/config';

describe('config', () => {
  it('bundled config loads with the spec defaults', () => {
    const c = loadConfig();
    expect(c.processId).toBe('37');
    expect(c.timeZone).toBe('America/Chicago');
    expect(c.morningHour).toBe(8);
    expect(c.excludedQueues).toContain('Not Interested');
    expect(c.excludedQueues).toContain('DONE- do not move here unless you have left a note');
    expect(c.chmsBaseUrl).toBe('https://wildwood.ccbchurch.com');
  });
  it('rejects bad values with a clear error', () => {
    const ok = loadConfig();
    expect(() => parseConfig(null)).toThrow(ConfigError);
    expect(() => parseConfig({ ...ok, timeZone: 'Mars/Olympus' })).toThrow(/timeZone/);
    expect(() => parseConfig({ ...ok, morningHour: 24 })).toThrow(/morningHour/);
    expect(() => parseConfig({ ...ok, dataSource: 'csv' })).toThrow(/dataSource/);
    expect(() => parseConfig({ ...ok, adminsByQueue: { Staff: 'M1' } })).toThrow(/adminsByQueue/);
    expect(() => parseConfig({ ...ok, excludedQueues: [1] })).toThrow(/excludedQueues/);
  });
  it('builds queue URLs from the default or a configured template', () => {
    const ok = loadConfig();
    expect(queueUrl(ok, '5')).toBe('https://wildwood.ccbchurch.com/process_queue_list.php?queue_id=5');
    const custom = parseConfig({ ...ok, queueUrlTemplate: '{chmsBaseUrl}/q/{queueId}' });
    expect(queueUrl(custom, 'a b')).toBe('https://wildwood.ccbchurch.com/q/a%20b');
    expect(() => parseConfig({ ...ok, queueUrlTemplate: '{chmsBaseUrl}/q' })).toThrow(/queueUrlTemplate/);
  });
});
