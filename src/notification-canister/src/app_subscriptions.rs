use candid::CandidType;
use candid::Principal;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::Subscription;

#[derive(Clone, Debug, CandidType, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppSubscriptions {
    pub subscriptions: BTreeMap<Principal, Vec<Subscription>>, // user -> subscriptions
    pub relayer_index: BTreeMap<Principal, Vec<Principal>>,    // relayer -> users
}

impl AppSubscriptions {
    pub fn new() -> Self {
        Self { subscriptions: BTreeMap::new(), relayer_index: BTreeMap::new() }
    }

    pub fn has_endpoint(&self, user: &Principal, endpoint: &str) -> bool {
        self.subscriptions
            .get(user)
            .map(|v| v.iter().any(|s| s.endpoint == endpoint))
            .unwrap_or(false)
    }

    pub fn user_has_relayer(&self, user: &Principal, relayer: &Principal) -> bool {
        self.subscriptions
            .get(user)
            .map(|v| v.iter().any(|s| &s.relayer == relayer))
            .unwrap_or(false)
    }

    fn ensure_index_user(&mut self, relayer: Principal, user: Principal) {
        let vec = self.relayer_index.entry(relayer).or_insert_with(Vec::new);
        if !vec.iter().any(|u| *u == user) {
            vec.push(user);
        }
    }

    fn maybe_remove_index_user(&mut self, relayer: &Principal, user: &Principal) {
        if let Some(vec) = self.relayer_index.get_mut(relayer) {
            vec.retain(|u| u != user);
            if vec.is_empty() {
                self.relayer_index.remove(relayer);
            }
        }
    }

    pub fn add(&mut self, user: Principal, sub: Subscription) -> (u128, u128, bool, bool) {
        let mut subs_added = 0u128;
        let subs_removed = 0u128;
        let mut user_added = false;
        let user_removed = false;

        let entry = self.subscriptions.entry(user).or_insert_with(|| {
            user_added = true;
            Vec::new()
        });

        if let Some(idx) = entry.iter().position(|s| s.endpoint == sub.endpoint) {
            let old_relayer = entry[idx].relayer;
            entry[idx] = sub.clone();
            // index maintenance
            self.ensure_index_user(sub.relayer, user);
            if old_relayer != sub.relayer {
                if !self.user_has_relayer(&user, &old_relayer) {
                    self.maybe_remove_index_user(&old_relayer, &user);
                }
            }
        } else {
            entry.push(sub.clone());
            subs_added = 1;
            self.ensure_index_user(sub.relayer, user);
        }
        (subs_added, subs_removed, user_added, user_removed)
    }

    pub fn remove_endpoint(&mut self, user: Principal, endpoint: &str) -> (u128, bool) {
        if let Some(list) = self.subscriptions.get_mut(&user) {
            let relayer_opt = list.iter().find(|s| s.endpoint == endpoint).map(|s| s.relayer);
            let before = list.len();
            list.retain(|s| s.endpoint != endpoint);
            let after = list.len();
            let removed = (before.saturating_sub(after)) as u128;
            let user_removed = after == 0 && before > 0;
            if user_removed {
                self.subscriptions.remove(&user);
            }
            if removed > 0 {
                if let Some(rel) = relayer_opt.as_ref() {
                    if !self.user_has_relayer(&user, rel) {
                        self.maybe_remove_index_user(rel, &user);
                    }
                }
            }
            (removed, user_removed)
        } else {
            (0, false)
        }
    }

    pub fn remove_endpoint_by_relayer(&mut self, user: Principal, endpoint: &str, relayer: &Principal) -> (u128, bool) {
        if let Some(list) = self.subscriptions.get_mut(&user) {
            let before = list.len();
            list.retain(|s| !(s.endpoint == endpoint && &s.relayer == relayer));
            let after = list.len();
            let removed = (before.saturating_sub(after)) as u128;
            let user_removed = after == 0 && before > 0;
            if user_removed {
                self.subscriptions.remove(&user);
            }
            if removed > 0 {
                if !self.user_has_relayer(&user, relayer) {
                    self.maybe_remove_index_user(relayer, &user);
                }
            }
            (removed, user_removed)
        } else { (0, false) }
    }

    pub fn remove_all_by_user(&mut self, user: Principal) -> (u128, bool) {
        if let Some(list) = self.subscriptions.get(&user) {
            let removed = list.len() as u128;
            let relayers: Vec<Principal> = list.iter().map(|s| s.relayer).collect();
            for r in relayers.iter() {
                self.maybe_remove_index_user(r, &user);
            }
            self.subscriptions.remove(&user);
            (removed, removed > 0)
        } else {
            (0, false)
        }
    }

    pub fn remove_all_by_relayer(&mut self, relayer: Principal) -> (u128, u128) {
        let users = self.relayer_index.get(&relayer).cloned().unwrap_or_default();
        let mut subs_removed = 0u128;
        let mut users_removed = 0u128;
        for user in users.iter() {
            if let Some(list) = self.subscriptions.get_mut(user) {
                let before = list.len();
                list.retain(|s| s.relayer != relayer);
                let after = list.len();
                if after < before {
                    subs_removed = subs_removed.saturating_add((before - after) as u128);
                }
                if after == 0 && before > 0 {
                    self.subscriptions.remove(user);
                    users_removed = users_removed.saturating_add(1);
                }
            }
        }
        self.relayer_index.remove(&relayer);
        (subs_removed, users_removed)
    }

    pub fn get_user_subs(&self, user: &Principal) -> Vec<Subscription> {
        self.subscriptions.get(user).cloned().unwrap_or_default()
    }
}
