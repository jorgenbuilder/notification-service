// src/worker/compare_cipher_heads.js
require('dotenv/config');
const { Actor, HttpAgent } = require('@dfinity/agent');
const { Ed25519KeyIdentity } = require('@dfinity/identity');
const crypto = require('crypto');

function identityFromBase64Secret(b64) {
  const raw = Uint8Array.from(Buffer.from(String(b64).replace(/\s+/g, ''), 'base64'));
  return Ed25519KeyIdentity.fromSecretKey(raw);
}

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
    prkAuth: IDL.Vec(IDL.Nat8),
    prk: IDL.Vec(IDL.Nat8),
    cek: IDL.Vec(IDL.Nat8),
    nonce: IDL.Vec(IDL.Nat8),
    plaintextHead: IDL.Vec(IDL.Nat8),
    cipherText: IDL.Vec(IDL.Nat8),
  });
  return IDL.Service({
    peekQueue: IDL.Func([], [IDL.Vec(Notification)], ['query']),
    peekQueueEncryptedDebug: IDL.Func([], [IDL.Vec(DebugEncryptedItem)], ['query']),
  });
};

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function toBuf(v) { return Buffer.isBuffer(v) ? v : Buffer.from(v); }
function b64uToBuf(s) { return Buffer.from(String(s).replace(/-/g,'+').replace(/_/g,'/'), 'base64'); }

