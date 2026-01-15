// src/worker/repro_http_ece.js
const ece = require('http_ece');
const crypto = require('crypto');

// Paste your latest debug-dump JSON values below
const J = {
    endpoint: "https://web.push.apple.com/…",
    subscription: {
        p256dh: "BJBpF2ssgyEaU7zfapVZmn7H-BUCC32yLPJV4gLoFjJR-rzRCZxzAO6N4Ei110U5hE26GmnkJNJJaTpoF6UsXA8",
        auth: "5WVxsMZFFTSbQK76MvkRrw"
    },
    // IMPORTANT: use body-first ordering to mirror canister’s plaintext
    payloadJson: "{\"body\":\"AAA\",\"title\":\"User 1 in room D7ZYPJ\",\"url\":\"/D7ZYPJ\",\"tag\":\"D7ZYPJ\"}",
    debug: {
        salt_b64u: "LBy_XqaBiyOBVObq0i-9mA",
        ephPriv_b64u: "Y3Dco7Dh1l7LhGphnrv8REC0IfAXnxDtdVijVPNtV4w",
        ephPub_b64u: "BK-Ur4i9QXU08zXl5OCsMnaFPnFtpv8vJXR3z2nOFa0UBkAXk1KTWUMnW8QU3PRHs0LQOC-796HbT87Vnf5mOaU",
        cipher_head16_b64u: "vqIoX-d4JNwpM5VsI-ungA"
    }
};

function b64uToBuf(s){ return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'), 'base64'); }

// Build an ECDH object for prime256v1 and set the ephemeral private key from canister debug
const ecdh = crypto.createECDH('prime256v1');
ecdh.setPrivateKey(b64uToBuf(J.debug.ephPriv_b64u));
// Sanity: ensure public key from private matches expected ephPub (uncompressed)
const pub = ecdh.getPublicKey(undefined, 'uncompressed');
const expectedPub = b64uToBuf(J.debug.ephPub_b64u);
if (!pub.equals(expectedPub)) {
    console.warn('[WARN] ECDH public key derived from ephPriv does not match expected ephPub — check inputs.');
    console.warn('derived=', pub.toString('base64url').slice(0,16), ' expected=', expectedPub.toString('base64url').slice(0,16));
}

const payload = Buffer.from(J.payloadJson, 'utf8');
const cipherText = ece.encrypt(payload, {
    version: 'aes128gcm',
    dh: J.subscription.p256dh,             // client p256dh (base64url string)
    privateKey: ecdh,                      // Node ECDH object
    salt: J.debug.salt_b64u,               // base64url string
    authSecret: J.subscription.auth,       // base64url string
});

console.log('[REPRO_ECE] len=', cipherText.length);
console.log('[REPRO_ECE] head16b64=', Buffer.from(cipherText).subarray(0,16).toString('base64url'));
console.log('[REPRO_ECE] equals_canister_head16=', Buffer.from(cipherText).subarray(0,16).toString('base64url') === J.debug.cipher_head16_b64u);