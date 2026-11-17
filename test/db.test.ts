import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/db';
import { createTestD1 } from './sqlite-d1';

describe('D1 store: upsertLeaders', () => {
  it('adds unknown people with fresh tokens, renames plain leaders, and keeps hand-given admin/owner names', async () => {
    const t = await createTestD1('migrations/0001_init.sql');
    t.sqlite.exec(
      "INSERT INTO leaders (chms_individual_id, name, token, is_admin, is_owner) VALUES ('L104', 'Owner Name', 'tok-owner-0123456789abcdef', 1, 1)," +
        " ('L101', 'Old Name', 'tok-plain-0123456789abcdef', 0, 0)",
    );
    const store = createD1Store(t.db);
    await store.upsertLeaders([
      { id: 'L104', name: 'Fixture Person' },
      { id: 'L101', name: 'New Name' },
      { id: 'L102', name: 'Someone New' },
    ]);
    const rows = await store.listLeaders();
    const by = Object.fromEntries(rows.map((r) => [r.chmsIndividualId, r]));
    expect(by.L104).toMatchObject({ name: 'Owner Name', token: 'tok-owner-0123456789abcdef', isAdmin: true, isOwner: true });
    expect(by.L101).toMatchObject({ name: 'New Name', token: 'tok-plain-0123456789abcdef' });
    expect(by.L102!.name).toBe('Someone New');
    expect(by.L102!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
