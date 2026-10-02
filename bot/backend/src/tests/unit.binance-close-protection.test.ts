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

  console.log("Result: 4 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
