use candid::{Encode, Decode, Principal};
use pocket_ic::PocketIc;
use std::collections::HashMap;

fn wasm_path() -> std::path::PathBuf {
    // Allow overriding path via env for CI
    if let Ok(p) = std::env::var("NOTIF_CANISTER_WASM") {
        return std::path::PathBuf::from(p);
    }
    // Default to release artifact
    std::path::Path::new("../../target/wasm32-unknown-unknown/release/notification_canister.wasm").into()
}

fn load_wasm() -> Vec<u8> {
    let path = wasm_path();
    std::fs::read(&path).expect(&format!("WASM not found at {:?}. Build it first with: cargo build --release --target wasm32-unknown-unknown", path))
}

fn call_update(pic: &PocketIc, canister_id: Principal, caller: Principal, method: &str, args: Vec<u8>) -> Result<Vec<u8>, String> {
    pic.update_call(canister_id, caller, method, args)
        .map_err(|user_err| format!("Error: {:?}", user_err))
}

fn call_query(pic: &PocketIc, canister_id: Principal, caller: Principal, method: &str, args: Vec<u8>) -> Result<Vec<u8>, String> {
    pic.query_call(canister_id, caller, method, args)
        .map_err(|user_err| format!("Error: {:?}", user_err))
}

// -------- Test helpers to avoid repetition across tests --------
mod helpers {
    use super::*;
    use candid::CandidType;
    use serde::{Deserialize, Serialize};

    // Crypto imports to generate valid subscription keys and decrypt payloads in tests
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::Aes128Gcm;
    use aes_gcm::Nonce;
    use hkdf::Hkdf;
    use p256::{elliptic_curve::sec1::ToEncodedPoint, ecdh::diffie_hellman, PublicKey as P256PublicKey, SecretKey as P256SecretKey};
    use sha2::{Digest, Sha256};

    // Shared DTOs used by tests
    #[derive(CandidType, Serialize, Clone)]
    pub struct Keys { pub p256dh: String, pub auth: String }
    #[derive(CandidType, Serialize, Clone)]
    pub struct Subscription { pub endpoint: String, pub expirationTime: Option<u64>, pub keys: Keys }
    #[derive(CandidType, Serialize, Clone)]
    pub struct NotificationBody { pub title: String, pub content: String, pub url: Option<String>, pub tag: Option<String> }

    #[derive(CandidType, Deserialize, Debug, Clone)]
    pub struct EncryptedData { pub localPublicKey: Vec<u8>, pub salt: Vec<u8>, pub cipherText: Vec<u8> }
    #[derive(CandidType, Deserialize, Debug, PartialEq, Eq, Clone)]
    pub enum ContentEncoding { #[serde(rename="aesgcm")] AesGcm, #[serde(rename="aes128gcm")] Aes128Gcm }
    #[derive(CandidType, Deserialize, Debug, Clone)]
    pub struct EncryptedNotification { pub endpoint: String, pub contentEncoding: ContentEncoding, pub encrypted: Option<EncryptedData>, pub context: (Principal, Principal) }

    #[derive(CandidType, Deserialize, Debug, Clone)]
    pub struct PeekPage { pub items: Vec<EncryptedNotification>, pub drained: bool }

    pub fn principal(seed: u8) -> Principal { Principal::from_slice(&[seed; 29]) }

    // Deterministic test key material derived from endpoint string; ensures reproducibility without RNG
    fn derive_test_sk(endpoint: &str) -> P256SecretKey {
        // Derive 32 bytes from SHA256(endpoint) and try incremental tweaks until valid
        let base = Sha256::digest(endpoint.as_bytes());
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&base[..32]);
        // Ensure non-zero
        if bytes.iter().all(|&b| b == 0) { bytes[0] = 1; }
        let mut ctr: u32 = 0;
        loop {
            if let Ok(sk) = P256SecretKey::from_slice(&bytes) { return sk; }
            // tweak with counter
            let mut h = Sha256::new();
            h.update(&bytes);
            h.update(&ctr.to_be_bytes());
            let next = h.finalize();
            bytes.copy_from_slice(&next[..32]);
            ctr = ctr.wrapping_add(1);
        }
    }

