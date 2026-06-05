#!/bin/bash
# Start the CP-SAT solver backend.
# Creates a venv and installs pinned dependencies from requirements.txt.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="${HOME}/.cpsat-venv"
PORT="${CPSAT_PORT:-8090}"
HOST="${CPSAT_HOST:-127.0.0.1}"
REQ="$SCRIPT_DIR/requirements.txt"
# Number of gunicorn worker *processes*. Each is a separate Python
# interpreter with its own ortools instance, so the OR-Tools "shared C++
# state" caveat (which is about threading within one process) does not
# apply. Bumping this lets multiple /solve requests run in parallel —
# pair with CPSAT_NUM_WORKERS=1 so the total core demand stays bounded.
# Default 1 keeps the historical behaviour for any host that hasn't
# explicitly opted in.
WORKERS="${CPSAT_GUNICORN_WORKERS:-1}"

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python venv at $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
fi

# Install / sync pinned deps. `pip install -r` is idempotent — no-op on match.
INSTALLED_HASH="$VENV_DIR/.requirements.sha256"
NEW_HASH="$(sha256sum "$REQ" | awk '{print $1}')"
if [ ! -f "$INSTALLED_HASH" ] || [ "$(cat "$INSTALLED_HASH")" != "$NEW_HASH" ]; then
    echo "Installing/updating Python deps from requirements.txt..."
    "$VENV_DIR/bin/pip" install --quiet -r "$REQ"
    echo "$NEW_HASH" > "$INSTALLED_HASH"
fi

echo "Starting CP-SAT solver on $HOST:$PORT (workers=$WORKERS)..."
# -w $WORKERS: gunicorn worker processes (each a separate Python+ortools
#   instance; >1 unlocks parallel /solve handling — see WORKERS comment above)
# -t 60: worker timeout — hung solves are killed and respawned, preventing sidecar lockup
# --chdir so gunicorn can import cpsat_server:app from SCRIPT_DIR
"$VENV_DIR/bin/gunicorn" \
    -w "$WORKERS" -t 60 \
    -b "$HOST:$PORT" \
    --access-logfile - \
    --chdir "$SCRIPT_DIR" \
    cpsat_server:app &
GUNICORN_PID=$!

# Readiness probe: /health must respond within 10s of launch.
cleanup_on_fail() {
    kill "$GUNICORN_PID" 2>/dev/null || true
    wait "$GUNICORN_PID" 2>/dev/null || true
    echo "CP-SAT solver failed to become healthy within 10s" >&2
    exit 1
}

ready=0
for _ in $(seq 1 20); do
    if ! kill -0 "$GUNICORN_PID" 2>/dev/null; then
        echo "gunicorn exited before becoming ready" >&2
        exit 1
    fi
    if curl -sf -o /dev/null --max-time 1 "http://${HOST}:${PORT}/health"; then
        ready=1
        break
    fi
    sleep 0.5
done

if [ "$ready" -ne 1 ]; then
    cleanup_on_fail
fi

echo "CP-SAT solver ready on $HOST:$PORT."

# Forward SIGTERM/SIGINT to gunicorn so the process group shuts down cleanly.
trap 'kill -TERM "$GUNICORN_PID" 2>/dev/null; wait "$GUNICORN_PID"' TERM INT
wait "$GUNICORN_PID"
