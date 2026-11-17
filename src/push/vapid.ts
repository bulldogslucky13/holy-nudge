// RFC 8292 VAPID: ES256-signed JWT plus the application server public key.
import { base64urlDecode, base64urlEncode } from './base64url';
import { p256PointToJwk } from './encrypt';

const te = new TextEncoder();

export interface VapidKeys {
  /** base64url 65-byte uncompressed P-256 point. */
  publicKey: string;
  /** base64url 32-byte private scalar. */
  privateKey: string;
  /** mailto: or https: contact for the push service. */
  subject: string;
}

export async function importVapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const d = base64urlDecode(keys.privateKey);
  if (d.length !== 32) throw new Error('VAPID private key must be 32 bytes (base64url)');
  const jwk = { ...p256PointToJwk(base64urlDecode(keys.publicKey)), d: base64urlEncode(d) };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Authorization header value for a push endpoint: `vapid t=<jwt>, k=<public key>`. */
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  signingKey: CryptoKey,
  now: Date,
  ttlSeconds = 12 * 60 * 60,
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = base64urlEncode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = base64urlEncode(
    te.encode(JSON.stringify({ aud, exp: Math.floor(now.getTime() / 1000) + ttlSeconds, sub: keys.subject })),
  );
  const unsigned = `${header}.${claims}`;
  // WebCrypto ECDSA output is raw r||s (64 bytes), which is exactly JWS ES256.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, te.encode(unsigned));
  return `vapid t=${unsigned}.${base64urlEncode(sig)}, k=${keys.publicKey}`;
}
