import { DatabaseManager } from "../database/DatabaseManager";
import { DailyProfitTarget } from "../risk/DailyProfitTarget";
import { TelegramBot } from "../notifications/TelegramBot";
import { ExecutionGateway } from "../execution/ExecutionGateway";
import { SystemConfig } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(mode: "paper" | "mt5" | "binance", target = 0.05, accountCurrency = "USD"): SystemConfig {
  return {
    mode,
    dataSource: mode === "mt5" ? "mt5" : "binance",
    accountBalance: 10_000,
    accountCurrency,
    accountName: "partial-pnl-test",
    riskPerTrade: 0.01,
    maxOpenTrades: 5,
    minConfidence: 0.55,
    maxDailyLoss: 0.02,
    dailyProfitTarget: target,
    consecutiveLossLimit: 3,
    cooldownMinutes: 60,
    mlRequired: false,
    symbols: ["EURUSD"],
    timeframes: ["H1"],
    scanInterval: 60_000,
    dbPath: ":memory:",
    mt5: { login: 1, password: "x", server: "srv", bridgeUrl: "http://mt5.test", bridgeApiKey: "secret" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

async function main() {
  const paperDb = new DatabaseManager(":memory:");
  await paperDb.initialize();
  const paperCfg = config("paper");
  const paperTarget = new DailyProfitTarget(paperCfg, paperDb, new TelegramBot(paperCfg));

  const openId = paperDb.insertTrade({
    ticket: 7001, symbol: "EURUSD", timeframe: "H1", side: "BUY", volume: 0.1,
    entry: 1.1, sl: 1.09, tp: 1.12, status: "open", openedAt: Date.now(), source: "PARTIAL_PNL_TEST",
  } as any);
  paperDb.createExecutionLedger({
    executionId: "partial-open-1", operationKey: "partial-open-op", action: "PARTIAL_CLOSE",
    status: "EXECUTED", symbol: "EURUSD", side: "BUY", volume: 0.4,
    request: { tradeId: openId, volume: 0.4 },
  });
  paperDb.updateExecutionLedger("partial-open-1", {
    result: { remainingVolume: 0.6, profit: 300 }, status: "EXECUTED",
  });
  assert(paperTarget.reached() === true, "open-trade partial realized PnL must count toward the daily target");

  const closedDb = new DatabaseManager(":memory:");
  await closedDb.initialize();
  const closedCfg = config("paper", 0.05);
  const closedTarget = new DailyProfitTarget(closedCfg, closedDb, new TelegramBot(closedCfg));
  const closedId = closedDb.insertTrade({
    ticket: 7002, symbol: "EURUSD", timeframe: "H1", side: "BUY", volume: 0.1,
    entry: 1.1, sl: 1.09, tp: 1.12, status: "open", openedAt: Date.now(), source: "PARTIAL_PNL_CLOSED_TEST",
  } as any);
  closedDb.updateTradeClose(closedId, 400, Date.now(), "MANUAL");
  closedDb.createExecutionLedger({
    executionId: "partial-closed-1", operationKey: "partial-closed-op", action: "PARTIAL_CLOSE",
    status: "EXECUTED", symbol: "EURUSD", side: "BUY", volume: 0.04,
    request: { tradeId: closedId, volume: 0.04 },
  });
  closedDb.updateExecutionLedger("partial-closed-1", {
    result: { remainingVolume: 0.06, profit: 300 }, status: "EXECUTED",
  });
  assert(
    closedTarget.reached() === false,
    "partial PnL attached to a closed trade must not be double-counted",
  );

  const liveDb = new DatabaseManager(":memory:");
  await liveDb.initialize();
  const liveCfg = config("mt5", 0.05);
  const liveTarget = new DailyProfitTarget(liveCfg, liveDb, new TelegramBot(liveCfg));
  const liveTradeId = liveDb.insertTrade({
    ticket: 7005, symbol: "EURUSD", timeframe: "H1", side: "BUY", volume: 0.1,
    entry: 1.1, sl: 1.09, tp: 1.12, status: "open", openedAt: Date.now(), source: "LIVE_PARTIAL_TARGET",
  } as any);
  liveDb.createExecutionLedger({
    executionId: "live-partial-1", operationKey: "live-partial-op", action: "PARTIAL_CLOSE",
    status: "EXECUTED", symbol: "EURUSD", side: "BUY", volume: 0.04,
    request: { tradeId: liveTradeId, volume: 0.04 },
  });
  liveDb.updateExecutionLedger("live-partial-1", {
    result: { remainingVolume: 0.06, profit: 600 }, status: "EXECUTED",
  });
  assert(liveTarget.reached() === true, "live daily target must include realized partial PnL");

  const binanceDb = new DatabaseManager(":memory:");
  await binanceDb.initialize();
  const binanceCfg = config("binance", 0.20, "EUR");
  const binanceGateway = new ExecutionGateway(
    binanceCfg,
    binanceDb,
    { getRate: async (currency: string) => currency === "USDT" ? 0.92 : null } as any,
  );
  const binanceTradeId = binanceDb.insertTrade({
    ticket: 7003, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 0.01,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(), source: "BINANCE_PARTIAL_PNL",
  } as any);
  (binanceGateway as any).binance.closePartialPosition = async () => ({
    ok: true, remainingVolume: 0.006, realizedProfit: 10, realizedProfitCurrency: "USDT",
  });
  const converted = await binanceGateway.closePartial(
    { id: binanceTradeId, ticket: 7003, symbol: "BTCUSDT", timeframe: "H1", side: "BUY",
      volume: 0.01, entry: 50_000, sl: 49_000, tp: 52_000, status: "open",
      openedAt: Date.now(), source: "BINANCE_PARTIAL_PNL" } as any,
    0.004, 51_000, "PARTIAL",
  );
  assert(converted.ok === true, "Binance partial close must succeed with a valid FX conversion");
  assert(Math.abs(converted.profit - 9.2) < 1e-9, "Binance partial PnL must be converted into account currency");

  const badDb = new DatabaseManager(":memory:");
  await badDb.initialize();
  const badCfg = config("binance", 0.20, "EUR");
  const badGateway = new ExecutionGateway(badCfg, badDb, { getRate: async () => null } as any);
  const badTradeId = badDb.insertTrade({
    ticket: 7004, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 0.01,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(), source: "BINANCE_PARTIAL_PNL_BAD_FX",
  } as any);
  (badGateway as any).binance.closePartialPosition = async () => ({
    ok: true, remainingVolume: 0.006, realizedProfit: 10, realizedProfitCurrency: "USDT",
  });
  const rejected = await badGateway.closePartial(
    { id: badTradeId, ticket: 7004, symbol: "BTCUSDT", timeframe: "H1", side: "BUY",
      volume: 0.01, entry: 50_000, sl: 49_000, tp: 52_000, status: "open",
      openedAt: Date.now(), source: "BINANCE_PARTIAL_PNL_BAD_FX" } as any,
    0.004, 51_000, "PARTIAL",
  );
  assert(rejected.ok === false, "missing FX conversion must fail closed for Binance partial PnL");

  paperDb.raw().close();
  closedDb.raw().close();
  liveDb.raw().close();
  binanceDb.raw().close();
  badDb.raw().close();

  console.log("Result: 5 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
