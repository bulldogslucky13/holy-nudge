// Access-token cache and single-use refresh-token rotation, coordinated through one D1 row.
//
// Pushpay refresh tokens are single use: a successful refresh returns a new refresh token
// and immediately revokes the old one (and the old access token). Two rules follow:
//   1. Only one job may refresh at a time. A conditional UPDATE takes a lease-style lock
//      on oauth_tokens; everyone else waits and re-reads instead of refreshing.
//   2. The new refresh token is written to D1 (in the same statement as the new access
//      token) before the access token is returned to anyone.
//
// Failure windows of a refresh, in order:
//   a. Holder dies before sending the request: nothing rotated; its lock expires after
//      LOCK_TTL_MS and the next job refreshes normally. Closed.
//   b. Request reached Pushpay, Pushpay rotated, but the response never reached us
//      (network drop, timeout, isolate killed mid-flight). We never saw the new refresh
//      token and the stored one is now revoked. THIS WINDOW CANNOT BE CLOSED from our side:
//      no client-side ordering can save a token we never received. The next refresh gets
//      invalid_grant -> ReauthorizationRequired -> the job alerts the owner, and a Master
//      Admin must re-approve via /oauth/start?key=... (SANDBOX: whether Pushpay keeps the
//      old token valid for a grace period is undocumented). We keep the window small:
//      at most one refresh per ~2 hours, one in flight, with a 20 s timeout.
//   c. Response received but the D1 write fails: retried PERSIST_ATTEMPTS times, and a
//      "failed" write is re-read in case it actually committed. If it still fails we throw
//      TokenPersistError loudly and do NOT use the access token. Recovery as in (b).
//   d. Holder outlives its lock (only if a refresh exceeds LOCK_TTL_MS, which the 20 s
//      timeout prevents): the write is a compare-and-swap on the refresh token it spent,
//      and invalid_grant only flags (never deletes) the stored token, so a late but valid
//      write still lands and clears the flag.
//
// Never log token values.
import { OAuthTokenError, refreshGrant, type OAuthEnv, type TokenResponse } from './oauth';

/** Refresh when the cached access token has less than this left. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Lock lease. Must comfortably exceed REFRESH_TIMEOUT_MS plus the persist retries. */
export const LOCK_TTL_MS = 60 * 1000;
export const REFRESH_TIMEOUT_MS = 20 * 1000;
const PERSIST_ATTEMPTS = 4;
/** A loser gives up waiting after this (a dead holder's lock expires well before). */
const MAX_LOCK_WAIT_MS = 2 * LOCK_TTL_MS + 10 * 1000;

/** The connection is gone; a Master Admin must re-approve. The job turns this into an owner alert. */
export class ReauthorizationRequired extends Error {
  override name = 'ReauthorizationRequired';
  constructor(readonly reason: 'not_connected' | 'invalid_grant') {
    super(
      reason === 'not_connected'
        ? 'Holy Nudge is not connected to Pushpay yet: a Master Admin must approve it via /oauth/start.'
        : 'Pushpay rejected the refresh token (invalid_grant): a Master Admin must re-approve Holy Nudge via /oauth/start.',
    );
  }
}

/** The refresh request failed for a reason other than invalid_grant. Nothing was rotated (or we cannot tell). */
export class TokenRefreshError extends Error {
  override name = 'TokenRefreshError';
  constructor(readonly tokenError: OAuthTokenError) {
    super(
      `Pushpay token refresh failed (${tokenError.code}, HTTP ${tokenError.status || 'n/a'}). Stored tokens are unchanged.`,
    );
  }
}

/** Pushpay rotated the token but D1 would not store the new one. Loud: the connection is probably lost. */
export class TokenPersistError extends Error {
  override name = 'TokenPersistError';
}

/** Another job held the refresh lock for longer than we were willing to wait. */
export class TokenLockTimeout extends Error {
  override name = 'TokenLockTimeout';
}

export type TokenEnv = Pick<OAuthEnv, 'CHMS_CLIENT_ID' | 'CHMS_CLIENT_SECRET' | 'CHMS_API_HOST'>;

export interface TokenOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Current epoch ms. Default: `now` advanced by real elapsed time. */
  clock?: () => number;
  /** An access token the API just rejected (401): do not hand it out again; refresh unless someone already did. */
  rejectedAccessToken?: string;
  /** Lock owner id; default random. */
  ownerId?: string;
  /** Diagnostic sink (never receives token values). Default console.error. */
  log?: (message: string) => void;
}

