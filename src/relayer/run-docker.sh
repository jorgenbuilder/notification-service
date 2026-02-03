#!/usr/bin/env sh
set -euo pipefail

# Simple helper to build the Docker image and run the relayer container detached.
# Usage:
#   ./run-docker.sh            # build and start the scheduler
#   ./run-docker.sh --once     # run a single cycle (container exits when done)
#   IMAGE_NAME=mytag ./run-docker.sh   # override image tag
#   CONTAINER_NAME=myname ./run-docker.sh --once

IMAGE_NAME=${IMAGE_NAME:-notification-relayer:latest}
CONTAINER_NAME=${CONTAINER_NAME:-notification-relayer}
BUILD_CONTEXT_DIR=$(dirname "$0")

cd "$BUILD_CONTEXT_DIR"

if [ ! -f .env ]; then
  echo "[run-docker] ERROR: .env file not found in $(pwd)."
  echo "Copy .env.example to .env and fill the values before running."
  exit 1
fi

echo "[run-docker] Building image: $IMAGE_NAME"
DOCKER_BUILDKIT=1 docker build -t "$IMAGE_NAME" .

# Stop and remove an existing container with the same name, if any
if [ "$(docker ps -aq -f name=^${CONTAINER_NAME}$)" ]; then
  echo "[run-docker] Found existing container '$CONTAINER_NAME'. Stopping/removing..."
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

# If user passed arguments (e.g., --once), forward them to the container CMD
EXTRA_ARGS="$@"

echo "[run-docker] Starting container: $CONTAINER_NAME"
if [ -n "$EXTRA_ARGS" ]; then
  echo "[run-docker] Forwarding args to node: $EXTRA_ARGS"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --env-file .env \
    --restart unless-stopped \
    "$IMAGE_NAME" $EXTRA_ARGS
else
  docker run -d \
    --name "$CONTAINER_NAME" \
    --env-file .env \
    --restart unless-stopped \
    "$IMAGE_NAME"
fi

echo "[run-docker] Done. Tail logs with: docker logs -f $CONTAINER_NAME"
