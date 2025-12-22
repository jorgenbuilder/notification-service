self.addEventListener('install', (event) => {
  // Activate immediately
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Become available to all pages
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    try {
      data = { title: 'New message', body: event.data ? event.data.text() : '' };
    } catch (_) {
      data = { title: 'New message', body: '' };
    }
  }

  const title = data.title || data.notification?.title || 'New message';
  const body = data.body || data.content || data.notification?.body || '';
  const icon = data.icon || '/icon-192.png';
  const badge = data.badge || '/badge-72.png';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      data,
      tag: data.tag || 'chat-message',
      renotify: false,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/';
  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      let client = allClients.find((c) => 'focus' in c);
      if (client) {
        await client.focus();
        if (targetUrl) {
          client.navigate(targetUrl);
        }
      } else {
        await clients.openWindow(targetUrl || '/');
      }
    })()
  );
});
