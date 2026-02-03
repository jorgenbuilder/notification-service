#![allow(non_snake_case)]

use candid::export_service;
use candid::{CandidType, Principal};
use ic_cdk::api;
use ic_cdk_macros::{init, post_upgrade, pre_upgrade, query, update};
use ic_cdk_timers::set_timer;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;
use std::time::Duration;

mod promtracker;
mod app_subscriptions;
use promtracker::{CounterValue, PromTracker, StableData};
pub use app_subscriptions::AppSubscriptions;

const MAX_QUEUE_SIZE: usize = 10_000;

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
    pub relayer: Principal,
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
    pub subscriptions: AppSubscriptions,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayerRecord {
    pub queue: VecDeque<Notification>,
    pub vapid_public_key: String,
    pub registered_at: u64,
    pub last_updated_at: u64,
    pub description: String,
    pub total_notifications_sent: u128,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct State {
    pub applications: BTreeMap<Principal, Application>,
    pub relayers: BTreeMap<Principal, RelayerRecord>,
    pub total_notifications_sent: u128,
    pub startup_random: Option<Vec<u8>>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            applications: BTreeMap::new(),
            relayers: BTreeMap::new(),
            total_notifications_sent: 0,
            startup_random: None,
        }
    }
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

struct PromHandler {
    tracker: PromTracker,
    users_counter: Rc<RefCell<CounterValue>>, // total number of subscribed users (per-app entries)
    subscriptions_counter: Rc<RefCell<CounterValue>>, // total number of subscriptions (endpoints)
    relayer_metric_ids: BTreeMap<Principal, Vec<usize>>, // per-relayer metric IDs registered in tracker
}

thread_local! {
    static PROM: RefCell<Option<PromHandler>> = RefCell::new(None);
}

fn add_relayer_metrics(relayer: Principal) {
    PROM.with(|p| {
        if p.borrow().is_none() {
            setup_prom();
        }
        if let Some(h) = p.borrow_mut().as_mut() {
            if h.relayer_metric_ids.contains_key(&relayer) {
                return;
            }
            let label = format!("relayer=\"{}\"", relayer.to_text());
            let id1 = h.tracker.add_pull("queue_len", &label, {
                let relayer = relayer.clone();
                move || {
                    STATE.with(|s2| {
                        s2.borrow()
                            .relayers
                            .get(&relayer)
                            .map(|wr| wr.queue.len() as u128)
                            .unwrap_or(0)
                    })
                }
            });
            let id2 = h.tracker.add_pull("notifications_sent", &label, {
                let relayer = relayer.clone();
                move || {
                    STATE.with(|s2| {
                        s2.borrow()
                            .relayers
                            .get(&relayer)
                            .map(|wr| wr.total_notifications_sent)
                            .unwrap_or(0)
                    })
                }
            });
            h.relayer_metric_ids.insert(relayer, vec![id1, id2]);
        }
    });
}

fn remove_relayer_metrics(relayer: Principal) {
    PROM.with(|p| {
        if let Some(h) = p.borrow_mut().as_mut() {
            if let Some(ids) = h.relayer_metric_ids.remove(&relayer) {
                for id in ids {
                    h.tracker.remove(id);
                }
            }
        }
    });
}

fn setup_prom() {
    PROM.with(|p| {
        let mut tracker = PromTracker::new("component=\"notification-canister\"");
        tracker.add_system_metrics();
        tracker.add_pull("total_notifications_sent", "", || {
            STATE.with(|s| s.borrow().total_notifications_sent)
        });
        tracker.add_pull("applications_registered", "", || {
            STATE.with(|s| s.borrow().applications.len() as u128)
        });
        tracker.add_pull("relayers_registered", "", || {
            STATE.with(|s| s.borrow().relayers.len() as u128)
        });
        let users_counter = tracker.add_counter("subscribed_users_total", "", true);
        let subscriptions_counter = tracker.add_counter("subscriptions_total", "", true);
        let handler = PromHandler {
            tracker,
            users_counter,
            subscriptions_counter,
            relayer_metric_ids: BTreeMap::new(),
        };
        *p.borrow_mut() = Some(handler);
        STATE.with(|s| {
            let st = s.borrow();
            for (wp, _) in st.relayers.iter() {
                add_relayer_metrics(*wp);
            }
        });
    });
}

fn trap(msg: &str) -> ! {
    ic_cdk::trap(msg)
}

