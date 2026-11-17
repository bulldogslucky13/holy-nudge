import type { HolyNudgeConfig, Person, Queue, QueueEntry } from '../src/core/types';

export const TZ = 'America/Chicago';

export function person(id: string, name = `Person ${id}`): Person {
  return { id, name };
}

export function entry(over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: 'e1',
    queueId: 'q1',
    status: 'IN_PROCESS',
    due: null,
    created: '2026-01-01T00:00:00Z',
    completed: null,
    assignee: person('L1', 'Lee'),
    individual: person('S1', 'Sam'),
    ...over,
  };
}

export function queue(over: Partial<Queue> = {}): Queue {
  return { id: 'q1', name: 'Queue One', processId: '37', managers: [], ...over };
}

export function config(over: Partial<HolyNudgeConfig> = {}): HolyNudgeConfig {
  return {
    processId: '37',
    excludedQueues: [],
    adminsByQueue: {},
    timeZone: TZ,
    morningHour: 8,
    dataSource: 'fixture',
    chmsBaseUrl: 'https://example.com',
    ...over,
  };
}
