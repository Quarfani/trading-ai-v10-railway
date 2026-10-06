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
  (executor as any).getProtectiveOrderIds = async () => [];
  (executor as any).getPosition = async () => ({
    positionAmt: 1,
    entryPrice: 100,
    unrealizedProfit: 0,
  });

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

  const rawProtectionId = (executor as any).makeProtectionClientOrderId(
    "modify-operation-identity",
    "SL",
  );
  assert(
    rawProtectionId.length <= 32 &&
      /^[.A-Z:/a-z0-9_-]{1,32}$/.test(rawProtectionId),
    "Binance protection clientOrderId must satisfy the documented 32-char format",
  );

  (executor as any).orderMap.clear();
  const restartDeleted: number[] = [];
  let verificationPass = false;
  (executor as any).getOpenOrders = async () => {
    if (!verificationPass) {
      return [
        { orderId: 201, side: "SELL", type: "STOP_MARKET", closePosition: "true", stopPrice: "90" },
        { orderId: 202, side: "SELL", type: "TAKE_PROFIT_MARKET", closePosition: "true", stopPrice: "110" },
      ];
    }
    return [];
  };
  (executor as any).getProtectiveOrderIds = async () => [201, 202];
  (executor as any).signedDelete = async (_path: string, params: any) => {
    restartDeleted.push(Number(params.orderId));
    if (restartDeleted.length === 2) verificationPass = true;
    return {};
  };
  (executor as any).getPosition = async () => ({
    positionAmt: 1,
    entryPrice: 100,
    unrealizedProfit: 0,
  });
  (executor as any).placeSLTP = async () => {};
  const restartModified = await executor.modifyPosition(
    999,
    "BTCUSDT",
    "BUY",
    90,
    110,
    "restart-modify-operation",
  );
  assert(
    restartModified,
    "modify must recover and replace broker protective orders after process restart",
  );
  assert(
    restartDeleted.includes(201) && restartDeleted.includes(202),
    "restart modify must cancel both broker-side protective orders",
  );

  const idempotent = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  let duplicatePosts = 0;
  (idempotent as any).signedGet = async (_path: string, params: any) => {
    const id = String(params.origClientOrderId);
    return id.includes("tasl_")
      ? {
          orderId: 301,
          status: "NEW",
          side: "SELL",
          type: "STOP_MARKET",
          closePosition: "true",
          stopPrice: "90",
          origQty: "1",
        }
      : {
          orderId: 302,
          status: "NEW",
          side: "SELL",
          type: "TAKE_PROFIT_MARKET",
          closePosition: "true",
          stopPrice: "110",
          origQty: "1",
        };
  };
  (idempotent as any).signedPost = async () => {
    duplicatePosts += 1;
    throw new Error("duplicate SL/TP submission should never happen");
  };
  await (idempotent as any).placeSLTP(
    {
      symbol: "BTCUSDT",
      side: "BUY",
      price: 100,
      sl: 90,
      tp: 110,
    } as any,
    1,
    1000,
    { pip: 0.1, volumeStep: 0.001 } as any,
    "existing-protection-operation",
  );
  assert(
    duplicatePosts === 0,
    "existing Binance SL/TP must be recovered instead of duplicated",
  );
  assert(
    (idempotent as any).orderMap.get(1000)?.slOrderId === 301 &&
      (idempotent as any).orderMap.get(1000)?.tpOrderId === 302,
    "recovered Binance SL/TP identities must populate orderMap",
  );

  console.log("Result: 10 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
