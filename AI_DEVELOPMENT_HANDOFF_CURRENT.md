# AI DEVELOPMENT HANDOFF CURRENT

## PROJECT
Repository: Quarfani/trading-ai-v10-railway
Branch: main
Current main baseline: b00a5c62597d34337490c9500311a75cdaa22882
Current hardening branch: hardening/combined-runtime-reliability
Current validated checkpoint: CI #548 passed for commit 5df114afb2ec7f3e797ef232186dd1f054d4332a
Current validation caveat: CI #550 for the execution-ledger state-machine commit failed twice before any job steps/logs were created; the new state-machine code therefore remains unvalidated by CI.

## TARGET
Adaptive Quantitative Trading Decision System
Crypto + Forex + Gold + Oil
M1/M5/M15/M30/H1/H4/D1
Unified market/contract/timeframe model with explicit broker economics, currency conversion, OOS/WFO evidence, promotion gates, execution/reconciliation safety.

## RECENTLY COMPLETED
- Broker-confirmed MT5 contract registry now preserves the exact broker symbol spelling/case.
- SymbolValidator enriches MT5 contracts and returns the broker's exact runtime symbol.
- PositionSizer and KellyPositionSizer consume broker-confirmed contract economics instead of stale static values on the live path.
- Static MarketCatalog economics are timeframe-aware.
- Broker-declared supported timeframes are propagated to MarketDefinition and blocked before signal computation/sizing.
- MT5 execution routes through the exact brokerSymbol.
- MT5 bridge open endpoint is aligned to /trade.
- MT5 bridge contract payload now exposes trade permissions, tick economics, volume limits, stop/freeze levels and margin metadata.
- Broker trade mode is respected by PositionSizer for BUY/SELL opening gates.
- CurrencyConversionProvider preserves exact broker suffixes during FX conversion lookup.
- MT5 broker-contract refresh runs every 6 hours; expired metadata fails closed.
- Existing WFO/Monte Carlo/evidence-promotion work remains intact.
- Startup reconciliation and execution-ledger safety remain in force.

## VERIFIED
- CI #523 for commit 1879743a73ea051e8608096f58d298d5fda9f4fb passed backend/frontend/python.
- CI #524 for commit 110e973d45383faf226bca128d4f203aa0780747 passed backend/frontend but exposed a Python simulation-path regression; it is fixed in the reconciliation hardening line.
- Reconciliation hardening includes authoritative MT5 close-state gating, stable idempotency persistence, simulation replay protection, and atomic execution-ledger operation claims.
- CI #548 passed all three validation jobs (backend/frontend/python).
- The current main SHA must be checked before claiming any later CI run is green; do not treat CI #550 as a code-test failure because it produced no job steps or logs.

## IMPORTANT ARCHITECTURE
Market identity flow:
MT5 symbol_info -> /contract -> SymbolValidator -> BrokerContractRegistry -> MarketCatalog/MarketDefinition -> PositionSizer/Kelly -> ExecutionGateway.

The exact broker symbol is authoritative for runtime broker calls. Canonical symbol normalization is used only for internal identity/classification.

## CURRENT RISKS / GAPS
1. Full non-USD live broker E2E still needs real broker credentials/network evidence.
2. Paper and backtest cost engines remain separate; economic equivalence is not proven across all asset classes.
3. Tick metadata is captured, but sizing remains primarily contract-size + explicit FX conversion.
4. Long paper/testnet/cloud soak evidence is still outstanding.
5. Strategy lifecycle evidence, WFO calibration evidence, and Monte Carlo evidence remain separate domains.
6. Deployment docs/reference profiles need another consistency pass after broker-contract hardening.
7. Real-runtime broker-contract refresh/expiry behavior still needs soak evidence.
8. Full reconciliation under broker/network interruption needs runtime evidence; code now fails closed on ambiguous closure, duplicate operation claims, corrupt persisted execution results, and conflicting partial position/history state.
9. Binance accepted CLOSE/CLOSE_AT_MARKET operations now carry deterministic clientOrderId values and have authoritative FILLED-order recovery paths for both startup and runtime reconciliation; incompatible currency or partial-fill ambiguity remains blocked.
10. MT5 runtime reconciliation now atomically settles authoritative full/partial close states; unrelated unresolved executions prevent inferred settlement.
11. Paper daily-loss accounting includes realized partial-close PnL for still-open trades, and SQLite-level ledger state constraints are prepared as defense-in-depth.

## NEXT TASK
Restore a valid CI validation path for the combined runtime-reliability hardening branch; once green, merge it to main and continue paper execution/reconciliation soak evidence, then testnet/cloud E2E evidence without automatically resolving UNKNOWN states.

## STOP/RESUME
1. Read this file and verify current main SHA.
2. Check the latest CI run for the current head.
3. Never overwrite unresolved execution-ledger entries automatically.
4. Keep one concrete NEXT TASK only.
