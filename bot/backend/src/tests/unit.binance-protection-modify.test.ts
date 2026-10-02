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
    deleted.push(Number(params.orderId));
    return {};
  };

  (executor as any).getOpenOrders = async () => [
    { orderId: 102, type: "TAKE_PROFIT_MARKET" },
  ];

  (executor as any).placeSLTP = async () => {
    throw new Error("must not replace protection while an old order remains");
  };

  const blocked = await executor.modifyPosition(7, "BTCUSDT", "BUY", 90, 110);
  assert(!blocked, "modify must fail closed when an old protective order remains open");
  assert(deleted.includes(101) && deleted.includes(102), "modify must attempt both old protective order cancellations");

  let protectionKey = "";
  (executor as any).getOpenOrders = async () => [];
  (executor as any).placeSLTP = async (
    _sig: any,
    _quantity: number,
    _ticket: number,
    _spec: any,
    key?: string,
  ) => {
    protectionKey = String(key ?? "");
  };

  const modified = await executor.modifyPosition(
    7,
    "BTCUSDT",
    "BUY",
    91,
    111,
    "modify-operation-identity",
  );
  assert(modified, "modify must succeed after old protection cancellation is verified");
  assert(
    protectionKey === "modify-operation-identity",
    "modify must pass the durable operation identity into protective-order creation",
  );

  console.log("Result: 5 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
