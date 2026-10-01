import { DatabaseManager } from '../database/DatabaseManager';
import { RiskManager } from '../risk/RiskManager';
import { SystemConfig, Signal } from '../types/trading.types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const cfg = {
  mode: 'paper', dataSource: 'binance', accountBalance: 10_000, accountName: 'unresolved-entry-gate',
  accountCurrency: 'USD', riskPerTrade: 0.01, maxOpenTrades: 5, minConfidence: 0.55, maxDailyLoss: 0.02,
  dailyProfitTarget: 0.05, consecutiveLossLimit: 3, cooldownMinutes: 60, mlRequired: false,
  symbols: ['BTCUSDT'], timeframes: ['H1'], scanInterval: 60_000, dbPath: ':memory:',
  mt5: { login: 0, password: '', server: '', bridgeUrl: '', bridgeApiKey: '' },
  binance: { apiKey: '', secret: '', env: 'testnet', futures: true },
  telegram: { token: '', chatId: '' }, compounding: { enabled: false, reinvestRate: 1 },
} as SystemConfig;

async function main() {
  const db = new DatabaseManager(':memory:');
  await db.initialize();
  const gateway = new RiskManager(cfg, db, { sendMessage: async () => {} } as any, { isActive: () => false } as any);
  db.createExecutionLedger({
    executionId: 'entry-gate-unknown', operationKey: 'entry-gate-op', action: 'CLOSE_AT_MARKET', status: 'UNKNOWN',
    symbol: 'BTCUSDT', side: 'BUY', volume: 0.01, request: { tradeId: 9001 },
  });
  const signal: Signal = {
    symbol: 'BTCUSDT', side: 'BUY', price: 50_000, confidence: 0.99, sl: 49_000, tp: 52_000,
    source: 'TEST', reason: 'entry-gate', timestamp: Date.now(), timeframe: 'H1',
  };
  const result = await gateway.check(signal, [], undefined, 10_000, 90);
  assert(result.passed === false, 'entry must be blocked while unresolved broker execution exists');
  assert(result.blockedBy === 'execution_reconciliation', 'entry must report the unresolved execution gate');
  assert(db.getExecutionByOperationKey('entry-gate-op').status === 'UNKNOWN', 'entry gate must not mutate unresolved ledger state');
  db.raw().close();
  console.log('Result: 1 passed, 0 failed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });