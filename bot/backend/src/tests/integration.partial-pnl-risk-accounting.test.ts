import { DatabaseManager } from "../database/DatabaseManager";
import { DailyProfitTarget } from "../risk/DailyProfitTarget";
import { TelegramBot } from "../notifications/TelegramBot";
import { SystemConfig } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(mode: "paper" | "mt5", target = 0.05): SystemConfig {
  return {
    mode,
    dataSource: mode === "mt5" ? "mt5" : "binance",
    accountBalance: 10_000,
    accountCurrency: "USD",
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
  const paperTarget = new DailyProfitTarget(
    config("paper"),
    paperDb,
    new TelegramBot(config("paper")),
  );

  const openId = paperDb.insertTrade({
    ticket: 7001,
    symbol: "EURUSD",
    timeframe: "H1",
    side: "BUY",
    volume: 0.1,
    entry: 1.1,
    sl: 1.09,
    tp: 1.12,
    status: "open",
    openedAt: Date.now(),
    source: "PARTIAL_PNL_TEST",
  } as any);
  paperDb.createExecutionLedger({
    executionId: "partial-open-1",
    operationKey: "partial-open-op",
    action: "PARTIAL_CLOSE",
    status: "EXECUTED",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.4,
    request: { tradeId: openId, volume: 0.4 },
  });
  paperDb.updateExecutionLedger("partial-open-1", {
    result: { remainingVolume: 0.6, profit: 300 },
    status: "EXECUTED",
  });

  assert(
    paperTarget.reached() === true,
    "open-trade partial realized PnL must count toward the daily target",
  );

  const closedDb = new DatabaseManager(":memory:");
  await closedDb.initialize();
  const closedTarget = new DailyProfitTarget(
    config("paper", 0.05),
    closedDb,
    new TelegramBot(config("paper")),
  );
  const closedId = closedDb.insertTrade({
    ticket: 7002,
    symbol: "EURUSD",
    timeframe: "H1",
    side: "BUY",
    volume: 0.1,
    entry: 1.1,
    sl: 1.09,
    tp: 1.12,
    status: "open",
    openedAt: Date.now(),
    source: "PARTIAL_PNL_CLOSED_TEST",
  } as any);
  closedDb.updateTradeClose(closedId, 400, Date.now(), "MANUAL");
  closedDb.createExecutionLedger({
    executionId: "partial-closed-1",
    operationKey: "partial-closed-op",
    action: "PARTIAL_CLOSE",
    status: "EXECUTED",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.04,
    request: { tradeId: closedId, volume: 0.04 },
  });
  closedDb.updateExecutionLedger("partial-closed-1", {
    result: { remainingVolume: 0.06, profit: 300 },
    status: "EXECUTED",
  });

  assert(
    closedTarget.reached() === false,
    "partial PnL attached to a closed trade must not be double-counted over final trade profit",
  );

  const liveDb = new DatabaseManager(":memory:");
  await liveDb.initialize();
  const liveCfg = config("mt5", 0.05);
  const liveTarget = new DailyProfitTarget(
    liveCfg,
    liveDb,
    new TelegramBot(liveCfg),
  );
  assert(liveTarget.reached(10_000) === false, "live target anchor should initialize at current equity");
  assert(liveTarget.reached(10_600) === true, "live daily target must use the persisted daily equity anchor");

  paperDb.raw().close();
  closedDb.raw().close();
  liveDb.raw().close();

  console.log("Result: 3 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
