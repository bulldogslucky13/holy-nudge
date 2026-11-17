import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAccessToken,
  LOCK_TTL_MS,
  REFRESH_MARGIN_MS,
  ReauthorizationRequired,
  saveAuthorizedTokens,
  TokenPersistError,
  TokenRefreshError,
  type TokenOptions,
} from '../src/chms/tokens';
import { createTestD1, type TestD1 } from './sqlite-d1';

const NOW = Date.UTC(2026, 10, 17, 14, 0, 0);
const MIN = 60_000;
const env = { CHMS_CLIENT_ID: 'client-id-x', CHMS_CLIENT_SECRET: 'client-secret-x', CHMS_API_HOST: 'https://api.test' };

/** Fake Pushpay token endpoint with real single-use rotation semantics. */
function tokenServer() {
  const s = {
    current: 'refresh-secret-0',
    issued: 0,
    calls: [] as URLSearchParams[],
    gate: null as Promise<void> | null,
    /** Return a Response to override the next answer. */
    override: null as ((body: URLSearchParams) => Response | Promise<Response>) | null,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      s.calls.push(body);
      expect(String(input)).toBe('https://api.test/oauth/token');
      if (s.gate) await s.gate;
      if (s.override) return s.override(body);
      if (body.get('grant_type') !== 'refresh_token' || body.get('refresh_token') !== s.current) {
        return Response.json({ error: 'invalid_grant', error_description: 'nope' }, { status: 401 });
      }
      s.issued++;
      s.current = `refresh-secret-${s.issued}`;
      return Response.json({
        access_token: `access-secret-${s.issued}`,
        token_type: 'bearer',
        expires_in: 7200,
        scope: 'read:process_queues',
        refresh_token: s.current,
      });
    }) as typeof fetch,
  };
  return s;
}

let t: TestD1;
let server: ReturnType<typeof tokenServer>;
let clockMs: number;
let logs: string[];

function opts(extra: Partial<TokenOptions> = {}): TokenOptions {
  return {
    fetch: server.fetch,
    clock: () => clockMs,
    sleep: async (ms) => {
      clockMs += ms;
      await new Promise((r) => setTimeout(r, 0));
    },
    log: (m) => logs.push(m),
    ...extra,
  };
}

async function seed(over: Record<string, unknown> = {}) {
  const row = {
    refresh_token: 'refresh-secret-0',
    access_token: 'access-secret-0',
    access_expires_at: NOW + 60 * MIN,
    lock_owner: null,
    lock_expires_at: null,
    needs_reauth_at: null,
    ...over,
  };
  await t.db
    .prepare(
      'UPDATE oauth_tokens SET refresh_token = ?, access_token = ?, access_expires_at = ?, lock_owner = ?, lock_expires_at = ?, needs_reauth_at = ?, updated_at = 1 WHERE id = 1',
    )
    .bind(row.refresh_token, row.access_token, row.access_expires_at, row.lock_owner, row.lock_expires_at, row.needs_reauth_at)
    .run();
}

const row = () => t.sqlite.prepare('SELECT * FROM oauth_tokens WHERE id = 1').get() as Record<string, unknown>;

beforeEach(async () => {
  t = await createTestD1('migrations/0002_oauth.sql');
  server = tokenServer();
  clockMs = NOW;
  logs = [];
});

