# Multi-Restaurant Execution Checklist

This checklist converts the plan in `docs/multi-restaurant-plan.md` into safe implementation slices. Keep each phase small enough to review and test independently. For a short reviewer map, use `docs/multi-restaurant-review.md`.

## Current Branch Status

Current as of this multi-restaurant release slice:

| Phase | Capability | Status |
| --- | --- | --- |
| 0 | Model and compatibility | Implemented |
| 1 | Active restaurant context | Implemented |
| 2 | Route migration | Implemented for the main app route families |
| 3 | Web switcher | MVP implemented |
| 4 | Restaurant creation and owner billing/legal | Implemented for this release scope |
| 5 | WhatsApp multi-context | Core context guard implemented |
| 6 | Shared worker pool | MVP implemented and frozen for Phase 7 |
| 7 | Per-owner DB extraction | Deferred and guarded out of this release |

Summary: `7` of `8` phases are achieved for this release slice. Phase `6` is implemented for the explicit same-owner shared-worker MVP; broad cross-restaurant optimization, owner-level payroll, cross-owner sharing, default HR/payroll/document sharing, and physical per-owner DB extraction remain outside this slice. Phase `7` remains an explicit non-goal until this logical owner-tenancy and worker-sharing model is reviewed in production-like use.

- Phase 0 is implemented: owner, membership, worker profile schema and compatibility helpers are in place.
- Phase 1 is implemented: session-backed active restaurant context, restaurant list, switch endpoint, and auth middleware context are in place.
- Auth login, demo-login, `/auth/me`, and `requireAuth` now resolve response and gate context through active memberships; legacy `users.restaurant_id` is only used as a compatibility fallback id for users without v2 context.
- Raw `restaurantId` request inputs are limited to active-restaurant switching and WhatsApp context selection, and both paths validate the requested restaurant against accessible memberships before use.
- Phase 2 is implemented for the main app route families and covered by active-context tests.
- Phase 3 MVP is implemented: desktop/mobile switcher, create-restaurant entry point, auth refresh, full React Query cache clearing on switch, and restaurant-prefixed query keys for restaurant-scoped data.
- The API release checks include an active-context coverage map guard that classifies route files as directly covered, specially covered, intentionally unscoped, or tracked follow-up, so newly migrated routes cannot silently miss the review checklist. The intentionally unscoped routes are `cron.ts`, `debug-cache.ts`, and `health-solver.ts`; all tracked active-context route follow-ups are now retired. Autostaffing coverage is direct and checks active membership permissions before solver execution.
- The web query-key catalog has a focused guard script to prove restaurant-scoped keys change with the active restaurant while auth and billing keys remain global, to block hand-rolled React Query keys or literal direct-cache keys, including multiline direct-cache calls, that bypass the `qk` catalog, to keep broad `queryClient.clear()` calls limited to auth logout/switch context changes, and to fail stale cache-clear allowlist entries.
- Phase 4 is implemented for this release scope: restaurant create/update, owner-level billing fields, owner active employee counting, owner legal acceptance storage, and restaurant subscription mirroring are in place. Restaurant create/update and owner billing endpoints are gated by owner-admin membership, not the active restaurant role, with regressions for an owner admin whose local role is manager in the active restaurant. Auth context now carries `ownerRole`; `owner_admin` users must satisfy owner legal acceptance even when their active restaurant role is manager, and they can accept owner legal terms from that context. Owner legal acceptance now has an explicit regression proving one owner-level acceptance applies across sibling restaurants in the same owner account. Newly created restaurants mirror the current owner subscription status during the transition instead of assuming an active restaurant-level mirror. Owner seat usage now dedupes workers across active restaurants only and ignores inactive workers. Usage reporting skips cancelled/unpaid owners so inactive billing accounts are not sent new meter events. Billing month inputs are validated as `YYYY-MM` before usage preview/reporting. Stripe SIRET metadata remains canonical only for single-restaurant billing customers; multi-restaurant owners clear the canonical `siret` metadata and mark it as `multi_restaurant`. Owner-level payroll remains outside this slice.
- Billing event recipient selection now uses active restaurant admin memberships when owner context exists, with legacy `users.restaurant_id` fallback only for pre-membership schemas.
- Phase 5 has the core context guard: WhatsApp identity resolution returns an explicit context-selection response for ambiguous phones, the real Meta webhook preserves that context-selection copy with the validated restaurant names, a text message that names exactly one accessible restaurant selects that context through the validated identity endpoint, selected restaurant context is pinned in `whatsapp_context_sessions` with a short TTL, and internal tool calls use the pinned context unless an explicit validated restaurant header is sent. Accepted same-owner worker shares can resolve an explicit internal WhatsApp target context with the worker role, `ownerRole: member`, and an explicit empty permission override, so stale source-row permissions or owner roles cannot leak into the target context; target subscription blocking is evaluated against the target restaurant, and revoked shares, inactive source memberships, owner-membership loss, and owner drift fail closed. The main WhatsApp route fixture now runs against owner/membership schema, including regressions for active membership and notification consent context when legacy `users.restaurant_id` differs. WhatsApp admin leave tools resolve workers with `scope=leave`, not broad team scope, and stop immediately when leave-scoped resolution fails.
- The WhatsApp service now forwards a selected restaurant id to identity resolution for demo/context-selected chat, demo notification polling, and demo chat clearing, so agent execution and chat data operations disambiguate before touching user data. Tool calls also send the server-owned active restaurant id in `X-Comptoir-Restaurant-Id`, so internal API authorization uses the validated tool context instead of an inferred legacy restaurant.
- Demo chat phone listing and phone validation now use restaurant memberships instead of legacy `users.restaurant_id`, with a regression covering switched demo context.
- Notification context hardening is implemented for the current Phase 5 and Phase 6 surface: planning, leave, replacement, open-shift, timeclock, admin reminder, and digest paths include the restaurant name when the recipient belongs to multiple restaurants, and admin notification/digest/timeclock-confirmation lookups use restaurant memberships when available. Dashboard and WhatsApp pointage confirmation notifications both include the active/target restaurant name for multi-restaurant admins. With owner tenancy present, admin-recipient resolution no longer falls back to legacy `users.restaurant_id`. Accepted shared-worker notification context now requires the same consent, revocation, owner membership, active source role membership, target worker profile, active user, owner match, and direct target-membership retirement shape used by scheduling context, with regressions proving stale shares do not make source-restaurant notifications look multi-restaurant. Weekly publish/reminder schedule notifications now also filter services through the live scheduling roster, so stale shared-worker target services do not produce outbound worker messages.
- Worker self-service, scheduling, leave, replacement, and team subroute hardening is implemented for the restaurant-switcher scope: worker preference updates, planning mutations, direct service edits, holiday creation, replacement target selection, and user document/availability guards no longer depend on the worker's legacy `users.restaurant_id` when active membership context exists. Shared-worker scheduling is limited to explicit accepted same-owner authorizations.
- Team detail, team mutation, contract generation, and public dossier token flows now carry active membership/restaurant context instead of relying solely on the worker's legacy `users.restaurant_id`. Dossier tokens are restaurant-bound for new links, old links with no restaurant id now use a single active restaurant membership before falling back to legacy worker scope, ambiguous old links fail closed, stale restaurant-scoped links fail closed when the worker no longer belongs to that restaurant, and dossier-completion notifications use the resolved token restaurant context.
- The onboarding-token restaurant context migration includes an index for restaurant-scoped token lookups.
- Migration smoke coverage now applies `0115` through `0120` against legacy-shaped SQLite rows, proving owner/membership backfill, session active restaurant backfill, owner legal backfill, WhatsApp context table creation, onboarding token restaurant backfill, worker-share authorization table creation, and the tenant/context indexes used by the release path. Phase 7 readiness smoke additionally requires `0121`/`0122` so split-table scope metadata exists before snapshot export.
- The deployment-only `bun run --cwd packages/api db:check-multi-restaurant` script verifies a target database migrated through at least `0120` has the owner/membership/context/share tables and no obvious owner, membership, active-session, legal-acceptance, or onboarding-token backfill gaps. It is expected to fail on a database that has not reached those migrations yet.
- Restaurant worker-pool reads are now membership-aware across team lists, dossier status, payroll, compliance, leave balances, DPAE export, staffing analysis, baseline cache fingerprints, weights preview, autostaffing, schedule recaps, notifications, onboarding counts, schedule worker-hours lookups, and replacement candidate ranking. Schedule worker-hours no longer selects the worker's legacy restaurant id after membership validation. Replacement candidate ranking now carries membership restaurant context internally and has a regression for workers whose legacy `users.restaurant_id` differs.
- Cron dossier reminders, monthly digest contract alerts, and internal WhatsApp active team, worker, document helper, and notification-recording endpoints now use membership context where available instead of the legacy `users.restaurant_id` worker lookup.
- Remaining `users.restaurant_id` reads in production code are transitional compatibility paths: auth fallback ids, old-token onboarding fallback after membership resolution, old-schema WhatsApp identity fallback, notification fallback, replacement-candidate fallback, seed/audit helpers, and cron fallback. `bun run --cwd packages/api test:tenant-scope` guards this allowlist, blocks new request-context `user.restaurantId` alias usage outside the auth compatibility path, blocks new raw request tenant inputs, including dot, bracket, destructured `body.restaurantId` / `body.sourceRestaurantId` / `body.targetRestaurantId` forms plus `X-Comptoir-Restaurant-Id`, unless the file is explicitly allowlisted for membership-validated context switching or same-owner worker sharing, and fails on stale allowlist entries so compatibility exceptions are removed when code stops needing them.
- Phase 6 MVP is implemented: `worker_share_authorizations` stores same-owner source/target restaurant sharing, owner admin/manager invite/list/revoke, worker pending-list/accept/decline, pending/accepted/revoked status, and worker consent. List responses expose scheduling identity only. Replacement/open-shift candidate ranking, autostaffing, staffing analysis, weights preview worker naming/sub-role inputs, titulaire preferred-assignment management, dashboard planning mutations, dashboard scheduling roster, dashboard schedule hours/who-works views, and bot-backed planning preparation include only accepted same-owner shares and count sibling/source restaurant services as overlap and weekly-hour constraints; revocation removes eligibility. Dashboard scheduling roster and internal WhatsApp team/context/worker-resolution/team-schedule/team-on-date/staffing-gap/send-schedule/schedule/hours/availability/weekly-recap/compliance/pending-requests/planning/delete-preparation/replacement-preparation have route-level stale-share or target-scope coverage for missing consent, revocation, inactive source membership, source role drift, owner membership loss, inactive workers, source/target owner drift, missing target profiles, and direct target-membership retirement where applicable. Dashboard schedule hours now accepts live shared workers without target membership and rejects stale shares; dashboard week, who-works, and monthly recap views filter accepted shared-worker services through the live roster and exact share role, so stale or wrong-role target services do not remain visible. Staffing analysis and titulaire management use target profile scheduling fields for accepted shared workers, including target contract hours, effective max weekly hours where internal-only, and sub-roles, while keeping source contract type/end private. Optimizer solver capacity can include accepted shared workers, but contract, termination, restriction, and training recommendation levers are restricted to direct target employment rows; manual what-if staffing overrides and the web what-if controls are also limited to direct target workers, and the staffing-analysis JSON response strips the internal shared-worker source id marker. Leave balances, employee details/updates/dossiers/contracts/invites, dossier-status summaries, expiring-document summaries, payroll exports, DPAE exports, monthly-digest contract-ending alerts, and document upload/review mutations remain direct-membership HR surfaces, so accepted shared workers are excluded unless they become real target restaurant members. Worker self-service holiday list/create remains tied to direct membership, while WhatsApp worker planning preferences in an accepted shared target context read and update the target `worker_restaurant_profiles` scheduling cap instead of mutating the source/global user hours. Cron dossier reminders also derive candidates, checklist context, and token restaurant ids from direct restaurant memberships, so an accepted share does not create a second target-restaurant dossier reminder. Dashboard compliance uses direct-member compliance metadata plus live scheduling-roster identity for accepted shared workers, so target services are checked without opening HR scope. Internal WhatsApp schedule-derived summaries now filter target services through the live scheduling roster, so stale shared-worker services do not remain visible in team schedule or staffing-gap output after share eligibility fails. Internal WhatsApp replacement review preparation also filters open replacement requesters through the live scheduling roster, so stale shared-worker requesters disappear before admin review prompts. Internal WhatsApp leave-scoped worker resolution excludes accepted shared workers, keeping shared-worker visibility out of HR/leave tools unless the worker has direct target membership. Dashboard service create, patch, and move reassignment paths validate shared workers against the exact target service role; role-only service patches also revalidate the final worker/role pair, so an accepted floor share cannot be converted into a kitchen service after creation. Manual service creation, patch reassignment, and move reassignment now have route-level stale-share coverage for missing consent, revocation, inactive source membership, source role drift, owner membership loss, inactive workers, source/target owner drift, and missing target profiles. Bot planning-service and open-shift preparation both reject wrong-role workers before confirmation, so the bot cannot present a service/open-shift action that the final mutation would reject. Bot replacement review preparation also filters stored candidate ids through the requested service role, so the bot does not propose kitchen-only workers for floor replacements or the reverse. Worker-reported unavailability now derives date/time/role from the stored service before ranking candidates and notifying admins, so client-supplied payload values cannot steer replacement eligibility across roles. Bot/admin replacement broadcast mutation now persists only live candidate ids after revalidation. Direct dashboard replacement requests with a pre-picked target now run the live candidate ranker before notifying. Worker replacement accept and reject actions both revalidate live candidate eligibility before mutating replacement state, including dashboard and WhatsApp response paths; dashboard broadcast responses also reject candidates already recorded in `rejected_candidate_ids`. Open-shift creation, claimable lookup, solicitation, and claim-time revalidation now have shared-worker regressions, including a source-restaurant conflict that appears after solicitation, stale source-restaurant weekly-cap candidates, source membership role drift, direct target-membership retirement, already-declined claim replay, and successful internal WhatsApp target-restaurant claim/decline flows for an accepted shared worker. Internal WhatsApp auth resolves accepted shared-worker target context from either the server-owned restaurant header or a pinned WhatsApp context session, with owner role and permissions clamped. Internal WhatsApp worker clock-in/out for accepted shared workers stays target-restaurant scoped, matches only target services, ignores same-day source services, writes pointage audit rows against the target restaurant, and includes the target restaurant name in admin confirmation notifications when the admin belongs to multiple restaurants.
- The Phase 6 web surface is implemented in the preferences profile tab: owner admins/managers can choose a source restaurant, list shareable workers through a scheduling-identity-only endpoint, send invitations, and revoke pending/accepted shares; workers can accept or decline pending invitations. The panel is localized in French, English, Spanish, and Portuguese.
- Worker-share UI errors now map backend machine codes to localized user-facing copy in French, English, Spanish, and Portuguese. The API returns stable machine codes for missing source restaurant, invalid role, malformed invite payloads, same source/target restaurant, inaccessible restaurants, inactive/stale source workers, target memberships, and missing/not-pending authorizations.
- Worker pending-invitation rows include both source and target restaurant names, so workers see the exact restaurant pair even when their active dashboard context is elsewhere.
- Worker-share list, pending-invitation list, shareable-worker list, and worker-share audit regressions assert scheduling identity or sharing metadata only: no contact, address/birth/nationality/emergency-contact data, permissions, payroll, HCR, matricule, IBAN/NIR, contract, sub-role, note/manager-note, document/medical, active-state, or source-owner fields are exposed through the sharing surface or its audit changes.
- Those API response regressions reuse the central shared-worker boundary guard's forbidden-field list, so new protected HR, identity, document, medical, payroll, or internal fields are checked consistently across route tests and contract guard tests. Shared-worker scheduling-roster regressions use the same vocabulary with explicit allowances for scheduling metadata (`subRoles`, `contractHours`) and blanked contact fields. Internal WhatsApp shared-worker team, worker-resolution, send-schedule, schedule, and hours regressions now use that vocabulary too, with shared-worker phone explicitly nulled.
- Owner worker-share lists hide stale active-looking shares when the worker leaves the owner account, loses source membership, gains direct target membership, or the worker account is deactivated.
- `bun run --cwd packages/api test:shared-worker-boundary` still protects `multiRestaurantWilling` / `multi_restaurant_willing` as preference-only plumbing; it must not become authorization.
- The shared-worker boundary guard also rejects broad `userCanBeScheduledInRestaurant(..., ["kitchen", "floor"])` calls in production code, so shared-worker scheduling eligibility must be checked against the exact service/request role. The central scheduling helper now has focused regressions for consent, revocation, source membership activity, source role, owner membership, active worker state, owner drift, target profile presence, and direct target-membership retirement.
- The shared-worker boundary guard now classifies accepted-share eligibility/context readers and requires the full boundary shape in `restaurant-context`, replacement candidates, autostaffing, notification context, and baseline cache fingerprints: accepted status, consent timestamp, no revocation, owner membership, active source role membership, target worker profile, active worker, same-owner source/target restaurants, and direct target-membership retirement where the path treats shares as external eligibility. It also guards the web API `WorkerShareAuthorization` and `ShareableWorker` response contracts so contact, address/birth/nationality/emergency-contact data, permission, payroll, HCR, matricule, IBAN/NIR, contract, sub-role, note/manager-note, document/medical, active-state, and source-owner fields cannot be added to the sharing surface unnoticed, with focused tests for allowed scheduling identity, forbidden sensitive fields, HR identity fields, missing protected types, and unrelated user types. Route and tool privacy fragments are pinned too: worker-share audit changes must stay limited to share metadata, internal WhatsApp leave-scoped worker resolution must keep excluding accepted shared workers, and both WhatsApp holiday admin tools must continue resolving workers through `scope=leave`.
- Phase 7 remains deferred. Per-owner DB extraction should not begin until the switcher/billing/legal and worker-sharing model is reviewed. The start gate and extraction contract are documented in `docs/phase-7-readiness.md`, and the deferred-phase guard now has focused regression coverage for owner-payroll, owner/tenant/master DB path and connection factory names, Phase 7-style environment variable names, object-storage namespace, and physical-tenancy markers. The same guard suite also proves current logical owner-tenancy vocabulary and `DATABASE_URL` remain allowed.

