# Notification Relayer (Node.js)

This module implements a standalone Node.js relayer that periodically pulls pending web‑push notifications from the Internet Computer (IC) notification canister and dispatches them to subscribers via VAPID/Web Push.

## What it does
- Connects to the IC using an Ed25519 identity (from `RELAYER_ED25519_SECRET_KEY`).
- Uses the relayer‑only queue API: `peekQueue(offset)` to read and `popQueue(amount)` to drain, and reports broken endpoints via `reportBrokenSubscriptions`.
- Runs continuously on a serialized schedule with a target cadence of ~10 seconds between runs:
  - Only one run is active at a time.
  - If a run takes more than 10 seconds, the next run starts immediately after the previous one finishes.
- Graceful shutdown on `SIGINT`/`SIGTERM`.

---

## End‑to‑end: Register and run a relayer
Follow these steps to provision VAPID keys, configure environment, register the relayer in the canister, and run it on your server (Docker).

### 1) Generate VAPID keys
You need a VAPID keypair to send Web Push.

Option A — using the `web-push` CLI (Node):
```bash
npx web-push generate-vapid-keys --json
```
This prints JSON with `publicKey` and `privateKey`.

Option B — using OpenSSL (as an alternative):
```bash
# Generate P-256 key
openssl ecparam -genkey -name prime256v1 -noout -out vapid-private.pem
# Export raw uncompressed public key in base64url (requires small scripting); prefer the CLI above if unsure.
```

You’ll also need a VAPID subject (a contact URL or mailto, e.g. `mailto:ops@example.com`).

### 2) Create `.env` for the relayer
Create `src/relayer/.env` (or copy from `.env.example`) and fill:
```ini
# IC connection
IC_HOST=https://icp-api.io                 # or http://127.0.0.1:4943 for local replica
NOTIFICATION_CANISTER_ID=<canister_id>

# Relayer identity (Ed25519)
# Base64 of 32/64-byte secret. Never commit this.
RELAYER_ED25519_SECRET_KEY=<base64_secret>

# VAPID (Web Push)
VAPID_SUBJECT=mailto:ops@example.com
VAPID_PUBLIC_KEY=<publicKey from step 1>
VAPID_PRIVATE_KEY=<privateKey from step 1>
```
Notes:
- The relayer principal is derived from `RELAYER_ED25519_SECRET_KEY`.
- Keep `.env` private; it’s not copied into Docker images.

To print the relayer principal from your key (optional):
```bash
node -e "const {Ed25519KeyIdentity}=require('@dfinity/identity');
const k=Buffer.from(process.env.KEY,'base64');
console.log(Ed25519KeyIdentity.fromSecretKey(k).getPrincipal().toText());" \
KEY="$RELAYER_ED25519_SECRET_KEY"
```

### 3) Register the relayer in the canister (controller‑only)
A controller of the notification canister must register this relayer principal and advertise the VAPID public key and a description.

```bash
dfx canister --network <ic|local|...> call <NOTIFICATION_CANISTER_ID> \
  registerRelayer '(principal "<RELAYER_PRINCIPAL>", "<VAPID_PUBLIC_KEY>", "<DESCRIPTION>")'
```
- If you see "Caller must be a canister controller", run the command from a controller identity.
- Verify registration:
```bash
dfx canister --network <net> call <ID> listRelayers
# or fetch a single key
dfx canister --network <net> call <ID> getVapidPublicKey '(principal "<RELAYER_PRINCIPAL>")'
```

### 4) Run the relayer on your server using Docker
From `src/relayer`:

1. Ensure `.env` exists:
   ```bash
   cp .env.example .env   # if needed
   # edit .env and paste values from steps above
   ```
2. Make the script executable (first time only):
   ```bash
   chmod +x ./run-docker.sh
   ```
3. Build and start (detached):
   ```bash
   ./run-docker.sh
   ```
4. Tail logs:
   ```bash
   docker logs -f notification-relayer
   ```

The script will:
- Build the image (default tag: `notification-relayer:latest`).
- Stop and remove any existing `notification-relayer` container.
- Start a new detached container with `--env-file .env` and `--restart unless-stopped`.

---

## Local development (without Docker)
From `src/relayer`:

1. Install dependencies:
   ```bash
   npm ci
   ```
2. Build TypeScript to JavaScript:
   ```bash
   npm run build
   ```
3. Run once (single cycle):
   ```bash
   npm run start:once
   ```
4. Run continuously (every ~10s):
   ```bash
   npm run start
   ```

## Docker references
- `Dockerfile` — Multi-stage build on `node:20-alpine`. Builds the relayer and runs `node dist/index.js`.
- `.dockerignore` — Excludes development files and prevents `.env` from being copied into the image.
- `run-docker.sh` — Helper script that builds the image and starts a detached container.

### Run a single cycle in Docker
```bash
./run-docker.sh --once
```

### Stop/remove
```bash
# Stop and remove the container
docker rm -f notification-relayer

# Remove the image (optional)
docker rmi notification-relayer:latest
```

### Configuration
Override image/container names when invoking the script:
```bash
IMAGE_NAME=myorg/notification-relayer:latest \
CONTAINER_NAME=notification-relayer-prod \
./run-docker.sh
```

## Security & troubleshooting
- Keep `RELAYER_ED25519_SECRET_KEY` and VAPID private key secret.
- If you see "canister does not belong to any subnet", ensure `IC_HOST` matches the network where the canister is deployed.
- For local replicas, the relayer automatically attempts `agent.fetchRootKey()`.
- If `registerRelayer` fails with permissions, use a controller identity.
- If push requests fail with 401/403, verify `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` are correct and that the browser subscription matches the advertised VAPID public key.
