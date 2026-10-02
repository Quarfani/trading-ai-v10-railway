import { BinanceExecutor, makeBinanceClientOrderId } from "../execution/BinanceExecutor";
import { DatabaseManager } from "../database/DatabaseManager";
import { Reconciler } from "../core/Reconciler";
import { TelegramBot } from "../notifications/TelegramBot";
import { PerformanceTracker } from "../analytics/PerformanceTracker";
import { EmergencyStop } from "../integration/EmergencyStop";
import { SystemConfig, Trade } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(): SystemConfig {
  return {
    mode: "binance",
    dataSource: "binance",
    accountBalance: 10_000,
    accountCurrency: "USD",
    accountName: "binance-recovery-test",
    riskPerTrade: 0.01,
    maxOpenTrades: 5,
    minConfidence: 0.55,
    maxDailyLoss: 0.2,
    maxWeeklyLoss: 0.5,
    dailyProfitTarget: 0.99,
    consecutiveLossLimit: 100,
    cooldownMinutes: 0,
    minRR: 1,
    maxSlippagePips: 100,
    maxDrawdown: 0.5,
    maxLeverage: 100,
    maxExposure: 100,
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

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 1,
    ticket: 7001,
    symbol: "BTCUSDT",
    timeframe: "H1",
    side: "BUY",
    volume: 1,
    entry: 50_000,
    sl: 49_000,
    tp: 52_000,
    status: "open",
    openedAt: Date.now(),
    source: "RECOVERY_TEST",
    realizedProfit: 0,
    ...overrides,
  } as Trade;
}

