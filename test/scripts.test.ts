// The leader scripts' coordinator helpers (scripts/lib/coordinators.mjs), with their SQL run on real SQLite
// with every migration. The scripts themselves only call wrangler around these. All names are made up.
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/db';
import { createTestD1 } from './sqlite-d1';

const MIGRATIONS = ['migrations/0001_init.sql', 'migrations/0002_oauth.sql', 'migrations/0003_link_tokens.sql', 'migrations/0004_lead_match.sql', 'migrations/0005_queue_coordinators.sql'];

type Lib = {
  cleanQueueKeys: (list: string[]) => { keys: string[] } | { error: string };
  replaceCoordinatorsSql: (leaderIdSql: number | string, keys: string[]) => string;
  keyWarnings: (keys: string[], o: { queues: { id: string; name: string }[] | null; excluded: string[] }) => string[];
};
// @ts-expect-error plain .mjs helper without types
const load = async () => (await import('../scripts/lib/coordinators.mjs')) as Lib;

describe('scripts/lib/coordinators.mjs', () => {
  it('cleans keys: trims, drops repeats, refuses blanks', async () => {
    const { cleanQueueKeys } = await load();
    expect(cleanQueueKeys(['Service Team', ' 4 ', '4', 'Service Team'])).toEqual({ keys: ['Service Team', '4'] });
    expect(cleanQueueKeys(['Service Team', '  '])).toEqual({ error: expect.stringMatching(/--coordinator-of/) });
  });

  it('sets (replaces) one row\'s keys, by id or by the new row\'s subquery; [] clears; other rows untouched', async () => {
    const { replaceCoordinatorsSql } = await load();
    const t = await createTestD1(...MIGRATIONS);
    t.sqlite.exec(
      "INSERT INTO leaders (id, name, token_hash, is_admin) VALUES (1, 'Casey Coordly', 'h1', 0), (2, 'Quinn Stafford', 'h2', 1);" +
        "INSERT INTO queue_coordinators (leader_id, queue_key) VALUES (1, 'Old Queue'), (2, 'Outreach Team');",
    );
    const store = createD1Store(t.db);
    const keysOf = async (id: number) => (await store.leaderById(id))!.coordinatorOf;

    t.sqlite.exec(replaceCoordinatorsSql(1, ['Service Team', "Queue's \"odd\" name", '4']));
    expect(await keysOf(1)).toEqual(['4', 'Queue\'s "odd" name', 'Service Team']);
    expect(await keysOf(2)).toEqual(['Outreach Team']);

    // A staff row can be a coordinator too (staff access wins in the app; the mark is still kept).
    t.sqlite.exec(replaceCoordinatorsSql(2, ['Staff']));
    expect(await keysOf(2)).toEqual(['Staff']);

    // A brand-new row, addressed the way add-leader does it (by its fresh token hash), in the same command.
    t.sqlite.exec("INSERT INTO leaders (name, token_hash) VALUES ('Nova Newrow', 'h3');" + replaceCoordinatorsSql("(SELECT id FROM leaders WHERE token_hash = 'h3')", ['Service Team']));
    expect(await keysOf(3)).toEqual(['Service Team']);

    t.sqlite.exec(replaceCoordinatorsSql(1, []));
    expect(await keysOf(1)).toEqual([]);
    expect(await keysOf(3)).toEqual(['Service Team']);
  });

  it('warns about keys that grant nothing: excluded queues, unknown sample queues, and unchecked live keys', async () => {
    const { keyWarnings } = await load();
    const queues = [{ id: '7', name: 'Service Team' }, { id: '12', name: 'Not Interested' }];
    const excluded = ['Not Interested'];
    expect(keyWarnings(['Service Team', '7'], { queues, excluded })).toEqual([]);
    const w = keyWarnings(['service team', 'Not Interested'], { queues, excluded });
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/"service team" is not a sample queue/);
    expect(w[1]).toMatch(/"Not Interested" is an excluded queue/);
    expect(keyWarnings(['Anything'], { queues: null, excluded })).toEqual([expect.stringMatching(/not checked against Lead/)]);
    expect(keyWarnings([], { queues: null, excluded })).toEqual([]);
  });
});
