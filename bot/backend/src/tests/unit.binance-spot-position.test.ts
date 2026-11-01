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
  assert(!closed.ok, "Spot restart close must fail closed without the authoritative OCO identity");
  assert(closeRequest === null, "Spot market close must not be sent while protection ownership is unknown");

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

  console.log("Result: 8 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
