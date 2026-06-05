# Commands

Sanitized public command reference.

## Install

```bash
bun install
```

## Development

```bash
bun run dev          # API + web + package dev tasks
bun run dev:api      # API only
bun run dev:web      # web only
bun run dev:wa       # WhatsApp bot only, requires configured LLM/Meta env
bun run dev:check    # local service health check
```

## Database

```bash
bun run db:migrate
bun run db:seed
bun run db:studio
```

## Verification

```bash
bun run typecheck
bun test
bun run --filter '@comptoir/web' lint
bun run --filter '@comptoir/web' build
```

Deployment commands and private operational scripts are intentionally excluded from this public mirror.
