use candid::{CandidType, Principal};
use ic_cdk::api;
use serde::{Deserialize, Serialize};
use candid::export_service;
use ic_cdk_macros::{init, post_upgrade, pre_upgrade, query, update};
use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};

const VAPID_PUBLIC_KEY: &str = "BHwsFW3GXWkq7v0U_QM3yF43-4U8bjn0Nfdc3tl4BuX3CkzZv9T3df84QHB8PABj5m34y3YRByQfHgC_uHNFYQ4";

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct Subscription {
    pub endpoint: String,
    pub expirationTime: Option<u64>,
    pub keys: SubscriptionKeys,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotificationBody {
    pub title: String,
    pub content: String,
    pub url: Option<String>,
    pub tag: Option<String>,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct Notification {
    pub subscription: Subscription,
    pub body: NotificationBody,
    pub context: (Principal, Principal), // (application, receiver)
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct Application {
    pub manager: Principal,
    pub subscriptions: BTreeMap<Principal, Vec<Subscription>>, // user -> subscriptions
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct State {
    pub applications: BTreeMap<Principal, Application>,
    pub notifications_queue: VecDeque<Notification>,
    pub worker: Principal,
}

impl Default for State {
    fn default() -> Self {
        Self {
            applications: BTreeMap::new(),
            notifications_queue: VecDeque::new(),
            worker: Principal::anonymous(),
        }
    }
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn trap(msg: &str) -> ! {
    ic_cdk::trap(msg)
}

#[init]
fn init(worker: Principal) {
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        st.worker = worker;
    });
}

#[pre_upgrade]
fn pre_upgrade() {
    STATE.with(|s| {
        let st = s.borrow().clone();
        ic_cdk::storage::stable_save((st,)).expect("stable_save failed");
    });
}

#[post_upgrade]
fn post_upgrade() {
    let (st,): (State,) = ic_cdk::storage::stable_restore().expect("stable_restore failed");
    STATE.with(|s| {
        *s.borrow_mut() = st;
    });
}

// End-user interface
#[query]
fn getVapidPublicKey() -> String {
    VAPID_PUBLIC_KEY.to_string()
}

#[query]
fn hasSubscription(application: Principal, endpoint: String) -> bool {
    let caller = api::caller();
    STATE.with(|s| {
        let st = s.borrow();
        let app = st
            .applications
            .get(&application)
            .unwrap_or_else(|| trap("Application not found"));
        if let Some(list) = app.subscriptions.get(&caller) {
            list.iter().any(|sub| sub.endpoint == endpoint)
        } else {
            false
        }
    })
}

#[update]
fn subscribe(application: Principal, subscription: Subscription) {
    let caller = api::caller();
    if caller == Principal::anonymous() {
        trap("Anonymous users cannot subscribe to notifications");
    }
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let app = st
            .applications
            .get_mut(&application)
            .unwrap_or_else(|| trap("Application not found"));

        let entry = app.subscriptions.entry(caller).or_insert_with(Vec::new);
        if let Some(idx) = entry.iter().position(|sub| sub.endpoint == subscription.endpoint) {
            entry[idx] = subscription;
        } else {
            entry.push(subscription);
        }
    });
}

fn remove_subscription(app: &mut Application, user: Principal, endpoint: &str) {
    if let Some(list) = app.subscriptions.get_mut(&user) {
        list.retain(|item| item.endpoint != endpoint);
        if list.is_empty() {
            app.subscriptions.remove(&user);
        }
    }
}

#[update]
fn unsubscribe(application: Principal, endpoint: String) {
    let caller = api::caller();
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let app = st
            .applications
            .get_mut(&application)
            .unwrap_or_else(|| trap("Application not found"));
        remove_subscription(app, caller, &endpoint);
    });
}

#[update]
fn unsubscribeAll(application: Principal) {
    let caller = api::caller();
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let app = st
            .applications
            .get_mut(&application)
            .unwrap_or_else(|| trap("Application not found"));
        app.subscriptions.remove(&caller);
    });
}

// Admin interface
#[update]
fn registerApplication(manager: Principal) {
    let caller = api::caller();
    if !api::is_controller(&caller) {
        trap("Only controllers can register application");
    }
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        if st.applications.contains_key(&manager) {
            trap("Already registered");
        }
        let app = Application {
            manager,
            subscriptions: BTreeMap::new(),
        };
        st.applications.insert(manager, app);
    });
}

#[update]
fn deregisterApplication(manager: Principal) {
    let caller = api::caller();
    if !api::is_controller(&caller) {
        trap("Only controllers can register application");
    }
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        st.applications.remove(&manager);
    });
}

