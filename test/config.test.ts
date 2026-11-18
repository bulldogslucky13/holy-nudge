import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig, queueUrl, adminQueueUrl } from '../src/core/config';

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
    expect(queueUrl(ok, '5')).toBe('https://wildwood.ccbchurch.com/step_individuals.php?ax=my&step_id=5');
    const custom = parseConfig({ ...ok, queueUrlTemplate: '{chmsBaseUrl}/q/{queueId}' });
    expect(queueUrl(custom, 'a b')).toBe('https://wildwood.ccbchurch.com/q/a%20b');
    expect(() => parseConfig({ ...ok, queueUrlTemplate: '{chmsBaseUrl}/q' })).toThrow(/queueUrlTemplate/);
  });

  it('builds admin queue links filtered by status across all assignees', () => {
    const c = { chmsBaseUrl: 'https://wildwood.ccbchurch.com' };
    const base = 'https://wildwood.ccbchurch.com/step_individuals.php?ax=my&search_flag=1&step_id=232&srch%5Bstatus_id%5D=';
    expect(adminQueueUrl(c, '232', 'NOT_STARTED')).toBe(base + '3&srch%5Bassigned%5D=all');
    expect(adminQueueUrl(c, '232', 'WAITING')).toBe(base + '0&srch%5Bassigned%5D=all');
    expect(adminQueueUrl(c, '232', 'DONE')).toBe(base + '2&srch%5Bassigned%5D=all');
    expect(adminQueueUrl(c, '232', 'IN_PROCESS')).toBe(base + '1&srch%5Bassigned%5D=all');
  });
});
