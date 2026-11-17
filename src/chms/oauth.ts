// Pushpay ChMS OAuth 2.0 (authorization code flow): env bindings, URLs, the token
// endpoint client, CSRF state, and the small HTML pages shown by /oauth/*.
// Sources: https://docs.pushpay.io/chms-v2/docs/getting-started.md (fetched 2026-11-17).
// Never log token values, codes, client secrets or the setup key.

/** Bindings the OAuth pieces need. The backend's Env must be a superset of this. */
export interface OAuthEnv {
  /** D1 database with migrations/0002_oauth.sql applied. */
  DB: D1Database;
  /** Secret. OAuth client id issued by Pushpay (sandbox and production ids differ). */
  CHMS_CLIENT_ID: string;
  /** Secret. OAuth client secret. */
  CHMS_CLIENT_SECRET: string;
  /** Secret. Long random string; /oauth/start?key=<this> is the only way to begin the flow. */
  OAUTH_SETUP_KEY: string;
  /** Var. Authorization host. Default https://oauth.ccbchurch.com; sandbox https://beta-oauth.ccbchurch.com */
  CHMS_AUTH_HOST?: string;
  /** Var. API host (also serves /oauth/token). Default https://api.ccbchurch.com; sandbox https://api-beta.ccbchurch.com */
  CHMS_API_HOST?: string;
  /** Var, optional. Church subdomain; when set, the authorize page skips asking for it. */
  CHMS_SUBDOMAIN?: string;
}

/** Registered with Pushpay character for character. A constant: never derived from the request host. */
export const REDIRECT_URI = 'https://holynudge.cameronbristol.xyz/oauth/callback';

/**
 * The scopes requested in the API access request. The form scopes are for a later feature.
 * SANDBOX: the authorize request fails if any of these is not among the scopes Pushpay
 * granted the app; if approval comes back narrower, trim this list.
 */
export const SCOPES = [
  'read:process_queues',
  'read:queue_individuals',
  'read:individuals',
  'read:forms',
  'read:form_responses',
  'read:individual_forms',
] as const;

export const DEFAULT_AUTH_HOST = 'https://oauth.ccbchurch.com';
export const DEFAULT_API_HOST = 'https://api.ccbchurch.com';
export const ACCEPT_V2 = 'application/vnd.ccbchurch.v2+json';
export const STATE_TTL_MS = 10 * 60 * 1000;

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export function authHost(env: Pick<OAuthEnv, 'CHMS_AUTH_HOST'>): string {
  return trimSlash(env.CHMS_AUTH_HOST || DEFAULT_AUTH_HOST);
}

export function apiHost(env: Pick<OAuthEnv, 'CHMS_API_HOST'>): string {
  return trimSlash(env.CHMS_API_HOST || DEFAULT_API_HOST);
}

export function tokenUrl(env: Pick<OAuthEnv, 'CHMS_API_HOST'>): string {
  return `${apiHost(env)}/oauth/token`;
}

/** Where to send the Master Admin's browser. System Auth: no resource_owner_auth. */
export function authorizeUrl(
  env: Pick<OAuthEnv, 'CHMS_AUTH_HOST' | 'CHMS_CLIENT_ID' | 'CHMS_SUBDOMAIN'>,
  state: string,
): string {
  const q = new URLSearchParams({
    client_id: env.CHMS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    state,
    scope: SCOPES.join(' '),
  });
  if (env.CHMS_SUBDOMAIN) q.set('subdomain', env.CHMS_SUBDOMAIN);
  return `${authHost(env)}/oauth/authorize?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// Token endpoint

export interface TokenResponse {
  access_token: string;
  /** Rotated on every refresh. SANDBOX: assumed always present (docs say so). */
  refresh_token: string | undefined;
  /** Seconds; docs say 7200. */
  expires_in: number;
  scope: string | undefined;
}

/**
 * The token endpoint said no, or could not be reached. `code` is the OAuth `error`
 * value (invalid_grant, invalid_client, ...) or one of network_error / timeout /
 * malformed_response. The message never contains secrets or the server's description.
 */
export class OAuthTokenError extends Error {
  override name = 'OAuthTokenError';
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Pushpay token endpoint failed: HTTP ${status || 'n/a'}, ${code}`);
  }
}

