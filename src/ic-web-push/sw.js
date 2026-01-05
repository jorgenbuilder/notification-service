/*
IC Web Push Service Worker

Scope recommendation: '/ic-web-push/'
File name recommendation at web root: '/ic-web-push-sw.js'

This SW is designed to coexist with your main application SW, by using a dedicated scope.
It handles 'push' events to display notifications and 'notificationclick' to focus/open the app.
*/

self.addEventListener('install', (event) => {
  // Skip waiting so updates take effect quickly
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim the clients in our scope so we can receive messages immediately
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    try {
      const data = event.data ? event.data.json() : {};
      const title = data.title || 'New notification';
      const urlFromPayload = (data && data.data && data.data.url) || data.url || '/';
      const options = {
        body: data.body || 'You have a new message',
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        data: { ...(data.data || {}), url: urlFromPayload },
        actions: data.actions || [],
        requireInteraction: !!data.requireInteraction,
      };

      let suppress = false;
      try {
        const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const targetUrl = new URL(urlFromPayload, self.location.origin);
        for (const client of allClients) {
          try {
            const clientUrl = new URL(client.url);
            if (clientUrl.href === targetUrl.href) {
              suppress = true;
              break;
            }
          } catch {}
        }
      } catch {}

      if (!suppress) {
        return self.registration.showNotification(title, options);
      }
      try {
        const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of allClients) {
          client.postMessage({ type: 'ic-web-push:suppressed', url: urlFromPayload, title, body: options.body });
        }
      } catch {}
      return;
    } catch (e) {
      return self.registration.showNotification('New notification', { body: 'You have a new notification', icon: '/favicon.ico' });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil(
    (async () => {
      // Try to focus an existing client that matches the URL origin
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        try {
          const clientUrl = new URL(client.url);
          const targetUrl = new URL(url, self.location.origin);
          if (clientUrl.origin === targetUrl.origin) {
            await client.focus();
            // Optionally navigate it to target path
            if ('navigate' in client && clientUrl.href !== targetUrl.href) {
              return client.navigate(targetUrl.href);
            }
            return;
          }
        } catch {}
      }
      // If no client, open a new window
      return self.clients.openWindow(url);
    })()
  );
});
