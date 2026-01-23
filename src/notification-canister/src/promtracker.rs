use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use candid::CandidType;
use ic_cdk::api::{canister_balance128, time};
use serde::{Deserialize, Serialize};

pub type Metric = (String, String, u128);

#[derive(Clone, CandidType, Serialize, Deserialize)]
pub enum StableDataItem {
    Counter(u128),
}

pub type StableData = Vec<(String, StableDataItem)>;

trait Value {
    fn prefix(&self) -> &str;
    fn labels(&self) -> &str;
    fn dump(&self) -> Vec<Metric>;
    fn share(&self) -> Option<StableDataItem>;
    fn unshare(&mut self, data: &StableDataItem);
}

pub struct PullValue {
    prefix: String,
    labels: String,
    pull: Box<dyn Fn() -> u128>,
}

impl Value for PullValue {
    fn prefix(&self) -> &str {
        &self.prefix
    }
    fn labels(&self) -> &str {
        &self.labels
    }

    fn dump(&self) -> Vec<Metric> {
        vec![(self.prefix.clone(), self.labels.clone(), (self.pull)())]
    }

    fn share(&self) -> Option<StableDataItem> {
        None
    }
    fn unshare(&mut self, _: &StableDataItem) {}
}

pub struct CounterValue {
    prefix: String,
    labels: String,
    stable: bool,
    value: u128,
}

impl CounterValue {
    pub fn add(&mut self, v: u128) {
        self.value += v;
    }
    pub fn sub(&mut self, v: u128) {
        self.value = self.value.saturating_sub(v);
    }
    pub fn set(&mut self, v: u128) {
        self.value = v;
    }
    pub fn get(&self) -> u128 {
        self.value
    }
}

impl Value for CounterValue {
    fn prefix(&self) -> &str {
        &self.prefix
    }
    fn labels(&self) -> &str {
        &self.labels
    }

    fn dump(&self) -> Vec<Metric> {
        vec![(self.prefix.clone(), self.labels.clone(), self.value)]
    }

    fn share(&self) -> Option<StableDataItem> {
        if self.stable {
            Some(StableDataItem::Counter(self.value))
        } else {
            None
        }
    }

    fn unshare(&mut self, data: &StableDataItem) {
        if let (StableDataItem::Counter(v), true) = (data, self.stable) {
            self.value = *v;
        }
    }
}

pub struct PromTracker {
    static_labels: String,
    values: Vec<Option<Rc<RefCell<dyn Value>>>>,
}

impl PromTracker {
    pub fn new(static_labels: impl Into<String>) -> Self {
        Self {
            static_labels: static_labels.into(),
            values: Vec::new(),
        }
    }

    pub fn add_pull<F>(&mut self, prefix: &str, labels: &str, f: F) -> usize
    where
        F: Fn() -> u128 + 'static,
    {
        let id = self.values.len();
        let v = PullValue {
            prefix: prefix.to_string(),
            labels: labels.to_string(),
            pull: Box::new(f),
        };
        self.values.push(Some(Rc::new(RefCell::new(v))));
        id
    }

    pub fn add_counter(
        &mut self,
        prefix: &str,
        labels: &str,
        stable: bool,
    ) -> Rc<RefCell<CounterValue>> {
        let v = Rc::new(RefCell::new(CounterValue {
            prefix: prefix.to_string(),
            labels: labels.to_string(),
            stable,
            value: 0,
        }));
        self.values.push(Some(v.clone()));
        v
    }

    pub fn remove(&mut self, id: usize) {
        if let Some(slot) = self.values.get_mut(id) {
            *slot = None;
        }
    }

    pub fn dump(&self) -> Vec<Metric> {
        let mut out = Vec::new();
        for v in &self.values {
            if let Some(val) = v {
                out.extend(val.borrow().dump());
            }
        }
        out
    }

    fn concat_labels(a: &str, b: &str) -> String {
        if a.is_empty() {
            return b.to_string();
        }
        if b.is_empty() {
            return a.to_string();
        }
        format!("{},{}", a, b)
    }

    fn render_metric(m: &Metric, global: &str, ts: u64) -> String {
        let (name, labels, val) = m;
        format!(
            "{}{{{}}} {} {}\n",
            name,
            Self::concat_labels(global, labels),
            val,
            ts
        )
    }

    pub fn render(&self, dynamic_labels: &str) -> String {
        let ts = time() / 1_000_000;
        let global = Self::concat_labels(&self.static_labels, dynamic_labels);
        self.dump()
            .iter()
            .map(|m| Self::render_metric(m, &global, ts))
            .collect()
    }

    fn stable_key(v: &dyn Value) -> String {
        if v.labels().is_empty() {
            v.prefix().to_string()
        } else {
            format!("{}{{{}}}", v.prefix(), v.labels())
        }
    }

    pub fn share(&self) -> StableData {
        let mut out = Vec::new();
        for v in &self.values {
            if let Some(val) = v {
                let val = val.borrow();
                if let Some(data) = val.share() {
                    out.push((Self::stable_key(&*val), data));
                }
            }
        }
        out
    }

    pub fn unshare(&mut self, data: StableData) {
        let map: HashMap<_, _> = data.into_iter().collect();
        for v in &self.values {
            if let Some(val) = v {
                let key = Self::stable_key(&*val.borrow());
                if let Some(stable) = map.get(&key) {
                    val.borrow_mut().unshare(stable);
                }
            }
        }
    }

    pub fn add_system_metrics(&mut self) {
        self.add_pull("cycles_balance", "", || canister_balance128());
        self.add_pull("canister_version", "", || {
            ic_cdk::api::canister_version() as u128
        });
        self.add_pull("stable_memory_pages", "", || {
            ic_cdk::api::stable::stable64_size() as u128
        });
        self.add_pull("stable_memory_bytes", "", || {
            (ic_cdk::api::stable::stable64_size() as u128) * 65_536u128
        });
        self.add_pull("rts_stable_memory_size", "", || {
            ic_cdk::api::stable::stable64_size() as u128
        });
        self.add_pull("rts_logical_stable_memory_size", "", || {
            ic_cdk::api::stable::stable64_size() as u128
        });
    }
}
