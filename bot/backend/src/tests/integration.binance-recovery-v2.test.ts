import { BinanceExecutor, makeBinanceClientOrderId } from "../execution/BinanceExecutor";
import { ExecutionGateway } from "../execution/ExecutionGateway";
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
    accountName: "binance-v2-test",
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
    mt5: {
      login: 0, password: "", server: "",
      bridgeUrl: "", bridgeApiKey: "",
    },
    binance: {
      apiKey: "", secret: "", env: "testnet", futures: true,
    },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

async function main() {
  const clientOrderId = makeBinanceClientOrderId("recovery-v2-operation");
  assert(clientOrderId.length <= 32, "Binance client order id must remain within the exchange limit");
  assert(clientOrderId === makeBinanceClientOrderId("recovery-v2-operation"), "client order id must be deterministic");

  const multi = new BinanceExecutor(config());
  (multi as any).signedGet = async () => [
    { symbol: "BTCUSDT", positionAmt: "1", entryPrice: "50000", unRealizedProfit: "0" },
    { symbol: "BTCUSDT", positionAmt: "-0.2", entryPrice: "51000", unRealizedProfit: "0" },
  ];
  let multiBlocked = false;
  try { await multi.getPosition("BTCUSDT"); } catch { multiBlocked = true; }
  assert(multiBlocked, "multiple live Binance sides must fail closed");

  const partial = new BinanceExecutor(config());
  let partialBody: any;
  let partialCalls = 0;
  (partial as any).getPosition = async () => {
    partialCalls += 1;
    return partialCalls === 1
      ? { positionAmt: 1, entryPrice: 50000, unrealizedProfit: 0 }
      : { positionAmt: 0.6, entryPrice: 50000, unrealizedProfit: 0 };
  };
  (partial as any).signedPost = async (_path: string, body: any) => {
    partialBody = body;
    return { orderId: 9001 };
  };
  (partial as any).getFuturesOrderNetPnl = async () => ({ profit: 7, currency: "USDT" });

  const partialResult = await partial.closePartialPosition(
    101,
    "BTCUSDT",
    0.4,
    clientOrderId,
  );
  assert(partialResult.ok === true, "partial close should succeed with verified post-fill state");
  assert(partialBody.newClientOrderId === clientOrderId, "partial close must send durable client order identity");
  assert(partialResult.remainingVolume === 0.6, "partial close must return the verified remaining position");

  const full = new BinanceExecutor(config());
  let fullBody: any;
  let fullCalls = 0;
  (full as any).getPosition = async () => {
    fullCalls += 1;
    return fullCalls === 1
      ? { positionAmt: 1, entryPrice: 50000, unrealizedProfit: 0 }
      : { positionAmt: 0, entryPrice: 50000, unrealizedProfit: 0 };
  };
  (full as any).signedPost = async (_path: string, body: any) => {
    fullBody = body;
    return { orderId: 9002 };
  };
  (full as any).getFuturesOrderNetPnl = async () => ({ profit: 11, currency: "USDT" });
  const fullResult = await full.closePosition(
    102,
    "BTCUSDT",
    1,
    "BUY",
    clientOrderId,
  );
  assert(fullResult.ok === true, "full close should succeed after post-fill flattening");
  assert(fullBody.newClientOrderId === clientOrderId, "full close must send durable client order identity");
  assert(fullResult.realizedProfit === 11, "full close must return authoritative PnL");

  const recoveredFull = new BinanceExecutor(config());
  (recoveredFull as any).signedGet = async (path: string, params: any) => {
    if (path === "/fapi/v1/allOrders") {
      assert(Number.isFinite(Number(params.startTime)), "historical full recovery must use a finite startTime");
      assert(Number.isFinite(Number(params.endTime)), "historical full recovery must use a finite endTime");
      assert(params.limit === 1000, "historical recovery must request a full bounded page");
      return [{
        symbol: "BTCUSDT",
        orderId: 9002,
        clientOrderId,
        status: "FILLED",
        executedQty: "1",
        updateTime: Date.now(),
      }];
    }
    if (path === "/fapi/v1/userTrades") {
      return [{
        realizedPnl: "13",
        commission: "2",
        commissionAsset: "USDT",
      }];
    }
    if (path === "/fapi/v2/positionRisk") return [];
    throw new Error("unexpected signed GET");
  };
  const recoveredFullResult = await recoveredFull.reconcileFullCloseByClientOrderId(
    "BTCUSDT",
    clientOrderId,
    Date.now() - 30_000,
  );
  assert(recoveredFullResult.ok === true, "historical full recovery must succeed");
  assert(recoveredFullResult.executedQty === 1, "historical full recovery must preserve executed quantity");
  assert(recoveredFullResult.realizedProfit === 11, "historical full recovery must return net PnL after commission");

  const recoveredPartial = new BinanceExecutor(config());
  (recoveredPartial as any).signedGet = async (path: string) => {
    if (path === "/fapi/v1/allOrders") {
      return [{
        symbol: "BTCUSDT",
        orderId: 9003,
        clientOrderId,
        status: "FILLED",
        executedQty: "0.4",
        updateTime: Date.now(),
      }];
    }
    if (path === "/fapi/v1/userTrades") {
      return [{
        realizedPnl: "8",
        commission: "1",
        commissionAsset: "USDT",
      }];
    }
    if (path === "/fapi/v2/positionRisk") {
      return [{
        symbol: "BTCUSDT",
        positionAmt: "0.6",
        entryPrice: "50000",
        unRealizedProfit: "0",
      }];
    }
    throw new Error("unexpected signed GET");
  };
  const recoveredPartialResult = await recoveredPartial.reconcilePartialCloseByClientOrderId(
    "BTCUSDT",
    clientOrderId,
    Date.now() - 30_000,
  );
  assert(recoveredPartialResult.ok === true, "historical partial recovery must succeed");
  assert(recoveredPartialResult.remainingVolume === 0.6, "historical partial recovery must use live position");
  assert(recoveredPartialResult.realizedProfit === 7, "historical partial recovery must return net PnL");

  const db = new DatabaseManager(":memory:");
  await db.initialize();
  const tradeId = db.insertTrade({
    ticket: 9100, symbol: "BTCUSDT", timeframe: "H1", side: "BUY", volume: 1,
    entry: 50_000, sl: 49_000, tp: 52_000, status: "open", openedAt: Date.now(),
    source: "GATEWAY_RECOVERY", realizedProfit: 50,
  } as any);
  const opKey = "gateway-close-operation";
  db.createExecutionLedger({
    executionId: "gateway-close-execution",
    operationKey: opKey,
    action: "CLOSE",
    status: "PENDING",
    symbol: "BTCUSDT",
    side: "BUY",
    volume: 1,
    request: { tradeId },
  });

  const gateway = new ExecutionGateway(config(), db);
  let gatewayClientId = "";
  (gateway as any).binance.closePosition = async (
    _ticket: number,
    _symbol: string,
    _volume: number,
    _side: string,
    suppliedClientId: string,
  ) => {
    gatewayClientId = suppliedClientId;
    return {
      ok: true,
      realizedProfit: 11,
      realizedProfitCurrency: "USDT",
    };
  };

  const gatewayResult = await gateway.closeTrade({
    id: tradeId,
    ticket: 9100,
    symbol: "BTCUSDT",
    timeframe: "H1",
    side: "BUY",
    volume: 1,
    entry: 50_000,
    sl: 49_000,
    tp: 52_000,
    status: "open",
    openedAt: Date.now(),
    source: "GATEWAY_RECOVERY",
    realizedProfit: 0,
  } as any);

  const persistedTrade = db.raw().prepare(
    "SELECT status, profit FROM trades WHERE id=?",
  ).get(tradeId) as any;
  const persistedLedger = db.getExecutionByOperationKey(opKey);

  assert(gatewayResult === true, "gateway close should settle successfully");
  assert(gatewayClientId === makeBinanceClientOrderId(opKey), "gateway must derive broker client identity from operation key");
  assert(persistedTrade.status === "closed" && persistedTrade.profit === 61, "gateway must use persisted prior partial PnL");
  assert(persistedLedger.status === "EXECUTED", "gateway close must atomically execute the ledger");

  db.raw().close();
  console.log("Result: 7 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
