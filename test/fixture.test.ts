import { describe, expect, it } from 'vitest';
import { computeNudges, isBehind } from '../src/core/behind';
import { loadConfig } from '../src/core/config';
import { createFixtureSource } from '../src/chms/fixture';
import { addDays, zonedDate } from '../src/core/time';

async function load(now: Date) {
  const config = loadConfig();
  const source = createFixtureSource(now, config.timeZone);
  const queues = await source.listQueues(config.processId);
  const entries = (await Promise.all(queues.map((q) => source.listEntries(q.id)))).flat();
  return { config, source, queues, entries };
}

const NOW = new Date('2026-11-17T15:00:00Z');

describe('fixture source', () => {
  it('models process 37 at small scale', async () => {
    const { queues, entries } = await load(NOW);
    expect(queues).toHaveLength(12);
    expect(entries.length).toBeGreaterThanOrEqual(55);
    expect(entries.length).toBeLessThanOrEqual(70);
    expect(await createFixtureSource(NOW).listQueues('999')).toEqual([]);
  });

  it('resolves offsets against the injected now', async () => {
    const a = await load(NOW);
    const b = await load(new Date(NOW.getTime() + 10 * 24 * 3600 * 1000));
    const today = zonedDate(NOW, 'America/Chicago');
    const dueA = a.entries.find((e) => e.id === 'E5017')!.due; // dueOffsetDays 0
    expect(dueA).toBe(today);
    expect(b.entries.find((e) => e.id === 'E5017')!.due).toBe(addDays(today, 10));
  });

  it('uses only invented contact details', async () => {
    const { entries } = await load(NOW);
    for (const e of entries) {
      if (e.individual.phone) expect(e.individual.phone).toMatch(/^555-01\d\d$/);
      if (e.individual.email) expect(e.individual.email).toMatch(/@example\.com$/);
    }
  });

  it('full computation gives sane totals', async () => {
    const { config, queues, entries } = await load(NOW);
    const r = computeNudges(queues, entries, config, NOW);

    const parking = new Set(queues.filter((q) => config.excludedQueues.includes(q.name)).map((q) => q.id));
    expect(parking.size).toBe(2);
    const included = entries.filter((e) => !parking.has(e.queueId));
    const expectedBehind = included.filter((e) => isBehind(e, NOW, config.timeZone));

    expect(r.leaders.length).toBeGreaterThan(3);
    expect(r.leaders.length).toBeLessThanOrEqual(8);
    const leaderTotal = r.leaders.reduce((n, l) => n + l.behind.length, 0);
    expect(leaderTotal).toBe(expectedBehind.filter((e) => e.assignee).length);
    expect(leaderTotal).toBeGreaterThan(10);
    expect(r.leaders.every((l) => l.behind.length > 0)).toBe(true);

    // Two fixture managers administer everything by default.
    expect(r.admins.map((a) => a.adminId).sort()).toEqual(['M201', 'M202']);
    const adminBehind = r.admins.flatMap((a) => a.behindByLeader.flatMap((g) => g.entries));
    expect(adminBehind).toHaveLength(expectedBehind.length); // each queue has exactly one admin
    expect(r.admins.flatMap((a) => a.staleUnassigned).length).toBeGreaterThan(3);
    // Nothing from the parking queues leaks through.
    expect(adminBehind.some((e) => parking.has(e.queueId))).toBe(false);
  });
});
