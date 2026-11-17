#!/usr/bin/env node
// Prints a new VAPID key pair (P-256). The private key goes into the secret store, never into git.
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.error(`
Put both lines in .dev.vars for local dev. For production, set them as secrets (paste when prompted):
  npx wrangler pages secret put VAPID_PUBLIC_KEY --project-name holy-nudge
  npx wrangler pages secret put VAPID_PRIVATE_KEY --project-name holy-nudge
  npx wrangler secret put VAPID_PUBLIC_KEY -c cron-worker/wrangler.toml
  npx wrangler secret put VAPID_PRIVATE_KEY -c cron-worker/wrangler.toml
Changing keys later invalidates every existing subscription (leaders must turn notifications on again).`);
