const { BinanceExecutor } = require("../execution/BinanceExecutor");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

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

console.log("Result: 3 passed, 0 failed");
