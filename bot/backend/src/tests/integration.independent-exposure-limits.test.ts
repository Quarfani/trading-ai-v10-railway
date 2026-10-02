import { DatabaseManager } from "../database/DatabaseManager";
import { RiskManager } from "../risk/RiskManager";
import { EmergencyStop } from "../integration/EmergencyStop";
import { TelegramBot } from "../notifications/TelegramBot";
import { SystemConfig, Signal, Trade } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function cfg(): SystemConfig {
  return {
    mode: "paper",
    dataSource: "auto",
    accountBalance: 10_000,
    accountCurrency: "USD",
    accountName: "exposure-limit-test",
    riskPerTrade: 0.01,
    maxOpenTrades: 10,
    minConfidence: 0.5,
    maxDailyLoss: 0.2,
    maxWeeklyLoss: 0.5,
    dailyProfitTarget: 0.99,
    consecutiveLossLimit: 100,
    cooldownMinutes: 0,
    minRR: 1,
    maxSlippagePips: 100,
    maxDrawdown: 0.5,
    maxLeverage: 100,
    maxExposure: 100,
    maxSymbolExposure: 0.05,
    maxCorrelatedExposure: 0.05,
    maxPortfolioHeat: 1,
    mlRequired: false,
    symbols: ["BTCUSDT", "ETHUSDT"],
    timeframes: ["H1"],
    scanInterval: 60_000,
    dbPath: ":memory:",
    mt5: { login: 0, password: "", server: "", bridgeUrl: "", bridgeApiKey: "" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

function signal(symbol: string): Signal {
  return {
    symbol, side: "BUY", price: 50_000, sl: 49_000, tp: 52_000,
    confidence: 0.9, source: "TEST", reason: "TEST", timestamp: Date.now(), timeframe: "H1",
  };
}

let tradeCounter = 0;

function trade(symbol: string, volume: number): Trade {
  tradeCounter += 1;
  return {
    id: 1_000_000 + tradeCounter,
    ticket: 2_000_000 + tradeCounter,
    symbol, timeframe: "H1", side: "BUY", volume,
    entry: symbol === "BTCUSDT" ? 50_000 : 2_500,
    sl: symbol === "BTCUSDT" ? 49_000 : 2_400,
    tp: symbol === "BTCUSDT" ? 52_000 : 2_700,
    status: "open", openedAt: Date.now(), source: "TEST",
  };
}

async function prepare(manager: RiskManager, db: DatabaseManager, peers: Trade[]) {
  const anyManager = manager as any;
  anyManager.breaker.canTrade = () => true;
  anyManager.lossGuard.canTrade = async () => true;
  anyManager.profitTarget.reached = () => false;
  anyManager.session.check = () => ({ allowed: true, session: "TEST" });
  anyManager.spread.check = () => ({ ok: true, spreadPips: 0.1 });
  anyManager.news.isFresh = () => true;
  anyManager.news.isBlocked = () => ({ blocked: false });
  anyManager.correlation.isCorrelated = () => ({ blocked: false });
  anyManager.correlation.getExposurePeers = (symbol: string, side: any, open: Trade[]) =>
    anyManager.__peers ?? [];
  anyManager.sizer.size = () => 0.01;
  anyManager.sizer.getDrawdownStatus = () => ({ drawdownPct: 0, level: "NORMAL", volumeScale: 1 });
  anyManager.heat.check = () => ({ allowed: true, currentHeat: 0 });
  db.getOpenTrades = () => peers;
}

async function main() {
  const database = new DatabaseManager(":memory:");
  await database.initialize();
  const config = cfg();
  const telegram = new TelegramBot(config);
  const emergency = new EmergencyStop(telegram);
  const manager = new RiskManager(config, database, telegram, emergency);

  const same = [trade("BTCUSDT", 0.01)];
  await prepare(manager, database, same);

  let result = await manager.check(
    signal("BTCUSDT"),
    same,
    { bid: 49_999, ask: 50_001 },
    10_000,
    100,
    { BTCUSDT: 50_000, ETHUSDT: 2_500 },
  );
  assert(result.blockedBy === "symbol_exposure", "same-symbol exposure must be independently enforceable");

  const correlated = [trade("ETHUSDT", 0.01)];
  (manager as any).__peers = correlated;
  await prepare(manager, database, []);
  result = await manager.check(
    signal("BTCUSDT"),
    [],
    { bid: 49_999, ask: 50_001 },
    10_000,
    100,
    { BTCUSDT: 50_000, ETHUSDT: 2_500 },
  );
  assert(result.blockedBy === "correlated_exposure", "correlated exposure must be independently enforceable");

  (manager as any).__peers = [];
  await prepare(manager, database, []);
  (manager as any).config.maxSymbolExposure = undefined;
  (manager as any).config.maxCorrelatedExposure = undefined;
  result = await manager.check(
    signal("BTCUSDT"),
    [],
    { bid: 49_999, ask: 50_001 },
    10_000,
    100,
    { BTCUSDT: 50_000, ETHUSDT: 2_500 },
  );
  assert(result.passed === true, "undefined optional exposure limits must not change legacy behavior");

  database.raw().close();
  console.log("Result: 3 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