async function main() {
  const cfg = config();
  const createdAt = Date.now() - 30_000;
  const executor = new BinanceExecutor(cfg) as any;
  const expectedClientId = makeBinanceClientOrderId("recovery-op");

  let historyCalls = 0;
  const observedParams: any[] = [];
  executor.signedGet = async (path: string, params: any) => {
    assert(path === "/fapi/v1/allOrders", "historical recovery must use Binance futures allOrders");
    historyCalls += 1;
    observedParams.push(params);
    if (historyCalls === 1) {
      const page = new Array(1000).fill(null).map((_, i) => ({
        orderId: 10_000 + i,
        clientOrderId: "other",
        executedQty: "1",
        status: "FILLED",
        updateTime: createdAt + i,
      }));
      return page;
    }
    return [{
      orderId: 22_001,
      clientOrderId: expectedClientId,
      executedQty: "1",
      status: "FILLED",
      updateTime: createdAt + 5_000,
    }];
  };
  executor.getFuturesOrderNetPnl = async (symbol: string, orderId: number) => ({
    profit: 5,
    currency: "USDT",
  });
  executor.getAllPositions = async () => [];

  const full = await executor.reconcileFullCloseByClientOrderId(
    "BTCUSDT",
    expectedClientId,
    createdAt,
  );
  assert(full.ok === true, "historical full-close recovery must resolve a filled broker order");
  assert(full.orderId === 22_001, "full-close recovery must identify the exact broker order");
  assert(full.executedQty === 1, "full-close recovery must preserve broker executed quantity");
  assert(historyCalls === 2, "historical lookup must page through a full first page");
  assert(
    observedParams[0].startTime <= createdAt &&
    observedParams[0].startTime >= createdAt - 5 * 60_000,
    "historical lookup must use a bounded createdAt-derived start time",
  );

  executor.signedGet = async () => [{
    orderId: 22_002,
    clientOrderId: makeBinanceClientOrderId("partial-op"),
    executedQty: "0.4",
    status: "FILLED",
    updateTime: Date.now(),
  }];
  executor.getPosition = async () => ({
    symbol: "BTCUSDT",
    positionAmt: 0.6,
    entryPrice: 50_000,
    unrealizedProfit: 0,
  });
  const partial = await executor.reconcilePartialCloseByClientOrderId(
    "BTCUSDT",
    makeBinanceClientOrderId("partial-op"),
    Date.now() - 10_000,
  );
  assert(partial.ok === true, "historical partial-close recovery must resolve a filled broker order");
  assert(partial.executedQty === 0.4, "partial recovery must preserve executed quantity");
  assert(partial.remainingVolume === 0.6, "partial recovery must return broker remaining volume");

  executor.getAllPositions = async () => [{
    symbol: "BTCUSDT",
    positionAmt: 0.2,
    entryPrice: 50_000,
    unrealizedProfit: 0,
  }];
  const fullStillOpen = await executor.reconcileFullCloseByClientOrderId(
    "BTCUSDT",
    expectedClientId,
    createdAt,
  );
  assert(fullStillOpen.ok === false, "full-close recovery must fail when broker position remains open");

  executor.getPosition = async () => null;
  const partialWithoutPosition = await executor.reconcilePartialCloseByClientOrderId(
    "BTCUSDT",
    makeBinanceClientOrderId("partial-op"),
    Date.now() - 10_000,
  );
  assert(partialWithoutPosition.ok === false, "partial-close recovery must fail without post-fill position state");

  // Partial recovery must also verify the broker-reported executed quantity.
  const partialDb = new DatabaseManager(":memory:");
  await partialDb.initialize();
  const partialTradeId = partialDb.insertTrade({
    ...trade({ ticket: 8003, volume: 1 }),
  } as any);
  partialDb.createExecutionLedger({
    executionId: "reconcile-partial-1",
    operationKey: "reconcile-partial-op-1",
    action: "PARTIAL_CLOSE",
    status: "UNKNOWN",
    symbol: "BTCUSDT",
    side: "BUY",
    volume: 0.4,
    request: { tradeId: partialTradeId, volume: 0.4 },
  });
  const partialExec = {
    getBinancePosition: async () => ({ positionAmt: 0.6 }),
    reconcileBinancePartialClose: async () => ({
      ok: true,
      orderId: 31_002,
      executedQty: 0.2,
      remainingVolume: 0.6,
      realizedProfit: 2.5,
    }),
  };
  const partialReconciler = new Reconciler(
    cfg,
    partialDb,
    partialExec as any,
    new TelegramBot(cfg),
    tracker as PerformanceTracker,
    {} as any,
    {} as any,
    new EmergencyStop(new TelegramBot(cfg)),
    () => {},
  );
  let partialBlocked = false;
  try {
    await (partialReconciler as any).reconcileBinance({
      ...trade({ id: partialTradeId, ticket: 8003, volume: 1 }),
    });
  } catch {
    partialBlocked = true;
  }
  assert(partialBlocked, "partial recovery must block when executed quantity disagrees with the requested close");
  assert(
    partialDb.getExecutionByOperationKey("reconcile-partial-op-1").status === "UNKNOWN",
    "quantity-mismatched partial recovery must remain UNKNOWN",
  );
  assert(
    partialDb.getOpenTrades()[0].volume === 1,
    "quantity-mismatched partial recovery must not mutate trade volume",
  );
  partialDb.raw().close();

  // End-to-end Reconciler full-close recovery.
  const db = new DatabaseManager(":memory:");
  await db.initialize();
  const dbTradeId = db.insertTrade({
    ...trade({ ticket: 8001, volume: 0.01 }),
  } as any);
  db.createExecutionLedger({
    executionId: "reconcile-full-1",
    operationKey: "reconcile-full-op-1",
    action: "CLOSE_AT_MARKET",
    status: "UNKNOWN",
    symbol: "BTCUSDT",
    side: "BUY",
    volume: 0.01,
    request: { tradeId: dbTradeId, exitPrice: 51_000, reason: "MANUAL" },
  });

  const fakeExec = {
    getBinancePosition: async () => null,
    reconcileBinanceFullClose: async () => ({
      ok: true,
      orderId: 31_001,
      executedQty: 0.01,
      realizedProfit: 12.5,
    }),
  };
  const tracker = {
    recordClose: (_profit: number) => {},
  } as any;
  const onCloseCalls: Trade[] = [];
  const reconciler = new Reconciler(
    cfg,
    db,
    fakeExec as any,
    new TelegramBot(cfg),
    tracker as PerformanceTracker,
    {} as any,
    {} as any,
    new EmergencyStop(new TelegramBot(cfg)),
    (t) => onCloseCalls.push(t),
  );

  await (reconciler as any).reconcileBinance({
    ...trade({ id: dbTradeId, ticket: 8001, volume: 0.01 }),
  });
  const closed = db.raw().prepare(
    "SELECT status, profit FROM trades WHERE id=?",
  ).get(dbTradeId) as any;
  const ledger = db.getExecutionByOperationKey("reconcile-full-op-1");
  assert(closed.status === "closed" && closed.profit === 12.5, "Reconciler must atomically settle an attributable full close");
  assert(ledger.status === "EXECUTED", "Reconciler must resolve the attributable full-close ledger");
  assert(onCloseCalls.length === 1, "Reconciler must emit one close callback after recovery");

  // Duplicate unresolved closes must remain blocked and unmodified.
  const duplicateDb = new DatabaseManager(":memory:");
  await duplicateDb.initialize();
  const duplicateTradeId = duplicateDb.insertTrade({
    ...trade({ ticket: 8002, volume: 0.01 }),
  } as any);
  for (const [executionId, operationKey] of [
    ["dup-close-a", "dup-close-op-a"],
    ["dup-close-b", "dup-close-op-b"],
  ]) {
    duplicateDb.createExecutionLedger({
      executionId,
      operationKey,
      action: "CLOSE_AT_MARKET",
      status: "UNKNOWN",
      symbol: "BTCUSDT",
      side: "BUY",
      volume: 0.01,
      request: { tradeId: duplicateTradeId },
    });
  }
  const duplicateReconciler = new Reconciler(
    cfg,
    duplicateDb,
    fakeExec as any,
    new TelegramBot(cfg),
    tracker as PerformanceTracker,
    {} as any,
    {} as any,
    new EmergencyStop(new TelegramBot(cfg)),
    () => {},
  );
  let duplicateBlocked = false;
  try {
    await (duplicateReconciler as any).reconcileBinance({
      ...trade({ id: duplicateTradeId, ticket: 8002, volume: 0.01 }),
    });
  } catch {
    duplicateBlocked = true;
  }
  assert(duplicateBlocked, "multiple unresolved Binance closes must block automatic reconciliation");
  assert(
    duplicateDb.getExecutionByOperationKey("dup-close-op-a").status === "UNKNOWN" &&
    duplicateDb.getExecutionByOperationKey("dup-close-op-b").status === "UNKNOWN",
    "duplicate Binance close recovery must not resolve either operation",
  );
  assert(
    duplicateDb.getOpenTrades()[0].status === "open",
    "duplicate Binance close recovery must not mutate the trade",
  );

  db.raw().close();
  duplicateDb.raw().close();

  console.log("Result: 7 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
