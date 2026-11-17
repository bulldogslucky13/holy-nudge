// Sample-data DataSource. Fixture JSON stores offsets relative to "now" so the data always looks current.
import peopleJson from '../../fixtures/people.json';
import queuesJson from '../../fixtures/queues.json';
import entriesJson from '../../fixtures/entries.json';
import { HOUR_MS, addDays, zonedDate } from '../core/time';
import type { DataSource, Person, Queue, QueueEntry, Status } from '../core/types';

interface FixtureEntry {
  id: string;
  queueId: string;
  status: Status;
  /** Whole calendar days from today (in the zone); null = no due date. */
  dueOffsetDays: number | null;
  /** Hours relative to now (negative = in the past). */
  createdOffsetHours: number;
  completedOffsetHours: number | null;
  assigneeId: string | null;
  individual: Person;
}

interface FixtureQueues {
  processId: string;
  queues: { id: string; name: string; managerIds: string[] }[];
}

const people = peopleJson as Person[];
const fixtureQueues = queuesJson as FixtureQueues;
const fixtureEntries = entriesJson as FixtureEntry[];

const peopleById = new Map(people.map((p) => [p.id, p]));

function person(id: string): Person {
  const p = peopleById.get(id);
  if (!p) throw new Error(`Fixture references unknown person ${id}`);
  return p;
}

const at = (now: Date, offsetHours: number) => new Date(now.getTime() + offsetHours * HOUR_MS).toISOString();

/** A DataSource over fixtures/*.json, with all offsets resolved against `now`. */
export function createFixtureSource(now: Date, timeZone = 'America/Chicago'): DataSource {
  const today = zonedDate(now, timeZone);

  const queues: Queue[] = fixtureQueues.queues.map((q) => ({
    id: q.id,
    name: q.name,
    processId: fixtureQueues.processId,
    managers: q.managerIds.map(person),
  }));

  const entries: QueueEntry[] = fixtureEntries.map((e) => ({
    id: e.id,
    queueId: e.queueId,
    status: e.status,
    due: e.dueOffsetDays === null ? null : addDays(today, e.dueOffsetDays),
    created: at(now, e.createdOffsetHours),
    completed: e.completedOffsetHours === null ? null : at(now, e.completedOffsetHours),
    assignee: e.assigneeId === null ? null : person(e.assigneeId),
    individual: e.individual,
  }));

  return {
    async listQueues(processId) {
      return processId === fixtureQueues.processId ? queues : [];
    },
    async listEntries(queueId) {
      return entries.filter((e) => e.queueId === queueId);
    },
  };
}
