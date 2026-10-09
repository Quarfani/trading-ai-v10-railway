# Production Gate

Production is **NOT READY**. Creating a valid environment configuration does not imply the software has passed its release gate.

## Configuration guardrails

- `DEPLOYMENT_PROFILE=production` rejects `MODE=paper`.
- Binance production requires `MODE=binance`, `BINANCE_ENV=mainnet`, and `LIVE_TRADING_ACK=I_UNDERSTAND_LIVE_RISK`.
- MT5 live execution requires `MT5_LIVE_TRADING_ACK=I_UNDERSTAND_MT5_LIVE_RISK`, independent of the Binance acknowledgment.
- Mainnet/testnet keys must not be shared; deployment secrets must be stored only in the target runtime secret manager.

## Release blockers

Do not enable real-money execution until reproducible builds, the full test suites, Docker/cloud startup, dependency/security review, authoritative broker accounting, failure/restart/chaos tests, Testnet evidence, paper soak evidence, cost and slippage calibration, out-of-sample/walk-forward/Monte Carlo stress evidence, rollback, and disaster-recovery drills have been completed and reviewed. Profitability is not established by a clean build or a healthy service.