function hkdfExtract(ikm, salt) {
  // HKDF-Extract: PRK = HMAC(salt, ikm)
  return crypto.createHmac('sha256', salt).update(ikm).digest();
}
function hkdfExpand(prk, info, len) {
  // HKDF-Expand (single block): T(1) = HMAC(PRK, info || 0x01)
  const t1 = crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();
  return t1.subarray(0, len);
}

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
  if (!items || items.length === 0 || !dbg || dbg.length === 0) {
    console.log('[COMPARE] queue or debug empty');
    process.exit(0);
  }
  const n = items[0];
  const d = dbg[0];

  // Build payload JSON body-first to mirror canister serialization
  const payloadObj = { body: n.body.content, title: n.body.title };
  if (n.body.url && n.body.url.length > 0) payloadObj.url = n.body.url[0];
  if (n.body.tag && n.body.tag.length > 0) payloadObj.tag = n.body.tag[0];
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8');

  const clientP256dh = n.subscription.keys.p256dh; // base64url string (uncompressed 65B)
  const clientPub = b64uToBuf(clientP256dh);
  const authSecret = b64uToBuf(n.subscription.keys.auth);
  const salt = toBuf(d.salt);
  const ephPriv = toBuf(d.ephemeralPrivateKey);
  const ephPub = toBuf(d.localPublicKey);
  const can_cipher = toBuf(d.cipherText);
  const can_prkAuth = toBuf(d.prkAuth || []);
  const can_prk = toBuf(d.prk || []);
  const can_cek = toBuf(d.cek);
  const can_nonce = toBuf(d.nonce);
  const context = toBuf(d.context);

  // Derive ECDH shared secret using Node ECDH
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(ephPriv);
  const derivedPub = ecdh.getPublicKey(undefined, 'uncompressed');
  console.log('[ECDH] serverPub matches=', derivedPub.equals(ephPub));
  const shared = ecdh.computeSecret(clientPub); // 32 bytes

  // Compute PRKs in Node
  const node_prkAuth = hkdfExtract(shared, authSecret);
  const node_prk = hkdfExtract(node_prkAuth, salt);
  console.log('[PRK] prkAuth_equal=', b64u(node_prkAuth) === b64u(can_prkAuth), ' prk_equal=', b64u(node_prk) === b64u(can_prk));
  console.log('[PRK] prkAuth.head8=', b64u(node_prkAuth.subarray(0,8)), ' can.head8=', b64u(can_prkAuth.subarray(0,8)));
  console.log('[PRK] prk.head8   =', b64u(node_prk.subarray(0,8)), ' can.head8=', b64u(can_prk.subarray(0,8)));

  // Build info blocks and derive CEK/NONCE
  const keyInfo = Buffer.concat([Buffer.from('Content-Encoding: aes128gcm', 'utf8'), Buffer.from([0x00]), context]);
  const nonceInfo = Buffer.concat([Buffer.from('Content-Encoding: nonce', 'utf8'), Buffer.from([0x00]), context]);
  const infoAuth = Buffer.concat([Buffer.from('Content-Encoding: auth', 'utf8'), Buffer.from([0x00]), context]);
  const node_cek = hkdfExpand(node_prk, keyInfo, 16);
  const node_nonce = hkdfExpand(node_prk, nonceInfo, 12);
  console.log('[KEYS] cek_equal=', b64u(node_cek) === b64u(can_cek), ' nonce_equal=', b64u(node_nonce) === b64u(can_nonce));
  console.log('[KEYS] cek.head8=', b64u(node_cek.subarray(0,8)), ' can.head8=', b64u(can_cek.subarray(0,8)));
  console.log('[KEYS] nonce.head8=', b64u(node_nonce.subarray(0,8)), ' can.head8=', b64u(can_nonce.subarray(0,8)));
  console.log('[INFO_AUTH]', b64u(infoAuth));
  console.log('[INFO_KEY ]', b64u(keyInfo));
  console.log('[INFO_NONC]', b64u(nonceInfo));

  // Also test server-first context hypothesis
  function buildContextSF(clientPub, serverPub) {
    const header = Buffer.concat([Buffer.from('WebPush: info','utf8'), Buffer.from([0x00])]);
    const len = (n)=> Buffer.from([ (n>>>8)&0xff, n&0xff ]);
    return Buffer.concat([header, len(serverPub.length), serverPub, len(clientPub.length), clientPub]);
  }
  const context_sf = buildContextSF(clientPub, ephPub);
  const keyInfoSF = Buffer.concat([Buffer.from('Content-Encoding: aes128gcm','utf8'), Buffer.from([0x00]), context_sf]);
  const nonceInfoSF = Buffer.concat([Buffer.from('Content-Encoding: nonce','utf8'), Buffer.from([0x00]), context_sf]);
  const node_cek_sf = hkdfExpand(node_prk, keyInfoSF, 16);
  const node_nonce_sf = hkdfExpand(node_prk, nonceInfoSF, 12);
  const cipherSF = crypto.createCipheriv('aes-128-gcm', node_cek_sf, node_nonce_sf);
  const ctSF = Buffer.concat([cipherSF.update(Buffer.concat([payload, Buffer.from([0x02])])), cipherSF.final()]);
  const tagSF = cipherSF.getAuthTag();
  const sealedSF = Buffer.concat([ctSF, tagSF]);
  console.log('[ALT] server-first AES head16=', b64u(sealedSF.subarray(0,16)));

  // Encrypt payload||0x02 and compare ciphertext head to canister
  const plaintext = Buffer.concat([payload, Buffer.from([0x02])]);
  let cipher = crypto.createCipheriv('aes-128-gcm', node_cek, node_nonce);
  let ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  let tag = cipher.getAuthTag();
  let sealed = Buffer.concat([ct, tag]);
  console.log('[AES] rawCipher.head16=', b64u(sealed.subarray(0,16)), ' can.head16=', b64u(can_cipher.subarray(0,16)), ' equal=', b64u(sealed.subarray(0,16)) === b64u(can_cipher.subarray(0,16)));

  // Also compute AES with payload-only and compare to ECE raw expectation
  cipher = crypto.createCipheriv('aes-128-gcm', node_cek, node_nonce);
  ct = Buffer.concat([cipher.update(payload), cipher.final()]);
  tag = cipher.getAuthTag();
  sealed = Buffer.concat([ct, tag]);
  console.log('[AES payload-only] head16=', b64u(sealed.subarray(0,16)));

  // Test aes128gcm with leading zero pad then 0x02 (pad=0x00 || 0x02 || payload)
  const plaintextPad02 = Buffer.concat([Buffer.from([0x00, 0x02]), payload]);
  cipher = crypto.createCipheriv('aes-128-gcm', node_cek, node_nonce);
  ct = Buffer.concat([cipher.update(plaintextPad02), cipher.final()]);
  tag = cipher.getAuthTag();
  sealed = Buffer.concat([ct, tag]);
  console.log('[AES 00+02+payload] head16=', b64u(sealed.subarray(0,16)));

  // Build http_ece body and compare rawCipher head as well
  try {
    const ece = require('http_ece');
    const body = ece.encrypt(Buffer.from(JSON.stringify(payloadObj), 'utf8'), { // http_ece handles framing
      version: 'aes128gcm',
      dh: n.subscription.keys.p256dh,
      privateKey: ecdh,
      salt: b64u(salt),
      authSecret: Buffer.from(n.subscription.keys.auth, 'base64url'),
    });
    const saltB = body.subarray(0,16);
    const rsB = body.readUInt32BE(16);
    const keyIdLenB = body.readUInt8(20);
    const dhB = body.subarray(21, 21 + keyIdLenB);
    const raw = body.subarray(16 + 4 + 1 + keyIdLenB);
    console.log('[ECE] hdr dhMatches=', dhB.equals(ephPub), ' keyIdLen=', keyIdLenB, ' rs=', rsB);
    console.log('[ECE] raw.head16=', b64u(raw.subarray(0,16)), ' can.head16=', b64u(can_cipher.subarray(0,16)), ' equal=', b64u(raw.subarray(0,16)) === b64u(can_cipher.subarray(0,16)));
  } catch (e) {
    console.log('[ECE] skip (module missing):', e && e.message);
  }

  // Try alternate HKDF schedules and context encodings to match ECE raw head
  function schedA(prk_auth, salt, ctx) { // current canister
    const prk = hkdfExtract(prk_auth, salt);
    const cek = hkdfExpand(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0x00]), ctx]), 16);
    const nce = hkdfExpand(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.from([0x00]), ctx]), 12);
    return { cek, nce };
  }
  function schedB(prk_auth, salt, ctx) { // Expand(PRK_auth, ctx)->IKM, then Extract(salt, IKM), Expand(label || 0x00)
    const ikm = hkdfExpand(prk_auth, ctx, 32);
    const prk = hkdfExtract(ikm, salt);
    const cek = hkdfExpand(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0x00])]), 16);
    const nce = hkdfExpand(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.from([0x00])]), 12);
    return { cek, nce };
  }
  function schedC(prk_auth, salt, ctx) { // PRK = Extract(salt, HMAC(PRK_auth, ctx))
    const ikm = crypto.createHmac('sha256', prk_auth).update(ctx).digest();
    const prk = hkdfExtract(ikm, salt);
    const cek = hkdfExpand(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0x00]), ctx]), 16);
    const nce = hkdfExpand(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.from([0x00]), ctx]), 12);
    return { cek, nce };
  }
  function schedD(prk_auth, salt, ctx) { // Extract(salt, prk_auth), Expand(label || 0x00) no context
    const prk = hkdfExtract(prk_auth, salt);
    const cek = hkdfExpand(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0x00])]), 16);
    const nce = hkdfExpand(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.from([0x00])]), 12);
    return { cek, nce };
  }
  function schedE(prk_auth, salt, ctx) { // IKM = Expand(PRK_auth, "Content-Encoding: auth" || 0x00 || context)
    const infoAuth = Buffer.concat([Buffer.from('Content-Encoding: auth'), Buffer.from([0x00]), ctx]);
    const ikm = hkdfExpand(prk_auth, infoAuth, 32);
    const prk = hkdfExtract(ikm, salt);
    const cek = hkdfExpand(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0x00]), ctx]), 16);
    const nce = hkdfExpand(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.from([0x00]), ctx]), 12);
    return { cek, nce };
  }
  function schedF(prk_auth, salt, ctx) { // IKM = Expand(PRK_auth, context); PRK = Extract(salt, IKM); Expand with server-first compressed keys only
    return { cek: Buffer.alloc(16,0), nce: Buffer.alloc(12,0) }; // placeholder; handled below per-context
  }

  // Compressed SEC1 encodings for context variants
  function compressPub(uncompressed) {
    // uncompressed: 0x04 || X (32) || Y (32)
    const x = uncompressed.subarray(1, 33);
    const y = uncompressed.subarray(33, 65);
    const odd = (y[31] & 1) === 1;
    const prefix = Buffer.from([odd ? 0x03 : 0x02]);
    return Buffer.concat([prefix, x]);
  }
  function ctxClientFirst(pubClient, pubServer) {
    const header = Buffer.concat([Buffer.from('WebPush: info','utf8'), Buffer.from([0x00])]);
    const len = (n)=> Buffer.from([ (n>>>8)&0xff, n&0xff ]);
    return Buffer.concat([header, len(pubClient.length), pubClient, len(pubServer.length), pubServer]);
  }
  function ctxServerFirst(pubClient, pubServer) {
    const header = Buffer.concat([Buffer.from('WebPush: info','utf8'), Buffer.from([0x00])]);
    const len = (n)=> Buffer.from([ (n>>>8)&0xff, n&0xff ]);
    return Buffer.concat([header, len(pubServer.length), pubServer, len(pubClient.length), pubClient]);
  }

  const schedules = { A: schedA, B: schedB, C: schedC, D: schedD };
  const names = Object.keys(schedules);
  // Derive ECE raw head from previous step if available
  let eceRawHead = null;
  try {
    const ece = require('http_ece');
    const bodyForEce = ece.encrypt(Buffer.from(JSON.stringify(payloadObj), 'utf8'), {
      version: 'aes128gcm', dh: n.subscription.keys.p256dh, privateKey: ecdh, salt: b64u(salt), authSecret: n.subscription.keys.auth,
    });
    const raw = bodyForEce.subarray(16 + 4 + 1 + 65);
    eceRawHead = b64u(raw.subarray(0,16));
  } catch {}

  const ctxVariants = {
    CF_UC: ctxClientFirst(clientPub, ephPub),
    SF_UC: ctxServerFirst(clientPub, ephPub),
    CF_CMP: ctxClientFirst(compressPub(clientPub), compressPub(ephPub)),
    SF_CMP: ctxServerFirst(compressPub(clientPub), compressPub(ephPub)),
  };

  for (const ctxName of Object.keys(ctxVariants)) {
    const ctxV = ctxVariants[ctxName];
    for (const name of names) {
      const { cek, nce } = schedules[name](node_prkAuth, salt, ctxV);
      const c = crypto.createCipheriv('aes-128-gcm', cek, nce);
      const ct = Buffer.concat([c.update(Buffer.concat([payload, Buffer.from([0x02])])), c.final()]);
      const tag = c.getAuthTag();
      const sealed = Buffer.concat([ct, tag]);
      const head = b64u(sealed.subarray(0,16));
      const eq = eceRawHead ? (head === eceRawHead) : 'n/a';
      console.log(`[TRY ${name} ${ctxName}] head16=`, head, 'equals_ECE=', eq);
    }
  }
})();
