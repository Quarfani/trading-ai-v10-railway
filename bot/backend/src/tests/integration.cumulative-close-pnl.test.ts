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

  const staleDb = new DatabaseManager(":memory:");
  await staleDb.initialize();
  const staleGateway = new ExecutionGateway(config(), staleDb);
  const staleTradeId = staleDb.insertTrade({
    ticket: 8002, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 0.01,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(),
    source: "STALE_MEMORY_PNL", realizedProfit: 300,
  } as any);
  (staleGateway as any).binance.closePosition = async () => ({
    ok: true,
    realizedProfit: 100,
    realizedProfitCurrency: "USDT",
  });
  const staleObject = {
    id: staleTradeId,
    ticket: 8002,
    symbol: "BTCUSDT",
    timeframe: "H1",
    side: "BUY",
    volume: 0.01,
    entry: 50_000,
    sl: 49_000,
    tp: 52_000,
    status: "open",
    openedAt: Date.now(),
    source: "STALE_MEMORY_PNL",
    realizedProfit: 0,
  } as any;
  assert(
    await staleGateway.closeTrade(staleObject) === true,
    "stale in-memory trade close must succeed",
  );
  const staleRow = staleDb.raw().prepare(
    "SELECT status, profit FROM trades WHERE id=?",
  ).get(staleTradeId) as any;
  assert(staleRow.profit === 400, "final Binance PnL must come from persisted partial PnL, not stale memory");
  staleDb.raw().close();

  const rollbackDb = new DatabaseManager(":memory:");
  await rollbackDb.initialize();
  const rollbackGateway = new ExecutionGateway(config(), rollbackDb);
  const rollbackTradeId = rollbackDb.insertTrade({
    ticket: 8003, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 0.01,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(),
    source: "GATEWAY_ATOMIC_ROLLBACK",
  } as any);
  rollbackDb.raw().prepare(
    "CREATE TRIGGER fail_gateway_close_ledger BEFORE UPDATE OF status ON execution_ledger " +
    "WHEN NEW.status='EXECUTED' BEGIN SELECT RAISE(ABORT, 'forced gateway ledger failure'); END",
  ).run();
  (rollbackGateway as any).binance.closePosition = async () => ({
    ok: true,
    realizedProfit: 100,
    realizedProfitCurrency: "USDT",
  });
  const rollbackObject = {
    id: rollbackTradeId,
    ticket: 8003,
    symbol: "BTCUSDT",
    timeframe: "H1",
    side: "BUY",
    volume: 0.01,
    entry: 50_000,
    sl: 49_000,
    tp: 52_000,
    status: "open",
    openedAt: Date.now(),
    source: "GATEWAY_ATOMIC_ROLLBACK",
  } as any;
  const rollbackResult = await rollbackGateway.closeTrade(rollbackObject);
  assert(rollbackResult === false, "gateway close must fail when atomic ledger settlement fails");
  const rollbackTrade = rollbackDb.raw().prepare(
    "SELECT status, profit FROM trades WHERE id=?",
  ).get(rollbackTradeId) as any;
  const rollbackLedger = rollbackDb.getLatestUnresolvedExecutionForTrade(
    rollbackTradeId,
    ["CLOSE"],
  );
  assert(rollbackTrade.status === "open", "gateway atomic failure must roll back trade close");
  assert(rollbackLedger?.status === "UNKNOWN", "gateway atomic failure must preserve UNKNOWN ledger state");
  rollbackDb.raw().close();

  db.raw().close();
  console.log("Result: 3 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
