import { HealthMonitor } from "../integration/HealthMonitor";
import { SystemConfig } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(): SystemConfig {
  return {
    mode: "mt5",
    dataSource: "mt5",
    accountBalance: 10_000,
    accountCurrency: "USD",
    accountName: "health-contract-test",
    riskPerTrade: 0.01,
    maxOpenTrades: 5,
    minConfidence: 0.55,
    maxDailyLoss: 0.02,
    dailyProfitTarget: 0.05,
    consecutiveLossLimit: 3,
    cooldownMinutes: 60,
    mlRequired: false,
    symbols: ["ZZZUSD"],
    timeframes: ["H1"],
    scanInterval: 60_000,
    dbPath: ":memory:",
    mt5: {
      login: 1,
      password: "x",
      server: "srv",
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
}

async function main() {
  const cfg = config();
  const db = {
    getSetting: () => null,
    getOpenTrades: () => [],
  } as any;

  const messages: string[] = [];
  const emergency = {
    isActive: () => false,
    activate: async (message: string) => { messages.push(message); },
  } as any;

  const telegram = {
    sendMessage: async (message: string) => { messages.push(message); },
  } as any;

  const monitor = new HealthMonitor(cfg, db, telegram, emergency);

  (monitor as any).checkMT5 = async () => true;
  (monitor as any).checkBinance = async () => true;
  (monitor as any).checkDB = () => true;

  await (monitor as any).tick();

  const status = monitor.getStatus();
  assert(status.mt5 === true, "MT5 connectivity should be healthy in the isolated fixture");
  assert(status.contractsReady === false, "missing broker contract must mark contractsReady=false");
  assert(status.ok === false, "health must be unhealthy when MT5 contracts are unavailable");
  assert(
    status.issues.includes("MT5 broker contracts unavailable or expired"),
    "health must expose the broker-contract readiness failure",
  );
  assert(messages.length === 0, "no emergency alert should fire without open trades");

  console.log("Result: 1 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
