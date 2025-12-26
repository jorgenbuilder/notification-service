/* Simple service worker for canChat PWA */
const VERSION = 'v1.0.1';
const STATIC_CACHE = `static-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;

const CORE_ASSETS = [
  // Vite will hash assets; keep this minimal to avoid 404. Shell caching is handled at runtime.
  '/',
  '/index.html',
  '/favicon.ico',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (!key.includes(VERSION)) {
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

// Offline and cache strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin
  if (url.origin !== self.location.origin) return;

  // Navigation requests: network-first with cache fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets: stale-while-revalidate
  if (request.destination === 'style' || request.destination === 'script' || request.destination === 'image' || request.destination === 'font') {
    event.respondWith(
      caches.match(request).then((cached) => {
        const fetchPromise = fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
            return response;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});

// Handle Web Push messages
self.addEventListener('push', (event) => {
  try {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'canChat';
    // Prefer URL from data.data.url, but also accept top-level data.url
    const urlFromPayload = (data && data.data && data.data.url) || data.url || '/';
    const options = {
      body: data.body || 'You have a new message',
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      data: { ...(data.data || {}), url: urlFromPayload },
      actions: data.actions || [],
      // Support for requireInteraction if desired
      requireInteraction: !!data.requireInteraction,
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    // Fallback if payload is not JSON
    event.waitUntil(self.registration.showNotification('canChat', { body: 'You have a new notification', icon: '/favicon.ico' }));
  }
});

// Focus the app when a notification is clicked
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification && event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    try {
      const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        try {
          await client.focus();
          // Use postMessage so the SPA can navigate itself (works better on iOS PWAs)
          client.postMessage({ type: 'OPEN_URL', url: targetUrl });
          return;
        } catch (_) {
          // continue
        }
      }
      if (clients.openWindow) {
        await clients.openWindow(targetUrl);
      }
    } catch (e) {
      // Best effort fallback
      if (clients.openWindow) {
        await clients.openWindow('/');
      }
    }
  })());
});