Latest verification:

- Multi-restaurant branch verification: `bun run verify:multi-restaurant` passing; this command runs workspace typecheck, repository tests, API tenant-scope guard, API active-context coverage map guard, API shared-worker boundary guard, API deferred-phase guard, web query-key guard, web worker-share locale guard, web lint, and the web production build.
- Repository test suite: passing with `1350` passing tests, `19` intentionally skipped legacy/parity tests, and `0` failures.
- Workspace typecheck: passing.
- API tenant-scope guard, including raw request tenant-input allowlist: passing.
- API active-context coverage map guard: `23` direct routes, `2` specialized routes, `3` intentionally unscoped routes, `0` tracked follow-ups.
- Workspace shared-worker boundary guard and API deferred Phase 7/payroll implementation boundary guard: passing. The deferred guard scans package manifests, env/config/deploy-adjacent files, API scripts/tools, solver sidecar files, root shell scripts, source/migrations, web scripts/source, and WhatsApp tools/source so tenant migration runners cannot land in this release slice by package script, env/config change, or internal tool. The shared-worker guard currently protects `10` preference/data-plumbing files, `5` accepted-share eligibility/context files, `2` web share response contracts, `1` staffing worker-load response contract, `21` route/privacy implementation files, and `1` tool privacy file.
- Multi-restaurant backfill checker: passing against a temporary database migrated through `0000` to `0120`, with focused unit coverage for valid backfills and owner/membership/session/legal/onboarding gaps. Phase 7 copied/staging DB readiness is covered separately by `phase7:readiness-preflight` and archived-report assertion after `0122`.
- Web query-key guard: passing, including active-restaurant scoping for worker-share management, shareable-worker, and worker pending-invitation keys.
- Web worker-share locale guard: passing across `13` API error codes in French, English, Spanish, and Portuguese.
- Web production build: passing.
- Focused active-context, billing/legal, WhatsApp ambiguity, worker-share, shared open-shift claim, replacement response revalidation, query-key, migration smoke, and backfill-checker regressions are included in the repository test suite.
- Browser smoke: switcher renders and opens the create-restaurant menu item.
- Web lint now reaches app code and exits successfully; it currently reports `35` React hook/compiler warnings and `0` errors.

