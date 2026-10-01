const { BinanceExecutor } = require("../execution/BinanceExecutor");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const executor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);

  let positionRead = 0;
  (executor as any).getPosition = async () => {
    positionRead++;
    if (positionRead === 1) {
      return { positionAmt: 1, entryPrice: 100, unrealizedProfit: 0 };
    }
    return { positionAmt: 0.6, entryPrice: 100, unrealizedProfit: 0 };
  };

  (executor as any).signedPost = async () => ({
    orderId: 321,
    status: "FILLED",
    executedQty: "0.4",
  });

  (executor as any).signedGet = async (path: string) => {
    assert(path === "/fapi/v1/userTrades", "partial PnL must use Futures userTrades");
    return [
      { realizedPnl: "50", commission: "0.20", commissionAsset: "USDT" },
      { realizedPnl: "5", commission: "0.10", commissionAsset: "USDT" },
    ];
  };

  const ok = await executor.closePartialPosition(7, "BTCUSDT", 0.4);
  assert(ok.ok, "partial close should succeed with authoritative fills");
  assert(ok.remainingVolume === 0.6, "remaining broker position must be authoritative");
  assert(
    Math.abs(ok.realizedProfit - 54.7) < 1e-12,
    "realized PnL must equal realizedPnl minus commission",
  );

  positionRead = 0;
  (executor as any).signedGet = async () => [
    { realizedPnl: "50", commission: "0.20", commissionAsset: "BTC" },
  ];
  const badFee = await executor.closePartialPosition(7, "BTCUSDT", 0.4);
  assert(!badFee.ok, "unexpected commission asset must fail closed");

  console.log("Result: 4 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
