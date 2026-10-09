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

## Phase 9 — Continued source hardening (2026-10-09)

### Changes made on the development branch

- **Consensus correctness:** a single vote may use half the configured aggregate-weight threshold only when it is the only vote and its confidence is at least 0.72. The ordinary threshold remains in force for medium-confidence votes; a 0.56-confidence single vote below the configured weight threshold still results in NO_TRADE. Malformed confidence values and non-finite/zero strategy weights are ignored, and non-finite aggregate weights fail closed.
- **Final portfolio risk:** post-risk sizing multipliers cannot increase the originally approved volume. After absolute per-trade risk is re-applied, the engine re-checks gross exposure/leverage and portfolio heat against the final volume and executable entry price immediately before execution.
- Paper mode now also fetches current marks for already-open positions before exposure checks. If a mark cannot be obtained, the existing exposure gate remains fail-closed instead of silently ignoring or mispricing a position.
- **Rate-limit abuse resistance:** caller-supplied `X-Forwarded-For` is ignored; proxy-derived client identity is opt-in. Proxy header values cannot receive the localhost exemption. Both the rate-limit state and login-attempt state have capacity limits; active bans are retained and new identities are rejected when capacity remains full.
- Railway ingress trust boundary is documented: `X-Real-IP` is used only when a request arrives through public HTTP ingress. Private `railway.internal` connections can bypass edge header sanitization, so untrusted private callers must not be allowed to reach the API while this trust flag is enabled.
- **Configuration safety:** credential placeholders are rejected at startup. Live broker mode and market-data source must match. Local, cloud Paper, Railway Paper, Binance Testnet, and production profiles have explicit constraints; Binance mainnet and MT5 have separate live acknowledgments. Consensus weighting/dominance/sample-window configuration is range checked.
- **API resource controls:** heavy research endpoints have separate rate-limit buckets and bounded schemas; numeric query limits and timeframe query values are parsed before reaching SQL or analytics.
- **Research accounting/resource cleanup:** backtest SQLite filenames include UUIDs; the database connection and temporary file are cleaned in a `finally` block. Mixed explicit/default transaction cost assumptions are labelled `MIXED`, not fully explicit.
- **Documentation/local Paper profile:** the local example now uses Binance public Spot data with Paper execution and ML/WFO disabled. README, environment, security, deployment, and Testnet instructions were aligned to Paper-first use.

### Test coverage added or extended (written, not executed as a full repository suite)

- Strategy consensus: a high-confidence single-vote case, a medium-confidence single-vote case, invalid confidence values, and non-finite established-strategy weights.
- Final-volume portfolio exposure and heat revalidation.
- Login and request rate-limit capacity behavior under high-cardinality IP traffic.
- Proxy-header loopback spoofing.
- Numeric/timeframe API query validation.
- Credential/deployment profile and consensus configuration validation.
- Backtest temporary-database cleanup and cost-profile classification.

### Verification status

- Latest source change: `1a96cc458dc93eb1cdef8e1e866652f67cc1e886` (Paper open-position marks; source-reviewed but not executed). The broader test additions were last committed in `05f937e892522ec38440ddcfc50212d0aade4341`. `main` remains `97a176f066848d1fa90d6e3eb8585fcaf50be650`; no merge or deployment has been performed.
- The repository tree contains **121 backend `.test.ts` files** and both backend/frontend `package-lock.json` files. The tree contains no tracked real `.env` file.
- GitHub check runs for broader test checkpoint `05f937e892522ec38440ddcfc50212d0aade4341`: **0**. Latest source-only change `1a96cc4...` and later documentation changes are not validated by CI. GitHub Actions were not launched.
- Backend `npm run typecheck`, `npm test`, backend build, frontend build, Python tests, dependency audit, Docker builds, Testnet E2E, Paper soak, and backup/restore drills remain **NOT RUN**.
- I attempted to retrieve the repository archive for local validation, but the archive downloader/tool path rejected the URL. This is a limitation of this execution environment; it is not evidence that the user's Internet connection is down. GitHub source operations remained available.

### Release disposition

**NOT COMPLETE / NO-GO for Testnet or real-money execution.** The changes improve fail-closed behavior but are not validated by a clean local build/test run or broker E2E. Do not create the new public repository or deploy to Railway until the candidate passes the actual release checklist.

