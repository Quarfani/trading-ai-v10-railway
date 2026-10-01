# AI DEVELOPMENT HANDOFF

## PROJECT
Repository: Quarfani/trading-ai-v10-railway
Branch: main
Current commit: b441e837ba392db82fe641d9da42bdbf6c922bef
Current message: test: enforce broker-confirmed Oil contract enrichment

## TARGET
Adaptive Quantitative Trading Decision System
Crypto + Forex + Gold + Oil
M1/M5/M15/M30/H1/H4/D1
Unified market/contract/timeframe model with explicit cost, FX, OOS/WFO and promotion evidence.

## COMPLETED
- HistoricalCurrencySeries: direct/inverse timestamp-aware conversion, validation and USD bridge.
- Historical FX loader for direct/inverse/bridge paths.
- CostModel: distinct entry/exit FX conversion.
- Backtester: historical FX, full-range coverage checks, DataQualityGate and explicit OOS evaluation start with warmup context.
- BrokerContractRegistry: verified broker metadata, provenance and expiry.
- MT5 bridge: authenticated /contract endpoint backed by symbol_info().
- SymbolValidator: broker-contract enrichment for MT5.
- Purged/Embargoed Walk-Forward framework.
- WFO Evidence adapter with OOS trades, PnL, cost-adjusted PF, stability, parameter sensitivity, regime coverage and dataset quality.
- WFO deployment parameters selected from training only; OOS cannot select the values.
- WFO and AdaptiveATR state scoped by symbol + timeframe.
- Live Risk/PositionSizer/Kelly sizing made currency + timeframe aware.
- Unified DataQualityGate; core adapter delegates to market validator.
- EvidenceSnapshotStore and migration 13.
- Central EvidencePromotionPolicy with configurable thresholds and freshness.
- ScheduledWFO across configured timeframes with historical FX and shared promotion policy.
- Local PowerShell handoff watcher integrated with START/STOP and ignored by Git.
- CI diagnostics preserve child test output.

## VERIFIED
Latest CI on main is green after c37ad360f5a9415482f9cdd494ad53765abbc47d.

## CURRENT RISKS / GAPS
1. Exact strategyId/symbol/timeframe EvidenceSnapshot is now required for SMALL_CAPITAL/PRODUCTION; Monte Carlo is additionally required when EVIDENCE_REQUIRE_MONTE_CARLO=true.
2. ScheduledWFO evidence is persisted, but strategy-level lifecycle and WFO calibration evidence remain separate domains.
3. Oil/energy activation requires real MT5 broker symbol metadata at runtime.
4. Full non-USD live broker E2E remains outstanding.
5. Monte Carlo recovery-time and stress-friction evidence need hardening.
6. Long paper/testnet/cloud E2E evidence remains outstanding.

## NEXT TASK
Extend broker-confirmed MT5 contract E2E to Forex/Metals runtime symbol-info flows and verify PositionSizer consumes refreshed contract economics; then extend long paper/testnet/cloud E2E.

## STOP PROTOCOL
Verify main SHA and CI; record blockers; update this file; keep the local AI_DEVELOPMENT_HANDOFF_CURRENT.md checkpoint; define one concrete NEXT TASK.
- Typed StrategyEvidence now includes optional Monte Carlo stress evidence.
- Monte Carlo promotion thresholds are configurable via EVIDENCE_* environment variables and backward-compatible by default.
