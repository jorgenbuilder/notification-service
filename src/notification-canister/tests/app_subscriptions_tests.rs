use candid::Principal;
use notification_canister::{AppSubscriptions, Subscription, SubscriptionKeys};

fn principal(id: u8) -> Principal {
    Principal::from_slice(&[id])
}

fn sub(endpoint: &str, relayer: Principal) -> Subscription {
    Subscription {
        endpoint: endpoint.to_string(),
        expirationTime: None,
        keys: SubscriptionKeys { p256dh: "k".into(), auth: "a".into() },
        relayer,
    }
}

#[test]
fn new_is_empty() {
    let app = AppSubscriptions::new();
    assert!(app.subscriptions.is_empty());
    assert!(app.relayer_index.is_empty());
}

#[test]
fn add_and_query_and_index_maintenance() {
    let mut app = AppSubscriptions::new();
    let u = principal(10);
    let r1 = principal(1);
    let r2 = principal(2);

    // Add first subscription E1@R1
    let (subs_added, subs_removed, user_added, user_removed) = app.add(u, sub("e1", r1));
    assert_eq!((subs_added, subs_removed, user_added, user_removed), (1, 0, true, false));
    assert!(app.has_endpoint(&u, "e1"));
    assert!(app.user_has_relayer(&u, &r1));
    assert_eq!(app.get_user_subs(&u).len(), 1);
    assert_eq!(app.relayer_index.get(&r1), Some(&vec![u]));

    // Add second subscription E2@R1
    let (subs_added, subs_removed, user_added, user_removed) = app.add(u, sub("e2", r1));
    assert_eq!((subs_added, subs_removed, user_added, user_removed), (1, 0, false, false));
    assert!(app.has_endpoint(&u, "e2"));
    assert!(app.user_has_relayer(&u, &r1));
    assert_eq!(app.relayer_index.get(&r1), Some(&vec![u]));

    // Add third subscription E3@R2
    let (subs_added, _, _, _) = app.add(u, sub("e3", r2));
    assert_eq!(subs_added, 1);
    assert!(app.user_has_relayer(&u, &r2));
    {
        let v = app.relayer_index.get(&r2).cloned().unwrap_or_default();
        assert!(v.contains(&u));
    }

    // Replace E1 with new relayer R2 (move endpoint between relayers)
    let (subs_added, subs_removed, user_added, user_removed) = app.add(u, sub("e1", r2));
    assert_eq!((subs_added, subs_removed, user_added, user_removed), (0, 0, false, false));
    assert!(app.has_endpoint(&u, "e1"));
    assert!(app.user_has_relayer(&u, &r2));
    // R1 should still have the user because E2@R1 still exists
    {
        let v = app.relayer_index.get(&r1).cloned().unwrap_or_default();
        assert!(v.contains(&u));
    }

    // Remove E2 (last sub for R1) -> user must be removed from R1 index
    let (removed, user_removed_flag) = app.remove_endpoint(u, "e2");
    assert_eq!((removed, user_removed_flag), (1, false));
    assert!(app.relayer_index.get(&r1).is_none());
    // Still has subscriptions under R2
    assert!(app.user_has_relayer(&u, &r2));

    // Removing non-existent endpoint
    let (removed, user_removed_flag) = app.remove_endpoint(u, "does-not-exist");
    assert_eq!((removed, user_removed_flag), (0, false));
}

#[test]
fn remove_endpoint_by_relayer() {
    let mut app = AppSubscriptions::new();
    let u = principal(11);
    let r1 = principal(1);
    let r2 = principal(2);
    app.add(u, sub("e1", r1));
    app.add(u, sub("e2", r2));

    // Wrong relayer -> nothing removed
    let (removed, user_removed) = app.remove_endpoint_by_relayer(u, "e1", &r2);
    assert_eq!((removed, user_removed), (0, false));
    assert!(app.has_endpoint(&u, "e1"));
    assert!(app.user_has_relayer(&u, &r1));

    // Correct relayer -> remove just that endpoint
    let (removed, user_removed) = app.remove_endpoint_by_relayer(u, "e1", &r1);
    assert_eq!((removed, user_removed), (1, false));
    assert!(!app.has_endpoint(&u, "e1"));
    // User still exists because e2@r2 remains
    assert!(app.has_endpoint(&u, "e2"));
    assert!(app.user_has_relayer(&u, &r2));
    // r1 index cleaned up
    assert!(app.relayer_index.get(&r1).is_none());
}

#[test]
fn remove_all_by_user() {
    let mut app = AppSubscriptions::new();
    let u = principal(12);
    let r1 = principal(1);
    let r2 = principal(2);
    app.add(u, sub("e1", r1));
    app.add(u, sub("e2", r2));

    let (removed, user_removed) = app.remove_all_by_user(u);
    assert_eq!((removed, user_removed), (2, true));
    assert!(app.get_user_subs(&u).is_empty());
    assert!(app.relayer_index.get(&r1).is_none());
    assert!(app.relayer_index.get(&r2).is_none());
}

#[test]
fn remove_all_by_relayer_across_users() {
    let mut app = AppSubscriptions::new();
    let u1 = principal(21);
    let u2 = principal(22);
    let r1 = principal(1);
    let r2 = principal(2);

    // u1: e1@r1, e2@r2
    app.add(u1, sub("e1", r1));
    app.add(u1, sub("e2", r2));
    // u2: e3@r2 only
    app.add(u2, sub("e3", r2));

    let (subs_removed, users_removed) = app.remove_all_by_relayer(r2);
    // Two subscriptions removed: u1:e2 and u2:e3
    assert_eq!(subs_removed, 2);
    // One user removed entirely: u2 had only r2
    assert_eq!(users_removed, 1);

    // Check remaining state
    assert!(app.get_user_subs(&u2).is_empty());
    assert!(app.relayer_index.get(&r2).is_none());
    // u1 remains with e1@r1
    let subs = app.get_user_subs(&u1);
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].endpoint, "e1");
    assert_eq!(subs[0].relayer, r1);
    let idx = app.relayer_index.get(&r1).cloned().unwrap_or_default();
    assert!(idx.contains(&u1));
}