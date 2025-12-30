import 'dotenv/config';
import { Actor, HttpAgent } from '@dfinity/agent';
import { Ed25519KeyIdentity } from '@dfinity/identity';
import { sendNotification } from 'web-push';

export interface Env {
  IC_HOST: string;
  NOTIFICATION_CANISTER_ID: string;
  VAPID_SUBJECT: string;
  VAPID_PUBLIC_KEY: string;
  WORKER_ED25519_SECRET_KEY: string;
  VAPID_PRIVATE_KEY: string;
}

type CanNotification = {
  subscription: {
    endpoint: string;
    expirationTime: [number] | [];
    keys: {
      p256dh: string;
      auth: string;
    };
  };
  body: {
    title: string;
    content: string;
    url: [string] | [];
  }
}

const idlFactory = ({ IDL }: { IDL: typeof import('@dfinity/candid').IDL }) => {
  const Text = IDL.Text;
  const Nat = IDL.Nat;
  const Subscription = IDL.Record({
    endpoint: Text,
    expirationTime: IDL.Opt(Nat),
    keys: IDL.Record({ p256dh: Text, auth: Text }),
  });
  const NotificationBody = IDL.Record({ title: Text, content: Text, url: IDL.Opt(Text) });
  const Notification = IDL.Record({
    subscription: Subscription,
    body: NotificationBody,
  });
  return IDL.Service({
    isQueueEmpty: IDL.Func([], [IDL.Bool], ['query']),
    collect: IDL.Func([], [IDL.Vec(Notification)], []),
  });
};

const PREFIX = '[notification-collector/node]';
const ts = () => new Date().toISOString();
const log = (...args: any[]) => console.log(ts(), PREFIX, ...args);
const warn = (...args: any[]) => console.warn(ts(), PREFIX, ...args);
const err = (...args: any[]) => console.error(ts(), PREFIX, ...args);
const redact = (value: string | undefined | null, keep: number = 6) =>
  value ? `${value.slice(0, keep)}...` : String(value);

function identityFromBase64Secret(b64: string): Ed25519KeyIdentity {
  const raw = Uint8Array.from(Buffer.from(String(b64).replace(/\s+/g, ''), 'base64'));
  return Ed25519KeyIdentity.fromSecretKey(raw);
}

async function sendWebPushBatch(notifications: CanNotification[], env: Env) {
  log('Preparing to send web-push batch:', notifications.length);
  const tasks = notifications.map(async (n, i) => {
    const endpoint = n.subscription.endpoint;
    log('Sending notification', i + 1, 'to', redact(endpoint, 16));

    const result = await sendNotification(
      {
        endpoint,
        expirationTime: n.subscription.expirationTime.length ? n.subscription.expirationTime[0] : null,
        keys: {
          p256dh: n.subscription.keys.p256dh,
          auth: n.subscription.keys.auth,
        },
      },
      JSON.stringify({
        title: n.body.title,
        body: n.body.content,
        url: n.body.url.length ? n.body.url[0] : undefined
      }),
      {
        TTL: 60 * 60, // 1 hour
        vapidDetails: {
          subject: env.VAPID_SUBJECT,
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
        },
        headers: {
          Urgency: 'normal',
        },
      }
    );
    const status = result.statusCode ?? 0;
    if (!(status >= 200 && status < 300)) {
      const text = (result.body && typeof result.body === 'string') ? result.body : '';
      throw new Error(`Push failed: status ${status} ${text ? '- ' + text : ''}`);
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
  if (fail > 0) warn('Some pushes failed. Sample error:', errors[0]);
}

async function runCycle(env: Env) {
  try {
    if (!env.IC_HOST) {
      warn('IC_HOST is not set. The agent cannot connect.');
      return;
    }
    if (!env.NOTIFICATION_CANISTER_ID) {
      warn('NOTIFICATION_CANISTER_ID is not set. Skipping cycle.');
      return;
    }
    log('runCycle() start. Creating identity...');
    const identity = identityFromBase64Secret(env.WORKER_ED25519_SECRET_KEY);
    const agent = new HttpAgent({ host: env.IC_HOST, identity, fetch: (globalThis as any).fetch?.bind(globalThis) });

    if (env.IC_HOST.startsWith('http://127.0.0.1') || env.IC_HOST.startsWith('http://localhost')) {
      log('Local IC host detected. Fetching root key...');
      await agent.fetchRootKey().then(() => log('Root key fetched successfully.'))
        .catch((e) => warn('Using local replica without valid root key.', String(e)));
    }
    const actor = Actor.createActor(idlFactory as any, {
      agent,
      canisterId: env.NOTIFICATION_CANISTER_ID,
    }) as unknown as {
      isQueueEmpty: () => Promise<boolean>;
      collect: () => Promise<any[]>;
    };
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
          await sendWebPushBatch(batch, env);
          log('Batch processing complete.');
        }
      }
    } catch (e: any) {
      err('sub-iteration error:', e?.stack || String(e));
    }
  } catch (e: any) {
    err('runCycle() error:', e?.stack || String(e));
  } finally {
    log('runCycle() end');
  }
}

function loadEnv(): Env {
  return {
    IC_HOST: process.env.IC_HOST || '',
    NOTIFICATION_CANISTER_ID: process.env.NOTIFICATION_CANISTER_ID || '',
    VAPID_SUBJECT: process.env.VAPID_SUBJECT || '',
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
    WORKER_ED25519_SECRET_KEY: process.env.WORKER_ED25519_SECRET_KEY || '',
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
  };
}

function startScheduler(env: Env) {
  const CRON_MS = 10_000; // target cadence: every 10 seconds
  log('Starting scheduler: serialized runs with target cadence', CRON_MS / 1000, 'seconds');

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const scheduleNext = (delayMs: number) => {
    if (stopped) return;
    log('Scheduling next run in', Math.max(0, Math.round(delayMs)), 'ms');
    timer = setTimeout(tick, Math.max(0, delayMs));
  };

  const tick = async () => {
    const start = Date.now();
    try {
      await runCycle(env);
    } catch (e) {
      err('scheduled run error', e);
    } finally {
      const elapsed = Date.now() - start;
      const delay = Math.max(0, CRON_MS - elapsed);
      scheduleNext(delay);
    }
  };
  tick();
  const shutdown = (signal: string) => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    log(`Received ${signal}. Scheduler stopped.`);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const env = loadEnv();
if (process.argv.includes('--once')) {
  runCycle(env).then();
} else {
  startScheduler(env);
}