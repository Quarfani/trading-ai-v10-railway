import axios from 'axios';
import { DatabaseManager } from '../database/DatabaseManager';
import { StartupReconciler } from '../integration/StartupReconciler';
import { TelegramBot } from '../notifications/TelegramBot';
import { SystemConfig } from '../types/trading.types';
import { BinanceExecutor, makeBinanceClientOrderId } from '../execution/BinanceExecutor';

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

  const binanceCfg = {
    ...config(),
    mode: 'binance',
    dataSource: 'binance',
    accountCurrency: 'USD',
    binance: { ...config().binance, futures: true },
  } as SystemConfig;

  const binanceRecoverDb = await newDb();
  const binanceRecoverTradeId = binanceRecoverDb.insertTrade({
    ticket: 501, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 0.01,
    entry: 50000, sl: 49000, tp: 52000, status: 'open', openedAt: Date.now(), source: 'BINANCE_RECOVERY_TEST',
  });
  binanceRecoverDb.createExecutionLedger({
    executionId: 'binance-close-unknown-1', operationKey: 'binance-close-op-1',
    action: 'CLOSE_AT_MARKET', status: 'UNKNOWN', symbol: 'BTCUSDT', side: 'BUY', volume: 0.01,
    request: { tradeId: binanceRecoverTradeId, exitPrice: 51000, reason: 'MANUAL' },
  });
  const fakeFilledExecutor = {
    reconcileFuturesCloseByClientOrderId: async () => ({
      found: true, status: 'FILLED', orderId: 9001, executedQty: 0.01,
      realizedProfit: 125, realizedProfitCurrency: 'USDT',
    }),
    getPosition: async () => null,
  } as any;
  const binanceRecover = new StartupReconciler(binanceCfg, binanceRecoverDb, new TelegramBot(binanceCfg));
  assert(
    makeBinanceClientOrderId('binance-close-unknown-1').startsWith('ta_'),
    'Binance recovery must derive the deterministic client order id from the ledger execution id',
  );
  await (binanceRecover as any).resolveAuthoritativeBinanceCloseLedgers(fakeFilledExecutor);
  assert(
    binanceRecoverDb.getExecutionByOperationKey('binance-close-op-1').status === 'EXECUTED',
    'FILLED Binance close must resolve the UNKNOWN ledger',
  );
  assert(binanceRecoverDb.getOpenTrades().length === 0, 'FILLED Binance close must settle the internal trade atomically');
  assert(
    binanceRecoverDb.getExecutionByOperationKey('binance-close-op-1').brokerOrderId === '9001',
    'Binance recovery must preserve the broker order id',
  );
  binanceRecoverDb.raw().close();

  const binanceCanceledDb = await newDb();
  const canceledTradeId = binanceCanceledDb.insertTrade({
    ticket: 502, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 0.01,
    entry: 50000, sl: 49000, tp: 52000, status: 'open', openedAt: Date.now(), source: 'BINANCE_RECOVERY_CANCEL_TEST',
  });
  binanceCanceledDb.createExecutionLedger({
    executionId: 'binance-close-canceled', operationKey: 'binance-close-canceled-op',
    action: 'CLOSE', status: 'UNKNOWN', symbol: 'BTCUSDT', side: 'BUY', volume: 0.01,
    request: { tradeId: canceledTradeId },
  });
  const fakeCanceledExecutor = {
    reconcileFuturesCloseByClientOrderId: async () => ({ found: true, status: 'CANCELED', orderId: 9002, executedQty: 0 }),
  } as any;
  const canceledRecover = new StartupReconciler(binanceCfg, binanceCanceledDb, new TelegramBot(binanceCfg));
  await (canceledRecover as any).resolveAuthoritativeBinanceCloseLedgers(fakeCanceledExecutor);
  assert(
    binanceCanceledDb.getExecutionByOperationKey('binance-close-canceled-op').status === 'FAILED',
    'authoritative Binance CANCELED close must become FAILED instead of remaining UNKNOWN',
  );
  assert(binanceCanceledDb.getOpenTrades().length === 1, 'canceled Binance close must not close the internal trade');
  binanceCanceledDb.raw().close();

  const binancePartialDb = await newDb();
  const partialCloseTradeId = binancePartialDb.insertTrade({
    ticket: 503, symbol: 'BTCUSDT', timeframe: 'H1', side: 'BUY', volume: 0.01,
    entry: 50000, sl: 49000, tp: 52000, status: 'open', openedAt: Date.now(), source: 'BINANCE_RECOVERY_PARTIAL_TEST',
  });
  binancePartialDb.createExecutionLedger({
    executionId: 'binance-close-partial', operationKey: 'binance-close-partial-op',
    action: 'CLOSE_AT_MARKET', status: 'UNKNOWN', symbol: 'BTCUSDT', side: 'BUY', volume: 0.01,
    request: { tradeId: partialCloseTradeId },
  });
  const fakePartialExecutor = {
    reconcileFuturesCloseByClientOrderId: async () => ({
      found: true, status: 'PARTIALLY_FILLED', orderId: 9003, executedQty: 0.004,
      realizedProfit: 50, realizedProfitCurrency: 'USDT',
    }),
    getPosition: async () => ({ positionAmt: 0.006, entryPrice: 50000, unrealizedProfit: 0 }),
  } as any;
  const partialRecover = new StartupReconciler(binanceCfg, binancePartialDb, new TelegramBot(binanceCfg));
  await (partialRecover as any).resolveAuthoritativeBinanceCloseLedgers(fakePartialExecutor);
  assert(
    binancePartialDb.getExecutionByOperationKey('binance-close-partial-op').status === 'UNKNOWN',
    'PARTIALLY_FILLED Binance close must remain UNKNOWN until final broker state is authoritative',
  );
  assert(binancePartialDb.getOpenTrades().length === 1, 'partial Binance close must not pretend the trade is fully closed');
  binancePartialDb.raw().close();
  console.log('Result: 27 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
