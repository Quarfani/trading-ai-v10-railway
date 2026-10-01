import { BinanceExecutor, makeBinanceClientOrderId } from "../execution/BinanceExecutor";
import { ExecutionGateway } from "../execution/ExecutionGateway";
import { Reconciler } from "../core/Reconciler";
import { DatabaseManager } from "../database/DatabaseManager";
import { SystemConfig } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(accountCurrency = "USD"): SystemConfig {
  return {
    mode: "binance",
    dataSource: "binance",
    accountCurrency,
    accountBalance: 10_000,
    accountName: "binance-recovery-test",
    riskPerTrade: 0.01,
    maxOpenTrades: 5,
    minConfidence: 0.55,
    maxDailyLoss: 0.02,
    dailyProfitTarget: 0.05,
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

async function main() {
  const operationKey = "partial-close-operation-key";
  const clientId = makeBinanceClientOrderId(operationKey);
  assert(clientId === makeBinanceClientOrderId(operationKey), "client order id must be deterministic");
  assert(clientId.length <= 32, "client order id must respect Binance length limits");

  const executor = new BinanceExecutor(config());
  const seen: Record<string, unknown> = {};
  (executor as any).signedPost = async (_path: string, body: Record<string, unknown>) => {
    seen.body = body;
    return { orderId: 70001 };
  };
  (executor as any).getPosition = async () => ({
    positionAmt: 0.6,
    entryPrice: 50_000,
    unrealizedProfit: 0,
  });
  (executor as any).getFuturesOrderNetPnl = async () => ({
    profit: 7.5,
    currency: "USDT",
  });

  const placed = await executor.closePartialPosition(9001, "BTCUSDT", 0.4, clientId);
  assert(placed.ok === true, "partial close with deterministic client id must succeed");
  assert(seen.body?.newClientOrderId === clientId, "partial close must send deterministic client order id");
  assert(placed.remainingVolume === 0.6, "partial close must return authoritative remaining volume");
  assert(placed.realizedProfit === 7.5, "partial close must return authoritative realized PnL");

  const recovered = new BinanceExecutor(config());
  (recovered as any).signedGet = async (path: string, params: Record<string, unknown>) => {
    if (path === "/fapi/v1/allOrders") {
      assert(Number.isFinite(Number(params.startTime)), "historical lookup must use a bounded time window");
      assert(Number.isFinite(Number(params.endTime)), "historical lookup must include an end time");
      assert(params.limit === 1000, "historical lookup must request the full bounded order page");
      return [{
        symbol: "BTCUSDT",
        orderId: 70001,
        clientOrderId: clientId,
        status: "FILLED",
        executedQty: "0.4",
      }];
    }
    throw new Error("unexpected signed GET");
  };
  (recovered as any).getPosition = async () => ({
    positionAmt: 0.6,
    entryPrice: 50_000,
    unrealizedProfit: 0,
  });
  (recovered as any).getFuturesOrderNetPnl = async (symbol: string, orderId: number) => {
    assert(symbol === "BTCUSDT" && orderId === 70001, "fill lookup must use recovered historical order");
    return { profit: 7.5, currency: "USDT" };
  };
  const recoveredResult = await recovered.reconcilePartialCloseByClientOrderId(
    "BTCUSDT",
    clientId,
    Date.now() - 30_000,
  );
  assert(recoveredResult.ok === true, "historical partial-close recovery must succeed");
  assert(recoveredResult.orderId === 70001, "historical recovery must preserve broker order id");
  assert(recoveredResult.executedQty === 0.4, "historical recovery must preserve executed quantity");
  assert(recoveredResult.remainingVolume === 0.6, "historical recovery must return live remaining position");
  assert(recoveredResult.realizedProfit === 7.5, "historical recovery must return fill PnL");

  const noOrder = await recovered.reconcilePartialCloseByClientOrderId(
    "BTCUSDT",
    makeBinanceClientOrderId("missing"),
    Date.now() - 30_000,
  );
  assert(noOrder.ok === false, "missing historical client order must fail closed");

  const db = new DatabaseManager(":memory:");
  await db.initialize();
  const gateway = new ExecutionGateway(config("EUR"), db, {
    getRate: async (currency: string) => currency === "USDT" ? 0.92 : null,
  } as any);
  (gateway as any).binance = recovered;
  const accountRecovered = await gateway.reconcileBinancePartialClose(
    operationKey,
    "BTCUSDT",
  );
  assert(accountRecovered.ok === true, "gateway recovery must succeed");
  assert(Math.abs(accountRecovered.realizedProfit - 6.9) < 1e-9, "gateway recovery must normalize PnL into account currency");
  db.raw().close();

  const reconDb = new DatabaseManager(":memory:");
  await reconDb.initialize();
  const reconTradeId = reconDb.insertTrade({
    ticket: 9100, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 1,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(),
    source: "BINANCE_RUNTIME_RECOVERY",
  } as any);
  reconDb.createExecutionLedger({
    executionId: "binance-partial-unknown",
    operationKey: operationKey,
    action: "PARTIAL_CLOSE",
    status: "UNKNOWN",
    symbol: "BTCUSDT",
    side: "BUY",
    volume: 0.4,
    request: { tradeId: reconTradeId, volume: 0.4 },
  });

  const reconcilerExec = {
    getBinancePosition: async () => ({
      positionAmt: 0.6,
      entryPrice: 50_000,
      unrealizedProfit: 0,
    }),
    reconcileBinancePartialClose: async (opKey: string, symbol: string) => {
      assert(opKey === operationKey && symbol === "BTCUSDT", "reconciler must use durable operation identity");
      return {
        ok: true,
        orderId: 70001,
        executedQty: 0.4,
        remainingVolume: 0.6,
        realizedProfit: 7.5,
      };
    },
  } as any;
  const reconciler = new Reconciler(
    config(),
    reconDb,
    reconcilerExec,
    { sendMessage: async () => {} } as any,
    { recordClose: () => {} } as any,
    {} as any,
    { activate: async () => {} } as any,
    () => {},
  );
  await (reconciler as any).reconcileOne(reconDb.getOpenTrades()[0]);

  const reconciledTrade = reconDb.getOpenTrades()[0];
  const reconciledLedger = reconDb.getExecutionByOperationKey(operationKey);
  assert(reconciledTrade.volume === 0.6, "reconciler must persist broker-confirmed remaining Binance volume");
  assert(reconciledTrade.realizedProfit === 7.5, "reconciler must persist cumulative realized PnL");
  assert(reconciledLedger.status === "EXECUTED", "reconciler must resolve UNKNOWN Binance partial ledger");
  assert(JSON.parse(reconciledLedger.resultJson).orderId === 70001, "reconciler must persist recovered broker order id");
  reconDb.raw().close();

  const fullExecutor = new BinanceExecutor(config());
  let fullClientOrderId: string | undefined;
  (fullExecutor as any).signedPost = async (_path: string, body: Record<string, unknown>) => {
    fullClientOrderId = String(body.newClientOrderId ?? "");
    return { orderId: 70002 };
  };
  (fullExecutor as any).getPosition = async () => ({
    positionAmt: 1,
    entryPrice: 50_000,
    unrealizedProfit: 0,
  });
  (fullExecutor as any).getFuturesOrderNetPnl = async () => ({
    profit: 11,
    currency: "USDT",
  });
  const fullPlaced = await fullExecutor.closePosition(
    9200,
    "BTCUSDT",
    1,
    "BUY",
    makeBinanceClientOrderId("full-close-operation-key"),
  );
  assert(fullPlaced.ok === true, "Binance full close must succeed");
  assert(fullPlaced.orderId === 70002, "Binance full close must return broker order id");
  assert(
    fullClientOrderId === makeBinanceClientOrderId("full-close-operation-key"),
    "Binance full close must send deterministic client order id",
  );

  const fullRecovered = new BinanceExecutor(config());
  (fullRecovered as any).signedGet = async (path: string, params: Record<string, unknown>) => {
    if (path === "/fapi/v1/allOrders") {
      assert(Number.isFinite(Number(params.startTime)), "full-close lookup must use a bounded time window");
      assert(Number.isFinite(Number(params.endTime)), "full-close lookup must include an end time");
      assert(params.limit === 1000, "full-close lookup must request the full bounded order page");
      return [{
        symbol: "BTCUSDT",
        orderId: 70002,
        clientOrderId: makeBinanceClientOrderId("full-close-operation-key"),
        status: "FILLED",
        executedQty: "1",
      }];
    }
    throw new Error("unexpected signed GET");
  };
  (fullRecovered as any).getAllPositions = async () => [];
  (fullRecovered as any).getFuturesOrderNetPnl = async (symbol: string, orderId: number) => {
    assert(symbol === "BTCUSDT" && orderId === 70002, "full recovery must use historical order id");
    return { profit: 11, currency: "USDT" };
  };
  const fullRecoveredResult = await fullRecovered.reconcileFullCloseByClientOrderId(
    "BTCUSDT",
    makeBinanceClientOrderId("full-close-operation-key"),
    Date.now() - 30_000,
  );
  assert(fullRecoveredResult.ok === true, "historical full-close recovery must succeed");
  assert(fullRecoveredResult.executedQty === 1, "historical full-close recovery must preserve executed quantity");
  assert(fullRecoveredResult.realizedProfit === 11, "historical full-close recovery must return fill PnL");

  const fullReconDb = new DatabaseManager(":memory:");
  await fullReconDb.initialize();
  const fullReconTradeId = fullReconDb.insertTrade({
    ticket: 9200, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 1,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(),
    source: "BINANCE_FULL_RUNTIME_RECOVERY", realizedProfit: 50,
  } as any);
  fullReconDb.createExecutionLedger({
    executionId: "binance-full-unknown",
    operationKey: "full-close-operation-key",
    action: "CLOSE_AT_MARKET",
    status: "UNKNOWN",
    symbol: "BTCUSDT",
    side: "BUY",
    volume: 1,
    request: { tradeId: fullReconTradeId, exitPrice: 51_000, reason: "MANUAL" },
  });
  const fullReconExec = {
    getBinancePosition: async () => null,
    reconcileBinanceFullClose: async (opKey: string, symbol: string) => {
      assert(opKey === "full-close-operation-key" && symbol === "BTCUSDT", "full reconciler must use durable close identity");
      return { ok: true, orderId: 70002, executedQty: 1, realizedProfit: 11 };
    },
  } as any;
  const fullReconciler = new Reconciler(
    config(), fullReconDb, fullReconExec,
    { sendMessage: async () => {} } as any,
    { recordClose: () => {} } as any,
    {} as any,
    { activate: async () => {} } as any,
    () => {},
  );
  await (fullReconciler as any).reconcileOne(fullReconDb.getOpenTrades()[0]);
  const fullTrade = fullReconDb.getRecentClosedTrades(1)[0] as any;
  const fullLedger = fullReconDb.getExecutionByOperationKey("full-close-operation-key");
  assert(fullTrade.profit === 61, "full runtime recovery must include persisted prior realized PnL");
  assert(fullLedger.status === "EXECUTED", "full runtime recovery must resolve UNKNOWN close ledger");
  fullReconDb.raw().close();

  const nullVerifyPartial = new BinanceExecutor(config());
  let partialPositionCalls = 0;
  (nullVerifyPartial as any).getPosition = async () => {
    partialPositionCalls += 1;
    if (partialPositionCalls === 1) {
      return { positionAmt: 1, entryPrice: 50_000, unrealizedProfit: 0 };
    }
    return null;
  };
  (nullVerifyPartial as any).signedPost = async () => ({ orderId: 70003 });
  (nullVerifyPartial as any).getFuturesOrderNetPnl = async () => ({
    profit: 5,
    currency: "USDT",
  });
  const nullPartial = await nullVerifyPartial.closePartialPosition(9300, "BTCUSDT", 0.4, "ta_test_partial");
  assert(nullPartial.ok === false, "partial close must fail closed when post-fill position verification is unavailable");

  const nullVerifyFull = new BinanceExecutor(config());
  (nullVerifyFull as any).getPosition = async () => null;
  (nullVerifyFull as any).signedPost = async () => ({ orderId: 70004 });
  const nullFull = await nullVerifyFull.closePosition(
    9301,
    "BTCUSDT",
    1,
    "BUY",
    makeBinanceClientOrderId("null-verify-full"),
  );
  assert(nullFull.ok === false, "full close must fail closed when position verification is unavailable");

  const multiSide = new BinanceExecutor(config());
  (multiSide as any).signedGet = async () => ([
    { symbol: "BTCUSDT", positionAmt: "1", entryPrice: "50000", unRealizedProfit: "0" },
    { symbol: "BTCUSDT", positionAmt: "-0.2", entryPrice: "51000", unRealizedProfit: "0" },
  ]);
  let multiSideBlocked = false;
  try {
    await multiSide.getPosition("BTCUSDT");
  } catch {
    multiSideBlocked = true;
  }
  assert(multiSideBlocked, "multiple live Binance position sides must fail closed");

  const qtyMismatchDb = new DatabaseManager(":memory:");
  await qtyMismatchDb.initialize();
  const qtyMismatchTradeId = qtyMismatchDb.insertTrade({
    ticket: 9400, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 1,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(),
    source: "BINANCE_QTY_MISMATCH",
  } as any);
  qtyMismatchDb.createExecutionLedger({
    executionId: "qty-mismatch-full",
    operationKey: "qty-mismatch-full-op",
    action: "CLOSE",
    status: "UNKNOWN",
    symbol: "BTCUSDT",
    side: "BUY",
    volume: 1,
    request: { tradeId: qtyMismatchTradeId },
  });
  const qtyMismatchExec = {
    getBinancePosition: async () => null,
    reconcileBinanceFullClose: async () => ({
      ok: true,
      orderId: 70100,
      executedQty: 0.4,
      remainingVolume: 0,
      realizedProfit: 10,
    }),
  } as any;
  const qtyMismatchReconciler = new Reconciler(
    config(), qtyMismatchDb, qtyMismatchExec,
    { sendMessage: async () => {} } as any,
    { recordClose: () => {} } as any,
    {} as any,
    { activate: async () => {} } as any,
    () => {},
  );
  let qtyMismatchBlocked = false;
  try {
    await (qtyMismatchReconciler as any).reconcileOne(qtyMismatchDb.getOpenTrades()[0]);
  } catch {
    qtyMismatchBlocked = true;
  }
  assert(qtyMismatchBlocked, "Binance full-close recovery must reject a partial historical fill");
  assert(qtyMismatchDb.getOpenTrades()[0].status === "open", "quantity-mismatch recovery must not mutate trade");
  assert(qtyMismatchDb.getExecutionByOperationKey("qty-mismatch-full-op").status === "UNKNOWN", "quantity-mismatch recovery must preserve UNKNOWN");
  qtyMismatchDb.raw().close();

  console.log("Result: 13 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