## Locked Decisions

These decisions are the basis for the implemented release slice:

- Use `owners` as the billing/legal tenant name.
- Use `sessions.active_restaurant_id` for active context unless implementation uncovers a real need for `session_contexts`.
- Backfill one owner per existing restaurant by default.
- Keep demo restaurants one-owner-per-restaurant unless product explicitly needs demo switching.
- Keep owner subscription fields mirrored from `restaurants` during transition.
- Store owner/admin legal acceptance at owner scope, while keeping compatibility with restaurant-backed legacy rows during the transition.

## Phase 0: Model And Compatibility

Goal: add the logical owner/membership model while preserving current app behavior.

Implementation:

- Add migration for `owners`.
- Add migration for `owner_memberships`.
- Add migration for `restaurant_memberships`.
- Add migration for `worker_restaurant_profiles`.
- Add nullable `restaurants.owner_id`.
- Backfill one owner per restaurant.
- Backfill owner memberships from existing `users.restaurant_id`.
- Backfill restaurant memberships from existing `users.restaurant_id`, `role`, `permissions`, and `active`.
- Backfill worker profiles from existing restaurant-specific worker columns.
- Add Drizzle schema definitions.
- Add compatibility helpers that read v2 rows when present and fall back to v1 columns.
- Do not change visible app behavior.
- Do not remove or stop writing existing `users` columns yet.

