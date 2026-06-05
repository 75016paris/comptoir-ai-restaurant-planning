# Deployment overview

This public mirror does not include private deployment scripts or host-specific operations.

The private project has been deployed on a Linux VPS using:

- Caddy as reverse proxy/TLS layer;
- systemd services for API, web, WhatsApp bot, and solver processes;
- SQLite database files with WAL mode;
- health checks, logs, backups, and staging/production separation;
- environment variables stored outside the repository.

Sensitive details such as hostnames, deploy paths, service names, secret names, logs, database backups, and rollback scripts are intentionally omitted.

For local evaluation, use `README.md` and `COMMANDS.md` instead of deployment scripts.
