# VPS Multi-Restaurant Cutover

This runbook explains how to promote the isolated `comptoir_multi` worktree into the real VPS deployment without hand-editing the original `/Users/pr/PROJECTS/comptoir` folder or overwriting production blindly.

## Recommendation

Use a clean GitHub repository or clean branch made from `/Users/pr/PROJECTS/comptoir_multi`, then deploy that exact commit to staging first.

Do not manually copy changed source files into `/Users/pr/PROJECTS/comptoir`.
Do not manually edit files in `/home/ubuntu/comptoir` on the VPS.
Do not deploy production before the copied/staging database passes the multi-restaurant checks.

The existing deploy script already preserves the important runtime state:

- It excludes SQLite files: `*.db`, `*.db-wal`, `*.db-shm`, backups.
- It excludes secrets: `.env`, `packages/api/.env`, `packages/whatsapp/.env`.
- It excludes local agent/project memory and internal tools.
- It uses `rsync --delete`, so the deployed source tree should come from one clean reviewed commit.

## Safe Promotion Shape

1. Keep `/Users/pr/PROJECTS/comptoir` as the untouched old local reference until the new release has passed staging.
2. Put `/Users/pr/PROJECTS/comptoir_multi` into a clean Git repo or branch.
3. Push that branch/repo to GitHub.
4. On local, run `bun run verify:multi-restaurant`.
5. On a copied database migrated through `0120`, run `bun run --cwd packages/api db:check-multi-restaurant`.
6. On a copied/staging database migrated through `0122`, run `docs/phase-7-staging-smoke.md` and fill `docs/phase-7-go-no-go-template.md`.
7. Deploy staging from the same commit.
8. Smoke staging manually: login, switch restaurant, create restaurant, billing/legal, WhatsApp ambiguous context, shared-worker invite/accept/revoke.
9. Back up production DB.
10. Deploy production from the same commit.
11. Keep the previous commit, DB backup, and `/Users/pr/PROJECTS/comptoir` reference available until production smoke passes.

## New Repo Vs Existing Repo

Preferred for this release: create a clean repo or clean branch from `comptoir_multi`.

Why:

- The multi-restaurant worktree contains many coordinated changes across API, web, WhatsApp, migrations, scripts, and docs.
- A clean repo/branch makes review and rollback clearer than manually transplanting files into the old folder.
- The VPS deploy script expects one coherent tree; source files copied piecemeal are riskier than a reviewed commit.

What stays on the VPS:

- Production database stays in `/home/ubuntu/comptoir/packages/api/comptoir.db`.
- Staging database stays in `/home/ubuntu/comptoir-staging/packages/api/comptoir.db`.
- Secrets stay in the existing `.env` files.
- Systemd service names and ports stay the same unless a separate infrastructure change is planned.

What changes on deploy:

- Source files, migrations, package manifests, web app, API, WhatsApp source, scripts, and docs are replaced by the new commit.
- Migrations are applied by the deploy script.
- Web is rebuilt on the VPS.
- Services are restarted and health-checked.

Migration note:

- The VPS deploy script runs `packages/api/migrate.ts`.
- That runner applies only top-level SQL files in `packages/api/drizzle`.
- It does not apply the draft Phase 7 baseline files under `packages/api/drizzle/phase7/...`.
- Therefore deploying this release can apply `0115` through `0122`, but it does not switch runtime storage to physical master/owner databases.

## Staging Checklist

Before `./scripts/deploy.sh staging`:

- `bun run verify:multi-restaurant` passed locally.
- Copied DB reached `0120` and passed `db:check-multi-restaurant`.
- Copied DB reached `0122` and passed Phase 7 readiness preflight/assertion if this is also the Phase 7 readiness record.
- Backup/restore plan for production is written down.
- Stripe staging behavior is understood for one owner with one restaurant and one owner with two restaurants.

After staging deploy:

- `https://staging.comptoir.cosmobot.fr/api/health` returns the API health marker.
- Login works for a multi-restaurant owner.
- Restaurant switcher invalidates data correctly.
- New restaurant creation works in staging.
- Owner billing page shows owner-level data and restaurant breakdown.
- Owner legal acceptance behaves across sibling restaurants.
- WhatsApp ambiguous admin/worker phone asks for context.
- Shared-worker invite, accept, schedule, and revoke work without exposing HR/payroll/documents.

## Production Checklist

Before `./scripts/deploy.sh production`:

- Staging smoke passed on the exact commit to deploy.
- Production DB backup completed.
- Rollback command is known: redeploy previous commit and restore DB backup if migrations/data require it.
- A short maintenance window is acceptable, even if expected downtime is small.

After production deploy:

- API health passes.
- Login works.
- Current restaurant data appears unchanged for single-restaurant users.
- Multi-restaurant owner can switch restaurants without stale data.
- Billing/legal gates do not block the wrong users.
- WhatsApp context selection does not act in the wrong restaurant.
- Cron logs show no repeated wrong-restaurant errors.

## Rollback

Rollback source first when the issue is code-only:

```sh
git checkout <previous-good-commit>
./scripts/deploy.sh production
```

Rollback DB only when a migration or data backfill caused the issue and a restore decision has been made:

```sh
scripts/db-restore.sh production <backup-file>
```

Do not partially copy old files over new files. Use one commit, one deploy, one health check.

## Phase 7 Note

This cutover does not mean runtime per-owner DB extraction is active.

Phase 7 runtime work starts later with read-only resolver instrumentation and health checks. The single production SQLite DB remains the source of truth until owner export/import/restore and owner-local backup/delete workflows are proven.
