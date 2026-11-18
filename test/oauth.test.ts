import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestGet as start } from '../functions/oauth/start';
import { onRequestGet as callback } from '../functions/oauth/callback';
import { constantTimeEqual, REDIRECT_URI, SCOPES, STATE_TTL_MS, type OAuthEnvInput } from '../src/chms/oauth';
import { importTokenKey, openToken } from '../src/chms/tokenbox';
import { TEST_TOKEN_KEY } from './helpers';
import { createTestD1, type TestD1 } from './sqlite-d1';

let t: TestD1;
let env: OAuthEnvInput;
let tokenCalls: { url: string; body: URLSearchParams; headers: Headers }[];
let tokenReply: () => Response;

type Ctx = Parameters<typeof start>[0];
const call = (fn: typeof start, url: string) =>
  fn({ request: new Request(url), env } as unknown as Ctx) as Promise<Response>;

beforeEach(async () => {
  t = await createTestD1('migrations/0002_oauth.sql');
  env = {
    DB: t.db,
    CHMS_CLIENT_ID: 'client-id-x',
    CHMS_CLIENT_SECRET: 'client-secret-x',
    OAUTH_SETUP_KEY: 'setup-key-0123456789',
    TOKEN_ENC_KEY: TEST_TOKEN_KEY,
  };
  tokenCalls = [];
  tokenReply = () =>
    Response.json({ access_token: 'access-secret-1', token_type: 'bearer', expires_in: 7200, scope: 'read:individuals', refresh_token: 'refresh-secret-1' });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    tokenCalls.push({ url: String(input), body: new URLSearchParams(String(init?.body)), headers: new Headers(init?.headers) });
    return tokenReply();
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const HOST = 'https://holynudge.cameronbristol.xyz';
const states = () => t.sqlite.prepare('SELECT state, created_at FROM oauth_states').all() as { state: string; created_at: number }[];
const tokens = () => t.sqlite.prepare('SELECT * FROM oauth_tokens WHERE id = 1').get() as Record<string, unknown>;

async function startFlow(): Promise<string> {
  const res = await call(start, `${HOST}/oauth/start?key=setup-key-0123456789`);
  expect(res.status).toBe(302);
  return new URL(res.headers.get('Location')!).searchParams.get('state')!;
}

describe('/oauth/start', () => {
  it('requires the setup key', async () => {
    for (const q of ['', '?key=', '?key=wrong', '?key=setup-key-012345678']) {
      const res = await call(start, `${HOST}/oauth/start${q}`);
      expect(res.status).toBe(403);
    }
    expect(states()).toHaveLength(0);
  });

  it('redirects to the authorize URL with the constant redirect URI, six scopes and a stored state', async () => {
    // Request arrives on another host (e.g. *.pages.dev): redirect_uri must not follow it.
    const res = await call(start, 'https://holy-nudge.pages.dev/oauth/start?key=setup-key-0123456789');
    expect(res.status).toBe(302);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe('https://oauth.ccbchurch.com/oauth/authorize');
    const q = loc.searchParams;
    expect(q.get('client_id')).toBe('client-id-x');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe('https://holynudge.cameronbristol.xyz/oauth/callback');
    expect(q.get('scope')!.split(' ')).toEqual([...SCOPES]);
    expect(SCOPES).toHaveLength(6);
    expect(q.has('subdomain')).toBe(false);
    expect(q.has('resource_owner_auth')).toBe(false);
    expect(q.get('state')!.length).toBeGreaterThanOrEqual(40);
    expect(states().map((s) => s.state)).toEqual([q.get('state')]);
  });

  it('shows a plain "not configured yet" page while credentials are missing, with or without a key', async () => {
    for (const missing of ['CHMS_CLIENT_ID', 'CHMS_CLIENT_SECRET', 'OAUTH_SETUP_KEY', 'TOKEN_ENC_KEY'] as const) {
      const saved = env[missing];
      delete env[missing];
      for (const q of ['', '?key=setup-key-0123456789']) {
        const res = await call(start, `${HOST}/oauth/start${q}`);
        expect(res.status).toBe(503);
        const text = await res.text();
        expect(text).toContain('credentials are not configured yet');
        expect(text).not.toContain('client-');
        expect(text).not.toContain('setup-key');
      }
      env[missing] = saved;
    }
    expect(states()).toHaveLength(0);
  });

  it('uses the sandbox auth host when configured', async () => {
    env.CHMS_AUTH_HOST = 'https://beta-oauth.ccbchurch.com';
    const res = await call(start, `${HOST}/oauth/start?key=setup-key-0123456789`);
    expect(res.headers.get('Location')).toMatch(/^https:\/\/beta-oauth\.ccbchurch\.com\/oauth\/authorize\?/);
  });
});

describe('/oauth/callback', () => {
  it('shows a neutral ready page with no parameters', async () => {
    const res = await call(callback, `${HOST}/oauth/callback`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Holy Nudge OAuth callback is ready');
    expect(tokenCalls).toHaveLength(0);
  });

  it('still shows the ready page with no parameters before credentials exist', async () => {
    env = { DB: t.db };
    const res = await call(callback, `${HOST}/oauth/callback`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Holy Nudge OAuth callback is ready');
  });

  it('refuses a callback with parameters while credentials are missing, without calling Pushpay', async () => {
    env = { DB: t.db, OAUTH_SETUP_KEY: 'setup-key-0123456789' };
    const res = await call(callback, `${HOST}/oauth/callback?code=abc&state=xyz`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('not configured yet');
    expect(tokenCalls).toHaveLength(0);
  });

  it('exchanges the code once, stores tokens and shows success', async () => {
    const state = await startFlow();
    const res = await call(callback, `${HOST}/oauth/callback?code=the-code&state=${state}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Holy Nudge is connected. You can close this tab.');

    expect(tokenCalls).toHaveLength(1);
    const c = tokenCalls[0]!;
    expect(c.url).toBe('https://api.ccbchurch.com/oauth/token');
    expect(c.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(c.headers.get('Accept')).toBe('application/vnd.ccbchurch.v2+json');
    expect(Object.fromEntries(c.body)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT_URI,
      client_id: 'client-id-x',
      client_secret: 'client-secret-x',
    });
    // Stored encrypted under TOKEN_ENC_KEY, never as plaintext.
    expect(JSON.stringify(tokens())).not.toMatch(/secret/);
    expect(tokens()).toMatchObject({ refresh_token: expect.stringMatching(/^v1\./), scope: 'read:individuals' });
    const key = await importTokenKey(TEST_TOKEN_KEY);
    expect(await openToken(key, 'refresh_token', tokens().refresh_token as string)).toBe('refresh-secret-1');
    expect(await openToken(key, 'access_token', tokens().access_token as string)).toBe('access-secret-1');

    // The state is single use.
    const replay = await call(callback, `${HOST}/oauth/callback?code=the-code&state=${state}`);
    expect(replay.status).toBe(400);
    expect(tokenCalls).toHaveLength(1);
  });

  it('refuses to store tokens without a valid TOKEN_ENC_KEY (never plaintext), without calling Pushpay', async () => {
    const state = await startFlow();
    for (const bad of [undefined, 'too-short']) {
      env.TOKEN_ENC_KEY = bad;
      const res = await call(callback, `${HOST}/oauth/callback?code=the-code&state=${state}`);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('not configured yet');
    }
    expect(tokenCalls).toHaveLength(0);
    expect(tokens().refresh_token).toBeNull();
  });

  it('sends security headers, allowing only its own inline style by hash', async () => {
    const res = await call(callback, `${HOST}/oauth/callback`);
    const csp = res.headers.get('Content-Security-Policy')!;
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/]+=*'/);
    expect(csp).not.toMatch(/unsafe-inline/);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
  });

  it('rejects unknown, missing and expired state without calling Pushpay', async () => {
    expect((await call(callback, `${HOST}/oauth/callback?code=c&state=forged`)).status).toBe(400);
    expect((await call(callback, `${HOST}/oauth/callback?code=c`)).status).toBe(400);

    const realNow = Date.now();
    vi.useFakeTimers({ now: realNow, toFake: ['Date'] });
    const state = await startFlow();
    vi.setSystemTime(realNow + STATE_TTL_MS + 1000);
    const res = await call(callback, `${HOST}/oauth/callback?code=c&state=${state}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired or was already used/);
    expect(tokenCalls).toHaveLength(0);
    expect(states()).toHaveLength(0); // expired rows are purged
  });

  it('shows a plain failure without details when the exchange fails', async () => {
    tokenReply = () =>
      Response.json({ error: 'invalid_request', error_description: 'redirect_uri mismatch detail' }, { status: 401 });
    const state = await startFlow();
    const res = await call(callback, `${HOST}/oauth/callback?code=c&state=${state}`);
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain('Holy Nudge could not connect');
    expect(html).not.toMatch(/invalid_request|redirect_uri|mismatch|client|secret/);
    expect(tokens().refresh_token).toBeNull();
  });

  it('handles a declined approval', async () => {
    const state = await startFlow();
    const res = await call(callback, `${HOST}/oauth/callback?error=access_denied&state=${state}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/not completed/);
    expect(tokenCalls).toHaveLength(0);
  });
});

describe('constantTimeEqual', () => {
  it('compares exactly', async () => {
    expect(await constantTimeEqual('abc', 'abc')).toBe(true);
    expect(await constantTimeEqual('abc', 'abd')).toBe(false);
    expect(await constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(await constantTimeEqual('', '')).toBe(false);
  });
});
