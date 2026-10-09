# AI DEVELOPMENT HANDOFF CURRENT

## Project identity
- Repository: `Quarfani/trading-ai-v10-railway`
- Current development branch: `phase1/durable-emergency-close-intent`
- Phase base commit: `41b0457f48cb38f27a8879604b87e1b4d73d5559`
- Last code commit before this documentation refresh: `3fd43494d2417d3e8987c8831740f4853dc28af5`. Verify the live branch ref/head before editing; the handoff edit itself creates a documentation-only commit.
- `main` was not modified or merged.
- Draft PR #2 remains separate and unchanged: https://github.com/Quarfani/trading-ai-v10-railway/pull/2 (base `main`, head `fix/binance-close-reconciliation-validation`, last verified head `41b0457f48cb38f27a8879604b87e1b4d73d5559`).

## Phase 2 implementation summary
This phase implements durable recovery for Binance protection-failure emergency closes. It is **not a verified/release-ready build**.

### Code changes
- `bot/backend/src/execution/BinanceExecutor.ts`
  - Receives `DatabaseManager` and requires a stable OPEN operation key/clientOrderId when the live gateway injects the ledger.
  - Persists a `PROTECTION_FAIL_CLOSE` child ledger before the broker-position precheck. The request explicitly records `PRECHECK_NOT_STARTED`, then stores the signed pre-close inventory and transitions to `SUBMISSION_ARMED` before the emergency market order is submitted.
  - Uses an operation-derived Binance `clientOrderId`; validates broker response symbol/clientOrderId, FILLED status, order ID, exact executed quantity, and the **signed** post-close position delta.
  - Recovery looks up the exact clientOrderId and blocks blind re-submission. If evidence is ambiguous, the child remains `UNKNOWN`.
  - Adds exact fill-detail recovery for entry and emergency close. Spot uses authoritative `myTrades` fills and quote-equivalent fees. Futures recovery rejects fee/PnL combinations where the commission asset differs from the quote asset.
  - `getAllPositions()` now excludes zero-quantity Futures rows from hidden-position detection.
- `bot/backend/src/execution/ExecutionGateway.ts`
  - Passes the database and stable OPEN key to Binance execution.
  - Does not replay an OPEN that was atomically settled as closed after a protection failure as a successful new entry.
- `bot/backend/src/integration/StartupReconciler.ts`
  - Reconciles unresolved `PROTECTION_FAIL_CLOSE` children for Spot and Futures using exact entry/close operation identities.
  - Validates parent/child signal identity, timeframe, fill status/quantity, prices, pre/post signed inventory, PnL/fee currencies, and account conversion before attempting settlement.
  - Explicitly blocks prechecks recorded as `PRECHECK_NOT_STARTED`; it never automatically sends a replacement close order.
  - Uses a valid original timeframe and positive SL/TP values; it does not fabricate default H1/zero protection metadata.
- `bot/backend/src/database/DatabaseManager.ts`
  - Adds `updateExecutionRequest()` for durable precheck-state updates.
  - Adds `settleProtectionFailureClose()`, which inserts one closed trade, sets the parent OPEN and child emergency ledgers to EXECUTED, links both ledgers to the trade ID, updates daily statistics and records ML outcome where present in one SQLite transaction.
  - Enforces single-counted entry commission and consistent PnL totals.
- Tests added/updated:
  - `bot/backend/src/tests/unit.binance-emergency-close-ledger.test.ts`
  - `bot/backend/src/tests/integration.protection-failure-emergency-reconciliation.test.ts`
  - `bot/backend/src/tests/unit.binance-close-protection.test.ts`
  - `bot/backend/src/tests/integration.execution-ledger-idempotency.test.ts`
  - Test counters are dynamic where modified; source counters are not proof of passing tests.

## Validation status — do not overstate
- GitHub source reads/writes and static string/identity checks succeeded.
- Branch comparison from phase base showed this branch ahead with changes in the execution gateway, executor, database, startup reconciler and focused test files.
- TypeScript typecheck: **NOT RUN**.
- New focused tests: **NOT RUN**.
- Full backend test suite: **NOT RUN for this phase**.
- Frontend full build and dashboard/browser E2E: **NOT RUN**.
- Real Binance broker E2E/soak: **NOT RUN**.
- GitHub Actions: not run; the previous handoff says the billing-cycle quota is exhausted. Do not trigger workflows until capacity is restored.
- Five external endpoint checks from the execution container failed at DNS resolution (`github.com`, `api.github.com`, `raw.githubusercontent.com`, `registry.npmjs.org`, `codeload.github.com`). The GitHub integration remained usable. This is a limitation of that execution container and is **not evidence that the user's internet is down**.

## Known limitations / next engineering targets
1. **Run actual validation first.** In a runnable checkout of the live phase branch, run:
   - `cd bot/backend && npm run typecheck`
   - `npx ts-node --transpile-only src/tests/integration.protection-failure-emergency-reconciliation.test.ts`
   - `npx ts-node --transpile-only src/tests/unit.binance-emergency-close-ledger.test.ts`
   - `npx ts-node --transpile-only src/tests/unit.binance-close-protection.test.ts`
   - `npx ts-node --transpile-only src/tests/integration.execution-ledger-idempotency.test.ts`
   - Then run `npm test` if runtime/resources allow; record real exit codes and actual output.
2. **Crash before emergency-child creation:** if the process crashes after an entry fill but before the protection-failure handler durably creates the child ledger, the unresolved parent OPEN and/or broker-visible hidden position should block startup, but the current new path does not automatically construct and settle an emergency close in that window. Add an explicit, operation-keyed startup recovery/incident path or document the required operator intervention, with tests.
3. **Protection cleanup before emergency market close:** audit exact, operation-keyed cancellation/verification of any partially created or ambiguously acknowledged Spot OCO and Futures SL/TP orders before emergency close. Do not cancel unrelated orders. This remains a release gate.
4. **Historical FX conversion:** non-USD accounting currently uses the conversion rate available during startup recovery; exact historical conversion-at-fill-time evidence is not persisted for this emergency path. Improve it or block release for unsupported accounting cases.
5. Complete the broader Spot OCO audit; re-verify frontend installation/build and dashboard-to-API integration in Paper mode; reconcile README and deployment profiles; scan for secrets/databases/runtime artifacts before release.
6. Only after verified backend/frontend checks should the separate release repository be created and the new Railway account wired up. Do not deploy or enable live trading from this branch.

## Resume procedure
1. Read this file and `Trading_AI_Phase2_Report_2026-10-09.md`.
2. Verify the live branch HEAD and compare it against the recorded last code commit; make no assumptions from old short SHAs.
3. Keep `main` and draft PR #2 unchanged.
4. Run actual typecheck/focused tests in a runnable environment and fix failures before adding unrelated features.
5. Keep Paper mode for tests; do not rerun GitHub Actions while quota is exhausted.
6. At the end of the next phase, update this file, create a new report, and stop so the user can transfer the file to a new conversation.
