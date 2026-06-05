# Multi-Restaurant Review Notes

Use this as the fast review map for the multi-restaurant release slice through the Phase 6 shared-worker MVP. The full plan and phased checklist remain in `docs/multi-restaurant-plan.md` and `docs/multi-restaurant-execution.md`. Phase 7 start gates are tracked separately in `docs/phase-7-readiness.md`.

## Scope

Included in this slice:

- Owner and membership schema.
- Server-side active restaurant context.
- Restaurant switch endpoint and web switcher.
- Restaurant creation/update for owner admins.
- Owner-level billing/legal compatibility.
- WhatsApp ambiguous restaurant context handling.
- Phase 6 MVP: explicit same-owner worker-share authorization, owner list/revoke, worker accept/decline, replacement/open-shift candidate eligibility, scheduling roster integration, role-aware planning/replacement/open-shift/timeclock/notification handling, and scheduling-identity-only web/WhatsApp surfaces.
- Tenant-scope, query-key, migration, cache, and deferred-phase guardrails.

Not included:

- Cross-restaurant solver optimization.
- Owner-level payroll.
- Per-owner database extraction.
- Cross-owner worker sharing.

Phase status:

- Achieved in this release slice: phases `0` through `6` for the defined MVP scope.
- Deferred and guarded out: phase `7` per-owner DB extraction.
- Count: `7` of `8` phases achieved; Phase `7` remains intentionally separate.

## Main Review Targets

- Migrations: `packages/api/drizzle/0115_multi_restaurant_foundation.sql` through `0120_worker_share_authorizations.sql` for the multi-restaurant release path, plus `0121_split_table_scope_metadata.sql` and `0122_backfill_split_table_scope_metadata.sql` for Phase 7 readiness snapshots.
- Active context helpers: `packages/api/src/services/restaurant-context.ts`, `packages/api/src/middleware/auth.ts`, `packages/api/src/middleware/internal-whatsapp-auth.ts`.
- Owner billing/legal: `packages/api/src/routes/auth.ts`, `packages/api/src/services/billing.ts`, `packages/api/src/services/legal-acceptance.ts`.
- Restaurant management and worker-share invite/list/accept/decline/revoke API: `packages/api/src/routes/restaurants.ts`, `packages/api/src/services/worker-sharing.ts`.
- Shared-worker candidate eligibility: `packages/api/src/services/replacement-candidates.ts`.
- Web switcher/cache and worker-share controls: `packages/web/src/hooks/auth-provider.tsx`, `packages/web/src/components/layout.tsx`, `packages/web/src/lib/query-keys.ts`, `packages/web/src/lib/api.ts`, `packages/web/src/pages/admin/preferences.tsx`, `packages/web/src/i18n/locales/*/preferences.json`.
- WhatsApp context: `packages/api/src/routes/internal-whatsapp.ts`, `packages/whatsapp/src/webhook.ts`, `packages/whatsapp/src/identity.ts`.
- Guard scripts and checker logic: `packages/api/scripts/assert-tenant-scope.ts`, `packages/api/scripts/assert-active-context-coverage.ts`, `packages/api/scripts/assert-shared-worker-boundary.ts`, `packages/api/scripts/assert-deferred-phase-boundary.ts`, `packages/api/scripts/check-multi-restaurant-backfill.ts`, `packages/api/scripts/phase7-readiness-preflight.ts`, `packages/api/scripts/phase7-assert-readiness-report.ts`, `packages/api/src/services/multi-restaurant-backfill-check.ts`, `packages/web/scripts/assert-query-keys.ts`.

## Must Run

```sh
bun run verify:multi-restaurant
```

This runs workspace typecheck, all tests, API tenant-scope guard, API active-context coverage map guard, API shared-worker and deferred-phase guards, web query-key/cache guard, web lint, and the web production build.

Latest local result in the isolated worktree: `1350` tests passing, `19` intentionally skipped legacy/parity tests, `0` failures, web lint `35` warnings and `0` errors, web build passing.

## Manual Smoke

- Run migrations `0115` through `0120` against a copied production-like database for the release backfill check; continue through `0122` before running the Phase 7 readiness preflight.
- Log in as an owner admin who is `admin` in restaurant A and `manager` in restaurant B.
- Switch A to B and verify schedule, team, settings, documents, and onboarding do not show stale A data.
- Create a second restaurant, complete enough onboarding to load its dashboard, then switch back.
- Check owner billing with one restaurant and two restaurants under the same owner.
- Send WhatsApp messages from a phone mapped to two restaurants; verify the bot asks for context and never guesses.
- In Preferences > Profile, invite a worker from a sibling restaurant, verify the worker can accept or decline the pending share, then verify an owner manager can revoke the accepted share.
- Confirm the worker-share panel and API responses show only scheduling identity from the source restaurant; do not expose email, phone, payroll, notes, documents, or medical fields.
- Confirm `multi_restaurant_willing` alone does not make a sibling worker appear as an eligible replacement/open-shift candidate.
- Confirm worker-share invite, accept/decline, and revoke actions appear in the active target restaurant's audit log as `worker_share_authorizations`.

## Deployment Checklist

