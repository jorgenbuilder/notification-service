# notification-service

## Local development

For a step-by-step guide to running the full stack — notification canister, relayer, an app canister, and a browser — on a single machine, see [LOCAL_DEV.md](./LOCAL_DEV.md).

## Consuming via `dfx deps pull`

Downstream apps can pull the released wasm directly — no vendoring, no rebuilding. In your project's `dfx.json`:

```json
{
  "canisters": {
    "notification_canister": {
      "type": "pull",
      "id": "zjwxf-jyaaa-aaaao-a43ca-cai"
    }
  }
}
```

Then `dfx deps pull && dfx deps init && dfx deps deploy` against a local replica. dfx fetches the released wasm from the URL embedded in the canister's `dfx` metadata, verifies its sha256 against the on-chain module hash, and installs it under the same canister id.

## Tests

If `cargo test -p notification-canister` appears to use an old Wasm, build the canister Wasm first, then run the tests from the repository root:

```bash
cargo build --release --target wasm32-unknown-unknown
cargo test -p notification-canister
```

Notes:
- The tests for the notification canister live in `src/notification-canister/tests/` and load the compiled Wasm from `target/wasm32-unknown-unknown/release/notification_canister.wasm`.
- If your build output differs, set the `NOTIF_CANISTER_WASM` env var to the correct path before running tests.
