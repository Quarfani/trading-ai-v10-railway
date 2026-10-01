import { DatabaseManager } from '../database/DatabaseManager';
import { Reconciler } from '../core/Reconciler';
import { SystemConfig, Trade } from '../types/trading.types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(): SystemConfig {
  return {
    mode: 'binance', dataSource: 'binance', accountCurrency: 'USD',
    accountBalance: 10_000, accountName: 'binance-runtime-recon-test',
    riskPerTrade: 0.01, maxOpenTrades: 5, minConfidence: 0.55,
    maxDailyLoss: 0.02, dailyProfitTarget: 0.03, consecutiveLossLimit: 3,
    cooldownMinutes: 60, mlRequired: false, symbols: ['BTCUSDT'], timeframes: ['H1'],
    scanInterval: 60_000, dbPath: ':memory:',
    mt5: { login: 0, password: '', server: '', bridgeUrl: '', bridgeApiKey: '' },
    binance: { apiKey: 'x', secret: 'x', env: 'testnet', futures: true },
    telegram: { token: '', chatId: '' },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

async function main() {
  const cfg = config();
  const db = new DatabaseManager(':memory:');
  await db.initialize();
  const tradeId = db.insertTrade({
    ticket: 6001, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 0.01,
    entry: 50_000, sl: 49_000, tp: 52_000, status: 'open', openedAt: Date.now(), source: 'BINANCE_RUNTIME_RECON',
  } as any);
  db.createExecutionLedger({
    executionId: 'runtime-close-1', operationKey: 'runtime-close-op',
    action: 'CLOSE_AT_MARKET', status: 'UNKNOWN', symbol: 'BTCUSDT', side: 'BUY', volume: 0.01,
    request: { tradeId, reason: 'MANUAL' },
  });

  const fakeExec = {
    getBinancePosition: async () => null,
    reconcileBinanceCloseByOperation: async (symbol: string, operationKey: string) => {
      assert(symbol === 'BTCUSDT', 'runtime recovery must query the trade symbol');
      assert(operationKey === 'runtime-close-op', 'runtime recovery must use the ledger operation key');
      return {
        found: true, status: 'FILLED', orderId: 9001, executedQty: 0.01, updatedAt: Date.now(),
        realizedProfit: 125, realizedProfitCurrency: 'USDT',
      };
    },
  } as any;
  const reconciler = new Reconciler(
    cfg, db, fakeExec,
    { sendMessage: async () => {} } as any,
    { recordClose: () => {} } as any,
    {} as any,
    { activate: async () => {} } as any,
    () => {},
  );
  const trade = db.getOpenTrades()[0] as Trade;
  await (reconciler as any).reconcileOne(trade);

  const resolved = db.getExecutionByOperationKey('runtime-close-op');
  const closed = db.raw().prepare(
    'SELECT status, profit FROM trades WHERE id=?',
  ).get(tradeId) as any;
  assert(resolved.status === 'EXECUTED', 'runtime Binance recovery must resolve the UNKNOWN close ledger');
  assert(resolved.brokerOrderId === '9001', 'runtime Binance recovery must keep broker order identity');
  assert(closed.status === 'closed' && closed.profit === 125, 'runtime Binance recovery must persist authoritative PnL');


  const ambiguousDb = new DatabaseManager(':memory:');
  await ambiguousDb.initialize();
  const ambiguousTradeId = ambiguousDb.insertTrade({
    ticket: 6002, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 0.01,
    entry: 50_000, sl: 49_000, tp: 52_000, status: 'open', openedAt: Date.now(), source: 'BINANCE_RUNTIME_AMBIGUOUS',
  } as any);
  ambiguousDb.createExecutionLedger({
    executionId: 'runtime-close-partial-1', operationKey: 'runtime-close-partial-op',
    action: 'CLOSE_AT_MARKET', status: 'UNKNOWN', symbol: 'BTCUSDT', side: 'BUY', volume: 0.01,
    request: { tradeId: ambiguousTradeId, reason: 'MANUAL' },
  });
  const ambiguousExec = {
    getBinancePosition: async () => ({ positionAmt: 0.006, entryPrice: 50_000, unrealizedProfit: 0 }),
    reconcileBinanceCloseByOperation: async () => ({
      found: true, status: 'PARTIALLY_FILLED', orderId: 9002, executedQty: 0.004,
      realizedProfit: 50, realizedProfitCurrency: 'USDT',
    }),
  } as any;
  const ambiguousReconciler = new Reconciler(
    cfg, ambiguousDb, ambiguousExec,
    { sendMessage: async () => {} } as any,
    { recordClose: () => {} } as any,
    {} as any,
    { activate: async () => {} } as any,
    () => {},
  );
  let ambiguousBlocked = false;
  try {
    await (ambiguousReconciler as any).reconcileOne(ambiguousDb.getOpenTrades()[0]);
  } catch {
    ambiguousBlocked = true;
  }
  assert(ambiguousBlocked, 'unresolved Binance close with reduced broker position must block runtime reconciliation');
  assert(
    ambiguousDb.getOpenTrades()[0].volume === 0.01,
    'ambiguous Binance close must not mutate internal volume',
  );
  ambiguousDb.raw().close();
  db.raw().close();
  console.log('Result: 2 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});