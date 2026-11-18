import { describe, expect, it } from 'vitest';
import { CSP, SECURITY_HEADERS } from '../src/api/headers';
import { OAUTH_PAGE_CSP, OAUTH_PAGE_STYLE, OAUTH_PAGE_STYLE_HASH } from '../src/chms/oauth';
import { readText } from './files';

async function sha256Base64(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  let bin = '';
  for (const b of d) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe('security headers', () => {
  it('public/_headers (static files) matches the headers set in code (Functions)', async () => {
    const file = await readText('public/_headers');
    const lines = file.split('\n').filter((l: string) => /^\s+\S+:/.test(l));
    const parsed = Object.fromEntries(lines.map((l: string) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
    expect(parsed).toEqual(SECURITY_HEADERS);
    expect(file).toMatch(/^\/\*$/m);
  });

  it('the CSP has no unsafe-inline / unsafe-eval and denies framing', () => {
    expect(CSP).not.toMatch(/unsafe/);
    expect(CSP).toMatch(/frame-ancestors 'none'/);
    expect(CSP).toMatch(/form-action 'none'/);
    expect(CSP).toMatch(/base-uri 'none'/);
  });

  it('the OAuth page CSP allows exactly its own inline style by hash', async () => {
    const hash = `sha256-${await sha256Base64(OAUTH_PAGE_STYLE)}`;
    expect(OAUTH_PAGE_STYLE_HASH).toBe(hash);
    expect(OAUTH_PAGE_CSP).toContain(`style-src '${hash}'`);
    expect(OAUTH_PAGE_CSP).not.toMatch(/unsafe/);
  });

  it('the app shell and scripts need no inline script or style (CSP-safe)', async () => {
    const html = await readText('public/index.html');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // every <script> has src
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
    const app = await readText('public/app.js');
    expect(app).not.toMatch(/\bstyle:\s*'/); // no style attributes via the h() helper
    expect(app).not.toMatch(/setAttribute\(\s*'style'/);
    expect(app).not.toMatch(/\beval\(|new Function\(/);
  });

  it('"Open in ChMS" links do not leak the referrer or the opener', async () => {
    const app = await readText('public/app.js');
    expect(app).toMatch(/target: '_blank', rel: 'noopener noreferrer'/);
    expect(app).not.toMatch(/rel: 'noopener'[,\s}]/);
  });
});
