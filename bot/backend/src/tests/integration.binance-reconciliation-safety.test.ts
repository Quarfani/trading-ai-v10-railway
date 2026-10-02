import { Reconciler } from "../core/Reconciler";
import { DatabaseManager } from "../database/DatabaseManager";
import { SystemConfig } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(): SystemConfig {
  return {
    mode: "binance",
    dataSource: "binance",
    accountCurrency: "USD",
    accountBalance: 10_000,
    accountName: "binance-recon-test",
    riskPerTrade: 0.01,
    maxOpenTrades: 5,
    minConfidence: 0.55,
    maxDailyLoss: 0.02,
    dailyProfitTarget: 0.03,
    consecutiveLossLimit: 3,
    cooldownMinutes: 60,
    mlRequired: false,
    symbols: ["BTCUSDT"],
    timeframes: ["H1"],
    scanInterval: 60_000,
    dbPath: ":memory:",
    mt5: { login: 0, password: "", server: "", bridgeUrl: "", bridgeApiKey: "" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

function makeReconciler(db: DatabaseManager, exec: any, onClose = () => {}) {
  return new Reconciler(
    config(),
    db,
    exec,
    { sendMessage: async () => {} } as any,
    { recordClose: () => {} } as any,
    {} as any,
    { activate: async () => {} } as any,
    onClose,
  );
}

async function main() {
  const fullDb = new DatabaseManager(":memory:");
  await fullDb.initialize();
  const fullTradeId = fullDb.insertTrade({
    ticket: 501,
    symbol: "BTCUSDT",
    timeframe: "H1",
    side: "BUY",
    volume: 1,
    entry: 100,
    sl: 90,
    tp: 120,
    status: "open",
    openedAt: Date.now(),
    source: "BINANCE_RECON_TEST",
  } as any);
  fullDb.createExecutionLedger({
    executionId: "binance-full-1",
    operationKey: "binance-full-op",
    action: "CLOSE_AT_MARKET",
    status: "UNKNOWN",
    symbol: "BTCUSDT",
    side: "BUY",
    volume: 1,
    request: { tradeId: fullTradeId, exitPrice: 101, reason: "MANUAL" },
  });

  let closedCallbacks = 0;
  const fullExec = {
    getBinancePosition: async () => null,
    recoverBinanceExecution: async (symbol: string, operationKey: string) => {
      assert(symbol === "BTCUSDT", "full recovery must use the trade symbol");
      assert(operationKey === "binance-full-op", "full recovery must use the exact operation key");
      return {
        orderId: 7001,
        status: "FILLED",
        executedQty: 1,
        avgPrice: 101,
        realizedProfit: 12.5,
      };
    },
  };
  await (makeReconciler(fullDb, fullExec, () => { closedCallbacks += 1; }) as any).reconcileOne(fullDb.getOpenTrades()[0]);

  const fullTrade = fullDb.raw()
    .prepare("SELECT status, profit, closedAt FROM trades WHERE id=?")
    .get(fullTradeId) as any;
  const fullLedger = fullDb.getExecutionByOperationKey("binance-full-op");
  assert(fullTrade.status === "closed" && fullTrade.profit === 12.5, "Binance full recovery must close the local trade with authoritative PnL");
  assert(fullLedger.status === "EXECUTED", "Binance full recovery must resolve the UNKNOWN ledger");
  assert(fullLedger.brokerOrderId === "7001", "Binance full recovery must persist broker order identity");
  assert(closedCallbacks === 1, "successful Binance recovery must emit exactly one close callback");
  fullDb.raw().close();

  const partialDb = new DatabaseManager(":memory:");
  await partialDb.initialize();
  const partialTradeId = partialDb.insertTrade({
    ticket: 502,
    symbol: "BTCUSDT",
    timeframe: "H1",
    side: "BUY",
    volume: 1,
    entry: 100,
    sl: 90,
    tp: 120,
    status: "open",
    openedAt: Date.now(),
    source: "BINANCE_RECON_PARTIAL",
    realizedProfit: 2,
  } as any);
  partialDb.createExecutionLedger({
    executionId: "binance-partial-1",
    operationKey: "binance-partial-op",
    action: "PARTIAL_CLOSE",
    status: "UNKNOWN",
    symbol: "BTCUSDT",
    side: "BUY",
    volume: 0.4,
    request: { tradeId: partialTradeId, volume: 0.4, exitPrice: 101, reason: "PARTIAL" },
  });

  const partialExec = {
    getBinancePosition: async () => ({
      positionAmt: 0.6,
      entryPrice: 100,
      unrealizedProfit: 0,
    }),
    recoverBinanceExecution: async (_symbol: string, operationKey: string) => {
      assert(operationKey === "binance-partial-op", "partial recovery must use the exact operation key");
      return {
        orderId: 7002,
        status: "FILLED",
        executedQty: 0.4,
        avgPrice: 101,
        realizedProfit: 3,
      };
    },
  };
  await (makeReconciler(partialDb, partialExec) as any).reconcileOne(partialDb.getOpenTrades()[0]);

  const partialTrade = partialDb.raw()
    .prepare("SELECT volume, realizedProfit FROM trades WHERE id=?")
    .get(partialTradeId) as any;
  const partialLedger = partialDb.getExecutionByOperationKey("binance-partial-op");
  assert(partialTrade.volume === 0.6, "Binance partial recovery must persist authoritative remaining volume");
  assert(partialTrade.realizedProfit === 5, "Binance partial recovery must preserve cumulative realized PnL");
  assert(partialLedger.status === "EXECUTED", "Binance partial recovery must resolve the UNKNOWN ledger");
  assert(partialLedger.brokerOrderId === "7002", "Binance partial recovery must persist broker order identity");
  partialDb.raw().close();

  const modifyDb = new DatabaseManager(":memory:");
  await modifyDb.initialize();
  const modifyTradeId = modifyDb.insertTrade({
    ticket: 504,
    symbol: "BTCUSDT",
    timeframe: "H1",
    side: "BUY",
    volume: 1,
    entry: 100,
    sl: 90,
    tp: 120,
    status: "open",
    openedAt: Date.now(),
    source: "BINANCE_RECON_MODIFY",
  } as any);
  modifyDb.createExecutionLedger({
    executionId: "binance-modify-1",
    operationKey: "binance-modify-op",
    action: "MOVE_SL_TP",
    status: "UNKNOWN",
    symbol: "BTCUSDT",
    side: "BUY",
    volume: 1,
    request: { tradeId: modifyTradeId, newSl: 95, newTp: 110 },
  });

  const modifyExec = {
    getBinancePosition: async () => ({
      positionAmt: 1,
      entryPrice: 100,
      unrealizedProfit: 0,
    }),
    recoverBinanceProtection: async (symbol: string, operationKey: string) => {
      assert(symbol === "BTCUSDT", "protective-order recovery must use the trade symbol");
      assert(operationKey === "binance-modify-op", "protective-order recovery must use the exact operation key");
      return {
        sl: { orderId: 7101, side: "SELL", type: "STOP_MARKET", stopPrice: "95", status: "NEW" },
        tp: { orderId: 7102, side: "SELL", type: "TAKE_PROFIT_MARKET", stopPrice: "110", status: "NEW" },
      };
    },
  };
  await (makeReconciler(modifyDb, modifyExec) as any).reconcileOne(modifyDb.getOpenTrades()[0]);
  const modifyLedger = modifyDb.getExecutionByOperationKey("binance-modify-op");
  assert(modifyLedger.status === "EXECUTED", "verified Binance protective orders must resolve MOVE_SL_TP");
  modifyDb.raw().close();

  const modifyBlockedDb = new DatabaseManager(":memory:");
  await modifyBlockedDb.initialize();
  const modifyBlockedTradeId = modifyBlockedDb.insertTrade({
    ticket: 505,
    symbol: "BTCUSDT",
    timeframe: "H1",
    side: "BUY",
    volume: 1,
    entry: 100,
    sl: 90,
    tp: 120,
    status: "open",
    openedAt: Date.now(),
    source: "BINANCE_RECON_MODIFY_BLOCK",
  } as any);
  modifyBlockedDb.createExecutionLedger({
    executionId: "binance-modify-blocked-1",
    operationKey: "binance-modify-blocked-op",
    action: "MOVE_SL_TP",
    status: "UNKNOWN",
    symbol: "BTCUSDT",
    side: "BUY",
    volume: 1,
    request: { tradeId: modifyBlockedTradeId, newSl: 95, newTp: 110 },
  });
  const modifyBlockedExec = {
    getBinancePosition: async () => ({
      positionAmt: 1,
      entryPrice: 100,
      unrealizedProfit: 0,
    }),
    recoverBinanceProtection: async () => ({
      sl: { orderId: 7103, side: "SELL", type: "STOP_MARKET", stopPrice: "95", status: "NEW" },
      tp: null,
    }),
  };
  let modifyBlocked = false;
  try {
    await (makeReconciler(modifyBlockedDb, modifyBlockedExec) as any).reconcileOne(modifyBlockedDb.getOpenTrades()[0]);
  } catch {
    modifyBlocked = true;
  }
  assert(modifyBlocked, "missing one Binance protective leg must block the trade");
  assert(
    modifyBlockedDb.getExecutionByOperationKey("binance-modify-blocked-op").status === "UNKNOWN",
    "incomplete Binance protective state must preserve UNKNOWN",
  );
  modifyBlockedDb.raw().close();

  const blockedDb = new DatabaseManager(":memory:");
  await blockedDb.initialize();
  const blockedTradeId = blockedDb.insertTrade({
    ticket: 503,
    symbol: "BTCUSDT",
    timeframe: "H1",
    side: "BUY",
    volume: 1,
    entry: 100,
    sl: 90,
    tp: 120,
    status: "open",
    openedAt: Date.now(),
    source: "BINANCE_RECON_BLOCK",
  } as any);
  blockedDb.createExecutionLedger({
    executionId: "binance-blocked-1",
    operationKey: "binance-blocked-op",
    action: "CLOSE",
    status: "UNKNOWN",
    symbol: "BTCUSDT",
    side: "BUY",
    volume: 1,
    request: { tradeId: blockedTradeId },
  });

  const blockedExec = {
    getBinancePosition: async () => null,
    recoverBinanceExecution: async () => ({
      orderId: 7003,
      status: "FILLED",
      executedQty: 1,
      avgPrice: 101,
      realizedProfit: null,
    }),
  };

  let blocked = false;
  try {
    await (makeReconciler(blockedDb, blockedExec) as any).reconcileOne(blockedDb.getOpenTrades()[0]);
  } catch {
    blocked = true;
  }
  assert(blocked, "Binance close without authoritative PnL must remain blocked");
  assert(blockedDb.getOpenTrades().length === 1, "ambiguous Binance close must not mutate the local trade");
  assert(
    blockedDb.getExecutionByOperationKey("binance-blocked-op").status === "UNKNOWN",
    "ambiguous Binance close must preserve UNKNOWN execution state",
  );
  blockedDb.raw().close();

  console.log("Result: 18 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
