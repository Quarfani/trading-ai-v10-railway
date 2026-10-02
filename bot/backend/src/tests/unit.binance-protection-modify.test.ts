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

  const verifyFailure = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  (verifyFailure as any).orderMap.set(9, {
    slOrderId: 401,
    tpOrderId: 402,
    quantity: 1,
  });
  (verifyFailure as any).placeSLTP = async () => {
    (verifyFailure as any).orderMap.set(9, {
      slOrderId: 501,
      tpOrderId: 502,
      quantity: 1,
    });
  };
  (verifyFailure as any).signedDelete = async () => {};
  (verifyFailure as any).getOpenOrders = async () => {
    throw new Error("verification unavailable");
  };
  const verificationUnavailable = await verifyFailure.modifyPosition(
    9, "SOLUSDT", "BUY", 90, 110,
  );
  assert(
    verificationUnavailable,
    "new protection should remain authoritative when old-order verification is temporarily unavailable",
  );
  const verificationState = (verifyFailure as any).orderMap.get(9);
  assert(
    verificationState.slOrderId === 501 &&
      verificationState.tpOrderId === 502 &&
      verificationState.staleOrderIds.includes(401) &&
      verificationState.staleOrderIds.includes(402),
    "verification failure must preserve all prior order ids as stale cleanup targets",
  );

  const verificationExecutor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  const verificationPosts: any[] = [
    { orderId: 601 },
    { orderId: 602 },
  ];
  (verificationExecutor as any).signedPost = async () => verificationPosts.shift();
  (verificationExecutor as any).signedDelete = async () => ({});
  (verificationExecutor as any).getOpenOrders = async () => [
    { orderId: 601 },
    { orderId: 602 },
  ];
  await (verificationExecutor as any).placeSLTP(
    {
      symbol: "BTCUSDT", side: "BUY", price: 100, confidence: 1,
      sl: 90, tp: 110, source: "TEST", reason: "verify", timestamp: Date.now(),
    },
    1,
    10,
    { pip: 0.1, volumeStep: 0.001 },
  );
  const verifiedMap = (verificationExecutor as any).orderMap.get(10);
  assert(verifiedMap.slOrderId === 601 && verifiedMap.tpOrderId === 602, "accepted SL/TP must be broker-verified before mapping");

  const incompleteExecutor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  const cleanup: number[] = [];
  (incompleteExecutor as any).signedPost = async () => ({ orderId: cleanup.length === 0 ? 701 : 702 });
  (incompleteExecutor as any).signedDelete = async (_path: string, params: any) => { cleanup.push(Number(params.orderId)); };
  (incompleteExecutor as any).getOpenOrders = async () => [{ orderId: 701 }];
  let verificationFailed = false;
  try {
    await (incompleteExecutor as any).placeSLTP(
      {
        symbol: "ETHUSDT", side: "BUY", price: 1000, confidence: 1,
        sl: 900, tp: 1100, source: "TEST", reason: "verify", timestamp: Date.now(),
      },
      1,
      11,
      { pip: 0.1, volumeStep: 0.001 },
    );
  } catch {
    verificationFailed = true;
  }
  assert(verificationFailed, "missing broker-visible protective order must fail closed");
  assert(cleanup.includes(701) && cleanup.includes(702), "failed protection verification must attempt to clean created orders");

  console.log("Result: 12 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
