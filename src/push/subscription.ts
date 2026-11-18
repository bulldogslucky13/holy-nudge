// Validate a PushSubscription.toJSON() body before storing it.
import type { NewSubscription } from '../db';
import { base64urlDecode } from './base64url';

/** Push services we will POST to. Anything else is rejected (no arbitrary outbound requests). */
const PUSH_HOSTS_EXACT = [
  'fcm.googleapis.com', // Chrome, Edge on Android, most Chromium (exactly this host, not all of googleapis.com)
];
const PUSH_HOST_SUFFIXES = [
  '.push.services.mozilla.com', // Firefox
  '.push.apple.com', // Safari / iOS Home Screen apps
  '.notify.windows.com', // Edge on Windows
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const hostname = u.hostname.toLowerCase();
  if (PUSH_HOSTS_EXACT.includes(hostname)) return true;
  const host = `.${hostname}`;
  return PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

export function parseSubscription(input: unknown): NewSubscription | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = o.endpoint;
  const p256dh = o.keys?.p256dh;
  const auth = o.keys?.auth;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !isAllowedPushEndpoint(endpoint)) return null;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  try {
    const k = base64urlDecode(p256dh);
    if (k.length !== 65 || k[0] !== 4) return null;
    if (base64urlDecode(auth).length !== 16) return null;
  } catch {
    return null;
  }
  return { endpoint, p256dh, auth };
}
