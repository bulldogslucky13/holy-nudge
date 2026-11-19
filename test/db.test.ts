import { describe, expect, it } from 'vitest';
import { createD1Store, hashToken } from '../src/db';
import { readText } from './files';
import { createTestD1 } from './sqlite-d1';

const MIGRATIONS = ['migrations/0001_init.sql', 'migrations/0002_oauth.sql', 'migrations/0003_link_tokens.sql', 'migrations/0004_lead_match.sql'];

describe('D1 store: upsertLeaders', () => {
  it('adds unknown people WITHOUT a link, renames plain leaders, and keeps hand-given admin/owner names and links', async () => {
    const t = await createTestD1(...MIGRATIONS);
    const ownerHash = await hashToken('tok-owner-0123456789abcdef');
    t.sqlite
      .prepare(
        "INSERT INTO leaders (chms_individual_id, name, token_hash, is_admin, is_owner) VALUES ('L104', 'Owner Name', ?, 1, 1), ('L101', 'Old Name', NULL, 0, 0)",
      )
      .run(ownerHash);
    const store = createD1Store(t.db);
    await store.upsertLeaders([
      { id: 'L104', name: 'Fixture Person' },
      { id: 'L101', name: 'New Name' },
      { id: 'L102', name: 'Someone New' },
    ]);
    const rows = await store.listLeaders();
    const by = Object.fromEntries(rows.map((r) => [r.chmsIndividualId, r]));
    expect(by.L104).toMatchObject({ name: 'Owner Name', hasLink: true, isAdmin: true, isOwner: true });
    expect(by.L101).toMatchObject({ name: 'New Name', hasLink: false });
    expect(by.L102).toMatchObject({ name: 'Someone New', hasLink: false });
    // Nothing usable at rest for automatically created rows.
    const raw = t.sqlite.prepare("SELECT token, token_hash FROM leaders WHERE chms_individual_id = 'L102'").get();
    expect(raw).toEqual({ token: null, token_hash: null });
    expect((await store.leaderByToken('tok-owner-0123456789abcdef'))?.name).toBe('Owner Name');
  });
});

describe('migration 0003 (hashed link tokens)', () => {
  it('keeps every leader, legacy token and push subscription through the table rebuild, with foreign keys on', async () => {
    const t = await createTestD1('migrations/0001_init.sql', 'migrations/0002_oauth.sql');
    t.sqlite.exec(
      "INSERT INTO leaders (id, chms_individual_id, name, token, is_admin, is_owner) VALUES (1, 'L104', 'Owner', 'legacy-owner-token-0123456789', 1, 1), (2, 'L101', 'Lee', 'legacy-lee-token-0123456789ab', 0, 0);" +
        "INSERT INTO push_subscriptions (id, leader_id, endpoint, p256dh, auth) VALUES (7, 1, 'https://web.push.apple.com/owner', 'k', 'a');",
    );
    t.sqlite.exec(await readText('migrations/0003_link_tokens.sql'));
    expect(t.sqlite.prepare('SELECT id, leader_id, endpoint FROM push_subscriptions').all()).toEqual([
      { id: 7, leader_id: 1, endpoint: 'https://web.push.apple.com/owner' },
    ]);
    expect(t.sqlite.prepare('SELECT id, token, token_hash, is_owner FROM leaders ORDER BY id').all()).toEqual([
      { id: 1, token: 'legacy-owner-token-0123456789', token_hash: null, is_owner: 1 },
      { id: 2, token: 'legacy-lee-token-0123456789ab', token_hash: null, is_owner: 0 },
    ]);
    expect(t.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // The foreign key still points at the rebuilt table: deleting a leader cascades.
    t.sqlite.exec('DELETE FROM leaders WHERE id = 1');
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 });
    // New ids continue after the old ones.
    t.sqlite.exec("INSERT INTO leaders (name) VALUES ('New')");
    expect(t.sqlite.prepare("SELECT id FROM leaders WHERE name = 'New'").get()).toEqual({ id: 3 });
  });
});

