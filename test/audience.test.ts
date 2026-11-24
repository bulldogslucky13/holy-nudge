// Staged release (docs/DECISIONS.md, 22 and 25): who sees data and who is nudged, by dataSource and audience.
import { describe, expect, it, vi } from 'vitest';
import { resolveMe } from '../src/api/me';
import { leaderAccess } from '../src/core/config';
import type { DataSource, QueueEntry } from '../src/core/types';
import { runDailyJob } from '../src/job/daily';
import type { Snapshot } from '../src/job/load';
import { FakeSender, FakeStore } from './fakes';
import { config, entry, person, queue } from './helpers';

const NOW = new Date('2026-01-15T14:00:00Z'); // 08:00 CST

type Role = 'owner' | 'staff' | 'coordinator' | 'leader';
const ROLES: Role[] = ['owner', 'staff', 'coordinator', 'leader'];

const q = queue({ id: 'q1', name: 'Outreach' });
/** Every invented person has one assigned student, overdue by due date, so each would be nudged if allowed. */
const entries: QueueEntry[] = ROLES.map((r, i) =>
  entry({ id: `e${i}`, queueId: 'q1', status: 'NOT_STARTED', due: '2026-01-05', assignee: person(`P-${r}`, `Invented ${r}`) }),
);
const snapshot: Snapshot = { queues: [q], entries };
const source = (): DataSource => ({ listQueues: async () => [q], listEntries: async () => entries });

function setup() {
  const store = new FakeStore();
  const id: Record<Role, number> = {
    owner: store.addLeader({ chmsIndividualId: 'P-owner', name: 'Invented owner', isAdmin: true, isOwner: true }, 1),
    staff: store.addLeader({ chmsIndividualId: 'P-staff', name: 'Invented staff', isAdmin: true }, 1),
    coordinator: store.addLeader({ chmsIndividualId: 'P-coordinator', name: 'Invented coordinator', coordinatorOf: ['Outreach'] }, 1),
    leader: store.addLeader({ chmsIndividualId: 'P-leader', name: 'Invented leader' }, 1),
  };
  return { store, id };
}

type Stage = { name: string; dataSource: 'fixture' | 'pushpay'; audience: 'staff' | 'everyone'; sees: Role[]; pushed: Role[] };
const STAGES: Stage[] = [
  { name: 'sample data (audience ignored: staff)', dataSource: 'fixture', audience: 'staff', sees: ['owner', 'staff'], pushed: ['owner'] },
  { name: 'sample data (audience ignored: everyone)', dataSource: 'fixture', audience: 'everyone', sees: ['owner', 'staff'], pushed: ['owner'] },
  { name: 'real data, audience staff', dataSource: 'pushpay', audience: 'staff', sees: ['owner', 'staff'], pushed: ['owner', 'staff'] },
  { name: 'real data, audience everyone', dataSource: 'pushpay', audience: 'everyone', sees: [...ROLES], pushed: [...ROLES] },
];

describe('leaderAccess', () => {
  it.each(STAGES)('$name', ({ dataSource, audience, sees, pushed }) => {
    const { store } = setup();
    for (const r of store.leaders) {
      const role = ROLES[store.leaders.indexOf(r)]!;
      expect(leaderAccess({ dataSource, audience }, r)).toEqual({ seesData: sees.includes(role), getsPush: pushed.includes(role) });
    }
  });
});

describe.each(STAGES)('$name', ({ dataSource, audience, sees, pushed }) => {
  const cfg = config({ dataSource, audience, excludedQueues: [] });

  it.each(ROLES)('/api/me for %s', async (role) => {
    const { store, id } = setup();
    const loader = vi.fn(async () => snapshot);
    const loadPhones = vi.fn(async () => new Map<string, string>());
    const r = await resolveMe({ store, config: cfg, leader: (await store.leaderById(id[role]))!, now: NOW, loadSnapshot: loader, loadPhones });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (sees.includes(role)) {
      expect(loader).toHaveBeenCalledTimes(1);
      expect(r.me.live).toBe(dataSource === 'pushpay'); // no "sample data" note for staff on real data
      expect(r.me.behind).toHaveLength(1);
    } else {
      // Pre-launch experience: nothing loaded, nothing shown, nothing looked up.
      expect(loader).not.toHaveBeenCalled();
      expect(loadPhones).not.toHaveBeenCalled();
      expect(r.me).toEqual({
        leader: { name: `Invented ${role}`, isAdmin: false, notificationsOn: true },
        live: false,
        behind: [],
        generatedAt: '2026-01-15T14:00:00Z',
      });
      expect('admin' in r.me).toBe(false);
    }
  });

  it('daily job pushes exactly the allowed rows', async () => {
    const { store, id } = setup();
    const sender = new FakeSender();
    const out = await runDailyJob({ config: cfg, store, sender, dataSource: source, now: NOW });
    expect(out.ran).toBe(true);
    const got = ROLES.filter((r) => sender.sent.some((s) => s.endpoint.startsWith(`https://push.example/${id[r]}/`)));
    expect(got).toEqual(pushed);
  });
});

describe('the staff stage, then everyone', () => {
  it('a non-staff leader with a device and overdue students gets no push and no snapshot load; "everyone" sends the same data', async () => {
    const { store, id } = setup();
    const staffCfg = config({ dataSource: 'pushpay', audience: 'staff', excludedQueues: [] });
    const sender = new FakeSender();
    await runDailyJob({ config: staffCfg, store, sender, dataSource: source, now: NOW });
    const toLeader = () => sender.sent.filter((s) => s.endpoint.startsWith(`https://push.example/${id.leader}/`));
    expect(toLeader()).toEqual([]);

    const loader = vi.fn(async () => snapshot);
    const before = await resolveMe({ store, config: staffCfg, leader: (await store.leaderById(id.leader))!, now: NOW, loadSnapshot: loader });
    expect(loader).not.toHaveBeenCalled();
    expect(before.ok && before.me.live).toBe(false);
    // Their device is still registered: nothing was deleted.
    expect(store.subs.filter((s) => s.leaderId === id.leader)).toHaveLength(1);

    const everyoneCfg = { ...staffCfg, audience: 'everyone' as const };
    await runDailyJob({ config: everyoneCfg, store, sender, dataSource: source, now: NOW });
    expect(toLeader().map((s) => s.payload.kind)).toEqual(['leader']);
    const after = await resolveMe({ store, config: everyoneCfg, leader: (await store.leaderById(id.leader))!, now: NOW, loadSnapshot: loader });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(after.ok && after.me.behind).toHaveLength(1);
  });
});
