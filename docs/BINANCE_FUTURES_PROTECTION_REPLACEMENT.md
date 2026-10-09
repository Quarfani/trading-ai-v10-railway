# Binance Futures Protection Replacement — Durable State Machine

**Status:** Engineering design / release gate. Not yet implemented or validated against Binance Testnet.  
**Scope:** USDⓈ-M Futures conditional SL/TP orders created with `closePosition=true`.

## Problem statement

The current replacement-first flow keeps the previous SL/TP pair live while it submits a new pair. Binance can reject a new close-position conditional order with `-4130` when a conflicting order already exists. Cancelling the old pair first can remove protection if replacement submission then fails or the process stops. Neither ordering alone provides a safe complete solution.

The REST API currently used by this project exposes new, query, and cancel operations for Algo orders; the project must not assume that these close-position Algo orders can be atomically amended. The exact conflict behavior and supported alternatives must be verified against the official current API and Testnet before release.

## Non-negotiable invariants

1. Never cancel an order unless its exact operation-derived `clientAlgoId`, symbol, side, type, and expected status have been verified.
2. Persist the intent and enough information to restore the prior protection **before** the first destructive broker action.
3. Never report a modification as successful until both requested replacement orders are recovered by exact identity and validated against symbol, side, type, trigger prices, status, and close-position semantics.
4. Never blindly retry a market order or a protective order after an ambiguous timeout. Query by deterministic client identity first.
5. A partial replacement is not a valid pair. Cancel only the partial orders owned by that replacement operation and verify their terminal state before attempting restoration.
6. If the system cannot prove that either the requested pair or a verified restoration pair is active, keep the ledger unresolved, block further destructive actions and startup readiness, and emit an explicit critical alert. Do not claim the position is protected.
7. Never sweep or cancel unrelated/manual Algo orders for the symbol.

## Durable operation phases

Store these fields in the existing `MOVE_SL_TP` execution-ledger request before broker actions. Preserve the original requested targets and operation identity; update the request atomically through the existing database API.

- `schemaVersion`
- `tradeId`, `ticket`, `symbol`, `positionSide`, and verified position quantity
- `oldProtectionKey`, `newProtectionKey`
- `oldProtection`: exact old SL/TP client IDs, Algo IDs, trigger prices, types, side, and validation timestamp
- `requestedProtection`: exact requested SL/TP prices and deterministic client IDs
- `phase`: one of the phases below
- `restoreProtectionKey`: deterministic unique key used only if restoration is required
- `lastError`, `lastBrokerEvidence`, and timestamps for each confirmed transition

Phases:

1. `PREPARED`: exact old pair was queried and validated; complete restoration data is durable. No cancellation has been attempted.
2. `OLD_CANCEL_REQUESTED`: durable phase written before sending any cancellation.
3. `OLD_CANCEL_VERIFIED`: both old orders are confirmed terminal/not open; absence is verified via the supported query endpoints.
4. `NEW_PAIR_REQUESTED`: durable phase written before submitting either new order.
5. `NEW_PAIR_VERIFIED`: both new orders were recovered by exact identity and validated. Only now may the operation settle as successful.
6. `RESTORE_REQUESTED`: replacement failed or is invalid; this phase is durable before creating a restoration pair.
7. `RESTORE_VERIFIED`: both restoration orders are recovered and validated at the original trigger prices; record the restoration key as the active protection identity.
8. `BLOCKED_UNKNOWN`: neither a valid requested pair nor a valid restoration pair can be proven. Startup readiness and further destructive actions remain blocked.

Phase writes must be idempotent. A database write failure before a broker action means that broker action must not be sent. A database write failure after a broker action must leave the ledger unresolved and trigger reconciliation.

## Runtime transition algorithm

1. Read the current Futures position and verify nonzero quantity and correct long/short direction.
2. Query the old pair by exact client Algo IDs. Validate both orders and persist the full old-pair snapshot with `PREPARED`.
3. Persist `OLD_CANCEL_REQUESTED`; cancel only the exact old SL and TP; query both again and verify they are no longer open. Persist `OLD_CANCEL_VERIFIED`.
4. Persist `NEW_PAIR_REQUESTED`; submit replacement SL and TP using the new operation key. Recover both by exact client IDs and verify all fields. Persist `NEW_PAIR_VERIFIED` only after both pass.
5. If either placement fails or the response is ambiguous, query the new IDs and open Algo orders before deciding anything. If a valid new pair exists, finish the success path. If only a partial pair exists, cancel only that operation's partial orders and verify cancellation.
6. If no valid new pair remains, persist `RESTORE_REQUESTED`, create a restoration pair at the old trigger prices under the deterministic restoration key, then recover and validate both. Persist `RESTORE_VERIFIED`; return failure for the requested modification while preserving the actual active protection identity in durable state.
7. If restoration cannot be verified, persist `BLOCKED_UNKNOWN` when possible, keep the operation unresolved otherwise, block startup/trading, and raise a critical operator alert. Never silently continue.

## Startup reconciliation

Reconciliation must not rely only on the in-memory `orderMap`. For every unresolved Binance `MOVE_SL_TP`:

- Read the durable phase and verify the live position still matches the recorded symbol and side.
- Query the old pair, requested new pair, and restoration pair by their exact deterministic identities.
- If the requested new pair is valid, cancel any still-open old operation-owned orders, verify cancellation, then settle the modification.
- If the requested pair is partial/invalid, cancel only its own partial orders and verify the result before restoring the old trigger prices.
- If the old pair remains valid and no destructive cancellation was confirmed, retain it and resolve the attempted modification as failed only after recording that the old pair is still active.
- If old protection is gone and no valid new pair exists, create/recover the deterministic restoration pair.
- If the state cannot be resolved authoritatively, remain blocked and surface exact evidence; never infer protection from local trade fields alone.

The active-protection lookup must use the durable active key, including a restoration key, rather than assuming the latest successful `MOVE_SL_TP` key is always active. A restored-old-target result must not write the requested new SL/TP values into the trade row.

## Required tests before Testnet

- Database phase is persisted before each cancel/place call; injected DB write failure causes no subsequent broker mutation.
- Crash after each phase transition, including after broker accepted an order but before response persistence.
- `-4130` on the first replacement order after old pair cancellation.
- Timeout on cancellation, then recovery finds old order still open vs already canceled.
- Replacement SL succeeds but TP fails; only the partial replacement is canceled.
- Restoration SL succeeds but TP fails; startup remains blocked and retries reconcile without duplicate orders.
- Restart sees a valid requested pair and an old pair still open; only the exact old pair is retired.
- Restart sees a verified restoration pair; the old targets and restoration key remain active, and the requested new targets are not persisted as live trade targets.
- Unknown/manual Algo orders remain untouched.
- Long and short positions, price precision/tick sizes, position changes during modification, and order-trigger races.
- Repeated calls with the same operation key are idempotent and never create duplicate live pairs.
- Tests assert broker state, ledger state, trade row values, startup readiness, and emitted critical alerts.

## Testnet release gate

Use a dedicated Binance Futures Testnet account and a small disposable position. Record request/response evidence with secrets redacted. Verify `-4130` behavior, cancellation confirmation semantics, deterministic client Algo ID behavior after cancellation, and restoration behavior under forced failures. Do not use live funds or infer production correctness from mocks alone.

## Current status

This document is a design artifact only. The runtime state machine, persistence integration, tests, and Testnet verification remain outstanding. The existing replacement-first implementation must remain a release blocker until this design (or a better broker-supported atomic approach) is implemented and validated.
