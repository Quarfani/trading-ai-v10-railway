# Security

## Implemented in the current development branch

- Dashboard/session secret validation and explicit operator/admin role separation.
- Broker-mode startup acknowledgments: Binance mainnet and MT5 require different explicit environment flags.
- Deployment-profile guards for local paper, Railway paper, cloud paper, Binance Testnet, and production.
- Venue matching for live execution and market-data source, so Binance execution cannot silently use MT5 tickers and vice versa.
- HMAC-signed sessions with timing-safe signature/password comparisons.
- Request body limits, CORS configuration, schema validation, global and expensive-research route limits.
- Client IP resolution ignores client-supplied `X-Forwarded-For`; Railway `X-Real-IP` is used only when explicitly enabled. A proxy header cannot grant the local-loopback rate-limit exemption. This trust applies only to requests arriving through Railway's public HTTP edge: private `railway.internal` traffic can bypass edge header sanitization and must not be accepted from untrusted internal callers while proxy trust is enabled.
- Rate-limit and login-attempt state maps have capacity bounds; the rate-limit cleanup timer does not pin short-lived processes.
- Unresolved execution operations and failed startup reconciliation block trading readiness.
- Binance protection changes use persisted operation identity and restart reconciliation.
- Database snapshots use SQLite's backup/snapshot path; optional backups can be encrypted with AES-256-GCM and uploaded with SigV4 signing.

## Not yet verified

- The full Node dependency audit and complete backend/frontend build/test suites have not been executed at the current candidate commit.
- The CI workflow includes production-dependency audit steps, but this is configuration evidence, not evidence of a passing run.
- S3-compatible upload and restore have not been verified against the actual target service; providers differ in path-style support, region configuration, and checksum semantics.
- No full runtime penetration test, distributed rate-limit test, sustained-load test, or multi-replica test has been performed.
- Binance Futures Testnet execution/reconciliation and MT5 broker end-to-end tests remain outstanding.
- Production secrets, database durability, recovery, and rollback must be tested in the target deployment environment.

## Operating rule

Keep Paper mode until the clean validation and paper-release gate passes. Do not infer safety or profitability from static review, CI configuration, or a healthy healthcheck alone.
