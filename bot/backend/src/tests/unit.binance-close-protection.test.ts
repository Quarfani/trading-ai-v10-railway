const { BinanceExecutor } = require("../execution/BinanceExecutor");

let assertions = 0;

function assert(condition: unknown, message: string): asserts condition {
  assertions += 1;
  if (!condition) throw new Error(message);
}

async function verifyFuturesProtectionModificationOrdering() {
  const executor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  const symbol = "BTCUSDT";
  const priorOperationKey = "open-operation-for-old-protection";
  const nextOperationKey = "move-operation-for-new-protection";
  const orderMap = new Map<string, any>();
  const deletedAlgoIds: number[] = [];
  let replacementVerified = false;

  const makeAlgoOrder = (
    operationKey: string,
    kind: "SL" | "TP",
    algoId: number,
    triggerPrice: number,
    status = "NEW",
  ) => {
    const clientAlgoId = (executor as any).makeProtectionClientOrderId(operationKey, kind);
    const order = {
      symbol,
      orderId: algoId,
      algoId,
      clientOrderId: clientAlgoId,
      algoType: "CONDITIONAL",
      status,
      type: kind === "SL" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
      side: "SELL",
      closePosition: true,
      stopPrice: triggerPrice,
    };
    orderMap.set(clientAlgoId, order);
    return order;
  };

  const oldSl = makeAlgoOrder(priorOperationKey, "SL", 701, 90);
  const oldTp = makeAlgoOrder(priorOperationKey, "TP", 702, 120);
  const newSl = makeAlgoOrder(nextOperationKey, "SL", 703, 95);
  const newTp = makeAlgoOrder(nextOperationKey, "TP", 704, 125);
  const unrelated = {
    symbol,
    orderId: 799,
    algoId: 799,
    clientAlgoId: "manual-algo-order",
    clientOrderId: "manual-algo-order",
    algoType: "CONDITIONAL",
    status: "NEW",
    type: "STOP_MARKET",
    side: "SELL",
    closePosition: true,
    stopPrice: 80,
  };
  orderMap.set(unrelated.clientAlgoId, unrelated);
  newSl.status = "NOT_CREATED";
  newTp.status = "NOT_CREATED";
  orderMap.set(newSl.clientOrderId, newSl);
  orderMap.set(newTp.clientOrderId, newTp);

  (executor as any).getPosition = async () => ({
    positionAmt: 1,
    entryPrice: 100,
    unrealizedProfit: 0,
  });
  (executor as any).placeSLTP = async (
    signal: any,
    quantity: number,
    _ticket: number,
    _spec: any,
    protectionKey: string,
  ) => {
    assert(protectionKey === nextOperationKey, "replacement SL/TP must use the new MOVE_SL_TP operation key");
    assert(quantity === 1, "replacement protection quantity must be based on current verified inventory");
    assert(signal.sl === 95 && signal.tp === 125, "replacement protection must use requested new targets");
    replacementVerified = true;
    orderMap.set(newSl.clientOrderId, { ...newSl, status: "NEW" });
    orderMap.set(newTp.clientOrderId, { ...newTp, status: "NEW" });
  };
  (executor as any).getAlgoOrderByClientIdStrict = async (
    requestedSymbol: string,
    clientAlgoId: string,
  ) => {
    assert(requestedSymbol === symbol, "exact Algo recovery must stay scoped to the symbol");
    const order = orderMap.get(clientAlgoId);
    return order ? { ...order } : null;
  };
  (executor as any).signedDelete = async (path: string, params: any) => {
    assert(replacementVerified, "replacement pair must be verified before the prior protection is canceled");
    assert(path === "/fapi/v1/algoOrder", "prior conditional orders must be canceled through the Algo API");
    const algoId = Number(params?.algoId);
    assert([701, 702].includes(algoId), "modification must cancel only the exact previous operation's SL/TP");
    const order = [...orderMap.values()].find(value => Number(value.algoId) === algoId);
    assert(order && [oldSl.clientOrderId, oldTp.clientOrderId].includes(order.clientOrderId), "cancellation must identify the prior operation's exact clientAlgoId");
    deletedAlgoIds.push(algoId);
    orderMap.set(order.clientOrderId, { ...order, status: "CANCELED" });
    return { algoId, clientAlgoId: order.clientOrderId };
  };
  (executor as any).getOpenAlgoOrders = async () =>
    [...orderMap.values()].filter(order => order.status === "NEW");

  const modified = await executor.modifyPosition(
    42,
    symbol,
    "BUY",
    95,
    125,
    nextOperationKey,
    priorOperationKey,
  );
  assert(modified, "SL/TP modification must succeed after verified replacement and prior-pair cancellation");
  assert(deletedAlgoIds.length === 2, "exactly the prior SL and TP must be canceled");
  assert(deletedAlgoIds.includes(701) && deletedAlgoIds.includes(702), "prior protection ids must both be canceled");
  const currentOrders = await (executor as any).getOpenAlgoOrders(symbol);
  assert(currentOrders.some((order: any) => Number(order.algoId) === 703), "new SL must remain open after modification");
  assert(currentOrders.some((order: any) => Number(order.algoId) === 704), "new TP must remain open after modification");
  assert(currentOrders.some((order: any) => Number(order.algoId) === 799), "unrelated manual Algo order must remain untouched");

  const failedExecutor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  const failedOldOperation = "old-protection-after-create-failure";
  const failedNewOperation = "new-protection-after-create-failure";
  const failedOld = new Map<string, any>();
  for (const [kind, id, price] of [["SL", 801, 90], ["TP", 802, 120]] as const) {
    const clientAlgoId = (failedExecutor as any).makeProtectionClientOrderId(failedOldOperation, kind);
    failedOld.set(clientAlgoId, {
      symbol,
      orderId: id,
      algoId: id,
      clientOrderId: clientAlgoId,
      algoType: "CONDITIONAL",
      status: "NEW",
      type: kind === "SL" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
      side: "SELL",
      closePosition: true,
      stopPrice: price,
    });
  }
  let priorCancellationCalls = 0;
  (failedExecutor as any).getPosition = async () => ({ positionAmt: 1, entryPrice: 100, unrealizedProfit: 0 });
  (failedExecutor as any).placeSLTP = async () => {
    throw new Error("simulated replacement protection creation failure");
  };
  (failedExecutor as any).getAlgoOrderByClientIdStrict = async (_symbol: string, clientAlgoId: string) => {
    const order = failedOld.get(clientAlgoId);
    return order ? { ...order } : null;
  };
  (failedExecutor as any).signedDelete = async () => {
    priorCancellationCalls += 1;
    throw new Error("old protection must not be canceled on failed replacement");
  };
  (failedExecutor as any).getOpenAlgoOrders = async () => [...failedOld.values()].filter(order => order.status === "NEW");

  const rejected = await failedExecutor.modifyPosition(
    43,
    symbol,
    "BUY",
    95,
    125,
    failedNewOperation,
    failedOldOperation,
  );
  assert(!rejected, "modification must be rejected when replacement protection cannot be verified");
  assert(priorCancellationCalls === 0, "old protection must not be canceled before replacement protection is verified");
  assert([...failedOld.values()].every(order => order.status === "NEW"), "old SL/TP must remain active after failed replacement creation");
}