    fn derive_auth_secret(endpoint: &str) -> Vec<u8> {
        let mut h = Sha256::new();
        h.update(b"auth:");
        h.update(endpoint.as_bytes());
        let full = h.finalize();
        full[..16].to_vec() // 16 bytes per canister validation (>=16)
    }

    fn b64url(bytes: &[u8]) -> String {
        use base64::Engine as _;
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        engine.encode(bytes)
    }

    #[derive(Clone)]
    pub struct ClientCred {
        pub sk: P256SecretKey,
        pub pk_uncompressed: Vec<u8>,
        pub auth_secret: Vec<u8>,
    }

    pub fn mk_valid_sub_with_creds(endpoint: &str) -> (Subscription, ClientCred) {
        let sk = derive_test_sk(endpoint);
        let pk = sk.public_key();
        let pk_uncompressed = pk.to_encoded_point(false).as_bytes().to_vec(); // 65 bytes starting 0x04
        let auth_secret = derive_auth_secret(endpoint);
        let sub = Subscription {
            endpoint: endpoint.to_string(),
            expirationTime: None,
            keys: Keys {
                p256dh: b64url(&pk_uncompressed),
                auth: b64url(&auth_secret),
            },
        };
        let cred = ClientCred { sk, pk_uncompressed, auth_secret };
        (sub, cred)
    }

    // Decrypt the payload JSON and return title/content/url/tag as serde_json::Value
    pub fn decrypt_payload(item: &EncryptedNotification, cred: &ClientCred) -> Option<serde_json::Value> {
        let enc = item.encrypted.as_ref()?;
        // Parse server ephemeral public key
        let server_pub = P256PublicKey::from_sec1_bytes(&enc.localPublicKey).ok()?;
        // ECDH shared secret using client secret key and server eph public key
        let shared_secret = diffie_hellman(cred.sk.to_nonzero_scalar(), server_pub.as_affine());
        let shared = shared_secret.raw_secret_bytes();

        // PRK_auth = HKDF-Extract(salt = auth_secret, IKM = shared_secret)
        let (prk_auth, _salt_unused) = Hkdf::<Sha256>::extract(Some(&cred.auth_secret), shared.as_slice());

        // Context = "WebPush: info" 0x00 || receiver_pub || sender_pub
        let mut context = Vec::with_capacity(2 + 65 + 65);
        context.extend_from_slice(b"WebPush: info");
        context.push(0u8);
        context.extend_from_slice(&cred.pk_uncompressed);
        context.extend_from_slice(&enc.localPublicKey);

        // secret32 = HKDF-Expand(PRK_auth, context, 32)
        let hk_auth = Hkdf::<Sha256>::from_prk(prk_auth.as_ref()).ok()?;
        let mut secret32 = [0u8; 32];
        hk_auth.expand(&context, &mut secret32).ok()?;

        // prk = HKDF-Extract(salt, secret32)
        let (prk, _salt2_unused) = Hkdf::<Sha256>::extract(Some(&enc.salt), &secret32);

        // Derive CEK and nonce as in canister
        let hk_prk = Hkdf::<Sha256>::from_prk(prk.as_ref()).ok()?;
        let mut cek = [0u8; 16];
        hk_prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).ok()?;
        let mut nonce_bytes = [0u8; 12];
        hk_prk.expand(b"Content-Encoding: nonce\0", &mut nonce_bytes).ok()?;

        // Decrypt
        let cipher = Aes128Gcm::new_from_slice(&cek).ok()?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let mut plaintext = cipher.decrypt(nonce, enc.cipherText.as_ref()).ok()?;
        // Drop trailing 0x02 marker per canister
        if let Some(&last) = plaintext.last() { if last == 0x02 { plaintext.pop(); } }

