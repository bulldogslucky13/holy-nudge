// Small helpers for the Pages Functions.
import type { LeaderRow, Store } from '../db';
import { errorClassName } from '../core/errors';
import { securityHeaders } from './headers';

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...securityHeaders(),
      ...headers,
    },
  });
}

export function apiError(code: string, status: number, headers: Record<string, string> = {}): Response {
  return json({ error: code }, status, headers);
}

const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

export function isTokenShaped(t: string): boolean {
  return TOKEN_RE.test(t);
}

/** The leader for `Authorization: Bearer <token>`, or null (unknown, malformed or turned-off link). */
export async function authenticate(request: Request, store: Pick<Store, 'leaderByToken'>): Promise<LeaderRow | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '');
  if (!m || !isTokenShaped(m[1]!)) return null;
  return store.leaderByToken(m[1]!);
}

/**
 * Pages middleware for /api/* and /oauth/*: an uncaught exception would be logged by the runtime with
 * its message (a D1 error can echo bound values, such as a legacy link token). Log the route and the
 * error class only, and answer a plain 500.
 */
export const errorBoundary: PagesFunction = async ({ request, next }) => {
  try {
    return await next();
  } catch (err) {
    console.error(`pages: unhandled error on ${new URL(request.url).pathname.split('/').slice(0, 3).join('/')} (${errorClassName(err)})`);
    return apiError('server_error', 500);
  }
};

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Rate limits: D1-backed fixed windows per leader (leader id, window start, count; nothing else).

export const RATE_LIMITS = {
  /** Every /api/me reads ChMS live; one leaked link must not drive unlimited reads. */
  me: { max: 30, windowMs: 5 * 60 * 1000 },
  'test-push': { max: 5, windowMs: 10 * 60 * 1000 },
  /** Staff minting or turning off links. */
  links: { max: 30, windowMs: 10 * 60 * 1000 },
} as const;

export type RateBucket = keyof typeof RATE_LIMITS;

/** Counts this request; returns a 429 response when the leader is over the limit, else null. */
export async function rateLimit(
  store: Pick<Store, 'hitRateLimit'>,
  leaderId: number,
  bucket: RateBucket,
  now: Date,
): Promise<Response | null> {
  const { max, windowMs } = RATE_LIMITS[bucket];
  const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
  const count = await store.hitRateLimit(leaderId, bucket, windowStart);
  if (count <= max) return null;
  const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now.getTime()) / 1000));
  return apiError('rate_limited', 429, { 'Retry-After': String(retryAfter) });
}
