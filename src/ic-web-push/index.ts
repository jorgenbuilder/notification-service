import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { Principal } from '@icp-sdk/core/principal';
import {
  idlFactory as notificationIdlFactory
} from './declarations/notification_canister/notification_canister.did.js';

export type IcWebPushConfig = {
  // Agent
  agent: HttpAgent;
  /** Notification canister ID (Principal text). Defaults to known mainnet ID. */
  notificationCanisterId?: string;
  /** Your application canister ID (Principal text) to associate subscriptions with. REQUIRED for subscribe(). */
  applicationCanisterId?: string;
  /** Path to the service worker file within your web root. Default: '/ic-web-push-sw.js' */
  serviceWorkerPath?: string;
  /** Service worker scope. Default: '/ic-web-push/' */
  serviceWorkerScope?: string;
};

export type SubscribeOptions = {
  // If true, will prompt for notification permission if not already granted.
  requestPermissionIfNeeded?: boolean;
  // Optionally force using a specific relayer (Principal text or Principal)
  relayer?: string | Principal;
};

const DEFAULTS = {
  notificationCanisterId: 'zjwxf-jyaaa-aaaao-a43ca-cai',
  serviceWorkerPath: '/ic-web-push-sw.js',
  serviceWorkerScope: '/ic-web-push/',
};

let _config: Required<Pick<IcWebPushConfig, 'agent' | 'notificationCanisterId' | 'serviceWorkerPath' | 'serviceWorkerScope'>> &
  Pick<IcWebPushConfig, 'applicationCanisterId'> = { ...DEFAULTS } as any;
let _actor: any | null = null;
let _debug = false;
let _debugAlerts = false;

function dbg(...args: any[]) {
  if (_debug) {
    console.log('[ic-web-push]', ...args);
    if (_debugAlerts) {
      alert('[ic-web-push] ' + args.map(x => JSON.stringify(x)).join(', '));
    }
  }
}

export function setDebug(enabled: boolean) {
  _debug = enabled;
}

export function setDebugAlerts(enabled: boolean) {
  _debugAlerts = enabled;
}

export function init(config: IcWebPushConfig) {
  _config = {
    agent: config.agent,
    notificationCanisterId: config?.notificationCanisterId ?? DEFAULTS.notificationCanisterId,
    serviceWorkerPath: config?.serviceWorkerPath ?? DEFAULTS.serviceWorkerPath,
    serviceWorkerScope: config?.serviceWorkerScope ?? DEFAULTS.serviceWorkerScope,
    applicationCanisterId: config?.applicationCanisterId,
  } as any;
  _actor = null;
  dbg('Initialized with config', _config);
}

function requireWindow(): Window {
  if (typeof window === 'undefined') throw new Error('ic-web-push: must be used in a browser context');
  return window;
}

async function getActor() {
  if (_actor) return _actor;
  if (!_config || !_config.agent) {
    throw new Error('ic-web-push: init() must be called with an HttpAgent before use');
  }
  const agent = _config.agent;
  const canisterId = _config.notificationCanisterId;
  const actor = Actor.createActor(notificationIdlFactory, {
    agent,
    canisterId,
  });
  _actor = actor as any;
  return _actor;
}

export async function getPermissionStatus(): Promise<NotificationPermission> {
  requireWindow();
  return Notification.permission;
}

export async function requestPermission(): Promise<NotificationPermission> {
  requireWindow();
  const res = await Notification.requestPermission();
  dbg('Notification permission result:', res);
  return res;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  const w = requireWindow();
  if (!('serviceWorker' in navigator)) {
    console.warn('[ic-web-push] Service workers are not supported in this browser.');
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.register(_config.serviceWorkerPath, {
      scope: _config.serviceWorkerScope,
      // type: 'module', // our sw is classic to maximize compatibility
      updateViaCache: 'none',
    });
    await reg.update();
    dbg('Service worker registered', reg);
    return reg;
  } catch (e) {
    console.error('[ic-web-push] Failed to register service worker:', e);
    throw e;
  }
}

