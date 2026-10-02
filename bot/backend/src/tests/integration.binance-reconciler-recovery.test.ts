import { DatabaseManager } from "../database/DatabaseManager";
import { Reconciler } from "../core/Reconciler";
import { SystemConfig } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(): SystemConfig {
  return {
    mode: "binance", dataSource: "binance", accountCurrency: "USD",
    accountBalance: 10_000, accountName: "binance-recon-test",
    riskPerTrade: 0.01, maxOpenTrades: 5, minConfidence: 0.55,
    maxDailyLoss: 0.02, dailyProfitTarget: 0.05, consecutiveLossLimit: 3,
    cooldownMinutes: 60, mlRequired: false, symbols: ["BTCUSDT"], timeframes: ["H1"],
    scanInterval: 60_000, dbPath: ":memory:",
    mt5: { login: 0, password: "", server: "", bridgeUrl: "", bridgeApiKey: "" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

function makeReconciler(db: DatabaseManager, exec: any, onClose: () => void) {
  return new Reconciler(
    config(), db, exec,
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
    ticket: 9001, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 0.01,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(),
    source: "BINANCE_RECON_FULL",
  } as any);
  fullDb.createExecutionLedger({
    executionId: "binance-full-unknown", operationKey: "binance-full-op",
    action: "CLOSE", status: "UNKNOWN", symbol: "BTCUSDT", side: "BUY", volume: 0.01,
    request: { tradeId: fullTradeId },
  });

  let closeCalls = 0;
  let closedCallback = 0;
  const fullExec = {
    getBinancePosition: async () => ({ positionAmt: 0, entryPrice: 50_000, unrealizedProfit: 0 }),
    reconcileBinanceCloseOperation: async () => ({
      ok: true, orderId: 12301, executedQty: 0.01, remainingVolume: 0, realizedProfit: 25,
    }),
    closeTrade: async () => { closeCalls += 1; },
  };
  const fullReconciler = makeReconciler(fullDb, fullExec, () => { closedCallback += 1; });
  await (fullReconciler as any).reconcileOne(fullDb.getOpenTrades()[0]);
  assert(closeCalls === 0, "reconciliation must not issue a new Binance close order");
  assert(fullDb.getOpenTrades().length === 0, "recovered Binance full close must close the internal trade");
  assert(fullDb.getExecutionByOperationKey("binance-full-op").status === "EXECUTED", "full close ledger must resolve");
  assert(closedCallback === 1, "full close recovery must emit one close callback");
  assert((fullDb.getRecentClosedTrades(1)[0] as any).profit === 25, "full close must persist authoritative PnL");
  fullDb.raw().close();

  const partialDb = new DatabaseManager(":memory:");
  await partialDb.initialize();
  const partialTradeId = partialDb.insertTrade({
    ticket: 9002, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 0.01,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(),
    source: "BINANCE_RECON_PARTIAL",
  } as any);
  partialDb.createExecutionLedger({
    executionId: "binance-partial-unknown", operationKey: "binance-partial-op",
    action: "PARTIAL_CLOSE", status: "UNKNOWN", symbol: "BTCUSDT", side: "BUY", volume: 0.004,
    request: { tradeId: partialTradeId, volume: 0.004 },
  });
  const partialExec = {
    getBinancePosition: async () => ({ positionAmt: 0.006, entryPrice: 50_000, unrealizedProfit: 0 }),
    reconcileBinanceCloseOperation: async () => ({
      ok: true, orderId: 12302, executedQty: 0.004, remainingVolume: 0.006, realizedProfit: 7,
    }),
  };
  const partialReconciler = makeReconciler(partialDb, partialExec, () => {});
  await (partialReconciler as any).reconcileOne(partialDb.getOpenTrades()[0]);
  const partialTrade = partialDb.getOpenTrades()[0] as any;
  assert(partialTrade.volume === 0.006, "partial recovery must restore broker remaining volume");
  assert(partialTrade.realizedProfit === 7, "partial recovery must persist realized PnL");
  assert(partialDb.getExecutionByOperationKey("binance-partial-op").status === "EXECUTED", "partial ledger must resolve");
  partialDb.raw().close();

  const ambiguousDb = new DatabaseManager(":memory:");
  await ambiguousDb.initialize();
  const ambiguousTradeId = ambiguousDb.insertTrade({
    ticket: 9003, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 0.01,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(),
    source: "BINANCE_RECON_AMBIGUOUS",
  } as any);
  ambiguousDb.createExecutionLedger({
    executionId: "binance-ambiguous", operationKey: "binance-ambiguous-op",
    action: "CLOSE", status: "UNKNOWN", symbol: "BTCUSDT", side: "BUY", volume: 0.01,
    request: { tradeId: ambiguousTradeId },
  });
  const ambiguousExec = {
    getBinancePosition: async () => ({ positionAmt: 0, entryPrice: 50_000, unrealizedProfit: 0 }),
    reconcileBinanceCloseOperation: async () => null,
  };
  const ambiguousReconciler = makeReconciler(ambiguousDb, ambiguousExec, () => {});
  let blocked = false;
  try { await (ambiguousReconciler as any).reconcileOne(ambiguousDb.getOpenTrades()[0]); }
  catch { blocked = true; }
  assert(blocked, "ambiguous Binance close must stay fail-closed");
  assert(ambiguousDb.getExecutionByOperationKey("binance-ambiguous-op").status === "UNKNOWN", "ambiguous close must remain UNKNOWN");
  ambiguousDb.raw().close();

  const modifyDb = new DatabaseManager(":memory:");
  await modifyDb.initialize();
  const modifyTradeId = modifyDb.insertTrade({
    ticket: 9004, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 0.01,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(),
    source: "BINANCE_RECON_MODIFY",
  } as any);
  modifyDb.createExecutionLedger({
    executionId: "binance-modify-unknown", operationKey: "binance-modify-op",
    action: "MOVE_SL_TP", status: "UNKNOWN", symbol: "BTCUSDT", side: "BUY", volume: 0.01,
    request: { tradeId: modifyTradeId, newSl: 49_500, newTp: 51_500 },
  });
  let modifyRecoveryCalls = 0;
  const modifyExec = {
    getBinancePosition: async () => ({ positionAmt: 0.01, entryPrice: 50_000, unrealizedProfit: 0 }),
    reconcileBinanceProtectionModify: async () => {
      modifyRecoveryCalls += 1;
      return { slOrderId: 13001, tpOrderId: 13002 };
    },
  };
  const modifyReconciler = makeReconciler(modifyDb, modifyExec, () => {});
  await (modifyReconciler as any).reconcileOne(modifyDb.getOpenTrades()[0]);
  assert(modifyRecoveryCalls === 1, "Binance protection recovery must query broker state exactly once");
  const modifyLedger = modifyDb.getExecutionByOperationKey("binance-modify-op");
  const modified = modifyDb.getOpenTrades()[0] as any;
  assert(modifyLedger.status === "EXECUTED", "broker-confirmed Binance protection state must resolve UNKNOWN");
  assert(modified.sl === 49_500 && modified.tp === 51_500, "Binance protection recovery must persist broker levels");
  modifyDb.raw().close();

  const mismatchDb = new DatabaseManager(":memory:");
  await mismatchDb.initialize();
  const mismatchTradeId = mismatchDb.insertTrade({
    ticket: 9005, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 0.01,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(),
    source: "BINANCE_RECON_MODIFY_MISMATCH",
  } as any);
  mismatchDb.createExecutionLedger({
    executionId: "binance-modify-mismatch", operationKey: "binance-modify-mismatch-op",
    action: "MOVE_SL_TP", status: "UNKNOWN", symbol: "BTCUSDT", side: "BUY", volume: 0.01,
    request: { tradeId: mismatchTradeId, newSl: 49_500, newTp: 51_500 },
  });
  const mismatchExec = {
    getBinancePosition: async () => ({ positionAmt: 0.01, entryPrice: 50_000, unrealizedProfit: 0 }),
    reconcileBinanceProtectionModify: async () => null,
  };
  const mismatchReconciler = makeReconciler(mismatchDb, mismatchExec, () => {});
  let mismatchBlocked = false;
  try {
    await (mismatchReconciler as any).reconcileOne(mismatchDb.getOpenTrades()[0]);
  } catch {
    mismatchBlocked = true;
  }
  assert(mismatchBlocked, "ambiguous Binance protection recovery must stay blocked");
  assert(
    mismatchDb.getExecutionByOperationKey("binance-modify-mismatch-op").status === "UNKNOWN",
    "ambiguous protection modify must remain UNKNOWN",
  );
  mismatchDb.raw().close();

  const driftDb = new DatabaseManager(":memory:");
  await driftDb.initialize();
  const driftTradeId = driftDb.insertTrade({
    ticket: 9006, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 0.01,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(),
    source: "BINANCE_RECON_DRIFT",
  } as any);
  const driftExec = {
    getBinancePosition: async () => ({ positionAmt: -0.02, entryPrice: 50_000, unrealizedProfit: 0 }),
  };
  const driftReconciler = makeReconciler(driftDb, driftExec, () => {});
  let driftBlocked = false;
  try {
    await (driftReconciler as any).reconcileOne(driftDb.getOpenTrades()[0]);
  } catch {
    driftBlocked = true;
  }
  assert(driftBlocked, "unledgered Binance reverse/size drift must stay blocked");
  assert(driftDb.getOpenTrades()[0].volume === 0.01, "unledgered Binance drift must not mutate local volume");
  driftDb.raw().close();

  console.log("Result: 6 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
