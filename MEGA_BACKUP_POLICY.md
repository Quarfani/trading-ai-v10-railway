# MEGA Backup & Recovery Policy

MEGA is an archive/DR target. It is never the live trading database.

## Schedule
- Every 6h: consistent SQLite snapshot + archive + SHA-256 + remote verification.
- The newest 6-hour checkpoints form the daily retention set.
- Weekly: full restore drill in an isolated directory.
- Monthly: disaster-recovery drill from MEGA only.
- Pre-deploy / pre-migration / pre-risk-change: event backup.

## Naming
`tradingai_db_full_YYYYMMDDTHHMMSSZ.zip`
with matching `.sha256` and `.manifest.json`.

## Integrity
Every archive gets SHA-256. Daily verification re-downloads the archive from MEGA and compares SHA-256. A mismatch invalidates the backup.

## Retention
- 14 daily
- 8 weekly
- 3 monthly
- Event backups are stored under `/critical` and are kept separately from daily retention.
Never delete the newest valid full backup or the newest restore-tested backup.

## Restore
1. Download archive.
2. Verify SHA-256.
3. Extract to isolated directory.
4. Run SQLite `PRAGMA integrity_check` and `PRAGMA foreign_key_check`.
5. Reconcile restored state against broker state before resuming trading.
6. Any mismatch => NO TRADE.

## Secrets
Do not place `.env`, API keys, passwords or private keys in MEGA archives. Credentials are injected at runtime from environment/secret storage.

## Event backups
Set `MEGA_BACKUP_CLASS=critical` before a pre-deploy, pre-migration, or emergency backup. Critical backups are isolated from daily retention.

## Ownership
The Windows PC/research host runs the MEGA archive agent. Railway keeps only short-lived runtime snapshots on its persistent volume. This avoids installing heavy MEGA tooling in the 1GB Railway paper container.
