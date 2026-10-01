import { DatabaseManager } from "../database/DatabaseManager";
import { PositionSizer } from "../risk/PositionSizer";
import { SystemConfig } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = new DatabaseManager(":memory:");
  await db.initialize();

  const config = {
    mode: "mt5",
    accountCurrency: "EUR",
    accountBalance: 10_000,
    riskPerTrade: 0.01,
    maxOpenTrades: 5,
    minConfidence: 0.55,
    maxDailyLoss: 0.02,
    dailyProfitTarget: 0.03,
    consecutiveLossLimit: 3,
    cooldownMinutes: 60,
    mlRequired: false,
    symbols: ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"],
    timeframes: ["H1"],
    scanInterval: 15_000,
    dbPath: ":memory:",
    mt5: { login: 1, password: "x", server: "x", bridgeUrl: "x", bridgeApiKey: "x" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: true, reinvestRate: 1 },
  } as SystemConfig;

  const sizer = new PositionSizer(config, db);

  const eurUsd = sizer.size(
    "EURUSD", "BUY", 1.1000, 1.0950, 70, 10_000, 1.1100,
    { EURUSD: 1.1000 }, "H1",
  );
  assert(eurUsd > 0, "EUR account must size EURUSD using inverse EURUSD conversion");

  const usdJpy = sizer.size(
    "USDJPY", "BUY", 150.00, 149.90, 70, 10_000, 150.30,
    { EURUSD: 1.1000, USDJPY: 150.0 }, "H1",
  );
  assert(usdJpy > 0, "EUR account must size USDJPY through USD bridge");

  const xauUsd = sizer.size(
    "XAUUSD", "BUY", 2_000.0, 1_998.0, 70, 10_000, 2_005.0,
    { EURUSD: 1.1000 }, "H1",
  );
  assert(xauUsd > 0, "EUR account must size XAUUSD using USD->EUR conversion");

  const missingFx = sizer.size(
    "USDJPY", "BUY", 150.00, 149.90, 70, 10_000, 150.30,
    {}, "H1",
  );
  assert(missingFx === 0, "missing FX conversion must fail closed in PositionSizer");

  console.log("Result: 4 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