Tests:

- Existing v1 user authenticates with unchanged response shape.
- V2 membership rows resolve the same restaurant as `users.restaurant_id`.
- Missing membership rows fall back to v1 safely.
- Backfill creates owner and membership rows for existing users.
- Worker profile backfill preserves payroll/scheduling metadata.

Acceptance:

- Full existing API test suite passes.
- Migrated database has new tables populated.
- No route behavior changes are visible to web or WhatsApp.

## Phase 1: Active Restaurant Context

Goal: establish server-side active restaurant context before UI work.

Implementation:

- Add nullable `sessions.active_restaurant_id`.
- Add `GET /auth/restaurants`.
- Add `POST /auth/active-restaurant`.
- Validate requested restaurant against active `restaurant_memberships`.
- Update `requireAuth` to set `ownerId`, `activeRestaurantId`, and `restaurantId` alias.
- Resolve role and permissions from active restaurant membership.
- Keep password-change and legal gates working.
- Keep subscription checks restaurant-scoped until owner billing migration.

Tests:

- User can list only restaurants where they have active membership.
- User can switch to restaurant A2 inside same owner when membership exists.
- User cannot switch to sibling restaurant without membership.
- User cannot switch to restaurant under another owner.
- `requireAuth` exposes active restaurant role and permissions.
- Existing single-restaurant users still behave exactly as before.

Acceptance:

- `/auth/me` includes active restaurant context and accessible restaurant list.
- Switching context changes server-side `restaurantId` alias.
- No frontend switcher is required yet.

## Phase 2: Route Migration