fn is_canister(p: &Principal) -> bool {
    let bytes = p.as_slice();
    // Motoko equivalent: size >= 0 and size <= 29 and last byte == 1
    // Rust: ensure non-empty and <=29 and last byte == 1
    !bytes.is_empty() && bytes.len() <= 29 && bytes[bytes.len() - 1] == 1u8
}

// One-shot randomness fetch scheduled via timer after init/upgrade
async fn fetch_startup_random_once() {
    let rand_blob: Vec<u8> = match ic_cdk::api::call::call::<(), (Vec<u8>,)>(
        Principal::management_canister(),
        "raw_rand",
        (),
    )
    .await
    {
        Ok((bytes,)) => bytes,
        Err(_) => Vec::new(),
    };

    STATE.with(|s| {
        let mut st = s.borrow_mut();
        if st.startup_random.is_none() && !rand_blob.is_empty() {
            st.startup_random = Some(rand_blob);
        }
    });
}

#[init]
fn init() {
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        if st.startup_random.is_none() {
            st.startup_random = None;
        }
    });
    setup_prom();
    set_timer(Duration::ZERO, || {
        ic_cdk::spawn(async {
            fetch_startup_random_once().await;
        });
    });
}

#[pre_upgrade]
fn pre_upgrade() {
    let st = STATE.with(|s| s.borrow().clone());
    let stable_metrics: StableData = PROM.with(|p| {
        if p.borrow().is_none() {
            setup_prom();
        }
        p.borrow().as_ref().unwrap().tracker.share()
    });
    ic_cdk::storage::stable_save((st, stable_metrics)).expect("stable_save failed");
}

#[post_upgrade]
fn post_upgrade() {
    let (mut st, stable_metrics): (State, StableData) =
        ic_cdk::storage::stable_restore().expect("stable_restore failed");

    if st.startup_random.is_none() {
        st.startup_random = None;
    }

    STATE.with(|s| {
        *s.borrow_mut() = st;
    });
    setup_prom();
    PROM.with(|p| {
        if let Some(handles) = p.borrow_mut().as_mut() {
            handles.tracker.unshare(stable_metrics);
        }
    });

    // Schedule a one-shot timer to fetch randomness after upgrade completes
    set_timer(Duration::ZERO, || {
        ic_cdk::spawn(async {
            fetch_startup_random_once().await;
        });
    });
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct HttpResponse {
    pub status_code: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

fn render400() -> HttpResponse {
    HttpResponse {
        status_code: 400,
        headers: vec![],
        body: b"Invalid request".to_vec(),
    }
}

fn render_plain_text(text: String) -> HttpResponse {
    HttpResponse {
        status_code: 200,
        headers: vec![("content-type".to_string(), "text/plain".to_string())],
        body: text.into_bytes(),
    }
}

#[query]
fn http_request(req: HttpRequest) -> HttpResponse {
    // Normalize path (strip query)
    let path = req.url.split('?').next().unwrap_or("");
    match (req.method.as_str(), path) {
        ("GET", "/metrics") => {
            PROM.with(|p| {
                if p.borrow().is_none() {
                    setup_prom();
                }
            });
            let full = api::id().to_text();
            let short = full.split('-').next().unwrap_or(&full);
            let canister_label = format!("canister=\"{}\"", short);
            PROM.with(|p| {
                let handles = p.borrow();
                let tracker = &handles.as_ref().unwrap().tracker;
                render_plain_text(tracker.render(&canister_label))
            })
        }
        _ => render400(),
    }
}

// Admin interface
#[update]
fn registerRelayer(relayer: Principal, vapid_public_key: String, description: String) {
    let caller = api::caller();
    if !api::is_controller(&caller) {
        trap("Caller must be a canister controller");
    }
    let now = api::time();
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        if st.relayers.contains_key(&relayer) {
            trap("Relayer already registered");
        }
        st.relayers.insert(
            relayer,
            RelayerRecord {
                queue: VecDeque::new(),
                vapid_public_key: vapid_public_key.clone(),
                registered_at: now,
                last_updated_at: now,
                description: description.clone(),
                total_notifications_sent: 0,
            },
        );
    });
    add_relayer_metrics(relayer);
}

