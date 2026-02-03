# IC Web Push (browser SDK)

IC Web Push is a tiny browser-side SDK that wires your web app to the Internet Computer (IC) notification canister to enable standards-based Web Push notifications.

- Works with the standard Push API in Safari, Chromium, Firefox, Edge, and Android browsers.
- Coexists with your existing service worker by using a separate scope.
- Handles subscription, unsubscription, and application registration against the IC notification canister.

Default notification canister ID: `zjwxf-jyaaa-aaaao-a43ca-cai` (configurable).

## High-level architecture

1. Your app registers a dedicated service worker (SW) under a separate scope (e.g., `/ic-web-push/`). This SW only handles displaying push notifications and reacting to clicks.
2. The SDK lists available relayers from the IC notification canister, picks one (random by default), fetches its VAPID public key, and subscribes the browser via `PushManager` using that key.
3. The resulting `PushSubscription` plus the chosen relayer principal is sent to the notification canister and associated with your application canister principal.
4. Your backend canister sends notifications to the notification canister; each subscription is routed to its chosen relayer's queue for delivery via Web Push.

## Files in this module

- `index.ts` — public API surface for initializing and controlling subscriptions.
- `sw.js` — the service worker that displays notifications and handles clicks.

## Coexisting with your app's service worker

Service workers are scoped by path. To avoid conflicts with your main app SW, IC Web Push uses its own scope, by default `/ic-web-push/`, and assumes its file is hosted at `/ic-web-push-sw.js` in your web root.

You may keep your app's own `sw.js` for app caching, offline, etc. This SDK's SW will not interfere because it is registered under a separate scope and only handles `push` and `notificationclick` events within that scope.

## Hosting the service worker file

Place the service worker file at the web root so it can be served at `/ic-web-push-sw.js`. There are multiple ways to do this depending on your bundler:

- Vite: copy `src/ic-web-push/sw.js` into `public/ic-web-push-sw.js` (the `public` folder is served at web root). Example:
  - Copy once manually, or
  - Add a small build step/plugin to copy the file on build
- CRA/Next.js/others: add a copy step to move `sw.js` to the output root as `ic-web-push-sw.js`.

You can also customize the path/scope via `init()` if you prefer a different location.

## Usage

1) Initialize the SDK early in app startup:

```ts
import icWebPush from 'ic-web-push';
import { HttpAgent } from '@dfinity/agent';

const agent = new HttpAgent({ host: 'https://ic0.app' });
// If developing locally against a replica, you may need:
// await agent.fetchRootKey();

icWebPush.init({
  agent,
  // Notification canister ID (defaults to mainnet id):
  // notificationCanisterId: 'zjwxf-jyaaa-aaaao-a43ca-cai',
  // Your application canister principal (REQUIRED to subscribe):
  applicationCanisterId: '<your app canister id>',
  // Optional: customize where the service worker is served from
  serviceWorkerPath: '/ic-web-push-sw.js',
  serviceWorkerScope: '/ic-web-push/',
});

icWebPush.setDebug(true); // optional
```

2) Register the service worker:

```ts
await icWebPush.registerServiceWorker();
```

3) Request permission (if needed) and subscribe:

```ts
// One-shot convenience that registers SW, ensures permission, and subscribes
await icWebPush.ensureSubscribed({ requestPermissionIfNeeded: true });

// Or do it step-by-step and pick a relayer explicitly
if (await icWebPush.getPermissionStatus() !== 'granted') {
  await icWebPush.requestPermission();
}

// Option A: pick a random relayer
const relayer = await icWebPush.chooseRandomRelayer();
if (!relayer) throw new Error('No relayers available');
await icWebPush.subscribe({ relayer });

// Option B: list relayers and choose one by your own policy
const relayers = await icWebPush.listRelayers();
// e.g., pick the first or prefer by description
await icWebPush.subscribe({ relayer: relayers[0].relayer });
```

4) Unsubscribe later (optional):

```ts
await icWebPush.unsubscribe();
// Or to remove all subscriptions for your app principal on-chain:
await icWebPush.unsubscribeAll();
```


## API reference

- `init(config)` — initializes SDK. Options:
  - `agent` (HttpAgent): an agent for interaction with IC. Should use user's identity.
  - `notificationCanisterId` (string): notification canister ID, default mainnet ID.
  - `applicationCanisterId` (string): your app canister principal. Required for `subscribe`/`unsubscribeAll`.
  - `serviceWorkerPath` (string): where the SW file is served from. Default `/ic-web-push-sw.js`.
  - `serviceWorkerScope` (string): SW scope. Default `/ic-web-push/`.

- `setDebug(enabled)` — toggles debug logs.
- `registerServiceWorker()` — registers the SW at the configured path/scope.
- `getPermissionStatus()` — returns the current `Notification.permission`.
- `requestPermission()` — prompts the browser permission dialog.
- `subscribe({ requestPermissionIfNeeded? })` — creates a push subscription and registers it on-chain.
- `ensureSubscribed({ requestPermissionIfNeeded? })` — convenience wrapper to do SW, permission, and subscription together.
- `getSubscription()` — resolves the current `PushSubscription` or `null`.
- `isSubscribed()` — boolean indicating whether a subscription exists locally.
- `unsubscribe()` — removes the local subscription and tries to unregister it on the canister.
- `unsubscribeAll()` — unregisters all subscriptions for the configured application principal on the canister.