Goal: migrate route families from implicit user scope to explicit restaurant context.

Implementation order:

1. Auth/me and switch context.
2. Read-only settings, users list, schedule week.
3. Mutations for settings/users/services.
4. Holidays, replacements, open shifts, documents.
5. Payroll, timeclock, audit, admin alerts.
6. Autostaffing/optimizer.
7. Cron jobs and notification dispatch.
8. Internal WhatsApp API.

Per-route rule:

- Route code must call a central restaurant context helper instead of reading raw frontend `restaurantId`.
- Any route that accepts a restaurant id must validate it against membership/owner rules.
- Add same-owner sibling denial tests unless the endpoint is intentionally owner-wide.
- Add different-owner denial tests.

Acceptance:

- No route can read or mutate a restaurant through stale `users.restaurant_id` after context switch.
- Audit logs include active restaurant where applicable.

## Phase 3: Web Switcher

Goal: expose active restaurant switching safely in the UI.

Implementation:

- Extend frontend `AuthUser` with `activeRestaurantId`, `restaurantName`, and `restaurants`.
- Add restaurant context provider.
- Add compact switcher in `AppLayout`.
- Add mobile drawer switcher.
- On switch, call `POST /auth/active-restaurant`.
- Refetch `/auth/me`.
- Clear React Query cache as MVP.
- Start prefixing restaurant-scoped query keys with `["restaurant", restaurantId, ...]`.

Tests:

- Switching restaurant clears stale schedule/team/settings data.
- Mobile and desktop show the active restaurant.
- Onboarding remains scoped to the active restaurant.

Acceptance:

- Owner can switch between existing restaurants without logout.
- No stale data appears after switch.

## Phase 4: Restaurant Creation And Owner Billing

Goal: make multi-restaurant ownership useful without adding shared workers.

Implementation:

- Add `POST /restaurants` for owner admins.
- Add `PATCH /restaurants/:id` for basic profile fields.
- New restaurant starts in onboarding.
- Creating restaurant gives the actor admin membership.
- Move Stripe reads/writes to `owners`.
- Keep restaurant subscription fields mirrored during transition.
- Add `countActiveForOwner(ownerId, month)`.
- Deduplicate active workers across owner restaurants.
- Return per-restaurant active employee breakdown.

Tests:

- Owner admin can create a second restaurant.
- Manager cannot create owner-level restaurants.
- New restaurant does not clone workers.
- Billing count dedupes shared users by identity.
- Existing Stripe webhook paths still update mirrored state.

Acceptance:

- Owner can create a second restaurant, onboard it, and switch back.
- Billing page shows owner-level subscription and breakdown.

## Phase 5: WhatsApp Multi-Context

Goal: avoid wrong-restaurant actions for phones mapped to multiple restaurants.

Implementation:

- Detect ambiguous phone membership.
- Prompt for restaurant context.
- Store selected restaurant in WhatsApp session state with TTL.
- Match explicit restaurant names only against membership.
- Pass active restaurant id from WhatsApp session to tools.
- Keep existing restaurant tools restaurant-scoped.
- Include restaurant name in outbound notifications when the recipient belongs to multiple restaurants.

Tests:

- Same admin phone in two restaurants gets context prompt.
- Same worker phone in two restaurants gets context prompt.
- Message naming another restaurant only works when membership matches.
- Prompt injection asking for all restaurants is rejected.
- Multi-restaurant recipients receive restaurant-labelled planning and open-shift messages.

Acceptance:

- WhatsApp never guesses restaurant context when ambiguous.

## Phase 6: Shared Worker Pool

Goal: allow explicit same-owner worker sharing with legal and privacy safeguards.

Implemented MVP:

