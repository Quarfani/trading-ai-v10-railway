# AI DEVELOPMENT HANDOFF

## PROJECT
Repository: Quarfani/trading-ai-v10-railway
Branch: main
Current commit: f2a295b92d7d4ae91b28e262faf03c28f20e9ec2
Current message: test: verify purged and embargoed walk forward validation

## TARGET
Adaptive Quantitative Trading Decision System:
- Crypto + Forex + Gold + Oil
- M1/M5/M15/M30/H1/H4/D1
- unified market/contract/timeframe model
- risk, cost, exposure, currency conversion, validation, adaptive research
- paper -> testnet -> production gating

## COMPLETED
- Seven canonical timeframes in the market domain.
- Cross-asset MarketCatalog with fail-closed unknown symbols.
- Account-currency conversion and cached live conversion provider.
- Cross-asset exposure/leverage and currency-aware sizing.
- Quarter-Kelly behavior with negative-Kelly fail-closed.
- Shared CostModel and versioned CostProfiles.
- PaperTrader partial-close entry-cost attribution and cash settlement fixes.
- Multi-timeframe confirmation fail-closed.
- StrategyDefinition / lifecycle persistence and transition history.
- Strategy scope eligibility in Consensus.
- Hard minimum Consensus weight gate; single-strategy bypass removed.
- EvidenceScore + ExpectedValue.
- HistoricalAnalogEngine.
- StrategyDecay + Champion/Challenger.
- ConvictionGateEngine.
- FailureMemoryStore + Counterfactual analysis.
- MonteCarloStress utilities.
- FalseSignalEngine integrated into TradingEngine.
- News calendar freshness fail-closed.
- Runtime strategy lifecycle gate before execution.
- Dynamic configured stablecoin-quoted crypto classification.
- HistoricalCurrencySeries with direct/inverse timestamped conversion and validation.
- CostModel supports distinct entry/exit conversion rates.
- Backtester uses historical conversion and fails closed on missing/non-covered FX.
- BrokerContractRegistry with provenance/verification/expiry checks.
- MarketCatalog broker-contract override integration.
- Purged/Embargoed Walk-Forward research framework.
- CI failure diagnostics improved to preserve child test output.
- Latest CI run on current main completed successfully.

## CURRENT RISKS / GAPS
1. Purged WFO is a generic research framework; it is not yet orchestrated directly over Backtester folds.
2. EvidenceScore does not yet derive walk-forward stability automatically from WFO outputs.
3. Oil/energy contract definitions remain unsupported until broker-confirmed metadata is supplied.
4. Paper/live non-USD execution still needs explicit runtime currency conversion injection; Backtest path is strict.
5. Monte Carlo recovery-time metric and stress friction model need research-grade hardening.
6. Full OOS evidence, dataset-quality controls, regime coverage, parameter sensitivity, and leakage audit are not yet end-to-end.
7. Long paper/testnet and broker/cloud E2E evidence remain outstanding.
8. Production promotion must eventually require explicit evidence snapshots and broker qualification.

## NEXT TASK
Integrate PurgedWalkForward with the research layer:
- Add a WFO evaluator that consumes Backtest fold results.
- Compute per-fold OOS PnL, trade count, cost-adjusted PF and stability.
- Feed derived stability and OOS sample into EvidenceScore.
- Preserve purge/embargo boundaries and fail closed on invalid folds.

## ACCEPTANCE CRITERIA
- No training sample overlaps validation label windows.
- Purge and embargo are recorded per fold.
- Backtest fold results are explicitly marked OOS.
- EvidenceScore can be generated from WFO output without hand-entered stability.
- Insufficient/invalid folds block evidence promotion.
- Existing CI remains green.
- Changes committed to main.
- This file updated with the new current SHA.

## STOP PROTOCOL
Before any stop:
- verify main SHA
- record completed work and files
- record exact CI state
- record blockers/risks
- set one concrete NEXT TASK
- commit the handoff update to main
