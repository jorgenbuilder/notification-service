import { Actor, HttpAgent } from '@dfinity/agent';
import { Ed25519KeyIdentity } from '@dfinity/identity';
import { buildPushPayload } from '@block65/webcrypto-web-push';

const idlFactory = ({ IDL }: { IDL: typeof import('@dfinity/candid').IDL }) => {
  const Text = IDL.Text;
  const Nat = IDL.Nat;
  const Subscription = IDL.Record({
    endpoint: Text,
    expirationTime: IDL.Opt(Nat),
    keys: IDL.Record({ p256dh: Text, auth: Text }),
  });
  const Vapid = IDL.Record({ subject: Text, publicKey: Text, privateKey: Text });
  const NotificationBody = IDL.Record({ title: Text, content: Text, url: IDL.Opt(Text) });
  const Notification = IDL.Record({
    subscription: Subscription,
    vapid: Vapid,
    body: NotificationBody,
  });

  return IDL.Service({
    isQueueEmpty: IDL.Func([], [IDL.Bool], ['query']),
    collect: IDL.Func([], [IDL.Vec(Notification)], []),
  });
};

export interface Env {
  IC_HOST: string; // e.g., http://127.0.0.1:4943 or https://icp-api.io (or boundary)
  NOTIFICATION_CANISTER_ID: string;
  WORKER_ED25519_SECRET_KEY: string; // base64 of 64-byte secret key (seed+public) or 32-byte seed; we will try to handle both
}

// ---------- Logging helpers ----------
const PREFIX = '[notification-collector]';
const ts = () => new Date().toISOString();
const log = (...args: any[]) => console.log(ts(), PREFIX, ...args);
const warn = (...args: any[]) => console.warn(ts(), PREFIX, ...args);
const err = (...args: any[]) => console.error(ts(), PREFIX, ...args);
const redact = (value: string | undefined | null, keep: number = 6) =>
  value ? `${value.slice(0, keep)}...` : String(value);

function identityFromBase64Secret(b64: string): Ed25519KeyIdentity {
  const raw = Uint8Array.from(atob(b64.replace(/\s+/g, '')), c => c.charCodeAt(0));
  if (raw.length === 64) {
    return Ed25519KeyIdentity.fromSecretKey(raw.buffer);
  }
  if (raw.length === 32) {
    return Ed25519KeyIdentity.fromSecretKey(raw.buffer);
  }
  throw new Error('WORKER_ED25519_SECRET_KEY must be base64 of 32 or 64 bytes');
}

