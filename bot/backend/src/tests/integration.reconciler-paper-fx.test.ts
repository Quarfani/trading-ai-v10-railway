import { DatabaseManager } from "../database/DatabaseManager";
import { ExecutionGateway } from "../execution/ExecutionGateway";
import { Reconciler } from "../core/Reconciler";
import { PerformanceTracker } from "../analytics/PerformanceTracker";
import { PaperTrader } from "../integration/PaperTrader";
import { SystemConfig, Trade } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = new DatabaseManager(":memory:");
  await db.initialize();
  const config = {
    mode: "paper", dataSource: "binance", accountCurrency: "EUR",
    accountBalance: 10_000, accountName: "recon-paper-fx", riskPerTrade: 0.01,
    maxOpenTrades: 5, minConfidence: 0.55, maxDailyLoss: 0.02,
    dailyProfitTarget: 0.03, consecutiveLossLimit: 3, cooldownMinutes: 60, mlRequired: false,
    symbols: ["EURUSD"], timeframes: ["H1"], scanInterval: 60_000, dbPath: ":memory:",
    mt5: { login: 0, password: "", server: "", bridgeUrl: "", bridgeApiKey: "" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;

  const openedAt = Date.now();
  db.insertTrade({
    ticket: 77, symbol: "EURUSD", timeframe: "H1", side: "BUY", volume: 0.01,
    entry: 1.1000, sl: 1.0900, tp: 1.1200, status: "open", openedAt, source: "TEST",
    entryQuoteToAccount: 0.90,
  });

  const rates = { getRate: async () => 0.95 } as any;
  const exec = new ExecutionGateway(config, db, rates);
  await exec.initialize();

  const tracker = new PerformanceTracker(db, config);
  const telegram = { sendMessage: async () => {} } as any;
  const scanner = { fetchCandles: async () => [] } as any;
  const emergency = { activate: async () => {} } as any;
  const callbacks: Trade[] = [];
  const reconciler = new Reconciler(
    config, db, exec, telegram, tracker, scanner, emergency,
    (trade) => callbacks.push(trade as Trade),
  );

  const open = db.getOpenTrades()[0];
  assert(Boolean(open), "open paper trade must exist");
  await (reconciler as any).closeAndRecord(open, 1.1100, "TP");

  const closed = db.getRecentTrades(1)[0] as any;
  assert(closed.status === "closed", "reconciler must close the paper trade");
  assert(Number(closed.exitQuoteToAccount) === 0.95, "reconciler must persist exit FX rate");
  assert(callbacks.length === 1, "reconciler must emit one close callback");
  assert(callbacks[0].profit === closed.profit, "callback PnL must match persisted PnL");

  const replayCount = db.raw()
    .prepare("SELECT COUNT(*) c FROM execution_ledger WHERE action='CLOSE_AT_MARKET' AND symbol='EURUSD'")
    .get() as any;
  assert(replayCount.c === 1, "paper reconciliation close must create one authoritative execution record");

  // A non-authoritative close result must be rejected instead of inferring PnL from price delta.
  const db2 = new DatabaseManager(":memory:");
  await db2.initialize();
  const exec2 = { closeAtMarket: async () => ({ ok: false }) } as any;
  const tracker2 = { recordClose: () => {} } as any;
  const reconciler2 = new Reconciler(config, db2, exec2, telegram, tracker2, scanner, emergency, () => {});
  let blocked = false;
  try {
    await (reconciler2 as any).closeAndRecord({ id: 88, ticket: 88, symbol: "EURUSD", side: "BUY", volume: 0.01, entry: 1.1, sl: 1.09, tp: 1.12, status: "open", openedAt, source: "TEST" }, 1.11, "TP");
  } catch {
    blocked = true;
  }
  assert(blocked, "reconciler must fail closed when authoritative paper PnL is unavailable");

  console.log("Result: 6 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
