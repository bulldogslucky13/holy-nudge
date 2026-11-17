// Small helpers for the Pages Functions.
import type { LeaderRow, Store } from '../db';

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export function apiError(code: string, status: number): Response {
  return json({ error: code }, status);
}

const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

export function isTokenShaped(t: string): boolean {
  return TOKEN_RE.test(t);
}

/** The leader for `Authorization: Bearer <token>`, or null. */
export async function authenticate(request: Request, store: Pick<Store, 'leaderByToken'>): Promise<LeaderRow | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '');
  if (!m || !isTokenShaped(m[1]!)) return null;
  return store.leaderByToken(m[1]!);
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
