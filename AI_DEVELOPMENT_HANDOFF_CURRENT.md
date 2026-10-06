# AI DEVELOPMENT HANDOFF CURRENT

## PROJECT
Repository: Quarfani/trading-ai-v10-railway
Branch: main
Current head: 268b18168a0e39e1e30758d0b6281b5b061303b2 (review branch `fix/binance-close-reconciliation-validation`; based on main 97a176f066848d1fa90d6e3eb8585fcaf50be650)
Current verified status: Local validation on the follow-up changes passed TypeScript typecheck and the focused Binance close-protection suite. The full backend suite completed with 605 passed and 19 failed. No green GitHub Actions run exists; Actions capacity is exhausted, so do not rerun workflows until capacity is restored.

## TARGET
Adaptive quantitative trading decision system for Crypto + Forex + Gold + Oil with:
- canonical market/broker contract identity
- explicit contract economics and account-currency conversion
- OOS/WFO evidence and promotion gates
- deterministic execution idempotency
- broker-authoritative reconciliation
- fail-closed risk/data/execution gates
- restart-safe emergency controls
- ML prediction/training integrity

## RESOURCE CONSTRAINTS
- GitHub Actions quota is exhausted for the current billing cycle. Avoid workflow reruns unless capacity is restored.
- A direct container clone attempt failed at the container DNS layer while GitHub integration remained operational. This is a tool/runtime limitation, not evidence that the user's internet is down.
- Continue development through GitHub static/code-level changes until runnable local/CI validation is available.

## COMPLETED IN CURRENT DEVELOPMENT LINE

### Execution ledger / atomic persistence
- Added execution_ledger.tradeId in migration v15 with an index on (tradeId,status,updatedAt).
- createExecutionLedger extracts request.tradeId into the indexed column while retaining requestJson compatibility for legacy rows.
- Reconciliation lookup prefers indexed tradeId and falls back to parsing pre-v15 requestJson.
- OPEN persistence is now atomic: local trade insertion and execution-ledger EXECUTED transition occur in one transaction.
- Atomic OPEN result now persists the local trade id so idempotent replay after restart returns a complete Trade identity.
- Full close, partial close, and SL/TP reconciliation have atomic DatabaseManager helpers.
- Terminal execution-ledger states remain one-way; ambiguous broker operations stay UNKNOWN and are never auto-retried.
- Added rollback coverage for atomic OPEN and SL/TP settlement.

### Binance execution / recovery
- Full and partial closes use deterministic clientOrderId values derived from execution operation keys.
- Binance clientOrderId generation is constrained to the documented <=32-character format and allowed character set.
- ExecutionGateway and BinanceExecutor now use the SAME clientOrderId derivation so recovery searches for the exact identifier that was submitted.
- Binance close/partial-close require FILLED status and expected executed quantity.
- Full and partial closes verify broker post-close position state; unavailable position state is ambiguous and fails closed.
- Binance full close requires authoritative realized PnL from broker fill history.
- Futures PnL recovery uses userTrades and can recover a weighted average fill price when order avgPrice is missing/zero.
- Binance close recovery matches operationKey -> clientOrderId -> exact broker order -> FILLED status -> quantity -> position state -> authoritative PnL.
- Startup reconciliation attempts exact recovery for CLOSE, CLOSE_AT_MARKET and PARTIAL_CLOSE.
- Binance protective SL/TP orders receive deterministic clientOrderIds derived from the MOVE_SL_TP/entry operation identity.
- Runtime MOVE_SL_TP recovery uses exact protective-order identity, validates status/side/type/price, and atomically updates trades.sl/tp plus the execution ledger.
- Binance protective-order state is continuously verified for open positions; missing/mismatched protection blocks further reconciliation/trading.
- Binance modify/close now recovers broker-visible protective order ids even after process restart instead of trusting the in-memory orderMap only.
- Cancellation uses the union of tracked and broker-visible protection ids and verifies they are gone before continuing.
- Entry-protection failure emergency close now uses a deterministic operation-derived client id and verifies the final position is actually flat.
- Binance close no longer treats getPosition()==null as a successful zero-position result.

### MT5 bridge / reconciliation
- MT5 bridge returns 503 for broker query failures instead of converting None into empty positions/history.
- /trade verifies authoritative post-entry broker position state, symbol/side, and SL/TP; malformed result becomes UNKNOWN.
- /close verifies post-close position state and authoritative deal history; residual or unavailable state becomes UNKNOWN.
- /modify verifies final broker SL/TP after DONE; mismatch/unavailable state becomes UNKNOWN.
- MT5 idempotency now binds each key to a canonical request fingerprint and rejects reuse for a different request with HTTP 409.
- Legacy MT5Bridge client now passes idempotency keys and treats non-authoritative responses as failure.
- Runtime and startup MT5 reconciliation recover verifiable MOVE_SL_TP operations atomically.
- Runtime MT5 protective-order drift blocks silently accepting unexplained broker SL/TP changes.

