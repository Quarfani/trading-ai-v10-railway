const { BinanceExecutor } = require("../execution/BinanceExecutor");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const executor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);

  (executor as any).orderMap.set(7, {
    slOrderId: 101,
    tpOrderId: 102,
    quantity: 1,
  });

  const deleted: number[] = [];
  (executor as any).signedDelete = async (_path: string, params: any) => {
    const id = Number(params.orderId);
    deleted.push(id);
    if (id === 102) throw new Error("temporary cancel failure");
    return {};
  };

  (executor as any).getOpenOrders = async () => [
    { orderId: 102, type: "TAKE_PROFIT_MARKET" },
  ];

  (executor as any).placeSLTP = async () => {
    (executor as any).orderMap.set(7, {
      slOrderId: 201,
      tpOrderId: 202,
      quantity: 1,
    });
  };

  const modified = await executor.modifyPosition(7, "BTCUSDT", "BUY", 90, 110);
  assert(modified, "modify should succeed when replacement protection is live");
  assert(deleted.includes(101) && deleted.includes(102), "modify must attempt both old protective orders");
  const replacement = (executor as any).orderMap.get(7);
  assert(
    replacement.slOrderId === 201 && replacement.tpOrderId === 202,
    "new protective orders must remain authoritative after replacement",
  );
  assert(
    Array.isArray(replacement.staleOrderIds) && replacement.staleOrderIds.includes(102),
    "old cancellation failures must be tracked as stale protective orders",
  );

  const failing = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  (failing as any).orderMap.set(8, {
    slOrderId: 301,
    tpOrderId: 302,
    quantity: 1,
  });
  (failing as any).placeSLTP = async () => {
    throw new Error("replacement rejected");
  };
  (failing as any).signedDelete = async () => {
    throw new Error("old protection must not be touched before replacement");
  };

  const rejected = await failing.modifyPosition(8, "ETHUSDT", "BUY", 1800, 2200);
  assert(!rejected, "modify must fail when replacement protection cannot be installed");
  const preserved = (failing as any).orderMap.get(8);
  assert(
    preserved.slOrderId === 301 && preserved.tpOrderId === 302,
    "failed replacement must preserve the old protective orders",
  );

  console.log("Result: 5 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
