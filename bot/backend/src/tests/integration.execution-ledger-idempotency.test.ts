import { BinanceExecutor, makeBinanceClientOrderId } from "../execution/BinanceExecutor";
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
    accountName: "binance-safety-test",
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
  const full = new BinanceExecutor(config()) as any;
  const fullPosts: any[] = [];
  let fullPositionReads = 0;
  full.getPosition = async () => {
    fullPositionReads += 1;
    if (fullPositionReads === 1) {
      return { positionAmt: 1, entryPrice: 50_000, unrealizedProfit: 0 };
    }
    return { positionAmt: 0, entryPrice: 0, unrealizedProfit: 0 };
  };
  full.signedPost = async (_path: string, params: any) => {
    fullPosts.push(params);
    return { orderId: 101 };
  };
  full.getFuturesOrderNetPnl = async () => ({ profit: 9, currency: "USDT" });

  const fullId = makeBinanceClientOrderId("full-close-safety");
  const fullResult = await full.closePosition(101, "BTCUSDT", undefined, "BUY", fullId);
  assert(fullResult.ok === true, "verified full close must succeed");
  assert(fullResult.realizedProfit === 9, "verified full close must return broker PnL");
  assert(fullPosts[0]?.newClientOrderId === fullId, "full close must preserve deterministic client identity");
  assert(fullPositionReads === 2, "full close must perform pre- and post-fill position verification");

  const noPosition = new BinanceExecutor(config()) as any;
  noPosition.getPosition = async () => ({ positionAmt: 0, entryPrice: 0, unrealizedProfit: 0 });
  let noPositionPosts = 0;
  noPosition.signedPost = async () => {
    noPositionPosts += 1;
    return { orderId: 102 };
  };
  const noPositionResult = await noPosition.closePosition(102, "BTCUSDT", 1, "BUY", makeBinanceClientOrderId("no-position"));
  assert(noPositionResult.ok === false, "full close must fail closed when no broker position exists");
  assert(noPositionPosts === 0, "no-position full close must not submit an order");

  const partial = new BinanceExecutor(config()) as any;
  const partialPosts: any[] = [];
  let partialReads = 0;
  partial.getPosition = async () => {
    partialReads += 1;
    if (partialReads === 1) {
      return { positionAmt: 1, entryPrice: 50_000, unrealizedProfit: 0 };
    }
    return { positionAmt: 0.6, entryPrice: 50_000, unrealizedProfit: 0 };
  };
  partial.signedPost = async (_path: string, params: any) => {
    partialPosts.push(params);
    return { orderId: 103 };
  };
  partial.getFuturesOrderNetPnl = async () => ({ profit: 3, currency: "USDT" });

  const partialId = makeBinanceClientOrderId("partial-close-safety");
  const partialResult = await partial.closePartialPosition(103, "BTCUSDT", 0.4, partialId);
  assert(partialResult.ok === true, "verified partial close must succeed");
  assert(partialResult.remainingVolume === 0.6, "partial close must return verified remaining volume");
  assert(partialPosts[0]?.newClientOrderId === partialId, "partial close must preserve deterministic client identity");

  const partialMismatch = new BinanceExecutor(config()) as any;
  partialMismatch.getPosition = async () => ({ positionAmt: 0.2, entryPrice: 50_000, unrealizedProfit: 0 });
  let partialMismatchPosts = 0;
  partialMismatch.signedPost = async () => {
    partialMismatchPosts += 1;
    return { orderId: 104 };
  };
  const partialMismatchResult = await partialMismatch.closePartialPosition(104, "BTCUSDT", 0.4, makeBinanceClientOrderId("partial-mismatch"));
  assert(partialMismatchResult.ok === false, "partial close must reject an oversized request");
  assert(partialMismatchPosts === 0, "oversized partial request must not reach the broker");

  const partialNoVerify = new BinanceExecutor(config()) as any;
  let partialNoVerifyReads = 0;
  partialNoVerify.getPosition = async () => {
    partialNoVerifyReads += 1;
    if (partialNoVerifyReads === 1) {
      return { positionAmt: 1, entryPrice: 50_000, unrealizedProfit: 0 };
    }
    return null;
  };
  partialNoVerify.signedPost = async () => ({ orderId: 105 });
  partialNoVerify.getFuturesOrderNetPnl = async () => ({ profit: 3, currency: "USDT" });
  const partialNoVerifyResult = await partialNoVerify.closePartialPosition(105, "BTCUSDT", 0.4, makeBinanceClientOrderId("partial-no-verify"));
  assert(partialNoVerifyResult.ok === false, "partial close must fail when post-fill verification disappears");

  const emergency = new BinanceExecutor(config()) as any;
  const emergencyPosts: any[] = [];
  emergency.signedPost = async (_path: string, params: any) => {
    emergencyPosts.push(params);
    return { status: "FILLED", executedQty: "0.01", orderId: 106 };
  };
  const emergencyId = makeBinanceClientOrderId("open-op:EMERGENCY_CLOSE");
  await emergency.emergencyCloseAfterProtectionFailure(
    { symbol: "BTCUSDT", side: "BUY" },
    0.01,
    emergencyId,
  );
  assert(emergencyPosts[0]?.newClientOrderId === emergencyId, "emergency close must carry deterministic identity");

  const malformed = new BinanceExecutor(config()) as any;
  malformed.signedGet = async () => ([
    { symbol: "BTCUSDT", positionAmt: "NaN", entryPrice: "50000", unRealizedProfit: "0" },
  ]);
  let malformedBlocked = false;
  try {
    await malformed.getAllPositions();
  } catch {
    malformedBlocked = true;
  }
  assert(malformedBlocked, "malformed Binance position metadata must fail closed instead of being filtered");

  console.log("Result: 7 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
