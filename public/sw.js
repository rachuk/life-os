/* Life OS service worker (PRD §12.1, §22): web push + a conservative offline mode.
 *
 * Caching rules — deliberately small:
 *  - static build assets (/_next/static, icons): cache-first (they are content-hashed);
 *  - page navigations: network-first; offline → the static /offline page (never caches pages with user data);
 *  - API: never cached, EXCEPT GET /api/today and /api/plan, kept as the "last loaded plan" for offline
 *    viewing. That snapshot is dropped on logout and on 401.
 */
const VERSION = 'v1';
const STATIC_CACHE = `lifeos-static-${VERSION}`;
const SHELL_CACHE = `lifeos-shell-${VERSION}`;
const DATA_CACHE = `lifeos-data-${VERSION}`;
const OFFLINE_URL = '/offline';
const DATA_PATHS = ['/api/today', '/api/plan'];
const KEEP = [STATIC_CACHE, SHELL_CACHE, DATA_CACHE];

async function precacheOffline() {
  const cache = await caches.open(SHELL_CACHE);
  const res = await fetch(OFFLINE_URL, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) return;
  const html = await res.clone().text();
  await cache.put(OFFLINE_URL, res);
  // the offline page's own scripts and styles, so it renders without a network
  const assets = [...new Set((html.match(/\/_next\/static\/[^"'\s)]+/g) || []).map((u) => u.replace(/\\u0026/g, '&')))].slice(0, 80);
  const statics = await caches.open(STATIC_CACHE);
  await Promise.all(
    assets.concat(['/icons/icon-192.png']).map((u) =>
      statics.match(u).then((hit) => hit || fetch(u, { credentials: 'omit' }).then((r) => (r.ok ? statics.put(u, r) : undefined)).catch(() => undefined)),
    ),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheOffline().catch(() => undefined).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lifeos-') && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'lifeos:clear-data') event.waitUntil(caches.delete(DATA_CACHE));
});

function offlineInline() {
  const html =
    '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Нет соединения · Life OS</title><body style="font-family:system-ui;padding:24px;max-width:480px;margin:auto">' +
    '<h1 style="font-size:20px">Нет соединения</h1><p>Life OS сейчас недоступен. Проверь интернет и обнови страницу.</p></body></html>';
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function refreshData(path) {
  try {
    const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    const cache = await caches.open(DATA_CACHE);
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) await cache.put(path, res);
    else if (res.status === 401) await caches.delete(DATA_CACHE);
  } catch {
    /* offline — keep the previous snapshot */
  }
}

async function handleNavigation(event) {
  try {
    const res = await fetch(event.request);
    const path = new URL(event.request.url).pathname;
    if (res.ok && !res.redirected) {
      if (path === '/today' || path === '/') event.waitUntil(refreshData('/api/today'));
      else if (path === '/plan') event.waitUntil(refreshData('/api/plan'));
    }
    return res;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match(OFFLINE_URL)) || offlineInline();
  }
}

async function handleData(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) await cache.put(request.url, res.clone());
    else if (res.status === 401) await caches.delete(DATA_CACHE);
    return res;
  } catch {
    const hit = await cache.match(request.url);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('X-LifeOS-Offline', '1');
      return new Response(await hit.blob(), { status: 200, headers });
    }
    return new Response(JSON.stringify({ code: 'OFFLINE', message: 'Нет соединения, а сохранённого плана на этом устройстве нет.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') await cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') {
    // signing out drops the offline copy of the plan
    if (url.pathname === '/api/auth/logout') event.waitUntil(caches.delete(DATA_CACHE));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (DATA_PATHS.includes(url.pathname)) event.respondWith(handleData(req));
    return; // every other API response is network-only and never stored
  }
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/') || url.pathname === '/favicon.png') {
    event.respondWith(cacheFirst(req));
  }
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Life OS';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    lang: 'ru',
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/today' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/today', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          await c.focus();
          if ('navigate' in c) await c.navigate(target).catch(() => undefined);
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    }),
  );
});