#[update]
fn deregisterRelayer(relayer: Principal) {
    let caller = api::caller();
    if !api::is_controller(&caller) {
        trap("Caller must be a canister controller");
    }
    remove_relayer_metrics(relayer);
        let (subs_removed_total, users_removed_total) = STATE.with(|s| {
        let mut st = s.borrow_mut();
        if !st.relayers.contains_key(&relayer) {
            trap("Relayer not registered");
        }

        let mut subs_removed: u128 = 0;
        let mut users_removed: u128 = 0;
        for (_app_id, app) in st.applications.iter_mut() {
            let (srm, urm) = app.subscriptions.remove_all_by_relayer(relayer);
            if srm > 0 {
                subs_removed = subs_removed.saturating_add(srm);
            }
            if urm > 0 {
                users_removed = users_removed.saturating_add(urm);
            }
        }
        st.relayers.remove(&relayer);

        (subs_removed, users_removed)
    });
    if subs_removed_total > 0 || users_removed_total > 0 {
        PROM.with(|p| {
            if let Some(h) = p.borrow().as_ref() {
                if subs_removed_total > 0 {
                    h.subscriptions_counter.borrow_mut().sub(subs_removed_total);
                }
                if users_removed_total > 0 {
                    h.users_counter.borrow_mut().sub(users_removed_total);
                }
            }
        });
    }
}

// End-user interface
#[query]
fn getVapidPublicKey(relayer: Principal) -> String {
    STATE.with(|s| {
        let st = s.borrow();
        match st.relayers.get(&relayer) {
            Some(wr) => wr.vapid_public_key.clone(),
            None => trap("Relayer not registered"),
        }
    })
}

#[query]
fn listRelayers() -> Vec<RelayerInfo> {
    STATE.with(|s| {
        let st = s.borrow();
        st.relayers
            .iter()
            .map(|(wp, wr)| RelayerInfo {
                relayer: *wp,
                vapid_public_key: wr.vapid_public_key.clone(),
                registeredAt: wr.registered_at,
                lastUpdatedAt: wr.last_updated_at,
                description: wr.description.clone(),
            })
            .collect()
    })
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
        app.subscriptions.has_endpoint(&caller, &endpoint)
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
        if !st.applications.contains_key(&application) {
            if !is_canister(&application) {
                trap("Only canister principals can be used as applications");
            }
            let app = Application {
                manager: application,
                subscriptions: AppSubscriptions::new(),
            };
            st.applications.insert(application, app);
        }
        let (subs_added, _subs_removed, user_added, _user_removed) = {
            let app = st
                .applications
                .get_mut(&application)
                .unwrap_or_else(|| trap("Application not found"));
            app.subscriptions.add(caller, subscription.clone())
        };
        if subs_added > 0 || user_added {
            PROM.with(|p| {
                if let Some(h) = p.borrow().as_ref() {
                    if subs_added > 0 { h.subscriptions_counter.borrow_mut().add(subs_added); }
                    if user_added { h.users_counter.borrow_mut().add(1); }
                }
            });
        }
    });
}


#[update]
fn unsubscribe(application: Principal, endpoint: String) {
    let caller = api::caller();
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let (removed, user_removed) = {
            let app = st
                .applications
                .get_mut(&application)
                .unwrap_or_else(|| trap("Application not found"));
            app.subscriptions.remove_endpoint(caller, &endpoint)
        };
        if removed > 0 || user_removed {
            PROM.with(|p| {
                if let Some(h) = p.borrow().as_ref() {
                    if removed > 0 {
                        h.subscriptions_counter.borrow_mut().sub(removed);
                    }
                    if user_removed {
                        h.users_counter.borrow_mut().sub(1);
                    }
                }
            });
        }
    });
}

#[update]
fn unsubscribeAll(application: Principal) {
    let caller = api::caller();
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let (removed, user_removed) = {
            let app = st
                .applications
                .get_mut(&application)
                .unwrap_or_else(|| trap("Application not found"));
            app.subscriptions.remove_all_by_user(caller)
        };
        if removed > 0 || user_removed {
            PROM.with(|p| {
                if let Some(h) = p.borrow().as_ref() {
                    if removed > 0 { h.subscriptions_counter.borrow_mut().sub(removed); }
                    if user_removed { h.users_counter.borrow_mut().sub(1); }
                }
            });
        }
    });
}

