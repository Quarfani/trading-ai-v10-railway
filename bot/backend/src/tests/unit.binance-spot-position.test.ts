function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const { BinanceExecutor } = require("../execution/BinanceExecutor");
  const executor = new BinanceExecutor({
  binance: {
    apiKey: "test",
    secret: "test",
    env: "testnet",
    futures: false,
  },
} as any);

(executor as any).signedGet = async (path: string) => {
  assert(path === "/api/v3/account", "Spot position lookup must use Spot account endpoint");
  return {
    balances: [
      { asset: "BTC", free: "0.4", locked: "0.1" },
      { asset: "USDT", free: "1000", locked: "0" },
    ],
  };
};

  const position = await executor.getPosition("BTCUSDT");
  assert(!!position, "Spot account lookup should return a position object");
  assert(position!.positionAmt === 0.5, "Spot position amount must equal free+locked base balance");
  assert(position!.entryPrice === 0, "Spot position entry price is not inferred during reconciliation");

  let closeRequest: any = null;
  (executor as any).signedDelete = async () => {};
  (executor as any).signedPost = async (path: string, params: any) => {
    closeRequest = { path, params };
    return { orderId: 99 };
  };

  // Simulate a process restart: the in-memory orderMap is empty, but the
  // persisted trade side/volume are still available to the Gateway.
  const closed = await executor.closePosition(123, "BTCUSDT", 0.5, "BUY");
  assert(closed.ok, "Spot position must remain closable after restart");
  assert(closed.realizedProfit === null, "Spot close does not expose a futures-style realized PnL");
  assert(closeRequest?.path === "/api/v3/order", "Spot close must use the Spot order endpoint");
  assert(closeRequest?.params?.side === "SELL", "BUY trade must close with SELL");
  assert(Number(closeRequest?.params?.quantity) === 0.5, "Spot restart close must use persisted trade volume");

  (executor as any).signedGet = async (path: string) => {
    assert(path === "/api/v3/account", "Spot equity must query the Spot account endpoint");
    return {
      balances: [
        { asset: "BTC", free: "0.5", locked: "0" },
        { asset: "USDT", free: "1000", locked: "0" },
      ],
    };
  };
  (executor as any).http.get = async (path: string, options: any) => {
    assert(path === "/api/v3/ticker/price", "Spot equity must mark non-stable assets using market prices");
    assert(options?.params?.symbol === "BTCUSDT", "BTC must be marked through BTCUSDT");
    return { data: { price: "20000" } };
  };

  const equity = await executor.accountEquity();
  assert(equity === 11000, "Spot equity must include marked BTC inventory plus USDT");

  const ocoExecutor = new BinanceExecutor({
    binance: {
      apiKey: "test",
      secret: "test",
      env: "testnet",
      futures: false,
    },
  } as any);
  (ocoExecutor as any).signedPost = async (path: string) => {
    assert(path === "/api/v3/orderList/oco", "Spot protection must use OCO order-list endpoint");
    return {
      orderReports: [
        { orderId: 801, type: "LIMIT_MAKER", clientOrderId: "taa" },
        { orderId: 802, type: "STOP_LOSS_LIMIT", clientOrderId: "tab" },
      ],
    };
  };
  (ocoExecutor as any).getOpenOrders = async () => [
    { orderId: 801 },
    { orderId: 802 },
  ];
  (ocoExecutor as any).signedDelete = async () => ({});
  await (ocoExecutor as any).placeOCO(
    {
      symbol: "BTCUSDT", side: "BUY", price: 20_000, confidence: 1,
      sl: 19_000, tp: 22_000, source: "TEST", reason: "OCO", timestamp: Date.now(),
    },
    0.5,
    123,
    { pip: 0.1, volumeStep: 0.0001 },
    "spot-oco-operation",
  );
  const ocoMap = (ocoExecutor as any).orderMap.get(123);
  assert(
    ocoMap.slOrderId === 802 && ocoMap.tpOrderId === 801,
    "Spot OCO protection must only be accepted after broker-visible child verification",
  );

  const ocoFailExecutor = new BinanceExecutor({
    binance: {
      apiKey: "test",
      secret: "test",
      env: "testnet",
      futures: false,
    },
  } as any);
  const ocoCleanup: number[] = [];
  (ocoFailExecutor as any).signedPost = async () => ({
    orderReports: [
      { orderId: 901, type: "LIMIT_MAKER" },
      { orderId: 902, type: "STOP_LOSS_LIMIT" },
    ],
  });
  (ocoFailExecutor as any).getOpenOrders = async () => [{ orderId: 901 }];
  (ocoFailExecutor as any).signedDelete = async (_path: string, params: any) => {
    ocoCleanup.push(Number(params.orderId));
  };
  let ocoFailed = false;
  try {
    await (ocoFailExecutor as any).placeOCO(
      {
        symbol: "ETHUSDT", side: "BUY", price: 2000, confidence: 1,
        sl: 1900, tp: 2200, source: "TEST", reason: "OCO_FAIL", timestamp: Date.now(),
      },
      0.5,
      124,
      { pip: 0.1, volumeStep: 0.0001 },
      "spot-oco-fail",
    );
  } catch {
    ocoFailed = true;
  }
  assert(ocoFailed, "Spot OCO with a missing child order must fail closed");
  assert(
    ocoCleanup.includes(901) && ocoCleanup.includes(902),
    "failed Spot OCO verification must attempt cleanup of both child orders",
  );
  console.log("Result: 12 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
