// Sends one encrypted web push message (RFC 8030 + 8291 + 8292) with fetch.
import type { SubscriptionRow } from '../db';
import { encryptPushPayload } from './encrypt';
import type { PushPayload } from './payload';
import { importVapidSigningKey, vapidAuthorization, type VapidKeys } from './vapid';

export interface SendResult {
  ok: boolean;
  /** The push service says the subscription is gone (404/410): delete it. */
  gone: boolean;
  /** HTTP status, or 0 for a network error. */
  status: number;
}

export interface PushSender {
  send(sub: Pick<SubscriptionRow, 'endpoint' | 'p256dh' | 'auth'>, payload: PushPayload): Promise<SendResult>;
}

export interface WebPushOptions {
  keys: VapidKeys;
  /** Seconds the push service may hold the message. Morning nudges go stale by evening. */
  ttl?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function createWebPushSender(opts: WebPushOptions): PushSender {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  let signingKey: Promise<CryptoKey> | undefined;

  return {
    async send(sub, payload) {
      signingKey ??= importVapidSigningKey(opts.keys);
      const body = await encryptPushPayload(new TextEncoder().encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
      const authorization = await vapidAuthorization(sub.endpoint, opts.keys, await signingKey, now());
      let res: Response;
      try {
        res = await doFetch(sub.endpoint, {
          method: 'POST',
          headers: {
            Authorization: authorization,
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(opts.ttl ?? 12 * 60 * 60),
            Urgency: payload.kind === 'alert' ? 'high' : 'normal',
          },
          body,
        });
      } catch {
        return { ok: false, gone: false, status: 0 };
      }
      // Drain the body so the connection can be reused; content is not needed.
      await res.arrayBuffer().catch(() => undefined);
      return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status };
    },
  };
}

/** Build a sender from env; throws a clear error if VAPID keys are missing. */
export function senderFromEnv(env: {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}, defaultSubject: string): PushSender {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    throw new Error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set (run npm run gen-vapid and set them as secrets)');
  }
  return createWebPushSender({
    keys: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || defaultSubject },
  });
}
