# Trading AI v10 — Railway + GitHub + MEGA + 4GB Local Readiness

Date: 2026-09-23
Status: **PAPER-READY BY DESIGN / NOT PRODUCTION-READY**

## Operating model
- GitHub: source control + CI.
- Railway: single-replica paper Trading Core, risk, execution, reconciliation, persistent `/app/data`.
- Windows 4GB PC: development, dashboard, monitoring, and optional MEGA archive agent.
- MEGA: archive/disaster-recovery target only; never the live database.
- Heavy ML/WFO/Monte Carlo: off the 4GB PC.

## Fixes carried forward from the previous version
1. Safe paper-only Railway profile remains fail-closed.
2. Local 4GB profile now keeps ML/training/WFO disabled.
3. START.bat no longer launches the local ML server.
4. STOP.bat now kills only the process trees created by Trading AI instead of every `node.exe`.
5. DOWNLOAD_DATA.bat no longer runs the heavy `pipeline` command; it performs a bounded data download only.
6. Windows memory check uses CIM instead of deprecated WMIC.
7. A persistent runtime PID directory is ignored by Git.
8. Local `.env` is generated with random password/session secrets on first start and remains ignored.
9. Added `.gitattributes` to keep repository text encoding/line endings predictable.
10. Fixed the incremental Binance ingestor call to use the implemented bounded `fetch_range()` method.
11. Added MEGA consistent SQLite snapshots, SHA-256 sidecars, manifests, remote verification, retention, verified download and isolated restore checks.
12. Added a Windows scheduled-task installer for a 6-hour MEGA backup cadence.
13. Moved core MEGA backup commands to the Python archive agent rather than the previous placeholder Node/megajs path.
14. Added GitHub CI scaffolding.

## Tests executed in this environment
### PASS
- Python compileall: PASS.
- MEGA backup unit tests: **2 passed**.
- Full Python suite: **54 passed, 1 blocked/failing** because `pyarrow` is not installed in the audit environment.
- TypeScript/TSX parser scan: **142 files, 0 parser errors**.
- `python run_all.py --help`: PASS.

### BLOCKED / NOT TESTED
- Full Node install/build/test: dependencies are not installed in this environment and package registry access timed out previously.
- `package-lock.json`: still not generated because npm registry access timed out; therefore fully reproducible Node builds remain a P0.
- Docker build: Docker executable unavailable in this environment.
- Actual Railway deployment from the user's account: not executed from this environment.
- Actual MEGA upload/restore against the user's account: requires the user's MEGAcmd session/credentials.
- Binance live/testnet order execution: not tested.

## Safety boundary
The v10 package is designed for **paper mode first**. Do not add live Binance credentials to the Railway paper profile. Do not use MEGA as live state. Do not interpret successful CI/build as proof of profitability.

## Next gates before Testnet
1. Generate and commit backend/frontend lockfiles on a networked machine.
2. Run clean Node install/build/test.
3. Deploy the single Railway paper service and verify `/health` + `/ready`.
4. Verify Railway persistent volume behavior.
5. Configure MEGA credentials only in the Windows archive agent and execute one backup + SHA-256 remote verification + restore-check.
6. Run paper trading and restart/reconciliation drills.
7. Close the economic P0s: shared cost engine, exposure/leverage/currency risk, OOS/WFO/Monte Carlo/stress evidence.

## Disposition
**Ready to continue the controlled GitHub → Railway Paper → MEGA archive setup. Not ready for real-money production trading.**


## Current Status — 2026-10-09

This status supersedes earlier statements in this historical report about missing lockfiles and the earlier list of remaining economic-control work.

### Source-level hardening since the earlier report

- Backend/frontend lockfiles are present; Docker builds use `npm ci` and fail if a lockfile is missing.
- Shared cost profiles, exposure/leverage controls, and broker reconciliation are present in the development branch and require executed regression evidence.
- Deployment profiles now hard-stop unsafe combinations of Paper, Testnet, MT5, and production Binance environments.
- API IP resolution, state-map bounds, research endpoint schemas/rate limits, backtest SQLite cleanup, and backup encryption/S3 signing have been hardened.
- Tests were added for client IP resolution, deployment-profile safety, lifecycle separation, backtest temp-file cleanup, S3 SigV4, and streaming backup encryption/retention.

### Validation status

- Full Node typecheck/test/build, frontend build, dependency audit and Docker builds: **NOT RUN**.
- Isolated copied-helper checks: 12 SigV4 assertions, 7 encryption/retention assertions, and 5 client-IP assertions passed. These are not the repository's actual test suite.
- Binance Futures Testnet, S3-compatible live upload/restore, sustained Paper soak, recovery drills, and economic validation: **NOT RUN**.
- No new GitHub repository or Railway deployment has been created. No real trading enabled.

**Release disposition: NOT COMPLETE / NO-GO** until clean local installs, complete tests/builds, Testnet and restore/recovery evidence, and the release checklist pass.
