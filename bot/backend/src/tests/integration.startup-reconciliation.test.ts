import { DatabaseManager } from '../database/DatabaseManager';
import { StartupReconciler } from '../integration/StartupReconciler';
import { TelegramBot } from '../notifications/TelegramBot';
import { SystemConfig } from '../types/trading.types';
import { BinanceExecutor } from '../execution/BinanceExecutor';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(): SystemConfig {
  return {
    mode: 'paper', dataSource: 'binance', accountBalance: 10_000,
    accountCurrency: 'USD', riskPerTrade: 0.01, maxOpenTrades: 5,
    minConfidence: 0.55, maxDailyLoss: 0.02, dailyProfitTarget: 0.03,
    consecutiveLossLimit: 3, cooldownMinutes: 60, mlRequired: false,
    symbols: ['BTCUSDT'], timeframes: ['H1'], scanInterval: 60_000,
    dbPath: ':memory:',
    mt5: { login: 0, password: '', server: '', bridgeUrl: '', bridgeApiKey: '' },
    binance: { apiKey: '', secret: '', env: 'testnet', futures: true },
    telegram: { token: '', chatId: '' },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

async function newDb() {
  const db = new DatabaseManager(':memory:');
  await db.initialize();
  return db;
}

async function main() {
  const cfg = config();
  const telegram = new TelegramBot(cfg);

  const clean = await newDb();
  await new StartupReconciler(cfg, clean, telegram).run();
  assert(true, 'clean paper database must reconcile');

  const unresolved = await newDb();
  unresolved.createExecutionLedger({
    executionId: 'e-unknown', operationKey: 'op-unknown',
    action: 'OPEN', status: 'UNKNOWN', symbol: 'BTCUSDT', side: 'BUY', volume: 0.1,
  });
  let unknownBlocked = false;
  try { await new StartupReconciler(cfg, unresolved, telegram).run(); } catch { unknownBlocked = true; }
  assert(unknownBlocked, 'UNKNOWN execution ledger entry must block paper startup');

  const pending = await newDb();
  pending.createExecutionLedger({
    executionId: 'e-pending', operationKey: 'op-pending',
    action: 'OPEN', status: 'PENDING', symbol: 'BTCUSDT', side: 'BUY', volume: 0.1,
  });
  let pendingBlocked = false;
  try { await new StartupReconciler(cfg, pending, telegram).run(); } catch { pendingBlocked = true; }
  assert(pendingBlocked, 'PENDING execution ledger entry must block paper startup');

  const valid = await newDb();
  valid.insertTrade({
    ticket: 7, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 0.1,
    entry: 100, sl: 90, tp: 120, status: 'open', openedAt: Date.now(), source: 'TEST',
  });
  await new StartupReconciler(cfg, valid, telegram).run();
  assert(true, 'valid open paper trade must reconcile');

  const zeroVolume = await newDb();
  zeroVolume.insertTrade({
    ticket: 8, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 0,
    entry: 100, sl: 90, tp: 120, status: 'open', openedAt: Date.now(), source: 'TEST',
  });
  let zeroBlocked = false;
  try { await new StartupReconciler(cfg, zeroVolume, telegram).run(); } catch { zeroBlocked = true; }
  assert(zeroBlocked, 'zero-volume paper state must block startup');

  const noTicket = await newDb();
  noTicket.insertTrade({
    ticket: null, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 0.1,
    entry: 100, sl: 90, tp: 120, status: 'open', openedAt: Date.now(), source: 'TEST',
  });
  let ticketBlocked = false;
  try { await new StartupReconciler(cfg, noTicket, telegram).run(); } catch { ticketBlocked = true; }
  assert(ticketBlocked, 'open paper trade without ticket must block startup');

  const spotCfg = { ...config(), mode: 'binance', dataSource: 'binance', binance: { ...config().binance, futures: false } } as SystemConfig;
  const originalPing = (BinanceExecutor.prototype as any).ping;
  const originalBalances = (BinanceExecutor.prototype as any).getAllSpotBalancesForConfiguredSymbols;
  (BinanceExecutor.prototype as any).ping = async () => true;

  try {
    const spotClean = await newDb();
    (BinanceExecutor.prototype as any).getAllSpotBalancesForConfiguredSymbols = async () => [
      { asset: 'USDT', free: 1000, locked: 0 },
    ];
    await new StartupReconciler(spotCfg, spotClean, new TelegramBot(spotCfg)).run();

    const spotHidden = await newDb();
    (BinanceExecutor.prototype as any).getAllSpotBalancesForConfiguredSymbols = async () => [
      { asset: 'BTC', free: 0.1, locked: 0 },
      { asset: 'USDT', free: 1000, locked: 0 },
    ];
    let hiddenBlocked = false;
    try { await new StartupReconciler(spotCfg, spotHidden, new TelegramBot(spotCfg)).run(); } catch { hiddenBlocked = true; }
    assert(hiddenBlocked, 'unattributed Binance Spot inventory must block startup');

    const spotOpen = await newDb();
    spotOpen.insertTrade({
      ticket: 9, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 0.1,
      entry: 100, sl: 90, tp: 120, status: 'open', openedAt: Date.now(), source: 'TEST',
    });
    let openBlocked = false;
    try { await new StartupReconciler(spotCfg, spotOpen, new TelegramBot(spotCfg)).run(); } catch { openBlocked = true; }
    assert(openBlocked, 'open Binance Spot bot trades must block ambiguous restart reconciliation');

  } finally {
    (BinanceExecutor.prototype as any).ping = originalPing;
    (BinanceExecutor.prototype as any).getAllSpotBalancesForConfiguredSymbols = originalBalances;
  }

  console.log('Result: 9 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
