# Architecture overview

Comptoir is organized as a Bun workspace monorepo.

## Packages

- `packages/api` — Hono API, Drizzle schema/migrations, auth, permissions, scheduling services, billing, notification APIs.
- `packages/web` — React dashboard for restaurant owners/managers/workers.
- `packages/whatsapp` — WhatsApp webhook server, agent loop, Meta client, tool layer, assistant prompts, voice-note path.
- `packages/shared` — shared TypeScript types and validation helpers.

## Core flows

1. Managers configure staff, availability, staffing targets, and schedule constraints in the web dashboard.
2. The API persists business state in SQLite via Drizzle.
3. The scheduling engine generates or assists schedule drafts.
4. Workers and managers can interact through WhatsApp for schedule questions, holiday requests, replacement flows, and notifications.
5. Role and tenant guards restrict what each actor can see or mutate.
6. Tests and eval scripts exercise normal business behavior plus failure-prone AI-agent boundaries.
