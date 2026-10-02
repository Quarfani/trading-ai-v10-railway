# Risk Model

## Current enforced controls

- Per-trade hard cap: 2% of current equity after sizing modifiers.
- Configurable daily loss limit.
- Configurable weekly loss limit.
- Configurable maximum drawdown gate, using persisted equity peak state.
- Max open trades.
- Portfolio heat.
- Spread and slippage gates.
- Confidence and minimum R:R gates.
- SL/TP direction validation.
- Circuit breaker and emergency-stop checks.
- Correlation filtering.
- Fail-closed equity and sizing-state validation in non-paper modes.
- Gross exposure and gross leverage gates are enforced before order admission using canonical contract notional and explicit quote-to-account FX conversion; MT5 requires broker-confirmed contract metadata.
- Optional independent same-symbol and correlation-bucket exposure gates are enforced at the final RiskManager admission point when configured; omitted values preserve legacy behavior.

## Known gaps

Current `MAX_LEVERAGE`, `MAX_EXPOSURE`, `MAX_SYMBOL_EXPOSURE`, and `MAX_CORRELATED_EXPOSURE` gates are enforced at the final RiskManager admission point when configured. Existing-position and proposed-position notionals are converted into account currency; missing market/FX/broker metadata fails closed. Remaining execution-control gap is a separately defined post-trade execution-latency SLO/guard; broker-specific margin/maintenance semantics beyond gross notional leverage remain broker-dependent.

## Sizing

The audited sizing path computes risk from stop distance × contract size, applies Kelly/drawdown/quality/R:R modifiers, then re-applies the absolute cap and symbol quantity constraints. Any live sizing database/persistence failure is now fail-closed.
