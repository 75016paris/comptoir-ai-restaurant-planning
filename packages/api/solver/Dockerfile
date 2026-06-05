# CP-SAT solver sidecar. Stateless HTTP server, one POST /solve per request.
# Deployable to Cloud Run (scale-to-zero, concurrency=1) or any container host.

FROM python:3.11-slim AS base

# Non-root user — Cloud Run accepts any UID but least-privilege is good hygiene.
RUN useradd --create-home --uid 1001 solver

WORKDIR /app

# Install pinned deps first for cache efficiency.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy server.
COPY cpsat_server.py .

USER solver

# Cloud Run sends traffic to $PORT (default 8080). Fall back to CPSAT_PORT locally.
ENV PORT=8080 \
    CPSAT_HOST=0.0.0.0 \
    CPSAT_RANDOM_SEED=42 \
    CPSAT_NUM_WORKERS=0 \
    GUNICORN_WORKERS=1 \
    PYTHONUNBUFFERED=1

EXPOSE 8080

# Shell form so $PORT env var is expanded at start.
# -w $GUNICORN_WORKERS: gunicorn worker processes. >1 unlocks parallel /solve
#   handling — bump for VPS-style hosts, keep at 1 for Cloud-Run-style
#   concurrency=1 deployments. Pair with CPSAT_NUM_WORKERS=1 when scaling out.
# -t 60: worker timeout — hung solves are killed and respawned, preventing lockup.
CMD gunicorn -w "$GUNICORN_WORKERS" -t 60 -b "$CPSAT_HOST:$PORT" --access-logfile - cpsat_server:app