        serde_json::from_slice::<serde_json::Value>(&plaintext).ok()
    }

    pub fn mk_sub(endpoint: &str) -> Subscription {
        // Backward-compatible helper: returns invalid keys (no encryption)
        Subscription {
            endpoint: endpoint.to_string(),
            expirationTime: None,
            keys: Keys { p256dh: "x".into(), auth: "y".into() },
        }
    }

    pub struct TestEnv {
        pub pic: PocketIc,
        pub canister_id: Principal,
        controller: Principal,
        worker: Principal,
        app_manager: Principal,
    }

    impl TestEnv {
        pub fn new() -> Self {
            let controller = principal(0xC1);
            let worker = principal(0xC2);
            let app_manager = principal(0xC3);

            let pic = PocketIc::new();
            let canister_id = pic.create_canister_with_settings(Some(controller), None);
            // PocketIC v11 requires cycles for install and execution
            pic.add_cycles(canister_id, 10_000_000_000_000u128);

            let wasm = super::load_wasm();
            let init_arg = Encode!(&worker).expect("encode init arg");
            pic.install_canister(canister_id, wasm, init_arg, Some(controller));

            // Register the application (managed by app_manager)
            let _ = super::call_update(&pic, canister_id, controller, "registerApplication", Encode!(&app_manager).unwrap());

            Self { pic, canister_id, controller, worker, app_manager }
        }

        pub fn controller(&self) -> Principal { self.controller }
        pub fn worker(&self) -> Principal { self.worker }
        pub fn app_manager(&self) -> Principal { self.app_manager }

        pub fn subscribe(&self, user: Principal, sub: &Subscription) -> Result<(), String> {
            super::call_update(&self.pic, self.canister_id, user, "subscribe", Encode!(&self.app_manager, sub).unwrap())
                .map(|_| ())
        }

        pub fn send(&self, items: &[(Principal, NotificationBody)]) -> Result<(), String> {
            super::call_update(&self.pic, self.canister_id, self.app_manager, "sendNotifications", Encode!(&items.to_vec()).unwrap())
                .map(|_| ())
        }

        pub fn peek(&self, offset: u64) -> Result<(Vec<EncryptedNotification>, bool), String> {
            let bytes = super::call_query(&self.pic, self.canister_id, self.worker, "peekQueue", Encode!(&offset).unwrap())?;
            let page: PeekPage = Decode!(&bytes, PeekPage).map_err(|e| format!("Decode error: {}", e))?;
            Ok((page.items, page.drained))
        }

        pub fn pop(&self, n: u64) -> Result<(), String> {
            super::call_update(&self.pic, self.canister_id, self.worker, "popQueue", Encode!(&n).unwrap()).map(|_| ())
        }
    }
}