- `worker_share_authorizations` records source restaurant, target restaurant, worker, role, status, inviter, consent timestamp, and revocation timestamp.
- Owner admins/managers can invite, list, and revoke same-owner worker shares.
- Workers can list, accept, and decline their own pending invitations.
- `GET /restaurants/:id/shareable-workers` returns scheduling identity only for same-owner source workers: user id, display name, role, source restaurant id, and source restaurant name.
- Shareable-worker listing excludes target-restaurant members and workers who already have a pending or accepted share for the same target/worker/role, even when the picker is looking at another sibling source restaurant. This matches the active authorization uniqueness rule and prevents duplicate invitations.
- Shareable-worker listing ignores stale non-revoked authorization rows from a previous owner after a restaurant changes owner, so old tenant state cannot hide eligible workers from the new owner.
- Shareable-worker listing uses the same live-share filtering as owner worker-share lists, so stale active authorization rows with an inactive or role-changed original source membership do not block an eligible sibling-source invite.
- Shareable-worker listing is based on the source restaurant membership role, active user state, and owner-account membership, not the legacy global `users.role` compatibility column.
- Duplicate invite requests for an already pending or accepted share are idempotent and do not write duplicate audit inserts. Re-inviting after revoke reactivates the existing authorization and writes an update audit row.
- Re-inviting after a stale active same-owner duplicate reuses the existing authorization row, resets it to pending from the currently valid source restaurant, clears prior worker consent, and writes an update audit row.
- Duplicate invite detection is scoped to the current owner, so stale authorization rows from a previous owner do not block a new owner after restaurant ownership changes.
- Duplicate revoke requests for an already revoked share are idempotent: they preserve the existing revocation timestamp and do not write duplicate audit updates.
- The worker-share service also rejects direct API invites for workers who are already active members of the target restaurant, matching the UI picker boundary.
- Worker acceptance revalidates current source-restaurant membership, active user state, and owner-account membership, and rejects stale invitations if the worker has left the source restaurant or has already joined the target restaurant directly. Inactive workers are also blocked at auth before they can answer invitations.
- Worker acceptance rejects pending invitations that were valid when sent but became stale because the worker left the owner account before consenting.
- Worker acceptance also revalidates current source and target restaurant ownership, so a pending invitation cannot be accepted after either restaurant leaves the owner account.
- Worker decline and owner revoke use the same current restaurant-ownership revalidation, preventing stale share cleanup actions from writing audit rows against restaurants that have moved to another owner.
- Worker acceptance and candidate ranking revalidate the worker's current source-restaurant role, so a stale kitchen/floor invitation cannot survive a role change.
- Worker accept/decline mutations require the invitation owner to match the worker's active owner context, matching the owner-scoped pending-invitation list.
- Worker pending-invitation React Query keys are active-restaurant scoped, so switching active owner/restaurant cannot reuse stale pending invitations from another owner context.
- Worker pending-invitation API responses are also active-owner scoped; a multi-owner worker does not see owner A invitations while active in owner B.
- Worker-share owner lists and worker pending-invitation lists filter stale authorizations when the source or target restaurant no longer belongs to the authorization owner.
- Worker-share owner lists also hide active share rows when the source membership is inactive, the source role changes, the worker leaves the owner account, or a direct target membership appears, so managers do not see stale scheduling shares as current.
- Worker pending-invitation lists hide invitations that can no longer be accepted because the source membership was deactivated, its role changed, or the worker already gained direct membership in the target restaurant.
- Autostaffing model input now includes accepted same-owner shared workers with target-restaurant profile fields, while sibling/source restaurant services count only as worker hard constraints and do not inflate target restaurant slot fill.
- Autostaffing also ignores stale accepted shares once the worker gains direct target membership, matching the roster, candidate, notification, and WhatsApp-context retirement rule.
- Dashboard and bot-backed planning mutations can schedule accepted shared workers into the target restaurant, and their overlap checks include sibling/source restaurant services.
- Dashboard and bot-backed planning mutations validate accepted shared workers against the exact service role, so a floor-only share cannot be used for a kitchen service or the reverse. Dashboard service create, patch, and move reassignment paths have focused regressions for this boundary, and manual service creation/reassignment fails closed for stale accepted shares after consent, ownership, membership, active-worker, or target-profile drift.
- The dashboard schedule page now loads a dedicated scheduling roster instead of the broad `/users` HR list. The roster includes accepted shared workers with scheduling-only fields and blanks contact details; shared workers are marked in the worker rail with a compact icon.
- Internal WhatsApp team, prompt context, worker-resolution, worker-send-schedule, worker-schedule, worker-hours, worker clock-in/out, planning-preparation, delete-preparation, replacement-preparation, and targeted open-shift preparation surfaces can resolve accepted shared workers through a scheduling-only roster row, with target profile role/sub-role/contract-hours context and no shared worker phone/HR/payroll/document fields. Leave-scoped worker resolution deliberately excludes accepted shared workers, so leave review/add tools stay direct-membership only. Shared-worker worker-send-schedule, worker-schedule, worker-hours, clock-in/out, and delete-preparation output stay scoped to the target restaurant and do not reveal, notify, match, or offer mutations for source-restaurant services. Shared-worker clock-in/out confirmation notifications also carry the target restaurant name for multi-restaurant admins. The internal WhatsApp team, prompt-context, planning-preparation, delete-preparation, replacement-preparation, and clock-in/out routes now have stale-share or target-scope regressions for consent, revocation, source membership, source role, owner membership, active worker, ownership, target profile drift, source-service isolation, or notification context where applicable. Planning preparation checks source/sibling restaurant overlaps before telling the bot a service can be added. Replacement preparation filters candidates by the service role before pick or broadcast output; replacement broadcast preparation returns only live roster-valid candidate ids, so stale or wrong-role candidates are not handed back to the bot. Replacement broadcast mutation also persists only live candidate ids after revalidation. Targeted open-shift preparation rejects wrong-role workers before creating an open-shift row.
- Internal WhatsApp shared-worker target context also fails closed after the worker gains direct target membership, so the normal restaurant membership path becomes the only active context.
- Internal WhatsApp availability now treats accepted shared workers without target-restaurant availability rows as "disponibilité à confirmer" instead of available by default, source/sibling restaurant services appear as already scheduled elsewhere, and stale accepted shares are hidden even when a target availability row exists.
- Internal WhatsApp weekly recap and compliance stay target-restaurant scoped for shared workers: source-restaurant services do not inflate target recap totals or compliance alerts, while target-restaurant services for accepted shared workers still count.
- Internal WhatsApp team schedule and team-on-date views stay target-restaurant scoped for shared workers: source services do not appear in team views, while target services for accepted shared workers are visible.
- Internal WhatsApp pending requests now use direct-membership leave scope for holidays and live scheduling roster scope for replacements: accepted shared-worker leave requests stay out of HR summaries, live target replacement summaries can appear, and stale shared-worker replacement summaries disappear. Worker self-service holiday list/create endpoints also require direct active restaurant membership, so a shared-worker target context cannot read or create target-restaurant leave records.
- Those stale-invitation and already-target-member failures return `409 Conflict` with stable machine codes, which the web panel localizes instead of showing raw codes.
- Shareable-worker and worker-share invite/list validation errors use the same stable machine-code vocabulary as the mutation service, and the web panel has localized copy for those codes in French, English, Spanish, and Portuguese.
- Workers cannot accept or decline another worker's invitation, and non-owner managers cannot revoke worker-share authorizations.
- Workers cannot answer worker-share invitations after they are already accepted or revoked, preventing duplicate consent/decline audit rows.
- Worker acceptance creates a minimal target `worker_restaurant_profiles` row when one does not already exist, with regression coverage proving source restaurant contract, payroll, matricule, hourly rate, manager notes, HR documents, and medical fields are not copied. Existing target profile rows are preserved.
- Worker decline leaves the target restaurant without a worker profile, so a non-consented share invitation does not create target scheduling/employment metadata.
- Share list responses expose scheduling identity only; they intentionally omit contact, HR identity, payroll, manager-note, document, and medical data.
- Share list responses include source and target restaurant display names for context, but still omit worker contact, HR, payroll, document, and medical data.
- Target-restaurant managers see shared workers through the scheduling roster only as scheduling identity, without HR, payroll, manager-note, medical, document, IBAN, or NIR fields.
- Medical documents from the source restaurant are not exposed through worker-share authorization; document list/download routes still require active restaurant membership and restaurant-scoped documents.
- Invite, accept, decline, and revoke actions write `audit_logs` rows against the target restaurant with table name `worker_share_authorizations`, and audit `changes` stay limited to share metadata (`sourceRestaurantId`, `targetRestaurantId`, `userId`, `role`, `status`) instead of source restaurant HR/payroll/profile fields.
- The web preferences profile tab exposes invite, pending invitation, accept/decline, and revoke controls with localized copy.
- Replacement/open-shift candidate ranking includes only accepted same-owner shares with worker consent.
- Shared-worker scheduling roster, manual service creation, direct replacement targeting, replacement/open-shift candidate ranking, and autostaffing ignore stale accepted share rows when `revoked_at` is set.
- Baseline solver fingerprints include live accepted shared-worker authorizations and target worker profiles, so accepting, revoking, or changing a shared worker invalidates cached autostaffing inputs.
- Candidate ranking treats sibling-restaurant services as hard overlap constraints and includes sibling-restaurant hours in weekly-cap checks.
- Shared-worker replacement/open-shift candidate ranking and autostaffing require explicit target-restaurant availability for the requested day/zone; local workers keep the legacy no-availability-row fallback.
- Open-shift claims revalidate those sibling-restaurant constraints before materialising the target-restaurant service, so a worker who becomes busy in the source restaurant after solicitation can no longer claim.
- Open-shift claims, claimable lookup, solicitation, and the internal WhatsApp claim route also revalidate source-restaurant weekly hours before materialising, offering, or messaging the target-restaurant service, so stale candidate lists cannot bypass the shared worker's target profile cap.
- Open-shift claims also revalidate source membership activity, source role, worker active state, owner membership, direct target-membership retirement, and source/target restaurant ownership before materialising a service, so stale accepted shares cannot be claimed after the original candidate list becomes invalid.
- Open-shift claimable lookup revalidates live candidate eligibility before returning a shift to the worker, so WhatsApp does not offer stale shared-worker shifts after source/target ownership changes, inactive source membership, inactive worker accounts, owner-membership loss, source-role drift, weekly-cap drift, or direct target-membership retirement.
- Open-shift claimable lookup now returns the most recent eligible shift and hides expired or already-rejected shifts before claim, matching the worker-facing helper contract.
- Open-shift solicitation and targeted no-response expiry revalidate live candidate eligibility before messaging the next worker or notifying the admin, so stale shared-worker candidates are skipped without being notified, marked solicited, or reported as no-response after source/target ownership changes, inactive source membership, inactive worker accounts, owner-membership loss, weekly-cap drift, source-role drift, or direct target-membership retirement. The central shared-worker boundary guard pins this revalidation path.
- Open-shift solicitation continues to the next live candidate when an earlier stored candidate has gone stale.
- Open-shift solicitation also continues to the next live candidate when an earlier stored candidate has already rejected the shift.
- Open-shift solicitation now expires the shift when no live candidates remain, including when every stored candidate has already rejected the shift, avoiding open-but-unclaimable stale shifts.
- Open-shift solicitation also expires when the shift creator can no longer be resolved for candidate messaging, so a broken notification context does not leave an open-but-unreachable shift.
- The open-shift solicitation processor counts that broken notification-context expiration as `done`, so cron diagnostics do not report it as a repeated pending send.
- The open-shift solicitation processor also preserves separate `waiting` and `done` counts when one shift is still inside its solicitation interval and another expires in the same pass.
- The processor has a mixed-pass regression for `sent`, `waiting`, and `done` together, so one successful solicitation does not mask blocked or expired shifts in the same cron run.
- The processor ignores already closed open shifts, preventing cron passes from notifying or mutating expired/claimed rows.
- The `/cron/open-shift-solicitations` endpoint has route-level coverage for processor counts, persisted cron-run diagnostics, and ignored closed rows.
- The cron middleware is covered for missing and invalid secret handling after moving the secret lookup to request time.
- Open-shift no-response timeout also revalidates the already-solicited worker before notifying the admin; stale shared-worker candidates, including source/target owner drift, weekly-cap-stale, inactive source membership, source-role-stale, inactive worker, owner-membership-stale, and direct-target-member candidates, expire quietly instead of producing a misleading no-response alert.
- Worker notification copy treats accepted worker-share target restaurants as messaging context, so a shared worker without target membership still receives target-restaurant schedule/replacement/open-shift messages with the restaurant name prepended. Stale accepted shares are ignored for notification context once consent is missing, the share is revoked, the source membership is inactive or role-mismatched, the worker loses owner membership, the worker account is inactive, source/target ownership drifts, or the worker gains direct target membership.
- Candidate ranking revalidates source-restaurant membership for accepted shares, so stale accepted authorizations do not keep ex-source workers eligible.
- Candidate ranking also excludes accepted shared workers after the source user account becomes inactive or leaves the owner account.
- Candidate ranking excludes stale accepted shares after the source or target restaurant leaves the authorization owner account, or after the worker gains direct target membership in any role.
- Shared-worker candidate ranking uses the target restaurant `worker_restaurant_profiles` row for scheduling metadata such as priority, sub-roles, contract dates/hours, weekly caps, HCR level, hourly rate, matricule, and manager notes. It does not use source/global user compatibility columns for those target-scoped decisions.
- Monthly schedule recaps use the active scheduling roster role for accepted shared workers, so legacy/source `users.role` drift does not leak into target-restaurant recap output.
- WhatsApp worker preference self-service uses the target restaurant `worker_restaurant_profiles` row for accepted shared-worker contract/max-hour display and max-hour updates, while keeping the source user row untouched for target-specific scheduling caps.
- Baseline solver fingerprints ignore stale accepted shares once the worker gains direct target membership, so local membership state is the single source of solver identity.
- Replacement candidate lookup falls back from CP-SAT to the direct share-aware ranker when CP-SAT returns no candidate or cannot run. This keeps accepted shared workers discoverable in replacement flows while owner-group solver mode remains deferred.
- Direct replacement requests that pre-pick a target worker now validate with the same scheduling-eligibility helper and live candidate ranker as planning, so accepted same-owner shared workers can be selected without granting them target-restaurant HR membership.
- Direct replacement requests also validate the pre-picked shared worker against the requester service role, conflicts, availability, weekly caps, and the full live-share boundary: accepted/not revoked, active source membership, source role, owner membership, active worker account, source/target owner match, target worker profile, and direct target-membership retirement.
- WhatsApp replacement review preparation resolves accepted shared candidates through the scheduling roster before admin pick/broadcast decisions, so the bot can name shared candidates without opening HR membership scope.
- Replacement admin review revalidates live candidate eligibility before pick/broadcast decisions, so stale shared-worker candidates are not notified after authorization, ownership, membership, or availability changes.
- Worker pending replacement lists also revalidate direct and broadcast offers before showing them, so WhatsApp self-service does not present stale shared-worker replacement opportunities.
- Worker pending replacement lists hide broadcast offers the worker already rejected, so a declined broadcast does not keep resurfacing as actionable.
- Worker pending replacement lists hide expired direct and broadcast offers.
- Worker replacement accept and reject actions revalidate direct and broadcast offers before mutating replacement state, returning conflict without changing the original service or rejection list when the candidate has become ineligible. Acceptance skips newer stale or expired direct/broadcast offers, ignores already-rejected offers, skips unrelated newer broadcasts, and can continue to a live broadcast when a stale direct offer exists instead of blocking the worker's newest actionable offer.
- WhatsApp team schedules, worker schedule sends, worker self-schedule/hour reads, timeclock service matching, replacement summaries, replacement review prompts, planning notifications, and same-day sibling transfers after replacement acceptance now treat accepted shares as role-aware: direct restaurant members keep the existing behavior, but accepted shared workers only see or trigger target-restaurant services whose `services.role` still matches the accepted share role, and accepted replacements only transfer sibling services the acceptor is eligible to work.
- Revoked shares immediately remove target-restaurant candidate eligibility.
- `multi_restaurant_willing` / `multiRestaurantWilling` remains preference/display/backfill plumbing only; it is not authorization.