async function sendWebPushBatch(notifications: any[], env: Env, ctx: ExecutionContext) {
  log('Preparing to send web-push batch:', notifications.length);
  const tasks = notifications.map(async (n, i) => {
    const endpoint = n.subscription?.endpoint || '';
    log('Sending notification', i + 1, 'to', redact(endpoint, 16));

    const subscription = {
      endpoint,
      expirationTime: n.subscription.expirationTime ?? null,
      keys: {
        p256dh: n.subscription.keys.p256dh,
        auth: n.subscription.keys.auth,
      },
    } as const;

    const url: string | null = Array.isArray(n?.body?.url) ? n.body.url[0] : null;
    const message = {
      data: {
        title: n.body?.title,
        body: n.body?.content,
        url,
      },
      options: {
        ttl: 60 * 60, // 1 hour
        urgency: 'normal' as const,
      },
    };

    const vapid = {
      subject: n.vapid.subject,
      publicKey: n.vapid.publicKey,
      privateKey: n.vapid.privateKey,
    } as const;

    const payload = await buildPushPayload(message as any, subscription as any, vapid as any);
    const resp = await fetch(subscription.endpoint, payload as RequestInit);

    // Treat non-2xx as failure
    if (!(resp.status === 201 || resp.status === 204)) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Push failed: status ${resp.status} ${resp.statusText} ${text ? '- ' + text : ''}`);
    }
    return true;
  });

  const results = await Promise.allSettled(tasks);
  let ok = 0, fail = 0;
  const errors: any[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') ok++; else {
      fail++;
      errors.push({ index: i, reason: String(r.reason) });
    }
  });
  log('WebPush results:', { ok, fail });
  if (fail > 0) {
    warn('Some pushes failed. Sample error:', errors[0]);
  }
}

async function runCycle(env: Env) {
  log('runCycle() start', {
    IC_HOST: env.IC_HOST,
    NOTIFICATION_CANISTER_ID: redact(env.NOTIFICATION_CANISTER_ID, 8),
    WORKER_ED25519_SECRET_KEY: env.WORKER_ED25519_SECRET_KEY ? '[set]' : '[missing]'
  });
  try {
    if (!env.IC_HOST) {
      warn('IC_HOST is not set. The agent cannot connect.');
      return;
    }
    if (!env.NOTIFICATION_CANISTER_ID) {
      warn('NOTIFICATION_CANISTER_ID is not set. Skipping cycle.');
      return;
    }

    log('Creating identity from secret key...');
    const identity = identityFromBase64Secret(env.WORKER_ED25519_SECRET_KEY);
    log('Creating HttpAgent for host', env.IC_HOST);
    const agent = new HttpAgent({ host: env.IC_HOST, identity, fetch: (globalThis as any).fetch?.bind(globalThis) });

    if (env.IC_HOST.startsWith('http://127.0.0.1') || env.IC_HOST.startsWith('http://localhost')) {
      log('Local IC host detected. Fetching root key...');
      await agent.fetchRootKey().then(() => log('Root key fetched successfully.'))
        .catch((e) => warn('Using local replica without valid root key.', String(e)));
    }

    log('Creating actor for canister', redact(env.NOTIFICATION_CANISTER_ID, 8));
    const actor = Actor.createActor(idlFactory as any, {
      agent,
      canisterId: env.NOTIFICATION_CANISTER_ID,
    }) as unknown as {
      isQueueEmpty: () => Promise<boolean>;
      collect: () => Promise<any[]>;
    };

    const INTERVAL_MS = 10_000; // target ~every 10s
    const MAX_ITERATIONS = 6;   // up to 6 times per minute
    const MAX_WINDOW_MS = 53_000; // leave a little headroom

    const started = Date.now();
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const loopStart = Date.now();
      log(`sub-iteration ${i + 1}/${MAX_ITERATIONS} start`);
      try {
        log('Checking if queue is empty...');
        const empty = await actor.isQueueEmpty();
        if (!empty) {
          log('Collecting notifications...');
          const batch = await actor.collect();
          log('Collected batch size:', batch.length);
          if (batch.length === 0) {
            log('Batch is empty after collect.');
          } else {
            await sendWebPushBatch(batch, env as Env, (null as any));
            log('Batch processing complete.');
          }
        }
      } catch (e: any) {
        err('sub-iteration error:', e?.stack || String(e));
      }
      const elapsed = Date.now() - loopStart;
      const totalElapsed = Date.now() - started;
      if (totalElapsed >= MAX_WINDOW_MS) {
        log('Reached time window limit for this runCycle invocation. Stopping.');
        break;
      }
      if (i < MAX_ITERATIONS - 1) {
        const sleepMs = INTERVAL_MS - elapsed;
        if (sleepMs > 0) {
          log(`Sleeping ~${sleepMs}ms before next sub-iteration`);
          await new Promise((r) => setTimeout(r, sleepMs));
        }
      }
    }
  } catch (e: any) {
    err('runCycle() error:', e?.stack || String(e));
  } finally {
    log('runCycle() end');
  }
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    log('scheduled event received at', ts());
    try {
      ctx.waitUntil(runCycle(env));
    } catch (e: any) {
      err('scheduled handler error:', e?.stack || String(e));
    }
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    log('fetch event', { method: request.method, path: url.pathname });
    try {
      if (url.pathname === '/run') {
        log('Triggering runCycle via /run endpoint');
        ctx.waitUntil(runCycle(env));
        return new Response('ok');
      }
      if (url.pathname === '/health') {
        return new Response('ok');
      }
      return new Response('notification-collector worker');
    } catch (e: any) {
      err('fetch handler error:', e?.stack || String(e));
      return new Response('error', { status: 500 });
    }
  },
};
