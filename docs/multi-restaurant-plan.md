# Multi-Restaurant Plan

Status: corrected implementation plan. This document replaces the earlier draft notes and is the source of truth for sequencing. Current implementation status and release checks live in `docs/multi-restaurant-execution.md`; the short reviewer map lives in `docs/multi-restaurant-review.md`.

## Product Scope

This plan covers two related but separate capabilities:

1. Multi-restaurant owner: one owner/account manages several restaurants and can switch active restaurant without logging out.
2. Cross-restaurant worker pool: selected workers can be proposed or scheduled in another restaurant owned by the same account.

Do not ship these as one feature. The restaurant switcher is tenant-context plumbing. The cross-restaurant worker pool is labor, privacy, solver, and notification semantics. Mixing them will create quiet data-scope and payroll bugs.

Current release status: phases `0` through `6` are achieved for this multi-restaurant release slice. Phase `6` implements the explicit same-owner shared-worker MVP with owner invite/list/revoke, worker accept/decline, scheduling-identity-only surfaces, candidate eligibility, and shared-worker scheduling guards. Phase `7` remains deferred and guarded out by release checks until it is intentionally started.

## Current Constraints

The current product is single-restaurant by construction:

- `users.restaurant_id` is the active tenant boundary.
- `restaurants` owns Stripe subscription fields and legal state is restaurant-scoped.
- Most routes derive scope from `c.get("user").restaurantId`.
- Frontend query keys do not include restaurant context.
- WhatsApp resolves one phone number to one active restaurant and explicitly blocks when the number maps to multiple restaurants.
- Solver, payroll, documents, holidays, replacements, open shifts, audit logs, and cron jobs assume one restaurant scope.
- `users.email` is globally unique, so the same person cannot naturally be represented as one login with multiple restaurant memberships.

Existing useful seed:

- `users.multi_restaurant_willing` already exists, but it is only a preference. It is not enough to authorize cross-restaurant scheduling.

## Product Decisions To Lock First

Tenant and legal unit:

- Use an `owners` or `accounts` table as the billing/legal tenant.
- Restaurants belong to an owner/account.
- Per-owner DB later maps naturally to this owner/account id.

Worker employment model:

- A worker has one identity/login, but restaurant-specific employment metadata.
- Contract, hourly rate, HCR level, matricule, DPAE data, payroll visibility, notes, documents, and WhatsApp consent must be owner-wide or restaurant-specific by explicit design.
- MVP default: keep employment, payroll, documents, and notes restaurant-specific.
- Cross-restaurant scheduling is allowed only inside the same owner/account after explicit opt-in.

Cross-restaurant labor compliance:

- Legal weekly hours, consecutive days, rest periods, and overlap constraints must be computed across all restaurants under the same owner/account when a worker is shared.
- Payroll export remains per restaurant unless owner-level payroll export is intentionally added.

Billing:

- Move Stripe customer/subscription state to owner/account.
- Seat billing counts active unique workers across the owner account for the month.
- Workers active in multiple restaurants count once.
- SIRET remains restaurant-level.
- Stripe metadata can no longer hold a single canonical SIRET unless the owner has one legal entity.

WhatsApp context:

- A multi-restaurant admin must select context when ambiguous.
- The bot must not guess the restaurant from a vague message.

## Target Data Model

Add these tables first, behind a compatibility layer:

```sql
owners (
  id text primary key,
  name text not null,
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text not null default 'active',
  subscription_period_end text,
  trial_ends_at text,
  cancel_at text,
  created_at text not null default current_timestamp
);

owner_memberships (
  owner_id text not null,
  user_id text not null,
  role text not null, -- owner_admin | owner_manager | member
  created_at text not null default current_timestamp,
  primary key (owner_id, user_id)
);

restaurant_memberships (
  restaurant_id text not null,
  user_id text not null,
  role text not null, -- admin | manager | kitchen | floor
  permissions text,
  active integer not null default 1,
  created_at text not null default current_timestamp,
  primary key (restaurant_id, user_id)
);

worker_restaurant_profiles (
  restaurant_id text not null,
  user_id text not null,
  priority integer not null default 1,
  sub_roles text not null default '[]',
  contract_type text,
  contract_hours integer,
  contract_end_date text,
  max_weekly_hours integer,
  admin_ot_override integer,
  hcr_level text,
  hourly_rate integer,
  matricule text,
  manager_notes text,
  multi_restaurant_willing integer not null default 0,
  primary key (restaurant_id, user_id)
);
```

