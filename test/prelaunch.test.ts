// Pre-launch: until real data is connected (dataSource "fixture"), only staff see or get nudged about
// the made-up sample students. Everyone else gets nothing from the sample data, however their row maps.
import { describe, expect, it, vi } from 'vitest';
import { buildMe, resolveMe } from '../src/api/me';
import { createDataSource } from '../src/chms/index';
import { createFixtureSource } from '../src/chms/fixture';
import { isLive, loadConfig } from '../src/core/config';
import type { HolyNudgeConfig } from '../src/core/types';
import type { LeaderRow } from '../src/db';
import { runDailyJob } from '../src/job/daily';
import { loadSnapshot } from '../src/job/load';
import { FakeSender, FakeStore } from './fakes';
import { config } from './helpers';

const NOW = new Date('2026-01-15T14:00:00Z'); // 08:00 CST
const row = (over: Partial<LeaderRow>): LeaderRow => ({
  id: 1, chmsIndividualId: null, name: 'X', hasLink: true, isAdmin: false, isOwner: false, lastSeenAt: null, revokedAt: null, subscriptionCount: 0, matchByHand: false, coordinatorOf: [], ...over,
});

const shipped = loadConfig(); // the bundled config: real data, released to staff first (asserted below)
const fixtureCfg: HolyNudgeConfig = { ...shipped, dataSource: 'fixture' };
const liveCfg = { ...fixtureCfg, dataSource: 'pushpay' as const, audience: 'everyone' as const };

