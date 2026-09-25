# Disaster Recovery

Recovery design currently covers persistent execution ledger, SQLite WAL mode/checkpointing, startup reconciliation, broker-state verification and graceful shutdown.

The S3 remote-backup integration is not yet production ready because its request signing is explicitly simplified. Do not treat remote S3 backup as a proven disaster-recovery control until SigV4/authentication and restore drills are validated.

Chaos tests for crash-during-open/close/SL/TP were not executed in this audit environment.