// App owner interface
#[update]
async fn sendNotifications(arg: Vec<(Principal, NotificationBody)>) -> Vec<bool> {
    let caller = api::caller();
    let arg_len = arg.len();

    // Snapshot the per-input subscriptions; also detect if application exists
    let (app_exists, per_input_subs): (
        bool,
        Vec<(Principal, NotificationBody, Vec<Subscription>)>,
    ) = STATE.with(|s| {
        let st = s.borrow();
        match st.applications.get(&caller) {
            None => (false, Vec::new()),
            Some(app) => {
                let mut out: Vec<(Principal, NotificationBody, Vec<Subscription>)> =
                    Vec::with_capacity(arg_len);
                for (user, body) in arg.iter() {
                    let subs = app.subscriptions.get_user_subs(user);
                    out.push((*user, body.clone(), subs));
                }
                (true, out)
            }
        }
    });

    if !app_exists {
        trap("Application not found");
    }

    let mut results: Vec<bool> = Vec::with_capacity(per_input_subs.len());

    STATE.with(|s| {
        let mut st = s.borrow_mut();
        for (user, body, subs) in per_input_subs.into_iter() {
            let mut any_enqueued = false;
            if subs.is_empty() {
                results.push(false);
                continue;
            }
            for subscription in subs.into_iter() {
                // Skip if relayer is not registered
                if let Some(wr) = st.relayers.get_mut(&subscription.relayer) {
                    if wr.queue.len() < MAX_QUEUE_SIZE {
                        // Enqueue
                        wr.queue.push_back(Notification {
                            subscription: subscription.clone(),
                            body: body.clone(),
                            context: (caller, user),
                        });
                        wr.total_notifications_sent = wr.total_notifications_sent.saturating_add(1);
                        st.total_notifications_sent = st.total_notifications_sent.saturating_add(1);
                        any_enqueued = true;
                    } else {
                        // Queue full for this relayer; skip this subscription
                    }
                } else {
                    // Can never happen: relayer not registered
                }
            }
            results.push(any_enqueued);
        }
    });

    results
}

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayerInfo {
    pub relayer: Principal,
    pub vapid_public_key: String,
    pub registeredAt: u64,
    pub lastUpdatedAt: u64,
    pub description: String,
}

// Relayer interface
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

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeekPage {
    pub items: Vec<EncryptedNotification>,
    pub drained: bool,
}

#[update]
fn updateRelayer(vapid_public_key: String, description: String) {
    let caller = api::caller();
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        let wr = st
            .relayers
            .get_mut(&caller)
            .unwrap_or_else(|| trap("Relayer not registered"));
        wr.vapid_public_key = vapid_public_key;
        wr.description = description;
        wr.last_updated_at = api::time();
    });
}

