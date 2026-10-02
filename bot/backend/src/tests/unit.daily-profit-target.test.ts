import { DatabaseManager } from '../database/DatabaseManager';
import { DailyProfitTarget } from '../risk/DailyProfitTarget';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = new DatabaseManager(':memory:');
  await db.initialize();

  const telegram = { sendMessage: async () => {} } as any;
  const today = new Date().toISOString().slice(0, 10);
  const startKey = 'daily_start_equity:live-account:' + today;

  const liveConfig = {
    mode: 'binance',
    accountName: 'live-account',
    accountCurrency: 'USD',
    accountBalance: 2_000,
    dailyProfitTarget: 0.03,
  } as any;

  db.setSetting(startKey, '1000');
  const liveTarget = new DailyProfitTarget(liveConfig, db, telegram);

  assert(
    !liveTarget.reached(1020),
    '2% growth from start-of-day equity must not hit a 3% target',
  );
  assert(
    liveTarget.reached(1040),
    '4% growth from start-of-day equity must hit a 3% target even when historical accountBalance is larger',
  );

  const paperDb = new DatabaseManager(':memory:');
  await paperDb.initialize();
  const paperConfig = {
    mode: 'paper',
    accountName: 'paper',
    accountCurrency: 'USD',
    accountBalance: 1_000,
    dailyProfitTarget: 0.03,
  } as any;
  const tradeId = paperDb.insertTrade({
    ticket: 1,
    symbol: 'EURUSD',
    timeframe: 'H1',
    side: 'BUY',
    volume: 0.1,
    entry: 1,
    sl: 0.99,
    tp: 1.02,
    status: 'open',
    openedAt: Date.now(),
    source: 'DAILY_TARGET_TEST',
  } as any);
  assert(
    paperDb.updateTradeClose(tradeId, 40, Date.now(), 'MANUAL'),
    'paper test trade must close and contribute to daily stats',
  );
  const disabledConfig = {
    mode: 'paper',
    accountName: 'disabled-target',
    accountCurrency: 'USD',
    accountBalance: 1_000,
    dailyProfitTarget: 0,
  } as any;
  const disabledTarget = new DailyProfitTarget(disabledConfig, paperDb, telegram);
  assert(
    !disabledTarget.reached(),
    'zero daily profit target must disable the profit-target gate',
  );

  const paperTarget = new DailyProfitTarget(paperConfig, paperDb, telegram);
  assert(
    paperTarget.reached(),
    'paper daily target must continue using realized daily PnL against configured starting balance',
  );

  db.raw().close();
  paperDb.raw().close();
  console.log('Result: 7 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
