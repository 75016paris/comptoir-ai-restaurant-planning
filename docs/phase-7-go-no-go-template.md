# Phase 7 Go/No-Go Record

Use one copy of this record per copied or staging database smoke. This is a release decision artifact, not a runtime migration script.

## Smoke Identity

- Date:
- Reviewer:
- Copied/staging DB source:
- Copy timestamp:
- Applied migration level:
- Snapshot output directory:
- JSON report path:

## Commands Run

Preflight:

```sh
DATABASE_URL=... bun run --cwd packages/api phase7:readiness-preflight -- --out ... --report ...
```

Strict archived-report assertion:

```sh
bun run --cwd packages/api phase7:assert-readiness-report -- --report ... --require-snapshot-dir --expect-snapshot-dir ... --max-report-age-minutes ... --expect-owner-count ... --expect-restaurant-count ... --expect-user-count ... --expect-service-count ... --expect-document-count ... --expect-notification-count ... --expect-chat-message-count ... --expect-cron-run-count ... --expect-total-database-bytes ...
```

Document storage smoke:

```sh
DATABASE_URL=... bun run --cwd packages/api phase7:document-storage-audit
DATABASE_URL=... bun run --cwd packages/api phase7:document-storage-plan
DATABASE_URL=... bun run --cwd packages/api phase7:document-storage-verify-plan -- --plan ...
```

## Expected Counts

- Owners:
- Restaurants:
- Users:
- Services:
- Documents:
- Notifications:
- Chat messages:
- Cron runs:
- Total generated SQLite bytes:

## Result Summary

- Preflight status:
- Assertion status:
- Report version:
- Snapshot report status:
- Dry-run failures:
- Split schema issues:
- Split scope gaps:
- Snapshot verification failures:
- Document issues:
- Document plan issues:
- Assertion failures:

## Object Storage

- Copied DB contains object-backed documents: yes/no
- If yes, move manifest path:
- If no, separate document-object staging smoke required before runtime object-key movement: yes/no

## Backup And Restore

- Backup path for the original single DB:
- Backup timestamp:
- Restore procedure:
- Restore test completed: yes/no
- Expected restore time:
- Rollback owner/source-of-truth rule:

## Go/No-Go

- Decision: go/no-go
- Reason:
- Required fixes before next attempt:
- Runtime branch allowed next: read-only resolver instrumentation only / no

## Runtime Branch Guardrails

- Single DB remains the source of truth until export/import/restore is verified.
- First runtime branch must start read-only: resolver instrumentation, health checks, and failure reporting before moving writes.
- Writes stay on the current single DB until owner-local restore, backup, delete, and cron fan-out behavior are proven.
- Do not drop single-DB tenant tables during the first runtime branch.