Add `restaurants.owner_id`.

Migration compatibility:

- Backfill one owner per existing non-demo restaurant.
- Backfill one owner per demo group, or keep demos grouped deliberately if demo switching is needed.
- For each existing user, create owner and restaurant membership rows.
- Leave existing columns in `users` during the transition, but stop adding new logic to them.
- Build read helpers that resolve current v1 columns and v2 membership rows consistently.
- Do not remove `users.restaurant_id` until all routes are converted.

## Auth And Active Restaurant Context

Add a server-side active context before UI work:

- Extend `sessions` with `active_restaurant_id`, or add a `session_contexts` table.
- Add `GET /auth/restaurants` returning allowed restaurants for the current user.
- Add `POST /auth/active-restaurant` to switch context.
- Validate the requested restaurant against `restaurant_memberships` and `restaurants.owner_id`.
- Update `requireAuth` to set:
  - `user.ownerId`
  - `user.activeRestaurantId`
  - `user.restaurantId` as a temporary alias
  - `user.restaurantTimezone`
  - active membership role and permissions
  - list/count of accessible restaurants where needed

Rules:

- Never trust a raw `restaurantId` from the frontend unless validated against membership.
- Admin/manager permissions are restaurant-specific unless deliberately promoted to owner-level.
- Password-change, legal-acceptance, onboarding, and subscription gates must evaluate against owner/account plus active restaurant where appropriate.

## Frontend Context And Cache

Add a restaurant context provider after server context exists:

- `AuthUser` includes `activeRestaurantId`, `restaurantName`, and `restaurants`.
- Header gets a compact restaurant switcher next to the restaurant name.
- Switching calls `POST /auth/active-restaurant`, refreshes `/auth/me`, and clears or invalidates all restaurant-scoped queries.

Preferred query-key strategy:

- Prefix all restaurant-scoped keys with active restaurant id:
  - `["restaurant", restaurantId, "schedule", ...]`
  - `["restaurant", restaurantId, "employees", ...]`
  - `["restaurant", restaurantId, "settings", ...]`
- Keep truly user-global keys separate:
  - `auth/me`
  - owner billing
  - owner restaurant list

Minimum acceptable MVP:

- Clear the entire React Query cache on switch, then refetch `/auth/me`.
- Update the query-key catalog soon after; cache clearing is too easy to regress.

UI notes:

- The switcher belongs in `AppLayout`, where the restaurant name is currently displayed.
- Mobile drawer must show active restaurant and switcher.
- Subscription blocked and legal gates need owner-aware copy.
- Onboarding remains scoped to the active restaurant.

## API Migration Strategy

Create a central helper:

```ts
function requestRestaurant(c): RestaurantContext {
  // returns active restaurant id, owner id, role, permissions, timezone
}
```

Then migrate route families one at a time from `user.restaurantId` to `requestRestaurant(c).restaurantId`.

Order:

1. Auth/me and switch context.
2. Read-only settings, users list, schedule week.
3. Mutations for settings/users/services.
4. Holidays, replacements, open shifts, documents.
5. Payroll, timeclock, audit, admin alerts.
6. Autostaffing/optimizer.
7. Cron jobs and notification dispatch.
8. Internal WhatsApp API.

Testing rule:

- Every migrated route gets at least one test proving restaurant A cannot read or mutate restaurant B inside the same owner unless the endpoint is intentionally owner-wide.
- Also test restaurant B under a different owner remains inaccessible.

## Billing And Legal Migration

Move subscription fields from `restaurants` to `owners`:

- `stripeCustomerId`
- `stripeSubscriptionId`
- `subscriptionStatus`
- `subscriptionPeriodEnd`
- `trialEndsAt`
- cancellation fields

Keep restaurant fields temporarily mirrored until all reads are migrated.

Update billing services:

- Add `countActiveForOwner(ownerId, month)`.
- Count unique active non-admin users with at least one non-cancelled service in any owner restaurant.
- Return per-restaurant breakdown for UI.

Legal acceptance:

- Owner/admin CGU/DPA acceptance should reference `owner_id`.
- Worker/user notice remains per user.
- WhatsApp consent may need to become per restaurant if messages can come from several restaurants.

