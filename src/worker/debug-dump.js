// src/worker/debug-dump.js
require('dotenv/config');
const { Actor, HttpAgent } = require('@dfinity/agent');
const { Ed25519KeyIdentity } = require('@dfinity/identity');
const { Principal } = require('@dfinity/principal');

function identityFromBase64Secret(b64) {
    const raw = Uint8Array.from(Buffer.from(String(b64).replace(/\s+/g, ''), 'base64'));
    return Ed25519KeyIdentity.fromSecretKey(raw);
}

// Minimal IDL matching your index.ts
const idlFactory = ({ IDL }) => {
    const Text = IDL.Text; const Nat = IDL.Nat;
    const Subscription = IDL.Record({ endpoint: Text, expirationTime: IDL.Opt(Nat), keys: IDL.Record({ p256dh: Text, auth: Text }) });
    const NotificationBody = IDL.Record({ title: Text, content: Text, url: IDL.Opt(Text), tag: IDL.Opt(Text) });
    const Notification = IDL.Record({ context: IDL.Tuple(IDL.Principal, IDL.Principal), subscription: Subscription, body: NotificationBody });
    const DebugEncryptedItem = IDL.Record({
        endpoint: Text,
        salt: IDL.Vec(IDL.Nat8),
        localPublicKey: IDL.Vec(IDL.Nat8),
        ephemeralPrivateKey: IDL.Vec(IDL.Nat8),
        context: IDL.Vec(IDL.Nat8),
        cek: IDL.Vec(IDL.Nat8),
        nonce: IDL.Vec(IDL.Nat8),
        plaintextHead: IDL.Vec(IDL.Nat8),
        cipherText: IDL.Vec(IDL.Nat8),
        prkAuth: IDL.Vec(IDL.Nat8),
        prk: IDL.Vec(IDL.Nat8),
    });
    return IDL.Service({
        peekQueue: IDL.Func([], [IDL.Vec(Notification)], ['query']),
        peekQueueEncryptedDebug: IDL.Func([], [IDL.Vec(DebugEncryptedItem)], ['query']),
    });
};

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function toBuf(v) { return Buffer.isBuffer(v) ? v : Buffer.from(v); }

(async () => {
    const env = {
        IC_HOST: process.env.IC_HOST || '',
        NOTIFICATION_CANISTER_ID: process.env.NOTIFICATION_CANISTER_ID || '',
        WORKER_ED25519_SECRET_KEY: process.env.WORKER_ED25519_SECRET_KEY || '',
    };
    if (!env.IC_HOST || !env.NOTIFICATION_CANISTER_ID || !env.WORKER_ED25519_SECRET_KEY) {
        console.error('Missing env: IC_HOST / NOTIFICATION_CANISTER_ID / WORKER_ED25519_SECRET_KEY');
        process.exit(2);
    }

    const identity = identityFromBase64Secret(env.WORKER_ED25519_SECRET_KEY);
    const agent = new HttpAgent({ host: env.IC_HOST, identity, fetch: (globalThis).fetch?.bind(globalThis) });
    if (env.IC_HOST.startsWith('http://127.0.0.1') || env.IC_HOST.startsWith('http://localhost')) {
        try { await agent.fetchRootKey(); } catch {}
    }
    const actor = Actor.createActor(idlFactory, { agent, canisterId: env.NOTIFICATION_CANISTER_ID });

    const [items, dbg] = await Promise.all([
        actor.peekQueue(),
        actor.peekQueueEncryptedDebug(),
    ]);

    if (!items || items.length === 0) {
        console.log(JSON.stringify({ error: 'queue_empty' }, null, 2));
        process.exit(0);
    }
    const n = items[0];
    const d = (dbg && dbg[0]) || null;
    if (!d) {
        console.log(JSON.stringify({ error: 'debug_empty' }, null, 2));
        process.exit(0);
    }

    const payloadObj = { title: n.body.title, body: n.body.content };
    if (n.body.url && n.body.url.length > 0) payloadObj.url = n.body.url[0];
    if (n.body.tag && n.body.tag.length > 0) payloadObj.tag = n.body.tag[0];
    const payloadJson = JSON.stringify(payloadObj);

    const out = {
        endpoint: n.subscription.endpoint,
        subscription: {
            p256dh: n.subscription.keys.p256dh,
            auth: n.subscription.keys.auth,
        },
        payloadJson,
        debug: {
            salt_b64u: b64u(toBuf(d.salt)),
            ephPriv_b64u: b64u(toBuf(d.ephemeralPrivateKey)),
            ephPub_b64u: b64u(toBuf(d.localPublicKey)),
            context_b64u: b64u(toBuf(d.context)),
            cek_b64u: b64u(toBuf(d.cek)),
            nonce_b64u: b64u(toBuf(d.nonce)),
            prkAuth_b64u: b64u(toBuf(d.prkAuth || [])),
            prk_b64u: b64u(toBuf(d.prk || [])),
            plaintextHead_b64u: b64u(toBuf(d.plaintextHead || [])),
            cipherText_b64u: b64u(toBuf(d.cipherText)),
            cipher_head16_b64u: b64u(toBuf(d.cipherText).subarray(0,16)),
        },
    };



    console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error(e); process.exit(1); });