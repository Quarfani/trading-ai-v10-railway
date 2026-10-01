import axios from "axios";
import { Reconciler } from "../core/Reconciler";
import { SystemConfig } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(): SystemConfig {
  return {
    mode: "mt5", dataSource: "mt5", accountCurrency: "USD",
    accountBalance: 10_000, accountName: "mt5-recon-safety",
    riskPerTrade: 0.01, maxOpenTrades: 5, minConfidence: 0.55,
    maxDailyLoss: 0.02, dailyProfitTarget: 0.03, consecutiveLossLimit: 3,
    cooldownMinutes: 60, mlRequired: false, symbols: ["EURUSD"], timeframes: ["H1"],
    scanInterval: 60_000, dbPath: ":memory:",
    mt5: { login: 1, password: "x", server: "x", bridgeUrl: "http://mt5.test", bridgeApiKey: "secret" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

async function main() {
  const noOp = { getSetting: () => null } as any;
  const reconciler = new Reconciler(
    config(),
    noOp,
    {} as any,
    { sendMessage: async () => {} } as any,
    { recordClose: () => {} } as any,
    {} as any,
    { activate: async () => {} } as any,
    () => {},
  );

  const originalGet = (axios as any).get;
  try {
    (axios as any).get = async () => ({
      data: {
        closed: false,
        remaining_volume: 0.01,
        close_price: 1.1000,
        net_profit: 25,
        close_reason: "manual",
      },
    });
    const unresolved = await (reconciler as any).getMT5History(77);
    assert(unresolved === null, "partial/unknown history must not settle an absent MT5 position");

    (axios as any).get = async () => ({
      data: {
        closed: true,
        remaining_volume: 0,
        close_price: 1.1000,
        net_profit: 25,
        close_reason: "sl",
      },
    });
    const resolved = await (reconciler as any).getMT5History(77);
    assert(resolved?.profit === 25, "closed MT5 history must expose authoritative PnL");
    assert(resolved?.reason === "SL", "closed MT5 history must preserve close reason");

    console.log("Result: 3 passed, 0 failed");
  } finally {
    (axios as any).get = originalGet;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
