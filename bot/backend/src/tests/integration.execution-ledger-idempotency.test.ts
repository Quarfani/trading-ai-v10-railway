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
    accountCurrency: "EUR", accountBalance: 10_000, accountName: "ledger-test",
    riskPerTrade: 0.01, maxOpenTrades: 5, minConfidence: 0.55, maxDailyLoss: 0.02,
    dailyProfitTarget: 0.03, consecutiveLossLimit: 3, cooldownMinutes: 60, mlRequired: false,
    symbols: ["EURUSD"], timeframes: ["H1"], scanInterval: 60_000, dbPath: ":memory:",
    mt5: { login: 1, password: "x", server: "x", bridgeUrl: "http://mt5.test", bridgeApiKey: "secret" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

function signal(ts: number, symbol = "EURUSD"): Signal {
  return {
    symbol, side: "BUY", price: 1.1000, confidence: 0.8,
    sl: 1.0900, tp: 1.1200, source: "LEDGER_TEST", reason: "idempotency",
    timestamp: ts, timeframe: "H1",
  };
}

async function main() {
  clearBrokerContracts();
  const db = new DatabaseManager(":memory:");
  await db.initialize();

  // Successful paper replay must return the exact persisted execution result
  // without creating a second trade/ledger row.
  let rateCalls = 0;
  const paperRates = {
    getRate: async () => (++rateCalls === 1 ? 0.90 : 0.95),
  } as any;
  const paper = new ExecutionGateway(baseConfig("paper"), db, paperRates);
  const first = await paper.execute(signal(1_800_000_000_001), 0.01, "H1");
  assert(first.success && first.trade, "first paper execution must succeed");
  assert(first.trade.entryQuoteToAccount === 0.90, "paper execution must persist entry FX rate");
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
    const liveSignal = signal(1_800_000_000_002, "EURUSD.a");
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

  const partialDb = new DatabaseManager(":memory:");
  await partialDb.initialize();
  registerBrokerContract({
    symbol: "EURUSD.a", baseAsset: "EUR", quoteCurrency: "USD", assetClass: "FOREX",
    contractType: "CFD", venue: "MT5", contractSize: 100000, priceIncrement: 0.00001,
    minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, marginModel: "BROKER_DEFINED",
    source: "mt5-partial-volume-test", observedAt: Date.now(), verified: true,
  });
  const partialGateway = new ExecutionGateway(
    { ...baseConfig("mt5"), symbols: ["EURUSD.a"] },
    partialDb,
  );
  const originalPostPartial = (axios as any).post;
  (axios as any).post = async () => ({
    data: {
      ticket: 77,
      price: 1.10002,
      volume: 0.06,
    },
  });
  try {
    const partial = await partialGateway.execute(
      signal(1_800_000_000_003, "EURUSD.a"),
      0.10,
      "H1",
    );
    assert(partial.success && partial.trade, "MT5 partial fill fixture must execute");
    assert(partial.trade.volume === 0.06, "MT5 gateway must persist broker-confirmed executed volume");
    const stored = partialDb.getOpenTrades()[0];
    assert(stored.volume === 0.06, "database trade volume must match executed broker volume");
  } finally {
    (axios as any).post = originalPostPartial;
    clearBrokerContracts();
  }

  const closeDb = new DatabaseManager(":memory:");
  await closeDb.initialize();
  registerBrokerContract({
    symbol: "EURUSD.a",
    baseAsset: "EUR",
    quoteCurrency: "USD",
    assetClass: "FOREX",
    contractType: "CFD",
    venue: "MT5",
    contractSize: 100000,
    priceIncrement: 0.00001,
    minVolume: 0.01,
    maxVolume: 100,
    volumeStep: 0.01,
    marginModel: "BROKER_DEFINED",
    source: "close-ledger-test",
    observedAt: Date.now(),
    verified: true,
  });
  const closeGateway = new ExecutionGateway(
    { ...baseConfig("mt5"), symbols: ["EURUSD.a"] },
    closeDb,
  );
  const closeTrade = {
    id: 900,
    ticket: 88,
    symbol: "EURUSD.a",
    timeframe: "H1",
    side: "BUY",
    volume: 0.01,
    entry: 1.1,
    sl: 1.09,
    tp: 1.12,
    status: "open",
    openedAt: 1_800_000_000_004,
    source: "CLOSE_LEDGER_TEST",
  } as any;

  const originalClosePost = (axios as any).post;
  (axios as any).post = async () => ({ data: { ok: true, closed: true } });
  try {
    const closed = await closeGateway.closeAtMarket(
      closeTrade,
      1.11,
      "MANUAL",
    );
    assert(closed.ok, "MT5 closeAtMarket fixture must succeed");
    const closeLedgers = closeDb.raw()
      .prepare("SELECT action, status FROM execution_ledger WHERE symbol=?")
      .all("EURUSD.a") as any[];
    assert(
      closeLedgers.length === 1,
      "closeAtMarket must create exactly one execution-ledger operation",
    );
    assert(
      closeLedgers[0].action === "CLOSE_AT_MARKET" &&
      closeLedgers[0].status === "EXECUTED",
      "closeAtMarket ledger must be executed",
    );
  } finally {
    (axios as any).post = originalClosePost;
    clearBrokerContracts();
  }

  console.log("Result: 16 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
