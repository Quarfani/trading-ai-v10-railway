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

  const clientIdExecutor = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  const operationKey = "CLOSE:" + "x".repeat(120);
  let sentClientId = "";
  (clientIdExecutor as any).getPosition = async () => ({
    positionAmt: 1,
    entryPrice: 50_000,
    unrealizedProfit: 0,
  });
  (clientIdExecutor as any).signedPost = async (_path: string, payload: any) => {
    sentClientId = String(payload.newClientOrderId);
    return { orderId: 888, status: "FILLED", executedQty: "1" };
  };
  (clientIdExecutor as any).getFuturesOrderNetPnl = async () => ({
    profit: 10,
    currency: "USDT",
  });
  const closeResult = await clientIdExecutor.closePosition(
    43,
    "BTCUSDT",
    1,
    "BUY",
    operationKey,
  );
  const expectedClientId = (clientIdExecutor as any).closeClientOrderId(operationKey);
  assert(closeResult.ok, "close with a valid broker fill must succeed");
  assert(sentClientId === expectedClientId, "close must send the same deterministic client id used for recovery");
  assert(sentClientId.length <= 36, "Binance close client id must stay within the broker length limit");

  let searchedClientId = "";
  (clientIdExecutor as any).findOrderByClientId = async (_symbol: string, clientId: string) => {
    searchedClientId = clientId;
    return { orderId: 888, status: "FILLED", executedQty: "1" };
  };
  (clientIdExecutor as any).getPosition = async () => ({ positionAmt: 0 });
  const recovered = await clientIdExecutor.reconcileCloseOperation(
    "BTCUSDT",
    operationKey,
    1,
    false,
  );
  assert(recovered?.ok === true, "filled Binance close must be recoverable by client id");
  assert(searchedClientId === expectedClientId, "recovery lookup must use the exact client id submitted to Binance");

  const result = await executor.closePosition(42, "BTCUSDT", 1, "BUY");
  assert(!result.ok, "full close must fail closed when old protection remains");
  assert(!marketCloseSubmitted, "market close must not be submitted with stale protection");
  
  const partialRecovery = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  (partialRecovery as any).findOrderByClientId = async () => ({
    orderId: 900,
    status: "PARTIALLY_FILLED",
    executedQty: "0.002",
  });
  (partialRecovery as any).getFuturesOrderNetPnl = async () => ({
    profit: 2,
    currency: "USDT",
  });
  (partialRecovery as any).getPosition = async () => ({ positionAmt: 0.008 });
  const stillUnknown = await partialRecovery.reconcileCloseOperation(
    "BTCUSDT",
    "partial-op",
    0.004,
    true,
  );
  assert(stillUnknown === null, "PARTIALLY_FILLED Binance close must remain unresolved");

  (partialRecovery as any).findOrderByClientId = async () => ({
    orderId: 901,
    status: "FILLED",
    executedQty: "0.004",
  });
  const recoveredPartial = await partialRecovery.reconcileCloseOperation(
    "BTCUSDT",
    "partial-op",
    0.004,
    true,
  );
  assert(recoveredPartial?.ok === true, "FILLED Binance partial close must be recoverable");
  assert(recoveredPartial.remainingVolume === 0.008, "partial recovery must preserve broker remaining volume");

  const retrySafe = new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: true },
  } as any);
  (retrySafe as any).orderMap.set(55, {
    slOrderId: 701,
    tpOrderId: 702,
    quantity: 1,
  });
  let closePostAttempts = 0;
  const deletedProtection: number[] = [];
  (retrySafe as any).signedDelete = async (_path: string, params: any) => {
    deletedProtection.push(Number(params.orderId));
    return {};
  };
  (retrySafe as any).getOpenOrders = async () => [];
  (retrySafe as any).getPosition = async () => ({
    positionAmt: 1, entryPrice: 100, unrealizedProfit: 0,
  });
  (retrySafe as any).signedPost = async () => {
    closePostAttempts += 1;
    throw new Error("temporary exchange timeout after protection cancellation");
  };
  const firstClose = await retrySafe.closePosition(55, "BTCUSDT", 1, "BUY", "retry-safe-close");
  assert(firstClose.ok === false, "temporary close failure must remain unsuccessful");
  assert(
    (retrySafe as any).orderMap.get(55) != null,
    "failed Binance close must retain orderMap for safe retry/cleanup",
  );
  assert(closePostAttempts === 1, "failed close must issue only one broker close attempt");
  assert(
    deletedProtection.includes(701) && deletedProtection.includes(702),
    "close must attempt to retire both prior protective orders",
  );

  console.log("Result: 9 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
