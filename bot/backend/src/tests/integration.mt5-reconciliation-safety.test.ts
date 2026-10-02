import axios from "axios";
import { Reconciler } from "../core/Reconciler";
import { DatabaseManager } from "../database/DatabaseManager";
import { SystemConfig } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function config(): SystemConfig {
  return {
    mode: "mt5", dataSource: "mt5", accountCurrency: "USD",
    accountBalance: 10_000, accountName: "mt5-recon-safety",
    riskPerTrade: 0.01, maxOpenTrades: 5, minConfidence: 0.55,
    maxDailyLoss: 0.02, dailyProfitTarget: 0.03, consecutiveLossLimit: 3,
    cooldownMinutes: 60, mlRequired: false, symbols: ["EURUSD"], timeframes: ["H1"],
    scanInterval: 60_000, dbPath: ":memory:",
    mt5: { login: 1, password: "x", server: "x", bridgeUrl: "http://mt5.test", bridgeApiKey: "secret" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

async function main() {
  const noOp = { getSetting: () => null } as any;
  const reconciler = new Reconciler(
    config(),
    noOp,
    {} as any,
    { sendMessage: async () => {} } as any,
    { recordClose: () => {} } as any,
    {} as any,
    { activate: async () => {} } as any,
    () => {},
  );

  const originalGet = (axios as any).get;
  try {
    (axios as any).get = async () => ({
      data: {
        closed: false,
        remaining_volume: 0.01,
        close_price: 1.1000,
        net_profit: 25,
        close_reason: "manual",
        close_time_msc: Date.now(),
      },
    });
    const unresolved = await (reconciler as any).getMT5History(77);
    assert(unresolved === null, "partial/unknown history must not settle an absent MT5 position");

    (axios as any).get = async () => ({
      data: {
        closed: false,
        remaining_volume: 0.6,
        close_price: 1.105,
        net_profit: 4.25,
        close_reason: "manual",
        close_time_msc: Date.now(),
      },
    });
    const partialHistory = await (reconciler as any).getMT5History(77, false);
    assert(partialHistory?.profit === 4.25, "partial history must expose cumulative realized PnL");
    assert(partialHistory?.closed === false, "partial history must remain marked open");

    (axios as any).get = async () => ({
      data: {
        closed: true,
        remaining_volume: 0,
        close_price: 1.1000,
        net_profit: 25,
        close_reason: "sl",
        close_time_msc: Date.now(),
      },
    });
    const resolved = await (reconciler as any).getMT5History(77);
    assert(resolved?.profit === 25, "closed MT5 history must expose authoritative PnL");
    assert(resolved?.reason === "SL", "closed MT5 history must preserve close reason");

    const db = new DatabaseManager(":memory:");
    await db.initialize();
    const tradeId = db.insertTrade({
      ticket: 77, symbol: "EURUSD", timeframe: "H1", side: "BUY", volume: 0.01,
      entry: 1.1000, sl: 1.0900, tp: 1.1200, status: "open", openedAt: Date.now(),
      source: "RECON_LEDGER_TEST",
    } as any);
    db.createExecutionLedger({
      executionId: "recon-close-1",
      operationKey: "recon-close-op",
      action: "CLOSE_AT_MARKET",
      status: "UNKNOWN",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.01,
      request: { tradeId, exitPrice: 1.11, reason: "MANUAL" },
    });

    const axiosGet2 = (axios as any).get;
    (axios as any).get = async (url: string) => {
      if (url.endsWith("/positions")) {
        return { data: { ok: true, positions: [] } };
      }
      return {
        data: {
          closed: true,
          remaining_volume: 0,
          close_price: 1.11,
          net_profit: 12.5,
          close_reason: "manual",
        close_time_msc: Date.now(),
        },
      };
    };
    try {
      const reconcilerWithLedger = new Reconciler(
        config(), db, {} as any,
        { sendMessage: async () => {} } as any,
        { recordClose: () => {} } as any,
        {} as any,
        { activate: async () => {} } as any,
        () => {},
      );
      const openTrade = db.getOpenTrades()[0];
      await (reconcilerWithLedger as any).reconcileOne(openTrade);
      const ledger = db.getExecutionByOperationKey("recon-close-op");
      assert(ledger.status === "EXECUTED", "authoritatively reconciled MT5 close must resolve its UNKNOWN ledger");
      assert(JSON.parse(ledger.resultJson).profit === 12.5, "reconciled ledger must store authoritative broker PnL");
      assert(db.getOpenTrades().length === 0, "reconciliation must close the internal trade");
    } finally {
      (axios as any).get = axiosGet2;
      db.raw().close();
    }

    const rollbackDb = new DatabaseManager(":memory:");
    await rollbackDb.initialize();
    const rollbackTradeId = rollbackDb.insertTrade({
      ticket: 770,
      symbol: "EURUSD",
      timeframe: "H1",
      side: "BUY",
      volume: 0.01,
      entry: 1.1000,
      sl: 1.0900,
      tp: 1.1200,
      status: "open",
      openedAt: Date.now(),
      source: "RUNTIME_ATOMIC_ROLLBACK",
    } as any);
    rollbackDb.createExecutionLedger({
      executionId: "runtime-rollback-close",
      operationKey: "runtime-rollback-close-op",
      action: "CLOSE_AT_MARKET",
      status: "UNKNOWN",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.01,
      request: { tradeId: rollbackTradeId, exitPrice: 1.11, reason: "MANUAL" },
    });
    rollbackDb.raw().exec(`
      CREATE TRIGGER fail_runtime_close_ledger
      BEFORE UPDATE OF status ON execution_ledger
      WHEN NEW.executionId='runtime-rollback-close' AND NEW.status='EXECUTED'
      BEGIN SELECT RAISE(ABORT, 'forced runtime ledger failure'); END;
    `);
    try {
      const rollbackReconciler = new Reconciler(
        config(), rollbackDb, {} as any,
        { sendMessage: async () => {} } as any,
        { recordClose: () => {} } as any,
        {} as any,
        { activate: async () => {} } as any,
        () => {},
      );
      let rollbackFailed = false;
      try {
        await (rollbackReconciler as any).reconcileOne(rollbackDb.getOpenTrades()[0]);
      } catch {
        rollbackFailed = true;
      }
      assert(rollbackFailed, "runtime atomic full-close must fail when ledger settlement fails");
      assert(
        rollbackDb.getOpenTrades()[0].status === "open",
        "runtime atomic full-close failure must roll back trade state",
      );
      assert(
        rollbackDb.getExecutionByOperationKey("runtime-rollback-close-op").status === "UNKNOWN",
        "runtime atomic full-close failure must preserve UNKNOWN ledger state",
      );
    } finally {
      rollbackDb.raw().close();
    }

    const staleDb = new DatabaseManager(":memory:");
    await staleDb.initialize();
    const staleTradeId = staleDb.insertTrade({
      ticket: 771,
      symbol: "EURUSD",
      timeframe: "H1",
      side: "BUY",
      volume: 0.01,
      entry: 1.1000,
      sl: 1.0900,
      tp: 1.1200,
      status: "open",
      openedAt: Date.now(),
      source: "RUNTIME_STALE_HISTORY",
    } as any);
    staleDb.createExecutionLedger({
      executionId: "runtime-stale-close",
      operationKey: "runtime-stale-close-op",
      action: "CLOSE_AT_MARKET",
      status: "UNKNOWN",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.01,
      request: { tradeId: staleTradeId, exitPrice: 1.11, reason: "MANUAL" },
    });
    staleDb.raw().prepare(
      "UPDATE execution_ledger SET createdAt=? WHERE executionId=?",
    ).run(Date.now(), "runtime-stale-close");
    try {
      const staleReconciler = new Reconciler(
        config(), staleDb, {} as any,
        { sendMessage: async () => {} } as any,
        { recordClose: () => {} } as any,
        {} as any,
        { activate: async () => {} } as any,
        () => {},
      );
      const staleOriginalGet = (axios as any).get;
      (axios as any).get = async (url: string) => {
        if (url.endsWith("/positions")) return { data: { ok: true, positions: [] } };
        return {
          data: {
            closed: true,
            remaining_volume: 0,
            close_price: 1.11,
            net_profit: 12.5,
            close_reason: "manual",
            close_time_msc: Date.now() - 60 * 60 * 1000,
          },
        };
      };
      try {
        let staleFailed = false;
        try {
          await (staleReconciler as any).reconcileOne(staleDb.getOpenTrades()[0]);
        } catch {
          staleFailed = true;
        }
        assert(staleFailed, "runtime reconciliation must reject stale broker close history");
        assert(
          staleDb.getOpenTrades()[0].status === "open",
          "stale runtime close history must not close the internal trade",
        );
        assert(
          staleDb.getExecutionByOperationKey("runtime-stale-close-op").status === "UNKNOWN",
          "stale runtime close history must preserve UNKNOWN ledger state",
        );
      } finally {
        (axios as any).get = staleOriginalGet;
      }
    } finally {
      staleDb.raw().close();
    }

    console.log("Result: 10 passed, 0 failed");
  } finally {
    (axios as any).get = originalGet;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
