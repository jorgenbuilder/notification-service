const crypto = require('crypto');

// Paste your JSON (the object printed by debug-dump.js) into the const below:
const J = {
    endpoint: "https://web.push.apple.com/…",
    subscription: {
        p256dh: "BJBpF2ssgyEaU7zfapVZmn7H-BUCC32yLPJV4gLoFjJR-rzRCZxzAO6N4Ei110U5hE26GmnkJNJJaTpoF6UsXA8",
        auth: "5WVxsMZFFTSbQK76MvkRrw"
    },
    payloadJson: `{"body":"AAA","title":"User 1 in room D7ZYPJ","url":"/D7ZYPJ","tag":"D7ZYPJ"}`,
    debug: {
        salt_b64u: "LBy_XqaBiyOBVObq0i-9mA",
        ephPriv_b64u: "Y3Dco7Dh1l7LhGphnrv8REC0IfAXnxDtdVijVPNtV4w",
        ephPub_b64u: "BK-Ur4i9QXU08zXl5OCsMnaFPnFtpv8vJXR3z2nOFa0UBkAXk1KTWUMnW8QU3PRHs0LQOC-796HbT87Vnf5mOaU",
        context_b64u: "V2ViUHVzaDogaW5mbwAAQQSQaRdrLIMhGlO832qVWZp-x_gVAgt9sizyVeIC6BYyUfq80QmccwDujeBItddFOYRNuhpp5CTSSWk6aBelLFwPAEEEr5SviL1BdTTzNeXk4KwydoU-cW2m_y8ldHfPac4VrRQGQBeTUpNZQydbxBTc9EezQtA4L7v3odtPztWd_mY5pQ",
        cek_b64u: "M1TX-X3ngHXUmr8cP0AA1w",
        nonce_b64u: "JKmEpTVz2oGxW293",
        cipherText_b64u: "vqIoX-d4JNwpM5VsI-ungFRoyYHVHdbhY4x6BQRWGf4ZLEFizcMSsjcDvBosAQykFTl6Oli3OS2AVOiqWqvzuKPDUJN9UNJArjyXd5zjnoEVSe-sqlygo9DU-p70bA",
        cipher_head16_b64u: "vqIoX-d4JNwpM5VsI-ungA"
    }
};

function b64uToBuf(s){ return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'), 'base64'); }

const cek = b64uToBuf(J.debug.cek_b64u); // 16 bytes
const nonce = b64uToBuf(J.debug.nonce_b64u); // 12 bytes
const payload = Buffer.from(J.payloadJson, 'utf8');

const test = (plaintext, prefix) => {
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const sealed = Buffer.concat([ciphertext, tag]);

    console.log(prefix + '[REPRO_CEK] sealed.len=', sealed.length);
    console.log(prefix + '[REPRO_CEK] head16b64=', sealed.subarray(0,16).toString('base64url'));
    console.log(prefix + '[REPRO_CEK] matches_canister_head16=', sealed.subarray(0,16).toString('base64url') === J.debug.cipher_head16_b64u);
};

test(Buffer.concat([payload, Buffer.from([0x02])]), '[VARIANT 0]');
test(Buffer.from(J.payloadJson, 'utf8'), '[VARIANT A]');
test(Buffer.concat([Buffer.from([0x00, 0x00]), Buffer.from(J.payloadJson, 'utf8')]), '[VARIANT B]');
test(Buffer.concat([Buffer.from(J.payloadJson, 'utf8'), Buffer.from([0x00])]), '[VARIANT C]');

console.log('Canister head16: ' + J.debug.cipher_head16_b64u);