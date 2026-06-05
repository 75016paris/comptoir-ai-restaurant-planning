# Phase 7 Readiness: Per-Owner DB Extraction

This document is a start gate, not an implementation plan for the current branch. Phase 7 moves from logical owner tenancy in one database to physical owner isolation. It should start in a new branch after the switcher, billing/legal, WhatsApp context, and Phase 6 shared-worker MVP have been reviewed in production-like use.

## Current Branch Rule

Do not add master/tenant database implementation code to this release slice. `bun run --cwd packages/api test:deferred-phase-boundary` intentionally blocks concrete Phase 7 markers such as owner database paths, tenant resolvers, tenant migration runners, tenant backup/export/delete code, package scripts, env/config changes, solver sidecar changes, and shell/helper-tool entry points that would start the extraction early.

Allowed in this branch:

- Documentation for the future extraction.
- Guardrails that keep Phase 7 out of the current release.
- Backfill and smoke checks for the logical owner schema and durable split-table scope metadata already added in migrations `0115` through `0122`.

Not allowed in this branch:

- Runtime tenant database resolvers.
- Owner database path columns or connection factories.
- Migration runners across owner databases.
- Per-owner backup, restore, export, or delete implementation.
- Object-storage key rewrites for physical tenancy.
- Cron fan-out over physical owner databases.

## Phase 6 Freeze Handoff

Automated checks already expected before opening a Phase 7 branch:

- `bun run verify:multi-restaurant` passes on the isolated multi-restaurant worktree.
- `bun run --cwd packages/api test:shared-worker-boundary` passes and keeps shared-worker visibility scheduling-only.
- `bun run --cwd packages/api test:deferred-phase-boundary` passes and keeps physical tenant extraction out of Phase 6.
- `bun test packages/api/scripts/check-multi-restaurant-backfill.test.ts` passes, proving the deployment checker catches missing tables, columns, and backfill gaps.

Use `docs/phase-7-staging-smoke.md` as the short runbook for executing and archiving the Phase 7 preflight on a copied or staging SQLite database, and `docs/phase-7-go-no-go-template.md` for the release decision record.

Manual checks that still require a copied production-like database or staging environment:

- Apply migrations `0115` through `0122` to the copied database.
- Run `bun run --cwd packages/api db:check-multi-restaurant` against that migrated copied database.
- Smoke one owner with at least two restaurants, including switcher, billing/legal, WhatsApp context selection, and shared-worker invite/accept/revoke.
- Record backup, rollback, and restore expectations before Phase 7 starts changing storage shape.

Demo DB smoke completed on the copied local demo database:

