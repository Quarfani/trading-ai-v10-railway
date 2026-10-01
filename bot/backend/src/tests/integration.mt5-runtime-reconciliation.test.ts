import axios from 'axios';
import { DatabaseManager } from '../database/DatabaseManager';
import { Reconciler } from '../core/Reconciler';
import { SystemConfig } from '../types/trading.types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(): SystemConfig {
  return {
    mode: 'mt5', dataSource: 'mt5', accountCurrency: 'USD', accountBalance: 10_000, accountName: 'mt5-runtime-recon',
    riskPerTrade: 0.01, maxOpenTrades: 5, minConfidence: 0.55, maxDailyLoss: 0.02, dailyProfitTarget: 0.03,
    consecutiveLossLimit: 3, cooldownMinutes: 60, mlRequired: false, symbols: ['EURUSD'], timeframes: ['H1'], scanInterval: 60_000,
    dbPath: ':memory:', mt5: { login: 1, password: 'x', server: 'srv', bridgeUrl: 'http://mt5.test', bridgeApiKey: 'secret' },
    binance: { apiKey: '', secret: '', env: 'testnet', futures: true }, telegram: { token: '', chatId: '' },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

async function main() {
  const cfg = config();
  const originalGet = (axios as any).get;
  try {
    const db = new DatabaseManager(':memory:');
    await db.initialize();
    const tradeId = db.insertTrade({
      ticket: 7101, symbol: 'EURUSD', timeframe: 'H1', side: 'BUY', volume: 0.1, entry: 1.1, sl: 1.09, tp: 1.12,
      status: 'open', openedAt: Date.now(), source: 'MT5_RUNTIME_FULL',
    } as any);
    db.createExecutionLedger({
      executionId: 'mt5-runtime-close-1', operationKey: 'mt5-runtime-close-op', action: 'CLOSE_AT_MARKET', status: 'UNKNOWN',
      symbol: 'EURUSD', side: 'BUY', volume: 0.1, request: { tradeId, reason: 'MANUAL' },
    });
    (axios as any).get = async (url: string) => url.endsWith('/positions')
      ? { data: { ok: true, positions: [] } }
      : { data: { closed: true, remaining_volume: 0, close_price: 1.105, net_profit: 12.5, close_reason: 'manual' } };
    const rec = new Reconciler(
      cfg, db, {} as any, { sendMessage: async () => {} } as any, { recordClose: () => {} } as any,
      {} as any, { activate: async () => {} } as any, () => {},
    );
    await (rec as any).reconcileOne(db.getOpenTrades()[0]);
    assert(db.getExecutionByOperationKey('mt5-runtime-close-op').status === 'EXECUTED', 'runtime MT5 full close must resolve UNKNOWN');
    assert(db.getOpenTrades().length === 0, 'runtime MT5 full close must close the internal trade');
    assert(db.getRecentTrades(1)[0].profit === 12.5, 'runtime MT5 full close must persist authoritative PnL');
    db.raw().close();

    const partialDb = new DatabaseManager(':memory:');
    await partialDb.initialize();
    const partialTradeId = partialDb.insertTrade({
      ticket: 7102, symbol: 'EURUSD', timeframe: 'H1', side: 'BUY', volume: 1.0, entry: 1.1, sl: 1.09, tp: 1.12,
      status: 'open', openedAt: Date.now(), source: 'MT5_RUNTIME_PARTIAL',
    } as any);
    partialDb.createExecutionLedger({
      executionId: 'mt5-runtime-partial-1', operationKey: 'mt5-runtime-partial-op', action: 'PARTIAL_CLOSE', status: 'UNKNOWN',
      symbol: 'EURUSD', side: 'BUY', volume: 0.4, request: { tradeId: partialTradeId, volume: 0.4 },
    });
    (axios as any).get = async (url: string) => url.endsWith('/positions')
      ? { data: { ok: true, positions: [{ ticket: 7102, symbol: 'EURUSD', type: 'BUY', volume: 0.6, sl: 1.09, tp: 1.12 }] } }
      : { data: { closed: false, remaining_volume: 0.6, close_price: 1.105, net_profit: 4.25, close_reason: 'manual' } };
    const partialRec = new Reconciler(
      cfg, partialDb, {} as any, { sendMessage: async () => {} } as any, { recordClose: () => {} } as any,
      {} as any, { activate: async () => {} } as any, () => {},
    );
    await (partialRec as any).reconcileOne(partialDb.getOpenTrades()[0]);
    const partialLedger = partialDb.getExecutionByOperationKey('mt5-runtime-partial-op');
    const partialTrade = partialDb.getOpenTrades()[0];
    assert(partialLedger.status === 'EXECUTED', 'runtime MT5 partial close must resolve UNKNOWN');
    assert(partialTrade.volume === 0.6, 'runtime MT5 partial close must persist broker remaining volume');
    assert(partialTrade.realizedProfit === 4.25, 'runtime MT5 partial close must persist cumulative realized PnL');
    partialDb.raw().close();

    console.log('Result: 2 passed, 0 failed');
  } finally {
    (axios as any).get = originalGet;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });