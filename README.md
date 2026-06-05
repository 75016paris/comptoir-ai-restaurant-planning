# Comptoir — AI restaurant workforce planning

Comptoir is a vertical SaaS project for restaurant staff planning.

It combines a web dashboard with a WhatsApp AI assistant to help restaurant teams manage schedules, availability, holidays, replacements, hours, and staffing constraints.

> Status: portfolio/publication mirror. Demo restaurants and users are synthetic. The original private history, secrets, runtime databases, logs, and deployment internals are intentionally excluded.

## Try the live demo

The fastest way to understand the product is to try the hosted demo:

**https://comptoir.cosmobot.fr → “Essayer la démo”**

The demo page lets you enter without a password as several fake restaurant accounts, including:

- **Mon restaurant** — fresh onboarding sandbox with no employees or services.
- **Chez Reno** — simpler restaurant planning demo.
- **The Grand Brasserie** — larger restaurant with richer staffing, holidays, replacements, preferences, and planning constraints.

The local seed reproduces these fake demo restaurants. In local development, run `bun run db:seed`, then open `/demo`.

## Why this project matters

Restaurant planning is operationally messy: split shifts, weekly constraints, absences, replacements, overtime, role coverage, labor-law checks, and last-minute messages from staff. Comptoir explores how a small business tool can combine:

- a structured dashboard for managers;
- a WhatsApp assistant for day-to-day staff interactions;
- scheduling/optimization logic;
- permissions and multi-restaurant isolation;
- billing, notifications, and deployment practices.

## Main capabilities

- **Planning dashboard** — employees, schedules, availability, holidays, replacements, payroll/hour tracking, staffing profiles, and compliance indicators.
- **Synthetic demo seed** — fake restaurants, managers, workers, schedules, holidays, replacement requests, staffing objectives, and demo login flows.
- **WhatsApp assistant** — conversational assistant for admins/managers/workers with role-aware tools and confirmation flows.
- **Scheduling engine** — OR-Tools CP-SAT sidecar with fallback solver paths for planning constraints.
- **Permissions and isolation** — role/permission guards and multi-restaurant boundaries.
- **Billing and onboarding** — Stripe subscription/trial flow and onboarding flows.
- **Testing discipline** — type checks, unit/integration tests, web lint/build, and assistant-evaluation material.

## Project role and scope

This is a solo product-building project, developed with AI coding assistants as accelerators.

My work focused on product framing, workflow design, data model iteration, integration, debugging, test/evaluation scenarios, deployment operations, and documentation. I present it as applied AI/product engineering proof: a concrete business tool, not a claim of senior full-stack or production-scale ML expertise.

## Tech stack

| Area | Stack |
|---|---|
| Frontend | React, TypeScript, Vite, Tailwind, shadcn/ui, TanStack Query |
| API | Hono on Bun, REST APIs, cookie sessions, CSRF, rate limiting |
| Database | SQLite/WAL, Drizzle ORM, migrations, synthetic seed data |
| AI assistant | LLM tool/function calling, WhatsApp Cloud API, voice-note STT path |
| Scheduling | Python OR-Tools CP-SAT sidecar, optimization constraints |
| Billing | Stripe subscriptions, webhooks, usage reporting logic |
| Ops | Linux VPS deployment experience, Caddy/systemd/logs/backups in private deployment docs |
| Tests | Bun tests, TypeScript checks, web lint/build, assistant eval/bench material |

## Repository structure

```text
packages/
  api/        Hono API, DB schema/migrations, seed data, business services, scheduling logic
  web/        React dashboard and demo entry points
  whatsapp/  WhatsApp assistant, agent loop, Meta client, role-aware tools
  shared/     Shared types and validation helpers
scripts/      Local development helpers only
```

Private deployment scripts, production host details, runtime databases, logs, `.env` files, and old agent/session history are intentionally excluded from this public mirror.

## Local development

Requirements:

- Bun
- SQLite-compatible local database path
- Python 3 only if you want to run the optional CP-SAT solver sidecar locally

Typical setup:

```bash
bun install
cp .env.example .env
bun run db:migrate
bun run db:seed
bun run dev
```

Then open:

```text
http://localhost:5173/demo
```

The seed creates fake demo restaurants and users. The demo page does not require a password. For direct seeded-account login flows, the seed also uses the shared demo password printed by the seed script.

Optional CP-SAT solver sidecar:

```bash
cd packages/api/solver
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python cpsat_server.py
```

WhatsApp/LLM paths require local or hosted model credentials. Leave those disabled unless you intentionally configure them from `.env.example`.

## Verification

Useful checks:

```bash
bun run typecheck
bun test
bun run --filter '@comptoir/web' lint
bun run --filter '@comptoir/web' build
```

Current public mirror verification passed with:

```text
1356 tests passed
33 skipped
0 failed
web lint exited 0 with existing warnings
web build passed
```

## Data and privacy

- Demo restaurants/users are synthetic fixtures.
- The seed script cleans and recreates demo restaurants only; it is designed not to wipe real non-demo restaurants.
- Runtime SQLite databases, backups, logs, and local `.env` files are excluded.
- This mirror was created from a tracked source tree with private history removed.
- Do not use this mirror with real customer data without your own security review.

## Bernardo / AI assistant evaluation

The WhatsApp assistant work is important, but the detailed evaluation story belongs in a smaller standalone repo:

> `bernardo-ai-agent-eval-harness` — planned

That repo should focus specifically on tool routing, relative dates, permissions, cross-restaurant isolation, confirmation flows, prompt-injection resistance, and expected database mutations.

This Comptoir mirror keeps the assistant source and relevant tests in context, while the future Bernardo repo will make the AI-evaluation evidence easier to inspect independently.

## License / usage

License not decided yet. For now, this repository is published as portfolio/source-available material; reuse requires explicit permission.
