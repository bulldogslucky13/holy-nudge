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
// Encryption at rest (src/chms/tokenbox.ts): both token columns hold AES-256-GCM ciphertext under
// TOKEN_ENC_KEY. Every value is decrypted only in memory. Each write uses a fresh IV, so the
// compare-and-swap below compares the STORED ciphertext we read (never re-encrypts to compare), and
// the rotated pair is encrypted once, before the first write attempt, so retries and the read-back
// check see the same bytes. Ordering is unchanged: the new refresh token is in D1 before the new
// access token is returned to anyone.
//
// Never log token values.
import { ChmsNotConfiguredError, OAuthTokenError, refreshGrant, type OAuthEnv, type TokenResponse } from './oauth';
import { importTokenKey, isValidTokenKey, openToken, sealToken, TokenDecryptError } from './tokenbox';

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
  constructor(readonly reason: 'not_connected' | 'invalid_grant' | 'undecryptable') {
    super(
      reason === 'not_connected'
        ? 'Holy Nudge is not connected to Pushpay yet: a Master Admin must approve it via /oauth/start.'
        : reason === 'invalid_grant'
          ? 'Pushpay rejected the refresh token (invalid_grant): a Master Admin must re-approve Holy Nudge via /oauth/start.'
          : 'The stored Pushpay token could not be decrypted: check TOKEN_ENC_KEY is the same on Pages and the cron worker, or have a Master Admin re-approve via /oauth/start.',
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

export type TokenEnv = Pick<OAuthEnv, 'CHMS_CLIENT_ID' | 'CHMS_CLIENT_SECRET' | 'CHMS_API_HOST' | 'TOKEN_ENC_KEY'>;

/** The AES key, or ChmsNotConfiguredError: never fall back to plaintext. */
async function tokenKey(env: Pick<OAuthEnv, 'TOKEN_ENC_KEY'>): Promise<CryptoKey> {
  if (!isValidTokenKey(env.TOKEN_ENC_KEY)) throw new ChmsNotConfiguredError(['TOKEN_ENC_KEY']);
  return importTokenKey(env.TOKEN_ENC_KEY);
}

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

/** As stored: refresh_token and access_token are ciphertext ("v1...."). */
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

/** The decrypted access token if it is still good for a while and not the one the API just rejected. */
async function usableAccess(
  key: CryptoKey,
  row: TokenRow | null,
  now: number,
  rejected: string | undefined,
  log: (m: string) => void,
): Promise<string | null> {
  if (!row?.access_token || row.access_expires_at === null || row.access_expires_at - REFRESH_MARGIN_MS <= now) return null;
  let access: string;
  try {
    access = await openToken(key, 'access_token', row.access_token);
  } catch (e) {
    if (!(e instanceof TokenDecryptError)) throw e;
    log('oauth: stored access token could not be decrypted; refreshing');
    return null;
  }
  return access === rejected ? null : access;
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
  const key = await tokenKey(env);
  const deadline = clock() + MAX_LOCK_WAIT_MS;
  let delay = 250;

  for (let round = 0; ; round++) {
    if (round >= 50) throw new TokenLockTimeout('Gave up getting a Pushpay access token after repeated retries.');
    const row = await readRow(db);
    const t = clock();
    const access = await usableAccess(key, row, t, opts.rejectedAccessToken, log);
    if (access !== null) return access;
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
        const result = await refreshUnderLock(db, env, key, opts, clock, sleep, log);
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
  key: CryptoKey,
  opts: TokenOptions,
  clock: () => number,
  sleep: (ms: number) => Promise<void>,
  log: (m: string) => void,
): Promise<string | typeof RETRY> {
  // Re-read under the lock: the previous holder may have refreshed since our first read.
  const row = await readRow(db);
  const access = await usableAccess(key, row, clock(), opts.rejectedAccessToken, log);
  if (access !== null) return access;
  if (!row?.refresh_token) throw new ReauthorizationRequired('not_connected');
  if (row.needs_reauth_at !== null) throw new ReauthorizationRequired('invalid_grant');
  /** Ciphertext exactly as stored: the compare-and-swap key for every write below. */
  const spentStored = row.refresh_token;
  let spent: string;
  try {
    spent = await openToken(key, 'refresh_token', spentStored);
  } catch (e) {
    if (!(e instanceof TokenDecryptError)) throw e;
    // Not flagged: the other worker may hold the right key. Nothing was sent to Pushpay.
    log('oauth: stored refresh token could not be decrypted (TOKEN_ENC_KEY changed or differs between Pages and the cron worker)');
    throw new ReauthorizationRequired('undecryptable');
  }

  let tokens: TokenResponse;
  try {
    tokens = await refreshGrant(env, spent, { fetch: opts.fetch, timeoutMs: REFRESH_TIMEOUT_MS });
  } catch (e) {
    if (!(e instanceof OAuthTokenError)) throw e;
    if (e.code === 'invalid_grant') {
      // Flag, do not delete: a late holder (window d) may still write a valid rotation.
      const flagged = await db
        .prepare('UPDATE oauth_tokens SET needs_reauth_at = ? WHERE id = 1 AND refresh_token = ?')
        .bind(clock(), spentStored)
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
  const outcome = await persistRotated(db, key, spentStored, next, tokens, expiresAt, clock, sleep, log);
  return outcome === 'saved' ? tokens.access_token : RETRY;
}

/** CAS write of the rotated pair, with retries. Returns 'superseded' if a re-approval replaced the token meanwhile. */
async function persistRotated(
  db: D1Database,
  key: CryptoKey,
  spentStored: string,
  next: string,
  tokens: TokenResponse,
  expiresAt: number,
  clock: () => number,
  sleep: (ms: number) => Promise<void>,
  log: (m: string) => void,
): Promise<'saved' | 'superseded'> {
  let lastErrorName = 'unknown';
  // Encrypt once, so every attempt (and the read-back below) deals in the same stored bytes.
  let nextStored: string;
  let accessStored: string;
  try {
    nextStored = await sealToken(key, 'refresh_token', next);
    accessStored = await sealToken(key, 'access_token', tokens.access_token);
  } catch (e) {
    lastErrorName = e instanceof Error ? e.name : typeof e;
    log(`oauth: encrypting rotated token failed (${lastErrorName})`);
    throw new TokenPersistError(`Encrypting the rotated Pushpay token failed (${lastErrorName}); have a Master Admin re-approve via /oauth/start.`);
  }
  for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
    try {
      const res = await db
        .prepare(
          `UPDATE oauth_tokens SET refresh_token = ?, access_token = ?, access_expires_at = ?, scope = ?, updated_at = ?,
             needs_reauth_at = NULL, lock_owner = NULL, lock_expires_at = NULL
           WHERE id = 1 AND refresh_token = ?`,
        )
        .bind(nextStored, accessStored, expiresAt, tokens.scope ?? null, clock(), spentStored)
        .run();
      if (res.meta.changes === 1) return 'saved';
      // Nothing matched: either an earlier "failed" attempt actually committed, or the
      // token was replaced (re-approval). Tell them apart by reading back.
      const row = await readRow(db);
      if (row?.refresh_token === nextStored) return 'saved';
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
  env: Pick<OAuthEnv, 'TOKEN_ENC_KEY'>,
  tokens: TokenResponse,
  now: number,
  opts: { sleep?: (ms: number) => Promise<void>; log?: (m: string) => void } = {},
): Promise<void> {
  if (!tokens.refresh_token) throw new TokenPersistError('Authorization response had no refresh token.');
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((m: string) => console.error(m));
  const key = await tokenKey(env);
  const refreshStored = await sealToken(key, 'refresh_token', tokens.refresh_token);
  const accessStored = await sealToken(key, 'access_token', tokens.access_token);
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
        .bind(refreshStored, accessStored, now + tokens.expires_in * 1000, tokens.scope ?? null, now)
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
