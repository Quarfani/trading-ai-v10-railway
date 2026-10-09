const { BinanceExecutor } = require("../execution/BinanceExecutor");

let assertions = 0;

function assert(condition: unknown, message: string): asserts condition {
  assertions += 1;
  if (!condition) throw new Error(message);
}

function makeAlgoOrder(
  symbol: string,
  operationKey: string,
  kind: "SL" | "TP",
  algoId: number,
  triggerPrice: number,
  status = "NEW",
) {
  const clientAlgoId = (executorForIds as any).makeProtectionClientOrderId(operationKey, kind);
  return {
    symbol,
    algoId,
    clientAlgoId,
    algoType: "CONDITIONAL",
    algoStatus: status,
    side: "SELL",
    orderType: kind === "SL" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
    triggerPrice: String(triggerPrice),
    closePosition: true,
  };
}

const executorForIds = new BinanceExecutor({
  binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
} as any);

async function verifyMissingPriorIdentityBlocksModification() {
  const executor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  let cancellations = 0;
  let placements = 0;
  (executor as any).getPosition = async () => ({
    positionAmt: 1,
    entryPrice: 100,
    unrealizedProfit: 0,
  });
  (executor as any).signedDelete = async () => {
    cancellations += 1;
    return {};
  };
  (executor as any).placeSLTP = async () => {
    placements += 1;
  };

  const result = await executor.modifyPosition(
    7,
    "BTCUSDT",
    "BUY",
    90,
    110,
    "new-move-operation",
  );
  assert(!result, "modify must block when exact current protection identity is missing");
  assert(cancellations === 0, "modify must not cancel protection when prior operation identity is missing");
  assert(placements === 0, "modify must not place a replacement against an unresolved prior protection state");
}

async function verifyReplaceThenCancelExactPriorPair() {
  const executor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  const symbol = "BTCUSDT";
  const priorOperationKey = "prior-open-protection-operation";
  const nextOperationKey = "next-move-protection-operation";
  const orders = new Map<string, any>();
  const deleted: number[] = [];
  let replacementVerified = false;

  const add = (
    operationKey: string,
    kind: "SL" | "TP",
    algoId: number,
    triggerPrice: number,
    status = "NEW",
  ) => {
    const clientAlgoId = (executor as any).makeProtectionClientOrderId(operationKey, kind);
    const order = {
      symbol,
      algoId,
      clientAlgoId,
      algoType: "CONDITIONAL",
      algoStatus: status,
      side: "SELL",
      orderType: kind === "SL" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
      triggerPrice: String(triggerPrice),
      closePosition: true,
    };
    orders.set(clientAlgoId, order);
    return order;
  };

  const oldSl = add(priorOperationKey, "SL", 101, 90);
  const oldTp = add(priorOperationKey, "TP", 102, 110);
  const unrelated = {
    symbol,
    algoId: 199,
    clientAlgoId: "manual-algo-id",
    algoType: "CONDITIONAL",
    algoStatus: "NEW",
    side: "SELL",
    orderType: "STOP_MARKET",
    triggerPrice: "80",
    closePosition: true,
  };
  orders.set(unrelated.clientAlgoId, unrelated);

  (executor as any).getPosition = async () => ({
    positionAmt: 1,
    entryPrice: 100,
    unrealizedProfit: 0,
  });
  (executor as any).signedGet = async (path: string, params: any) => {
    if (path === "/fapi/v1/algoOrder") {
      const found = orders.get(String(params?.clientAlgoId ?? ""));
      if (found) return { ...found };
      const missing: any = new Error("Algo order not found");
      missing.response = { data: { code: -2013 } };
      throw missing;
    }
    if (path === "/fapi/v1/openAlgoOrders") {
      return [...orders.values()].filter(order => order.algoStatus === "NEW");
    }
    throw new Error("Unexpected endpoint " + path);
  };
  (executor as any).signedDelete = async (path: string, params: any) => {
    assert(replacementVerified, "replacement protection must be verified before old protection cancellation");
    assert(path === "/fapi/v1/algoOrder", "conditional protection cancellation must use the Algo endpoint");
    const algoId = Number(params?.algoId);
    assert([101, 102].includes(algoId), "only the prior operation's Algo IDs may be canceled");
    deleted.push(algoId);
    const entry = [...orders.entries()].find(([, order]) => Number(order.algoId) === algoId);
    if (!entry) throw new Error("Exact old Algo order was not found");
    orders.set(entry[0], { ...entry[1], algoStatus: "CANCELED" });
    return { algoId, clientAlgoId: entry[0] };
  };
  (executor as any).placeSLTP = async (
    signal: any,
    quantity: number,
    _ticket: number,
    _spec: any,
    operationKey: string,
  ) => {
    assert(operationKey === nextOperationKey, "replacement pair must be keyed to the new MOVE_SL_TP operation");
    assert(quantity === 1 && signal.sl === 91 && signal.tp === 111, "replacement protection must use the verified position and requested targets");
    add(nextOperationKey, "SL", 103, 91);
    add(nextOperationKey, "TP", 104, 111);
    replacementVerified = true;
  };

  const result = await executor.modifyPosition(
    7,
    symbol,
    "BUY",
    91,
    111,
    nextOperationKey,
    priorOperationKey,
  );
  assert(result, "modification should succeed after replacement and old-pair cancellation");
  assert(deleted.length === 2 && deleted.includes(101) && deleted.includes(102), "both and only the prior operation's protection orders must be canceled");
  const active = await executor.getOpenAlgoOrders(symbol);
  assert(active.some((order: any) => Number(order.orderId) === 103), "new SL must remain open");
  assert(active.some((order: any) => Number(order.orderId) === 104), "new TP must remain open");
  assert(active.some((order: any) => Number(order.orderId) === 199), "unrelated manual Algo order must remain untouched");
  assert(oldSl.algoId === 101 && oldTp.algoId === 102, "test must retain distinct prior order identities");
}