#[test]
fn notifications_queue_basic_flow() {
    use helpers as h;
    // Test environment with controller/worker/app_manager set up and app registered
    let env = h::TestEnv::new();
    let controller = env.controller();
    let app_manager = env.app_manager();
    let user1 = h::principal(0x04);

    // Subscribe two endpoints with valid keys and collect creds for decryption
    let (sub1, cred1) = h::mk_valid_sub_with_creds("https://push.example/ep-1");
    let (sub2, cred2) = h::mk_valid_sub_with_creds("https://push.example/ep-2");
    env.subscribe(user1, &sub1).expect("subscribe ep-1");
    env.subscribe(user1, &sub2).expect("subscribe ep-2");
    let mut creds: HashMap<String, h::ClientCred> = HashMap::new();
    creds.insert(sub1.endpoint.clone(), cred1);
    creds.insert(sub2.endpoint.clone(), cred2);

    // Send one notification to user1
    let body = h::NotificationBody { title: "Hello".into(), content: "World".into(), url: Some("https://app/hello".into()), tag: Some("t1".into()) };
    env.send(&vec![(user1, body)]).expect("sendNotifications failed");

    // Non-worker cannot peek
    let res = call_query(&env.pic, env.canister_id, controller, "peekQueue", Encode!(&0u64).unwrap());
    assert!(res.is_err(), "peekQueue by non-worker should reject");

    // Worker can peek; expect 2 items, FIFO order of endpoints
    let (list, _is_drained) = env.peek(0).expect("worker peek");
    assert_eq!(list.len(), 2, "expected two queued notifications");
    assert_eq!(list[0].endpoint, "https://push.example/ep-1");
    assert_eq!(list[1].endpoint, "https://push.example/ep-2");
    // Context must reflect (application manager, receiver)
    assert_eq!(list[0].context, (app_manager, user1));
    assert_eq!(list[1].context, (app_manager, user1));
    // Decrypt and assert titles/contents
    for item in &list {
        let cred = creds.get(&item.endpoint).unwrap();
        let payload = h::decrypt_payload(item, cred).expect("decrypt payload");
        assert_eq!(payload["title"], "Hello");
        assert_eq!(payload["body"], "World");
    }

    // Pop one item; expect FIFO so remaining should be ep-2
    env.pop(1).expect("popQueue failed");

    let (list, _is_drained) = env.peek(0).expect("peek after pop");
    assert_eq!(list.len(), 1, "expected one remaining after pop");
    assert_eq!(list[0].endpoint, "https://push.example/ep-2");
    // Decrypt and assert remaining item title/content
    let cred = creds.get(&list[0].endpoint).unwrap();
    let payload = h::decrypt_payload(&list[0], cred).expect("decrypt payload after pop");
    assert_eq!(payload["title"], "Hello");
    assert_eq!(payload["body"], "World");
}

#[test]
fn pop_more_than_queue_len_is_safe() {
    use helpers as h;
    let env = h::TestEnv::new();
    let user1 = h::principal(0x14);

    // Subscribe single endpoint with valid keys and send 1 notification
    let (sub, cred) = h::mk_valid_sub_with_creds("https://push.example/only");
    env.subscribe(user1, &sub).expect("subscribe");
    env.send(&vec![(user1, h::NotificationBody { title: "One".into(), content: "Item".into(), url: None, tag: None })]).expect("sendNotifications");

    // Peek once to assert title/content
    let (list_before, _drained0) = env.peek(0).expect("peek before pop");
    assert_eq!(list_before.len(), 1, "expected one item queued");
    let payload = h::decrypt_payload(&list_before[0], &cred).expect("decrypt single item");
    assert_eq!(payload["title"], "One");
    assert_eq!(payload["body"], "Item");

    // Pop more than available
    env.pop(10).expect("popQueue(10)");

    // Queue should be empty now
    let (list, _d_after) = env.peek(0).expect("peek by worker");
    assert!(list.is_empty(), "queue should be empty after popping more than present");
}


