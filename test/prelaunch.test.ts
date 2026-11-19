// Pre-launch: until real data is connected (dataSource "fixture"), only staff see or get nudged about
// the made-up sample students. Everyone else gets nothing from the sample data, however their row maps.
import { describe, expect, it, vi } from 'vitest';
import { buildMe, resolveMe } from '../src/api/me';
import { createDataSource } from '../src/chms/index';
import { createFixtureSource } from '../src/chms/fixture';
import { isLive, loadConfig } from '../src/core/config';
import type { LeaderRow } from '../src/db';
import { runDailyJob } from '../src/job/daily';
import { loadSnapshot } from '../src/job/load';
import { FakeSender, FakeStore } from './fakes';
import { config } from './helpers';

const NOW = new Date('2026-01-15T14:00:00Z'); // 08:00 CST
const row = (over: Partial<LeaderRow>): LeaderRow => ({
  id: 1, chmsIndividualId: null, name: 'X', hasLink: true, isAdmin: false, isOwner: false, lastSeenAt: null, revokedAt: null, subscriptionCount: 0, matchByHand: false, ...over,
});

const fixtureCfg = loadConfig(); // the bundled config; asserted below to be the fixture one
const liveCfg = { ...fixtureCfg, dataSource: 'pushpay' as const };

describe('isLive', () => {
  it('is false for the fixture and true for anything else', () => {
    expect(isLive({ dataSource: 'fixture' })).toBe(false);
    expect(isLive({ dataSource: 'pushpay' })).toBe(true);
    expect(isLive(fixtureCfg)).toBe(false); // still pre-launch in the bundled config
  });
});

describe('/api/me while not live', () => {
  /** The sample snapshot (made-up students, leaders and queue managers). */
  const ids = () => loadSnapshot(createFixtureSource(NOW, fixtureCfg.timeZone), fixtureCfg);

  it('non-staff mapped to every fixture leader and manager: empty behind, no admin, snapshot never loaded', async () => {
    const snap = await ids();
    const people = new Map<string, string>();
    for (const q of snap.queues) for (const m of q.managers) people.set(m.id, m.name);
    for (const e of snap.entries) if (e.assignee) people.set(e.assignee.id, e.assignee.name);
    expect(people.size).toBeGreaterThan(5);

    const loader = vi.fn(async () => {
      throw new Error('must not load the sample data');
    });
    const store = {
      upsertLeaders: vi.fn(async () => {
        throw new Error('no row creation for non-staff');
      }),
      listLeaders: vi.fn(async () => {
        throw new Error('no leader list for non-staff');
      }),
      applyMatches: vi.fn(async () => {
        throw new Error('no matching for non-staff');
      }),
    };
    let sawBehind = 0;
    for (const [chmsId, name] of people) {
      const leader = row({ chmsIndividualId: chmsId, name, subscriptionCount: 1 });
      // Control: with live data this very row would see students (leaders) or an admin view (managers).
      const live = buildMe({ config: liveCfg, snapshot: snap, leader, leaders: [leader], now: NOW });
      if (live.behind.length > 0 || live.admin) sawBehind++;

      const r = await resolveMe({ store, config: fixtureCfg, leader, now: NOW, loadSnapshot: loader });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.me).toEqual({
        leader: { name, isAdmin: false, notificationsOn: true },
        live: false,
        behind: [],
        generatedAt: '2026-01-15T14:00:00Z',
      });
      expect('admin' in r.me).toBe(false);
    }
    expect(sawBehind).toBeGreaterThan(0);
    expect(loader).not.toHaveBeenCalled();
    expect(store.upsertLeaders).not.toHaveBeenCalled();
    expect(store.listLeaders).not.toHaveBeenCalled();
    expect(store.applyMatches).not.toHaveBeenCalled();
  });

  it('buildMe itself refuses to show sample data to non-staff, even when handed a full snapshot', async () => {
    const snap = await ids();
    const manager = snap.queues.flatMap((q) => q.managers)[0]!;
    const me = buildMe({ config: fixtureCfg, snapshot: snap, leader: row({ chmsIndividualId: manager.id }), leaders: [], now: NOW });
    expect(me.behind).toEqual([]);
    expect(me.admin).toBeUndefined();
    expect(me.live).toBe(false);
  });

  it('staff are unchanged: sample data, admin view, live false', async () => {
    const staff = row({ id: 7, name: 'Staffer', isAdmin: true });
    const store = new FakeStore();
    store.addLeader({ name: 'Staffer', isAdmin: true });
    const r = await resolveMe({
      store,
      config: fixtureCfg,
      leader: staff,
      now: NOW,
      loadSnapshot: () => loadSnapshot(createDataSource(fixtureCfg, {} as never, NOW), fixtureCfg),
    });
    expect(r.ok && r.me.live).toBe(false);
    expect(r.ok && r.me.leader.isAdmin).toBe(true);
    expect(r.ok && r.me.admin?.byLeader.length).toBeGreaterThan(1);
    expect(r.ok && r.me.admin?.leaders?.length).toBeGreaterThan(5);
  });

  it('when live, non-staff are exactly as before: live true, their own list, implicit admin view', async () => {
    const snap = await ids();
    const manager = snap.queues.flatMap((q) => q.managers)[0]!;
    const store = new FakeStore();
    const m = store.addLeader({ name: manager.name, chmsIndividualId: manager.id });
    const r = await resolveMe({ store, config: liveCfg, leader: (await store.leaderById(m))!, now: NOW, loadSnapshot: async () => snap });
    expect(r.ok && r.me.live).toBe(true);
    expect(r.ok && r.me.leader.isAdmin).toBe(true);
    expect(r.ok && r.me.admin).toBeDefined();
  });

  it('a data-source failure for staff is reported by class name only', async () => {
    const r = await resolveMe({
      store: new FakeStore(),
      config: fixtureCfg,
      leader: row({ isAdmin: true }),
      now: NOW,
      loadSnapshot: async () => {
        throw new TypeError('secret upstream text');
      },
    });
    expect(r).toEqual({ ok: false, errorName: 'TypeError' });
  });
});

