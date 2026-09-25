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

## Known gaps

The repository validates `MAX_LEVERAGE` and `MAX_EXPOSURE`, but the final order decision does not yet enforce them with a complete cross-asset notional model. `maxSymbolExposure`, `maxCorrelatedExposure`, and `maxExecutionLatency` are not yet first-class limits. Cross-currency conversion and contract-specific margin calculations are incomplete. These are production blockers.

## Sizing

The audited sizing path computes risk from stop distance × contract size, applies Kelly/drawdown/quality/R:R modifiers, then re-applies the absolute cap and symbol quantity constraints. Any live sizing database/persistence failure is now fail-closed.
