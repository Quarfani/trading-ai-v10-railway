import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseManager } from "../database/DatabaseManager";
import { ExecutionGateway } from "../execution/ExecutionGateway";
import { SystemConfig, Signal } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(dbPath: string): SystemConfig {
  return {
    mode: "paper", dataSource: "binance", accountCurrency: "EUR",
    accountBalance: 10_000, accountName: "paper-soak", riskPerTrade: 0.01,
    maxOpenTrades: 5, minConfidence: 0.55, maxDailyLoss: 0.02,
    dailyProfitTarget: 0.03, consecutiveLossLimit: 3, cooldownMinutes: 60, mlRequired: false,
    symbols: ["EURUSD"], timeframes: ["H1"], scanInterval: 60_000, dbPath,
    mt5: { login: 0, password: "", server: "", bridgeUrl: "", bridgeApiKey: "" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

function makeSignal(i: number): Signal {
  const entry = 1.1000 + (i % 10) * 0.0001;
  return {
    symbol: "EURUSD", side: i % 2 === 0 ? "BUY" : "SELL", price: entry,
    confidence: 0.80, sl: i % 2 === 0 ? entry - 0.005 : entry + 0.005,
    tp: i % 2 === 0 ? entry + 0.010 : entry - 0.010,
    source: "PAPER_SOAK", reason: "gateway-soak",
    timestamp: Date.now() - 10_000 + i, timeframe: "H1",
  };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trading-ai-paper-soak-"));
  const dbPath = path.join(dir, "trading.db");
  const cfg = config(dbPath);
  const rates = { getRate: async () => 0.95 } as any;
  const db = new DatabaseManager(dbPath);
  await db.initialize();
  let dbClosed = false;

  try {
    const gateway = new ExecutionGateway(cfg, db, rates);
    await gateway.initialize();

    for (let i = 0; i < 100; i++) {
      const opened = await gateway.execute(makeSignal(i), 0.01, "H1");
      assert(opened.success && opened.trade, `open ${i} must succeed`);
      const exit = opened.trade.side === "BUY"
        ? opened.trade.entry + 0.001
        : opened.trade.entry - 0.001;
      const closed = await gateway.closeAtMarket(opened.trade, exit, "MANUAL");
      assert(closed.ok && Number.isFinite(Number(closed.profit)), `close ${i} must succeed with finite PnL`);
    }

    const trades = db.getRecentTrades(200);
    const ledgers = db.raw().prepare("SELECT action, status FROM execution_ledger ORDER BY createdAt").all() as any[];
    assert(trades.length === 100, "soak must persist exactly 100 trades");
    assert(ledgers.length === 200, "100 opens + 100 closes must produce 200 execution ledger rows");
    assert(ledgers.every(row => row.status === "EXECUTED"), "all paper lifecycle ledger rows must be EXECUTED");
    assert(gateway.getPaperStats()?.trades === 100, "paper stats must match closed trade count");

    const balanceBeforeRestart = gateway.getPaperStats()!.balance;
    db.raw().close();
    dbClosed = true;

    const dbRestarted = new DatabaseManager(dbPath);
    await dbRestarted.initialize();
    const gatewayRestarted = new ExecutionGateway(cfg, dbRestarted, rates);
    await gatewayRestarted.initialize();
    const statsAfterRestart = gatewayRestarted.getPaperStats()!;
    assert(statsAfterRestart.trades === 100, "restart must restore all closed trades");
    assert(Math.abs(statsAfterRestart.balance - balanceBeforeRestart) <= 1e-8, "restart must preserve paper balance");
    dbRestarted.raw().close();

    console.log("Result: 8 passed, 0 failed");
  } finally {
    if (!dbClosed) {
      try { db.raw().close(); } catch { /* already closed */ }
    }
    if (fs.existsSync(dbPath)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
