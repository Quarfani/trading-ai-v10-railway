import { StartupReconciler } from "../integration/StartupReconciler";
import { BinanceExecutor } from "../execution/BinanceExecutor";
import { DatabaseManager } from "../database/DatabaseManager";
import { SystemConfig } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(): SystemConfig {
  return {
    mode: "binance", dataSource: "binance", accountCurrency: "USD",
    accountBalance: 10_000, accountName: "startup-open-recovery",
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

async function main() {
  const cfg = config();
  const original = {
    ping: BinanceExecutor.prototype.ping,
    positions: BinanceExecutor.prototype.getAllPositions,
    orders: BinanceExecutor.prototype.getOpenOrders,
    open: BinanceExecutor.prototype.reconcileOpenOperation,
    protection: BinanceExecutor.prototype.reconcileProtectionModify,
  };

  try {
    const db = new DatabaseManager(":memory:");
    await db.initialize();
    db.createExecutionLedger({
      executionId: "startup-open-unknown",
      operationKey: "startup-open-op",
      action: "OPEN",
      status: "UNKNOWN",
      symbol: "BTCUSDT",
      side: "BUY",
      volume: 0.01,
      request: {
        timeframe: "H1",
        volume: 0.01,
        signal: {
          symbol: "BTCUSDT", side: "BUY", price: 50_000,
          confidence: 0.9, sl: 49_000, tp: 52_000,
          source: "STARTUP_RECOVERY", reason: "test",
          timestamp: Date.now(),
        },
      },
    });

    let openRecoveryCalls = 0;
    BinanceExecutor.prototype.ping = async () => true;
    BinanceExecutor.prototype.getAllPositions = async () => [{
      symbol: "BTCUSDT", positionAmt: 0.01, entryPrice: 50_000, unrealizedProfit: 0,
    }] as any;
    BinanceExecutor.prototype.getOpenOrders = async () => [
      {
        symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET",
        clientOrderId: "expected-sl",
        stopPrice: 49_000, orderId: 5001,
      },
      {
        symbol: "BTCUSDT", side: "SELL", type: "TAKE_PROFIT_MARKET",
        clientOrderId: "expected-tp",
        stopPrice: 52_000, orderId: 5002,
      },
    ] as any;
    BinanceExecutor.prototype.reconcileOpenOperation = async () => {
      openRecoveryCalls += 1;
      return { ok: true, orderId: 4001, executedQty: 0.01, entryPrice: 50_000 };
    };
    BinanceExecutor.prototype.reconcileProtectionModify = async () => ({
      slOrderId: 5001, tpOrderId: 5002,
    });

    // The protection helper uses deterministic client IDs internally; this test
    // overrides it at the abstraction boundary to prove startup logic, not hashing.
    const telegram = { sendMessage: async () => {} } as any;
    const reconciler = new StartupReconciler(cfg, db, telegram);
    await reconciler.run();

    assert(openRecoveryCalls === 1, "startup must recover one authoritative OPEN operation");
    assert(db.getExecutionByOperationKey("startup-open-op").status === "EXECUTED", "recovered OPEN ledger must become EXECUTED");
    const recoveredTrades = db.getOpenTrades();
    assert(recoveredTrades.length === 1, "startup OPEN recovery must create exactly one trade");
    assert(
      recoveredTrades[0].ticket === 4001 &&
      recoveredTrades[0].volume === 0.01 &&
      recoveredTrades[0].entry === 50_000 &&
      recoveredTrades[0].sl === 49_000 &&
      recoveredTrades[0].tp === 52_000,
      "recovered trade must preserve authoritative broker/order fields",
    );
    db.raw().close();

    const ambiguousDb = new DatabaseManager(":memory:");
    await ambiguousDb.initialize();
    for (const suffix of ["a", "b"]) {
      ambiguousDb.createExecutionLedger({
        executionId: `startup-open-${suffix}`,
        operationKey: `startup-open-${suffix}-op`,
        action: "OPEN",
        status: "UNKNOWN",
        symbol: "BTCUSDT",
        side: "BUY",
        volume: 0.01,
        request: {
          timeframe: "H1",
          volume: 0.01,
          signal: {
            symbol: "BTCUSDT", side: "BUY", price: 50_000,
            confidence: 0.9, sl: 49_000, tp: 52_000,
            source: "STARTUP_RECOVERY_DUPLICATE", reason: "test",
            timestamp: Date.now(),
          },
        },
      });
    }
    const ambiguousReconciler = new StartupReconciler(cfg, ambiguousDb, telegram);
    let ambiguousBlocked = false;
    try {
      await ambiguousReconciler.run();
    } catch {
      ambiguousBlocked = true;
    }
    assert(ambiguousBlocked, "multiple UNKNOWN OPENs for one Binance symbol must block startup");
    assert(
      ambiguousDb.getOpenTrades().length === 0,
      "ambiguous Binance OPEN recovery must not create a guessed trade",
    );
    assert(
      ambiguousDb.getExecutionByOperationKey("startup-open-a-op").status === "UNKNOWN" &&
      ambiguousDb.getExecutionByOperationKey("startup-open-b-op").status === "UNKNOWN",
      "ambiguous OPEN ledgers must remain UNKNOWN",
    );
    ambiguousDb.raw().close();

    console.log("Result: 2 passed, 0 failed");
  } finally {
    BinanceExecutor.prototype.ping = original.ping;
    BinanceExecutor.prototype.getAllPositions = original.positions;
    BinanceExecutor.prototype.getOpenOrders = original.orders;
    BinanceExecutor.prototype.reconcileOpenOperation = original.open;
    BinanceExecutor.prototype.reconcileProtectionModify = original.protection;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