describe('migration 0004 (Lead match by hand)', () => {
  it('adds match_by_hand = 0 to every row and keeps every leader, link and push subscription', async () => {
    const t = await createTestD1('migrations/0001_init.sql', 'migrations/0002_oauth.sql', 'migrations/0003_link_tokens.sql');
    t.sqlite.exec(
      "INSERT INTO leaders (id, chms_individual_id, name, token, token_hash, is_admin, is_owner, last_seen_at, revoked_at) VALUES " +
        "(1, NULL, 'Owner', 'legacy-owner-token-0123456789', NULL, 1, 1, '2026-11-18T14:00:00.000Z', NULL), " +
        "(2, 'L101', 'Lee', NULL, 'abc123', 0, 0, NULL, NULL), (3, 'L102', 'Off', NULL, NULL, 0, 0, NULL, '2026-11-01T00:00:00.000Z');" +
        "INSERT INTO push_subscriptions (id, leader_id, endpoint, p256dh, auth) VALUES (7, 1, 'https://web.push.apple.com/owner', 'k', 'a'), (8, 2, 'https://fcm.googleapis.com/x', 'k2', 'a2');" +
        "INSERT INTO rate_limits (leader_id, bucket, window_start, count) VALUES (1, 'me', 0, 3);",
    );
    const before = {
      leaders: t.sqlite.prepare('SELECT * FROM leaders ORDER BY id').all(),
      subs: t.sqlite.prepare('SELECT * FROM push_subscriptions ORDER BY id').all(),
      rate: t.sqlite.prepare('SELECT * FROM rate_limits').all(),
    };
    t.sqlite.exec(await readText('migrations/0004_lead_match.sql'));
    expect(t.sqlite.prepare('SELECT * FROM leaders ORDER BY id').all()).toEqual(before.leaders.map((r) => ({ ...r, match_by_hand: 0 })));
    expect(t.sqlite.prepare('SELECT * FROM push_subscriptions ORDER BY id').all()).toEqual(before.subs);
    expect(t.sqlite.prepare('SELECT * FROM rate_limits').all()).toEqual(before.rate);
    expect(t.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // The store reads it, and the owner's legacy link still works.
    const store = createD1Store(t.db);
    expect(await store.leaderByToken('legacy-owner-token-0123456789')).toMatchObject({ id: 1, isOwner: true, matchByHand: false, subscriptionCount: 1 });
  });
});

describe('D1 store: last successful daily run', () => {
  it('is the start of the latest ok run; failed and unfinished runs never count; null before any', async () => {
    const t = await createTestD1(...MIGRATIONS);
    const store = createD1Store(t.db);
    expect(await store.lastSuccessfulRunStart()).toBeNull();

    const a = await store.startJobRun(new Date('2026-01-13T14:00:00Z'));
    await store.finishJobRun(a, true, { pushesSent: 1 }, new Date('2026-01-13T14:00:05Z'));
    const b = await store.startJobRun(new Date('2026-01-14T14:00:00Z'));
    await store.finishJobRun(b, false, { stage: 'datasource' }, new Date('2026-01-14T14:00:05Z'));
    await store.startJobRun(new Date('2026-01-15T14:00:00Z')); // still running (ok = 0)
    // The START of the run, not its finish: entries created while it ran are new next time (a repeat, never a miss).
    expect((await store.lastSuccessfulRunStart())?.toISOString()).toBe('2026-01-13T14:00:00.000Z');

    const c = await store.startJobRun(new Date('2026-01-16T14:00:00Z'));
    await store.finishJobRun(c, true, {}, new Date('2026-01-16T14:00:05Z'));
    expect((await store.lastSuccessfulRunStart())?.toISOString()).toBe('2026-01-16T14:00:00.000Z');
    // Undelivered pushes carried to the next run: read from the latest ok run only; junk is ignored.
    expect(await store.lastRunRetryFrom()).toEqual({});
    const d = await store.startJobRun(new Date('2026-01-17T14:00:00Z'));
    await store.finishJobRun(d, true, { retryFrom: { '7': '2026-01-16T14:00:00.000Z', '8': 'not a date' } }, new Date('2026-01-17T14:00:05Z'));
    expect(await store.lastRunRetryFrom()).toEqual({ '7': '2026-01-16T14:00:00.000Z' });
    // Nothing about any student is in job_runs: one timestamp per run and a counts-only summary.
    expect(Object.keys(t.sqlite.prepare('SELECT * FROM job_runs LIMIT 1').get() as object).sort()).toEqual(['finished_at', 'id', 'ok', 'started_at', 'summary']);
  });
});

describe('token hashing', () => {
  it('scripts (Node crypto) and the Workers runtime (WebCrypto) hash a token identically', async () => {
    // @ts-expect-error plain .mjs helper without types
    const lib = (await import('../scripts/lib/d1.mjs')) as { hashToken: (t: string) => string; newToken: () => { token: string; hash: string } };
    const { token, hash } = lib.newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(await hashToken(token));
    expect(lib.hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
