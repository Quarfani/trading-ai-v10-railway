# AI DEVELOPMENT HANDOFF CURRENT

## PROJECT
Repository: Quarfani/trading-ai-v10-railway
Branch: main
Current head: verify refs/heads/main before resuming
Current validated checkpoint: CI #549 passed for commit c1eb40fc08c3624691b06f3533fe43ff7e924410

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
- The current main/branch SHA must be checked before claiming any later CI run is green.

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

## NEXT TASK
After the current main validation run is green:
A. Validate the atomic execution-ledger claim/reconciliation hardening through CI.
B. Continue paper execution/reconciliation soak evidence, then testnet/cloud E2E evidence, without automatically resolving UNKNOWN states.

## STOP/RESUME
1. Read this file and verify current main SHA.
2. Check the latest CI run for the current head.
3. Never overwrite unresolved execution-ledger entries automatically.
4. Keep one concrete NEXT TASK only.

## CURRENT MAIN CI STATUS
- Main HEAD: caf0d9f46b61aeef66c01d8c44a4c35a6b019d27
- Latest successful main CI: #549 (c1eb40fc08c3624691b06f3533fe43ff7e924410)
- Main CI #550 and #551 completed as failures. Both runs finished within seconds and their job step summaries/log blobs are currently unavailable through the GitHub integration, so the exact failure cause is not verified.
- Do not burn Actions minutes on blind reruns. First establish whether this is an Actions/billing/runner-level block; GitHub Free includes 2,000 Actions minutes/month and usage can be blocked after quota exhaustion when no valid payment method/budget is available.

## BINANCE RUNTIME RECOVERY CANDIDATE
- Branch: hardening/binance-runtime-recovery-release-candidate
- Adds bounded /fapi/v1/allOrders lookup by deterministic clientOrderId and createdAt.
- Full and partial closes can be reconciled from authoritative broker history after an ambiguous timeout.
- Reconciler requires exactly one attributable unresolved operation per trade and DB settlement is atomic.
- Full recovery checks executed quantity and verified flat position; partial recovery checks executed quantity and remaining position quantity.
- Canceled/expired historical orders are not treated as successful recovery; ambiguous cases remain blocked.
