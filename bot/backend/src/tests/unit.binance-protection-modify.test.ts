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
  (executor as any).getAlgoOrderByClientIdStrict = async (
    _symbol: string,
    clientAlgoId: string,
  ) => {
    const found = orders.get(clientAlgoId);
    if (!found) return null;
    return {
      ...found,
      orderId: Number(found.algoId),
      clientOrderId: String(found.clientAlgoId),
      origClientOrderId: String(found.clientAlgoId),
      status: String(found.algoStatus),
      type: String(found.orderType),
      stopPrice: found.triggerPrice,
    };
  };
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
    assert(!replacementVerified, "the old pair must be canceled only after its durable intent is recorded and before replacement placement");
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
    async () => true,
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
  const restoreKey = `PROTECTION_RESTORE:${nextOperationKey}:${priorOperationKey}`;
  const orders = new Map<string, any>();
  const states: any[] = [];
  let loggedWarning = "";

  const add = (operationKey: string, kind: "SL" | "TP", algoId: number, triggerPrice: number) => {
    const clientAlgoId = (executor as any).makeProtectionClientOrderId(operationKey, kind);
    const raw = {
      symbol, algoId, clientAlgoId, algoType: "CONDITIONAL",
      algoStatus: "NEW", side: "SELL",
      orderType: kind === "SL" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
      triggerPrice: String(triggerPrice), closePosition: true,
    };
    orders.set(clientAlgoId, raw);
    return raw;
  };
  const normalized = (raw: any) => ({
    ...raw,
    orderId: Number(raw.algoId),
    clientOrderId: String(raw.clientAlgoId),
    origClientOrderId: String(raw.clientAlgoId),
    status: String(raw.algoStatus),
    type: String(raw.orderType),
    stopPrice: raw.triggerPrice,
  });

  add(priorOperationKey, "SL", 801, 90);
  add(priorOperationKey, "TP", 802, 110);
  const manual = add("manual-operation", "SL", 899, 80);
  manual.clientAlgoId = "manual-algo-id";
  orders.delete((executor as any).makeProtectionClientOrderId("manual-operation", "SL"));
  orders.set(manual.clientAlgoId, manual);

  (executor as any).logger.warn = (message: unknown) => { loggedWarning = String(message); };
  (executor as any).logger.error = () => {};
  (executor as any).getPosition = async () => ({
    positionAmt: 1, entryPrice: 100, unrealizedProfit: 0,
  });
  (executor as any).recoverProtectionByOperation = async (_symbol: string, operationKey: string) => {
    const kinds = ["SL", "TP"] as const;
    const found: any = {};
    for (const kind of kinds) {
      const id = (executor as any).makeProtectionClientOrderId(operationKey, kind);
      const raw = orders.get(id);
      found[kind.toLowerCase()] = raw ? normalized(raw) : null;
    }
    return { sl: found.sl, tp: found.tp };
  };
  (executor as any).getOpenAlgoOrders = async () =>
    [...orders.values()].filter(order => order.algoStatus === "NEW").map(normalized);
  (executor as any).cancelProtectionByOperationKey = async (_symbol: string, _side: string, operationKey: string) => {
    for (const kind of ["SL", "TP"] as const) {
      const id = (executor as any).makeProtectionClientOrderId(operationKey, kind);
      const raw = orders.get(id);
      if (raw?.algoStatus === "NEW") orders.set(id, { ...raw, algoStatus: "CANCELED" });
    }
  };
  (executor as any).placeSLTP = async (
    _signal: any, _quantity: number, _ticket: number, _spec: any, operationKey: string,
  ) => {
    if (operationKey === nextOperationKey) {
      throw new Error("SL placement failed code=-4130: conflicting close-position order");
    }
    assert(operationKey === restoreKey, "restoration must use its own deterministic operation key");
    add(restoreKey, "SL", 811, 90);
    add(restoreKey, "TP", 812, 110);
  };

  const result = await executor.modifyPosition(
    8, symbol, "BUY", 91, 111, nextOperationKey, priorOperationKey,
    async state => { states.push(state); return true; },
  );

  assert(!result, "requested modification must report failure when the replacement is rejected");
  assert(states.some(state => state.phase === "OLD_CANCEL_REQUESTED"), "durable cancel intent must be persisted before old protection is removed");
  assert(states.some(state => state.phase === "RESTORE_REQUESTED"), "restoration intent must be persisted before restoring the prior targets");
  assert(states.some(state => state.phase === "RESTORE_VERIFIED" && state.activeProtectionKey === restoreKey), "restored pair and its active identity must be persisted after verification");
  assert(
    [...orders.values()].some(order => order.clientAlgoId === (executor as any).makeProtectionClientOrderId(restoreKey, "SL") && order.algoStatus === "NEW") &&
    [...orders.values()].some(order => order.clientAlgoId === (executor as any).makeProtectionClientOrderId(restoreKey, "TP") && order.algoStatus === "NEW"),
    "both restored protection legs must be active",
  );
  assert(
    ![...orders.values()].some(order => order.clientAlgoId === (executor as any).makeProtectionClientOrderId(nextOperationKey, "SL") && order.algoStatus === "NEW"),
    "a failed replacement must not remain open",
  );
  assert(manual.algoStatus === "NEW", "unrelated manual protection must remain untouched");
  assert(loggedWarning.includes("code=-4130"), "the broker conflict code must remain visible");
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

