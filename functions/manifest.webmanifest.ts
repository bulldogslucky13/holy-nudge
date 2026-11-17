// The PWA manifest, personalised when ?t=<token> is present so the installed app opens /l/<token>.
import { isTokenShaped } from '../src/api/http';
import type { Env } from '../src/env';

const FALLBACK = {
  name: 'Holy Nudge',
  short_name: 'Holy Nudge',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#FFF8F0',
  theme_color: '#C2410C',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  let manifest: Record<string, unknown> = { ...FALLBACK };
  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(new URL('/manifest.webmanifest', request.url));
    if (res.ok) {
      try {
        manifest = (await res.json()) as Record<string, unknown>;
      } catch {
        // keep fallback
      }
    }
  }
  const t = new URL(request.url).searchParams.get('t');
  const personal = t !== null && isTokenShaped(t);
  if (personal) {
    manifest.start_url = `/l/${t}`;
    manifest.id = `/l/${t}`;
    manifest.scope = '/';
  }
  return new Response(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': personal ? 'private, no-store' : 'public, max-age=300',
      'Referrer-Policy': 'no-referrer',
    },
  });
};
