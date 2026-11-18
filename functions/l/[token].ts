// Personal link: serve the app shell with the manifest pointing at this leader's start_url.
// The token is not checked here; the app calls /api/me with it and shows a friendly error if invalid.
// Functions responses do not get public/_headers, so the security headers are set here.
import { applySecurityHeaders } from '../../src/api/headers';
import { isTokenShaped } from '../../src/api/http';
import type { Env } from '../../src/env';

export const onRequestGet: PagesFunction<Env, 'token'> = async ({ request, env, params }) => {
  const token = String(params.token);
  if (!env.ASSETS) return new Response('Assets binding missing', { status: 500 });
  const shell = await env.ASSETS.fetch(new URL('/', request.url));
  const headers = applySecurityHeaders(new Headers(shell.headers));
  headers.set('Cache-Control', 'private, no-store');
  headers.delete('ETag');
  const base = new Response(shell.body, { status: shell.status, headers });
  if (!isTokenShaped(token)) return base; // still show the app; it will ask for a valid link
  return new HTMLRewriter()
    .on('link[rel="manifest"]', {
      element(el) {
        el.setAttribute('href', `/manifest.webmanifest?t=${encodeURIComponent(token)}`);
      },
    })
    .transform(base);
};
