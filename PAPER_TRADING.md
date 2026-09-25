# Paper Trading

Paper mode shares the main signal/risk/execution/reconciliation classes, but no real broker order should be sent.

## Gate to operate

1. Set `MODE=paper`.
2. Configure `DASHBOARD_PASSWORD` and `SESSION_SECRET`.
3. Keep `LIVE_TRADING_ACK` unset.
4. Run backend tests and the Python pipeline tests after installing all requirements.
5. Observe health, risk, execution-ledger and reconciliation events.

## Limitation

Paper and backtest cost modelling are still separate implementations. Until a single shared cost engine covers commission, spread, slippage, maker/taker, funding, market impact and partial fills, paper economics are not equivalent to production economics.
