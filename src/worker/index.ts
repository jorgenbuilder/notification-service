import 'dotenv/config';
import { Actor, HttpAgent } from '@dfinity/agent';
import { Ed25519KeyIdentity } from '@dfinity/identity';
import { Principal } from '@dfinity/principal';
import { EncryptedNotification, sendEncrypted } from './web-push-helper';

export interface Env {
  IC_HOST: string;
  NOTIFICATION_CANISTER_ID: string;
  VAPID_SUBJECT: string;
  VAPID_PUBLIC_KEY: string;
  WORKER_ED25519_SECRET_KEY: string;
  VAPID_PRIVATE_KEY: string;
}

type CanNotification = {
  endpoint: string;
  contentEncoding: { aesgcm?: null; aes128gcm?: null };
  encrypted: [{
    localPublicKey: Uint8Array | number[];
    salt: Uint8Array | number[];
    cipherText: Uint8Array | number[]
  }] | [];
  context: [Principal, Principal];
}

const idlFactory = ({ IDL }: { IDL: typeof import('@dfinity/candid').IDL }) => {
  const Notification = IDL.Record({
    endpoint: IDL.Text,
    contentEncoding: IDL.Variant({ aesgcm: IDL.Null, aes128gcm: IDL.Null }),
    encrypted: IDL.Opt(IDL.Record({
      localPublicKey: IDL.Vec(IDL.Nat8),
      salt: IDL.Vec(IDL.Nat8),
      cipherText: IDL.Vec(IDL.Nat8),
    })),
    context: IDL.Tuple(IDL.Principal, IDL.Principal),
  });
  const PeekPage = IDL.Record({
    items: IDL.Vec(Notification),
    drained: IDL.Bool,
  });
  return IDL.Service({
    peekQueue: IDL.Func([IDL.Nat64], [PeekPage], ['query']),
    popQueue: IDL.Func([IDL.Nat64], [], []),
    reportBrokenSubscriptions: IDL.Func(
      [IDL.Vec(IDL.Tuple(IDL.Principal, IDL.Principal, IDL.Text))],
      [],
      [],
    ),
  });
};

const PREFIX = '[notification-collector/node]';
const ts = () => new Date().toISOString();
const log = (...args: any[]) => console.log(ts(), PREFIX, ...args);
const warn = (...args: any[]) => console.warn(ts(), PREFIX, ...args);
const err = (...args: any[]) => console.error(ts(), PREFIX, ...args);

function identityFromBase64Secret(b64: string): Ed25519KeyIdentity {
  const raw = Uint8Array.from(Buffer.from(String(b64).replace(/\s+/g, ''), 'base64'));
  return Ed25519KeyIdentity.fromSecretKey(raw);
}

function toBuffer(v: Uint8Array | number[] | Buffer): Buffer {
  if (Buffer.isBuffer(v)) return v;
  return Buffer.from(v as any);
}

function toBase64Url(v: Uint8Array | number[] | Buffer): string {
  return toBuffer(v).toString('base64url');
}

async function sendWebPushBatch(actor: any, notifications: CanNotification[], env: Env) {
  log('Preparing to send web-push batch:', notifications.length);
  const tasks = notifications.map(async (n, i) => {
    let result;
    try {
      const ce = ('aes128gcm' in n.contentEncoding) ? 'aes128gcm' : 'aesgcm';
      let transformedNotification: EncryptedNotification = {
        endpoint: n.endpoint,
        contentEncoding: ce,
      };
      if (n.encrypted[0]) {
        const enc = n.encrypted[0]!;
        // For aes128gcm, http_ece body format is: salt (16) || rs (4, BE) || keyid_len (1=65) || dh (65) || ciphertext
        const rs = Buffer.alloc(4);
        rs.writeUInt32BE(4096, 0);
        const keyIdLen = Buffer.from([65]);
        transformedNotification.encrypted = {
          localPublicKey: toBuffer(enc.localPublicKey),
          salt: toBase64Url(enc.salt),
          cipherText: ce === 'aes128gcm'
            ? Buffer.concat([toBuffer(enc.salt), rs, keyIdLen, toBuffer(enc.localPublicKey), toBuffer(enc.cipherText)])
            : toBuffer(enc.cipherText),
        }
      }
      result = await sendEncrypted(
        transformedNotification,
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
    } catch (err) {
      throw new Error(String(err) + ". Response body: " + (err as any).body);
    }
    const status = result.statusCode ?? 0;
    if (!(status >= 200 && status < 300)) {
      const text = result.body || '';
      throw new Error(`Push failed: status ${status} ${text ? '- ' + text : ''}`);
    }
    return true;
  });

  const results = await Promise.allSettled(tasks);
  let ok = 0, fail = 0;
  const errors: any[] = [];
  let brokenSubscriptions: number[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') ok++; else {
      fail++;
      errors.push({ index: i, reason: String(r.reason) });
      if (String(r.reason).includes('push subscription has unsubscribed or expired')) {
        brokenSubscriptions.push(i);
      }
    }
  });
  log('WebPush results:', { ok, fail });
  if (brokenSubscriptions.length > 0) {
    log(`Reporting ${brokenSubscriptions.length} broken subscriptions...`);
    try {
      await actor.reportBrokenSubscriptions(brokenSubscriptions.map(index => {
        return [notifications[index].context[0], notifications[index].context[1], notifications[index].endpoint];
      }));
    } catch (err) {
      console.error(err);
      // pass
    }
  }
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
      peekQueue: (offset: bigint) => Promise<{ items: CanNotification[]; drained: boolean }>;
      popQueue: (amount: bigint) => Promise<void>;
    };
    try {
      log('Checking if queue is empty...');
      const page = await actor.peekQueue(0n);
      const batch = page.items;
      const isDrained = page.drained;
      if (batch.length > 0) {
        await sendWebPushBatch(actor, batch, env);
        log('Reporting sent notifications...');
        await actor.popQueue(BigInt(batch.length));
      }
    } catch (e: any) {
      err('sub-iteration error:', e?.stack || String(e));
    }
  } catch (e: any) {
    err('runCycle() error:', e?.stack || String(e));
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