const { BinanceExecutor } = require("../execution/BinanceExecutor");

let assertions = 0;

function assert(condition: unknown, message: string): asserts condition {
  assertions += 1;
  if (!condition) throw new Error(message);
}

async function verifyFuturesProtectionCleanupIsOperationScoped() {
  async function runCase(withUnrelatedOrder: boolean) {
    const executor = new BinanceExecutor({
      binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
    } as any);
    const operationKey = "owned-protection-cleanup-unit";
    const slClientOrderId = (executor as any).makeProtectionClientOrderId(operationKey, "SL");
    const tpClientOrderId = (executor as any).makeProtectionClientOrderId(operationKey, "TP");
    const orders = new Map<string, any>([
      [slClientOrderId, {
        symbol: "BTCUSDT",
        clientOrderId: slClientOrderId,
        origClientOrderId: slClientOrderId,
        orderId: 910,
        status: "NEW",
        side: "SELL",
        type: "STOP_MARKET",
        closePosition: true,
      }],
    ]);
    const unrelated = {
      symbol: "BTCUSDT",
      clientOrderId: "manual-order",
      orderId: 999,
      status: "NEW",
      side: "SELL",
      type: "LIMIT",
      closePosition: false,
    };
    const deleted: number[] = [];

    (executor as any).signedGet = async (path: string, params: any) => {
      if (path !== "/fapi/v1/order") throw new Error("unexpected lookup endpoint: " + path);
      const clientOrderId = String(params?.origClientOrderId ?? "");
      if (clientOrderId === tpClientOrderId) {
        const missing: any = new Error("order does not exist");
        missing.response = { data: { code: -2013 } };
        throw missing;
      }
      const order = orders.get(clientOrderId);
      if (!order) {
        const missing: any = new Error("order does not exist");
        missing.response = { data: { code: -2013 } };
        throw missing;
      }
      return { ...order };
    };
    (executor as any).signedDelete = async (path: string, params: any) => {
      assert(path === "/fapi/v1/order", "owned protective orders must use the Futures order endpoint");
      const orderId = Number(params?.orderId);
      deleted.push(orderId);
      assert(orderId === 910, "cleanup may cancel only the exact operation-owned SL order");
      const sl = orders.get(slClientOrderId);
      if (!sl || Number(sl.orderId) !== orderId) throw new Error("delete identity mismatch");
      orders.set(slClientOrderId, { ...sl, status: "CANCELED" });
      return { ...orders.get(slClientOrderId) };
    };
    (executor as any).getOpenOrders = async (symbol: string) => {
      assert(symbol === "BTCUSDT", "cleanup open-order verification must be symbol-scoped");
      const open = [...orders.values()].filter(order => order.status === "NEW");
      return withUnrelatedOrder ? [...open, unrelated] : open;
    };

    let threw = false;
    try {
      await (executor as any).cancelProtectionForEmergencyClose({
        symbol: "BTCUSDT",
        side: "BUY",
        price: 100,
        sl: 90,
        tp: 120,
        confidence: 0.8,
        timestamp: 123456,
        source: "unit",
      }, operationKey);
    } catch {
      threw = true;
    }
    return { threw, deleted };
  }

  const clean = await runCase(false);
  assert(!clean.threw, "exact owned protection cleanup should pass when no orders remain open");
  assert(clean.deleted.length === 1 && clean.deleted[0] === 910, "only the exact owned SL order should be canceled");

  const blocked = await runCase(true);
  assert(blocked.threw, "emergency close must be blocked when an unrelated order remains open");
  assert(blocked.deleted.length === 1 && !blocked.deleted.includes(999), "unrelated order must never be canceled by protection cleanup");
}

