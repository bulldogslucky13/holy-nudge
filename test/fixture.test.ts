import { describe, expect, it } from 'vitest';
import { allQueuesView, computeNudges, isBehind, isNewSinceLastRun, isOverdue, isPastFirstText, ownTriggered } from '../src/core/behind';
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

    // The fixture's queue managers grant nothing: no coordinator rows, no whole-queue views.
    expect(r.coordinators).toEqual([]);
    // Staff see everything that is not parked.
    const all = allQueuesView(queues, entries, config, NOW);
    const adminBehind = all.behindByLeader.flatMap((g) => g.entries);
    expect(adminBehind).toHaveLength(expectedBehind.length);
    expect(all.unassigned.length).toBeGreaterThan(3);
    // Nothing from the parking queues leaks through.
    expect(adminBehind.some((e) => parking.has(e.queueId))).toBe(false);
    // A coordinator of one sample queue (by exact name) sees that queue only.
    const one = computeNudges(queues, entries, config, NOW, [{ leaderId: 1, queueKeys: ['Service Team'] }]).coordinators;
    expect(one.map((c) => c.queueIds)).toEqual([['7']]);
  });

  it('exercises every nudge-timing case (last run 24 hours before now)', async () => {
    const { config, queues, entries } = await load(NOW);
    const w = { now: NOW, lastRunAt: new Date(NOW.getTime() - 24 * 3600 * 1000) };
    const tz = config.timeZone;
    const e = (id: string) => entries.find((x) => x.id === id)!;
    const facts = (id: string) => ({
      assigned: e(id).assignee !== null,
      isNew: isNewSinceLastRun(e(id), w, tz),
      overdue: isOverdue(e(id), NOW, config),
      pastFirstText: isPastFirstText(e(id), NOW, config),
    });
    expect(facts('E5035')).toMatchObject({ assigned: true, isNew: true, overdue: false }); // new assigned
    expect(facts('E5024')).toMatchObject({ assigned: true, isNew: false, overdue: false }); // grace week (3 days, no due date)
    expect(facts('E5012')).toMatchObject({ assigned: true, isNew: false, overdue: true }); // overdue by age (8 days, no due date)
    expect(e('E5012').due).toBeNull();
    expect(facts('E5016')).toMatchObject({ assigned: true, overdue: true }); // overdue by due date
    expect(e('E5016').due).not.toBeNull();
    expect(facts('E5033')).toMatchObject({ assigned: false, isNew: true, pastFirstText: false }); // new unassigned
    expect(facts('E5030')).toMatchObject({ assigned: false, isNew: false, pastFirstText: false }); // 2 days unassigned: quiet
    expect(facts('E5036')).toMatchObject({ assigned: false, isNew: false, pastFirstText: true }); // 4 days unassigned
    // A leader with a student waiting but nothing new or overdue: counted in the app, no push.
    const r = computeNudges(queues, entries, config, NOW);
    const quiet = r.leaders.find((l) => l.leader.id === 'L108')!;
    expect(quiet.behind.length).toBeGreaterThan(0);
    expect(ownTriggered(quiet.behind, w, config)).toBe(false);
  });
});
