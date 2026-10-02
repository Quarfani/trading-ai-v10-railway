# AI DEVELOPMENT HANDOFF CURRENT

## PROJECT
Repository: Quarfani/trading-ai-v10-railway
Branch: main
Current head: 31c771ed1032e1bffdc8a46aaec3a941b3557ba2
Current validated checkpoint: CI #549 passed for commit c1eb40fc08c3624691b06f3533fe43ff7e924410 (latest known green; post-checkpoint changes are unverified until CI is available)

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
1. When GitHub Actions capacity/log access is restored, run the focused backend integration test and verify the current main head.
2. Until then, continue static/code-level hardening only; do not burn Actions minutes on blind reruns.
3. Next high-value area: audit Binance protective-order recovery and modify/cancel idempotency, then harden restart behavior.
4. Preserve UNKNOWN execution states and never auto-retry ambiguous broker operations.

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

## LAST DEVELOPMENT SESSION (2026-10-02)
- Added migration v15: execution_ledger.tradeId plus index (tradeId,status,updatedAt).
- createExecutionLedger now extracts request.tradeId into the indexed column while retaining requestJson compatibility.
- Reconciliation lookup uses the indexed tradeId first and falls back only for pre-v15 rows.
- Added integration assertion that tradeId is persisted.
- Fixed a migration syntax typo before stopping.
- Added atomic MT5 full-close reconciliation using DatabaseManager.resolveReconciledFullClose(), so broker-confirmed trade settlement and UNKNOWN-ledger resolution commit in one DB transaction.
- Added atomic MT5 partial-close reconciliation using DatabaseManager.resolveReconciledPartialClose().
- Preserved duplicate-operation safety: atomic partial reconciliation resolves only the selected UNKNOWN operation and deliberately leaves additional unresolved duplicate operations blocked.
- Added reconciled-close side effects only after the atomic DB transaction succeeds.
- Binance close and partial-close now carry deterministic clientOrderId values derived from the execution operation key.
- Binance execution recovery can locate the exact broker order by clientOrderId and verify authoritative realized PnL from userTrades before reconciliation.
- Binance full/partial reconciliation now resolves UNKNOWN operations only after exact order identity, FILLED status, quantity, position state, and authoritative PnL all match.
- Binance Spot closes now fail closed when authoritative realized PnL is unavailable instead of marking the local operation EXECUTED with unknown economics.
- Added Binance reconciliation safety integration coverage plus clientOrderId forwarding assertions.
- New commits in this session: 824e5c4d6ff3d007a9bc2430131d5bb3b0aa0555, 694753de3b53c348eb14f10af14f75aeeb97a623, 324aa1a3373709a6aebe03ffa45c75852b0b5da0, 35e2e41926fa89f39ee7aae21c048de38563673c, b1c44b4b0a97fdad7d5b76471abacf127f3baaef, f83dca05abb08ddb52084bb5b3f80c4b102cc576, f9bfbdaef70d9cf1fd712b73e43268e3c8750451, 5967fd7652c3ed52f2e547b97c780ccfa7d26369, ac910305bddbeecf65efadc689a0a41feae6d345, 31c771ed1032e1bffdc8a46aaec3a941b3557ba2
- CI has NOT been run on these changes because Actions capacity is exhausted; do not claim them verified until a green run exists.
