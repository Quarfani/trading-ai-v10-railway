# Operations

## Startup

1. Validate environment and mode.
2. Initialize database and migrations.
3. Connect broker/external services.
4. Run startup reconciliation.
5. Only resume trading after healthy reconciliation.

## Shutdown

Send SIGTERM/SIGINT. The application now awaits engine stop, WAL checkpoint and HTTP server close. Uncaught/unhandled process errors activate fail-closed shutdown paths.

## Recovery

An unresolved `PENDING`/`UNKNOWN` execution ledger entry blocks startup. Reconcile broker state first; do not manually delete ledger state to bypass a mismatch.

## Alerts

Telegram is treated as notification-only; trading must not depend on Telegram availability.
