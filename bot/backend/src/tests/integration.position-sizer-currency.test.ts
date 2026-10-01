import { DatabaseManager } from "../database/DatabaseManager";
import { PositionSizer } from "../risk/PositionSizer";
import { SystemConfig } from "../types/trading.types";
import { clearBrokerContracts, registerBrokerContract } from "../market/MarketCatalog";

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

  // Mirror real MT5 startup: every active symbol must have a verified
  // broker-confirmed contract before live sizing is allowed.
  clearBrokerContracts();
  for (const [symbol, baseAsset, quoteCurrency, contractSize, pip] of [
    ["EURUSD", "EUR", "USD", 100000, 0.00001],
    ["USDJPY", "USD", "JPY", 100000, 0.01],
    ["XAUUSD", "XAU", "USD", 100, 0.1],
  ] as const) {
    registerBrokerContract({
      symbol,
      baseAsset,
      quoteCurrency,
      assetClass: symbol === "XAUUSD" ? "METAL" : "FOREX",
      contractType: "CFD",
      venue: "MT5",
      contractSize,
      priceIncrement: pip,
      minVolume: 0.01,
      maxVolume: 100,
      volumeStep: 0.01,
      marginModel: "BROKER_DEFINED",
      source: "mt5-symbol-info:test-base",
      observedAt: Date.now(),
      verified: true,
    });
  }

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

  // Broker economics intentionally differ from static symbolConfig.
  clearBrokerContracts();
  registerBrokerContract({
    symbol: "EURUSD",
    baseAsset: "EUR",
    quoteCurrency: "USD",
    assetClass: "FOREX",
    contractType: "CFD",
    venue: "MT5",
    contractSize: 1,
    priceIncrement: 0.00001,
    minVolume: 0.03,
    maxVolume: 0.09,
    volumeStep: 0.03,
    marginModel: "BROKER_DEFINED",
    source: "mt5-symbol-info:test-eur-account",
    observedAt: Date.now(),
    verified: true,
  });

  const brokerVolume = sizer.size(
    "EURUSD", "BUY", 1.1000, 1.0990, 70, 10_000, 1.1040,
    { EURUSD: 1.1000 }, "H1",
  );
  assert(
    brokerVolume === 0.09,
    `broker economics must control max volume/step; got ${brokerVolume}`,
  );

  clearBrokerContracts();

  registerBrokerContract({
    symbol: "EURUSD.a",
    baseAsset: "EUR",
    quoteCurrency: "USD",
    assetClass: "FOREX",
    contractType: "CFD",
    venue: "MT5",
    contractSize: 100_000,
    priceIncrement: 0.00001,
    minVolume: 0.01,
    maxVolume: 0.05,
    volumeStep: 0.01,
    marginModel: "BROKER_DEFINED",
    source: "mt5-symbol-info:suffix",
    observedAt: Date.now(),
    verified: true,
  });

  const suffixed = sizer.size(
    "EURUSD.a", "BUY", 1.1000, 1.0990, 70, 10_000, 1.1040,
    { "EURUSD.a": 1.1000, EURUSD: 1.1000 }, "H1",
  );
  assert(
    suffixed === 0.05,
    `suffixed MT5 symbol must use its broker max volume; got ${suffixed}`,
  );

  clearBrokerContracts();
  const unknownSuffixed = sizer.size(
    "EURUSD.a", "BUY", 1.1000, 1.0990, 70, 10_000, 1.1040,
    { "EURUSD.a": 1.1000, EURUSD: 1.1000 }, "H1",
  );
  assert(
    unknownSuffixed === 0,
    "unknown suffixed MT5 symbol must fail closed instead of inheriting static economics",
  );

  registerBrokerContract({
    symbol: "EURUSD",
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
    source: "mt5-symbol-info:test-timeframe",
    observedAt: Date.now(),
    verified: true,
    supportedTimeframes: ["H1"],
  });

  const unsupportedTf = sizer.size(
    "EURUSD", "BUY", 1.1000, 1.0950, 70, 10_000, 1.1100,
    { EURUSD: 1.1000 }, "M5",
  );
  assert(
    unsupportedTf === 0,
    "PositionSizer must fail closed for broker-declared unsupported timeframe",
  );

  clearBrokerContracts();
  registerBrokerContract({
    symbol: "EURUSD",
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
    source: "mt5-symbol-info:test-trade-mode",
    observedAt: Date.now(),
    verified: true,
    tradeMode: 2,
  });

  const longOnlyBlocked = sizer.size(
    "EURUSD", "BUY", 1.1000, 1.0950, 70, 10_000, 1.1100,
    { EURUSD: 1.1000 }, "H1",
  );
  assert(
    longOnlyBlocked === 0,
    "BUY must be blocked when broker trade mode is SHORTONLY",
  );

  const shortAllowed = sizer.size(
    "EURUSD", "SELL", 1.1000, 1.1050, 70, 10_000, 1.0900,
    { EURUSD: 1.1000 }, "H1",
  );
  assert(
    shortAllowed > 0,
    "SELL must remain allowed when broker trade mode is SHORTONLY",
  );

  clearBrokerContracts();

  registerBrokerContract({
    symbol: "EURUSD",
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
    source: "mt5-symbol-info:test-volume-limit",
    observedAt: Date.now(),
    verified: true,
    volumeLimit: 0.02,
  });

  const volumeLimited = sizer.size(
    "EURUSD", "BUY", 1.1000, 1.0900, 70, 10_000, 1.1200,
    { EURUSD: 1.1000 }, "H1",
  );
  assert(
    volumeLimited === 0.02,
    `broker volume_limit must cap the order; got ${volumeLimited}`,
  );

  clearBrokerContracts();
  registerBrokerContract({
    symbol: "EURUSD",
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
    source: "mt5-symbol-info:test-stops-level",
    observedAt: Date.now(),
    verified: true,
    stopsLevel: 10,
  });

  const tooCloseStop = sizer.size(
    "EURUSD", "BUY", 1.1000, 1.09995, 70, 10_000, 1.1010,
    { EURUSD: 1.1000 }, "H1",
  );
  assert(
    tooCloseStop === 0,
    "PositionSizer must block stop distance below broker stops level",
  );

  clearBrokerContracts();
  console.log("Result: 16 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
