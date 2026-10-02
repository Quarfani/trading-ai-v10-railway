const { BinanceExecutor } = require("../execution/BinanceExecutor");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
  (executor as any).getOpenOrders = async () => [
    { orderId: 702, type: "TAKE_PROFIT_MARKET" },
  ];
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

  (executor as any).getOpenOrders = async () => [];
  (executor as any).getPosition = async () => ({
    positionAmt: 0,
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
  (executor as any).getOpenOrders = async () => [
    { orderId: 801, side: "SELL", type: "STOP_MARKET", closePosition: "true" },
    { orderId: 802, side: "SELL", type: "TAKE_PROFIT_MARKET", closePosition: "true" },
  ];
  (executor as any).signedDelete = async () => ({});
  (executor as any).signedGet = async () => [
    { realizedPnl: "10", commission: "0.10", commissionAsset: "USDT" },
  ];
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
  (spotPnl as any).getSpotOcoByClientId = async () => null;
  (spotPnl as any).getPosition = async () => ({ positionAmt: 0.5, entryPrice: 0, unrealizedProfit: 0 });
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
      return {
        balances: [
          { asset: "BTC", free: "0", locked: "0" },
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
    undefined,
    100,
  );
  assert(spotProfit.ok, "Spot close with authoritative fills must succeed");
  assert(
    spotProfit.realizedProfitCurrency === "USDT",
    "Spot realized PnL must be denominated in the quote asset",
  );
  assert(
    Math.abs(Number(spotProfit.realizedProfit) - 5.488) < 1e-9,
    "Spot realized PnL must equal weighted exit proceeds minus entry cost and quote fees",
  );
  assert(postCalls === 1, "Spot PnL test must submit exactly one market close");

  const spot = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: false },
  } as any);
  const canceledSpot: number[] = [];
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
    canceledSpot.push(Number(params.orderId));
    return {};
  };
  (spot as any).getOpenOrders = async () => [];
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
      fills: [{ price: "110", qty: "0.1" }],
    };
  };

  const spotClosed = await spot.closePosition(
    900,
    "BTCUSDT",
    0.1,
    "BUY",
    "close-spot-operation",
    "open-spot-operation",
  );
  assert(spotClosed.ok, "Spot close must succeed after exact OCO recovery/cancellation");
  assert(
    canceledSpot.includes(8801) && canceledSpot.includes(8802),
    "Spot close after restart must cancel both recovered OCO legs",
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
  let flatRejected = false;
  try {
    await executor.closePosition(
      1001,
      "BTCUSDT",
      1,
      "BUY",
      "flat-position-new-operation",
    );
  } catch {
    flatRejected = true;
  }
  assert(
    flatRejected,
    "a new Binance close operation must not infer success from an already-flat position",
  );

  console.log("Result: 11 passed, 0 failed");

}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