export interface TokenRequestOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type TokenEnv = Pick<OAuthEnv, 'CHMS_CLIENT_ID' | 'CHMS_CLIENT_SECRET' | 'CHMS_API_HOST'>;

/**
 * POST to the token URL. Per the getting-started guide: form-encoded body, v2 Accept
 * header, client credentials in the body, and no `subdomain` (the code identifies the church).
 * SANDBOX: the OpenAPI entry for /oauth/token instead shows a JSON body with a required
 * `subdomain`. The guide is newer (2026-10-16 vs 2026-04-20) and explicit, so we follow it.
 */
export async function requestToken(
  env: TokenEnv,
  params: Record<string, string>,
  opts: TokenRequestOptions = {},
): Promise<TokenResponse> {
  const doFetch = opts.fetch ?? fetch;
  const body = new URLSearchParams({
    ...params,
    client_id: env.CHMS_CLIENT_ID,
    client_secret: env.CHMS_CLIENT_SECRET,
  });
  let res: Response;
  try {
    res = await doFetch(tokenUrl(env), {
      method: 'POST',
      headers: { Accept: ACCEPT_V2, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    throw new OAuthTokenError(0, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error');
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const obj = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof obj.error === 'string' && /^[a-z_]{1,64}$/.test(obj.error) ? obj.error : 'http_error';
    throw new OAuthTokenError(res.status, code);
  }
  const access = obj.access_token;
  const refresh = obj.refresh_token;
  const expires = Number(obj.expires_in);
  if (typeof access !== 'string' || access === '' || (refresh !== undefined && typeof refresh !== 'string')) {
    throw new OAuthTokenError(res.status, 'malformed_response');
  }
  return {
    access_token: access,
    refresh_token: typeof refresh === 'string' && refresh !== '' ? refresh : undefined,
    // SANDBOX: expires_in assumed present; fall back to the documented 2 hours.
    expires_in: Number.isFinite(expires) && expires > 0 ? expires : 7200,
    scope: typeof obj.scope === 'string' ? obj.scope : undefined,
  };
}

/** Exchange the one-time code. redirect_uri must equal the authorize request's exactly. */
export function exchangeCode(env: TokenEnv, code: string, opts?: TokenRequestOptions): Promise<TokenResponse> {
  return requestToken(env, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }, opts);
}

/** Spend a single-use refresh token. `scope` is not accepted on refresh. */
export function refreshGrant(env: TokenEnv, refreshToken: string, opts?: TokenRequestOptions): Promise<TokenResponse> {
  return requestToken(env, { grant_type: 'refresh_token', refresh_token: refreshToken }, opts);
}

// ---------------------------------------------------------------------------
// Small crypto helpers (WebCrypto only)

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** Constant-time string comparison: compares SHA-256 digests, so length is not leaked either. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0 && a.length > 0 && b.length > 0;
}

// ---------------------------------------------------------------------------
// CSRF state

export async function saveState(db: D1Database, state: string, now: number): Promise<void> {
  await db.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(now - STATE_TTL_MS).run();
  await db.prepare('INSERT INTO oauth_states (state, created_at) VALUES (?, ?)').bind(state, now).run();
}

/** True exactly once per state, and only within 10 minutes of creation. */
export async function consumeState(db: D1Database, state: string, now: number): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM oauth_states WHERE state = ? AND created_at >= ? AND created_at <= ?')
    .bind(state, now - STATE_TTL_MS, now)
    .run();
  await db.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(now - STATE_TTL_MS).run();
  return res.meta.changes === 1;
}

// ---------------------------------------------------------------------------
// Plain pages

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A tiny self-contained page: no scripts, no external resources (so no Referer leaks the code). */
export function htmlPage(status: number, title: string, message: string): Response {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#222;background:#fffdf8}
@media (prefers-color-scheme:dark){body{color:#eee;background:#1b1a17}}h1{font-size:1.4rem}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
