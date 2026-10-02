import { BinanceExecutor } from "../execution/BinanceExecutor";
import { SystemConfig } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(): SystemConfig {
  return {
    mode: "binance",
    dataSource: "binance",
    accountBalance: 10_000,
    accountCurrency: "USD",
    accountName: "binance-post-fill-test",
    riskPerTrade: 0.01,
    maxOpenTrades: 5,
    minConfidence: 0.55,
    maxDailyLoss: 0.02,
    dailyProfitTarget: 0.05,
    consecutiveLossLimit: 3,
    cooldownMinutes: 60,
    mlRequired: false,
    symbols: ["BTCUSDT"],
    timeframes: ["H1"],
    scanInterval: 60_000,
    dbPath: ":memory:",
    mt5: { login: 0, password: "", server: "", bridgeUrl: "", bridgeApiKey: "" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

async function main() {
  // Full close must not report success when there is no open position.
  const empty = new BinanceExecutor(config()) as any;
  empty.getPosition = async () => ({
    positionAmt: 0,
    entryPrice: 50_000,
    unrealizedProfit: 0,
  });
  let emptyPosts = 0;
  empty.signedPost = async () => {
    emptyPosts += 1;
    return { orderId: 1 };
  };
  const emptyResult = await empty.closePosition(1, "BTCUSDT", 1, "BUY");
  assert(emptyResult.ok === false, "full close with no broker position must fail closed");
  assert(emptyPosts === 0, "no-position full close must never send an order");

  // Partial close must reject silent clamping when requested size exceeds live size.
  const mismatch = new BinanceExecutor(config()) as any;
  mismatch.getPosition = async () => ({
    positionAmt: 0.2,
    entryPrice: 50_000,
    unrealizedProfit: 0,
  });
  let mismatchPosts = 0;
  mismatch.signedPost = async () => {
    mismatchPosts += 1;
    return { orderId: 2 };
  };
  const mismatchResult = await mismatch.closePartialPosition(2, "BTCUSDT", 0.4);
  assert(mismatchResult.ok === false, "partial close must reject quantity larger than live position");
  assert(mismatchPosts === 0, "quantity mismatch must never reach order_send");

  // Partial close must fail closed when post-fill position verification disappears.
  const noPostVerify = new BinanceExecutor(config()) as any;
  let verifyCalls = 0;
  noPostVerify.getPosition = async () => {
    verifyCalls += 1;
    if (verifyCalls === 1) {
      return { positionAmt: 1.0, entryPrice: 50_000, unrealizedProfit: 0 };
    }
    return null;
  };
  noPostVerify.signedPost = async () => ({ orderId: 3 });
  noPostVerify.getFuturesOrderNetPnl = async () => ({ profit: 5, currency: "USDT" });
  const noPostVerifyResult = await noPostVerify.closePartialPosition(3, "BTCUSDT", 0.4);
  assert(noPostVerifyResult.ok === false, "partial close must fail when post-fill position verification is unavailable");

  // Partial close must fail closed when the broker leaves more volume than expected.
  const remainingMismatch = new BinanceExecutor(config()) as any;
  let remainingCalls = 0;
  remainingMismatch.getPosition = async () => {
    remainingCalls += 1;
    if (remainingCalls === 1) {
      return { positionAmt: 1.0, entryPrice: 50_000, unrealizedProfit: 0 };
    }
    return { positionAmt: 0.9, entryPrice: 50_000, unrealizedProfit: 0 };
  };
  remainingMismatch.signedPost = async () => ({ orderId: 4 });
  remainingMismatch.getFuturesOrderNetPnl = async () => ({ profit: 5, currency: "USDT" });
  const remainingMismatchResult = await remainingMismatch.closePartialPosition(4, "BTCUSDT", 0.4);
  assert(remainingMismatchResult.ok === false, "partial close must fail when live remaining volume disagrees with expected remaining volume");

  // Full close must fail when the position survives the close order.
  const stillOpen = new BinanceExecutor(config()) as any;
  let fullCalls = 0;
  stillOpen.getPosition = async () => {
    fullCalls += 1;
    if (fullCalls === 1) {
      return { positionAmt: 1.0, entryPrice: 50_000, unrealizedProfit: 0 };
    }
    return { positionAmt: 0.2, entryPrice: 50_000, unrealizedProfit: 0 };
  };
  let fullPosts = 0;
  stillOpen.signedPost = async () => {
    fullPosts += 1;
    return { orderId: 5 };
  };
  stillOpen.getFuturesOrderNetPnl = async () => ({ profit: 7, currency: "USDT" });
  const stillOpenResult = await stillOpen.closePosition(5, "BTCUSDT", 1, "BUY");
  assert(stillOpenResult.ok === false, "full close must fail when broker position remains after execution");
  assert(fullPosts === 1, "full close should issue one broker request before detecting post-fill residue");

  // Full close succeeds only when the broker is flat and PnL is authoritative.
  const success = new BinanceExecutor(config()) as any;
  let successCalls = 0;
  success.getPosition = async () => {
    successCalls += 1;
    if (successCalls === 1) {
      return { positionAmt: 1.0, entryPrice: 50_000, unrealizedProfit: 0 };
    }
    return { positionAmt: 0, entryPrice: 0, unrealizedProfit: 0 };
  };
  success.signedPost = async () => ({ orderId: 6 });
  success.getFuturesOrderNetPnl = async () => ({ profit: 9, currency: "USDT" });
  const successResult = await success.closePosition(6, "BTCUSDT", undefined, "BUY");
  assert(successResult.ok === true, "full close must succeed only after verified flat position");
  assert(successResult.realizedProfit === 9, "full close must return authoritative realized PnL");

  console.log("Result: 6 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
