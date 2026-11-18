// Bindings and secrets shared by the Pages Functions and the cron Worker.
// Secrets are set with `wrangler secret put` / `wrangler pages secret put`, or .dev.vars locally.
export interface Env {
  DB: D1Database;
  /** Pages only: static assets from public/. */
  ASSETS?: Fetcher;
  /** VAPID public key, base64url uncompressed P-256 point (65 bytes). */
  VAPID_PUBLIC_KEY?: string;
  /** VAPID private key, base64url 32-byte scalar. Secret. */
  VAPID_PRIVATE_KEY?: string;
  /** VAPID "sub" claim: mailto: or https: contact. Defaults to the app URL. */
  VAPID_SUBJECT?: string;
  /** Cron Worker only: shared secret for POST /run. Secret. */
  JOB_TRIGGER_KEY?: string;
  /** Optional override for building personal links (default: the production URL, or the origin on localhost). */
  APP_BASE_URL?: string;
  /**
   * Live ChMS connection (dataSource "pushpay"). Optional so fixture mode runs without them;
   * checked at runtime where needed (src/chms/index.ts, functions/oauth/*). Secrets.
   */
  CHMS_CLIENT_ID?: string;
  CHMS_CLIENT_SECRET?: string;
  /** Secret. /oauth/start?key=<this> begins the Master Admin approval (Pages only). */
  OAUTH_SETUP_KEY?: string;
  /** Vars. Default production hosts; sandbox https://beta-oauth.ccbchurch.com / https://api-beta.ccbchurch.com */
  CHMS_AUTH_HOST?: string;
  CHMS_API_HOST?: string;
  /** Var, optional. Church subdomain for the authorize page. */
  CHMS_SUBDOMAIN?: string;
  /**
   * Secret, Pages AND cron worker (same value): 32 random bytes, base64url (`npm run gen-token-key`).
   * Encrypts the Pushpay tokens in oauth_tokens. Required when dataSource is "pushpay".
   */
  TOKEN_ENC_KEY?: string;
}

export const DEFAULT_APP_BASE_URL = 'https://holynudge.cameronbristol.xyz';

/**
 * Base URL for personal links. Links always point at the custom domain, even when the request
 * came in on *.pages.dev, except during local development where the local origin is used.
 */
export function appBaseUrl(env: Pick<Env, 'APP_BASE_URL'>, requestUrl: string): string {
  if (env.APP_BASE_URL) return env.APP_BASE_URL.replace(/\/+$/, '');
  const url = new URL(requestUrl);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return local ? url.origin : DEFAULT_APP_BASE_URL;
}
