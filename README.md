# notification-service

## Tests

If `cargo test -p notification-canister` appears to use an old Wasm, build the canister Wasm first, then run the tests from the repository root:

```bash
cargo build --release --target wasm32-unknown-unknown
cargo test -p notification-canister
```

Notes:
- The tests for the notification canister live in `src/notification-canister/tests/` and load the compiled Wasm from `target/wasm32-unknown-unknown/release/notification_canister.wasm`.
- If your build output differs, set the `NOTIF_CANISTER_WASM` env var to the correct path before running tests.
