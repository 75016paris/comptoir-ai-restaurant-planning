# Comptoir — AI restaurant workforce planning

Comptoir is a portfolio/publication mirror of a vertical SaaS project for restaurant staff planning.

It combines a web dashboard with a WhatsApp AI assistant to help restaurant teams manage schedules, availability, holidays, replacements, hours, and staffing constraints.

> Status: portfolio/source-available mirror. Demo data is synthetic. This repository is intended to show product, integration, AI workflow, testing, and deployment ability — not to be a turnkey commercial distribution.

## Why this project matters

Restaurant planning is operationally messy: split shifts, weekly constraints, absences, replacements, overtime, role coverage, labor-law checks, and last-minute messages from staff. Comptoir explores how a small business tool can combine:

- a structured dashboard for managers;
- a WhatsApp assistant for day-to-day staff interactions;
- scheduling/optimization logic;
- permissions and tenant isolation;
- billing, notifications, and deployment practices;
- AI-agent evaluation around tool routing, permissions, and prompt-injection resistance.

## Main capabilities

- **Planning dashboard** — employees, schedules, availability, holidays, replacements, payroll/hour tracking, staffing profiles, and compliance indicators.
- **WhatsApp assistant** — conversational assistant for admins/managers/workers with role-aware tools and confirmation flows.
- **Scheduling engine** — OR-Tools CP-SAT sidecar with fallback solver paths for planning constraints.
- **Permissions and isolation** — role/permission guards and multi-restaurant boundaries.
- **Billing and onboarding** — Stripe subscription/trial flow and demo restaurant seed data.
- **AI-agent reliability tests** — tool-routing, relative dates, permission boundaries, database mutation checks, and prompt-injection scenarios.

## My contribution / positioning

This is a solo product-building project developed with AI coding assistants as implementation accelerators.

My ownership was product framing, requirements, workflow design, data model iteration, integration, debugging, evaluation scenarios, deployment operations, and documentation. The project is presented honestly as applied AI/product engineering proof, not as a claim of senior full-stack or production-scale ML expertise.

## Tech stack

| Area | Stack |
|---|---|
| Frontend | React, TypeScript, Vite, Tailwind, shadcn/ui, TanStack Query |
| API | Hono on Bun, REST APIs, cookie sessions, CSRF, rate limiting |
| Database | SQLite/WAL, Drizzle ORM, migrations, seed data |
| AI assistant | LLM tool/function calling, WhatsApp Cloud API, voice-note STT path |
| Scheduling | Python OR-Tools CP-SAT sidecar, optimization constraints |
| Billing | Stripe subscriptions, webhooks, usage reporting logic |
| Ops | Linux VPS deployment experience, Caddy/systemd/logs/backups in private deployment docs |
| Tests | Bun tests, TypeScript checks, web lint/build, AI-agent eval/bench scripts |

## Repository structure

```text
packages/
  api/        Hono API, DB schema/migrations, business services, scheduling logic
  web/        React dashboard
  whatsapp/  WhatsApp assistant, agent loop, tool definitions, eval/bench material
  shared/     Shared types and validation helpers
scripts/      Local development helpers only
```

Private deployment scripts, production host details, runtime databases, logs, `.env` files, and old agent/session history are intentionally excluded from this public mirror.

## Local development

Requirements:

- Bun
- Python 3 for the optional CP-SAT solver sidecar
- SQLite-compatible local database path

Typical setup:

```bash
bun install
cp .env.example .env
bun run db:migrate
bun run db:seed
bun run dev
```

Optional solver sidecar:

```bash
cd packages/api/solver
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python cpsat_server.py
```

WhatsApp/LLM paths need local or hosted model credentials. Leave those disabled unless you intentionally configure them from `.env.example`.

## Verification

Useful checks:

```bash
bun run typecheck
bun test
bun run --filter '@comptoir/web' lint
bun run --filter '@comptoir/web' build
```

Some tests or integrations may require local environment values. Public demo credentials/secrets are not included.

## Data and privacy

- Demo restaurants/users are synthetic fixtures.
- Runtime SQLite databases, backups, logs, and local `.env` files are excluded.
- This mirror was created from a tracked source tree with private history removed.
- Do not use this mirror with real customer data without your own security review.

## AI evaluation note

The WhatsApp assistant is not just a prompt demo. The project includes evaluation/bench material for practical assistant reliability, including:

- correct tool selection;
- relative-date handling;
- permission boundaries;
- cross-restaurant isolation;
- destructive-action confirmation;
- prompt-injection resistance;
- expected database mutations.

A smaller standalone showcase repo, `bernardo-ai-agent-eval-harness`, is planned to make this evidence easier to inspect independently.

## License / usage

No open-source license is granted at this stage. The code is visible as portfolio/source-available material. You may read it for evaluation, but reuse requires explicit permission.