## Restaurant Management MVP

After auth context is stable:

- Add `POST /restaurants` for owner admins.
- Add `PATCH /restaurants/:id` for basic profile fields.
- Add restaurant list/switcher UI.
- New restaurant starts in onboarding.
- Existing owner admin is automatically restaurant admin for the new restaurant.
- Do not clone workers by default.

Out of scope for this phase:

- Shared workers.
- Cross-restaurant solver.
- Owner-level payroll.
- WhatsApp multi-context.

Acceptance:

- Owner can create a second restaurant, switch to it, complete onboarding, and switch back.
- No stale data appears after switching.
- Billing page shows owner-level subscription and active employee breakdown.

## Cross-Restaurant Worker Pool

Only begin after the switcher is stable.

Explicit worker sharing:

- Owner/admin invites or enables a worker for another restaurant.
- Worker sees and accepts cross-restaurant availability/consent.
- Store per-restaurant profile rows.
- `multiRestaurantWilling` becomes a preference, not an authorization by itself.

Privacy defaults:

- A manager in restaurant B can see only scheduling identity unless granted HR/payroll/document permissions for that worker in restaurant B.
- Medical documents are never shared across restaurants by default.
- Manager notes are restaurant-specific.

Scheduling rules:

Candidate search includes shared workers only when:

- same owner/account,
- worker opted in,
- target restaurant membership/profile exists or a temporary share authorization exists,
- legal constraints across the owner group pass.

## Solver And Staffing

Add group-aware availability input:

- Existing services for the worker across all owner restaurants are hard constraints.
- Weekly hours and rest checks aggregate across all owner restaurants.
- Target staffing demand remains restaurant-specific.
- Cost/contract completion uses the target restaurant profile unless owner-level employment is later introduced.

Solver modes:

- Single-restaurant mode: same behavior as today, but conflict data can include cross-restaurant services for shared workers.
- Owner-group mode: future mode for optimizing multiple restaurants together. Not required for MVP switcher.

Replacement and open-shift ranking must share the same conflict/compliance helper as autostaffing.

## WhatsApp

Phase 1: keep single active context.

- If a phone maps to multiple restaurants, reply with a context-selection prompt.
- Store selected restaurant in WhatsApp session state with a short TTL.
- Allow explicit restaurant names in user messages only after matching against membership.
- Tool context must include active restaurant id from the WhatsApp session, not from arbitrary model output.

Phase 2: cross-restaurant operations.

- Admin tools can answer owner-level questions only if a specific owner-level tool exists.
- Existing restaurant tools remain restaurant-scoped.
- Worker tools show services across restaurants only when the worker asks for "tout mon planning"; otherwise prefer current context and mention there are services elsewhere.

Must-test cases:

- Same admin phone in two restaurants.
- Same worker phone in two restaurants.
- Message naming another restaurant.
- Prompt injection asking for all restaurants.
- Subscription blocked for one restaurant but not another.

## Cron And Notifications

Cron jobs must fan out by owner and restaurant intentionally:

- Monthly digest: owner-level email with per-restaurant sections, or keep per-restaurant digest with explicit recipients.
- Dossier reminders: per restaurant.
- Timeclock reminders: per service restaurant.
- Schedule publication reminders: per restaurant.
- Billing events: owner-level recipient.

Notifications need restaurant context in message copy:

- Include restaurant name when recipient belongs to more than one restaurant.
- Avoid sending duplicate reminders to a worker shared across restaurants.

## Per-Owner DB Path

Per-owner DB should happen before broad cross-restaurant sharing if possible.

Needed pieces:

- Master DB: owners, login identities, sessions, Stripe state, owner DB path, phone/email routing metadata.
- Tenant DB: restaurants, users/memberships, schedules, services, documents metadata, audit logs.
- Tenant resolver middleware.
- Migration runner across all tenant DBs.
- Per-owner backup/restore/export/delete.
- Object storage keys namespaced by owner id.
- Cron runner iterates tenants safely and records failures per owner.

Do not combine per-owner DB migration with the first restaurant switcher release. First add owner schema in the current DB; then extract tenancy once the logical model is proven.

## Test Matrix

Add fixtures:

