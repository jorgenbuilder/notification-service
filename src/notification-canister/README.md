# Notification Canister

This Rust canister powers the web‑push notification flow for applications running on the Internet Computer. It stores user subscriptions per application, accepts notification requests from application managers, and exposes a worker‑only queue interface for an off‑chain worker to deliver push messages to endpoints.

## What this canister is for

- Manage applications and their user subscriptions (Web Push `endpoint` + keys).
- Allow application owners (managers) to enqueue notifications for specific users via `sendNotifications`.
- Maintain a FIFO notifications queue that an external worker process can read (`peekQueue`) and drain (`popQueue`).
- Provide deterministic AES‑128‑GCM web‑push payload encryption for compatible subscriptions when valid keys are present (encryption is optional; queue mechanics work regardless).

### High‑level interfaces

- End‑user:
  - `subscribe(application, subscription)` / `unsubscribe` / `unsubscribeAll`
  - `hasSubscription(application, endpoint)`
  - `getVapidPublicKey()`
- Application owner (manager == caller):
  - `sendNotifications([(user, NotificationBody)])`
- Worker (designated at init):
  - `peekQueue(offset) -> ([EncryptedNotification], isDrained)` (up to 100, FIFO)
  - `popQueue(amount)`
  - `reportBrokenSubscriptions([(application, user, endpoint)])`


## How to run the tests

The tests for this canister are Rust integration tests that use PocketIC to simulate the IC locally. They live in `src/notification-canister/tests/queue.rs` and focus on the notifications queue mechanics (ordering, access control, safe popping).

### Prerequisites

- Rust toolchain (stable)
- The workspace dependencies will pull `pocket-ic` for tests

### 1) Build the canister Wasm

The tests load the compiled Wasm of this canister. Build it once before running tests:

```bash
# From the repository root
cargo build --release --target wasm32-unknown-unknown
```

By default, tests look for the binary at:

```
src/notification-canister/../../target/wasm32-unknown-unknown/release/notification_canister.wasm
```

You can override the path via the `NOTIF_CANISTER_WASM` environment variable if your build output differs, for example:

```bash
NOTIF_CANISTER_WASM=/absolute/path/to/notification_canister.wasm \
  cargo test -p notification-canister
```

### 2) Run the tests for this crate

From the repository root:

```bash
cargo test -p notification-canister
```

This will execute the integration tests under `src/notification-canister/tests/`.

### Running a single test

```bash
cargo test -p notification-canister notifications_queue_basic_flow
```

### Troubleshooting

- "WASM not found" error in tests: make sure you have built the Wasm first (step 1), or set `NOTIF_CANISTER_WASM` to the correct file.
- Build features: the canister uses pure‑Rust crypto crates and does not require OpenSSL.
- If you changed the package name or target paths, re‑run the build and adjust `NOTIF_CANISTER_WASM` accordingly.


## Notes

- The queue is FIFO and capped per `peekQueue` call (returns up to 100 items or stops early if instruction budget is approached). Use repeated `peekQueue` + `popQueue` cycles in your worker.
- Access control:
  - Only the configured worker principal can call `peekQueue`, `popQueue`, and `reportBrokenSubscriptions`.
  - Only canister controllers can `registerApplication`/`deregisterApplication`.
  - `sendNotifications` can be called by the application manager principal (the application is keyed by manager principal in this implementation).
- Encryption:
  - When subscription keys are valid (base64url P‑256 key and auth secret), payloads are deterministically encrypted as `aes128gcm`. If keys are invalid/missing, `encrypted` is `None` so workers can still deliver plain notifications or handle accordingly.
