const { BinanceExecutor } = require("../execution/BinanceExecutor");

let assertions = 0;

function assert(condition: unknown, message: string): asserts condition {
  assertions += 1;
  if (!condition) throw new Error(message);
}

async function main() {
  let ledger: any = null;
  let ledgerCreates = 0;
  let brokerPosts = 0;
  let positionReads = 0;
  const exactClientOrderIds: string[] = [];

  const db = {
    getExecutionByOperationKey(operationKey: string) {
      return ledger && ledger.operationKey === operationKey ? { ...ledger } : null;
    },
    createExecutionLedger(entry: any) {
      ledgerCreates += 1;
      if (ledger) return false;
      ledger = {
        ...entry,
        requestJson: JSON.stringify(entry.request ?? null),
        resultJson: null,
        brokerOrderId: null,
        error: null,
      };
      return true;
    },
    updateExecutionRequest(executionId: string, request: any) {
      if (!ledger || ledger.executionId !== executionId) return false;
      if (ledger.status === "EXECUTED" || ledger.status === "FAILED") return false;
      ledger = { ...ledger, requestJson: JSON.stringify(request) };
      return true;
    },
    updateExecutionLedger(executionId: string, patch: any) {
      if (!ledger || ledger.executionId !== executionId) return false;
      if (ledger.status === "EXECUTED" || ledger.status === "FAILED") return false;
      ledger = {
        ...ledger,
        ...patch,
        resultJson: patch.result === undefined ? ledger.resultJson : JSON.stringify(patch.result),
      };
      return true;
    },
  };

  const executor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any, db as any);

  (executor as any).getPosition = async () => ({
    positionAmt: ++positionReads === 1 ? 1 : 0,
    entryPrice: 100,
    unrealizedProfit: 0,
  });

  (executor as any).signedPost = async (_path: string, payload: any) => {
    brokerPosts += 1;
    assert(ledger !== null, "emergency intent must exist before the broker order is submitted");
    assert(ledger.status === "PENDING", "emergency ledger must be PENDING before order submission");
    const persistedRequest = JSON.parse(ledger.requestJson);
    assert(persistedRequest.submissionState === "SUBMISSION_ARMED", "position snapshot must be persisted before order submission");
    assert(persistedRequest.positionBeforeSignedAmount === 1, "signed pre-close inventory must be durable before order submission");
    exactClientOrderIds.push(String(payload?.newClientOrderId ?? ""));
    assert(Boolean(payload?.newClientOrderId), "emergency order must carry a deterministic clientOrderId");
    return {
      symbol: "BTCUSDT",
      clientOrderId: String(payload?.newClientOrderId ?? ""),
      orderId: 902,
      status: "FILLED",
      executedQty: "1",
    };
  };

  (executor as any).findOrderByClientId = async (_symbol: string, clientOrderId: string) => {
    assert(clientOrderId === exactClientOrderIds[0], "recovery must query the exact submitted clientOrderId");
    return {
      symbol: "BTCUSDT",
      clientOrderId,
      orderId: 902,
      status: "FILLED",
      executedQty: "1",
    };
  };

  const signal = {
    symbol: "BTCUSDT",
    side: "BUY",
    price: 100,
    sl: 90,
    tp: 120,
    confidence: 0.8,
    timestamp: 123456,
    source: "unit",
  };

  await (executor as any).emergencyCloseAfterProtectionFailure(
    signal,
    1,
    "open-operation-123",
    "entry-client-id-123",
    {
      orderId: 901,
      entryPrice: 100,
      executedQty: 1,
      commission: 0.1,
      commissionCurrency: "USDT",
    },
    "simulated SL/TP failure",
  );

  assert(ledgerCreates === 1, "one durable emergency-close intent must be created");
  assert(ledger.action === "PROTECTION_FAIL_CLOSE", "intent must have its own emergency-close action");
  assert(ledger.status === "UNKNOWN", "verified broker execution must remain unresolved until PnL and parent settlement");
  assert(ledger.resultJson !== null, "broker order and position evidence must be persisted");
  const result = JSON.parse(ledger.resultJson);
  assert(result.positionDeltaVerified === true, "post-close inventory delta must be verified");
  assert(result.orderId === 902, "verified broker order identity must be stored");
  assert(result.parentOperationKey === "open-operation-123", "emergency record must link to its parent OPEN operation");
  assert(brokerPosts === 1, "initial emergency close must send one broker order");

  await (executor as any).emergencyCloseAfterProtectionFailure(
    signal,
    1,
    "open-operation-123",
    "entry-client-id-123",
    {
      orderId: 901,
      entryPrice: 100,
      executedQty: 1,
      commission: 0.1,
      commissionCurrency: "USDT",
    },
    "simulated restart recovery",
  );

  assert(ledgerCreates === 1, "recovery must reuse the existing durable intent");
  assert(brokerPosts === 1, "recovery must not submit a duplicate market order");
  assert(ledger.status === "UNKNOWN", "recovery evidence must not bypass atomic accounting settlement");
  assert(positionReads === 3, "recovery must query and validate the post-close inventory again");

  let flipLedgerWrites = 0;
  const flipDb = {
    updateExecutionLedger() {
      flipLedgerWrites += 1;
      return true;
    },
  };
  const flipExecutor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any, flipDb as any);
  (flipExecutor as any).getPosition = async () => ({
    positionAmt: -1,
    entryPrice: 100,
    unrealizedProfit: 0,
  });
  let signedFlipRejected = false;
  try {
    await (flipExecutor as any).verifyAndRecordEmergencyClose(
      "flip-execution",
      "PROTECTION_FAIL:flip-parent",
      "ta_emergency_flip",
      "flip-parent",
      signal,
      1,
      2,
      2,
      {
        symbol: "BTCUSDT",
        clientOrderId: "ta_emergency_flip",
        orderId: 903,
        status: "FILLED",
        executedQty: "1",
      },
      "ta_parent_flip",
      { orderId: 901, entryPrice: 100, executedQty: 2 },
    );
  } catch {
    signedFlipRejected = true;
  }
  assert(signedFlipRejected, "matching absolute quantity must not conceal a flipped Futures position");
  assert(flipLedgerWrites === 0, "unverified signed inventory must not be marked as verified in the ledger");

  console.log(`Result: ${assertions} passed, 0 failed`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