async function verifySpotOcoCleanupIsOperationScoped() {
  async function runCase(withUnrelatedOrder: boolean) {
    const executor = new BinanceExecutor({
      binance: { apiKey: "test", secret: "test", env: "testnet", futures: false },
    } as any);
    const operationKey = "owned-spot-oco-cleanup-unit";
    const listClientOrderId = (executor as any).makeOcoClientOrderId(operationKey, "LIST");
    const aboveClientOrderId = (executor as any).makeOcoClientOrderId(operationKey, "ABOVE");
    const belowClientOrderId = (executor as any).makeOcoClientOrderId(operationKey, "BELOW");
    const orders = new Map<string, any>([
      [aboveClientOrderId, {
        symbol: "BTCUSDT",
        clientOrderId: aboveClientOrderId,
        orderId: 920,
        status: "NEW",
        side: "SELL",
        type: "LIMIT_MAKER",
      }],
      [belowClientOrderId, {
        symbol: "BTCUSDT",
        clientOrderId: belowClientOrderId,
        orderId: 921,
        status: "NEW",
        side: "SELL",
        type: "STOP_LOSS_LIMIT",
      }],
    ]);
    let listCanceled = false;
    const unrelated = {
      symbol: "BTCUSDT",
      clientOrderId: "manual-spot-order",
      orderId: 999,
      status: "NEW",
      side: "SELL",
      type: "LIMIT_MAKER",
    };
    const deletedOrderIds: number[] = [];

    const currentList = () => ({
      symbol: "BTCUSDT",
      orderListId: 930,
      listClientOrderId,
      listStatusType: listCanceled ? "ALL_DONE" : "EXECUTING",
      listOrderStatus: listCanceled ? "ALL_DONE" : "EXECUTING",
      orders: [
        { symbol: "BTCUSDT", orderId: 920, clientOrderId: aboveClientOrderId },
        { symbol: "BTCUSDT", orderId: 921, clientOrderId: belowClientOrderId },
      ],
    });

    (executor as any).signedGet = async (path: string, params: any) => {
      const clientOrderId = String(params?.origClientOrderId ?? "");
      if (path === "/api/v3/orderList" && clientOrderId === listClientOrderId) {
        return currentList();
      }
      if (path === "/api/v3/order") {
        const order = orders.get(clientOrderId);
        if (order) return { ...order };
      }
      const missing: any = new Error("order does not exist");
      missing.response = { data: { code: -2013 } };
      throw missing;
    };
    (executor as any).signedDelete = async (path: string, params: any) => {
      assert(path === "/api/v3/orderList", "Spot cleanup must cancel the operation-owned OCO list");
      assert(Number(params?.orderListId) === 930, "Spot cleanup must use the exact recovered OCO list id");
      assert(listClientOrderId === (executor as any).makeOcoClientOrderId(operationKey, "LIST"), "OCO list identity must be derived from the original operation key");
      listCanceled = true;
      for (const [key, order] of orders) orders.set(key, { ...order, status: "CANCELED" });
      return { listClientOrderId, orderListId: 930 };
    };
    (executor as any).getOpenOrders = async (symbol: string) => {
      assert(symbol === "BTCUSDT", "Spot cleanup verification must be symbol-scoped");
      const active = [...orders.values()].filter(order => order.status === "NEW");
      return withUnrelatedOrder ? [...active, unrelated] : active;
    };
    (executor as any).cancelSpotProtectionByOperation = async (
      symbol: string,
      requestedKey: string,
    ) => {
      assert(symbol === "BTCUSDT", "Spot OCO cancellation must target the matching symbol");
      assert(requestedKey === operationKey, "Spot OCO cancellation must use the original OPEN operation key");
      assert(String(currentList().listStatusType) === "EXECUTING", "Spot OCO should be active before cancellation");
      const response = await (executor as any).signedDelete("/api/v3/orderList", {
        symbol,
        orderListId: 930,
      });
      assert(response.listClientOrderId === listClientOrderId, "Spot OCO cancellation response must preserve exact list identity");
      const after = currentList();
      assert(after.listStatusType === "ALL_DONE", "Spot OCO cancellation must be confirmed terminal");
      assert((await (executor as any).getOpenOrders(symbol)).every((order: any) => order.orderId !== 920 && order.orderId !== 921), "owned OCO legs must no longer be open");
    };

    let threw = false;
    try {
      await (executor as any).cancelProtectionForEmergencyClose({
        symbol: "BTCUSDT",
        side: "BUY",
        price: 100,
        sl: 90,
        tp: 120,
        confidence: 0.8,
        timestamp: 123456,
        source: "unit",
      }, operationKey);
    } catch {
      threw = true;
    }
    return { threw, listCanceled, deletedOrderIds };
  }

  const clean = await runCase(false);
  assert(!clean.threw, "exact Spot OCO cleanup should pass when owned protection is terminal and no other orders remain");
  assert(clean.listCanceled, "operation-owned Spot OCO should be canceled before emergency market close");

  const blocked = await runCase(true);
  assert(blocked.threw, "emergency close must be blocked when unrelated Spot orders remain open");
  assert(blocked.listCanceled, "the owned OCO should be canceled even when a separate unrelated order causes a safety block");
  assert(blocked.deletedOrderIds.length === 0, "Spot cleanup must not issue individual cancellation requests against unrelated or unrelated-list order IDs");
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
  let cleanupCalls = 0;
  (executor as any).cancelProtectionForEmergencyClose = async () => {
    cleanupCalls += 1;
  };

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

  assert(cleanupCalls === 1, "operation-owned protection cleanup must finish before the first emergency order");
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
  assert(cleanupCalls === 1, "a replay of an existing emergency intent must not restart the protection/close flow");

  await verifyFuturesProtectionCleanupIsOperationScoped();
  await verifySpotOcoCleanupIsOperationScoped();

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
