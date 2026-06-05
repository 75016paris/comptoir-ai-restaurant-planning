# Local Multi-Restaurant Smoke

This runbook mounts the isolated `comptoir_multi` worktree locally against a copied SQLite database. It is for product smoke only; it does not deploy, replace VPS files, or switch Phase 7 runtime storage.

## Inputs

- Worktree: `/Users/pr/PROJECTS/comptoir_multi`
- Copied SQLite DB path, usually `/Users/pr/PROJECTS/comptoir_multi/packages/api/comptoir.db`
- If the source DB was live at copy time, copy the matching `comptoir.db-wal` and `comptoir.db-shm` files too before opening the copy.
- Database migrated through at least `0120` for multi-restaurant release smoke, and through `0122` for Phase 7 readiness smoke.

## Preflight

Run these from `/Users/pr/PROJECTS/comptoir_multi`:

```sh
bun run verify:multi-restaurant
DATABASE_URL=/Users/pr/PROJECTS/comptoir_multi/packages/api/comptoir.db bun run --cwd packages/api db:check-multi-restaurant
DATABASE_URL=/Users/pr/PROJECTS/comptoir_multi/packages/api/comptoir.db bun run --cwd packages/api phase7:readiness-preflight -- --out /private/tmp/comptoir-phase7-local-readiness --report /private/tmp/comptoir-phase7-local-readiness.json
```

For a disposable smoke DB, copy the SQLite triplet into `/private/tmp` and point `DATABASE_URL` there:

```sh
SMOKE_DIR=$(mktemp -d /private/tmp/comptoir-local-smoke-XXXXXX)
cp /Users/pr/PROJECTS/comptoir_multi/packages/api/comptoir.db "$SMOKE_DIR/comptoir.db"
cp /Users/pr/PROJECTS/comptoir_multi/packages/api/comptoir.db-wal "$SMOKE_DIR/comptoir.db-wal"
cp /Users/pr/PROJECTS/comptoir_multi/packages/api/comptoir.db-shm "$SMOKE_DIR/comptoir.db-shm"
DATABASE_URL="$SMOKE_DIR/comptoir.db" bun run --cwd packages/api db:check-multi-restaurant
```

For the archived Phase 7 report, add the strict assertion once the expected copied-DB counts are known:

```sh
bun run --cwd packages/api phase7:assert-readiness-report -- --report /private/tmp/comptoir-phase7-local-readiness.json --require-snapshot-dir --expect-snapshot-dir /private/tmp/comptoir-phase7-local-readiness --max-report-age-minutes 60 --expect-owner-count ... --expect-restaurant-count ... --expect-user-count ... --expect-service-count ... --expect-document-count ... --expect-notification-count ... --expect-chat-message-count ... --expect-cron-run-count ... --expect-total-database-bytes ...
```

## Start Locally

Use separate terminals so the API and web logs stay readable:

```sh
cd /Users/pr/PROJECTS/comptoir_multi
DATABASE_URL=/Users/pr/PROJECTS/comptoir_multi/packages/api/comptoir.db bun run dev:api
```

For a smoke closer to staging/prod, use the non-watch API start:

```sh
cd /Users/pr/PROJECTS/comptoir_multi
DATABASE_URL=/Users/pr/PROJECTS/comptoir_multi/packages/api/comptoir.db bun run --cwd packages/api start
```

If you created `SMOKE_DIR`, use `DATABASE_URL="$SMOKE_DIR/comptoir.db"` for both API commands instead.

```sh
cd /Users/pr/PROJECTS/comptoir_multi
bun run dev:web
```

If a sandboxed environment reports `EADDRINUSE` for every port, retry these commands from a normal local terminal. The smoke needs permission to bind local TCP ports.

Optional WhatsApp local smoke:

```sh
cd /Users/pr/PROJECTS/comptoir_multi
DATABASE_URL=/Users/pr/PROJECTS/comptoir_multi/packages/api/comptoir.db API_INTERNAL_URL=http://localhost:3000 WHATSAPP_INTERNAL_API_SECRET=<local-secret> bun run dev:wa
```

Open:

- Web app: `http://localhost:5173`
- Demo login helper: `http://localhost:5173/demo`
- API health: `http://localhost:3000/health`
- WhatsApp health, if started: `http://localhost:3002/health`

## Manual Smoke

- Login as a multi-restaurant owner.
- Confirm `/auth/me` exposes active restaurant context and accessible restaurants.
- Switch restaurant from the header and confirm schedule, team, settings, onboarding, and billing data do not show stale values from the previous restaurant.
- Create a second restaurant only on the copied DB, then complete minimal onboarding and switch back.
- Invite a shared worker from one sibling restaurant to another, accept as worker, schedule them, then revoke and confirm they disappear from candidate lists.
- Confirm HR/payroll/document surfaces do not expose accepted shared workers unless they have direct target membership.
- For WhatsApp, test one admin phone and one worker phone mapped to more than one restaurant; ambiguous context should ask for selection instead of guessing.

## Stop And Reset

- Stop local servers with `Ctrl-C`.
- Do not run `bun run db:seed` on a copied smoke DB unless the goal is to destroy and recreate demo data.
- If the copied DB becomes messy, discard the copy and recopy from the source; do not repair it by editing the original `/Users/pr/PROJECTS/comptoir` database.

## Pass Criteria

- `verify:multi-restaurant` passes.
- `db:check-multi-restaurant` passes on the copied DB.
- Phase 7 readiness preflight and archived-report assertion pass when the DB is migrated through `0122`.
- UI switcher smoke shows no stale data after context changes.
- Shared-worker smoke keeps scheduling visibility separate from HR/payroll/document visibility.