### Risk / capital protection
- Added centralized validateRiskConfiguration() fail-closed checks for malformed risk settings.
- PositionSizer and KellyPositionSizer reject non-finite/invalid inputs and prevent minimum-volume rounding from exceeding the calculated risk budget.
- Kelly non-positive edge now returns zero size instead of forcing broker minimum volume.
- ExposureGuard fails closed on invalid equity, prices, conversion, exposure, or leverage inputs.
- PortfolioHeat fails closed on invalid configuration/proposed-position inputs.
- DailyLossGuard uses start-of-day equity for live account checks and fails closed when the anchor is unavailable.
- DailyProfitTarget uses the same live start-of-day equity concept; zero target is treated as explicitly disabled; invalid target blocks in the standalone guard.
- DrawdownScaler fails closed on invalid current equity and invalid persisted peak state.
- CircuitBreaker validates persisted state, blocks on non-finite PnL, and blocks immediately when persistence fails.
- Fixed circuit-breaker cooldown expiry edge case: a state-save failure can no longer allow one additional trade cycle.
- SessionFilter rejects invalid/future timestamps, applies weekend closure to FX/Metals, keeps Crypto 24/7, and uses unified USDT/USDC crypto detection including synthetic symbols such as 1000PEPEUSDT.
- SpreadFilter rejects invalid/crossed quotes.
- CorrelationFilter rejects invalid/zero-variance live correlation data instead of silently treating it as zero correlation.
- NewsFilter is fail-closed when the economic calendar is stale, malformed, or timestamp-invalid.
- StaleDataGuard and DataQualityGate reject future/invalid timestamps.
- RiskManager validates signal symbol/side/confidence/timestamp/prices before R:R or downstream sizing.

### Emergency controls
- TradingEngine exposes explicit activateEmergencyStop/deactivateEmergencyStop APIs.
- Telegram /emergency now calls the real emergency-stop state instead of a non-existent function.
- Added /emergency_off for authorized manual resume.
- Manual emergency stop persists in DB across process restarts and is restored before engine.start().
- /status exposes emergency-stop state.
- EmergencyStop documentation now matches actual behavior: it halts new entries and leaves existing protective orders untouched.

### ML integrity
- TypeScript MLTrainingPipeline now uses chronological train/test splitting instead of random mixing.
- TypeScript ML performance features symbolWR/sourceWR are computed as-of each trade timestamp rather than using future outcomes.
- Invalid TypeScript ML training rows are filtered.
- Persisted TypeScript trees are fully stored and structurally validated on load.
- TypeScript ML predict returns neutral output on invalid feature/probability state.
- Production Python ModelServer validates prediction probabilities/confidence/label ranges and normalization.
- Production Python online-learning path rejects non-finite profit and invalid signal labels.
- Disabled false “model degradation” auto-retraining based on realized win-rate because the server did not store the model prediction needed to compute true prediction accuracy.
- ML API validates candle shape, finite OHLCV values, monotonic timestamps, OHLC geometry, and no future timestamps.
- ML API validates record_trade symbol/timeframe/profit/signal.
- Node MLEnhancer/MLClient validate ML output ranges before using it.
- Training pipeline already uses time-based train/val/test splitting with purge/embargo.
- Deployment recommendation now includes a majority-class baseline check so class-imbalanced accuracy cannot alone justify deployment.

### Backtest / research integrity
- Backtester executes pending signals on the next bar open to avoid close-to-entry leakage.
- H4 confirmation uses resampled historical data excluding the current incomplete H4 bucket.
- Backtests include explicit entry/exit/impact/holding costs and historical currency conversion checks.
- Open positions at dataset end are settled as TIMEOUT rather than silently dropped.
- Market-data quality and historical FX conversion coverage are validation gates.

## TESTS ADDED/UPDATED
Focused tests were added for:
- Binance close/partial-close idempotency and residual protection.
- Binance runtime/startup exact execution recovery.
- Binance exact protective-order recovery and protection-loss blocking.
- Binance clientOrderId length/format.
- MT5 bridge query failures, residual closes, unverified modifications, protection mismatch, and idempotency conflicts.
- MT5 runtime/startup MOVE_SL_TP recovery and protection drift.
- Atomic OPEN/SLTP transaction rollback and success.
- Risk configuration, daily target, portfolio heat, drawdown, circuit-breaker persistence.
- Session, spread, correlation, news, and stale-data fail-closed behavior.
- Malformed RiskManager signal inputs.
- Persistent emergency-stop lifecycle.
- ML/risk safety tests.

IMPORTANT: test files contain human-readable Result counters, but because CI/local execution is unavailable in this environment, those counters are not evidence that the suites passed. Do not claim green tests until actually executed.

