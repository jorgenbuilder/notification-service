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
            const urlFromPayload = (data?.data?.url) || data?.url || '/';
            const options = {
                body: data.body || 'You have a new message',
                icon: '/favicon.ico',
                badge: '/favicon.ico',
                data: {...(data.data || {}), url: urlFromPayload},
                actions: data.actions || [],
                requireInteraction: !!data.requireInteraction,
            };
            let tag = data?.data?.tag || data?.tag;
            if (tag) {
                options.tag = tag;
            }
            return self.registration.showNotification(title, options);
        } catch (e) {
            return self.registration.showNotification('New notification', {
                body: 'You have a new notification',
                icon: '/favicon.ico'
            });
        }
    })());
});

self.addEventListener('message', (event) => {
    try {
        const data = event?.data || {};
        if (data && data.type === 'CLEAR_NOTIFICATIONS_BY_TAG') {
            const tag = data.tag;
            if (!tag) return;
            event.waitUntil((async () => {
                try {
                    const list = await self.registration.getNotifications({ includeTriggered: true });
                    for (const n of list) {
                        if (n?.tag === tag) {
                            try { n.close(); } catch (_) {}
                        }
                    }
                } catch (_) {
                    try {
                        const list = await self.registration.getNotifications();
                        for (const n of list) {
                            if (n?.tag === tag) {
                                try { n.close(); } catch (_) {}
                            }
                        }
                    } catch (_) {}
                }
            })());
        }
    } catch (_) {}
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification?.data?.url || '/';
    event.waitUntil(
        (async () => {
            const targetUrl = new URL(url, self.location.origin);
            // Try to find and focus an existing same-origin client
            const allClients = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
            for (const client of allClients) {
                try {
                    const clientUrl = new URL(client.url);
                    if (clientUrl.origin !== targetUrl.origin) continue;

                    await client.focus();
                    // Prefer messaging so the app can set session flags and handle navigation itself
                    try {
                        client.postMessage({type: 'OPEN_URL', url: targetUrl.href});
                    } catch (_) {
                    }

                    // Safe fallback: if the app is already in-app (not start_url) and different href, also navigate
                    const atRoot = clientUrl.pathname === '/' && clientUrl.search === '' && clientUrl.hash === '';
                    if ('navigate' in client && !atRoot && clientUrl.href !== targetUrl.href) {
                        return client.navigate(targetUrl.href);
                    }
                    return;
                } catch (_) {
                }
            }
            // If no client exists, open a new window at the target URL
            return self.clients.openWindow(targetUrl.href);
        })()
    );
});
