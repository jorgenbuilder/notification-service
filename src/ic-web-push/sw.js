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
  // The payload is expected to be JSON with fields { title, content, url }
  let data = {};
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    // If payload isn't JSON, show a generic message
    data = { title: 'New notification', content: event.data?.text?.() ?? 'You have a new message.' };
  }

  const title = data.title || 'New notification';
  const body = data.content || '';
  const url = data.url || '/';
  const icon = data.icon || '/favicon.ico';
  const badge = data.badge || undefined;

  const options = {
    body,
    icon,
    badge,
    data: { url },
  };

  event.waitUntil(self.registration.showNotification(title, options));
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
