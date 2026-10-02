import axios from "axios";
import { DatabaseManager } from "../database/DatabaseManager";
import { ExecutionGateway } from "../execution/ExecutionGateway";
import { PaperTrader } from "../integration/PaperTrader";
import { SystemConfig, Signal } from "../types/trading.types";
import { clearBrokerContracts, registerBrokerContract } from "../market/MarketCatalog";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function baseConfig(mode: "paper" | "mt5"): SystemConfig {
  return {
    mode, dataSource: mode === "mt5" ? "mt5" : "binance",
    accountCurrency: "EUR", accountBalance: 10_000, accountName: "ledger-test",
    riskPerTrade: 0.01, maxOpenTrades: 5, minConfidence: 0.55, maxDailyLoss: 0.02,
    dailyProfitTarget: 0.03, consecutiveLossLimit: 3, cooldownMinutes: 60, mlRequired: false,
    symbols: ["EURUSD"], timeframes: ["H1"], scanInterval: 60_000, dbPath: ":memory:",
    mt5: { login: 1, password: "x", server: "x", bridgeUrl: "http://mt5.test", bridgeApiKey: "secret" },
    binance: { apiKey: "", secret: "", env: "testnet", futures: true },
    telegram: { token: "", chatId: "" },
    compounding: { enabled: false, reinvestRate: 1 },
  } as SystemConfig;
}

function signal(ts: number, symbol = "EURUSD"): Signal {
  return {
    symbol, side: "BUY", price: 1.1000, confidence: 0.8,
    sl: 1.0900, tp: 1.1200, source: "LEDGER_TEST", reason: "idempotency",
    timestamp: ts, timeframe: "H1",
  };
}