interface TokenRow {
  refresh_token: string | null;
  access_token: string | null;
  access_expires_at: number | null;
  lock_owner: string | null;
  lock_expires_at: number | null;
  needs_reauth_at: number | null;
}

const RETRY = Symbol('retry');

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function readRow(db: D1Database): Promise<TokenRow | null> {
  return db
    .prepare(
      'SELECT refresh_token, access_token, access_expires_at, lock_owner, lock_expires_at, needs_reauth_at FROM oauth_tokens WHERE id = 1',
    )
    .first<TokenRow>();
}

function usable(row: TokenRow | null, now: number, rejected: string | undefined): row is TokenRow & { access_token: string } {
  return (
    !!row?.access_token &&
    row.access_expires_at !== null &&
    row.access_expires_at - REFRESH_MARGIN_MS > now &&
    row.access_token !== rejected
  );
}

/**
 * A valid access token for the Pushpay API, refreshing (under the D1 lock) if needed.
 * Throws ReauthorizationRequired when a Master Admin must (re-)approve.
 */
export async function getAccessToken(
  db: D1Database,
  env: TokenEnv,
  now: number | Date,
  opts: TokenOptions = {},
): Promise<string> {
  const start = typeof now === 'number' ? now : now.getTime();
  const realStart = Date.now();
  const clock = opts.clock ?? (() => start + (Date.now() - realStart));
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((m: string) => console.error(m));
  const deadline = clock() + MAX_LOCK_WAIT_MS;
  let delay = 250;

  for (let round = 0; ; round++) {
    if (round >= 50) throw new TokenLockTimeout('Gave up getting a Pushpay access token after repeated retries.');
    const row = await readRow(db);
    const t = clock();
    if (usable(row, t, opts.rejectedAccessToken)) return row.access_token;
    if (!row?.refresh_token) throw new ReauthorizationRequired('not_connected');
    if (row.needs_reauth_at !== null) throw new ReauthorizationRequired('invalid_grant');

    const owner = opts.ownerId ?? crypto.randomUUID();
    const lock = await db
      .prepare(
        'UPDATE oauth_tokens SET lock_owner = ?, lock_expires_at = ? WHERE id = 1 AND (lock_owner IS NULL OR lock_expires_at < ?)',
      )
      .bind(owner, t + LOCK_TTL_MS, t)
      .run();

    if (lock.meta.changes === 1) {
      try {
        const result = await refreshUnderLock(db, env, opts, clock, sleep, log);
        if (result !== RETRY) return result;
      } finally {
        await db
          .prepare('UPDATE oauth_tokens SET lock_owner = NULL, lock_expires_at = NULL WHERE id = 1 AND lock_owner = ?')
          .bind(owner)
          .run()
          .catch(() => log('oauth: could not release refresh lock; it will expire on its own'));
      }
      continue;
    }

    // Someone else is refreshing: wait, then re-read (never refresh in parallel).
    if (clock() >= deadline) throw new TokenLockTimeout('Timed out waiting for another job to refresh the Pushpay token.');
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function refreshUnderLock(
  db: D1Database,
  env: TokenEnv,
  opts: TokenOptions,
  clock: () => number,
  sleep: (ms: number) => Promise<void>,
  log: (m: string) => void,
): Promise<string | typeof RETRY> {
  // Re-read under the lock: the previous holder may have refreshed since our first read.
  const row = await readRow(db);
  if (usable(row, clock(), opts.rejectedAccessToken)) return row.access_token;
  if (!row?.refresh_token) throw new ReauthorizationRequired('not_connected');
  if (row.needs_reauth_at !== null) throw new ReauthorizationRequired('invalid_grant');
  const spent = row.refresh_token;

  let tokens: TokenResponse;
  try {
    tokens = await refreshGrant(env, spent, { fetch: opts.fetch, timeoutMs: REFRESH_TIMEOUT_MS });
  } catch (e) {
    if (!(e instanceof OAuthTokenError)) throw e;
    if (e.code === 'invalid_grant') {
      // Flag, do not delete: a late holder (window d) may still write a valid rotation.
      const flagged = await db
        .prepare('UPDATE oauth_tokens SET needs_reauth_at = ? WHERE id = 1 AND refresh_token = ?')
        .bind(clock(), spent)
        .run();
      if (flagged.meta.changes === 1) {
        log('oauth: refresh returned invalid_grant; Master Admin re-approval required');
        throw new ReauthorizationRequired('invalid_grant');
      }
      return RETRY; // the stored token changed under us (re-approval or a late write): re-read
    }
    log(`oauth: refresh failed (${e.code}, HTTP ${e.status || 'n/a'})`);
    throw new TokenRefreshError(e);
  }

  // SANDBOX: a refresh response is assumed to always carry a new refresh_token. If it does
  // not, keep the one we have (the only token we could possibly still use).
  const next = tokens.refresh_token ?? spent;
  if (!tokens.refresh_token) log('oauth: refresh response had no refresh_token; keeping the stored one');
  const expiresAt = clock() + tokens.expires_in * 1000;
  const outcome = await persistRotated(db, spent, next, tokens, expiresAt, clock, sleep, log);
  return outcome === 'saved' ? tokens.access_token : RETRY;
}

/** CAS write of the rotated pair, with retries. Returns 'superseded' if a re-approval replaced the token meanwhile. */
async function persistRotated(
  db: D1Database,
  spent: string,
  next: string,
  tokens: TokenResponse,
  expiresAt: number,
  clock: () => number,
  sleep: (ms: number) => Promise<void>,
  log: (m: string) => void,
): Promise<'saved' | 'superseded'> {
  let lastErrorName = 'unknown';
  for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
    try {
      const res = await db
        .prepare(
          `UPDATE oauth_tokens SET refresh_token = ?, access_token = ?, access_expires_at = ?, scope = ?, updated_at = ?,
             needs_reauth_at = NULL, lock_owner = NULL, lock_expires_at = NULL
           WHERE id = 1 AND refresh_token = ?`,
        )
        .bind(next, tokens.access_token, expiresAt, tokens.scope ?? null, clock(), spent)
        .run();
      if (res.meta.changes === 1) return 'saved';
      // Nothing matched: either an earlier "failed" attempt actually committed, or the
      // token was replaced (re-approval). Tell them apart by reading back.
      const row = await readRow(db);
      if (row?.refresh_token === next) return 'saved';
      log('oauth: stored refresh token changed during refresh (re-approval?); using the stored one');
      return 'superseded';
    } catch (e) {
      // Only the error's class name: driver messages could echo bound values.
      lastErrorName = e instanceof Error ? e.name : typeof e;
      log(`oauth: saving rotated token failed (attempt ${attempt}/${PERSIST_ATTEMPTS}, ${lastErrorName})`);
      if (attempt < PERSIST_ATTEMPTS) await sleep(100 * 4 ** (attempt - 1));
    }
  }
  const message =
    `Pushpay token refresh succeeded but saving the rotated refresh token to D1 failed ${PERSIST_ATTEMPTS} times ` +
    `(${lastErrorName}). The previous refresh token is already revoked, so the Pushpay connection is probably lost: ` +
    'check D1, then have a Master Admin re-approve via /oauth/start.';
  log(`oauth: ${message}`);
  throw new TokenPersistError(message);
}

/**
 * Store the first token pair from the authorization-code exchange (also used on re-approval).
 * Replaces whatever was there, clears the reauth flag and any lock. Retries like a rotation.
 */
export async function saveAuthorizedTokens(
  db: D1Database,
  tokens: TokenResponse,
  now: number,
  opts: { sleep?: (ms: number) => Promise<void>; log?: (m: string) => void } = {},
): Promise<void> {
  if (!tokens.refresh_token) throw new TokenPersistError('Authorization response had no refresh token.');
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((m: string) => console.error(m));
  let lastErrorName = 'unknown';
  for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
    try {
      await db
        .prepare(
          `INSERT INTO oauth_tokens (id, refresh_token, access_token, access_expires_at, scope, updated_at,
             lock_owner, lock_expires_at, needs_reauth_at)
           VALUES (1, ?, ?, ?, ?, ?, NULL, NULL, NULL)
           ON CONFLICT (id) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token,
             access_expires_at = excluded.access_expires_at, scope = excluded.scope, updated_at = excluded.updated_at,
             lock_owner = NULL, lock_expires_at = NULL, needs_reauth_at = NULL`,
        )
        .bind(tokens.refresh_token, tokens.access_token, now + tokens.expires_in * 1000, tokens.scope ?? null, now)
        .run();
      return;
    } catch (e) {
      lastErrorName = e instanceof Error ? e.name : typeof e;
      log(`oauth: saving authorized tokens failed (attempt ${attempt}/${PERSIST_ATTEMPTS}, ${lastErrorName})`);
      if (attempt < PERSIST_ATTEMPTS) await sleep(100 * 4 ** (attempt - 1));
    }
  }
  throw new TokenPersistError(`Saving the new Pushpay tokens to D1 failed (${lastErrorName}).`);
}