// App owner interface
#[update]
async fn sendNotifications(arg: Vec<(Principal, NotificationBody)>) {
    let caller = api::caller();
    // Process each (user, body) in two phases to avoid overlapping borrows:
    // 1) read-only borrow to fetch and clone user's subscriptions
    // 2) mutable borrow to push notifications into the queue
    for (user, body) in arg.into_iter() {
        // Phase 1: read subscriptions immutably
        let maybe_user_subs = STATE.with(|s| {
            let st = s.borrow();
            let app = match st.applications.get(&caller) {
                Some(a) => a,
                None => trap("Caller does not have any application registered"),
            };
            app.subscriptions.get(&user).cloned()
        });

        let user_subs = match maybe_user_subs {
            Some(list) => list,
            None => return, // replicate Motoko early return
        };

        // Phase 2: push notifications with a fresh mutable borrow
        STATE.with(|s| {
            let mut st = s.borrow_mut();
            for subscription in user_subs.into_iter() {
                st.notifications_queue.push_back(Notification {
                    subscription,
                    body: body.clone(),
                    context: (caller, user),
                });
            }
        });
    }
}

// Worker interface
#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedData {
    pub localPublicKey: Vec<u8>,
    pub salt: Vec<u8>,
    pub cipherText: Vec<u8>,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub enum ContentEncoding {
    #[serde(rename = "aesgcm")]
    AesGcm,
    #[serde(rename = "aes128gcm")]
    Aes128Gcm,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedNotification {
    pub endpoint: String,
    pub contentEncoding: ContentEncoding,
    pub encrypted: Option<EncryptedData>,
    pub context: (Principal, Principal),
}

fn b64url_decode(input: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    engine.decode(input.as_bytes()).ok()
}

#[query]
fn peekQueue() -> Vec<EncryptedNotification> {
    let caller = api::caller();
    STATE.with(|s| {
        let st = s.borrow();
        if caller != st.worker {
            trap("Only worker can use this interface");
        }
        st.notifications_queue
            .iter()
            .take(10)
            .map(|n| {
                let mut obj = serde_json::json!({
                    "title": n.body.title,
                    "body": n.body.content,
                });
                if let Some(url) = &n.body.url { obj["url"] = serde_json::Value::String(url.clone()); }
                if let Some(tag) = &n.body.tag { obj["tag"] = serde_json::Value::String(tag.clone()); }
                let payload_bytes = serde_json::to_vec(&obj).unwrap_or_else(|_| Vec::new());

                let encrypted = match (b64url_decode(&n.subscription.keys.p256dh), b64url_decode(&n.subscription.keys.auth)) {
                    (Some(user_pubkey), Some(auth_secret)) => {
                        match encrypt_webpush_aes128gcm(&user_pubkey, &auth_secret, &payload_bytes) {
                            Some((local_public_key, salt, cipher_text)) => Some(EncryptedData {
                                localPublicKey: local_public_key,
                                salt,
                                cipherText: cipher_text,
                            }),
                            None => None,
                        }
                    }
                    _ => None,
                };

                EncryptedNotification {
                    endpoint: n.subscription.endpoint.clone(),
                    contentEncoding: ContentEncoding::Aes128Gcm,
                    encrypted,
                    context: n.context.clone(),
                }
            })
            .collect()
    })
}

fn encrypt_webpush_aes128gcm(user_public_key: &[u8], auth_secret: &[u8], payload: &[u8]) -> Option<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    // Deterministic, query-safe Web Push AES-128-GCM per RFC 8291/8188.
    // No RNG used; all values derived from stable inputs via HKDF-SHA256.
    use aes_gcm::{Aes128Gcm};
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::Nonce;
    use hkdf::Hkdf;
    use p256::{PublicKey as P256PublicKey, SecretKey as P256SecretKey};
    use p256::elliptic_curve::sec1::{ToEncodedPoint};
    use sha2::{Digest, Sha256};

    // Validate inputs
    if user_public_key.len() != 65 || user_public_key[0] != 0x04 || auth_secret.len() < 16 {
        return None;
    }

    // Parse subscriber public key (client key)
    let client_pub = P256PublicKey::from_sec1_bytes(user_public_key).ok()?;

    // Hash of payload for uniqueness in derivation
    let payload_hash = {
        let mut h = Sha256::new();
        h.update(payload);
        h.finalize().to_vec()
    };

    // Derive base HKDF from stable inputs
    let mut hkdf_ikm = Vec::with_capacity(16 + user_public_key.len() + auth_secret.len() + payload_hash.len());
    hkdf_ikm.extend_from_slice(b"ic-webpush-v1");
    hkdf_ikm.extend_from_slice(user_public_key);
    hkdf_ikm.extend_from_slice(auth_secret);
    hkdf_ikm.extend_from_slice(&payload_hash);

    let hk = Hkdf::<Sha256>::new(None, &hkdf_ikm);

    // Derive 16-byte salt (RFC 8188 salt)
    let mut salt = [0u8; 16];
    if hk.expand(b"wp-salt", &mut salt).is_err() { return None; }

    // Derive ephemeral secret key deterministically; ensure non-zero scalar
    let mut ctr: u32 = 0;
    let eph_sk = loop {
        let mut sk_bytes = [0u8; 32];
        // domain separated by counter to avoid bias/zero
        let mut info = Vec::with_capacity(32);
        info.extend_from_slice(b"wp-epk");
        info.extend_from_slice(&ctr.to_be_bytes());
        if hk.expand(&info, &mut sk_bytes).is_err() { return None; }
        if let Ok(sk) = P256SecretKey::from_slice(&sk_bytes) {
            break sk;
        }
        ctr = ctr.wrapping_add(1);
        if ctr == 0 { return None; }
    };

    // Ephemeral public key (server key)
    let eph_pub_point = eph_sk.public_key().to_encoded_point(false);
    let eph_pub_uncompressed = eph_pub_point.as_bytes().to_vec();

    // Compute ECDH shared secret using P-256 diffie_hellman
    let shared_secret = {
        use p256::ecdh::diffie_hellman;
        let ss = diffie_hellman(eph_sk.to_nonzero_scalar(), client_pub.as_affine());
        ss.raw_secret_bytes().as_slice().to_vec()
    };

    // RFC 8291/8188 key schedule (Web Push) — align with http_ece:
    // 1) PRK_auth = HKDF-Extract(salt = auth_secret, IKM = shared_secret)
    let (prk_auth, _salt_unused) = Hkdf::<Sha256>::extract(Some(auth_secret), &shared_secret);

    // Build WebPush info context per http_ece (no length prefixes): "WebPush: info" 0x00 || receiver_pub || sender_pub
    let mut context = Vec::with_capacity(2 + 65 + 65);
    context.extend_from_slice(b"WebPush: info");
    context.push(0u8);
    context.extend_from_slice(user_public_key);
    context.extend_from_slice(&eph_pub_uncompressed);

    // http_ece aes128gcm derivation aligned to RFC 8291/8188 and node-http_ece:
    // secret = HKDF-Expand(PRK_auth, context, 32)
    let hk_auth = Hkdf::<Sha256>::from_prk(prk_auth.as_ref()).ok()?;
    let mut secret32 = [0u8; 32];
    if hk_auth.expand(&context, &mut secret32).is_err() { return None; }

    // prk = HKDF-Extract(salt, secret)
    let (prk, _salt2_unused) = Hkdf::<Sha256>::extract(Some(&salt), &secret32);

    // key = HKDF-Expand(prk, "Content-Encoding: aes128gcm\0", 16)
    // nonce = HKDF-Expand(prk, "Content-Encoding: nonce\0", 12)
    let key_info: &[u8] = b"Content-Encoding: aes128gcm\0";
    let nonce_info: &[u8] = b"Content-Encoding: nonce\0";

    let hk_prk = Hkdf::<Sha256>::from_prk(prk.as_ref()).ok()?;
    let mut cek = [0u8; 16];
    if hk_prk.expand(&key_info, &mut cek).is_err() { return None; }
    let mut nonce = [0u8; 12];
    if hk_prk.expand(&nonce_info, &mut nonce).is_err() { return None; }

    // aes128gcm plaintext framing: payload || 0x02 (last record)
    let mut plaintext = Vec::with_capacity(payload.len() + 1);
    plaintext.extend_from_slice(payload);
    plaintext.push(0x02);

    let cipher = Aes128Gcm::new_from_slice(&cek).ok()?;
    let nonce = Nonce::from_slice(&nonce);
    let ciphertext = cipher.encrypt(nonce, plaintext.as_ref()).ok()?;

    Some((eph_pub_uncompressed, salt.to_vec(), ciphertext))
}

#[update]
async fn popQueue(amount: u64) {
    let caller = api::caller();
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        if caller != st.worker {
            trap("Only worker can use this interface");
        }
        for _ in 0..amount {
            st.notifications_queue.pop_front();
        }
    });
}

#[update]
async fn reportBrokenSubscriptions(arg: Vec<(Principal, Principal, String)>) {
    let caller = api::caller();
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        if caller != st.worker {
            trap("Only worker can use this interface");
        }
        for (application, user, endpoint) in arg.into_iter() {
            if let Some(app) = st.applications.get_mut(&application) {
                remove_subscription(app, user, &endpoint);
            }
        }
    });
}

// Candid export for dfx
#[query(name = "__get_candid_interface_tmp_hack")]
fn export_candid() -> String {
    export_service!();
    __export_service()
}


