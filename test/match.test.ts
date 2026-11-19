// Matching leaders added by name to their Lead (ChMS) person: the automatic rules (daily job and staff page
// views), the manual POST /api/leader-match, and what /api/me tells staff. Real D1 (node:sqlite) with every
// migration, so the merge SQL itself is exercised. All names are made up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestPost as leaderMatch } from '../functions/api/leader-match';
import { onRequestGet as me } from '../functions/api/me';
import { resolveMe } from '../src/api/me';
import { computeNudges } from '../src/core/behind';
import { RATE_LIMITS } from '../src/api/http';
import { createFixtureSource } from '../src/chms/fixture';
import { loadConfig } from '../src/core/config';
import { normalizeName, planMatches, type MatchRow } from '../src/core/match';
import { createD1Store, hashToken, type Store } from '../src/db';
import { runDailyJob } from '../src/job/daily';
import { loadSnapshot, peopleSeen, syncLeaders } from '../src/job/load';
import { FakeSender } from './fakes';
import { config, entry, person, queue } from './helpers';
import { createTestD1, type TestD1 } from './sqlite-d1';

const MIGRATIONS = ['migrations/0001_init.sql', 'migrations/0002_oauth.sql', 'migrations/0003_link_tokens.sql', 'migrations/0004_lead_match.sql', 'migrations/0005_queue_coordinators.sql'];
const HOST = 'https://holynudge.cameronbristol.xyz';

let t: TestD1;
let store: Store;

