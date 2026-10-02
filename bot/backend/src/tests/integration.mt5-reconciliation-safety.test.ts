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
      },
    });
    const resolved = await (reconciler as any).getMT5History(77);
    assert(resolved?.profit === 25, "closed MT5 history must expose authoritative PnL");
    assert(resolved?.reason === "SL", "closed MT5 history must preserve close reason");

    const modifyDb = new DatabaseManager(":memory:");
    await modifyDb.initialize();
    const modifyTradeId = modifyDb.insertTrade({
      ticket: 76, symbol: "EURUSD", timeframe: "H1", side: "BUY", volume: 0.1,
      entry: 1.1000, sl: 1.0900, tp: 1.1200, status: "open", openedAt: Date.now(),
      source: "RECON_MODIFY_TEST",
    } as any);
    modifyDb.createExecutionLedger({
      executionId: "recon-modify-1",
      operationKey: "recon-modify-op",
      action: "MOVE_SL_TP",
      status: "UNKNOWN",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.1,
      request: { tradeId: modifyTradeId, newSl: 1.0950, newTp: 1.1150 },
    });
    (axios as any).get = async (url: string) => {
      if (url.endsWith("/positions")) {
        return {
          data: {
            ok: true,
            positions: [{
              ticket: 76, symbol: "EURUSD", type: "BUY", volume: 0.1,
              sl: 1.0950, tp: 1.1150,
            }],
          },
        };
      }
      throw new Error("unexpected URL");
    };
    const modifyExec = {} as any;
    const modifyReconciler = new Reconciler(
      config(), modifyDb, modifyExec,
      { sendMessage: async () => {} } as any,
      { recordClose: () => {} } as any,
      {} as any,
      { activate: async () => {} } as any,
      () => {},
    );
    await (modifyReconciler as any).reconcileOne(modifyDb.getOpenTrades()[0]);
    assert(
      modifyDb.getExecutionByOperationKey("recon-modify-op").status === "EXECUTED",
      "matching MT5 protective state must resolve UNKNOWN MOVE_SL_TP",
    );
    const modifiedTrade = modifyDb.getOpenTrades()[0];
    assert(
      modifiedTrade.sl === 1.0950 && modifiedTrade.tp === 1.1150,
      "MT5 protective recovery must persist the broker SL/TP values",
    );
    modifyDb.raw().close();

    const driftDb = new DatabaseManager(":memory:");
    await driftDb.initialize();
    driftDb.insertTrade({
      ticket: 75, symbol: "EURUSD", timeframe: "H1", side: "BUY", volume: 0.1,
      entry: 1.1000, sl: 1.0900, tp: 1.1200, status: "open", openedAt: Date.now(),
      source: "RECON_DRIFT_TEST",
    } as any);
    (axios as any).get = async (url: string) => {
      if (url.endsWith("/positions")) {
        return {
          data: {
            ok: true,
            positions: [{
              ticket: 75, symbol: "EURUSD", type: "BUY", volume: 0.1,
              sl: 1.0950, tp: 1.1150,
            }],
          },
        };
      }
      throw new Error("unexpected URL");
    };
    let driftBlocked = false;
    try {
      await (new Reconciler(
        config(), driftDb, {} as any,
        { sendMessage: async () => {} } as any,
        { recordClose: () => {} } as any,
        {} as any,
        { activate: async () => {} } as any,
        () => {},
      ) as any).reconcileOne(driftDb.getOpenTrades()[0]);
    } catch {
      driftBlocked = true;
    }
    assert(driftBlocked, "unexplained MT5 protective-order drift must block runtime reconciliation");
    assert(driftDb.getOpenTrades().length === 1, "protective-order drift must not close the trade silently");
    driftDb.raw().close();

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

    console.log("Result: 13 passed, 0 failed");
  } finally {
    (axios as any).get = originalGet;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