async function verifyCancelIntentPersistenceFailurePreventsCancellation() {
  const executor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  const symbol = "BTCUSDT";
  const priorKey = "durable-prior-operation";
  const nextKey = "durable-next-operation";
  const raw = (kind: "SL" | "TP", algoId: number, triggerPrice: number) => {
    const clientAlgoId = (executor as any).makeProtectionClientOrderId(priorKey, kind);
    return {
      symbol, algoId, orderId: algoId, clientAlgoId,
      clientOrderId: clientAlgoId, origClientOrderId: clientAlgoId,
      algoType: "CONDITIONAL", algoStatus: "NEW", status: "NEW",
      side: "SELL",
      orderType: kind === "SL" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
      type: kind === "SL" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
      triggerPrice: String(triggerPrice), stopPrice: String(triggerPrice),
      closePosition: true,
    };
  };
  const prior = { sl: raw("SL", 901, 90), tp: raw("TP", 902, 110) };
  let cancellations = 0;
  let placements = 0;
  const phases: string[] = [];
  (executor as any).getPosition = async () => ({ positionAmt: 1, entryPrice: 100 });
  (executor as any).recoverProtectionByOperation = async (_symbol: string, key: string) =>
    key === priorKey ? prior : { sl: null, tp: null };
  (executor as any).cancelProtectionByOperationKey = async () => { cancellations += 1; };
  (executor as any).placeSLTP = async () => { placements += 1; };
  const result = await executor.modifyPosition(
    9, symbol, "BUY", 91, 111, nextKey, priorKey,
    async state => {
      phases.push(String(state.phase));
      if (state.phase === "OLD_CANCEL_REQUESTED") return false;
      return true;
    },
  );
  assert(!result, "modification must fail if durable cancel intent cannot be persisted");
  assert(cancellations === 0, "no broker cancellation may occur before cancel intent is durably recorded");
  assert(placements === 0, "replacement placement must not occur after cancel-intent persistence failure");
  assert(phases.includes("PREPARED") && phases.includes("OLD_CANCEL_REQUESTED"), "the persistence failure must be exercised at the intended phase");
}

async function main() {
  await verifyMissingPriorIdentityBlocksModification();
  await verifyCancelIntentPersistenceFailurePreventsCancellation();
  await verifyReplaceThenCancelExactPriorPair();
  await verifyReplacementFailureKeepsOldProtection();
  await verifyExistingAlgoPairIsRecoveredWithoutDuplicateSubmission();
  console.log(`Result: ${assertions} passed, 0 failed`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
