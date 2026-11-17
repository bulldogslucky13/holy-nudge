// RFC 8291 (Message Encryption for Web Push) with RFC 8188 aes128gcm, on WebCrypto only.
import { base64urlDecode, base64urlEncode, concatBytes } from './base64url';

const te = new TextEncoder();

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** HKDF with a single output block (length <= 32), as RFC 8291 uses it. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concatBytes(info, new Uint8Array([1])))).slice(0, length);
}

/** P-256 public point (65 bytes, uncompressed) -> JWK x/y. */
export function p256PointToJwk(point: Uint8Array): { kty: 'EC'; crv: 'P-256'; x: string; y: string } {
  if (point.length !== 65 || point[0] !== 4) throw new Error('Expected a 65-byte uncompressed P-256 point');
  return { kty: 'EC', crv: 'P-256', x: base64urlEncode(point.slice(1, 33)), y: base64urlEncode(point.slice(33, 65)) };
}

export interface EphemeralKeys {
  privateKey: CryptoKey;
  /** 65-byte uncompressed public point. */
  publicKey: Uint8Array;
}

export async function generateEphemeralKeys(): Promise<EphemeralKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  return { privateKey: pair.privateKey, publicKey };
}

export interface EncryptOptions {
  /** Inject for tests (RFC 8291 Appendix A); random otherwise. */
  ephemeral?: EphemeralKeys;
  salt?: Uint8Array;
  recordSize?: number;
}

/**
 * Encrypt a push message body for a subscription.
 * @param uaPublicB64 subscription keys.p256dh (base64url)
 * @param authSecretB64 subscription keys.auth (base64url)
 * Returns the full aes128gcm body (header + single record).
 */
export async function encryptPushPayload(
  plaintext: Uint8Array,
  uaPublicB64: string,
  authSecretB64: string,
  opts: EncryptOptions = {},
): Promise<Uint8Array> {
  const uaPublic = base64urlDecode(uaPublicB64);
  const authSecret = base64urlDecode(authSecretB64);
  if (authSecret.length !== 16) throw new Error('auth secret must be 16 bytes');
  const rs = opts.recordSize ?? 4096;
  // One record only: plaintext + 1 delimiter byte + 16 tag bytes must fit.
  if (plaintext.length + 17 > rs) throw new Error('Payload too large for a single record');

  const as = opts.ephemeral ?? (await generateEphemeralKeys());
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('salt must be 16 bytes');

  const uaKey = await crypto.subtle.importKey('jwk', p256PointToJwk(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // Standard WebCrypto spells it `public` (workers-types calls it `$public`; workerd accepts `public`).
  const ecdhParams = { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, as.privateKey, 256));

  // RFC 8291 section 3.4
  const keyInfo = concatBytes(te.encode('WebPush: info\0'), uaPublic, as.publicKey);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);

  // RFC 8188: last (only) record is padded with a 0x02 delimiter.
  const record = concatBytes(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));

  const header = new Uint8Array(16 + 4 + 1 + as.publicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = as.publicKey.length;
  header.set(as.publicKey, 21);
  return concatBytes(header, ciphertext);
}
