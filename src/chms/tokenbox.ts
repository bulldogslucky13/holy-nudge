// Encryption at rest for the Pushpay OAuth tokens in oauth_tokens (AES-256-GCM, WebCrypto only).
//
// Stored form: "v1.<base64url iv (12 bytes)>.<base64url ciphertext+tag>". A fresh random 96-bit IV
// per write. The column name is bound in as additional data, so a refresh token cannot be passed
// off as an access token (or the other way round) by swapping columns.
//
// The key is the secret TOKEN_ENC_KEY: 32 random bytes, base64url (scripts/gen-token-key.mjs). The
// Pages project and the cron worker must have the SAME key: both refresh and both read.
// There is no plaintext fallback: a value that is not "v1." or does not decrypt is an error.
import { base64urlDecode, base64urlEncode } from '../push/base64url';

const VERSION = 'v1';
const IV_BYTES = 12;

export type TokenColumn = 'refresh_token' | 'access_token';

/** The stored value could not be decrypted (wrong or changed key, corrupt or plaintext value). */
export class TokenDecryptError extends Error {
  override name = 'TokenDecryptError';
  constructor() {
    super('A stored Pushpay token could not be decrypted (TOKEN_ENC_KEY changed, differs between Pages and the cron worker, or the value is not encrypted).');
  }
}

/** True if the value is a base64url encoding of exactly 32 bytes. */
export function isValidTokenKey(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return base64urlDecode(value.trim()).length === 32;
  } catch {
    return false;
  }
}

/** Import TOKEN_ENC_KEY for AES-GCM. Throws if it is not 32 bytes of base64url. */
export async function importTokenKey(value: string): Promise<CryptoKey> {
  if (!isValidTokenKey(value)) throw new Error('TOKEN_ENC_KEY must be 32 random bytes, base64url');
  return crypto.subtle.importKey('raw', base64urlDecode(value.trim()), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function aad(column: TokenColumn): Uint8Array {
  return new TextEncoder().encode(`holy-nudge:oauth_tokens.${column}:${VERSION}`);
}

export async function sealToken(key: CryptoKey, column: TokenColumn, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(column) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${VERSION}.${base64urlEncode(iv)}.${base64urlEncode(ct)}`;
}

export async function openToken(key: CryptoKey, column: TokenColumn, stored: string): Promise<string> {
  const parts = stored.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) throw new TokenDecryptError();
  try {
    const iv = base64urlDecode(parts[1]!);
    if (iv.length !== IV_BYTES) throw new TokenDecryptError();
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(column) },
      key,
      base64urlDecode(parts[2]!),
    );
    return new TextDecoder().decode(pt);
  } catch {
    // Never surface the crypto error: keep the message fixed.
    throw new TokenDecryptError();
  }
}
