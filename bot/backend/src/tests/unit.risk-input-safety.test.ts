import { RiskManager } from '../risk/RiskManager';
import { DatabaseManager } from '../database/DatabaseManager';
import { EmergencyStop } from '../integration/EmergencyStop';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config() {
  return {
    mode: 'paper',
    accountBalance: 10_000,
    accountCurrency: 'USD',
    accountName: 'risk-input-test',
    riskPerTrade: 0.01,
    maxOpenTrades: 5,
    minConfidence: 0.55,
    maxDailyLoss: 0.02,
    dailyProfitTarget: 0.03,
    consecutiveLossLimit: 3,
    cooldownMinutes: 60,
    minRR: 1.5,
    maxWeeklyLoss: 0.05,
    maxDrawdown: 0.10,
    maxPortfolioHeat: 0.06,
    maxExposure: 1,
    maxLeverage: 3,
    maxSlippagePct: 0.005,
    maxSlippagePips: 3,
    symbols: ['EURUSD'],
    timeframes: ['H1'],
    scanInterval: 60_000,
    dbPath: ':memory:',
    mt5: { login: 0, password: '', server: '', bridgeUrl: '', bridgeApiKey: '' },
    binance: { apiKey: '', secret: '', env: 'testnet', futures: true },
    telegram: { token: '', chatId: '' },
    compounding: { enabled: false, reinvestRate: 1 },
  } as any;
}

async function main() {
  const db = new DatabaseManager(':memory:');
  await db.initialize();
  const risk = new RiskManager(
    config(),
    db,
    { sendMessage: async () => {} } as any,
    new EmergencyStop(),
  );

  const base = {
    symbol: 'EURUSD',
    side: 'BUY',
    price: 1.1,
    sl: 1.09,
    tp: 1.12,
    confidence: 0.8,
    timestamp: Date.now(),
    source: 'TREND',
  };

  const nanConfidence = await risk.check(
    { ...base, confidence: Number.NaN } as any,
    [],
  );
  assert(!nanConfidence.allowed, 'NaN confidence must block before risk evaluation');
  assert(
    nanConfidence.blockedBy === 'invalid_signal',
    'NaN confidence must return invalid_signal',
  );

  const badSide = await risk.check(
    { ...base, side: 'HOLD' } as any,
    [],
  );
  assert(!badSide.allowed, 'invalid signal side must block');
  assert(badSide.blockedBy === 'invalid_signal', 'invalid signal side must return invalid_signal');

  const future = await risk.check(
    { ...base, timestamp: Date.now() + 60_000 } as any,
    [],
  );
  assert(!future.allowed, 'future signal timestamp must block');
  assert(future.blockedBy === 'invalid_signal', 'future signal timestamp must return invalid_signal');

  const badPrices = await risk.check(
    { ...base, sl: 0 } as any,
    [],
  );
  assert(!badPrices.allowed, 'non-positive SL must block');
  assert(badPrices.blockedBy === 'invalid_prices', 'bad prices must return invalid_prices');

  db.raw().close();
  console.log('Result: 4 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
