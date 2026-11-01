import { Backtester } from '../backtest/Backtester';
import { Candle, SystemConfig } from '../types/trading.types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const config: SystemConfig = {
  accountName: 'TEST',
  accountCurrency: 'USD',
  mode: 'paper',
  accountBalance: 10_000,
  dataSource: 'auto',
  riskPerTrade: 0.01,
  maxOpenTrades: 1,
  minConfidence: 0.7,
  maxDailyLoss: 0.05,
  dailyProfitTarget: 0,
  consecutiveLossLimit: 3,
  cooldownMinutes: 0,
  mlRequired: false,
  symbols: ['EURGBP'],
  timeframes: ['H1'],
  scanInterval: 60_000,
  dbPath: ':memory:',
  mt5: { login: 0, password: '', server: '', bridgeUrl: '', bridgeApiKey: '' },
  binance: { apiKey: '', secret: '', env: 'testnet', futures: false },
  telegram: { token: '', chatId: '' },
  compounding: { enabled: false, reinvestRate: 0 },
};

const candles: Candle[] = Array.from({ length: 260 }, (_, i) => ({
  time: (i + 1) * 3_600_000,
  open: 1,
  high: 1.001,
  low: 0.999,
  close: 1,
  volume: 100,
}));

async function main() {
  const result = await new Backtester(config).run('EURGBP', candles);
  assert(!result.valid, 'EURGBP backtest without historical FX should be invalid');
  assert(
    result.blockedReason?.includes('Missing historical GBP->USD'),
    'missing FX reason should identify GBP->USD',
  );
  assert(result.totalTrades === 0, 'invalid FX backtest must not simulate trades');
  console.log('Result: 4 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