Still deferred from Phase 6:

- Owner-group solver mode.
- Broad cross-restaurant schedule optimization.
- Owner-level payroll.
- Sharing HR, payroll, manager notes, medical documents, or dossier access across restaurants by default.
- Cross-owner worker sharing.
- Owner-wide worker employment profiles beyond the compatibility/profile rows already added.

Covered by tests:

- Shareable-worker endpoint rejects cross-owner source restaurants and returns scheduling identity only.
- Shareable-worker and worker-share invite/list endpoints return stable validation codes for missing source restaurant, invalid role, same source/target restaurant, inaccessible restaurant, and malformed invite payloads.
- Shareable-worker listing and direct invite reject inactive source users and source workers outside the owner account.
- Accepted shared-worker ranking rejects inactive source users and source workers no longer in the owner account.
- Pending share alone does not make a sibling worker eligible.
- Accepted share makes a same-owner source worker eligible for target replacement/open-shift candidates.
- Revoked share removes eligibility.
- Sibling restaurant services exclude shared workers for overlaps.
- Weekly-hour candidate checks aggregate source and target restaurant services for shared workers.
- `multi_restaurant_willing` alone does not authorize cross-restaurant candidate eligibility.

Acceptance:

- Shared workers can be proposed only after explicit same-owner authorization and worker consent.
- Cross-restaurant candidate eligibility uses the same conflict/hour checks as normal replacement/open-shift candidate selection.
- Non-home restaurant managers see scheduling identity only unless a future, explicit HR/payroll/document sharing design is implemented.

