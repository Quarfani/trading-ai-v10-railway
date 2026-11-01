import { DatabaseManager } from "../database/DatabaseManager";
import { ExecutionGateway } from "../execution/ExecutionGateway";
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
    accountName: "cumulative-pnl-test",
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
    mt5: { login: 1, password: "x", server: "srv", bridgeUrl: "http://mt5.test", bridgeApiKey: "secret" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

async function main() {
  const db = new DatabaseManager(":memory:");
  await db.initialize();
  const cfg = config();
  const gateway = new ExecutionGateway(cfg, db);

  const tradeId = db.insertTrade({
    ticket: 8001,
    symbol: "BTCUSDT",
    timeframe: "H1",
    side: "BUY",
    volume: 0.01,
    entry: 50_000,
    sl: 49_000,
    tp: 52_000,
    status: "open",
    openedAt: Date.now(),
    source: "CUMULATIVE_PNL_TEST",
    realizedProfit: 300,
  } as any);
  db.createExecutionLedger({
    executionId: "cumulative-open-execution",
    operationKey: "cumulative-open-operation",
    action: "OPEN",
    status: "PENDING",
    symbol: "BTCUSDT",
    side: "BUY",
    volume: 0.01,
    request: { tradeId },
  });
  db.updateExecutionLedger("cumulative-open-execution", {
    status: "EXECUTED",
    result: { ticket: 8001 },
  });

  (gateway as any).binance.closePosition = async () => ({
    ok: true,
    realizedProfit: 100,
    realizedProfitCurrency: "USDT",
  });

  const result = await gateway.closeTrade({
    id: tradeId,
    ticket: 8001,
    symbol: "BTCUSDT",
    timeframe: "H1",
    side: "BUY",
    volume: 0.01,
    entry: 50_000,
    sl: 49_000,
    tp: 52_000,
    status: "open",
    openedAt: Date.now(),
    source: "CUMULATIVE_PNL_TEST",
    realizedProfit: 300,
  } as any);

  assert(result === true, "Binance final close must succeed");
  const trade = db.raw().prepare(
    "SELECT status, profit FROM trades WHERE id=?",
  ).get(tradeId) as any;
  const stats = db.raw().prepare(
    "SELECT trades, pnl FROM daily_stats WHERE day=?",
  ).get(new Date().toISOString().slice(0, 10)) as any;

  assert(trade.status === "closed", "Binance final close must close the internal trade");
  assert(trade.profit === 400, "final Binance profit must include prior realized partial PnL");
  assert(stats.trades === 1 && stats.pnl === 400, "daily stats must record cumulative Binance realized PnL exactly once");

  db.raw().close();
  console.log("Result: 1 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