describe('daily job while not live', () => {
  const cfg = config({ dataSource: 'fixture', excludedQueues: ['DONE- do not move here unless you have left a note', 'Not Interested'] });
  const run = (store: FakeStore, sender: FakeSender, c = cfg) =>
    runDailyJob({ config: c, store, sender, dataSource: () => createDataSource(c, {} as never, NOW), now: NOW });

  async function sampleLeadersAndManagers() {
    const snap = await loadSnapshot(createFixtureSource(NOW, cfg.timeZone), cfg);
    const out = new Map<string, string>();
    for (const q of snap.queues) for (const m of q.managers) out.set(m.id, m.name);
    for (const e of snap.entries) if (e.assignee) out.set(e.assignee.id, e.assignee.name);
    return out;
  }

  it('sends nothing to non-staff rows (with or without a ChMS id), but still nudges staff', async () => {
    const people = await sampleLeadersAndManagers();
    const store = new FakeStore();
    const sender = new FakeSender();
    // A real volunteer row with no ChMS id, with a device.
    const noId = store.addLeader({ name: 'Real Volunteer' }, 1);
    // Non-staff rows that happen to map to every sample leader and queue manager, each with a device.
    const mapped = [...people].map(([chmsIndividualId, name]) => store.addLeader({ chmsIndividualId, name }, 1));
    // Staff: one with no ChMS id (global admin summary), one mapped to a sample leader (also gets the leader nudge).
    const staffPlain = store.addLeader({ name: 'Staffer', isAdmin: true }, 1);
    const [firstId, firstName] = [...people][0]!;
    store.leaders.find((l) => l.chmsIndividualId === firstId)!.isAdmin = true;
    expect(firstName).toBeTruthy();

    const out = await run(store, sender);
    expect(out.ran).toBe(true);

    const toLeader = (id: number) => sender.sent.filter((s) => s.endpoint.startsWith(`https://push.example/${id}/`));
    expect(toLeader(noId)).toEqual([]);
    const staffMappedId = store.leaders.find((l) => l.chmsIndividualId === firstId)!.id;
    for (const id of mapped.filter((i) => i !== staffMappedId)) expect(toLeader(id)).toEqual([]);

    expect(toLeader(staffPlain).map((s) => s.payload.kind)).toEqual(['admin']);
    // The mapped staff row still gets its summary (and its own leader nudge if it has students behind).
    expect(toLeader(staffMappedId).map((s) => s.payload.kind)).toContain('admin');
    // Everything sent went to staff, and only counts.
    const staffIds = new Set([staffPlain, staffMappedId]);
    for (const s of sender.sent) {
      const id = Number(/push\.example\/(\d+)\//.exec(s.endpoint)![1]);
      expect(staffIds.has(id)).toBe(true);
    }
    expect(out.ran && out.summary.adminsNudged).toBe(2);
  });

  it('the same rows DO get nudged once live (so the guard is the only thing holding them back)', async () => {
    const people = await sampleLeadersAndManagers();
    const store = new FakeStore();
    const sender = new FakeSender();
    for (const [chmsIndividualId, name] of people) store.addLeader({ chmsIndividualId, name }, 1);
    // The fixture source is still used for the data; only the config's liveness differs.
    await runDailyJob({
      config: { ...cfg, dataSource: 'pushpay' },
      store,
      sender,
      dataSource: () => createFixtureSource(NOW, cfg.timeZone),
      now: NOW,
    });
    expect(sender.sent.length).toBeGreaterThan(0);
    expect(sender.sent.some((s) => s.payload.kind === 'leader')).toBe(true);
    expect(sender.sent.some((s) => s.payload.kind === 'admin')).toBe(true);
  });
});
