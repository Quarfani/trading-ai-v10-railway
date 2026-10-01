import axios from "axios";
import { DatabaseManager } from "../database/DatabaseManager";
import { ExecutionGateway } from "../execution/ExecutionGateway";
import { SystemConfig, Signal } from "../types/trading.types";
import { clearBrokerContracts, registerBrokerContract } from "../market/MarketCatalog";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function baseConfig(mode: "paper" | "mt5"): SystemConfig {
  return {
    mode, dataSource: mode === "mt5" ? "mt5" : "binance",
    accountCurrency: "USD", accountBalance: 10_000, accountName: "ledger-test",
    riskPerTrade: 0.01, maxOpenTrades: 5, minConfidence: 0.55, maxDailyLoss: 0.02,
    dailyProfitTarget: 0.03, consecutiveLossLimit: 3, cooldownMinutes: 60, mlRequired: false,
    symbols: ["BTCUSDT"], timeframes: ["H1"], scanInterval: 60_000, dbPath: ":memory:",
    mt5: { login: 1, password: "x", server: "x", bridgeUrl: "http://mt5.test", bridgeApiKey: "secret" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

function signal(ts: number): Signal {
  return {
    symbol: "BTCUSDT", side: "BUY", price: 100, confidence: 0.8,
    sl: 90, tp: 120, source: "LEDGER_TEST", reason: "idempotency",
    timestamp: ts, timeframe: "H1",
  };
}

async function main() {
  clearBrokerContracts();
  const db = new DatabaseManager(":memory:");
  await db.initialize();

  // Successful paper replay must return the exact persisted execution result
  // without creating a second trade/ledger row.
  const paper = new ExecutionGateway(baseConfig("paper"), db);
  const first = await paper.execute(signal(1_800_000_000_001), 0.01, "H1");
  assert(first.success && first.trade, "first paper execution must succeed");
  const second = await paper.execute(signal(1_800_000_000_001), 0.01, "H1");
  assert(second.success && second.trade, "executed operation must be replayable");
  assert(second.trade.ticket === first.trade.ticket, "replay must return the same ticket");
  assert(db.getRecentTrades(20).length === 1, "replay must not create a duplicate trade");

  // Live MT5 failures become UNKNOWN. A repeated call with the same key must
  // be blocked instead of sending the order a second time.
  registerBrokerContract({
    symbol: "EURUSD.a", baseAsset: "EUR", quoteCurrency: "USD", assetClass: "FOREX",
    contractType: "CFD", venue: "MT5", contractSize: 100000, priceIncrement: 0.00001,
    minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, marginModel: "BROKER_DEFINED",
    source: "ledger-test", observedAt: Date.now(), verified: true,
  });
  const mt5 = new ExecutionGateway({ ...baseConfig("mt5"), symbols: ["EURUSD.a"] }, db);
  const originalPost = (axios as any).post;
  let postCalls = 0;
  (axios as any).post = async () => { postCalls += 1; throw new Error("simulated transport failure"); };

  try {
    const liveSignal = { ...signal(1_800_000_000_002), symbol: "EURUSD.a" };
    const failed = await mt5.execute(liveSignal, 0.01, "H1");
    assert(!failed.success, "simulated MT5 failure must fail execution");
    assert(postCalls === 1, "first UNKNOWN operation must send exactly once");

    const replay = await mt5.execute(liveSignal, 0.01, "H1");
    assert(!replay.success, "UNKNOWN replay must remain blocked");
    assert(postCalls === 1, "UNKNOWN replay must never resend to broker");
    assert(String(replay.error).includes("automatic retry is forbidden"), "UNKNOWN replay must explain the safety block");
    const ledgers = db.raw().prepare("SELECT status, retryCount FROM execution_ledger WHERE symbol=?").all("EURUSD.a") as any[];
    assert(ledgers.length === 1 && ledgers[0].status === "UNKNOWN" && ledgers[0].retryCount === 0, "UNKNOWN state must remain durable");
  } finally {
    (axios as any).post = originalPost;
    clearBrokerContracts();
  }

  console.log("Result: 9 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