#[test]
fn peek_then_push_then_pop_then_peek_no_skip_no_repeat() {
    use helpers as h;

    let env = h::TestEnv::new();
    let user1 = h::principal(0x24);

    // Batch 1: create 5 subscriptions (valid keys) and enqueue notifications
    let batch1_eps: Vec<String> = (1..=5).map(|i| format!("https://push.example/ep-{}", i)).collect();
    let mut creds: HashMap<String, h::ClientCred> = HashMap::new();
    for ep in &batch1_eps {
        let (sub, cred) = h::mk_valid_sub_with_creds(ep);
        env.subscribe(user1, &sub).expect("subscribe batch1");
        creds.insert(sub.endpoint.clone(), cred);
    }
    env.send(&vec![(user1, h::NotificationBody { title: "T".into(), content: "C".into(), url: None, tag: None })]).expect("send batch1");

    // Peek after first push → expect 5 entries matching batch1 and title T
    let (list1, _d_a) = env.peek(0).expect("peek after batch1");
    assert_eq!(list1.len(), 5, "expected 5 notifications after first push");
    for (i, item) in list1.iter().enumerate() {
        assert_eq!(item.endpoint, batch1_eps[i], "batch1 endpoint order mismatch at index {}", i);
        assert_eq!(item.context.1, user1);
        let cred = creds.get(&item.endpoint).unwrap();
        let payload = h::decrypt_payload(item, cred).expect("decrypt batch1 item");
        assert_eq!(payload["title"], "T");
        assert_eq!(payload["body"], "C");
    }

    // Batch 2: add 5 more subscriptions (valid keys) and enqueue again
    let batch2_eps: Vec<String> = (6..=10).map(|i| format!("https://push.example/ep-{}", i)).collect();
    for ep in &batch2_eps {
        let (sub, cred) = h::mk_valid_sub_with_creds(ep);
        env.subscribe(user1, &sub).expect("subscribe batch2");
        creds.insert(sub.endpoint.clone(), cred);
    }
    env.send(&vec![(user1, h::NotificationBody { title: "T2".into(), content: "C2".into(), url: None, tag: None })]).expect("send batch2");

    // Pop first 5 (batch1)
    env.pop(5).expect("pop first 5");

    // Peek again → 10 should remain (second send enqueued for all 10 subs), all with title T2
    let (list2, _d_b) = env.peek(0).expect("peek after pop 5");
    assert_eq!(list2.len(), 10, "expected 10 remaining after popping first 5 (second send enqueues for all 10 subs)");
    for (i, item) in list2.iter().enumerate() {
        let expected = if i < 5 { &batch1_eps[i] } else { &batch2_eps[i - 5] };
        assert_eq!(item.endpoint, *expected, "endpoint order mismatch at index {}", i);
        assert_eq!(item.context.1, user1);
        let cred = creds.get(&item.endpoint).unwrap();
        let payload = h::decrypt_payload(item, cred).expect("decrypt batch2 item");
        assert_eq!(payload["title"], "T2");
        assert_eq!(payload["body"], "C2");
    }

    // Drain all remaining (10) and verify empty
    env.pop(10).expect("drain remaining");
    let (list3, _d_final) = env.peek(0).expect("final peek");
    assert!(list3.is_empty(), "queue should be empty after draining remaining 10");
}


#[test]
fn single_subscription_many_notifications() {
    use helpers as h;

    let env = h::TestEnv::new();
    let user1 = h::principal(0x34);

    // Subscribe single endpoint with valid keys to enable encryption + decryption
    let (sub, cred) = h::mk_valid_sub_with_creds("https://push.example/single");
    env.subscribe(user1, &sub).expect("subscribe single endpoint");
    let mk_body = |i: usize| h::NotificationBody {
        title: format!("N{}", i),
        content: format!("Content {}", i),
        url: None,
        tag: Some(format!("t{}", i)),
    };

    // 1) Send 5 notifications in one call
    let batch1: Vec<(Principal, h::NotificationBody)> = (1..=5).map(|i| (user1, mk_body(i))).collect();
    env.send(&batch1).expect("send batch1");

    // 2) peek -> expect 5 queued items for the single endpoint; assert titles N1..N5
    let (list1, _d1) = env.peek(0).expect("peek after batch1");
    assert_eq!(list1.len(), 5, "expected 5 notifications after first send");
    for (idx, item) in list1.iter().enumerate() {
        assert_eq!(item.endpoint, "https://push.example/single");
        assert_eq!(item.context.1, user1);
        let payload = h::decrypt_payload(item, &cred).expect("decrypt payload batch1");
        assert_eq!(payload["title"], format!("N{}", idx + 1));
        assert_eq!(payload["body"], format!("Content {}", idx + 1));
    }

    // 3) Send another 5 notifications in a second call
    let batch2: Vec<(Principal, h::NotificationBody)> = (6..=10).map(|i| (user1, mk_body(i))).collect();
    env.send(&batch2).expect("send batch2");

    // 4) popQueue(5) to remove the first batch
    env.pop(5).expect("pop first 5");

    // 5) peek again -> expect the remaining 5 (the second batch), no skip/no repeat; assert titles N6..N10
    let (list2, _d2) = env.peek(0).expect("peek after pop 5");
    assert_eq!(list2.len(), 5, "expected 5 remaining after popping the first 5");
    for (i, item) in list2.iter().enumerate() {
        assert_eq!(item.endpoint, "https://push.example/single");
        assert_eq!(item.context.1, user1);
        let payload = h::decrypt_payload(item, &cred).expect("decrypt payload batch2");
        let n = 6 + i;
        assert_eq!(payload["title"], format!("N{}", n));
        assert_eq!(payload["body"], format!("Content {}", n));
    }
}


