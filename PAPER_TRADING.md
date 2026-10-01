# Paper Trading

Paper mode shares the main signal/risk/execution/reconciliation classes, but no real broker order should be sent.

## Gate to operate

1. Set `MODE=paper`.
2. Configure `DASHBOARD_PASSWORD` and `SESSION_SECRET`.
3. Keep `LIVE_TRADING_ACK` unset.
4. Run backend tests and the Python pipeline tests after installing all requirements.
5. Observe health, risk, execution-ledger and reconciliation events.

## Limitation

Paper execution and backtesting now share the repository `CostModel`/`CostProfiles` accounting for commission, spread, market impact and holding cost, including partial fills. This establishes model-level economic consistency, but does not prove equivalence with live broker fees, fills, funding, latency or execution quality.