async function verifyReplacementFailureKeepsOldProtection() {
  const executor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  const symbol = "BTCUSDT";
  const priorOperationKey = "old-operation";
  const nextOperationKey = "new-operation";
  const oldOrders = new Map<string, any>();
  for (const [kind, algoId, triggerPrice] of [["SL", 801, 90], ["TP", 802, 110]] as const) {
    const clientAlgoId = (executor as any).makeProtectionClientOrderId(priorOperationKey, kind);
    oldOrders.set(clientAlgoId, {
      symbol,
      algoId,
      clientAlgoId,
      algoType: "CONDITIONAL",
      algoStatus: "NEW",
      side: "SELL",
      orderType: kind === "SL" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
      triggerPrice: String(triggerPrice),
      closePosition: true,
    });
  }

  let cancellations = 0;
  let loggedWarning = "";
  (executor as any).logger.warn = (message: unknown) => {
    loggedWarning = String(message);
  };
  (executor as any).getPosition = async () => ({
    positionAmt: 1,
    entryPrice: 100,
    unrealizedProfit: 0,
  });
  (executor as any).recoverProtectionByOperation = async (
    _symbol: string,
    operationKey: string,
  ) => {
    assert(operationKey === nextOperationKey, "replacement lookup must use the new MOVE_SL_TP key");
    return { sl: null, tp: null };
  };
  (executor as any).signedPost = async (path: string, payload: any) => {
    assert(path === "/fapi/v1/algoOrder", "replacement conditional protection must use the Algo API");
    assert(payload.clientAlgoId === (executor as any).makeProtectionClientOrderId(nextOperationKey, "SL"), "failed SL request must retain its exact operation identity");
    const failure: any = new Error("Binance rejected the conflicting conditional order");
    failure.response = {
      data: {
        code: -4130,
        msg: "An open stop or take profit order with GTE and closePosition in the direction is existing",
      },
    };
    throw failure;
  };
  (executor as any).getAlgoOrderByClientIdStrict = async (
    _symbol: string,
    clientAlgoId: string,
  ) => oldOrders.get(clientAlgoId) ?? null;
  (executor as any).getOpenAlgoOrders = async () =>
    [...oldOrders.values()].filter(order => order.algoStatus === "NEW");
  (executor as any).signedDelete = async () => {
    cancellations += 1;
    throw new Error("prior protection must not be canceled by a rejected replacement");
  };
  (executor as any).placeSLTP = undefined;

  const result = await executor.modifyPosition(
    8,
    symbol,
    "BUY",
    91,
    111,
    nextOperationKey,
    priorOperationKey,
  );
  assert(!result, "modification must remain unresolved when Binance rejects replacement with -4130");
  assert(cancellations === 0, "old protection must not be canceled after Binance rejects replacement");
  assert(
    [...oldOrders.values()].every(order => order.algoStatus === "NEW"),
    "the exact previous SL/TP pair must remain active after -4130",
  );
  assert(
    loggedWarning.includes("code=-4130"),
    "Binance conditional-order error code must remain visible for diagnosis and safe recovery",
  );
}

async function verifyExistingAlgoPairIsRecoveredWithoutDuplicateSubmission() {
  const executor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  const operationKey = "existing-protection-operation";
  const sl = makeAlgoOrder("BTCUSDT", operationKey, "SL", 301, 90);
  const tp = makeAlgoOrder("BTCUSDT", operationKey, "TP", 302, 110);
  let duplicatePosts = 0;

  (executor as any).signedGet = async (path: string, params: any) => {
    assert(path === "/fapi/v1/algoOrder", "protection recovery must query the Algo API endpoint");
    const requested = String(params?.clientAlgoId ?? "");
    if (requested === sl.clientAlgoId) return { ...sl };
    if (requested === tp.clientAlgoId) return { ...tp };
    const missing: any = new Error("Algo order not found");
    missing.response = { data: { code: -2013 } };
    throw missing;
  };
  (executor as any).signedPost = async () => {
    duplicatePosts += 1;
    throw new Error("duplicate protection submission is forbidden");
  };

  await (executor as any).placeSLTP(
    {
      symbol: "BTCUSDT",
      side: "BUY",
      price: 100,
      sl: 90,
      tp: 110,
    } as any,
    1,
    1000,
    { pip: 0.1, volumeStep: 0.001 } as any,
    operationKey,
  );

  assert(duplicatePosts === 0, "verified existing Algo protection must be recovered instead of duplicated");
  assert(
    (executor as any).orderMap.get(1000)?.slOrderId === 301 &&
      (executor as any).orderMap.get(1000)?.tpOrderId === 302,
    "recovered Algo IDs must populate orderMap",
  );
}

async function main() {
  await verifyMissingPriorIdentityBlocksModification();
  await verifyReplaceThenCancelExactPriorPair();
  await verifyReplacementFailureKeepsOldProtection();
  await verifyExistingAlgoPairIsRecoveredWithoutDuplicateSubmission();
  console.log(`Result: ${assertions} passed, 0 failed`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
