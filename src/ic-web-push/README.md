# IC Web Push (browser SDK)

IC Web Push is a tiny browser-side SDK that wires your web app to the Internet Computer (IC) notification canister to enable standards-based Web Push notifications.

- Works with the standard Push API in Chromium, Firefox, Edge, and Android browsers.
- Coexists with your existing service worker by using a separate scope.
- Handles subscription, unsubscription, and application registration against the IC notification canister.

Default notification canister ID: `zjwxf-jyaaa-aaaao-a43ca-cai` (configurable).

## High-level architecture

1. Your app registers a dedicated service worker (SW) under a separate scope (e.g., `/ic-web-push/`). This SW only handles displaying push notifications and reacting to clicks.
2. The SDK asks the IC notification canister for its VAPID public key and subscribes the browser via `PushManager`.
3. The resulting `PushSubscription` is sent to the notification canister and associated with your application canister principal.
4. Your backend (or a canister) sends notifications to the notification canister, which delivers them to subscribed browsers via Web Push.

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

icWebPush.init({
  // Host the canister on IC mainnet (default):
  host: 'https://ic0.app',
  // Notification canister ID (defaults to mainnet canister in this repo):
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

// Or do it step-by-step
if (await icWebPush.getPermissionStatus() !== 'granted') {
  await icWebPush.requestPermission();
}
await icWebPush.subscribe();
```

4) Unsubscribe later (optional):

```ts
await icWebPush.unsubscribe();
// Or to remove all subscriptions for your app principal on-chain:
await icWebPush.unsubscribeAll();
```

5) Optional app registration lifecycle on the canister:

```ts
await icWebPush.registerApplication();
// ... when removing your app or cleaning up
await icWebPush.deregisterApplication();
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

The service worker listens to:

- `install`/`activate` — makes itself active immediately.
- `push` — expects a JSON payload `{ title, content, url }`. Falls back to a generic message if payload is text.
- `notificationclick` — focuses an existing tab for your origin if possible, otherwise opens a new window to `url`.

You can customize the UI, icons, or behavior by editing `sw.js` before copying it into your `public` root.

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

From your canister or backend, call `sendNotification(principal, { title, content, url })` on the notification canister. The `principal` should be your application canister principal that was used when registering subscriptions.

Refer to `declarations/notification_canister/notification_canister.did.js` for the full interface: `subscribe`, `unsubscribe`, `unsubscribeAll`, `sendNotification`, etc.

## Troubleshooting

- Ensure HTTPS and a secure origin. Service workers and Push require secure contexts.
- Make sure the SW file is actually served at the path you configured in `init()`.
- If subscription fails, check that the VAPID key is being fetched successfully from the notification canister.
- If notifications do not appear, ensure the notification payload fields match what your SW expects, and that the browser has permission granted.
- Some desktop browsers block notifications when the window is focused; try sending while unfocused or check OS notification settings.
