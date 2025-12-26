# Notification Worker (Node.js)

This module implements a standalone Node.js worker that periodically pulls pending web push notifications from the Internet Computer (IC) notification canister and dispatches them to subscribers via the `web-push` library.

## What it does
- Connects to the IC using an Ed25519 identity (from `WORKER_ED25519_SECRET_KEY`).
- Checks the notification canister queue (`isQueueEmpty`), collects pending notifications (`collect`), and sends them via Web Push.
- Runs continuously on a serialized schedule with a target cadence of ~10 seconds between runs:
  - Only one run is active at a time.
  - If a run takes more than 10 seconds, the next run starts immediately after the previous one finishes.
- Graceful shutdown on `SIGINT`/`SIGTERM`.

## Environment variables
Create `.env` in `src/worker/` (see `.env.example`). Never commit secrets.

Required variables:
- `IC_HOST` — IC public API host. Example: `https://icp-api.io` (mainnet). For local development you can set `http://127.0.0.1:4943`.
- `NOTIFICATION_CANISTER_ID` — ID of the deployed notification canister on the target network.
- `WORKER_ED25519_SECRET_KEY` — Base64-encoded Ed25519 secret (seed or secret+public, 32 or 64 bytes).

## Local development (without Docker)
From the `src/worker` directory:

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

## Docker usage
This module includes a Dockerfile and a helper script to build and run the worker container.

### Files
- `Dockerfile` — Multi-stage build on `node:20-alpine`. Builds the worker and runs `node dist/index.js`.
- `.dockerignore` — Excludes development files and prevents `.env` from being copied into the image.
- `run-docker.sh` — Simple script that builds the image and starts a detached container.

### Build and run (detached)
From `src/worker`:

1. Ensure `.env` exists (copy from `.env.example` and fill values):
   ```bash
   cp .env.example .env
   # edit .env
   ```
2. Make the script executable (first time only):
   ```bash
   chmod +x ./run-docker.sh
   ```
3. Build the image and start the container (detached):
   ```bash
   ./run-docker.sh
   ```

The script will:
- Build the image (default tag: `notification-worker:latest`).
- Stop and remove any existing `notification-worker` container.
- Start a new detached container with `--env-file .env` and `--restart unless-stopped`.

### Run a single cycle
To start a container that runs exactly one cycle and exits:
```bash
./run-docker.sh --once
```

### Logs
Tail logs from the running container:
```bash
docker logs -f notification-worker
```

### Stop/remove
```bash
# Stop and remove the container
docker rm -f notification-worker

# Remove the image (optional)
docker rmi notification-worker:latest
```

### Configuration
You can override image and container names via environment variables when invoking the script:
```bash
IMAGE_NAME=myorg/notification-worker:latest \
CONTAINER_NAME=notification-worker-prod \
./run-docker.sh
```

## Server deployment workflow
On your server:
1. Clone the repository.
2. Navigate to `src/worker`.
3. Create `.env` from `.env.example` and fill the values.
4. Execute:
   ```bash
   chmod +x ./run-docker.sh
   ./run-docker.sh
   ```
5. Verify logs with `docker logs -f notification-worker`.

## Security notes
- The `.env` file is not copied into the image (see `.dockerignore`). It is mounted into the container at runtime via `--env-file`.
- Keep your secret key (`WORKER_ED25519_SECRET_KEY`) safe and out of version control.

## Troubleshooting
- If you see errors like "canister does not belong to any subnet", ensure `IC_HOST` matches the network where the canister ID is deployed (e.g., mainnet vs local replica).
- If `IC_HOST` is a local replica, the worker automatically attempts to fetch the root key.
- Connection/timeout issues may be transient; the scheduler will retry every ~10 seconds.