## KNOWN LIMITATIONS / NEXT ENGINEERING TARGETS
1. Diagnose and resolve the 19 failing backend tests from the 2026-10-06 local full-suite run; rerun the full suite after fixes. The summary was `605 passed, 19 failed`.
2. Audit Binance Spot OCO restart recovery separately. Futures protective-order recovery is now broker-identity based; Spot OCO recovery may still rely more heavily on in-memory order mapping.
3. Audit Binance protective-order creation itself for partial failure between SL and TP creation; ensure a half-created protection set is either rolled back or remains explicitly UNKNOWN/blocked.
4. Audit emergency-close recovery after a protection failure so the emergency-close operation can itself be reconciled from broker history after a process crash.
5. Add prediction-level IDs to Python ModelServer outcome records if true live model-accuracy degradation monitoring is desired; do not re-enable auto-retraining based only on win-rate.
6. Review TypeScript MLTrainingPipeline because it is now leak-resistant but its historical training rows still use simplified placeholder technical features; production deployment relies on the Python pipeline, so these two paths should eventually be consolidated.
7. Perform a final consistency pass between README/deployment profiles and the new fail-closed risk semantics.
8. Real broker E2E/soak evidence remains outstanding for non-USD conversions, restart interruption, broker latency, and long-run protection/reconciliation behavior.

## IMMEDIATE NEXT TASK
Audit entry-protection emergency-close recovery after a process crash, then diagnose the 19 full-suite failures. Keep UNKNOWN operations fail-closed and do not mutate local state on unattributed broker actions.

## LATEST CHECKPOINT
- Spot OCO cancellation now uses the exact OCO list identity and verifies the list is fully done and all legs are no longer open before manual market close.
- Spot close post-state now verifies the exact inventory delta (before - executedQty = after) instead of requiring total asset inventory to reach zero, so multiple same-asset holdings are supported without false residual failures.
- Binance Spot close now requires authoritative fills via /api/v3/myTrades and computes exit PnL in the quote asset from fill price/qty/commission. Unknown third-asset commissions fail closed.
- ExecutionGateway passes local trade entry price/side into Binance close and startup/runtime recovery so Spot close PnL can be recovered after restart.
- Unattributed broker-side Binance partial reductions no longer rewrite local trade volume; reconciliation blocks for manual reconciliation instead.
- Local regression fixes on 2026-10-06: removed a duplicated `daily_stats` SQL block that caused a syntax error; defined executed quantity for Futures full/partial close responses; corrected recovered Spot commission union narrowing; aligned startup reconciliation with the public Spot OCO/open-order recovery methods; and added the missing DailyProfitTarget logger.
- Updated regression fixtures for exact OCO identity/fill evidence, open protective-order validation, and OPEN execution-ledger identity on cumulative close PnL.
- Validation on 2026-10-06: backend TypeScript typecheck passed; focused Binance close-protection tests passed (11/11); full backend suite completed with 605 passed and 19 failed. Failures remain and must be fixed before claiming the suite is green. GitHub Actions was not run because the monthly quota is exhausted.
- Binance Futures SL/TP creation is recover-before-create and recover-after-timeout; Spot OCO creation is operation-key idempotent and restart-recoverable.
- Ensemble/model artifact validation, baseline-aware training recommendation, NVIDIA fail-closed live behavior, daily equity anchor corruption handling, correlation fail-closed behavior, and PositionSizer stop-direction validation are all in the current development line.
- CI/local green validation is still outstanding. No claim of passing tests is valid until execution is available.

## RESUME PROCEDURE
1. Read this file first.
2. Verify `main` and the follow-up review branch heads.
3. Inspect latest GitHub Actions status only if capacity is restored; do not spend minutes on blind reruns.
4. Continue with the IMMEDIATE NEXT TASK above.
5. Before any interruption, update this file with the latest HEAD and exact next task.

## DEVELOPMENT HISTORY / RECENT HEADS
Recent important commits in this development line include:
- 700e11b7814b4f47ddecac2a99a977d443309008 — Spot OCO list-level cancellation and exact inventory-delta verification
- 42cca10fcb05550fd95744a5b34a6eba75be162b — Spot close PnL recovery from authoritative fills
- 6ede90b590abdb6208b1fa3005795c99acf4fff3 — pass entry price/side into Binance recovery
- 336763262467f3210dbb69d84eb9a2dab843f22e — fail closed on unattributed Binance position reductions
- a26442ebfbe5cb5bf099494e48f8f029b1a554e5 — NVIDIA live fail-closed
- a7a7ba613bb09e0ec756869178a3b52a04900572 — latest current HEAD checkpoint

## FINAL RULE
Never infer “internet is closed” from a single tool failure. Verify the specific service/tool limitation separately before reporting connectivity problems.