async function main() {
  const executor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);

  (executor as any).orderMap.set(42, {
    slOrderId: 701,
    tpOrderId: 702,
    quantity: 1,
  });

  let marketCloseSubmitted = false;
  let closeClientOrderId = "";
  (executor as any).signedDelete = async () => ({});
  (executor as any).getOpenAlgoOrders = async () => [
    { orderId: 702, algoId: 702, clientOrderId: "ta_tp_open", status: "NEW", type: "TAKE_PROFIT_MARKET", closePosition: "true", symbol: "BTCUSDT" },
  ];
  (executor as any).getOpenOrders = async () => [];
  (executor as any).signedPost = async (_path: string, payload: any) => {
    marketCloseSubmitted = true;
    closeClientOrderId = String(payload?.newClientOrderId ?? "");
    return { orderId: 999, status: "FILLED", executedQty: "1" };
  };

  const result = await executor.closePosition(42, "BTCUSDT", 1, "BUY");
  assert(!result.ok, "full close must fail closed when old protection remains");
  assert(!marketCloseSubmitted, "market close must not be submitted with stale protection");
  
  assert(
    closeClientOrderId === "",
    "blocked full close must not submit a Binance clientOrderId before stale protection is cleared",
  );

  (executor as any).getOpenAlgoOrders = async () => [];
  (executor as any).getOpenOrders = async () => [];
  let closePositionCalls = 0;
  (executor as any).getPosition = async () => ({
    positionAmt: ++closePositionCalls === 1 ? 1 : 0,
    entryPrice: 100,
    unrealizedProfit: 0,
  });
  (executor as any).signedGet = async () => [
    { realizedPnl: "10", commission: "0.10", commissionAsset: "USDT" },
  ];

  const reopened = await executor.closePosition(
    42,
    "BTCUSDT",
    1,
    "BUY",
    "ta_full_test",
  );
  assert(reopened.ok, "full close should succeed after stale protection is cleared");
  assert(closeClientOrderId === "ta_full_test", "full close must forward the durable Binance clientOrderId");

  (executor as any).getPosition = async () => ({
    positionAmt: 0.1,
    entryPrice: 100,
    unrealizedProfit: 0,
  });
  const residual = await executor.closePosition(
    42,
    "BTCUSDT",
    1,
    "BUY",
    "ta_full_residual_test",
  );
  assert(!residual.ok, "full close must fail when Binance reports a residual position");
  
  (executor as any).orderMap.clear();
  let restartPostSubmitted = false;
  const restartAlgoOrders = new Map<number, any>([
    [801, { symbol: "BTCUSDT", orderId: 801, algoId: 801, clientOrderId: "ta_sl_restart", status: "NEW", type: "STOP_MARKET", closePosition: "true", side: "SELL" }],
    [802, { symbol: "BTCUSDT", orderId: 802, algoId: 802, clientOrderId: "ta_tp_restart", status: "NEW", type: "TAKE_PROFIT_MARKET", closePosition: "true", side: "SELL" }],
  ]);
  (executor as any).getOpenAlgoOrders = async () => [...restartAlgoOrders.values()];
  (executor as any).getOpenOrders = async () => [];
  (executor as any).signedDelete = async (path: string, params: any) => {
    assert(path === "/fapi/v1/algoOrder", "restart close must cancel protections using the Algo API");
    const algoId = Number(params?.algoId);
    restartAlgoOrders.delete(algoId);
    return { algoId };
  };
  (executor as any).signedGet = async () => [
    { realizedPnl: "10", commission: "0.10", commissionAsset: "USDT" },
  ];
  (executor as any).signedPost = async () => {
    restartPostSubmitted = true;
    throw new Error("close must not be posted when position state is unavailable");
  };
  (executor as any).getPosition = async () => null;

  const unavailable = await executor.closePosition(
    999,
    "BTCUSDT",
    1,
    "BUY",
    "restart-close-unavailable",
  );
  assert(!unavailable.ok, "restart close must fail closed when position state is unavailable");
  assert(
    !restartPostSubmitted,
    "restart close must not submit a market close without verified position state",
  );

  const spotPnl = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: false },
  } as any);
  (spotPnl as any).getOpenOrders = async () => [];
  (spotPnl as any).recoverSpotOcoByOperation = async () => ({
    orderListId: 6001,
    listStatusType: "EXEC_STARTED",
    listOrderStatus: "EXECUTING",
    orders: [{ orderId: 6002 }, { orderId: 6003 }],
  });
  (spotPnl as any).getSpotOcoByClientId = async () => ({
    listStatusType: "ALL_DONE",
    listOrderStatus: "ALL_DONE",
    orders: [{ orderId: 6002 }, { orderId: 6003 }],
  });
  let spotPositionReads = 0;
  (spotPnl as any).getPosition = async () => ({
    positionAmt: ++spotPositionReads === 1 ? 0.5 : 0,
    entryPrice: 0,
    unrealizedProfit: 0,
  });
  let postCalls = 0;
  (spotPnl as any).signedPost = async (_path: string, payload: any) => {
    postCalls += 1;
    assert(payload.type === "MARKET", "Spot PnL close must submit a market order");
    return {
      orderId: 9901,
      status: "FILLED",
      executedQty: "0.5",
      fills: [
        { price: "110", qty: "0.3", commission: "0.033", commissionAsset: "USDT" },
        { price: "111", qty: "0.2", commission: "0.022", commissionAsset: "USDT" },
      ],
    };
  };
  (spotPnl as any).signedGet = async (path: string) => {
    if (path === "/api/v3/account") {
      const baseBalance = spotPositionReads <= 1 ? "0.5" : "0";
      return {
        balances: [
          { asset: "BTC", free: baseBalance, locked: "0" },
        ],
      };
    }
    if (path === "/api/v3/myTrades") {
      return [
        { price: "110", qty: "0.3", commission: "0.033", commissionAsset: "USDT" },
        { price: "111", qty: "0.2", commission: "0.022", commissionAsset: "USDT" },
      ];
    }
    return [];
  };
  const spotProfit = await spotPnl.closePosition(
    1002,
    "BTCUSDT",
    0.5,
    "BUY",
    "spot-pnl-close",
    "spot-open-operation",
    100,
  );
  assert(spotProfit.ok, "Spot close with authoritative fills must succeed");
  assert(
    spotProfit.realizedProfitCurrency === "USDT",
    "Spot realized PnL must be denominated in the quote asset",
  );
  assert(
    Math.abs(Number(spotProfit.realizedProfit) - 5.145) < 1e-9,
    "Spot realized PnL must equal weighted exit proceeds minus entry cost and quote fees",
  );
  assert(postCalls === 1, "Spot PnL test must submit exactly one market close");

  const spot = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: false },
  } as any);
  const canceledSpotLists: number[] = [];
  let spotPostSubmitted = false;
  (spot as any).recoverSpotOcoByOperation = async (symbol: string, operationKey: string) => {
    assert(symbol === "BTCUSDT", "Spot close recovery must use the trade symbol");
    assert(operationKey === "open-spot-operation", "Spot close recovery must use the exact OPEN operation key");
    return {
      orderListId: 555,
      listStatusType: "EXEC_STARTED",
      listOrderStatus: "EXECUTING",
      orders: [
        { orderId: 8801, clientOrderId: "tp" },
        { orderId: 8802, clientOrderId: "sl" },
      ],
    };
  };
  (spot as any).signedDelete = async (_path: string, params: any) => {
    canceledSpotLists.push(Number(params.orderListId));
    return {
      listClientOrderId: (spot as any).makeOcoClientOrderId(
        "open-spot-operation",
        "LIST",
      ),
    };
  };
  (spot as any).getSpotOcoByClientId = async () => null;
  (spot as any).getOpenOrders = async () => [];
  (spot as any).signedGet = async (path: string) => {
    assert(path === "/api/v3/myTrades", "Spot exit PnL must use authoritative trade fills");
    return [{ price: "110", qty: "0.1", commission: "0.01", commissionAsset: "USDT" }];
  };
  let spotPositionCalls = 0;
  (spot as any).getPosition = async () => {
    spotPositionCalls += 1;
    return spotPositionCalls === 1
      ? { positionAmt: 0.1, entryPrice: 0, unrealizedProfit: 0 }
      : { positionAmt: 0, entryPrice: 0, unrealizedProfit: 0 };
  };
  (spot as any).signedPost = async (_path: string, payload: any) => {
    spotPostSubmitted = true;
    assert(payload.type === "MARKET", "Spot close must use a market order");
    return {
      orderId: 8803,
      status: "FILLED",
      executedQty: "0.1",
    };
  };

  const spotClosed = await spot.closePosition(
    900,
    "BTCUSDT",
    0.1,
    "BUY",
    "close-spot-operation",
    "open-spot-operation",
    100,
  );
  assert(spotClosed.ok, "Spot close must succeed after exact OCO recovery/cancellation");
  assert(
    canceledSpotLists.includes(555),
    "Spot close after restart must cancel the exact recovered OCO list",
  );
  assert(
    spotPostSubmitted,
    "Spot market close must only be submitted after OCO cancellation",
  );

  (executor as any).orderMap.clear();
  (executor as any).getProtectiveOrderIds = async () => [];
  (executor as any).getOpenOrders = async () => [];
  (executor as any).getPosition = async () => ({
    positionAmt: 0,
    entryPrice: 100,
    unrealizedProfit: 0,
  });
  const alreadyFlat = await executor.closePosition(
    1001,
    "BTCUSDT",
    1,
    "BUY",
    "flat-position-new-operation",
  );
  assert(
    !alreadyFlat.ok,
    "a new Binance close operation must not infer success from an already-flat position",
  );

  const positionExecutor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  (positionExecutor as any).signedGet = async () => [
    { symbol: "BTCUSDT", positionAmt: "0", entryPrice: "0", unRealizedProfit: "0" },
    { symbol: "ETHUSDT", positionAmt: "0.25", entryPrice: "2500", unRealizedProfit: "10" },
  ];
  const openPositions = await positionExecutor.getAllPositions();
  assert(openPositions.length === 1, "flat Futures rows must not appear as open positions during startup reconciliation");
  assert(
    openPositions[0].symbol === "ETHUSDT" && openPositions[0].positionAmt === 0.25,
    "non-zero Futures positions must be preserved for reconciliation",
  );

  await verifyFuturesProtectionModificationOrdering();

  console.log(`Result: ${assertions} passed, 0 failed`);

}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

