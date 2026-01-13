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
#[query]
fn peekQueue() -> Vec<Notification> {
    let caller = api::caller();
    STATE.with(|s| {
        let st = s.borrow();
        if caller != st.worker {
            trap("Only worker can use this interface");
        }
        st.notifications_queue.iter().take(100).cloned().collect()
    })
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
