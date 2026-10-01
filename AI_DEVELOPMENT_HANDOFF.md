# AI DEVELOPMENT HANDOFF

## PROJECT
Repository: Quarfani/trading-ai-v10-railway
Branch: main
Current head: 1bbd817dcc1fa702e96dff0fe0634ebefafa930d
Current message: test: isolate broker timeframe and trade-mode fixtures

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
- CI run 36865834042 for commit fbe5ef405d1bc23c06d85e6eebe06a9cfbd7adb3: all backend/frontend/python jobs succeeded.
- Earlier CI run 36866050430 for f8a5232ed3a75eaf36b07f7a0152c2e1689302a1: backend/frontend/python jobs succeeded.
- Current head 1bbd817dcc1fa702e96dff0fe0634ebefafa930d is awaiting its own CI run; do not claim it green until run completes.

## IMPORTANT ARCHITECTURE
Market identity flow:
MT5 symbol_info -> /contract -> SymbolValidator -> BrokerContractRegistry -> MarketCatalog/MarketDefinition -> PositionSizer/Kelly -> ExecutionGateway.

The exact broker symbol is authoritative for runtime broker calls. Canonical symbol normalization is used only for internal identity/classification.

## CURRENT RISKS / GAPS
1. Full non-USD live broker E2E still needs real broker credentials/network evidence.
2. Paper and backtest cost engines are still separate; economic equivalence is not proven.
3. Tick metadata is captured but not yet used as the primary sizing formula; current sizing remains contract-size + explicit FX conversion.
4. MT5 order_calc_profit/order_calc_margin pre-trade risk estimation is not yet wired into the Node risk pipeline.
5. Long paper/testnet/cloud soak evidence is still outstanding.
6. Strategy lifecycle evidence, WFO calibration evidence, and Monte Carlo evidence remain separate domains.
7. Deployment docs/reference profiles need another consistency pass after the current broker-contract hardening.

## NEXT TASK
After current CI is green:
A. Add a Node/bridge MT5 pre-trade risk estimator using MT5 order_calc_profit in account currency and order_calc_margin as a final execution-side guard.
B. Add soak tests for paper mode and execution-ledger/reconciliation recovery.
C. Add real-runtime contract refresh/expiry observability to health/ready endpoints.
D. Then perform the long paper -> testnet -> cloud E2E evidence pass.

## STOP/RESUME
1. Read this file and verify current main SHA.
2. Check the latest CI run for the current head.
3. Never overwrite unresolved execution-ledger entries automatically.
4. Keep one concrete NEXT TASK only.
