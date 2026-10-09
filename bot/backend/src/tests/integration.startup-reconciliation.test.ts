import axios from 'axios';
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

  const mt5Cfg = {
    ...config(),
    mode: 'mt5',
    dataSource: 'mt5',
    symbols: ['EURUSD'],
    mt5: { login: 1, password: 'x', server: 'srv', bridgeUrl: 'http://mt5.test', bridgeApiKey: 'secret' },
  } as SystemConfig;

  const originalAxiosGet = axios.get;
  try {
    const mt5ModifyStartupDb = await newDb();
  const mt5ModifyStartupTradeId = mt5ModifyStartupDb.insertTrade({
    ticket: 84, symbol: 'EURUSD', timeframe: 'H1', side: 'BUY', volume: 0.1,
    entry: 1.1000, sl: 1.0900, tp: 1.1200, status: 'open', openedAt: Date.now(), source: 'TEST',
  });
  mt5ModifyStartupDb.createExecutionLedger({
    executionId: 'mt5-modify-startup',
    operationKey: 'mt5-modify-startup-op',
    action: 'MOVE_SL_TP',
    status: 'UNKNOWN',
    symbol: 'EURUSD',
    side: 'BUY',
    volume: 0.1,
    request: { tradeId: mt5ModifyStartupTradeId, newSl: 1.095, newTp: 1.115 },
  });
  (axios.get as any) = async (url: string) => {
    if (url.endsWith('/positions')) {
      return {
        data: {
          ok: true,
          positions: [{
            ticket: 84, symbol: 'EURUSD', type: 'BUY', volume: 0.1,
            sl: 1.095, tp: 1.115,
          }],
        },
      };
    }
    throw new Error('unexpected URL');
  };
  await new StartupReconciler(
    mt5Cfg,
    mt5ModifyStartupDb,
    new TelegramBot(mt5Cfg),
  ).run();
  assert(
    mt5ModifyStartupDb.getExecutionByOperationKey('mt5-modify-startup-op').status === 'EXECUTED',
    'MT5 startup reconciliation must resolve a verifiable MOVE_SL_TP operation',
  );
  assert(
    mt5ModifyStartupDb.getOpenTrades()[0].sl === 1.095 &&
    mt5ModifyStartupDb.getOpenTrades()[0].tp === 1.115,
    'MT5 startup protective recovery must persist the broker SL/TP values',
  );
  mt5ModifyStartupDb.raw().close();

  const mt5CloseDb = await newDb();
    const tradeId = mt5CloseDb.insertTrade({
      ticket: 77, symbol: 'EURUSD', timeframe: 'H1', side: 'BUY', volume: 0.1,
      entry: 1.1000, sl: 1.0900, tp: 1.1200, status: 'open', openedAt: Date.now(), source: 'TEST',
    });
    mt5CloseDb.createExecutionLedger({
      executionId: 'mt5-close-unknown', operationKey: 'mt5-close-op',
      action: 'CLOSE_AT_MARKET', status: 'UNKNOWN', symbol: 'EURUSD', side: 'BUY', volume: 0.1,
      request: { tradeId, exitPrice: 1.105, reason: 'MANUAL' },
    });

    (axios.get as any) = async (url: string) => {
      if (url.endsWith('/positions')) return { data: { ok: true, positions: [] } };
      if (url.endsWith('/history')) {
        return {
          data: {
            closed: true, remaining_volume: 0, close_price: 1.105,
            net_profit: 12.5, close_reason: 'manual',
          },
        };
      }
      throw new Error('unexpected URL');
    };

    await new StartupReconciler(mt5Cfg, mt5CloseDb, new TelegramBot(mt5Cfg)).run();
    const resolvedLedger = mt5CloseDb.getExecutionByOperationKey('mt5-close-op');
    assert(resolvedLedger.status === 'EXECUTED', 'authoritative MT5 close must clear UNKNOWN before startup completes');
    assert(mt5CloseDb.getOpenTrades().length === 0, 'authoritative MT5 close must close the internal trade before startup completes');
    mt5CloseDb.raw().close();

    const mt5StaleHistoryDb = await newDb();
    const staleTradeId = mt5StaleHistoryDb.insertTrade({
      ticket: 83, symbol: 'EURUSD', timeframe: 'H1', side: 'BUY', volume: 0.1,
      entry: 1.1000, sl: 1.0900, tp: 1.1200, status: 'open', openedAt: Date.now(), source: 'TEST',
    });
    mt5StaleHistoryDb.createExecutionLedger({
      executionId: 'mt5-stale-close', operationKey: 'mt5-stale-close-op',
      action: 'CLOSE_AT_MARKET', status: 'UNKNOWN', symbol: 'EURUSD', side: 'BUY', volume: 0.1,
      request: { tradeId: staleTradeId },
    });
    const staleCreated = mt5StaleHistoryDb.raw()
      .prepare('UPDATE execution_ledger SET createdAt=? WHERE executionId=?')
      .run(Date.now(), 'mt5-stale-close').changes;
    assert(staleCreated === 1, 'stale history fixture must persist operation timestamp');
    (axios.get as any) = async (url: string) => {
      if (url.endsWith('/positions')) return { data: { ok: true, positions: [] } };
      if (url.endsWith('/history')) return {
        data: {
          closed: true, remaining_volume: 0, close_price: 1.105,
          net_profit: 12.5, close_reason: 'manual', close_time_msc: Date.now() - 60 * 60 * 1000,
        },
      };
      throw new Error('unexpected URL');
    };
    let staleBlocked = false;
    try {
      await new StartupReconciler(mt5Cfg, mt5StaleHistoryDb, new TelegramBot(mt5Cfg)).run();
    } catch { staleBlocked = true; }
    assert(staleBlocked, 'broker history predating UNKNOWN close operation must block startup');
    assert(
      mt5StaleHistoryDb.getOpenTrades().length === 1,
      'stale close history must not close the internal trade',
    );
    assert(
      mt5StaleHistoryDb.getExecutionByOperationKey('mt5-stale-close-op').status === 'UNKNOWN',
      'stale close history must leave the execution UNKNOWN',
    );
    mt5StaleHistoryDb.raw().close();

    const mt5CloseDuplicateRestartDb = await newDb();
    const duplicateCloseRestartTradeId = mt5CloseDuplicateRestartDb.insertTrade({
      ticket: 82, symbol: 'EURUSD', timeframe: 'H1', side: 'BUY', volume: 0.1,
      entry: 1.1000, sl: 1.0900, tp: 1.1200, status: 'open', openedAt: Date.now(), source: 'TEST',
    });
    mt5CloseDuplicateRestartDb.createExecutionLedger({
      executionId: 'mt5-close-restart-a', operationKey: 'mt5-close-restart-a-op',
      action: 'CLOSE_AT_MARKET', status: 'UNKNOWN', symbol: 'EURUSD', side: 'BUY', volume: 0.1,
      request: { tradeId: duplicateCloseRestartTradeId },
    });
    mt5CloseDuplicateRestartDb.createExecutionLedger({
      executionId: 'mt5-close-restart-b', operationKey: 'mt5-close-restart-b-op',
      action: 'CLOSE', status: 'UNKNOWN', symbol: 'EURUSD', side: 'BUY', volume: 0.1,
      request: { tradeId: duplicateCloseRestartTradeId },
    });

    (axios.get as any) = async (url: string) => {
      if (url.endsWith('/positions')) return { data: { ok: true, positions: [] } };
      if (url.endsWith('/history')) return {
        data: { closed: true, remaining_volume: 0, close_price: 1.105, net_profit: 12.5, close_reason: 'manual' },
      };
      throw new Error('unexpected URL');
    };

    let firstCloseDuplicateBlocked = false;
    try {
      await new StartupReconciler(mt5Cfg, mt5CloseDuplicateRestartDb, new TelegramBot(mt5Cfg)).run();
    } catch { firstCloseDuplicateBlocked = true; }
    assert(firstCloseDuplicateBlocked, 'duplicate MT5 full-close operations must block after resolving one operation');
    assert(mt5CloseDuplicateRestartDb.getExecutionByOperationKey('mt5-close-restart-a-op').status === 'EXECUTED', 'first close must resolve');
    assert(mt5CloseDuplicateRestartDb.getExecutionByOperationKey('mt5-close-restart-b-op').status === 'UNKNOWN', 'second close must remain UNKNOWN');

    let secondCloseDuplicateBlocked = false;
    try {
      await new StartupReconciler(mt5Cfg, mt5CloseDuplicateRestartDb, new TelegramBot(mt5Cfg)).run();
    } catch { secondCloseDuplicateBlocked = true; }
    assert(secondCloseDuplicateBlocked, 'duplicate MT5 full-close must remain blocked across restart');
    assert(
      mt5CloseDuplicateRestartDb.getExecutionByOperationKey('mt5-close-restart-b-op').status === 'UNKNOWN',
      'second close must not auto-resolve on later restart',
    );
    mt5CloseDuplicateRestartDb.raw().close();

    const mt5PartialDb = await newDb();
    const partialTradeId = mt5PartialDb.insertTrade({
      ticket: 79, symbol: 'EURUSD', timeframe: 'H1', side: 'BUY', volume: 1.0,
      entry: 1.1000, sl: 1.0900, tp: 1.1200, status: 'open', openedAt: Date.now(), source: 'TEST',
    });
    mt5PartialDb.createExecutionLedger({
      executionId: 'mt5-partial-unknown', operationKey: 'mt5-partial-op',
      action: 'PARTIAL_CLOSE', status: 'UNKNOWN', symbol: 'EURUSD', side: 'BUY', volume: 0.4,
      request: { tradeId: partialTradeId, volume: 0.4, exitPrice: 1.105, reason: 'PARTIAL' },
    });

    (axios.get as any) = async (url: string) => {
      if (url.endsWith('/positions')) {
        return {
          data: {
            ok: true,
            positions: [{
              ticket: 79, symbol: 'EURUSD', type: 'BUY', volume: 0.6,
              sl: 1.09, tp: 1.12,
            }],
          },
        };
      }
      if (url.endsWith('/history')) {
        return {
          data: {
            closed: false, remaining_volume: 0.6, close_price: 1.105,
            net_profit: 4.25, close_reason: 'manual', close_deal_ticket: 12345,
          },
        };
      }
      throw new Error('unexpected URL');
    };

    await new StartupReconciler(mt5Cfg, mt5PartialDb, new TelegramBot(mt5Cfg)).run();
    const partialLedger = mt5PartialDb.getExecutionByOperationKey('mt5-partial-op');
    const partialTrade = mt5PartialDb.getOpenTrades()[0];
    assert(partialLedger.status === 'EXECUTED', 'authoritative MT5 partial close must clear UNKNOWN before startup completes');
    assert(partialTrade.volume === 0.6, 'authoritative MT5 partial close must restore broker remaining volume');
    assert(partialTrade.realizedProfit === 4.25, 'authoritative MT5 partial close must preserve cumulative realized PnL');
    mt5PartialDb.raw().close();

    const mt5PartialMismatchDb = await newDb();
    const mismatchTradeId = mt5PartialMismatchDb.insertTrade({
      ticket: 80, symbol: 'EURUSD', timeframe: 'H1', side: 'BUY', volume: 1.0,
      entry: 1.1000, sl: 1.0900, tp: 1.1200, status: 'open', openedAt: Date.now(), source: 'TEST',
    });
    mt5PartialMismatchDb.createExecutionLedger({
      executionId: 'mt5-partial-mismatch', operationKey: 'mt5-partial-mismatch-op',
      action: 'PARTIAL_CLOSE', status: 'UNKNOWN', symbol: 'EURUSD', side: 'BUY', volume: 0.4,
      request: { tradeId: mismatchTradeId, volume: 0.4, exitPrice: 1.105, reason: 'PARTIAL' },
    });
    (axios.get as any) = async (url: string) => {
      if (url.endsWith('/positions')) {
        return { data: { ok: true, positions: [{
          ticket: 80, symbol: 'EURUSD', type: 'BUY', volume: 0.6, sl: 1.09, tp: 1.12,
        }] } };
      }
      if (url.endsWith('/history')) {
        return { data: {
          closed: false, remaining_volume: 0.7, close_price: 1.105,
          net_profit: 4.25, close_reason: 'manual', close_deal_ticket: 12346,
        } };
      }
      throw new Error('unexpected URL');
    };
    let mismatchBlocked = false;
    try {
      await new StartupReconciler(mt5Cfg, mt5PartialMismatchDb, new TelegramBot(mt5Cfg)).run();
    } catch { mismatchBlocked = true; }
    assert(mismatchBlocked, 'conflicting MT5 partial position/history state must block startup');
    assert(
      mt5PartialMismatchDb.getOpenTrades()[0].volume === 1.0,
      'conflicting MT5 partial state must not mutate internal volume',
    );
    assert(
      mt5PartialMismatchDb.getExecutionByOperationKey('mt5-partial-mismatch-op').status === 'UNKNOWN',
      'conflicting MT5 partial state must remain unresolved',
    );
    mt5PartialMismatchDb.raw().close();

    const mt5DuplicateDb = await newDb();
    const duplicateTradeId = mt5DuplicateDb.insertTrade({
      ticket: 78, symbol: 'EURUSD', timeframe: 'H1', side: 'BUY', volume: 0.1,
      entry: 1.1000, sl: 1.0900, tp: 1.1200, status: 'open', openedAt: Date.now(), source: 'TEST',
    });
    mt5DuplicateDb.createExecutionLedger({
      executionId: 'mt5-close-unknown-a', operationKey: 'mt5-close-op-a',
      action: 'CLOSE_AT_MARKET', status: 'UNKNOWN', symbol: 'EURUSD', side: 'BUY', volume: 0.1,
      request: { tradeId: duplicateTradeId, exitPrice: 1.105, reason: 'MANUAL' },
    });
    mt5DuplicateDb.createExecutionLedger({
      executionId: 'mt5-close-unknown-b', operationKey: 'mt5-close-op-b',
      action: 'CLOSE', status: 'UNKNOWN', symbol: 'EURUSD', side: 'BUY', volume: 0.1,
      request: { tradeId: duplicateTradeId },
    });

    // DUPLICATE_CLOSE_HISTORY_MOCK
    (axios.get as any) = async (url: string) => {
      if (url.endsWith('/positions')) {
        return { data: { ok: true, positions: [] } };
      }
      if (url.endsWith('/history')) {
        return { data: {
          ok: true,
          closed: true,
          remaining_volume: 0,
          close_price: 1.105,
          net_profit: 12.5,
          close_reason: 'manual',
          close_time_msc: Date.now(),
        } };
      }
      throw new Error('unexpected URL');
    };

    const duplicateReconciler = new StartupReconciler(
      mt5Cfg,
      mt5DuplicateDb,
      new TelegramBot(mt5Cfg),
    );
    const duplicateHistory = await (duplicateReconciler as any).getMT5HistoryEntry(78);
    assert(
      duplicateHistory?.profit === 12.5 && duplicateHistory?.closed === undefined,
      'MT5 history fixture must be accepted as an authoritative close entry',
    );

    let duplicateBlocked = false;
    try {
      await duplicateReconciler.run();
    } catch { duplicateBlocked = true; }
    assert(duplicateBlocked, 'multiple unresolved MT5 close operations for one trade must remain a startup blocker');
    const duplicateUnresolved = mt5DuplicateDb.raw().prepare(
      `SELECT COUNT(*) c FROM execution_ledger
       WHERE operationKey IN ('mt5-close-op-a','mt5-close-op-b')
         AND status IN ('PENDING','UNKNOWN')`,
    ).get().c;
    if (duplicateUnresolved !== 1) {
      const state = mt5DuplicateDb.raw().prepare(
        `SELECT operationKey, executionId, action, status, requestJson FROM execution_ledger
         WHERE operationKey IN ('mt5-close-op-a','mt5-close-op-b')
         ORDER BY operationKey`,
      ).all();
      const trade = mt5DuplicateDb.raw().prepare(
        'SELECT id, status, profit, closedAt FROM trades WHERE id=?',
      ).get(duplicateTradeId);
      throw new Error(
        'duplicate MT5 close state=' + JSON.stringify({ duplicateUnresolved, state, trade }),
      );
    }
    assert(
      mt5DuplicateDb.getExecutionByOperationKey('mt5-close-op-a').status === 'EXECUTED',
      'earliest duplicate MT5 close operation must be the one reconciled',
    );
    assert(mt5DuplicateDb.getOpenTrades().length === 0, 'duplicate-close recovery may settle the internal trade once');
    mt5DuplicateDb.raw().close();

    const mt5PartialDuplicateDb = await newDb();
    const duplicatePartialTradeId = mt5PartialDuplicateDb.insertTrade({
      ticket: 81, symbol: 'EURUSD', timeframe: 'H1', side: 'BUY', volume: 1.0,
      entry: 1.1000, sl: 1.0900, tp: 1.1200, status: 'open', openedAt: Date.now(), source: 'TEST',
    });
    mt5PartialDuplicateDb.createExecutionLedger({
      executionId: 'mt5-partial-a', operationKey: 'mt5-partial-a-op',
      action: 'PARTIAL_CLOSE', status: 'UNKNOWN', symbol: 'EURUSD', side: 'BUY', volume: 0.4,
      request: { tradeId: duplicatePartialTradeId, volume: 0.4 },
    });
    mt5PartialDuplicateDb.createExecutionLedger({
      executionId: 'mt5-partial-b', operationKey: 'mt5-partial-b-op',
      action: 'PARTIAL_CLOSE', status: 'UNKNOWN', symbol: 'EURUSD', side: 'BUY', volume: 0.4,
      request: { tradeId: duplicatePartialTradeId, volume: 0.4 },
    });

    (axios.get as any) = async (url: string) => {
      if (url.endsWith('/positions')) {
        return { data: { ok: true, positions: [{
          ticket: 81, symbol: 'EURUSD', type: 'BUY', volume: 0.6, sl: 1.09, tp: 1.12,
        }] } };
      }
      if (url.endsWith('/history')) {
        return { data: {
          closed: false, remaining_volume: 0.6, close_price: 1.105,
          net_profit: 4.25, close_reason: 'manual', close_deal_ticket: 12347,
        } };
      }
      throw new Error('unexpected URL');
    };

    let firstDuplicateBlocked = false;
    try {
      await new StartupReconciler(mt5Cfg, mt5PartialDuplicateDb, new TelegramBot(mt5Cfg)).run();
    } catch { firstDuplicateBlocked = true; }
    assert(firstDuplicateBlocked, 'duplicate MT5 partial operations must block after resolving only one');
    assert(
      mt5PartialDuplicateDb.getExecutionByOperationKey('mt5-partial-a-op').status === 'EXECUTED',
      'first MT5 partial operation should resolve',
    );
    assert(
      mt5PartialDuplicateDb.getExecutionByOperationKey('mt5-partial-b-op').status === 'UNKNOWN',
      'second MT5 partial operation should remain UNKNOWN',
    );
    assert(mt5PartialDuplicateDb.getOpenTrades()[0].volume === 0.6, 'first partial recovery should persist broker remaining volume');

    let secondDuplicateBlocked = false;
    try {
      await new StartupReconciler(mt5Cfg, mt5PartialDuplicateDb, new TelegramBot(mt5Cfg)).run();
    } catch { secondDuplicateBlocked = true; }
    assert(secondDuplicateBlocked, 'duplicate MT5 partial must remain blocked across restart');
    assert(
      mt5PartialDuplicateDb.getExecutionByOperationKey('mt5-partial-b-op').status === 'UNKNOWN',
      'duplicate MT5 partial must not auto-resolve on a later restart',
    );
    mt5PartialDuplicateDb.raw().close();

    const mt5OpenDb = await newDb();
    mt5OpenDb.createExecutionLedger({
      executionId: 'mt5-open-unknown', operationKey: 'mt5-open-op',
      action: 'OPEN', status: 'UNKNOWN', symbol: 'EURUSD', side: 'BUY', volume: 0.1,
    });
    let mt5OpenBlocked = false;
    try {
      await new StartupReconciler(mt5Cfg, mt5OpenDb, new TelegramBot(mt5Cfg)).run();
    } catch { mt5OpenBlocked = true; }
    assert(mt5OpenBlocked, 'ambiguous MT5 OPEN must remain a startup blocker');
    mt5OpenDb.raw().close();
  } finally {
    axios.get = originalAxiosGet;
  }

  const binanceRecoveryDb = await newDb();
  const binanceRecoveryTradeId = binanceRecoveryDb.insertTrade({
    ticket: 601, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 1,
    entry: 100, sl: 90, tp: 120, status: 'open', openedAt: Date.now(), source: 'TEST',
  });
  binanceRecoveryDb.createExecutionLedger({
    executionId: 'binance-startup-close',
    operationKey: 'binance-startup-close-op',
    action: 'CLOSE_AT_MARKET',
    status: 'UNKNOWN',
    symbol: 'BTCUSDT',
    side: 'BUY',
    volume: 1,
    request: { tradeId: binanceRecoveryTradeId, exitPrice: 101, reason: 'MANUAL' },
  });

  const futuresCfg = { ...config(), mode: 'binance' } as SystemConfig;
  const originalFuturesPing = (BinanceExecutor.prototype as any).ping;
  const originalGetAllPositions = (BinanceExecutor.prototype as any).getAllPositions;
  const originalRecoverOperation = (BinanceExecutor.prototype as any).recoverOperation;
  try {
    (BinanceExecutor.prototype as any).ping = async () => true;
    (BinanceExecutor.prototype as any).getAllPositions = async () => [];
    (BinanceExecutor.prototype as any).recoverOperation = async (symbol: string, operationKey: string) => {
      assert(symbol === 'BTCUSDT', 'startup Binance recovery must use the trade symbol');
      assert(operationKey === 'binance-startup-close-op', 'startup Binance recovery must use the exact operation key');
      return {
        orderId: 9911,
        status: 'FILLED',
        executedQty: 1,
        avgPrice: 101,
        realizedProfit: 14.5,
        realizedProfitCurrency: 'USDT',
      };
    };
    await new StartupReconciler(
      futuresCfg,
      binanceRecoveryDb,
      new TelegramBot(futuresCfg),
    ).run();
    assert(
      binanceRecoveryDb.getOpenTrades().length === 0,
      'startup reconciliation must settle a recoverable Binance full close',
    );
    const startupBinanceLedger = binanceRecoveryDb.getExecutionByOperationKey('binance-startup-close-op');
    assert(
      startupBinanceLedger.status === 'EXECUTED' &&
      startupBinanceLedger.brokerOrderId === '9911',
      'startup Binance reconciliation must resolve the exact broker operation',
    );
  } finally {
    (BinanceExecutor.prototype as any).ping = originalFuturesPing;
    (BinanceExecutor.prototype as any).getAllPositions = originalGetAllPositions;
    (BinanceExecutor.prototype as any).recoverOperation = originalRecoverOperation;
    binanceRecoveryDb.raw().close();
  }

  const binanceModifyDb = await newDb();
  const binanceModifyTradeId = binanceModifyDb.insertTrade({
    ticket: 602, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 1,
    entry: 100, sl: 90, tp: 120, status: 'open', openedAt: Date.now(), source: 'TEST',
  });
  const binanceModifyOpenSignal = {
    symbol: 'BTCUSDT',
    side: 'BUY',
    timestamp: Date.now() - 1000,
    price: 100,
    sl: 90,
    tp: 120,
    source: 'TEST',
  };
  binanceModifyDb.createExecutionLedger({
    executionId: 'binance-startup-modify-open',
    operationKey: 'binance-startup-modify-open-op',
    action: 'OPEN',
    status: 'EXECUTED',
    symbol: 'BTCUSDT',
    side: 'BUY',
    volume: 1,
    request: { tradeId: binanceModifyTradeId, timeframe: 'H1', signal: binanceModifyOpenSignal, volume: 1 },
  });
  binanceModifyDb.createExecutionLedger({
    executionId: 'binance-startup-modify',
    operationKey: 'binance-startup-modify-op',
    action: 'MOVE_SL_TP',
    status: 'UNKNOWN',
    symbol: 'BTCUSDT',
    side: 'BUY',
    volume: 1,
    request: { tradeId: binanceModifyTradeId, newSl: 95, newTp: 110 },
  });

  const originalModifyGetAllPositions = (BinanceExecutor.prototype as any).getAllPositions;
  const originalModifyGetOpenOrders = (BinanceExecutor.prototype as any).getOpenOrders;
  const originalModifyGetOpenAlgoOrders = (BinanceExecutor.prototype as any).getOpenAlgoOrders;
  const originalModifyRecoverProtection = (BinanceExecutor.prototype as any).recoverProtectionByOperation;
  const originalModifyCancelProtection = (BinanceExecutor.prototype as any).cancelProtectionByOperationKey;
  try {
    (BinanceExecutor.prototype as any).ping = async () => true;
    (BinanceExecutor.prototype as any).getAllPositions = async () => [{
      symbol: 'BTCUSDT',
      positionAmt: 1,
      entryPrice: 100,
      unrealizedProfit: 0,
    }];
    (BinanceExecutor.prototype as any).getOpenOrders = async () => [];
    const modifyProbe = new BinanceExecutor(futuresCfg);
    const modifySlClientId = (modifyProbe as any).makeProtectionClientOrderId('binance-startup-modify-op', 'SL');
    const modifyTpClientId = (modifyProbe as any).makeProtectionClientOrderId('binance-startup-modify-op', 'TP');
    (BinanceExecutor.prototype as any).getOpenAlgoOrders = async (symbol: string) => {
      assert(symbol === 'BTCUSDT', 'startup Algo-order verification must use the trade symbol');
      return [
        { symbol, orderId: 9921, clientOrderId: modifySlClientId, side: 'SELL', type: 'STOP_MARKET', closePosition: true, stopPrice: '95', status: 'NEW' },
        { symbol, orderId: 9922, clientOrderId: modifyTpClientId, side: 'SELL', type: 'TAKE_PROFIT_MARKET', closePosition: true, stopPrice: '110', status: 'NEW' },
      ];
    };
    (BinanceExecutor.prototype as any).recoverProtectionByOperation = async (symbol: string, operationKey: string) => {
      assert(symbol === 'BTCUSDT', 'startup protection recovery must use the trade symbol');
      assert(operationKey === 'binance-startup-modify-op', 'startup protection recovery must use the exact operation key');
      return {
        sl: { orderId: 9921, clientOrderId: modifySlClientId, side: 'SELL', type: 'STOP_MARKET', closePosition: true, stopPrice: '95', status: 'NEW' },
        tp: { orderId: 9922, clientOrderId: modifyTpClientId, side: 'SELL', type: 'TAKE_PROFIT_MARKET', closePosition: true, stopPrice: '110', status: 'NEW' },
      };
    };
    (BinanceExecutor.prototype as any).cancelProtectionByOperationKey = async (
      symbol: string,
      entrySide: string,
      operationKey: string,
    ) => {
      assert(symbol === 'BTCUSDT', 'prior Algo protection cancellation must use the trade symbol');
      assert(entrySide === 'BUY', 'prior Algo protection cancellation must preserve entry side');
      assert(operationKey === 'binance-startup-modify-open-op', 'startup must retire only the original OPEN protection pair');
    };
    await new StartupReconciler(
      futuresCfg,
      binanceModifyDb,
      new TelegramBot(futuresCfg),
    ).run();
    assert(
      binanceModifyDb.getExecutionByOperationKey('binance-startup-modify-op').status === 'EXECUTED',
      'startup reconciliation must resolve verifiable Binance MOVE_SL_TP operations',
    );
    assert(
      binanceModifyDb.getOpenTrades().length === 1,
      'resolving Binance MOVE_SL_TP must keep the broker-backed trade open',
    );
  } finally {
    (BinanceExecutor.prototype as any).ping = originalFuturesPing;
    (BinanceExecutor.prototype as any).getAllPositions = originalModifyGetAllPositions;
    (BinanceExecutor.prototype as any).getOpenOrders = originalModifyGetOpenOrders;
    (BinanceExecutor.prototype as any).getOpenAlgoOrders = originalModifyGetOpenAlgoOrders;
    (BinanceExecutor.prototype as any).recoverProtectionByOperation = originalModifyRecoverProtection;
    (BinanceExecutor.prototype as any).cancelProtectionByOperationKey = originalModifyCancelProtection;
    binanceModifyDb.raw().close();
  }

  const interruptedProtectionDb = await newDb();
  const interruptedProtectionTradeId = interruptedProtectionDb.insertTrade({
    ticket: 603, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 1,
    entry: 100, sl: 90, tp: 120, status: 'open', openedAt: Date.now(), source: 'TEST',
  });
  interruptedProtectionDb.createExecutionLedger({
    executionId: 'binance-interrupted-open',
    operationKey: 'binance-interrupted-open-op',
    action: 'OPEN',
    status: 'EXECUTED',
    symbol: 'BTCUSDT',
    side: 'BUY',
    volume: 1,
    request: { tradeId: interruptedProtectionTradeId, volume: 1 },
  });
  const interruptedModifyKey = 'binance-interrupted-modify-op';
  const interruptedRestoreKey = `PROTECTION_RESTORE:${interruptedModifyKey}:binance-interrupted-open-op`;
  const interruptedProbe = new BinanceExecutor(futuresCfg);
  const interruptedIds = (key: string) => ({
    sl: (interruptedProbe as any).makeProtectionClientOrderId(key, 'SL'),
    tp: (interruptedProbe as any).makeProtectionClientOrderId(key, 'TP'),
  });
  const interruptedOldIds = interruptedIds('binance-interrupted-open-op');
  const interruptedNewIds = interruptedIds(interruptedModifyKey);
  interruptedProtectionDb.createExecutionLedger({
    executionId: 'binance-interrupted-modify',
    operationKey: interruptedModifyKey,
    action: 'MOVE_SL_TP',
    status: 'UNKNOWN',
    symbol: 'BTCUSDT',
    side: 'BUY',
    volume: 1,
    request: {
      tradeId: interruptedProtectionTradeId,
      newSl: 95,
      newTp: 110,
      schemaVersion: 1,
      symbol: 'BTCUSDT',
      ticket: 603,
      positionSide: 'BUY',
      quantity: 1,
      oldProtectionKey: 'binance-interrupted-open-op',
      newProtectionKey: interruptedModifyKey,
      restoreProtectionKey: interruptedRestoreKey,
      phase: 'NEW_PAIR_REQUESTED',
      activeProtectionKey: null,
      oldProtection: {
        slClientAlgoId: interruptedOldIds.sl,
        tpClientAlgoId: interruptedOldIds.tp,
        slAlgoId: 9301,
        tpAlgoId: 9302,
        slPrice: 90,
        tpPrice: 120,
      },
      requestedProtection: {
        slPrice: 95,
        tpPrice: 110,
        slClientAlgoId: interruptedNewIds.sl,
        tpClientAlgoId: interruptedNewIds.tp,
      },
    },
  });

  const interruptedOriginalPing = (BinanceExecutor.prototype as any).ping;
  const interruptedOriginalPositions = (BinanceExecutor.prototype as any).getAllPositions;
  const interruptedOriginalOpenOrders = (BinanceExecutor.prototype as any).getOpenOrders;
  const interruptedOriginalAlgoOrders = (BinanceExecutor.prototype as any).getOpenAlgoOrders;
  const interruptedOriginalRecover = (BinanceExecutor.prototype as any).recoverProtectionByOperation;
  const interruptedOriginalCancel = (BinanceExecutor.prototype as any).cancelProtectionByOperationKey;
  const interruptedOriginalRestore = (BinanceExecutor.prototype as any).restoreProtectionPairForReconciliation;
  const interruptedPairs = new Map<string, { sl: any; tp: any }>();
  let interruptedOpenAlgoOrders: any[] = [];
  let restorationCalls = 0;
  const makeInterruptedPair = (key: string, slPrice: number, tpPrice: number) => {
    const ids = interruptedIds(key);
    const pair = {
      sl: { symbol: 'BTCUSDT', orderId: 9401, clientOrderId: ids.sl, side: 'SELL', type: 'STOP_MARKET', closePosition: true, stopPrice: String(slPrice), status: 'NEW' },
      tp: { symbol: 'BTCUSDT', orderId: 9402, clientOrderId: ids.tp, side: 'SELL', type: 'TAKE_PROFIT_MARKET', closePosition: true, stopPrice: String(tpPrice), status: 'NEW' },
    };
    interruptedPairs.set(key, pair);
    interruptedOpenAlgoOrders = [...interruptedOpenAlgoOrders.filter((order: any) =>
      order.clientOrderId !== ids.sl && order.clientOrderId !== ids.tp,
    ), pair.sl, pair.tp];
    return pair;
  };
  try {
    (BinanceExecutor.prototype as any).ping = async () => true;
    (BinanceExecutor.prototype as any).getAllPositions = async () => [{
      symbol: 'BTCUSDT', positionAmt: 1, entryPrice: 100, unrealizedProfit: 0,
    }];
    (BinanceExecutor.prototype as any).getOpenOrders = async () => [];
    (BinanceExecutor.prototype as any).getOpenAlgoOrders = async (symbol: string) => {
      assert(symbol === 'BTCUSDT', 'interrupted protection recovery must query the exact symbol');
      return interruptedOpenAlgoOrders;
    };
    (BinanceExecutor.prototype as any).recoverProtectionByOperation = async (symbol: string, key: string) => {
      assert(symbol === 'BTCUSDT', 'interrupted protection recovery must use the trade symbol');
      return interruptedPairs.get(key) ?? { sl: null, tp: null };
    };
    (BinanceExecutor.prototype as any).cancelProtectionByOperationKey = async (
      symbol: string,
      side: string,
      key: string,
    ) => {
      assert(symbol === 'BTCUSDT', 'interrupted protection cancellation must use the trade symbol');
      assert(side === 'BUY', 'interrupted protection cancellation must preserve the position side');
      const ids = interruptedIds(key);
      interruptedOpenAlgoOrders = interruptedOpenAlgoOrders.filter((order: any) =>
        order.clientOrderId !== ids.sl && order.clientOrderId !== ids.tp,
      );
      interruptedPairs.delete(key);
    };
    (BinanceExecutor.prototype as any).restoreProtectionPairForReconciliation = async (
      ticket: number,
      symbol: string,
      side: string,
      quantity: number,
      key: string,
      slPrice: number,
      tpPrice: number,
    ) => {
      restorationCalls += 1;
      assert(ticket === 603 && symbol === 'BTCUSDT' && side === 'BUY' && quantity === 1,
        'startup restoration must use the original position identity and quantity');
      assert(key === interruptedRestoreKey && slPrice === 90 && tpPrice === 120,
        'startup restoration must use a deterministic key and the original protection targets');
      makeInterruptedPair(key, slPrice, tpPrice);
      return true;
    };

    await new StartupReconciler(
      futuresCfg,
      interruptedProtectionDb,
      new TelegramBot(futuresCfg),
    ).run();

    const interruptedLedger = interruptedProtectionDb.getExecutionByOperationKey(interruptedModifyKey);
    const restoredTrade = interruptedProtectionDb.getOpenTrades().find((trade: any) => trade.id === interruptedProtectionTradeId);
    assert(interruptedLedger.status === 'FAILED',
      'interrupted Binance modification must settle as failed after prior protection is restored');
    assert(restorationCalls === 1,
      'startup must invoke restoration exactly once when both requested and prior pairs are absent');
    assert(restoredTrade?.sl === 90 && restoredTrade?.tp === 120,
      'restoring prior protection must not persist the failed requested targets');
    assert(interruptedPairs.has(interruptedRestoreKey),
      'restored protection must remain under its deterministic restoration identity');
  } finally {
    (BinanceExecutor.prototype as any).ping = interruptedOriginalPing;
    (BinanceExecutor.prototype as any).getAllPositions = interruptedOriginalPositions;
    (BinanceExecutor.prototype as any).getOpenOrders = interruptedOriginalOpenOrders;
    (BinanceExecutor.prototype as any).getOpenAlgoOrders = interruptedOriginalAlgoOrders;
    (BinanceExecutor.prototype as any).recoverProtectionByOperation = interruptedOriginalRecover;
    (BinanceExecutor.prototype as any).cancelProtectionByOperationKey = interruptedOriginalCancel;
    (BinanceExecutor.prototype as any).restoreProtectionPairForReconciliation = interruptedOriginalRestore;
    interruptedProtectionDb.raw().close();
  }

  const spotCfg = { ...config(), mode: 'binance', dataSource: 'binance', binance: { ...config().binance, futures: false } } as SystemConfig;
  const originalPing = (BinanceExecutor.prototype as any).ping;
  const originalBalances = (BinanceExecutor.prototype as any).getAllSpotBalancesForConfiguredSymbols;
  const originalSpotOcoRecovery = (BinanceExecutor.prototype as any).recoverSpotOcoByOperation;
  const originalSpotOpenOrders = (BinanceExecutor.prototype as any).getOpenOrders;
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
    const spotTradeId = spotOpen.insertTrade({
      ticket: 9, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 0.1,
      entry: 100, sl: 90, tp: 120, status: 'open', openedAt: Date.now(), source: 'TEST',
    });
    spotOpen.createExecutionLedger({
      executionId: 'spot-startup-open',
      operationKey: 'spot-startup-open-op',
      action: 'OPEN',
      status: 'EXECUTED',
      symbol: 'BTCUSDT',
      side: 'BUY',
      volume: 0.1,
      request: { tradeId: spotTradeId, volume: 0.1 },
    });
    (BinanceExecutor.prototype as any).getAllSpotBalancesForConfiguredSymbols = async () => [
      { asset: 'BTC', free: 0.1, locked: 0 },
      { asset: 'USDT', free: 1000, locked: 0 },
    ];
    (BinanceExecutor.prototype as any).recoverSpotOcoByOperation = async (
      symbol: string,
      operationKey: string,
    ) => {
      assert(symbol === 'BTCUSDT', 'Spot startup OCO recovery must use trade symbol');
      assert(operationKey === 'spot-startup-open-op', 'Spot startup OCO recovery must use exact OPEN operation key');
      return {
        orderListId: 9001,
        listStatusType: 'EXEC_STARTED',
        listOrderStatus: 'EXECUTING',
        orders: [
          { symbol: 'BTCUSDT', orderId: 9101, clientOrderId: 'tp' },
          { symbol: 'BTCUSDT', orderId: 9102, clientOrderId: 'sl' },
        ],
      };
    };
    (BinanceExecutor.prototype as any).getOpenOrders = async (symbol: string) => {
      assert(symbol === 'BTCUSDT', 'Spot startup open-order verification must use trade symbol');
      return [
        {
          orderId: 9101, side: 'SELL', type: 'LIMIT_MAKER', status: 'NEW',
          origQty: '0.1', price: '120',
        },
        {
          orderId: 9102, side: 'SELL', type: 'STOP_LOSS_LIMIT', status: 'NEW',
          origQty: '0.1', stopPrice: '90', price: '89.95',
        },
      ];
    };

    await new StartupReconciler(
      spotCfg,
      spotOpen,
      new TelegramBot(spotCfg),
    ).run();
    assert(
      spotOpen.getOpenTrades().length === 1,
      'verifiable Binance Spot OCO protection must allow startup to continue',
    );

    const spotMissingProtection = await newDb();
    const missingTradeId = spotMissingProtection.insertTrade({
      ticket: 10, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 0.1,
      entry: 100, sl: 90, tp: 120, status: 'open', openedAt: Date.now(), source: 'TEST',
    });
    spotMissingProtection.createExecutionLedger({
      executionId: 'spot-startup-missing',
      operationKey: 'spot-startup-missing-op',
      action: 'OPEN',
      status: 'EXECUTED',
      symbol: 'BTCUSDT',
      side: 'BUY',
      volume: 0.1,
      request: { tradeId: missingTradeId, volume: 0.1 },
    });
    (BinanceExecutor.prototype as any).getAllSpotBalancesForConfiguredSymbols = async () => [
      { asset: 'BTC', free: 0.1, locked: 0 },
      { asset: 'USDT', free: 1000, locked: 0 },
    ];
    (BinanceExecutor.prototype as any).recoverSpotOcoByOperation = async () => null;
    let missingBlocked = false;
    try {
      await new StartupReconciler(
        spotCfg,
        spotMissingProtection,
        new TelegramBot(spotCfg),
      ).run();
    } catch {
      missingBlocked = true;
    }
    assert(
      missingBlocked,
      'missing Binance Spot OCO protection must block startup',
    );

  } finally {
    (BinanceExecutor.prototype as any).ping = originalPing;
    (BinanceExecutor.prototype as any).getAllSpotBalancesForConfiguredSymbols = originalBalances;
    (BinanceExecutor.prototype as any).recoverSpotOcoByOperation = originalSpotOcoRecovery;
    (BinanceExecutor.prototype as any).getOpenOrders = originalSpotOpenOrders;
  }

  console.log('Result: 36 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
