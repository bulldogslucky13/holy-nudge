import { describe, expect, it } from 'vitest';
import { createD1Store, hashToken } from '../src/db';
import { readText } from './files';
import { createTestD1 } from './sqlite-d1';

const MIGRATIONS = ['migrations/0001_init.sql', 'migrations/0002_oauth.sql', 'migrations/0003_link_tokens.sql'];

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