## Phase 7: Per-Owner DB Extraction

Goal: move from logical owner tenancy to physical tenant isolation after the model is proven.

Implementation:

- Add master DB tenant resolver.
- Move tenant-scoped data into owner DBs.
- Namespace object storage by owner id.
- Add tenant migration runner.
- Add per-owner backup/export/delete.
- Update cron runner to iterate tenants and record failures per owner.

Acceptance:

- One owner can be backed up, restored, exported, or deleted independently.
- Cron failures are isolated per owner.

## Hard Stops

Do not proceed to shared workers until:

- Restaurant switcher is stable.
- Route migration tests prove active restaurant isolation.
- Billing has an owner-level dedupe rule.
- WhatsApp ambiguous context handling is implemented.

Do not proceed to per-owner DB extraction until:

- Logical owner tenancy has shipped and survived real usage.
- Route and object-storage authorization are owner/restaurant aware.

## Release Readiness For Switcher/Billing/Legal Slice

Review before staging this branch:

- Confirm migrations `0115` through `0120` run against a copied production-like database and backfill owners/memberships without orphaning active users; for Phase 7 readiness smoke, continue the copied DB through `0122` and run the preflight/report assertion runbook.
- Review the API tenant-scope guard allowlists; every remaining `users.restaurant_id` production read should be a documented compatibility fallback.
- Review owner-admin boundaries for restaurant create/update, owner billing, and owner legal acceptance.
- Smoke the browser switcher with at least one owner admin who is `admin` in restaurant A and `manager` in restaurant B.
- Smoke onboarding for a newly created second restaurant and verify switching back does not show stale schedule, team, settings, billing, or document data.
- Verify Stripe webhook behavior in a staging Stripe customer with one restaurant and with two restaurants under one owner.
- Keep Phase 6 limited to explicit accepted same-owner worker-share authorizations for replacement/open-shift candidate eligibility; `multi_restaurant_willing` remains a preference only.