describe('getAccessToken', () => {
  it('reuses the cached access token until shortly before expiry', async () => {
    await seed({ access_expires_at: NOW + REFRESH_MARGIN_MS + MIN });
    expect(await getAccessToken(t.db, env, NOW, opts())).toBe('access-secret-0');
    expect(server.calls).toHaveLength(0);

    clockMs = NOW + 2 * MIN; // now inside the margin
    expect(await getAccessToken(t.db, env, clockMs, opts())).toBe('access-secret-1');
    expect(server.calls).toHaveLength(1);
    const sent = server.calls[0]!;
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('client_id')).toBe('client-id-x');
    expect(sent.get('client_secret')).toBe('client-secret-x');
    expect(sent.has('subdomain')).toBe(false);
    expect(sent.has('scope')).toBe(false);
    expect(row()).toMatchObject({
      refresh_token: 'refresh-secret-1',
      access_token: 'access-secret-1',
      access_expires_at: clockMs + 7200 * 1000,
      lock_owner: null,
    });
  });

  it('persists the new refresh token in the same statement as the access token, before returning', async () => {
    await seed({ access_expires_at: NOW - 1 });
    const writes: string[] = [];
    t.failWhen = (sql) => {
      if (/SET refresh_token = \?/.test(sql)) writes.push(sql);
      return null;
    };
    const token = await getAccessToken(t.db, env, NOW, opts());
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/access_token = \?/);
    // By the time the caller has the token, D1 already holds the matching refresh token.
    expect(row().access_token).toBe(token);
    expect(row().refresh_token).toBe(server.current);
  });

  it('never refreshes twice when two jobs race: the loser waits and re-reads', async () => {
    await seed({ access_expires_at: NOW - 1 });
    let open!: () => void;
    server.gate = new Promise((r) => (open = r));
    const a = getAccessToken(t.db, env, NOW, opts({ ownerId: 'job-a' }));
    const b = getAccessToken(t.db, env, NOW, opts({ ownerId: 'job-b' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(row().lock_owner).toBe('job-a');
    open();
    expect(await Promise.all([a, b])).toEqual(['access-secret-1', 'access-secret-1']);
    expect(server.calls).toHaveLength(1);
    expect(row().lock_owner).toBeNull();
  });

  it('takes the lock with one conditional UPDATE and backs off when it is held', async () => {
    await seed({ access_expires_at: NOW - 1, lock_owner: 'other-job', lock_expires_at: NOW + 30_000 });
    let sleeps = 0;
    const token = await getAccessToken(
      t.db,
      env,
      NOW,
      opts({
        sleep: async (ms) => {
          clockMs += ms;
          // The other job finishes its refresh while we wait.
          if (++sleeps === 1) {
            t.sqlite
              .prepare(
                "UPDATE oauth_tokens SET refresh_token = 'refresh-secret-9', access_token = 'access-secret-9', access_expires_at = ?, lock_owner = NULL, lock_expires_at = NULL",
              )
              .run(NOW + 120 * MIN);
          }
        },
      }),
    );
    expect(token).toBe('access-secret-9');
    expect(server.calls).toHaveLength(0);
  });

  it("frees a crashed holder's lock once it expires", async () => {
    await seed({ access_expires_at: NOW - 1, lock_owner: 'crashed-job', lock_expires_at: NOW + 20_000 });
    const token = await getAccessToken(t.db, env, NOW, opts());
    expect(token).toBe('access-secret-1');
    expect(server.calls).toHaveLength(1);
    expect(clockMs).toBeGreaterThan(NOW + 20_000); // waited for the lease to run out
    expect(clockMs).toBeLessThan(NOW + LOCK_TTL_MS);
    expect(row().lock_owner).toBeNull();
  });

  it('raises ReauthorizationRequired on invalid_grant, flags the row, and stops calling Pushpay', async () => {
    await seed({ refresh_token: 'refresh-secret-revoked', access_expires_at: NOW - 1 });
    const err = await getAccessToken(t.db, env, NOW, opts()).catch((e) => e);
    expect(err).toBeInstanceOf(ReauthorizationRequired);
    expect(err.reason).toBe('invalid_grant');
    expect(row().needs_reauth_at).toBe(NOW);
    expect(row().refresh_token).toBe('refresh-secret-revoked'); // flagged, not deleted
    expect(row().lock_owner).toBeNull();

    await expect(getAccessToken(t.db, env, NOW, opts())).rejects.toBeInstanceOf(ReauthorizationRequired);
    expect(server.calls).toHaveLength(1);
  });

  it('does not treat invalid_grant as fatal when the stored token changed meanwhile (late holder or re-approval)', async () => {
    await seed({ access_expires_at: NOW - 1 });
    server.override = () => {
      server.override = null;
      // Someone else stored a fresh pair while our request was in flight.
      t.sqlite
        .prepare(
          "UPDATE oauth_tokens SET refresh_token = 'refresh-secret-7', access_token = 'access-secret-7', access_expires_at = ?",
        )
        .run(NOW + 120 * MIN);
      return Response.json({ error: 'invalid_grant' }, { status: 401 });
    };
    expect(await getAccessToken(t.db, env, NOW, opts())).toBe('access-secret-7');
    expect(row().needs_reauth_at).toBeNull();
  });

  it('says not_connected before the first approval', async () => {
    const err = await getAccessToken(t.db, env, NOW, opts()).catch((e) => e);
    expect(err).toBeInstanceOf(ReauthorizationRequired);
    expect(err.reason).toBe('not_connected');
    expect(server.calls).toHaveLength(0);
  });

  it('leaves tokens untouched and releases the lock when Pushpay errors', async () => {
    await seed({ access_expires_at: NOW - 1 });
    server.override = () => new Response('oops', { status: 503 });
    await expect(getAccessToken(t.db, env, NOW, opts())).rejects.toBeInstanceOf(TokenRefreshError);
    expect(row()).toMatchObject({ refresh_token: 'refresh-secret-0', lock_owner: null, needs_reauth_at: null });
  });

  it('retries the D1 write when it fails after a successful refresh', async () => {
    await seed({ access_expires_at: NOW - 1 });
    let failures = 0;
    t.failWhen = (sql) => (/SET refresh_token = \?/.test(sql) && failures++ < 2 ? new Error('D1_ERROR: busy') : null);
    expect(await getAccessToken(t.db, env, NOW, opts())).toBe('access-secret-1');
    expect(row().refresh_token).toBe('refresh-secret-1');
    expect(failures).toBe(3);
  });

  it('treats a write that committed but reported failure as saved', async () => {
    await seed({ access_expires_at: NOW - 1 });
    let once = true;
    t.failAfterWhen = (sql) => {
      if (/SET refresh_token = \?/.test(sql) && once) {
        once = false;
        return new Error('network lost after commit');
      }
      return null;
    };
    expect(await getAccessToken(t.db, env, NOW, opts())).toBe('access-secret-1');
    expect(row().refresh_token).toBe('refresh-secret-1');
  });

  it('fails loudly, without secrets and without returning the token, when D1 never takes the write', async () => {
    await seed({ access_expires_at: NOW - 1 });
    t.failWhen = (sql, params) =>
      /SET refresh_token = \?/.test(sql) ? new Error(`D1_ERROR with bound values ${params.join(',')}`) : null;
    const err = await getAccessToken(t.db, env, NOW, opts()).catch((e) => e);
    expect(err).toBeInstanceOf(TokenPersistError);
    expect(err.message).toMatch(/re-approve/);
    expect(err.message).not.toMatch(/secret/);
    expect(logs.join('\n')).not.toMatch(/secret/);
  });

  it('refreshes when the API rejected the cached token, unless another job already replaced it', async () => {
    await seed();
    expect(await getAccessToken(t.db, env, NOW, opts({ rejectedAccessToken: 'access-secret-0' }))).toBe('access-secret-1');
    expect(server.calls).toHaveLength(1);
    // A stale rejection (token already replaced) does not trigger another refresh.
    expect(await getAccessToken(t.db, env, NOW, opts({ rejectedAccessToken: 'access-secret-0' }))).toBe('access-secret-1');
    expect(server.calls).toHaveLength(1);
  });

  it('never logs token values', async () => {
    await seed({ access_expires_at: NOW - 1 });
    await getAccessToken(t.db, env, NOW, opts());
    server.current = 'something-else';
    clockMs += 3 * 3600_000;
    await getAccessToken(t.db, env, clockMs, opts()).catch(() => {});
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toMatch(/secret/);
  });
});

describe('saveAuthorizedTokens', () => {
  it('replaces tokens and clears the reauth flag and any lock', async () => {
    await seed({ needs_reauth_at: NOW - 5, lock_owner: 'x', lock_expires_at: NOW + 1000 });
    await saveAuthorizedTokens(
      t.db,
      { access_token: 'access-secret-new', refresh_token: 'refresh-secret-new', expires_in: 7200, scope: 'a b' },
      NOW,
    );
    expect(row()).toMatchObject({
      refresh_token: 'refresh-secret-new',
      access_token: 'access-secret-new',
      access_expires_at: NOW + 7_200_000,
      scope: 'a b',
      needs_reauth_at: null,
      lock_owner: null,
    });
  });
});
