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
  (executor as any).signedDelete = async () => ({});
  (executor as any).getOpenOrders = async () => [
    { orderId: 702, type: "TAKE_PROFIT_MARKET" },
  ];
  (executor as any).signedPost = async () => {
    marketCloseSubmitted = true;
    return { orderId: 999, status: "FILLED", executedQty: "1" };
  };

  const result = await executor.closePosition(42, "BTCUSDT", 1, "BUY");
  assert(!result.ok, "full close must fail closed when old protection remains");
  assert(!marketCloseSubmitted, "market close must not be submitted with stale protection");
  
  console.log("Result: 2 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
