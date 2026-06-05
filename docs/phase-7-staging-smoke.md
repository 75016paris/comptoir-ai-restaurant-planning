# Phase 7 Staging Smoke Runbook

This runbook validates Phase 7 readiness on a copied or staging SQLite database. It does not switch runtime routing to physical owner databases.

Use `docs/phase-7-go-no-go-template.md` to archive the smoke decision beside the generated report and terminal output.

## Inputs

- A migrated SQLite database with migrations through `0122`.
- A writable output directory path that does not already exist.
- A writable JSON report path that does not already exist.

Example paths:

```sh
DATABASE_URL=/path/to/staging-copy.sqlite
RUN_ID=$(date +%Y%m%d-%H%M%S)
SNAPSHOT_OUT=/tmp/comptoir-phase7-readiness-$RUN_ID
REPORT_OUT=/tmp/comptoir-phase7-readiness-$RUN_ID.json
```

## Run

If the copied database is not already migrated through `0122`, migrate the copy first:

```sh
DATABASE_URL="$DATABASE_URL" bun run --cwd packages/api db:migrate
```

Generate the preflight snapshot and report:

```sh
DATABASE_URL="$DATABASE_URL" bun run --cwd packages/api phase7:readiness-preflight -- --out "$SNAPSHOT_OUT" --report "$REPORT_OUT"
```

Assert the archived report:

```sh
bun run --cwd packages/api phase7:assert-readiness-report -- --report "$REPORT_OUT"
```

If the snapshot directory should still be present, assert both the archived report and the referenced snapshot directory:

```sh
bun run --cwd packages/api phase7:assert-readiness-report -- --report "$REPORT_OUT" --require-snapshot-dir --expect-snapshot-dir "$SNAPSHOT_OUT"
```

For a staging smoke, also require that the report is fresh enough for the current run:

```sh
bun run --cwd packages/api phase7:assert-readiness-report -- --report "$REPORT_OUT" --require-snapshot-dir --expect-snapshot-dir "$SNAPSHOT_OUT" --max-report-age-minutes 60
```

If you know the expected high-level counts for the copied database, assert them too:

```sh
bun run --cwd packages/api phase7:assert-readiness-report -- --report "$REPORT_OUT" --require-snapshot-dir --expect-snapshot-dir "$SNAPSHOT_OUT" --max-report-age-minutes 60 --expect-owner-count 3 --expect-restaurant-count 3 --expect-user-count 51 --expect-service-count 5895 --expect-document-count 0 --expect-notification-count 0 --expect-chat-message-count 0 --expect-cron-run-count 0 --expect-total-database-bytes 3534848
```

## Pass Criteria

The preflight JSON must show:

- `reportVersion: 2`
- `generatedAt` is an ISO timestamp.
- `status: "pass"`
- `snapshotReportStatus: "pass"`
- `dryRunFailures: []`
- `splitSchemaIssues: 0`
- `splitScopeGaps: 0`
- `snapshotVerificationFailures: []`
- `documentIssueCount: 0`
- `documentPlanIssueCount: 0`
- `failures: []`
- `snapshotSummary.ownerDatabases` matches the expected owner count for the copied database.
- `snapshotSummary.restaurants`, `users`, and `services` are plausible for the copied database.
- `snapshotSummary.totalDatabaseBytes` is positive, and matches the expected value when the smoke records a fixed copied database.
- `directory` matches the generated snapshot directory path.

The assertion command must show:

- `status: "pass"`
- `expectedReportVersion: 2`
- `actualReportVersion: 2`
- `expectedSnapshotDirectory` matches the generated snapshot directory when `--expect-snapshot-dir` is used.
- `maxReportAgeMinutes` matches the freshness window when `--max-report-age-minutes` is used.
- `expectedSnapshotSummary` matches the provided count flags when they are used.
- `generatedAt` and `actualSnapshotSummary` show the archived report timestamp and copied snapshot counts for the smoke record.
- `snapshotDirectory` matches the report `directory` when `--require-snapshot-dir` is used.
- `failures: []`

## Go/No-Go Record

Treat the smoke as a start-gate record, not as permission to switch runtime storage immediately.

Record these answers beside the archived report:

- Copied DB source, copy timestamp, and migration level. It must be a copied or staging DB, not the live production DB.
- Exact preflight command and exact assertion command, including expected counts and total database bytes when known.
- Whether the snapshot directory was retained until review, and who reviewed the JSON report.
- Whether document storage was tested on rows with real object keys. If the copied DB has `0` object-backed documents, record that runtime object-key movement still needs a separate smoke.
- Backup location for the original single DB, restore command or procedure, and expected restore time.
- Decision: `go` means Phase 7 runtime resolver work may start in a new branch; `no-go` means keep the single DB as the only source of truth and fix the listed blocker first.

The first runtime Phase 7 branch still starts read-only: resolver instrumentation and health checks before moving writes.

## Fail Handling

Do not proceed to runtime Phase 7 work when either command fails.

Use the failure prefix to route the fix:

- `dry_run:*`: missing table or owner assignment problem in the source database.
- `split_schema:*`: missing durable scope columns, usually migration `0121` was not applied.
- `split_scope:*`: rows still lack durable owner/restaurant/scope metadata, usually migration `0122` or a write path needs review.
- `snapshot:*`: extracted files have dangling references, count mismatches, or integrity drift.
- `snapshot_report:*`: the generated snapshot identity report did not pass.
- `document:*` or `document_plan:*`: document storage rows are not safe for future owner-scoped object movement.
- `invalid_report_json:*`: the archived report file is unreadable or not valid JSON.
- `invalid_report_version:*`: the archived report was generated by an older report format.
- `snapshot_directory_mismatch:*`: the archived report points at a different snapshot directory than the one passed to `--expect-snapshot-dir`.
- `snapshot_summary_mismatch:*`: the archived report summary does not match an expected count flag.
- `stale_report:*`: the archived report is older than the `--max-report-age-minutes` freshness window.
- `future_report:*`: the archived report timestamp is later than the current machine time; check clock skew or regenerate the report.
- `missing_snapshot_directory:*`: the archived report points at a snapshot directory that is not present while `--require-snapshot-dir` is enabled.
- `Missing value for --report`, `--out`, `--expect-snapshot-dir`, `--max-report-age-minutes`, or an expected count flag: rerun with a complete flag value; the CLI validates these before opening the database.

## Keep

Keep these artifacts for the staging smoke record:

- The JSON report.
- The terminal output of both commands.
- The generated snapshot directory until the release decision is made.

Do not upload copied database files or snapshots to GitHub.