beforeEach(async () => {
  t = await createTestD1(...MIGRATIONS);
  store = createD1Store(t.db);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Insert a row directly; returns its id. `token` gives it a working link (hash stored). */
async function insert(r: { name: string; chms?: string | null; token?: string | null; admin?: boolean; owner?: boolean; lastSeen?: string; revoked?: string; byHand?: boolean; devices?: number; coordinates?: string[] }): Promise<number> {
  const res = t.sqlite
    .prepare('INSERT INTO leaders (chms_individual_id, name, token_hash, is_admin, is_owner, last_seen_at, revoked_at, match_by_hand) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .get(r.chms ?? null, r.name, r.token ? await hashToken(r.token) : null, r.admin ? 1 : 0, r.owner ? 1 : 0, r.lastSeen ?? null, r.revoked ?? null, r.byHand ? 1 : 0) as { id: number };
  for (let i = 0; i < (r.devices ?? 0); i++) {
    t.sqlite.prepare("INSERT INTO push_subscriptions (leader_id, endpoint, p256dh, auth) VALUES (?, ?, 'k', 'a')").run(res.id, `https://web.push.apple.com/${res.id}/${i}`);
  }
  for (const k of r.coordinates ?? []) t.sqlite.prepare('INSERT INTO queue_coordinators (leader_id, queue_key) VALUES (?, ?)').run(res.id, k);
  return res.id;
}
const rows = () => t.sqlite.prepare('SELECT id, chms_individual_id AS chms, name, token_hash, is_admin, is_owner, last_seen_at, revoked_at, match_by_hand FROM leaders ORDER BY id').all() as Record<string, unknown>[];
const rowById = (id: number) => rows().find((r) => r.id === id);
/** Every coordinator row, as [leader id, key], sorted: shows exactly whose they are. */
const coordinatorRows = () =>
  (t.sqlite.prepare('SELECT leader_id, queue_key FROM queue_coordinators ORDER BY leader_id, queue_key').all() as { leader_id: number; queue_key: string }[]).map((c) => [c.leader_id, c.queue_key]);
const subsOf = (id: number) => (t.sqlite.prepare('SELECT endpoint FROM push_subscriptions WHERE leader_id = ? ORDER BY endpoint').all(id) as { endpoint: string }[]).map((s) => s.endpoint);

describe('normalizeName', () => {
  it('trims, collapses whitespace and ignores case', () => {
    expect(normalizeName('  Pat   Q.  Fakerly ')).toBe('pat q. fakerly');
    expect(normalizeName('PAT Q. FAKERLY')).toBe('pat q. fakerly');
    expect(normalizeName('Élise Mockwell')).toBe(normalizeName('Élise Mockwell'));
  });
});

describe('automatic matching (syncLeaders)', () => {
  it('ties a unique name-only row to its Lead person, keeping link, devices, role, last seen; the spare row goes', async () => {
    const tokenR = 'name-only-token-aaaaaaaaaaaaaaaaaaaaaa';
    const r = await insert({ name: 'Pat Fakerly', token: tokenR, admin: true, lastSeen: '2026-11-18T14:00:00.000Z', devices: 2 });
    const spare = await insert({ name: 'Pat Fakerly', chms: 'P1' }); // created by an earlier run, no link
    const n = await syncLeaders(store, [{ id: 'P1', name: '  pat   FAKERLY ' }, { id: 'P2', name: 'Other Personsen' }]);
    expect(n).toBe(1);
    expect(rowById(spare)).toBeUndefined();
    expect(rowById(r)).toMatchObject({ chms: 'P1', name: 'Pat Fakerly', token_hash: await hashToken(tokenR), is_admin: 1, is_owner: 0, last_seen_at: '2026-11-18T14:00:00.000Z', revoked_at: null, match_by_hand: 0 });
    expect(subsOf(r)).toHaveLength(2);
    expect((await store.leaderByToken(tokenR))?.chmsIndividualId).toBe('P1');
    // Exactly one row per Lead person, the other person untouched.
    expect(rows().filter((x) => x.chms === 'P1')).toHaveLength(1);
    expect(rows().filter((x) => x.chms === 'P2')).toHaveLength(1);
    expect(t.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('works when the Lead person is seen for the first time (the spare row is made and merged in one go)', async () => {
    const r = await insert({ name: 'Robin Notreal', token: 'robin-token-bbbbbbbbbbbbbbbbbbbbbbbbbb', owner: true, admin: true });
    expect(await syncLeaders(store, [{ id: 'P7', name: 'Robin Notreal' }])).toBe(1);
    expect(rows()).toEqual([expect.objectContaining({ id: r, chms: 'P7', is_owner: 1 })]);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const r = await insert({ name: 'Pat Fakerly', token: 'pat-token-cccccccccccccccccccccccccccc', devices: 1 });
    const people = [{ id: 'P1', name: 'Pat Fakerly' }];
    expect(await syncLeaders(store, people)).toBe(1);
    const before = rows();
    expect(await syncLeaders(store, people)).toBe(0);
    expect(rows()).toEqual(before);
    expect(rowById(r)!.chms).toBe('P1');
    expect(subsOf(r)).toHaveLength(1);
  });

  it('two name-only rows with the same name: no match', async () => {
    const a = await insert({ name: 'Sam Doublename', token: 'sam-a-token-dddddddddddddddddddddddddd' });
    const b = await insert({ name: 'sam  doublename', token: 'sam-b-token-eeeeeeeeeeeeeeeeeeeeeeeeee' });
    expect(await syncLeaders(store, [{ id: 'P1', name: 'Sam Doublename' }])).toBe(0);
    expect(rowById(a)!.chms).toBeNull();
    expect(rowById(b)!.chms).toBeNull();
    expect(rows().filter((x) => x.chms === 'P1')).toHaveLength(1); // the person's own (linkless) row stays
  });

  it('two Lead people with the same name: no match (seen today, or one known only from an existing row)', async () => {
    const r = await insert({ name: 'Jo Twinly', token: 'jo-token-ffffffffffffffffffffffffffffff' });
    expect(await syncLeaders(store, [{ id: 'P1', name: 'Jo Twinly' }, { id: 'P2', name: 'JO TWINLY' }])).toBe(0);
    expect(rowById(r)!.chms).toBeNull();

    const t2 = await createTestD1(...MIGRATIONS);
    t = t2;
    store = createD1Store(t2.db);
    const r2 = await insert({ name: 'Jo Twinly', token: 'jo-token-ffffffffffffffffffffffffffffff' });
    await insert({ name: 'Jo Twinly', chms: 'P9' }); // a Lead person from an earlier day, not seen today
    expect(await syncLeaders(store, [{ id: 'P1', name: 'Jo Twinly' }])).toBe(0);
    expect(rowById(r2)!.chms).toBeNull();
  });

  it('a Lead person already tied to a row with a link: no match, and neither row changes (never merges two linked rows)', async () => {
    const tied = await insert({ name: 'Kit Holder', chms: 'P1', token: 'kit-held-token-gggggggggggggggggggggggg' });
    const r = await insert({ name: 'Kit Holder Two', token: 'kit-two-token-hhhhhhhhhhhhhhhhhhhhhhhhh' });
    // Same name as the tied person's Lead name, but that person is held by a linked row.
    t.sqlite.prepare('UPDATE leaders SET name = ? WHERE id = ?').run('kit holder', r);
    expect(await syncLeaders(store, [{ id: 'P1', name: 'Kit Holder' }])).toBe(0);
    expect(rowById(tied)!.chms).toBe('P1');
    expect(rowById(r)!.chms).toBeNull();
    expect(rows()).toHaveLength(2);
  });

  it('a Lead person whose row is staff, owner or has devices (even without a link) is not taken over', async () => {
    for (const holder of [{ admin: true }, { owner: true }, { devices: 1 }]) {
      t = await createTestD1(...MIGRATIONS);
      store = createD1Store(t.db);
      const h = await insert({ name: 'Lee Heldover', chms: 'P1', ...holder });
      const r = await insert({ name: 'Lee Heldover', token: 'lee-token-iiiiiiiiiiiiiiiiiiiiiiiiiiiii' });
      expect(await syncLeaders(store, [{ id: 'P1', name: 'Lee Heldover' }])).toBe(0);
      expect(rowById(h)!.chms).toBe('P1');
      expect(rowById(r)!.chms).toBeNull();
    }
  });

  it('leaves a row whose match staff cleared by hand alone', async () => {
    const r = await insert({ name: 'Dee Cleared', token: 'dee-token-jjjjjjjjjjjjjjjjjjjjjjjjjjjjj', byHand: true });
    expect(await syncLeaders(store, [{ id: 'P1', name: 'Dee Cleared' }])).toBe(0);
    expect(rowById(r)!.chms).toBeNull();
  });

  it('needs the exact name: no partial, first-name or nickname matches', async () => {
    const r = await insert({ name: 'Alex Mockley', token: 'alex-token-kkkkkkkkkkkkkkkkkkkkkkkkkkkk' });
    expect(await syncLeaders(store, [{ id: 'P1', name: 'Alexander Mockley' }, { id: 'P2', name: 'Alex' }, { id: 'P3', name: 'Alex Mockley-Smith' }])).toBe(0);
    expect(rowById(r)!.chms).toBeNull();
  });

  it('skips a merge whose rows changed after it was planned (re-checked in SQL)', async () => {
    const r = await insert({ name: 'Ren Racer', token: 'ren-token-lllllllllllllllllllllllllllll' });
    const spare = await insert({ name: 'Ren Racer', chms: 'P1' });
    const plan = planMatches((await store.listLeaders()) as MatchRow[], [{ id: 'P1', name: 'Ren Racer' }]);
    expect(plan).toEqual([{ keepId: r, chmsId: 'P1', dropId: spare }]);
    // Meanwhile staff give the spare row a link: it is no longer a spare and must not be deleted.
    t.sqlite.prepare('UPDATE leaders SET token_hash = ? WHERE id = ?').run(await hashToken('ren-spare-token-mmmmmmmmmmmmmmmmmmmmmm'), spare);
    expect(await store.applyMatches(plan)).toBe(0);
    expect(rowById(spare)!.chms).toBe('P1');
    expect(rowById(r)!.chms).toBeNull();
  });

  it('the daily job matches too, and the matched row gets that person\'s nudge (counts only in the summary)', async () => {
    const r = await insert({ name: 'Pat Fakerly', token: 'pat-job-token-nnnnnnnnnnnnnnnnnnnnnnnnn', devices: 1 });
    const pat = person('P1', 'Pat Fakerly');
    const cfg = config({ dataSource: 'pushpay' });
    const sender = new FakeSender();
    const out = await runDailyJob({
      config: cfg,
      store,
      sender,
      dataSource: () => ({
        listQueues: async () => [queue({ id: 'q1' })],
        listEntries: async () => [entry({ id: 'e1', queueId: 'q1', status: 'NOT_STARTED', assignee: pat })],
      }),
      now: new Date('2026-01-15T14:00:00Z'),
    });
    expect(out.ran && out.summary.leadersMatched).toBe(1);
    expect(rowById(r)!.chms).toBe('P1');
    expect(sender.sent.map((s) => s.payload)).toEqual([{ title: '1 student is waiting on you', body: 'Tap to see who could use a hello', kind: 'leader', count: 1 }]);
    expect(JSON.stringify(out)).not.toMatch(/Pat|Fakerly/);
  });
});

describe('coordinator rows through merges', () => {
  it('an automatic merge moves the spare row\'s coordinator rows to the surviving row (union, no duplicates, no orphans)', async () => {
    const r = await insert({ name: 'Pat Fakerly', token: 'pat-coord-token-ooooooooooooooooooooooo', coordinates: ['Outreach Team', 'Service Team'] });
    const spare = await insert({ name: 'Pat Fakerly', chms: 'P1', coordinates: ['Service Team', '4'] });
    const other = await insert({ name: 'Other Personsen', chms: 'P2', coordinates: ['Staff'] });
    expect(await syncLeaders(store, [{ id: 'P1', name: 'Pat Fakerly' }, { id: 'P2', name: 'Other Personsen' }])).toBe(1);
    expect(rowById(spare)).toBeUndefined();
    expect(coordinatorRows()).toEqual([[r, '4'], [r, 'Outreach Team'], [r, 'Service Team'], [other, 'Staff']]);
    expect((await store.leaderById(r))?.coordinatorOf).toEqual(['4', 'Outreach Team', 'Service Team']);
    expect(t.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('a staff row that is also a coordinator keeps its mark through a merge and takes the spare row\'s too', async () => {
    const staff = await insert({ name: 'Quinn Stafford', token: 'quinn-coord-token-wwwwwwwwwwwwwwwwwwww', admin: true, coordinates: ['Staff'] });
    await insert({ name: 'Quinn Stafford', chms: 'P4', coordinates: ['Service Team'] });
    expect(await syncLeaders(store, [{ id: 'P4', name: 'Quinn Stafford' }])).toBe(1);
    expect(await store.leaderById(staff)).toMatchObject({ isAdmin: true, chmsIndividualId: 'P4', coordinatorOf: ['Service Team', 'Staff'] });
    expect(coordinatorRows()).toEqual([[staff, 'Service Team'], [staff, 'Staff']]);
  });

  it('a merge that is skipped (re-checked in SQL) copies nothing: rows never land on a different row', async () => {
    const r = await insert({ name: 'Ren Racer', token: 'ren-coord-token-ppppppppppppppppppppppp' });
    const spare = await insert({ name: 'Ren Racer', chms: 'P1', coordinates: ['Service Team'] });
    const plan = planMatches((await store.listLeaders()) as MatchRow[], [{ id: 'P1', name: 'Ren Racer' }]);
    t.sqlite.prepare('UPDATE leaders SET is_admin = 1 WHERE id = ?').run(spare); // no longer a spare
    expect(await store.applyMatches(plan)).toBe(0);
    expect(coordinatorRows()).toEqual([[spare, 'Service Team']]);
    expect(rowById(r)!.chms).toBeNull();
  });

  it('does not rely on ON DELETE CASCADE: with foreign keys off, the merge still leaves no orphan rows', async () => {
    t.sqlite.exec('PRAGMA foreign_keys = OFF');
    const r = await insert({ name: 'Pat Fakerly', token: 'pat-nofk-token-qqqqqqqqqqqqqqqqqqqqqqqq' });
    const spare = await insert({ name: 'Pat Fakerly', chms: 'P1', coordinates: ['Service Team'] });
    expect(await syncLeaders(store, [{ id: 'P1', name: 'Pat Fakerly' }])).toBe(1);
    expect(rowById(spare)).toBeUndefined();
    expect(coordinatorRows()).toEqual([[r, 'Service Team']]);
  });

  it('a match by hand moves the spare row\'s rows to the row with the link; changing or clearing the match keeps the row\'s own', async () => {
    const staff = await insert({ name: 'Staff Person', token: 'staff-coord-token-rrrrrrrrrrrrrrrrrrrrr', admin: true });
    const newbie = await insert({ name: 'Newbie Byname', token: 'newbie-coord-token-sssssssssssssssssss', coordinates: ['Outreach Team'] });
    const s1 = await insert({ name: 'Cordelia Fitch', chms: 'L103', coordinates: ['Service Team'] });
    const s2 = await insert({ name: 'Esme Calder', chms: 'L105', coordinates: ['Staff'] });
    const actor = (await store.leaderById(staff))!;
    const { matchLeader } = await import('../src/api/leaders');
    expect(await matchLeader(store, actor, newbie, 'L103')).toEqual({ ok: true, matched: true });
    expect(coordinatorRows()).toEqual([[newbie, 'Outreach Team'], [newbie, 'Service Team'], [s2, 'Staff']]);
    expect(rowById(s1)).toBeUndefined();
    // Changing the match takes over the next person's spare row (and its rows): still the person holding the link.
    expect(await matchLeader(store, actor, newbie, 'L105')).toEqual({ ok: true, matched: true });
    expect(coordinatorRows()).toEqual([[newbie, 'Outreach Team'], [newbie, 'Service Team'], [newbie, 'Staff']]);
    // Clearing the match: scope belongs to the row, not to the Lead id, so it stays.
    expect(await matchLeader(store, actor, newbie, null)).toEqual({ ok: true, matched: false });
    expect((await store.leaderById(newbie))?.coordinatorOf).toEqual(['Outreach Team', 'Service Team', 'Staff']);
    expect(t.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('a refused match by hand (person held by a row in use) moves nothing', async () => {
    const staff = await insert({ name: 'Staff Person', token: 'staff-coord-token-ttttttttttttttttttttt', admin: true });
    const newbie = await insert({ name: 'Newbie Byname', token: 'newbie-coord-token-uuuuuuuuuuuuuuuuuuu' });
    const held = await insert({ name: 'Plain Leader', chms: 'L101', token: 'held-coord-token-vvvvvvvvvvvvvvvvvvvvvv', coordinates: ['Service Team'] });
    const { matchLeader } = await import('../src/api/leaders');
    expect(await matchLeader(store, (await store.leaderById(staff))!, newbie, 'L101')).toEqual({ error: 'person_taken' });
    expect(coordinatorRows()).toEqual([[held, 'Service Team']]);
  });
});

// ---------------------------------------------------------------------------------------------- endpoint

const tok = {
  owner: 'owner-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  staff: 'staff-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  leader: 'leader-token-cccccccccccccccccccccccccccc',
  manager: 'manager-token-dddddddddddddddddddddddddd',
  newbie: 'newbie-token-eeeeeeeeeeeeeeeeeeeeeeeeeeee',
};

async function call(fn: (ctx: never) => Response | Promise<Response>, path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const request = new Request(`${HOST}${path}`, { method: path === '/api/me' ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return fn({ request, env: { DB: t.db } } as never);
}
const match = (token: string | null, body?: unknown) => call(leaderMatch, '/api/leader-match', token, body);

describe('POST /api/leader-match', () => {
  let id: Record<keyof typeof tok, number> & { spareL103: number; spareL105: number };
  beforeEach(async () => {
    id = {
      owner: await insert({ name: 'Owner Person', token: tok.owner, admin: true, owner: true }),
      staff: await insert({ name: 'Staff Person', token: tok.staff, admin: true }),
      leader: await insert({ name: 'Plain Leader', chms: 'L101', token: tok.leader }),
      manager: await insert({ name: 'Queue Manager', chms: 'M201', token: tok.manager, coordinates: ['Connect Card Coordinators'] }),
      newbie: await insert({ name: 'Newbie Byname', token: tok.newbie, devices: 1, lastSeen: '2026-11-18T14:00:00.000Z' }),
      spareL103: await insert({ name: 'Cordelia Fitch', chms: 'L103' }),
      spareL105: await insert({ name: 'Esme Calder', chms: 'L105' }),
    };
  });

  it('staff match a name-only leader to a Lead person: the spare row goes, link and devices stay', async () => {
    const res = await match(tok.staff, { leaderId: id.newbie, chmsId: 'L103' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, matched: true });
    expect(rowById(id.spareL103)).toBeUndefined();
    expect(rowById(id.newbie)).toMatchObject({ chms: 'L103', name: 'Newbie Byname', token_hash: await hashToken(tok.newbie), last_seen_at: '2026-11-18T14:00:00.000Z', match_by_hand: 1 });
    expect(subsOf(id.newbie)).toHaveLength(1);
    expect((await call(me, '/api/me', tok.newbie)).status).toBe(200);
  });

  it('changing a match moves to the new person; clearing keeps the link and stops automatic re-matching', async () => {
    await match(tok.staff, { leaderId: id.newbie, chmsId: 'L103' });
    expect(await (await match(tok.staff, { leaderId: id.newbie, chmsId: 'L105' })).json()).toEqual({ ok: true, matched: true });
    expect(rowById(id.newbie)!.chms).toBe('L105');
    expect(rowById(id.spareL105)).toBeUndefined();

    const res = await match(tok.staff, { leaderId: id.newbie, chmsId: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, matched: false });
    expect(rowById(id.newbie)).toMatchObject({ chms: null, token_hash: await hashToken(tok.newbie), match_by_hand: 1 });
    expect(subsOf(id.newbie)).toHaveLength(1);
    expect((await call(me, '/api/me', tok.newbie)).status).toBe(200);
    // Even with a Lead person of exactly this name, the cleared row is left alone.
    expect(await syncLeaders(store, [{ id: 'P50', name: 'Newbie Byname' }])).toBe(0);
    expect(rowById(id.newbie)!.chms).toBeNull();
  });

  it('matching to the person the row already has is a no-op success', async () => {
    const res = await match(tok.staff, { leaderId: id.leader, chmsId: 'L101' });
    expect(await res.json()).toEqual({ ok: true, matched: true });
    expect(rowById(id.leader)!.match_by_hand).toBe(0);
  });

  it('409 person_taken when the Lead person is tied to another row with a link; nothing changes', async () => {
    const before = rows();
    const res = await match(tok.staff, { leaderId: id.newbie, chmsId: 'L101' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'person_taken' });
    expect(rows()).toEqual(before);
  });

  it('refuses unknown people, bad ids and rows without a link', async () => {
    const cases: [unknown, number, string][] = [
      [{ leaderId: id.newbie, chmsId: 'NOPE1' }, 404, 'unknown_person'],
      [{ leaderId: id.newbie, chmsId: '' }, 400, 'invalid_person'],
      [{ leaderId: id.newbie, chmsId: ' L103' }, 400, 'invalid_person'],
      [{ leaderId: id.newbie, chmsId: 103 }, 400, 'invalid_person'],
      [{ leaderId: id.newbie, chmsId: 'x'.repeat(65) }, 400, 'invalid_person'],
      [{ leaderId: id.newbie }, 400, 'invalid_person'], // a missing chmsId is not a clear
      [{ leaderId: id.spareL105, chmsId: 'L103' }, 400, 'no_link'],
      [{ leaderId: 999, chmsId: 'L103' }, 404, 'not_found'],
      [{ leaderId: '3', chmsId: 'L103' }, 404, 'not_found'],
      ['just a string', 404, 'not_found'],
    ];
    const before = rows();
    for (const [body, status, error] of cases) {
      const res = await match(tok.staff, body);
      expect([body, res.status, await res.json()]).toEqual([body, status, { error }]);
    }
    expect(rows()).toEqual(before);
  });

  it('is staff only: plain leaders and coordinators get 403, no token 401, nothing changes', async () => {
    const before = rows();
    for (const who of [tok.leader, tok.manager, tok.newbie]) {
      for (const chmsId of ['L103', null]) {
        const res = await match(who, { leaderId: id.newbie, chmsId });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'forbidden' });
      }
    }
    expect((await match(null, { leaderId: id.newbie, chmsId: 'L103' })).status).toBe(401);
    expect(rows()).toEqual(before);
  });

  it('protects the owner like the link routes: other staff cannot change the owner\'s match; the owner can', async () => {
    for (const chmsId of ['L103', null]) {
      const res = await match(tok.staff, { leaderId: id.owner, chmsId });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'owner_protected' });
    }
    expect(rowById(id.owner)!.chms).toBeNull();
    expect(await (await match(tok.owner, { leaderId: id.owner, chmsId: 'L103' })).json()).toEqual({ ok: true, matched: true });
    // Staff can match themselves.
    expect(await (await match(tok.staff, { leaderId: id.staff, chmsId: 'L105' })).json()).toEqual({ ok: true, matched: true });
  });

  it(`shares the links rate limit (${RATE_LIMITS.links.max} per window)`, async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-18T14:00:10Z'), toFake: ['Date'] });
    try {
      for (let i = 0; i < RATE_LIMITS.links.max; i++) expect((await match(tok.staff, { leaderId: id.newbie, chmsId: null })).status).toBe(200);
      const res = await match(tok.staff, { leaderId: id.newbie, chmsId: 'L103' });
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'rate_limited' });
      expect(t.sqlite.prepare('SELECT bucket, count FROM rate_limits WHERE leader_id = ?').all(id.staff)).toEqual([{ bucket: 'links', count: RATE_LIMITS.links.max + 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------------------------- /api/me

describe('GET /api/me and matching', () => {
  type StaffView = { admin: { leaders: { id: number; name: string; matched: boolean }[]; leadPeople: { id: string; name: string }[] } };

  it('staff (on sample data) see who is matched and which Lead people are free; no ChMS id on leader rows', async () => {
    const cfg = loadConfig();
    expect(cfg.dataSource).toBe('fixture');
    const sample = peopleSeen(await loadSnapshot(createFixtureSource(new Date(), cfg.timeZone), cfg));
    const [first, second] = sample;
    await insert({ name: 'Owner Person', token: tok.owner, admin: true, owner: true });
    const held = await insert({ name: 'Held Leader', chms: first!.id, token: tok.leader });
    // A name-only row that is exactly one sample person's name: matched automatically on this page view.
    const byName = await insert({ name: second!.name.toUpperCase(), token: tok.newbie });

    const view = (await (await call(me, '/api/me', tok.owner)).json()) as StaffView;
    const l = (rid: number) => view.admin.leaders.find((x) => x.id === rid)!;
    expect(l(held).matched).toBe(true);
    expect(l(byName).matched).toBe(true);
    expect(rowById(byName)!.chms).toBe(second!.id);
    expect(view.admin.leaders.find((x) => x.name === 'Owner Person')!.matched).toBe(false);
    // Free people: everyone seen except the two now held by linked rows.
    const free = view.admin.leadPeople.map((p) => p.id).sort();
    expect(free).toEqual(sample.map((p) => p.id).filter((pid) => pid !== first!.id && pid !== second!.id).sort());
    for (const p of view.admin.leadPeople) expect(Object.keys(p).sort()).toEqual(['id', 'name']);
    for (const x of view.admin.leaders) expect(x).not.toHaveProperty('chmsId');
    // ...and staff can match from that list right away.
    const target = view.admin.leadPeople[0]!;
    const owner = view.admin.leaders.find((x) => x.name === 'Owner Person')!;
    expect(await (await match(tok.owner, { leaderId: owner.id, chmsId: target.id })).json()).toEqual({ ok: true, matched: true });
  });

  it('staff whose own row is matched by this very page view get their own students in the same response', async () => {
    const cfg = loadConfig();
    const now = new Date();
    const snap = await loadSnapshot(createFixtureSource(now, cfg.timeZone), cfg);
    const waiting = computeNudges(snap.queues, snap.entries, cfg, now).leaders[0]!;
    const id = await insert({ name: waiting.leader.name, token: tok.owner, admin: true });
    const before = (await store.leaderById(id))!;
    expect(before.chmsIndividualId).toBeNull();

    const r = await resolveMe({ store, config: cfg, leader: before, now, loadSnapshot: async () => snap });
    expect(rowById(id)!.chms).toBe(waiting.leader.id);
    expect(r.ok && r.me.behind.length).toBe(waiting.behind.length);
    expect(r.ok && r.me.admin?.leaders?.find((l) => l.id === id)?.matched).toBe(true);
  });

  it('non-staff before launch get nothing new: no admin, no matching, no rows created or changed', async () => {
    await insert({ name: 'Plain Leader', chms: 'L101', token: tok.leader });
    const byName = await insert({ name: 'Auberon Quince', token: tok.newbie }); // a sample person's name
    const withoutVisit = () => rows().map(({ last_seen_at: _seen, ...r }) => r); // a visit is recorded, as always
    const before = withoutVisit();
    for (const who of [tok.leader, tok.newbie]) {
      const body = (await (await call(me, '/api/me', who)).json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['behind', 'generatedAt', 'leader', 'live']);
    }
    expect(withoutVisit()).toEqual(before);
    expect(rowById(byName)!.chms).toBeNull();
  });
});