describe('isLive', () => {
  it('is false for the fixture and true for anything else', () => {
    expect(isLive({ dataSource: 'fixture' })).toBe(false);
    expect(isLive({ dataSource: 'pushpay' })).toBe(true);
    expect(isLive(fixtureCfg)).toBe(false);
    // The bundled config: real data is on, for staff only. Opening it to everyone is a deliberate change
    // to config/holy-nudge.config.json and to this line (docs/DECISIONS.md, 25).
    expect({ dataSource: shipped.dataSource, audience: shipped.audience }).toEqual({ dataSource: 'pushpay', audience: 'staff' });
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
      // Each also marked as a coordinator: that must not open the sample data either.
      const leader = row({ chmsIndividualId: chmsId, name, subscriptionCount: 1, coordinatorOf: ['Service Team'] });
      // Control: with live data this very row would see students (leaders) and a coordinator view.
      const live = buildMe({ config: liveCfg, snapshot: snap, leader, leaders: [leader], now: NOW });
      expect(live.admin).toBeDefined();
      if (live.behind.length > 0) sawBehind++;

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
    const me = buildMe({ config: fixtureCfg, snapshot: snap, leader: row({ chmsIndividualId: manager.id, coordinatorOf: ['3', 'Service Team'] }), leaders: [], now: NOW });
    expect(me.behind).toEqual([]);
    expect(me.admin).toBeUndefined();
    expect(me.live).toBe(false);
  });

  it('staff are unchanged: sample data, admin view, live false', async () => {
    const store = new FakeStore();
    // The authenticated row always comes from the store, so its id is the store's.
    const staff = (await store.leaderById(store.addLeader({ name: 'Staffer', isAdmin: true })))!;
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
    // The sample people are not turned into leader rows: staff see only the real row.
    expect(r.ok && r.me.admin?.leaders?.map((l) => l.name)).toEqual(['Staffer']);
    expect(store.leaders).toHaveLength(1);
  });

  it('staff view: rows before and after are identical on sample data; under a live config the sample people do get rows', async () => {
    const view = async (c: typeof fixtureCfg) => {
      const store = new FakeStore();
      store.addLeader({ name: 'Real Volunteer' });
      const staff = (await store.leaderById(store.addLeader({ name: 'Staffer', isAdmin: true })))!;
      const before = JSON.stringify(store.leaders);
      const r = await resolveMe({ store, config: c, leader: staff, now: NOW, loadSnapshot: () => loadSnapshot(createFixtureSource(NOW, c.timeZone), c) });
      expect(r.ok).toBe(true);
      return { store, before };
    };
    const sample = await view(fixtureCfg);
    expect(JSON.stringify(sample.store.leaders)).toBe(sample.before);
    const live = await view(liveCfg);
    expect(live.store.leaders.length).toBeGreaterThan(5);
    expect(live.store.leaders.some((l) => l.chmsIndividualId !== null && l.linkToken === null)).toBe(true);
  });

  it('when live, non-staff are exactly as before: live true, their own list; a whole-queue view only as a marked coordinator', async () => {
    const snap = await ids();
    const manager = snap.queues.flatMap((q) => q.managers)[0]!;
    const store = new FakeStore();
    const m = store.addLeader({ name: manager.name, chmsIndividualId: manager.id });
    const r = await resolveMe({ store, config: liveCfg, leader: (await store.leaderById(m))!, now: NOW, loadSnapshot: async () => snap });
    expect(r.ok && r.me.live).toBe(true);
    // A Lead queue manager, not marked: no whole-queue view.
    expect(r.ok && r.me.leader.isAdmin).toBe(false);
    expect(r.ok && 'admin' in r.me).toBe(false);
    store.leaders.find((l) => l.id === m)!.coordinatorOf = ['Connect Card Coordinators'];
    const c = await resolveMe({ store, config: liveCfg, leader: (await store.leaderById(m))!, now: NOW, loadSnapshot: async () => snap });
    expect(c.ok && c.me.leader.isAdmin).toBe(true);
    expect(c.ok && c.me.admin).toBeDefined();
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

  it('sends nothing to anyone but the owner: not to non-staff rows (with or without a ChMS id), not to other staff', async () => {
    const people = await sampleLeadersAndManagers();
    const store = new FakeStore();
    const sender = new FakeSender();
    // A real volunteer row with no ChMS id, with a device.
    const noId = store.addLeader({ name: 'Real Volunteer', coordinatorOf: ['Connect Card Coordinators'] }, 1);
    // Non-staff rows that happen to map to every sample leader and queue manager, each with a device.
    // Each also marked as a coordinator: before launch that must not send them anything either.
    const mapped = [...people].map(([chmsIndividualId, name]) => store.addLeader({ chmsIndividualId, name, coordinatorOf: ['Service Team'] }, 1));
    // Staff who is not the owner, with a device: sees sample data in the app, but gets no push about it.
    const staffPlain = store.addLeader({ name: 'Staffer', isAdmin: true }, 1);
    // Owners: one with no ChMS id (global admin summary), one mapped to a sample leader (also gets the leader nudge).
    const ownerPlain = store.addLeader({ name: 'Owner', isAdmin: true, isOwner: true }, 1);
    const [firstId, firstName] = [...people][0]!;
    const mappedOwner = store.leaders.find((l) => l.chmsIndividualId === firstId)!;
    mappedOwner.isAdmin = true;
    mappedOwner.isOwner = true;
    expect(firstName).toBeTruthy();

    const out = await run(store, sender);
    expect(out.ran).toBe(true);

    const toLeader = (id: number) => sender.sent.filter((s) => s.endpoint.startsWith(`https://push.example/${id}/`));
    expect(toLeader(noId)).toEqual([]);
    const staffMappedId = store.leaders.find((l) => l.chmsIndividualId === firstId)!.id;
    for (const id of mapped.filter((i) => i !== staffMappedId)) expect(toLeader(id)).toEqual([]);

    expect(toLeader(staffPlain)).toEqual([]);
    expect(toLeader(ownerPlain).map((s) => s.payload.kind)).toEqual(['admin']);
    // The mapped owner row gets one push: its summary, combined with its own count if it has students behind.
    const mappedPushes = toLeader(staffMappedId);
    expect(mappedPushes).toHaveLength(1);
    expect(mappedPushes[0]!.payload.body).toMatch(/^\d+ waiting across all queues|^Across /);
    // Everything sent went to an owner, and only counts.
    const staffIds = new Set([ownerPlain, staffMappedId]);
    for (const s of sender.sent) {
      const id = Number(/push\.example\/(\d+)\//.exec(s.endpoint)![1]);
      expect(staffIds.has(id)).toBe(true);
    }
    expect(out.ran && out.summary.adminsNudged).toBe(2);
  });

  it('creates no leader rows from sample people and matches nothing: the leaders table is exactly what it was', async () => {
    const store = new FakeStore();
    store.addLeader({ name: 'Staffer', isAdmin: true }, 1);
    store.addLeader({ name: 'Real Volunteer' });
    const before = JSON.stringify(store.leaders);
    const out = await run(store, new FakeSender());
    expect(out.ran && out.summary.leadersMatched).toBe(0);
    expect(JSON.stringify(store.leaders)).toBe(before);
  });

  it('under a live config the same run creates rows for the people it sees and matches name-only rows', async () => {
    const people = [...(await sampleLeadersAndManagers())];
    const store = new FakeStore();
    store.addLeader({ name: people[0]![1] }); // name-only row for one sample person
    const out = await runDailyJob({ config: { ...cfg, dataSource: 'pushpay', audience: 'everyone' }, store, sender: new FakeSender(), dataSource: () => createFixtureSource(NOW, cfg.timeZone), now: NOW });
    expect(out.ran && out.summary.leadersMatched).toBe(1);
    expect(store.leaders).toHaveLength(people.length);
    expect(store.leaders.filter((l) => l.chmsIndividualId !== null)).toHaveLength(people.length);
  });

  it('the same rows DO get nudged once live (so the guard is the only thing holding them back)', async () => {
    const people = await sampleLeadersAndManagers();
    const store = new FakeStore();
    const sender = new FakeSender();
    for (const [chmsIndividualId, name] of people) store.addLeader({ chmsIndividualId, name, coordinatorOf: ['Connect Card Coordinators', 'Service Team'] }, 1);
    // The fixture source is still used for the data; only the config's liveness differs.
    await runDailyJob({
      config: { ...cfg, dataSource: 'pushpay', audience: 'everyone' },
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
