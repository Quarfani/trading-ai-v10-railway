import { DailyLossGuard } from "../risk/DailyLossGuard";
import { clearBrokerContracts, registerBrokerContract } from "../market/MarketCatalog";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
const trade = {
  symbol: "EURUSD.a", side: "BUY", volume: 1, entry: 2, sl: 1.9, tp: 2.2,
  openedAt: Date.now(), status: "open", timeframe: "H1",
} as any;

const db = {
  getOpenTrades: () => [trade],
  getTodayStats: () => ({ pnl: 0 }),
} as any;
const telegram = { sendMessage: async () => {} } as any;
const config = {
  accountBalance: 10_000,
  accountCurrency: "EUR",
  maxDailyLoss: 0.10,
} as any;

clearBrokerContracts();
registerBrokerContract({
  symbol: "EURUSD.a",
  baseAsset: "EUR",
  quoteCurrency: "USD",
  assetClass: "FOREX",
  contractType: "CFD",
  venue: "MT5",
  // Deliberately differs from the static Forex contract to prove the guard
  // consumes canonical broker economics.
  contractSize: 1,
  priceIncrement: 0.00001,
  minVolume: 0.01,
  maxVolume: 100,
  volumeStep: 0.01,
  marginModel: "BROKER_DEFINED",
  source: "daily-loss-test",
  observedAt: Date.now(),
  verified: true,
});

const guard = new DailyLossGuard(config, db, telegram);
const floating = (guard as any).calcFloating({
  "EURUSD.a": 1,
  EURUSD: 1.25,
});

assert(Math.abs(floating + 0.8) < 1e-9, `expected -0.8 EUR floating PnL, got ${floating}`);
assert((guard as any).calcFloating() === null, "missing prices must fail closed");

const allowed = await guard.canTrade({ "EURUSD.a": 2, EURUSD: 1.25 });
assert(allowed, "daily loss guard must not confuse a small positive floating PnL with a loss");

clearBrokerContracts();
console.log("Result: 3 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
