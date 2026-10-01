import { DatabaseManager } from "../database/DatabaseManager";
import { ExecutionGateway } from "../execution/ExecutionGateway";
import { PaperTrader } from "../integration/PaperTrader";
import { Signal, SystemConfig } from "../types/trading.types";
import { estimateEntryCosts, estimateExitCosts, calculateGrossPnlAccount } from "../market/CostModel";
import { getCostProfile } from "../market/CostProfiles";
import { getSymbolSpec } from "../config/symbolConfig";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function closeEnough(a: number, b: number, eps = 1e-9) {
  assert(Math.abs(a - b) <= eps, `expected ${b}, got ${a}`);
}

async function main() {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const db = new DatabaseManager(":memory:");
    await db.initialize();

    const config = {
      mode: "paper", dataSource: "binance", accountCurrency: "EUR",
      accountBalance: 10_000, accountName: "paper-fx", riskPerTrade: 0.01,
      maxOpenTrades: 5, minConfidence: 0.55, maxDailyLoss: 0.02,
      dailyProfitTarget: 0.03, consecutiveLossLimit: 3, cooldownMinutes: 60,
      mlRequired: false, symbols: ["BTCUSDT"], timeframes: ["H1"],
      scanInterval: 60_000, dbPath: ":memory:",
      mt5: { login: 0, password: "", server: "", bridgeUrl: "", bridgeApiKey: "" },
      binance: { apiKey: "", secret: "", env: "testnet", futures: true },
      telegram: { token: "", chatId: "" },
      compounding: { enabled: false, reinvestRate: 1 },
    } as SystemConfig;

    let rateCalls = 0;
    const currencyRates = {
      getRate: async (_quote: string) => (++rateCalls === 1 ? 0.90 : 0.95),
    } as any;

    const gateway = new ExecutionGateway(config, db, currencyRates);
    const signal: Signal = {
      symbol: "BTCUSDT", side: "BUY", price: 100, confidence: 0.8,
      sl: 90, tp: 120, source: "TEST", reason: "paper-fx",
      timestamp: 1_800_000_000_000, timeframe: "H1",
    };

    const opened = await gateway.execute(signal, 2, "H1");
    assert(opened.success && opened.trade, "paper execution must open with FX conversion");
    closeEnough(opened.trade.entryQuoteToAccount ?? 0, 0.90);

    const closed = await gateway.closeAtMarket(opened.trade, 110, "MANUAL");
    assert(closed.ok, "paper close must succeed with exit FX conversion");
    assert(rateCalls === 2, "paper open and close must resolve FX independently");
    closeEnough(opened.trade.exitQuoteToAccount ?? 0, 0.95);

    const row = db.getRecentTrades(1)[0];
    assert(Boolean(row), "closed trade must be persisted");
    closeEnough(Number((row as any).entryQuoteToAccount), 0.90);
    closeEnough(Number((row as any).exitQuoteToAccount), 0.95);

    const spec = getSymbolSpec("BTCUSDT");
    const profile = getCostProfile("BTCUSDT");
    const entryCost = estimateEntryCosts({ price: 100, volume: 2, contractSize: spec.contractSize, quoteToAccount: 0.90 }, profile);
    const exitCost = estimateExitCosts({ price: 110, volume: 2, contractSize: spec.contractSize, quoteToAccount: 0.95 }, profile);
    const gross = calculateGrossPnlAccount({
      entryPrice: 100, exitPrice: 110, volume: 2, contractSize: spec.contractSize,
      quoteToAccount: 0.95, side: "BUY",
    });
    const expectedProfit = gross - entryCost - exitCost;
    closeEnough(Number(row.profit), expectedProfit, 1e-8);

    const restored = new PaperTrader(10_000);
    restored.restoreState([], [row]);
    closeEnough(restored.getBalance(), 10_000 + expectedProfit, 1e-8);

    console.log("Result: 10 passed, 0 failed");
  } finally {
    Math.random = originalRandom;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
