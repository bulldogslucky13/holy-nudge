/* Holy Nudge service worker.
 * - Shows push notifications (always calls showNotification: iOS revokes the subscription otherwise).
 * - Opens the leader's personal link when a notification is tapped.
 * - Caches only the static shell. /api/ responses are never cached or touched.
 */

const CACHE = 'holy-nudge-shell-v4';
const SHELL_ASSETS = ['/styles.css', '/app.js', '/icon.svg', '/logo.svg', '/favicon.svg', '/icon-192.png', '/apple-touch-icon.png'];
const SHELL_PAGE = '/__shell'; // cache key for the index page (the "open your link" screen / offline fallback)

/* ---------- tiny IndexedDB key/value store (holds only the personal-link token) ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('holy-nudge', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) {
    return null;
  }
}

async function kvSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch (_) {
    /* storage unavailable: notification taps will just open the home page */
  }
}

async function kvDelete(key) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch (_) {
    /* nothing stored */
  }
}

/* ---------- lifecycle and caching ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        await cache.addAll(SHELL_ASSETS);
        const res = await fetch('/', { cache: 'reload' });
        if (res.ok) {
          // Re-wrap so a redirected response is never reused for a navigation.
          await cache.put(SHELL_PAGE, new Response(await res.blob(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
        }
      } catch (_) {
        /* offline at install time: the app still works online */
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never touch the API, OAuth, the per-leader manifest, or this file: always straight to the network.
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/oauth/') || p === '/manifest.webmanifest' || p === '/sw.js') return;

  if (req.mode === 'navigate') {
    // Always network first so the server can rewrite the manifest link per leader.
    // Pages are not cached (they carry the personal link); offline we fall back to the static shell.
    event.respondWith(
      fetch(req).catch(async () => (await caches.match(SHELL_PAGE)) || Response.error())
    );
    return;
  }

  if (SHELL_ASSETS.includes(p)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const fresh = await fetch(req);
          if (fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        } catch (_) {
          const hit = await cache.match(req);
          return hit || Response.error();
        }
      })()
    );
  }
});

/* ---------- token handoff from the page ---------- */

// The page sends only tokens the server has accepted, and asks us to forget the token after any 401
// (link unknown or turned off), so a notification tap never reopens a dead link.
self.addEventListener('message', (event) => {
  if (event.origin && event.origin !== self.location.origin) return;
  const data = event.data;
  if (data && data.type === 'token' && typeof data.token === 'string' && data.token) {
    event.waitUntil(kvSet('token', data.token));
  } else if (data && data.type === 'forget-token') {
    event.waitUntil(kvDelete('token'));
  }
});

/* ---------- push ---------- */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    try {
      data = { body: event.data.text() };
    } catch (__) {
      data = {};
    }
  }
  const kind = typeof data.kind === 'string' && data.kind ? data.kind : 'nudge';
  const title = typeof data.title === 'string' && data.title ? data.title : 'Holy Nudge';
  const body = typeof data.body === 'string' && data.body ? data.body : 'Someone could use a friendly hello. Tap to see who.';

  // Always show something, even if the payload was odd.
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: 'holy-nudge-' + kind, // repeats of the same kind replace each other
      renotify: true,
      icon: '/icon-192.png',
      data: { kind },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const token = await kvGet('token');
      const target = token ? '/l/' + encodeURIComponent(token) : '/';
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        try {
          if (new URL(w.url).origin === self.location.origin) {
            await w.focus();
            w.postMessage({ type: 'refresh' });
            return;
          }
        } catch (_) {
          /* try the next window */
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});

/* If the browser rotates the push subscription, quietly re-register it. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const token = await kvGet('token');
        if (!token) return;
        const headers = { Authorization: 'Bearer ' + token };
        const { key } = await (await fetch('/api/vapid-public-key', { headers })).json();
        const pad = '='.repeat((4 - (key.length % 4)) % 4);
        const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/'));
        const appKey = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
        const res = await fetch('/api/subscribe', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        });
        if (res.status === 401) {
          // The link was turned off: forget it and drop the new subscription.
          await kvDelete('token');
          await sub.unsubscribe().catch(() => {});
        }
      } catch (_) {
        /* the next time the app opens it will offer to turn notifications back on */
      }
    })()
  );
});
