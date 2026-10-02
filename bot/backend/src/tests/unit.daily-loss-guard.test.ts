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

const settings = new Map<string, string>();
const db = {
  getOpenTrades: () => [trade],
  getTodayStats: () => ({ pnl: 0 }),
  getSetting: (key: string) => settings.get(key) ?? null,
  setSetting: (key: string, value: string) => settings.set(key, value),
} as any;
const telegram = { sendMessage: async () => {} } as any;
const config = {
  accountBalance: 10_000,
  accountCurrency: "EUR",
  maxDailyLoss: 0.10,
  mode: "paper",
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

const corruptDb = new DatabaseManager(':memory:');
await corruptDb.initialize();
const corruptKey = 'daily_start_equity:loss-corrupt:' + new Date().toISOString().slice(0, 10);
corruptDb.setSetting(corruptKey, 'NaN');
const corruptLossGuard = new DailyLossGuard(
  { ...config, accountName: 'loss-corrupt', mode: 'binance' } as any,
  corruptDb,
  telegram,
);
assert(
  !(await corruptLossGuard.canTrade({}, 5000)),
  'corrupt live daily equity anchor must block the loss guard',
);
assert(
  corruptDb.getSetting(corruptKey) === 'NaN',
  'corrupt daily loss equity anchor must not be overwritten',
);
corruptDb.raw().close();

const invalidConfig = { ...config, maxDailyLoss: Number.NaN } as any;
const invalidGuard = new DailyLossGuard(invalidConfig, db, telegram);
assert(
  !(await invalidGuard.canTrade({ "EURUSD.a": 2.0 })),
  "invalid MAX_DAILY_LOSS must fail closed",
);

const guard = new DailyLossGuard(config, db, telegram);
const floating = (guard as any).calcFloating({
  "EURUSD.a": 1,
  EURUSD: 1.25,
});

assert(Math.abs(floating + 0.8) < 1e-9, `expected -0.8 EUR floating PnL, got ${floating}`);
assert((guard as any).calcFloating() === null, "missing prices must fail closed");

const allowed = await guard.canTrade({ "EURUSD.a": 2.1, EURUSD: 1.25 });
assert(allowed, "daily loss guard must not block on a small positive floating PnL");

const noTradesDb = {
  getOpenTrades: () => [],
  getTodayStats: () => ({ pnl: -1900 }),
  getSetting: (key: string) => settings.get(key) ?? null,
  setSetting: (key: string, value: string) => settings.set(key, value),
} as any;
const anchorConfig = {
  ...config,
  accountName: "anchor-test",
  mode: "mt5",
  maxDailyLoss: 0.10,
  accountBalance: 10_000,
} as any;
const anchorGuard = new DailyLossGuard(anchorConfig, noTradesDb, telegram);
assert(await anchorGuard.canTrade({}, 20_000), "first live equity observation should establish the daily anchor");
assert(await anchorGuard.canTrade({}, 18_100), "daily loss should be measured from persisted start-of-day equity anchor");

const blockedDb = {
  getOpenTrades: () => [],
  getTodayStats: () => ({ pnl: 0 }),
  getSetting: (key: string) => settings.get(key) ?? null,
  setSetting: (key: string, value: string) => settings.set(key, value),
} as any;
const blockedGuard = new DailyLossGuard(anchorConfig, blockedDb, telegram);
assert(await blockedGuard.canTrade({}, 20_000), "threshold fixture should establish its own daily anchor");
blockedDb.getTodayStats = () => ({ pnl: 0 });
assert(
  !(await blockedGuard.canTrade({}, 17_900)),
  "daily loss should block once live equity falls more than 10% below the daily anchor",
);


clearBrokerContracts();
console.log("Result: 10 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
