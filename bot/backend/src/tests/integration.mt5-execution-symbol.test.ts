import axios from "axios";
import { DatabaseManager } from "../database/DatabaseManager";
import { ExecutionGateway } from "../execution/ExecutionGateway";
import { Signal, SystemConfig } from "../types/trading.types";
import {
  clearBrokerContracts,
  registerBrokerContract,
} from "../market/MarketCatalog";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = new DatabaseManager(":memory:");
  await db.initialize();

  const config = {
    mode: "mt5",
    accountBalance: 10_000,
    accountCurrency: "USD",
    accountName: "test",
    dataSource: "mt5",
    riskPerTrade: 0.01,
    maxOpenTrades: 5,
    minConfidence: 0.55,
    maxDailyLoss: 0.02,
    dailyProfitTarget: 0.03,
    consecutiveLossLimit: 3,
    cooldownMinutes: 60,
    mlRequired: false,
    symbols: ["EURUSD.A"],
    timeframes: ["H1"],
    scanInterval: 60_000,
    dbPath: ":memory:",
    mt5: {
      login: 1,
      password: "x",
      server: "x",
      bridgeUrl: "http://mt5.test",
      bridgeApiKey: "secret",
    },
    binance: {
      apiKey: "",
      secret: "",
      env: "testnet",
      futures: true,
    },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;

  clearBrokerContracts();
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
    source: "execution-test",
    observedAt: Date.now(),
    verified: true,
  });

  const signal: Signal = {
    symbol: "EURUSD.A",
    side: "BUY",
    price: 1.1,
    confidence: 0.8,
    sl: 1.095,
    tp: 1.11,
    source: "TREND",
    reason: "test",
    timestamp: Date.now(),
    timeframe: "H1",
  };

  const originalPost = axios.post;
  let requestedSymbol = "";

  (axios as any).post = async (url: string, body: any) => {
    assert(url === "http://mt5.test/trade", "ExecutionGateway must call /trade");
    requestedSymbol = String(body?.symbol ?? "");
    assert(body?.idempotency_key, "MT5 request must carry idempotency key");
    return { data: { ticket: 12345, price: 1.1002 } };
  };

  try {
    const gateway = new ExecutionGateway(config, db);
    const result = await gateway.execute(signal, 0.10, "H1");

    assert(result.success === true, "MT5 execution should succeed with broker fixture");
    assert(requestedSymbol === "EURUSD.a", "ExecutionGateway must preserve exact broker symbol");
    assert(result.trade?.symbol === "EURUSD.a", "returned trade must use exact broker symbol");

    clearBrokerContracts();
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
      source: "execution-expiry-test",
      observedAt: Date.now(),
      expiresAt: Date.now() + 1,
      verified: true,
    });

    let blockedPost = false;
    (axios as any).post = async () => {
      blockedPost = true;
      throw new Error("expired contract must not reach broker");
    };

    await new Promise(resolve => setTimeout(resolve, 5));
    const expiredSignal = { ...signal, timestamp: Date.now() };
    const expired = await gateway.execute(expiredSignal, 0.10, "H1");
    assert(!expired.success, "expired broker contract must block MT5 execution");
    assert(!blockedPost, "expired broker contract must not call /trade");

    console.log("Result: 6 passed, 0 failed");
  } finally {
    (axios as any).post = originalPost;
    clearBrokerContracts();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