export function ensurePushSupported(): boolean {
  try {
    requireWindow();
  } catch {
    return false;
  }
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) {
    dbg('[ic-web-push] Push is not supported in this browser.');
    console.warn('[ic-web-push] Push is not supported in this browser.');
  }
  return supported;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function toPrincipal(p: string | Principal): Principal {
  return typeof p === 'string' ? Principal.fromText(p) : p;
}

export type RelayerInfo = {
  relayer: Principal;
  vapid_public_key: string;
  registeredAt: bigint;
  lastUpdatedAt: bigint;
  description: string;
};

export async function listRelayers(): Promise<RelayerInfo[]> {
  const actor = await getActor();
  return actor.listRelayers();
}

export async function chooseRandomRelayer(): Promise<Principal | null> {
  const list = await listRelayers();
  if (!list || list.length === 0) return null;
  const idx = Math.floor(Math.random() * list.length);
  return list[idx].relayer;
}

export async function getVapidPublicKey(relayer: string | Principal): Promise<string> {
  const actor = await getActor();
  const key: string = await actor.getVapidPublicKey(toPrincipal(relayer));
  dbg('VAPID public key fetched for relayer');
  return key;
}

function subscriptionToRecord(sub: PushSubscription, relayer: Principal): any {
  const json = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    keys: {
      p256dh: (json.keys as any)?.p256dh ?? '',
      auth: (json.keys as any)?.auth ?? '',
    },
    expirationTime: json.expirationTime ? [BigInt(json.expirationTime)] : [],
    relayer,
  };
}

const LS = (principalText: string) => ({
  registered: `icwp.${principalText}.registered`,
  endpoint: `icwp.${principalText}.endpoint`,
  relayer: `icwp.${principalText}.relayer`,
});

async function getCurrentPrincipalText(): Promise<string | null> {
  try {
    return (await _config?.agent.getPrincipal())?.toText();
  } catch (err) {
    dbg('[ic-web-push] Failed to get current principal:', err);
  }
  return null;
}

async function isCurrentPrincipalAnonymous(): Promise<boolean> {
  const pt = await getCurrentPrincipalText();
  return !pt || pt === '2vxsx-fae';
}

function setLocalRegistered(principalText: string, endpoint: string | null) {
  const keys = LS(principalText);
  try {
    if (endpoint) {
      localStorage.setItem(keys.registered, '1');
      localStorage.setItem(keys.endpoint, endpoint);
    } else {
      localStorage.removeItem(keys.registered);
      localStorage.removeItem(keys.endpoint);
    }
  } catch {
  }
}

function setLocalRelayer(principalText: string, relayerText: string | null) {
  const keys = LS(principalText);
  try {
    if (relayerText) {
      localStorage.setItem(keys.relayer, relayerText);
    } else {
      localStorage.removeItem(keys.relayer);
    }
  } catch {
  }
}

async function clearLocalForCurrentPrincipal() {
  const pt = await getCurrentPrincipalText();
  if (!pt) return;
  setLocalRegistered(pt, null);
  setLocalRelayer(pt, null);
}