## Service worker behavior

This SDK ships a dedicated service worker (`sw.js`) intended to live under its own scope (recommended: `/ic-web-push/`) and be served from your web root as `/ic-web-push-sw.js`. It is designed to coexist with your app’s main service worker without conflict. The worker implements the following:

- `install`
  - Calls `self.skipWaiting()` so that updates to the worker take effect immediately after install.
- `activate`
  - Calls `self.clients.claim()` to take control of pages under its scope without a manual reload.
- `push`
  - Parses a JSON payload (if present). Robust to missing/invalid payloads and falls back to a generic notification.
  - Supported payload fields (top-level preferred; `data.*` also accepted for backward compatibility):
    - `title` (string): Notification title. Default: `"New notification"`.
    - `content` (string): Notification text; mapped to Notification API `body`. Default: `"You have a new message"`.
    - `url` (string): A URL to open/focus when the notification is clicked. May also be provided as `data.url`.
    - `actions` (array): Standard Notification API actions.
    - `requireInteraction` (boolean): If `true`, the notification stays until user interaction.
    - `tag` (string): Notification tag for collapsing/updating and for later clearing.
    - `data` (object): Arbitrary extra fields; merged into the notification `data` object. The worker ensures `data.url` is set to the resolved URL.
  - Display options applied by default:
    - `icon` and `badge` default to `/favicon.ico` (override by editing `sw.js`).
    - If `tag` is provided, it is set on the notification so later notifications with the same tag replace or group, per browser behavior.
  - Example payload sent by your canister (matches `NotificationBody`):
    ```json
    {
      "title": "New message",
      "content": "You received a message",
      "url": "/inbox/123",
      "tag": "chat-123"
    }
    ```
- `message`
  - Listens for `{ type: 'CLEAR_NOTIFICATIONS_BY_TAG', tag: string }` to programmatically close notifications with the given tag.
  - Uses `registration.getNotifications({ includeTriggered: true })` when supported, with a safe fallback to `getNotifications()`.
  - Example from a page context (any controlled client under the SW scope):
    ```ts
    navigator.serviceWorker.controller?.postMessage({
      type: 'CLEAR_NOTIFICATIONS_BY_TAG',
      tag: 'chat-123',
    });
    ```
- `notificationclick`
  - Closes the clicked notification.
  - Resolves a target URL from `notification.data.url` (defaults to `/`).
  - Looks for an existing same-origin window client and, if found:
    - Focuses it.
    - Tries to `postMessage({ type: 'OPEN_URL', url })` so the app can handle in-app routing/session flags.
    - As a safe fallback, if the client is not at the origin root and the href differs, calls `client.navigate(url)`.
  - If no suitable client exists, opens a new window via `clients.openWindow(url)`.

You can customize icons, default texts, or add behavior by editing `src/ic-web-push/sw.js` before copying it into your build’s web root as `ic-web-push-sw.js`.

### Page <-> SW messaging: handling OPEN_URL

When a notification is clicked, the SW first tries to notify an existing tab using a message. In your application code, you may listen to this message to perform client-side routing instead of a hard navigation:

```ts
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg?.type === 'OPEN_URL' && typeof msg.url === 'string') {
      // App-specific navigation, e.g., using your router
      // router.push(new URL(msg.url, location.origin).pathname);
      // Or simply: location.href = msg.url;
    }
  });
}
```

## Integration example (Vite + the provided chat_frontend)

1. Copy the service worker to the example's public root:
   - Copy `src/ic-web-push/sw.js` to `example/chat_frontend/public/ic-web-push-sw.js`.

2. Initialize and subscribe in your app code, e.g., `example/chat_frontend/src/App.jsx`:

```jsx
import { useEffect } from 'react';
import icWebPush from 'ic-web-push';
import { HttpAgent } from '@dfinity/agent';

export default function App() {
  useEffect(() => {
    icWebPush.init({
      agent: new HttpAgent(),
      applicationCanisterId: '<chat_backend_canister_id>',
      // notificationCanisterId: '<override if not using default>'
    });
    icWebPush.ensureSubscribed({ requestPermissionIfNeeded: true }).catch(console.error);
  }, []);

  return <div>Chat app with IC Web Push</div>;
}
```

3. Start the dev server. Verify you see the permission prompt and a registered service worker under Application > Service Workers in DevTools.

## Sending notifications

From your canister or backend, call `sendNotifications` with a vector of `(principal, NotificationBody)` pairs on the notification canister. The `principal` should be your application canister principal that was used when registering subscriptions.

`NotificationBody` schema:
```candid
record {
  title: text;
  content: text;
  url: opt text;
  tag: opt text;
}
```

Refer to the canister Candid (`src/notification-canister/notification_canister.did`) for the full interface. On-chain sending uses `sendNotifications(principal, NotificationBody)`.

## Troubleshooting

- Ensure HTTPS and a secure origin. Service workers and Push require secure contexts.
- Make sure the SW file is actually served at the path you configured in `init()`.
- If subscription fails, check that the VAPID key is being fetched successfully from the notification canister.
- If notifications do not appear, ensure the notification payload fields match what your SW expects, and that the browser has permission granted.
- Some desktop browsers block notifications when the window is focused; try sending while unfocused or check OS notification settings.