#[test]
fn peek_queue_pagination_and_is_drained() {
    use helpers as h;
    let env = h::TestEnv::new();
    let user = h::principal(0x44);

    // Create 3 subscriptions to produce 3 queued notifications per send
    let eps: Vec<String> = (1..=3).map(|i| format!("https://push.example/pag-{}", i)).collect();
    for ep in &eps {
        let (sub, _cred) = h::mk_valid_sub_with_creds(ep);
        env.subscribe(user, &sub).expect("subscribe");
    }
    env.send(&vec![(user, h::NotificationBody { title: "P".into(), content: "G".into(), url: None, tag: None })]).expect("send");

    // offset 0 -> 3 items, drained true
    let (page0, drained0) = env.peek(0).expect("peek off 0");
    assert_eq!(page0.len(), 3);
    assert!(drained0);

    // offset 1 -> 2 items, drained true
    let (page1, drained1) = env.peek(1).expect("peek off 1");
    assert_eq!(page1.len(), 2);
    assert!(drained1);

    // offset 2 -> 1 item, drained true
    let (page2, drained2) = env.peek(2).expect("peek off 2");
    assert_eq!(page2.len(), 1);
    assert!(drained2);

    // offset 3 -> 0 items, drained true (at end)
    let (page3, drained3) = env.peek(3).expect("peek off 3");
    assert!(page3.is_empty());
    assert!(drained3);

    // offset large -> 0 items, drained true
    let (page_big, drained_big) = env.peek(10).expect("peek off 10");
    assert!(page_big.is_empty());
    assert!(drained_big);

    // Now push many notifications so that total > 100, and verify first page is not drained
    // We currently have 3 items in the queue (one send -> 3 subs). Each additional send adds 3.
    // Keep sending until total exceeds 100.
    let mut total = 3usize;
    let mut i = 0usize;
    while total <= 100 {
        env.send(&vec![(user, h::NotificationBody { title: format!("P{}", i), content: "G".into(), url: None, tag: None })])
            .expect("send more to exceed 100 total");
        total += 3; // 3 subs per send
        i += 1;
    }

    // Peek the first page and validate that when total > returned_len, is_drained is false.
    let (first_page, drained_first) = env.peek(0).expect("peek first page after bulk push");
    assert!(!first_page.is_empty(), "first page should return at least one item");
    assert!(total > first_page.len(), "test setup expects total queued > first page size");
    assert!(!drained_first, "is_drained must be false when more items remain beyond the first page");

    // Continue paginating until drained; accumulate total seen and ensure it matches `total`.
    let mut seen = first_page.len();
    let mut offset = first_page.len() as u64;
    let mut drained = drained_first;
    let mut guard = 0; // safety to avoid infinite loops in case of a bug
    while !drained {
        let (page, d) = env.peek(offset).expect("peek subsequent page");
        assert!(!page.is_empty(), "subsequent page should not be empty before drained");
        seen += page.len();
        offset += page.len() as u64;
        drained = d;
        guard += 1;
        assert!(guard < 1000, "pagination loop guard tripped");
    }
    assert_eq!(seen, total, "paginated view should cover all queued items");
}