export async function getSubscription(): Promise<PushSubscription | null> {
  try {
    requireWindow();
  } catch {
    return null; // SSR or non-browser environment
  }
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration(_config.serviceWorkerScope);
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

export async function isSubscribed(): Promise<boolean> {
  if (await isCurrentPrincipalAnonymous()) return false;
  const pt = (await getCurrentPrincipalText())!;

  const sub = await getSubscription();
  if (!sub) return false;

  // Best-effort relayer consistency check: if we stored a relayer locally, ensure it's still registered.
  try {
    const storedRelayerTxt = localStorage.getItem(LS(pt).relayer);
    if (storedRelayerTxt) {
      const relayers = await listRelayers();
      const exists = relayers.some(r => r.relayer.toText() === storedRelayerTxt);
      if (!exists) {
        dbg('[ic-web-push] Stored relayer is no longer registered. Treating as unsubscribed for current principal.');
        return false;
      }
    }
  } catch {
  }

  // If there is no local record for this principal, report not subscribed
  try {
    const keys = LS(pt);
    const perEndpoint = localStorage.getItem(keys.endpoint);
    const perRegistered = localStorage.getItem(keys.registered);
    if (!perRegistered || !perEndpoint) {
      return false;
    }
    if (perEndpoint !== sub.endpoint) {
      // Local record exists for current principal but endpoint differs from current browser endpoint
      // Consider not subscribed for this principal; do not change browser subscription.
      return false;
    }
  } catch {
  }

  // If applicationCanisterId is configured, verify with server canister
  if (_config.applicationCanisterId) {
    try {
      const actor = await getActor();
      const app = Principal.fromText(_config.applicationCanisterId);
      const ok: boolean = await actor.hasSubscription(app, sub.endpoint);
      if (!ok) {
        dbg('[ic-web-push] Local subscription not found on the canister for current principal. Removing it locally');
        // Do NOT unsubscribe browser here; it may be registered for another principal.
        await clearLocalForCurrentPrincipal();
        return false;
      }
    } catch (e) {
      dbg('[ic-web-push] hasSubscription check failed; assuming local subscription is valid:', e);
      console.warn('[ic-web-push] hasSubscription check failed; assuming local subscription is valid:', e);
      // Fall through and trust local presence
    }
  }

  return true;
}

async function ensureServiceWorkerReady(): Promise<ServiceWorkerRegistration> {
  let reg = await navigator.serviceWorker.getRegistration(_config.serviceWorkerScope);
  if (!reg) {
    reg = (await registerServiceWorker())!;
  }
  if (!reg) throw new Error('ic-web-push: service worker is required but was not registered');
  return reg;
}

/** Subscribe the browser and register the subscription on the notification canister. */
export async function subscribe(options?: SubscribeOptions): Promise<PushSubscription> {
  if (await isCurrentPrincipalAnonymous()) throw new Error('ic-web-push: Anonymous principal is not supported for subscriptions');
  if (!_config.applicationCanisterId) throw new Error('ic-web-push: applicationCanisterId is required in init() to subscribe');
  if (!ensurePushSupported()) throw new Error('ic-web-push: Push not supported');

  const pt = (await getCurrentPrincipalText())!;

  const permission = await getPermissionStatus();
  if (permission !== 'granted') {
    if (options?.requestPermissionIfNeeded) {
      const p = await requestPermission();
      if (p !== 'granted') throw new Error('ic-web-push: Notification permission was not granted');
    } else {
      throw new Error('ic-web-push: Notification permission is not granted');
    }
  }

  // Resolve relayer to use
  let relayer: Principal | null = null;
  try {
    if (options?.relayer) {
      relayer = toPrincipal(options.relayer);
    } else {
      const stored = localStorage.getItem(LS(pt).relayer);
      if (stored) relayer = Principal.fromText(stored);
    }
  } catch {
  }
  if (!relayer) {
    relayer = await chooseRandomRelayer();
  }
  if (!relayer) {
    throw new Error('ic-web-push: No relayers are registered on the notification canister');
  }

  const reg = await ensureServiceWorkerReady();
  const existing = await reg.pushManager.getSubscription();
  const vapidKey = await getVapidPublicKey(relayer);
  const appServerKey = urlBase64ToUint8Array(vapidKey);

  let subscription = existing;
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey as any
    });
    dbg('Created new PushSubscription');
  } else {
    dbg('Existing PushSubscription found');
  }

  const actor = await getActor();
  const app = Principal.fromText(_config.applicationCanisterId!);
  await actor.subscribe(app, subscriptionToRecord(subscription, relayer));
  setLocalRegistered(pt, subscription.endpoint);
  try {
    setLocalRelayer(pt, relayer.toText());
  } catch {
  }
  dbg('Subscription registered on canister with relayer', relayer.toText());
  return subscription;
}

