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
  /** Optional override for building personal links (defaults to the request origin / production URL). */
  APP_BASE_URL?: string;
  /** Used by the live ChMS connection (OAuth worker). */
  CHMS_CLIENT_ID?: string;
  CHMS_CLIENT_SECRET?: string;
}

export const DEFAULT_APP_BASE_URL = 'https://holynudge.cameronbristol.xyz';