- Take a database backup before applying `0115` through `0122`.
- Apply migrations in order and confirm `owners`, `owner_memberships`, `restaurant_memberships`, `worker_restaurant_profiles`, `whatsapp_context_sessions`, and `worker_share_authorizations` exist.
- Run `bun run --cwd packages/api db:check-multi-restaurant` against the migrated database after it has reached at least `0120`; an unmigrated local DB is expected to fail this check.
- For the Phase 7 readiness record, run `docs/phase-7-staging-smoke.md` after the copied/staging DB has reached `0122`, then archive the JSON report and assertion output.
- Spot-check backfill counts before opening the switcher: every active user should have an active `restaurant_memberships` row, and every restaurant should have `owner_id`.
- Confirm existing sessions have `active_restaurant_id`; new logins should resolve the same active restaurant before any switch.
- Confirm migrated legal acceptances have `owner_id`, and existing onboarding tokens have `restaurant_id`.
- Deploy API before relying on the web switcher, because the web cache strategy depends on server-pinned active restaurant context.
- After deploy, run the manual smoke list above on staging first, then production.
- Keep `users.restaurant_id` populated during the transition; it is still the compatibility fallback.

Useful post-migration spot checks:

```sql
SELECT COUNT(*) AS restaurants_without_owner
FROM restaurants
WHERE owner_id IS NULL;

SELECT COUNT(*) AS active_users_without_membership
FROM users u
WHERE u.active = 1
  AND NOT EXISTS (
    SELECT 1
    FROM restaurant_memberships rm
    WHERE rm.user_id = u.id
      AND rm.restaurant_id = u.restaurant_id
      AND rm.active = 1
  );

SELECT COUNT(*) AS sessions_without_active_restaurant
FROM sessions
WHERE active_restaurant_id IS NULL;

SELECT COUNT(*) AS legal_acceptances_without_owner
FROM legal_acceptances
WHERE restaurant_id IS NOT NULL
  AND owner_id IS NULL;

SELECT COUNT(*) AS onboarding_tokens_without_restaurant
FROM onboarding_tokens
WHERE user_id IS NOT NULL
  AND restaurant_id IS NULL;
```

## Guardrail Expectations

- New tenant-scoped API code should use `requestRestaurant(c)` or restaurant-context helpers.
- New frontend restaurant-scoped queries should use `qk`.
- Broad `queryClient.clear()` should stay limited to logout and active-restaurant switching.
- New raw request restaurant-id inputs (`restaurantId`, `sourceRestaurantId`, `targetRestaurantId`) should fail the tenant guard unless they validate membership or same-owner boundaries before use.
- Remaining `users.restaurant_id` reads are compatibility fallbacks only.
- New `multiRestaurantWilling` / `multi_restaurant_willing` use should fail the shared-worker boundary guard unless it is profile/display/backfill plumbing; it must not authorize cross-restaurant scheduling. The guard scans API, shared, web, and WhatsApp code.
- New worker-share UI/API additions must keep the privacy boundary: scheduling identity can cross restaurants after same-owner validation, but HR, payroll, manager notes, documents, and medical data cannot cross by default. The shared-worker boundary guard pins the web share response contracts so sensitive fields cannot be added silently.
- New owner-payroll, owner/tenant/master database path, database factory, connection, connection factory, Phase 7-specific environment variable, tenant-resolver, tenant migration runner, object-storage namespace/prefix, physical-tenant, or tenant/owner backup/export/delete implementation markers should fail the deferred-phase boundary guard; those belong to later branches, not this release slice. The guard scans package manifests, env/config/deploy-adjacent files, API scripts/tools, solver sidecar files, root shell scripts, API source/migrations, shared, web scripts/source, and WhatsApp tools/source.
- Tenant-scoped routes using active context should be listed in the active-context coverage map as directly covered or specially covered. `cron.ts`, `debug-cache.ts`, and `health-solver.ts` are the only intentionally unscoped routes. The current expected tracked follow-up count is `0`.

## Known Constraints

- Web lint reaches app code and exits successfully; the remaining lint output is `35` React hook/compiler warnings and `0` errors.
- `users.restaurant_id` is intentionally retained during this release as a fallback for legacy rows and old context paths.
- `multi_restaurant_willing` remains a preference only. It does not authorize shared-worker scheduling.
- Broad cross-restaurant optimization, owner-level payroll, cross-owner sharing, HR/payroll/document sharing by default, and per-owner database extraction are deliberately outside this slice.
- Owner subscription fields are mirrored back to restaurant fields during the transition so old reads keep working.

## Rollback Notes

- If migrations have not reached production, roll back the branch normally and keep the deployed single-restaurant model unchanged.
- If migrations have already run, prefer disabling the web switcher/create-restaurant UI first while keeping the server compatibility layer in place.
- Do not drop owner, membership, context, or restaurant-bound token columns during an emergency rollback; they are additive and older code can ignore them.
- Keep `users.restaurant_id` populated during the transition so legacy code still has a tenant boundary.
- Any hotfix after rollback should still run `bun run verify:multi-restaurant` or at minimum the API tenant-scope guard before deployment.