- Owner A with restaurants A1 and A2.
- Owner B with restaurant B1.
- Admin A belongs to A1/A2.
- Manager A belongs only to A1.
- Worker shared A1/A2.
- Worker A1 only.
- Worker B1 only.

Required tests:

- Auth restaurant switching validates membership.
- Query routes return active restaurant data only.
- Mutations cannot target sibling restaurants unless endpoint is explicitly owner-wide.
- Manager permissions are restaurant-specific.
- Billing active employee count dedupes shared workers.
- Solver rejects overlap across A1/A2.
- Payroll for A1 does not include A2 service unless owner-level payroll is requested.
- WhatsApp asks for context on ambiguous phone.
- Object/document access remains restaurant-scoped.
- Audit logs record active restaurant and actor.

## Rollout Plan

Phase 0: model and compatibility — achieved

- Add owner/membership tables and backfill.
- Keep app behavior unchanged.
- Add helper APIs and tests.

Phase 1: active restaurant context — achieved

- Add session active restaurant.
- Add switch endpoint and `/auth/me` restaurant list.
- No visible switcher yet except maybe dev/debug.

Phase 2: route migration — achieved for the main app route families

- Migrate route families to request restaurant helper.
- Add cross-tenant tests.

Phase 3: web switcher — MVP achieved

- Add restaurant switcher.
- Add cache invalidation/prefixing.
- Allow creating a second restaurant.

Phase 4: billing/legal owner migration — achieved for this release scope

- Move Stripe and legal acceptance to owner.
- Update billing UI and webhooks.

Phase 5: WhatsApp multi-context — core context guard achieved

- Add context selection and session-pinned active restaurant.

Phase 6: shared workers — MVP implemented and frozen for Phase 7

- Add memberships/profiles/consent.
- Update candidate ranking and solver constraints.
- Current MVP adds `worker_share_authorizations`, owner admin/manager invite/list/revoke, worker pending-list/accept/decline, accepted-share candidate eligibility, sibling-restaurant conflict/weekly-hour checks for replacement/open-shift ranking, target-restaurant scheduling roster use, role-aware planning/replacement/open-shift/timeclock/notification handling, and scheduling-identity-only web/WhatsApp surfaces.
- `multiRestaurantWilling` remains a preference only and does not authorize eligibility.

Phase 7: per-owner DB extraction — deferred and guarded out

- Move from logical owner tenancy to physical DB isolation.

## Implementation Guardrails

- `bun run --cwd packages/api test:tenant-scope` blocks new unreviewed `users.restaurant_id`, request-context `user.restaurantId`, and raw request restaurant-id tenant inputs, including `restaurantId`, `sourceRestaurantId`, and `targetRestaurantId`.
- `bun run --cwd packages/api test:active-context-coverage` keeps tenant-scoped route files mapped to active-context coverage.
- `bun run --cwd packages/api test:shared-worker-boundary` keeps `multiRestaurantWilling` as a preference, not shared-worker authorization, across API, shared, web, and WhatsApp code.
- `bun run --cwd packages/api test:deferred-phase-boundary` blocks concrete Phase 7/per-owner DB and owner-level payroll implementation markers across package manifests, env/config/deploy-adjacent files, API scripts/tools, solver sidecar files, root shell scripts, shared, web scripts/source, and WhatsApp tools/source.
- `bun run --cwd packages/web test:query-keys` keeps restaurant-scoped frontend cache keys routed through the active restaurant query-key catalog.
- `bun run --cwd packages/api db:check-multi-restaurant` checks migrated databases for owner/membership/context backfill gaps after applying migrations.

## Explicit Non-Goals For MVP

- One global calendar showing all restaurants.
- Multi-restaurant simultaneous optimization.
- Cross-owner worker sharing.
- Automatic worker cloning.
- Restaurant-level legal entities under one Stripe customer without a deliberate legal/billing design.
- Sharing HR, payroll, or medical documents across restaurants by default.

## Main Failure Modes To Guard Against

- Stale frontend cache after switch.
- A route still using old `user.restaurantId`.
- Billing counted twice or undercounted for shared workers.
- WhatsApp acting in the wrong restaurant.
- Solver ignoring services in a sibling restaurant.
- Manager seeing HR/payroll/medical data for a restaurant they do not manage.
- Cron jobs sending duplicate or wrong-restaurant notifications.
- Object storage documents keyed or authorized only by user id instead of restaurant/owner context.
