# Testnet

Use a dedicated Binance Testnet API key and account. Never reuse production credentials.

## Required configuration

- `DEPLOYMENT_PROFILE=cloud-testnet`
- `MODE=binance`
- `DATA_SOURCE=binance`
- `BINANCE_ENV=testnet`
- `SYMBOLS` must contain supported Binance quote symbols (for example `BTCUSDT`)
- `BINANCE_API_KEY` and `BINANCE_SECRET` must be Testnet-only credentials
- `DASHBOARD_PASSWORD`, `SESSION_SECRET`, and `OPERATOR_PASSWORD` must be unique, strong secrets

The profile rejects paper mode, MT5, and Binance mainnet endpoints. Startup reconciliation and unresolved-ledger checks must pass before trading can resume. A strategy must be explicitly promoted to at least `TESTNET` lifecycle for the configured scope; `TESTNET` alone does not qualify for `PRODUCTION`.

Runtime broker E2E was **not tested** at the current development checkpoint. Do not mark this stage complete until actual controlled Testnet tests and restart/partial-fill evidence are recorded.
