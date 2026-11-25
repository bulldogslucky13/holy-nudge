import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig, queueUrl, adminQueueUrl, entryUrl, individualUrl } from '../src/core/config';

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
    expect(() => parseConfig({ ...ok, excludedQueues: [1] })).toThrow(/excludedQueues/);
    expect(() => parseConfig({ ...ok, followUpDays: 0 })).toThrow(/followUpDays/);
    expect(() => parseConfig({ ...ok, followUpDays: 1.5 })).toThrow(/followUpDays/);
    expect(() => parseConfig({ ...ok, firstTextHours: '72' })).toThrow(/firstTextHours/);
  });
  it('audience: bundled value is staff, absent defaults to staff, anything else is rejected', () => {
    const ok = loadConfig();
    expect(ok.audience).toBe('staff');
    const { audience: _a, ...rest } = ok;
    expect(parseConfig(rest).audience).toBe('staff');
    expect(parseConfig({ ...ok, audience: 'everyone' }).audience).toBe('everyone');
    for (const bad of ['all', 'Staff', '', null, 1, true]) expect(() => parseConfig({ ...ok, audience: bad })).toThrow(/audience/);
  });
  it('refuses the removed adminsByQueue key, even empty, pointing at the coordinator rows instead', () => {
    const ok = loadConfig();
    expect('adminsByQueue' in ok).toBe(false);
    for (const v of [{}, { Staff: ['M1'] }]) {
      expect(() => parseConfig({ ...ok, adminsByQueue: v })).toThrow(/adminsByQueue is no longer supported.*--coordinator-of/);
    }
  });
  it('nudge-timing thresholds default to one week and 72 hours', () => {
    const ok = loadConfig();
    expect(ok).toMatchObject({ followUpDays: 7, firstTextHours: 72 });
    const { followUpDays: _d, firstTextHours: _h, ...rest } = ok;
    expect(parseConfig(rest)).toMatchObject({ followUpDays: 7, firstTextHours: 72 });
    expect(parseConfig({ ...ok, followUpDays: 10, firstTextHours: 48 })).toMatchObject({ followUpDays: 10, firstTextHours: 48 });
  });
  it('builds queue URLs from the default or a configured template', () => {
    const ok = loadConfig();
    expect(queueUrl(ok, '5')).toBe('https://wildwood.ccbchurch.com/step_individuals.php?ax=my&step_id=5');
    const custom = parseConfig({ ...ok, queueUrlTemplate: '{chmsBaseUrl}/q/{queueId}' });
    expect(queueUrl(custom, 'a b')).toBe('https://wildwood.ccbchurch.com/q/a%20b');
    expect(() => parseConfig({ ...ok, queueUrlTemplate: '{chmsBaseUrl}/q' })).toThrow(/queueUrlTemplate/);
  });

  it('builds Lead profile URLs from the default or a configured template', () => {
    const ok = loadConfig();
    expect('individualUrlTemplate' in ok).toBe(false); // the default is right, so the bundled file leaves it out
    expect(individualUrl(ok, '12345')).toBe('https://wildwood.ccbchurch.com/goto/individuals/12345');
    expect(individualUrl(ok, 'a b/c?d')).toBe('https://wildwood.ccbchurch.com/goto/individuals/a%20b%2Fc%3Fd');
    const custom = parseConfig({ ...ok, individualUrlTemplate: '{chmsBaseUrl}/people/{individualId}/view' });
    expect(individualUrl(custom, '77')).toBe('https://wildwood.ccbchurch.com/people/77/view');
    expect(() => parseConfig({ ...ok, individualUrlTemplate: '{chmsBaseUrl}/people' })).toThrow(/individualUrlTemplate/);
    expect(() => parseConfig({ ...ok, individualUrlTemplate: '{chmsBaseUrl}/people/{queueId}' })).toThrow(/individualUrlTemplate/);
    expect(() => parseConfig({ ...ok, individualUrlTemplate: 5 })).toThrow(/individualUrlTemplate/);
    // A student's own card: the web individual_step_id is the API entry id (confirmed against Lead 2026-11-25).
    expect('entryUrlTemplate' in ok).toBe(false);
    expect(entryUrl(ok, '30353')).toBe('https://wildwood.ccbchurch.com/step_manage_ind.php?individual_step_id=30353');
    expect(entryUrl(ok, 'a b&c')).toBe('https://wildwood.ccbchurch.com/step_manage_ind.php?individual_step_id=a%20b%26c');
    expect(entryUrl(parseConfig({ ...ok, entryUrlTemplate: '{chmsBaseUrl}/cards/{entryId}' }), '9')).toBe('https://wildwood.ccbchurch.com/cards/9');
    expect(() => parseConfig({ ...ok, entryUrlTemplate: '{chmsBaseUrl}/cards' })).toThrow(/entryUrlTemplate/);
    expect(() => parseConfig({ ...ok, entryUrlTemplate: 5 })).toThrow(/entryUrlTemplate/);
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