/** Unsubscribe from browser and unregister from the notification canister. */
export async function unsubscribe(): Promise<void> {
  const sub = await getSubscription();
  if (!sub) {
    dbg('No subscription present');
    return;
  }
  const pt = await getCurrentPrincipalText();
  const matchesCurrentPrincipal = (() => {
    if (!pt) return false;
    try {
      const keys = LS(pt);
      const perEndpoint = localStorage.getItem(keys.endpoint);
      return perEndpoint === sub.endpoint;
    } catch {
      return false;
    }
  })();

  try {
    // Try unregister on canister first (for current principal)
    const actor = await getActor();
    if (_config.applicationCanisterId) {
      const app = Principal.fromText(_config.applicationCanisterId);
      await actor.unsubscribe(app, sub.endpoint);
      dbg('Subscription removed from canister for current principal (if existed). Endpoint:', sub.endpoint);
    }
  } catch (e) {
    dbg('[ic-web-push] Failed to unregister on canister for current principal (may still remove local state):', e);
    console.warn('[ic-web-push] Failed to unregister on canister for current principal (may still remove local state):', e);
  }

  if (matchesCurrentPrincipal) {
    // Only unsubscribe the browser-wide PushSubscription if it belongs to the current principal
    try {
      const ok = await sub.unsubscribe();
      dbg('Browser PushSubscription unsubscribed:', ok);
    } finally {
      // Clear per-principal local state for current identity
      await clearLocalForCurrentPrincipal();
    }
  } else {
    // Do not touch the browser subscription since it likely belongs to a different principal.
    await clearLocalForCurrentPrincipal();
    dbg('Skipped unsubscribing browser subscription as it does not match current principal.');
  }
}

/** Unregister all subscriptions for this application principal on the canister. */
export async function unsubscribeAll(): Promise<void> {
  if (!_config.applicationCanisterId) throw new Error('ic-web-push: applicationCanisterId is required in init() to unsubscribeAll');
  const actor = await getActor();
  const app = Principal.fromText(_config.applicationCanisterId);
  await actor.unsubscribeAll(app);
  dbg('[ic-web-push] Removed all subscriptions from the canister');
  // keep local sub as-is; caller may also call unsubscribe()
}

// Convenience: combined flow to ensure sw + permission + subscription
export async function ensureSubscribed(options?: SubscribeOptions): Promise<PushSubscription> {
  if (await isCurrentPrincipalAnonymous()) throw new Error('ic-web-push: Anonymous principal is not supported for subscriptions');
  await registerServiceWorker();
  if ((await getPermissionStatus()) !== 'granted') {
    if (options?.requestPermissionIfNeeded) {
      await requestPermission();
    }
  }
  return subscribe({ requestPermissionIfNeeded: false });
}

export type IcWebPushPublicAPI = {
  init: typeof init;
  registerServiceWorker: typeof registerServiceWorker;
  requestPermission: typeof requestPermission;
  getPermissionStatus: typeof getPermissionStatus;
  // Relayers
  listRelayers: typeof listRelayers;
  chooseRandomRelayer: typeof chooseRandomRelayer;
  getVapidPublicKey: typeof getVapidPublicKey;
  // Subs
  subscribe: typeof subscribe;
  unsubscribe: typeof unsubscribe;
  unsubscribeAll: typeof unsubscribeAll;
  ensureSubscribed: typeof ensureSubscribed;
  getSubscription: typeof getSubscription;
  isSubscribed: typeof isSubscribed;
  setDebug: typeof setDebug;
  setDebugAlerts: typeof setDebugAlerts;
};

const api: IcWebPushPublicAPI = {
  init,
  registerServiceWorker,
  requestPermission,
  getPermissionStatus,
  // Relayers
  listRelayers,
  chooseRandomRelayer,
  getVapidPublicKey,
  // Subs
  subscribe,
  unsubscribe,
  unsubscribeAll,
  ensureSubscribed,
  getSubscription,
  isSubscribed,
  setDebug,
  setDebugAlerts,
};

export default api;