#[query]
fn peekQueue(offset: u64) -> PeekPage {
    let caller = api::caller();
    STATE.with(|s| {
        let st = s.borrow();
        let wr = st
            .relayers
            .get(&caller)
            .unwrap_or_else(|| trap("Relayer not registered"));

        let total_len = wr.queue.len();
        let start = core::cmp::min(offset as usize, total_len);

        let start_ic = api::instruction_counter();
        let mut items: Vec<EncryptedNotification> = Vec::with_capacity(100);

        for n in wr.queue.iter().skip(start) {
            let mut obj = serde_json::json!({
                "title": n.body.title,
                "body": n.body.content,
            });
            if let Some(url) = &n.body.url {
                if let Some(map) = obj.as_object_mut() {
                    map.insert("url".to_string(), serde_json::Value::String(url.clone()));
                }
            }
            if let Some(tag) = &n.body.tag {
                if let Some(map) = obj.as_object_mut() {
                    map.insert("tag".to_string(), serde_json::Value::String(tag.clone()));
                }
            }
            let payload_bytes = serde_json::to_vec(&obj).unwrap_or_else(|_| Vec::new());

            let encrypted = match (
                b64url_decode(&n.subscription.keys.p256dh),
                b64url_decode(&n.subscription.keys.auth),
            ) {
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

            items.push(EncryptedNotification {
                endpoint: n.subscription.endpoint.clone(),
                contentEncoding: ContentEncoding::Aes128Gcm,
                encrypted,
                context: n.context.clone(),
            });

            if items.len() >= 100
                || api::instruction_counter().saturating_sub(start_ic) > 2_000_000_000u64
            {
                break;
            }
        }

        let drained = start + items.len() >= total_len;
        PeekPage { items, drained }
    })
}

fn encrypt_webpush_aes128gcm(
    user_public_key: &[u8],
    auth_secret: &[u8],
    payload: &[u8],
) -> Option<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    // Deterministic, query-safe Web Push AES-128-GCM per RFC 8291/8188.
    // No RNG used; all values derived from stable inputs via HKDF-SHA256.
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::Aes128Gcm;
    use aes_gcm::Nonce;
    use hkdf::Hkdf;
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use p256::{PublicKey as P256PublicKey, SecretKey as P256SecretKey};
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

    let (total_sent_be, startup_rand) = STATE.with(|s| {
        let st = s.borrow();
        (
            st.total_notifications_sent.to_be_bytes(),
            st.startup_random.clone().unwrap_or_default(),
        )
    });
    // Derive base HKDF from stable inputs plus canister-scoped entropy and counters
    let mut hkdf_ikm = Vec::with_capacity(
        16 + user_public_key.len()
            + auth_secret.len()
            + payload_hash.len()
            + 16
            + startup_rand.len(),
    );
    hkdf_ikm.extend_from_slice(b"ic-webpush-v1");
    hkdf_ikm.extend_from_slice(user_public_key);
    hkdf_ikm.extend_from_slice(auth_secret);
    hkdf_ikm.extend_from_slice(&payload_hash);
    hkdf_ikm.extend_from_slice(&total_sent_be);
    hkdf_ikm.extend_from_slice(&startup_rand);

    let hk = Hkdf::<Sha256>::new(None, &hkdf_ikm);

    // Derive 16-byte salt (RFC 8188 salt)
    let mut salt = [0u8; 16];
    if hk.expand(b"wp-salt", &mut salt).is_err() {
        return None;
    }

    // Derive ephemeral secret key deterministically; ensure non-zero scalar
    let mut ctr: u32 = 0;
    let eph_sk = loop {
        let mut sk_bytes = [0u8; 32];
        // domain separated by counter to avoid bias/zero
        let mut info = Vec::with_capacity(32);
        info.extend_from_slice(b"wp-epk");
        info.extend_from_slice(&ctr.to_be_bytes());
        if hk.expand(&info, &mut sk_bytes).is_err() {
            return None;
        }
        if let Ok(sk) = P256SecretKey::from_slice(&sk_bytes) {
            break sk;
        }
        ctr = ctr.wrapping_add(1);
        if ctr == 0 {
            return None;
        }
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
    if hk_auth.expand(&context, &mut secret32).is_err() {
        return None;
    }

    // prk = HKDF-Extract(salt, secret)
    let (prk, _salt2_unused) = Hkdf::<Sha256>::extract(Some(&salt), &secret32);

    // key = HKDF-Expand(prk, "Content-Encoding: aes128gcm\0", 16)
    // nonce = HKDF-Expand(prk, "Content-Encoding: nonce\0", 12)
    let key_info: &[u8] = b"Content-Encoding: aes128gcm\0";
    let nonce_info: &[u8] = b"Content-Encoding: nonce\0";

    let hk_prk = Hkdf::<Sha256>::from_prk(prk.as_ref()).ok()?;
    let mut cek = [0u8; 16];
    if hk_prk.expand(&key_info, &mut cek).is_err() {
        return None;
    }
    let mut nonce = [0u8; 12];
    if hk_prk.expand(&nonce_info, &mut nonce).is_err() {
        return None;
    }

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
        let wr = st
            .relayers
            .get_mut(&caller)
            .unwrap_or_else(|| trap("Relayer not registered"));
        let amt = core::cmp::min(amount as usize, wr.queue.len());
        for _ in 0..amt {
            wr.queue.pop_front();
        }
    });
}

#[update]
async fn reportBrokenSubscriptions(arg: Vec<(Principal, Principal, String)>) {
    let caller = api::caller();
    STATE.with(|s| {
        let mut st = s.borrow_mut();
        for (application, user, endpoint) in arg.into_iter() {
            let (removed, user_removed) = {
                let app = st
                    .applications
                    .get_mut(&application)
                    .unwrap_or_else(|| trap("Application not found"));
                app.subscriptions.remove_endpoint_by_relayer(user, &endpoint, &caller)
            };
            if removed > 0 || user_removed {
                PROM.with(|p| {
                    if let Some(h) = p.borrow().as_ref() {
                        if removed > 0 {
                            h.subscriptions_counter.borrow_mut().sub(removed);
                        }
                        if user_removed {
                            h.users_counter.borrow_mut().sub(1);
                        }
                    }
                });
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
