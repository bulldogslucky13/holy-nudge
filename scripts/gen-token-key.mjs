#!/usr/bin/env node
// Prints a new TOKEN_ENC_KEY: 32 random bytes, base64url. It encrypts the Pushpay OAuth tokens in D1
// (AES-256-GCM). The Pages project and the cron worker need the SAME value.
import { randomBytes } from 'node:crypto';

console.log(`TOKEN_ENC_KEY=${randomBytes(32).toString('base64url')}`);
console.error(`
Put the line in .dev.vars for local dev. For production, set the same value on both (paste when prompted):
  npx wrangler pages secret put TOKEN_ENC_KEY --project-name holy-nudge
  npx wrangler secret put TOKEN_ENC_KEY -c cron-worker/wrangler.toml
Changing it later makes the stored Pushpay tokens unreadable: a Master Admin must approve again (/oauth/start).`);