- Source copied from `/Users/pr/PROJECTS/comptoir/packages/api/comptoir.db` into the isolated worktree.
- Migrations `0115` through `0122` applied manually because the demo DB had the legacy schema but no complete Drizzle migration journal.
- `bun run --cwd packages/api db:check-multi-restaurant` passed on the migrated copy.
- Resulting backfill counts: `3` restaurants, `3` owners, `51` owner memberships, `51` restaurant memberships, `46` worker profiles, `0` restaurants without owner, `0` active users without membership.
- Phase 7 dry-run export summary on that migrated copy, via `bun run --cwd packages/api phase7:export-dry-run`: master would contain `51` login identities, `3` owners, `51` owner memberships, and `0` sessions; owner DB row groups are `42` memberships / `4788` services, `8` memberships / `1107` services, and `1` membership / `0` services; dry-run failures: `0`.
- Phase 7 document storage audit on that migrated copy, via `bun run --cwd packages/api phase7:document-storage-audit`: `0` documents, `0` object-storage documents, `0` issues.
- Phase 7 readiness preflight on the `0121`/`0122` migrated smoke DB, via `bun run --cwd packages/api phase7:readiness-preflight -- --out /private/tmp/comptoir-phase7-readiness-preflight-smoke-7 --report /private/tmp/comptoir-phase7-readiness-preflight-smoke-7.json`: report version `2`, dry-run failures `0`, split schema issues `0`, split scope gaps `0`, snapshot verification failures `0`, snapshot report `pass`, document move count `0`, document issues `0`; the JSON report includes `generatedAt`, a snapshot summary of `3` owner DBs, `3` restaurants, `51` users, and `5,895` services, and was written to the requested report path.
- Archived preflight report assertion completed with `bun run --cwd packages/api phase7:assert-readiness-report -- --report /private/tmp/comptoir-phase7-readiness-preflight-smoke-7.json`: status `pass`, expected report version `2`, failures `0`.
- Archived preflight report assertion now supports staging freshness checks with `--max-report-age-minutes <minutes>`, so a smoke command can fail if it accidentally points at an older JSON report or a future timestamp caused by clock skew.
- Archived preflight report assertion also supports exact copied-database identity checks with `--expect-total-database-bytes <bytes>`; the local demo smoke currently passes with `3,534,848` total SQLite bytes across the generated master and owner DB files.
- The archived-report assertion CLI is covered by `packages/api/scripts/phase7-assert-readiness-report.test.ts`, including both a passing report and a report with blocking scope failures.
- Invalid archived-report JSON is also reported as a machine-readable `fail` result with an `invalid_report_json:*` failure entry, so CI/staging callers do not have to parse raw exception output.
- Older archived report versions are rejected explicitly, and the assertion CLI prints both `expectedReportVersion` and `actualReportVersion` in its machine-readable output.
- Empty Phase 7 DB creation smoke completed with `bun run --cwd packages/api phase7:create-empty-dbs -- --out /private/tmp/comptoir-phase7-empty-dbs-smoke --owners owner-a,owner-b`: one `master.sqlite` and two owner `comptoir.sqlite` files were created from the draft baselines.
- Core Phase 7 snapshot smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-smoke`: one `master.sqlite` and three owner DBs were created from the migrated demo DB; copied counts matched the dry-run, verification failures: `0`.
- Core Phase 7 snapshot verification completed with `bun run --cwd packages/api phase7:verify-core-snapshot -- --dir /private/tmp/comptoir-phase7-core-snapshot-smoke-2`: checked all three owner DBs, verified no dangling owner-local service/document/audit rows, no owner-local login secrets, failures: `0`.
- Snapshot manifest smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-manifest-smoke`: the extractor wrote `phase7-snapshot-manifest.json`, and `phase7:verify-core-snapshot` required and consumed it successfully, failures: `0`.
- Snapshot fingerprint smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-fingerprint-smoke`: manifest includes SHA-256 and byte-size fingerprints for `master.sqlite` and each owner DB; `phase7:verify-core-snapshot` verified them successfully, failures: `0`.
- Snapshot identity report smoke completed with `bun run --cwd packages/api phase7:snapshot-report -- --dir /private/tmp/comptoir-phase7-core-snapshot-fingerprint-smoke`: printed a stable JSON fiche d'identite with `status: pass`, `3` owner DBs, `51` projected owner-local users, `5,895` services, SHA-256/byte-size fingerprints, expected-file inventory, split-table counts, and `0` verification failures.
- Snapshot owner-user isolation check completed with `bun run --cwd packages/api phase7:verify-core-snapshot -- --dir /private/tmp/comptoir-phase7-core-snapshot-fingerprint-smoke`: every owner-local `users` projection exactly matched that owner's `owner_memberships` in the master snapshot; verification failures: `0`.
- Snapshot session-context check completed with `bun run --cwd packages/api phase7:verify-core-snapshot -- --dir /private/tmp/comptoir-phase7-core-snapshot-fingerprint-smoke`: every master session with an active owner/restaurant context must point to a user in that owner and to a restaurant present in that owner DB; demo snapshot currently has `0` sessions and `0` verification failures.
- Snapshot document-user reference check completed with `bun run --cwd packages/api phase7:verify-core-snapshot -- --dir /private/tmp/comptoir-phase7-core-snapshot-doc-scope-smoke`: owner-local documents now validate `user_id`, `uploaded_by`, and `reviewed_by` against owner-local users while allowing null optional reviewer/uploader fields; verification failures: `0`.
- Snapshot table-coverage smoke completed with `bun run --cwd packages/api phase7:snapshot-report -- --dir /private/tmp/comptoir-phase7-core-snapshot-owner-complete-smoke`: report now lists all `33` owner tables copied, `0` remaining owner tables, and the remaining split tables still requiring explicit export semantics before full Phase 7 extraction.
- Snapshot scope manifest smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-scope-smoke`: manifest now declares `scope.kind: core`, the copied owner tables, remaining owner tables, and remaining split tables; `phase7:verify-core-snapshot` rejects manifests without the expected core scope.
- Snapshot strict-scope smoke completed with `bun run --cwd packages/api phase7:verify-core-snapshot -- --dir /private/tmp/comptoir-phase7-core-snapshot-strict-scope-smoke`: verifier now rejects manifests whose `copiedOwnerTables`, `remainingOwnerTables`, or `remainingSplitTables` drift from the current Phase 7 table-boundary contract.
- Snapshot master login-routing check completed with `bun run --cwd packages/api phase7:verify-core-snapshot -- --dir /private/tmp/comptoir-phase7-core-snapshot-ownerless-login-smoke`: every copied master `login_identities` row must have at least one `owner_memberships` row so login can route to an owner DB; verification failures: `0`.
- Snapshot time-clock export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-time-clocks-smoke`: core snapshot now copies and verifies `time_clocks`; demo data copied `3` time-clock rows, all under one owner DB, with `0` verification failures.
- Snapshot daily-revenue export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-daily-revenue-smoke`: core snapshot now copies and verifies `daily_revenue`; demo data copied `312` revenue rows across two owner DBs, with `0` verification failures.
- Snapshot restaurant-closures export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-restaurant-closures-smoke`: core snapshot now copies and verifies `restaurant_closures`; demo data copied `2` closure rows across two owner DBs, with `0` verification failures.
- Snapshot published-weeks export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-published-weeks-smoke`: core snapshot now copies and verifies `published_weeks`; demo data copied `54` published-week rows across two owner DBs, with `0` verification failures.
- Snapshot calendar-events export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-calendar-events-smoke`: core snapshot now copies and verifies `calendar_events`; demo data currently has `0` calendar-event rows, and verification failures remain `0`.
- Snapshot worker-availability export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-worker-availability-smoke`: core snapshot now copies and verifies `worker_availability`, including local worker references; demo data currently has `0` worker-availability rows, and verification failures remain `0`.
- Snapshot worker-preferred-schedule export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-worker-preferred-schedule-smoke`: core snapshot now copies and verifies `worker_preferred_schedule`, including local worker references; demo data copied `211` preferred-schedule rows, all under one owner DB, with `0` verification failures.
- Snapshot worker-restrictions export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-worker-restrictions-smoke`: core snapshot now copies and verifies `worker_restrictions`, including local worker references; demo data copied `7` restriction rows, all under one owner DB, with `0` verification failures.
- Snapshot email-recipients export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-email-recipients-smoke`: core snapshot now copies and verifies `email_recipients`; demo data currently has `0` email-recipient rows, and verification failures remain `0`.
- Snapshot contract-templates export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-contract-templates-smoke`: core snapshot now copies and verifies `contract_templates`, including optional local `created_by` references; demo data currently has `0` contract-template rows, and verification failures remain `0`.
- Snapshot weather-data export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-weather-data-smoke`: core snapshot now copies and verifies `weather_data`; demo data currently has `0` weather rows, and verification failures remain `0`.
- Snapshot admin-alerts export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-admin-alerts-smoke`: core snapshot now copies and verifies `admin_alerts`, including local `recipient_id` and optional `worker_id` references; demo data currently has `0` admin-alert rows, and verification failures remain `0`.
- Snapshot holiday-requests export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-holiday-requests-smoke`: core snapshot now copies and verifies `holiday_requests`, including local `worker_id` and optional `reviewed_by` references; demo data copied `23` holiday-request rows across two owner DBs, with `0` verification failures.
- Snapshot replacement-requests export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-replacement-requests-smoke`: core snapshot now copies and verifies `replacement_requests`, including local `requester_id`, optional `target_id`, and `requester_service_id` references; demo data copied `7` replacement-request rows across two owner DBs, with `0` verification failures.
- Snapshot open-shifts export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-open-shifts-smoke`: core snapshot now copies and verifies `open_shifts`, including local creator, optional claimer, optional service, and JSON candidate references; demo data currently has `0` open-shift rows, and verification failures remain `0`.
- Snapshot restriction-requests export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-restriction-requests-smoke`: core snapshot now copies and verifies `restriction_requests`, including local `worker_id` and optional `reviewed_by` references; demo data currently has `0` restriction-request rows, and verification failures remain `0`.
- Snapshot worker-share export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-worker-shares-smoke`: core snapshot now copies and verifies `worker_share_authorizations`, including local source restaurant, target restaurant, worker, and inviter references; demo data currently has `0` worker-share rows, and verification failures remain `0`.
- Snapshot staffing export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-staffing-smoke-2`: core snapshot now copies and verifies `staffing_profiles`, `service_templates`, `service_template_overrides`, `staffing_schedule`, `staffing_targets`, and `staffing_analysis_cache`; demo data copied `2` profiles, `16` templates, `2` overrides, `28` schedule rows, and `52` targets, while legacy-missing `staffing_analysis_cache` is treated as `0`, with `0` verification failures.
- Snapshot owner-complete export smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-owner-complete-smoke`: core snapshot now copies and verifies every owner-target table, including `onboarding_tokens` and `worker_weekly_hours`; demo data currently has `0` rows for those two tables, and verification failures remain `0`.
- Snapshot split-table contract smoke completed with `bun run --cwd packages/api phase7:extract-core-snapshot -- --out /private/tmp/comptoir-phase7-core-snapshot-users-legal-split-smoke`: core snapshot now declares `users` handled by the master login identity plus owner-local user projection split, copies `legal_acceptances` rows with `owner_id` into master `owner_legal_acceptances`, verifies dangling owner/user references, and reports `3` remaining split tables: `chat_messages`, `cron_runs`, and `notifications`; demo data currently has `0` legal acceptance rows and verification failures remain `0`.
- Snapshot remaining-split report smoke completed with `bun run --cwd packages/api phase7:snapshot-report -- --dir /private/tmp/comptoir-phase7-core-snapshot-users-legal-split-smoke`: report now includes `remainingSplitRows` and `remainingSplitPlans`, so each still-blocked split table shows both its row count and the missing durable scope field/semantic decision before export.
- Phase 7 dry-run now includes `splitSchemaIssues`: `notifications` needs `owner_id`/`restaurant_id`, `chat_messages` needs `owner_id`/`restaurant_id`/`context_kind`, and `cron_runs` needs `owner_id`/`scope` before those tables can be exported without guessing.
- Migration `0121_split_table_scope_metadata.sql` adds nullable durable scope metadata to the current single DB for those remaining split tables: `notifications.owner_id`, `notifications.restaurant_id`, `chat_messages.owner_id`, `chat_messages.restaurant_id`, `chat_messages.context_kind`, `cron_runs.owner_id`, and `cron_runs.scope`.
- Migration `0121` smoke completed on `/private/tmp/comptoir-phase7-0121-smoke.db`: after applying the migration, `bun run --cwd packages/api phase7:export-dry-run` reported `splitSchemaIssues: []`, and `phase7:extract-core-snapshot`, `phase7:verify-core-snapshot`, and `phase7:snapshot-report` all passed on `/private/tmp/comptoir-phase7-core-snapshot-0121-scope-smoke`.
- Phase 7 dry-run now also includes `splitScopeGaps`: once the split scope columns exist, it reports rows that still miss a durable owner/scope assignment, such as restaurant notifications without `restaurant_id`, restaurant-context chat messages without `restaurant_id`, or owner cron attempts without `owner_id`.
- New API-side queued notifications now preserve durable scope through `queueNotification`: restaurant-scoped notifications store `restaurant_id` and infer `owner_id` from the restaurant, while owner-level notifications can store `owner_id` without a restaurant. The write path remains backward-compatible with pre-`0121` test databases by checking column presence before writing the new fields.
- New internal WhatsApp chat writes now preserve durable scope where possible: `/chat/messages` and `/notifications/record` infer or accept a validated restaurant context, then store `restaurant_id`, inferred `owner_id`, and `context_kind` only when the database has the `0121` columns. Older fixtures keep using the legacy `chat_messages` shape without migration-time breakage.
- Migration `0122_backfill_split_table_scope_metadata.sql` backfills existing split rows after `0121`: restaurant notifications and chat transcripts use legacy `users.restaurant_id` or a unique active restaurant membership, owner ids are inferred from restaurants or unique owner memberships, pre-context chat messages are allowed to stay ownerless in the future master DB, and existing cron attempts are marked as fleet-level.
- New cron attempts now write `scope = 'fleet'` by default when the column exists, while `runCron(..., { scope: 'owner', ownerId })` is available for future owner-local job attempts. The insert path remains backward-compatible with pre-`0121` `cron_runs` tables.
- Core snapshot split export now copies all remaining mixed-responsibility rows once `0121`/`0122` have made scope durable: owner-only notifications, `pre_context` chat messages, and fleet cron attempts go to master; restaurant notifications, `restaurant_context` chat transcripts, and owner-scope cron attempts go to the matching owner DB.
- Document storage audit now reports `relocationMoves` for object-backed documents that are valid today under `restaurants/{restaurant}/users/{user}/...` and can later move to `owners/{owner}/restaurants/{restaurant}/users/{user}/...`; keys already in that future shape are accepted. `bun run --cwd packages/api phase7:document-storage-plan` prints a versioned offline move manifest, `phase7:document-storage-verify-plan -- --plan <file>` verifies that a saved manifest still matches the current DB before any future move, and `phase7:document-storage-verify-post-move` fails if any OVH document key is still in the old shape after a future move. Smoke on `/private/tmp/comptoir-phase7-0121-smoke.db` currently reports `0` documents, `0` moves, and no issues.

## Start Conditions

Phase 7 should not start until all of these are true:

- Migrations `0115` through `0122` have been tested on a copied production-like database.
- The logical owner model has survived staging smoke tests with at least two restaurants under one owner.
- Active restaurant switching has no stale schedule, team, settings, billing, legal, onboarding, or document data.
- Billing owner dedupe has been reviewed against real-ish multi-restaurant usage.
- WhatsApp ambiguous context handling has been smoke-tested with one admin phone and one worker phone mapped to multiple restaurants.
- Shared-worker authorization has been reviewed for privacy: scheduling identity crosses restaurants, HR/payroll/documents/medical data does not.
- Remaining production `users.restaurant_id` reads are still compatibility fallbacks and are covered by `test:tenant-scope`.

## Extraction Contract

Keep the logical ownership model stable while changing storage:

- Master data owns login identities, sessions, owners, Stripe state, owner legal acceptance state, and routing metadata.
- Owner data owns restaurants, memberships, schedules, services, documents metadata, holidays, open shifts, replacements, payroll inputs, audit logs, and restaurant settings.
- Object storage keys must be scoped by owner id before documents can be restored or deleted owner-by-owner; the current audit reports the exact source/target key move plan without moving objects.
- Cron and notification jobs must record failure per owner, not fail the whole fleet.
- Cross-owner worker sharing remains out of scope.

## Remaining Before Runtime Cutover

The current branch proves that the logical model can be snapshotted into draft master/owner SQLite files. It does not yet make the app run from those files.

Before any runtime Phase 7 cutover branch:

- Run the staging smoke runbook on a copied production-like database migrated through `0122`, with `--require-snapshot-dir`, `--expect-snapshot-dir`, `--max-report-age-minutes`, expected copied-row counts, and `--expect-total-database-bytes`.
- Repeat the document storage audit on a dataset that contains real object-backed documents, then archive the move manifest and post-move verification output.
- Define the owner database storage path, backup cadence, restore drill, export format, and owner-delete semantics before adding runtime connection factories.
- Add an owner migration runner that can apply master and owner baselines on isolated copies first, with failure reporting per owner.
- Add read-only runtime resolver instrumentation before moving write paths; auth/session should remain able to route even if one owner DB is broken.
- Keep the single DB as source of truth until at least one owner export/import/restore round trip has been verified.

## First Phase 7 Branch Shape

Start with read-only infrastructure before moving writes:

1. Add a master schema proposal and migration draft for owner database routing metadata. Started with `packages/api/src/db/phase7-master-schema.ts` and `packages/api/drizzle/phase7/master/0000_master_baseline.sql`.
2. Add an owner-data schema boundary for restaurant operational tables. Started with `packages/api/src/db/phase7-schema-boundaries.ts`, `packages/api/src/db/phase7-owner-schema.ts`, and `packages/api/drizzle/phase7/owner/0000_owner_baseline.sql`.
3. Add an owner-data resolver interface with test doubles only. Started with `packages/api/src/db/phase7-owner-data-resolver.ts`.
4. Add a migration runner design that can apply baselines to an isolated copy. Started with `packages/api/src/db/phase7-baseline-runner.ts` and `bun run --cwd packages/api phase7:create-empty-dbs`.
5. Add a dry-run export checker that compares row counts by owner in the current single DB. Started with `packages/api/src/db/phase7-export-dry-run.ts`.
6. Add object-storage namespace audit checks before changing write paths. Started with `packages/api/src/db/phase7-document-storage-audit.ts`.

Only after those checks pass should runtime route code start reading from physical owner databases.

Current Phase 7 first slice:

- Master schema draft separates `login_identities`, `owners`, owner memberships, sessions, password reset, pending registration, owner legal acceptance, phone routing, WhatsApp context, owner/global notifications, pre-context chat, and fleet cron attempts into the future control-plane DB.
- Owner schema draft keeps restaurant operations in owner-local DBs: restaurants, memberships, worker profiles, worker shares, planning, services, documents metadata, leave, replacements, open shifts, pointage, payroll inputs, audit logs, settings, notifications, and optimizer/cache state.
- SQL baselines now exist for a clean future install: one master baseline and one owner-data baseline. They are tested in memory but are not wired to `db:migrate` yet.
- Baseline runner can create an isolated empty master DB and one empty owner DB per owner id. It refuses to write into an existing output directory.
- Core snapshot extractor can copy the current safe subset into isolated DB files: master login identities, owners, owner memberships, owner legal acceptances, sessions, master-side split rows, plus owner restaurants, owner-local user projection, restaurant memberships, worker profiles, services, documents, audit logs, and owner-side split rows. It verifies copied counts against the dry-run before passing.
- Core snapshot extractor writes `phase7-snapshot-manifest.json` with snapshot version, explicit `core` scope, copied and remaining table coverage, DB paths, SHA-256/byte-size file fingerprints, dry-run counts, and copied counts.
- Core snapshot verifier can re-open an extracted snapshot directory and validate master/owner integrity without the source DB: manifest exists and matches master owner paths, manifest scope exactly matches the current core snapshot table contract, file fingerprints still match, owner files exist, copied counts match the actual DB files, every login identity can route to at least one owner membership, each owner-local `users` projection exactly matches master `owner_memberships`, master session context points to a user in the active owner and a restaurant present in that owner DB, master memberships/sessions are not dangling, owner-local tables do not expose login secrets, owner-local documents keep `user_id`, `uploaded_by`, and `reviewed_by` inside local users when present, and owner-local service/document/audit rows point to local restaurants/users.
- Snapshot report can turn that verified snapshot into a compact identity sheet: pass/fail status, master/owner file fingerprints, copied and verified counts, aggregate totals, expected-file inventory, unexpected SQLite file detection, split-table counts, split-schema issues, split-scope gaps, remaining split-table row counts/plans if any, and verification failures if any.
- Readiness preflight now combines the offline gate into one command: dry-run summary, document move manifest validation, core snapshot extraction, snapshot verification, and snapshot identity report. It emits a versioned JSON report with `generatedAt` and a compact snapshot summary, fails closed if any part reports a schema issue, scope gap, copied-count mismatch, dangling reference, document-plan drift, or non-pass snapshot report, and returns dry-run/scope blockers as a `fail` report before attempting a snapshot. Pass `--report <path>` to persist the exact JSON result for staging or release notes.
- The preflight CLI validates `--out` and `--report` before opening the database, and refuses to overwrite an existing report path, so bad invocations do not create a default local SQLite file by accident.
- Archived readiness reports can be re-checked without touching the database via `bun run --cwd packages/api phase7:assert-readiness-report -- --report <report-json-path>`. The assertion requires report version `2`, non-empty `generatedAt` and snapshot directory, `status: pass`, `snapshotReportStatus: pass`, a non-negative snapshot summary, string-only failure arrays, no dry-run failures, no snapshot verification failures, no preflight failures, and non-negative/zero blocking schema/scope/document issue counts. Staging smoke can also require `--max-report-age-minutes`, `--expect-snapshot-dir`, expected copied-row counts, and `--expect-total-database-bytes`; the assertion output echoes `expectedReportVersion`, `actualReportVersion`, `expectedSnapshotSummary`, and `actualSnapshotSummary`.
- Snapshot report also includes table coverage so the current core snapshot cannot be mistaken for runtime multi-DB routing. The current copied owner tables are all owner-target tables: `restaurants`, `users`, `restaurant_memberships`, `worker_restaurant_profiles`, `worker_share_authorizations`, `services`, `service_templates`, `service_template_overrides`, `staffing_profiles`, `staffing_schedule`, `staffing_targets`, `staffing_analysis_cache`, `time_clocks`, `daily_revenue`, `restaurant_closures`, `published_weeks`, `calendar_events`, `worker_availability`, `worker_preferred_schedule`, `worker_restrictions`, `restriction_requests`, `email_recipients`, `contract_templates`, `weather_data`, `admin_alerts`, `holiday_requests`, `replacement_requests`, `open_shifts`, `documents`, `audit_logs`, `onboarding_tokens`, `worker_weekly_hours`, `sub_role_training_costs`, and `sub_role_training_moves`; copied split tables now include `users`, `legal_acceptances`, `notifications`, `chat_messages`, and `cron_runs`.
- No mixed-responsibility table remains blocked at the core snapshot export layer after `0121`/`0122`; the remaining Phase 7 work is runtime resolver wiring, object-storage owner namespace handling, backup/restore/delete workflows, and staging smoke.
- The owner-data baseline also includes owner-local split metadata for future tenant DBs: `chat_messages.restaurant_id`, `chat_messages.context_kind`, and `cron_runs.scope`.
- Owner-data resolver draft defines the future ownerId-to-database-location contract and fails closed for unknown or disabled owners, but it does not open SQLite or change request routing yet.
- Dry-run export checker counts master rows and owner-local rows without copying data, and reports rows that cannot be assigned to an owner.
- Document storage audit checks existing object-storage rows before any key rewrite: every object-backed document must belong to an owned restaurant, use either the current restaurant/user key shape or the future owner/restaurant/user key shape, expose a versioned offline move manifest, verify that the saved manifest still matches the current DB before moving, and provide a post-move verification command that accepts only the future key shape.
- This slice is schema/design only. Runtime routes still use the current single DB until the resolver and migration/export checks exist.

## Required Acceptance Tests

- Owner A export does not include Owner B restaurants, users, services, documents, audit rows, or notifications.
- Owner A restore can rebuild restaurants, memberships, services, documents metadata, and audit rows without touching Owner B.
- Deleting Owner A leaves login identities needed by other owners intact.
- Cron processes Owner A and Owner B independently and records failures separately.
- A broken owner database does not prevent auth/session operations for another owner.
- Object storage authorization requires the owner namespace and the active restaurant/document context.

## Rollback Expectations

Phase 7 needs its own rollback plan before code starts:

- Keep logical owner ids stable across rollback.
- Keep the single-DB source of truth until one owner export/import round trip is verified.
- Do not drop single-DB tenant tables until backups, restore drills, and cron fan-out are proven.
- Keep a clear cutover marker per owner so partial extraction can be paused safely.
