# Architecture

## Current repository layout

- `bot/backend`: Node.js/TypeScript API, trading engine, risk, execution, reconciliation, SQLite state.
- `bot/frontend`: React/Vite dashboard.
- `pipeline`: Python ingestion, cleaning, features, training, model serving and tests.
- `bot/mt5_bridge.py`: Flask bridge for MetaTrader 5.
- `data/models`: local model artifacts.

## Intended runtime flow

```text
React/TSX
  -> Backend API / WebSocket
  -> TradingEngine
  -> DataQualityGate
  -> Strategy / Consensus
  -> ML/AI advisory gate
  -> Economic/Risk gates
  -> PositionSizer / PortfolioHeat
  -> ExecutionGateway
  -> BinanceExecutor or MT5 bridge
  -> Startup/periodic reconciliation
  -> SQLite ledger / trades / risk events
```

## Safety boundaries implemented in the audit

- Central configuration validation and mode-specific fail-closed checks.
- Persistent `execution_ledger` for idempotent order operations.
- Live ambiguous executions are marked `UNKNOWN` and are not auto-retried.
- Startup reconciliation is mandatory before live/testnet execution.
- Protective-order verification is part of Binance startup reconciliation.
- ML can advise/filter, but cannot bypass risk, execution or emergency-stop layers.
- Missing authoritative Binance close history no longer becomes a fabricated PnL.
- MT5 close accounting requires authoritative history.

## Runtime / network

Backend default API port is configured through `API_PORT` and the health endpoints are `/health`, `/ready`, and `/liveness`. The MT5 bridge uses `MT5_BRIDGE_PORT`. Container-to-container communication must use environment-configured service addresses, not `localhost`.

## Current architectural blockers

1. No repository lockfiles are present, so reproducible `npm ci`/Docker builds cannot currently be verified.
2. No compose file or CI workflow was found.
3. Cost modelling is split between backtest and paper implementations and does not yet represent the full requested funding/impact/partial-fill model.
4. Max leverage/exposure are validated as configuration but are not fully enforced in the RiskManager.
5. Cross-currency exposure/risk conversion is not complete.
6. Strategy lifecycle stages are documented conceptually but are not enforced as an executable promotion gate.

## Railway / Low-Resource Cloud Profile

The recommended first cloud deployment is a **single Railway backend service** from `bot/backend` in `MODE=paper` with `DATA_SOURCE=binance` and only Binance-quoted paper symbols. The service uses `/health`, `/ready`, and `/liveness`; `/ready` is a strict readiness gate that requires at least one validated market symbol.

The Railway profile disables automatic ML training, automatic WFO parameter mutation, and the unfinished remote S3 upload path. Heavy ML/backtesting/WFO/Monte Carlo should remain outside the 1GB trading-core service until a larger cloud environment is available.

Use a single replica for the trading core. Do not horizontally scale this service.
