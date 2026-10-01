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
      assert(params.origClientOrderId === clientId, "historical order lookup must use the operation client id");
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
  );
  assert(recoveredResult.ok === true, "historical partial-close recovery must succeed");
  assert(recoveredResult.orderId === 70001, "historical recovery must preserve broker order id");
  assert(recoveredResult.executedQty === 0.4, "historical recovery must preserve executed quantity");
  assert(recoveredResult.remainingVolume === 0.6, "historical recovery must return live remaining position");
  assert(recoveredResult.realizedProfit === 7.5, "historical recovery must return fill PnL");

  const noOrder = await recovered.reconcilePartialCloseByClientOrderId(
    "BTCUSDT",
    makeBinanceClientOrderId("missing"),
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

  console.log("Result: 6 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