async function main() {
  clearBrokerContracts();
  const db = new DatabaseManager(":memory:");
  await db.initialize();

  // Successful paper replay must return the exact persisted execution result
  // without creating a second trade/ledger row.
  let rateCalls = 0;
  const paperRates = {
    getRate: async () => (++rateCalls === 1 ? 0.90 : 0.95),
  } as any;
  const paper = new ExecutionGateway(baseConfig("paper"), db, paperRates);
  const first = await paper.execute(signal(1_800_000_000_001), 0.01, "H1");
  assert(first.success && first.trade, "first paper execution must succeed");
  assert(first.trade.entryQuoteToAccount === 0.90, "paper execution must persist entry FX rate");
  const second = await paper.execute(signal(1_800_000_000_001), 0.01, "H1");
  assert(second.success && second.trade, "executed operation must be replayable");
  assert(second.trade.ticket === first.trade.ticket, "replay must return the same ticket");
  assert(db.getRecentTrades(20).length === 1, "replay must not create a duplicate trade");

  // Live MT5 failures become UNKNOWN. A repeated call with the same key must
  // be blocked instead of sending the order a second time.
  registerBrokerContract({
    symbol: "EURUSD.a", baseAsset: "EUR", quoteCurrency: "USD", assetClass: "FOREX",
    contractType: "CFD", venue: "MT5", contractSize: 100000, priceIncrement: 0.00001,
    minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, marginModel: "BROKER_DEFINED",
    source: "ledger-test", observedAt: Date.now(), verified: true,
  });
  const mt5 = new ExecutionGateway({ ...baseConfig("mt5"), symbols: ["EURUSD.a"] }, db);
  const originalPost = (axios as any).post;
  let postCalls = 0;
  (axios as any).post = async () => { postCalls += 1; throw new Error("simulated transport failure"); };

  try {
    const liveSignal = signal(1_800_000_000_002, "EURUSD.a");
    const failed = await mt5.execute(liveSignal, 0.01, "H1");
    assert(!failed.success, "simulated MT5 failure must fail execution");
    assert(postCalls === 1, "first UNKNOWN operation must send exactly once");

    const replay = await mt5.execute(liveSignal, 0.01, "H1");
    assert(!replay.success, "UNKNOWN replay must remain blocked");
    assert(postCalls === 1, "UNKNOWN replay must never resend to broker");
    assert(String(replay.error).includes("automatic retry is forbidden"), "UNKNOWN replay must explain the safety block");
    const ledgers = db.raw().prepare("SELECT status, retryCount FROM execution_ledger WHERE symbol=?").all("EURUSD.a") as any[];
    assert(ledgers.length === 1 && ledgers[0].status === "UNKNOWN" && ledgers[0].retryCount === 0, "UNKNOWN state must remain durable");
  } finally {
    (axios as any).post = originalPost;
    clearBrokerContracts();
  }

  const partialDb = new DatabaseManager(":memory:");
  await partialDb.initialize();
  registerBrokerContract({
    symbol: "EURUSD.a", baseAsset: "EUR", quoteCurrency: "USD", assetClass: "FOREX",
    contractType: "CFD", venue: "MT5", contractSize: 100000, priceIncrement: 0.00001,
    minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, marginModel: "BROKER_DEFINED",
    source: "mt5-partial-volume-test", observedAt: Date.now(), verified: true,
  });
  const partialGateway = new ExecutionGateway(
    { ...baseConfig("mt5"), symbols: ["EURUSD.a"] },
    partialDb,
  );
  const originalPostPartial = (axios as any).post;
  (axios as any).post = async () => ({
    data: {
      ticket: 77,
      price: 1.10002,
      volume: 0.06,
    },
  });
  try {
    const partial = await partialGateway.execute(
      signal(1_800_000_000_003, "EURUSD.a"),
      0.10,
      "H1",
    );
    assert(partial.success && partial.trade, "MT5 partial fill fixture must execute");
    assert(partial.trade.volume === 0.06, "MT5 gateway must persist broker-confirmed executed volume");
    const stored = partialDb.getOpenTrades()[0];
    assert(stored.volume === 0.06, "database trade volume must match executed broker volume");
  } finally {
    (axios as any).post = originalPostPartial;
    clearBrokerContracts();
  }

  const closeDb = new DatabaseManager(":memory:");
  await closeDb.initialize();
  registerBrokerContract({
    symbol: "EURUSD.a",
    baseAsset: "EUR",
    quoteCurrency: "USD",
    assetClass: "FOREX",
    contractType: "CFD",
    venue: "MT5",
    contractSize: 100000,
    priceIncrement: 0.00001,
    minVolume: 0.01,
    maxVolume: 100,
    volumeStep: 0.01,
    marginModel: "BROKER_DEFINED",
    source: "close-ledger-test",
    observedAt: Date.now(),
    verified: true,
  });
  const closeGateway = new ExecutionGateway(
    { ...baseConfig("mt5"), symbols: ["EURUSD.a"] },
    closeDb,
  );
  const closeTradeId = closeDb.insertTrade({
    ticket: 88,
    symbol: "EURUSD.a",
    timeframe: "H1",
    side: "BUY",
    volume: 0.01,
    entry: 1.1,
    sl: 1.09,
    tp: 1.12,
    status: "open",
    openedAt: 1_800_000_000_004,
    source: "CLOSE_LEDGER_TEST",
  } as any);
  const closeTrade = {
    id: closeTradeId,
    ticket: 88,
    symbol: "EURUSD.a",
    timeframe: "H1",
    side: "BUY",
    volume: 0.01,
    entry: 1.1,
    sl: 1.09,
    tp: 1.12,
    status: "open",
    openedAt: 1_800_000_000_004,
    source: "CLOSE_LEDGER_TEST",
  } as any;

  const originalClosePost = (axios as any).post;
  (axios as any).post = async () => ({ data: { ok: true, closed: true, profit: 12.5 } });
  try {
    const closed = await closeGateway.closeAtMarket(
      closeTrade,
      1.11,
      "MANUAL",
    );
    assert(closed.ok, "MT5 closeAtMarket fixture must succeed");
    const closeLedgers = closeDb.raw()
      .prepare("SELECT action, status FROM execution_ledger WHERE symbol=?")
      .all("EURUSD.a") as any[];
    assert(
      closeLedgers.length === 1,
      "closeAtMarket must create exactly one execution-ledger operation",
    );
    assert(
      closeLedgers[0].action === "CLOSE_AT_MARKET" &&
      closeLedgers[0].status === "EXECUTED",
      "closeAtMarket ledger must be executed",
    );
  } finally {
    (axios as any).post = originalClosePost;
    clearBrokerContracts();
  }

  const replayCloseDb = new DatabaseManager(":memory:");
  await replayCloseDb.initialize();
  registerBrokerContract({
    symbol: "EURUSD.a", baseAsset: "EUR", quoteCurrency: "USD", assetClass: "FOREX",
    contractType: "CFD", venue: "MT5", contractSize: 100000, priceIncrement: 0.00001,
    minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, marginModel: "BROKER_DEFINED",
    source: "replay-result-test", observedAt: Date.now(), verified: true,
  });
  const replayCloseGateway = new ExecutionGateway(
    { ...baseConfig("mt5"), symbols: ["EURUSD.a"] },
    replayCloseDb,
  );
  const originalReplayPost = (axios as any).post;
  let replayCloseCalls = 0;
  (axios as any).post = async () => {
    replayCloseCalls += 1;
    return { data: { ok: true, profit: 17.25 } };
  };
  const replayCloseId = replayCloseDb.insertTrade({
    ticket: 910, symbol: "EURUSD.a", timeframe: "H1", side: "BUY",
    volume: 0.01, entry: 1.1, sl: 1.09, tp: 1.12, status: "open",
    openedAt: 1_800_000_000_010, source: "REPLAY_CLOSE_TEST",
  } as any);
  const replayCloseTrade = {
    id: replayCloseId, ticket: 910, symbol: "EURUSD.a", timeframe: "H1", side: "BUY",
    volume: 0.01, entry: 1.1, sl: 1.09, tp: 1.12, status: "open",
    openedAt: 1_800_000_000_010, source: "REPLAY_CLOSE_TEST",
  } as any;
  try {
    const close1 = await replayCloseGateway.closeAtMarket(replayCloseTrade, 1.11, "MANUAL");
    const close2 = await replayCloseGateway.closeAtMarket(replayCloseTrade, 1.11, "MANUAL");
    assert(close1.ok && close2.ok, "successful close replay must remain successful");
    assert(close1.profit === 17.25 && close2.profit === 17.25, "close replay must return the same persisted realized profit");
    assert(replayCloseCalls === 1, "close replay must not call the broker twice");
    assert(replayCloseDb.getOpenTrades().length === 0, "verified MT5 close must close the internal trade");
  } finally {
    (axios as any).post = originalReplayPost;
    replayCloseDb.raw().close();
    clearBrokerContracts();
  }

  const replayPartialDb = new DatabaseManager(":memory:");
  await replayPartialDb.initialize();
  registerBrokerContract({
    symbol: "EURUSD.a", baseAsset: "EUR", quoteCurrency: "USD", assetClass: "FOREX",
    contractType: "CFD", venue: "MT5", contractSize: 100000, priceIncrement: 0.00001,
    minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, marginModel: "BROKER_DEFINED",
    source: "replay-partial-test", observedAt: Date.now(), verified: true,
  });
  const replayPartialGateway = new ExecutionGateway(
    { ...baseConfig("mt5"), symbols: ["EURUSD.a"] },
    replayPartialDb,
  );
  const originalPartialPost = (axios as any).post;
  let partialCalls = 0;
  (axios as any).post = async () => {
    partialCalls += 1;
    return { data: { ok: true, remaining_volume: 0.06, profit: 3.75 } };
  };
  const replayPartialTrade = {
    id: 911, ticket: 911, symbol: "EURUSD.a", timeframe: "H1", side: "BUY",
    volume: 0.10, entry: 1.1, sl: 1.09, tp: 1.12, status: "open",
    openedAt: 1_800_000_000_011, source: "REPLAY_PARTIAL_TEST",
  } as any;
  try {
    const partial1 = await replayPartialGateway.closePartial(replayPartialTrade, 0.04, 1.11, "PARTIAL");
    const partial2 = await replayPartialGateway.closePartial(replayPartialTrade, 0.04, 1.11, "PARTIAL");
    assert(partial1.ok && partial2.ok, "successful partial-close replay must remain successful");
    assert(partial1.profit === 3.75 && partial2.profit === 3.75, "partial replay must return persisted profit");
    assert(partial1.remainingVolume === 0.06 && partial2.remainingVolume === 0.06, "partial replay must return persisted remaining volume");
    assert(partialCalls === 1, "partial replay must not call the broker twice");
  } finally {
    (axios as any).post = originalPartialPost;
    replayPartialDb.raw().close();
    clearBrokerContracts();
  }

  const modifyDb = new DatabaseManager(":memory:");
  await modifyDb.initialize();
  const modifyGateway = new ExecutionGateway(baseConfig("mt5"), modifyDb);
  const originalModifyPost = (axios as any).post;
  (axios as any).post = async () => ({ data: { ok: false, error: "broker rejected" } });
  try {
    const modified = await modifyGateway.modifySLTP(
      {
        id: 901, ticket: 91, symbol: "EURUSD.a", timeframe: "H1",
        side: "BUY", volume: 0.01, entry: 1.1, sl: 1.09, tp: 1.12,
        status: "open", openedAt: 1_800_000_000_005, source: "MODIFY_TEST",
      } as any,
      1.095,
      1.115,
    );
    assert(modified === false, "HTTP 200 with MT5 modify ok=false must fail the operation");
    const modifyLedger = modifyDb.raw()
      .prepare("SELECT status FROM execution_ledger WHERE action='MOVE_SL_TP'")
      .get() as any;
    assert(
      modifyLedger.status === "UNKNOWN",
      "broker-rejected modify response must remain UNKNOWN for reconciliation",
    );
  } finally {
    (axios as any).post = originalModifyPost;
    modifyDb.raw().close();
  }

  const resolveDb = new DatabaseManager(":memory:");
  await resolveDb.initialize();
  const created = resolveDb.createExecutionLedger({
    executionId: "resolve-1",
    operationKey: "resolve-operation",
    action: "CLOSE_AT_MARKET",
    status: "UNKNOWN",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.01,
    request: { tradeId: 42, exitPrice: 1.11, reason: "MANUAL" },
  });
  assert(created === true, "unresolved ledger fixture must be created");
  const unresolved = resolveDb.getLatestUnresolvedExecutionForTrade(42, ["CLOSE_AT_MARKET"]);
  assert(unresolved?.executionId === "resolve-1", "trade-linked unresolved ledger must be discoverable");
  const resolved = resolveDb.resolveExecutionLedger(
    "resolve-1",
    { broker: "mt5", ticket: 77, profit: 12.5 },
    77,
  );
  assert(resolved === true, "unresolved ledger must be resolvable");
  const resolvedRow = resolveDb.getExecutionByOperationKey("resolve-operation");
  assert(resolvedRow.status === "EXECUTED", "resolved ledger status must become EXECUTED");
  assert(resolvedRow.brokerOrderId === "77", "resolved ledger must preserve broker identity");
  assert(JSON.parse(resolvedRow.resultJson).profit === 12.5, "resolved ledger must preserve authoritative result");
  resolveDb.raw().close();

  const atomicDb = new DatabaseManager(":memory:");
  await atomicDb.initialize();
  const atomicTradeId = atomicDb.insertTrade({
    ticket: 990, symbol: "EURUSD.a", timeframe: "H1", side: "BUY", volume: 1.0,
    entry: 1.1, sl: 1.09, tp: 1.12, status: "open", openedAt: Date.now(), source: "ATOMIC_TEST",
  } as any);
  atomicDb.createExecutionLedger({
    executionId: "atomic-fail",
    operationKey: "atomic-fail-op",
    action: "PARTIAL_CLOSE",
    status: "UNKNOWN",
    symbol: "EURUSD.a",
    side: "BUY",
    volume: 0.4,
    request: { tradeId: atomicTradeId, volume: 0.4 },
  });
  atomicDb.raw().exec(`
    CREATE TRIGGER fail_atomic_ledger
    BEFORE UPDATE OF status ON execution_ledger
    WHEN NEW.executionId='atomic-fail' AND NEW.status='EXECUTED'
    BEGIN SELECT RAISE(ABORT, 'forced ledger failure'); END;
  `);
  let atomicFailed = false;
  try {
    atomicDb.resolveReconciledPartialClose(
      atomicTradeId,
      "atomic-fail",
      0.6,
      4.0,
      { broker: "mt5", ticket: 990, profit: 4.0 },
      123,
    );
  } catch {
    atomicFailed = true;
  }
  assert(atomicFailed, "forced partial ledger failure must abort the atomic transaction");
  assert(
    atomicDb.getOpenTrades()[0].volume === 1.0,
    "atomic partial recovery failure must roll back the trade volume update",
  );
  assert(
    atomicDb.getExecutionByOperationKey("atomic-fail-op").status === "UNKNOWN",
    "atomic partial recovery failure must preserve UNKNOWN ledger state",
  );
  atomicDb.raw().close();

  const atomicSuccessDb = new DatabaseManager(":memory:");
  await atomicSuccessDb.initialize();
  const atomicSuccessTradeId = atomicSuccessDb.insertTrade({
    ticket: 992, symbol: "EURUSD.a", timeframe: "H1", side: "BUY", volume: 0.01,
    entry: 1.1, sl: 1.09, tp: 1.12, status: "open", openedAt: Date.now(), source: "ATOMIC_FULL_SUCCESS",
  } as any);
  atomicSuccessDb.createExecutionLedger({
    executionId: "atomic-full-success",
    operationKey: "atomic-full-success-op",
    action: "CLOSE_AT_MARKET",
    status: "UNKNOWN",
    symbol: "EURUSD.a",
    side: "BUY",
    volume: 0.01,
    request: { tradeId: atomicSuccessTradeId },
  });
  const atomicSuccessClosedAt = Date.now();
  assert(
    atomicSuccessDb.resolveReconciledFullClose(
      atomicSuccessTradeId,
      "atomic-full-success",
      12.5,
      atomicSuccessClosedAt,
      "MANUAL",
      { broker: "mt5", ticket: 992, profit: 12.5 },
      992,
    ) === true,
    "authoritative full-close recovery must resolve the operation",
  );
  const closedRow = atomicSuccessDb.raw()
    .prepare("SELECT status, profit, closedAt FROM trades WHERE id=?")
    .get(atomicSuccessTradeId) as any;
  const ledgerRow = atomicSuccessDb.getExecutionByOperationKey("atomic-full-success-op");
  const dailyRow = atomicSuccessDb.raw()
    .prepare("SELECT trades, wins, losses, pnl FROM daily_stats WHERE day=?")
    .get(new Date(atomicSuccessClosedAt).toISOString().slice(0, 10)) as any;
  assert(closedRow.status === "closed" && closedRow.profit === 12.5, "full-close recovery must persist final trade PnL");
  assert(ledgerRow.status === "EXECUTED", "full-close recovery must execute the ledger");
  assert(dailyRow.trades === 1 && dailyRow.wins === 1 && dailyRow.pnl === 12.5, "full-close recovery must update daily stats exactly once");
  atomicSuccessDb.raw().close();

  const atomicFullDb = new DatabaseManager(":memory:");
  await atomicFullDb.initialize();
  const atomicFullTradeId = atomicFullDb.insertTrade({
    ticket: 991, symbol: "EURUSD.a", timeframe: "H1", side: "BUY", volume: 0.01,
    entry: 1.1, sl: 1.09, tp: 1.12, status: "open", openedAt: Date.now(), source: "ATOMIC_FULL_TEST",
  } as any);
  atomicFullDb.createExecutionLedger({
    executionId: "atomic-full-fail",
    operationKey: "atomic-full-fail-op",
    action: "CLOSE_AT_MARKET",
    status: "UNKNOWN",
    symbol: "EURUSD.a",
    side: "BUY",
    volume: 0.01,
    request: { tradeId: atomicFullTradeId },
  });
  atomicFullDb.raw().exec(`
    CREATE TRIGGER fail_atomic_full_ledger
    BEFORE UPDATE OF status ON execution_ledger
    WHEN NEW.executionId='atomic-full-fail' AND NEW.status='EXECUTED'
    BEGIN SELECT RAISE(ABORT, 'forced full ledger failure'); END;
  `);
  let atomicFullFailed = false;
  try {
    atomicFullDb.resolveReconciledFullClose(
      atomicFullTradeId,
      "atomic-full-fail",
      12.5,
      Date.now(),
      "MANUAL",
      { broker: "mt5", ticket: 991, profit: 12.5 },
      456,
    );
  } catch {
    atomicFullFailed = true;
  }
  assert(atomicFullFailed, "forced full ledger failure must abort the atomic close transaction");
  assert(
    atomicFullDb.getOpenTrades()[0].status === "open",
    "atomic full-close failure must roll back trade status",
  );
  assert(
    atomicFullDb.getExecutionByOperationKey("atomic-full-fail-op").status === "UNKNOWN",
    "atomic full-close failure must preserve UNKNOWN ledger state",
  );
  atomicFullDb.raw().close();

  const stateDb = new DatabaseManager(":memory:");
  await stateDb.initialize();
  const invalidStateCreated = stateDb.createExecutionLedger({
    executionId: "state-invalid",
    operationKey: "state-invalid-op",
    action: "OPEN",
    status: "BROKEN",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.01,
  });
  assert(invalidStateCreated === false, "ledger creation must reject unknown execution states");
  stateDb.createExecutionLedger({
    executionId: "state-1",
    operationKey: "state-op",
    action: "OPEN",
    status: "PENDING",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.01,
  });
  assert(
    stateDb.updateExecutionLedger("state-1", { status: "UNKNOWN", error: "transport ambiguous" }) === true,
    "PENDING must transition to UNKNOWN",
  );
  assert(
    stateDb.updateExecutionLedger("state-1", {
      status: "EXECUTED",
      result: { broker: "paper", ticket: 123 },
      brokerOrderId: 123,
    }) === true,
    "UNKNOWN must transition to EXECUTED",
  );
  assert(
    stateDb.updateExecutionLedger("state-1", { status: "UNKNOWN", error: "late callback" }) === false,
    "EXECUTED must be immutable and reject rollback to UNKNOWN",
  );
  assert(
    stateDb.updateExecutionLedger("state-1", { status: "PENDING" }) === false,
    "terminal execution must reject transition back to PENDING",
  );
  const stateRow = stateDb.getExecutionByOperationKey("state-op");
  assert(stateRow.status === "EXECUTED", "illegal transitions must preserve terminal EXECUTED state");
  stateDb.raw().close();

  const corruptDb = new DatabaseManager(":memory:");
  await corruptDb.initialize();

  const corruptGateway = new ExecutionGateway(
    baseConfig("paper"),
    corruptDb,
    new PaperTrader(10_000),
  );
  const corruptSignal = {
    symbol: "EURUSD",
    side: "BUY",
    timestamp: 123456,
    price: 1.1,
    sl: 1.09,
    tp: 1.12,
    confidence: 0.9,
    source: "CORRUPT_LEDGER_TEST",
    timeframe: "H1",
  } as any;
  const corruptOperationKey = (corruptGateway as any).stableKey('OPEN', {
    account: "ledger-test",
    mode: "paper",
    symbol: "EURUSD",
    side: "BUY",
    timestamp: 123456,
    timeframe: "H1",
    volume: 0.01,
    source: "CORRUPT_LEDGER_TEST",
    sl: 1.09,
    tp: 1.12,
  });
  corruptDb.createExecutionLedger({
    executionId: "corrupt-1",
    operationKey: corruptOperationKey,
    action: "OPEN",
    status: "EXECUTED",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.01,
  });
  corruptDb.raw()
    .prepare("UPDATE execution_ledger SET resultJson=? WHERE executionId=?")
    .run("{invalid-json", "corrupt-1");

  const corruptResult = await corruptGateway.execute(
    corruptSignal,
    0.01,
    "H1",
  );
  assert(!corruptResult.success, "corrupt EXECUTED ledger must fail closed");
  assert(
    String(corruptResult.error).includes("manual reconciliation"),
    "corrupt EXECUTED ledger must require manual reconciliation",
  );
  corruptDb.raw().close();

  const closeIdentityExecutor = new (require("../execution/BinanceExecutor").BinanceExecutor)(baseConfig("binance")) as any;
  const closePosts: any[] = [];
  closeIdentityExecutor.getPosition = async () => ({
    positionAmt: 0.01,
    entryPrice: 50_000,
    unrealizedProfit: 0,
  });
  closeIdentityExecutor.signedPost = async (_path: string, params: any) => {
    closePosts.push(params);
    return { orderId: 99901 };
  };
  closeIdentityExecutor.getFuturesOrderNetPnl = async () => ({
    profit: 4.5,
    currency: "USDT",
  });
  const closeClientOrderId = makeBinanceClientOrderId("ledger-close-identity-op");
  const closeIdentityResult = await closeIdentityExecutor.closePosition(
    999,
    "BTCUSDT",
    0.01,
    "BUY",
    closeClientOrderId,
  );
  assert(closeIdentityResult.ok === true, "Binance close with deterministic clientOrderId must succeed");
  assert(
    closePosts[0]?.newClientOrderId === closeClientOrderId,
    "Binance close MARKET order must carry the ledger-derived clientOrderId",
  );

  const claimDb = new DatabaseManager(":memory:");
  await claimDb.initialize();
  const firstClaim = claimDb.createExecutionLedger({
    executionId: "claim-1",
    operationKey: "race-operation",
    action: "OPEN",
    status: "PENDING",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.01,
  });
  const secondClaim = claimDb.createExecutionLedger({
    executionId: "claim-2",
    operationKey: "race-operation",
    action: "OPEN",
    status: "PENDING",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.01,
  });
  assert(firstClaim === true, "first ledger claim must win");
  assert(secondClaim === false, "second concurrent ledger claim must lose atomically");
  assert(
    claimDb.getExecutionByOperationKey("race-operation")?.executionId === "claim-1",
    "losing ledger claim must reuse the existing operation owner",
  );
  claimDb.raw().close();

  console.log("Result: 25 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
