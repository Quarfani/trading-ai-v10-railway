import { BinanceExecutor } from '../execution/BinanceExecutor';
import { DatabaseManager } from '../database/DatabaseManager';
import { StartupReconciler } from '../integration/StartupReconciler';

let assertions = 0;

function assert(condition: unknown, message: string): asserts condition {
  assertions += 1;
  if (!condition) throw new Error(message);
}

function makeConfig(futures: boolean): any {
  return {
    accountName: 'phase2-test',
    accountCurrency: 'USD',
    mode: 'binance',
    binance: {
      apiKey: 'test-key',
      secret: 'test-secret',
      env: 'testnet',
      futures,
    },
  };
}

async function makeFixture(futures: boolean, recoverClose = true) {
  const db = new DatabaseManager(':memory:');
  await db.initialize();
  const config = makeConfig(futures);
  const executor = new BinanceExecutor(config);
  const parentOperationKey = futures ? 'phase2-futures-open-key' : 'phase2-spot-open-key';
  const childOperationKey = 'PROTECTION_FAIL:' + parentOperationKey;
  const parentExecutionId = futures ? 'phase2-futures-open-ledger' : 'phase2-spot-open-ledger';
  const childExecutionId = futures ? 'phase2-futures-emergency-ledger' : 'phase2-spot-emergency-ledger';
  const symbol = futures ? 'ETHUSDT' : 'BTCUSDT';
  const entryOrderId = futures ? 601 : 501;
  const closeOrderId = futures ? 602 : 502;
  const parentClientOrderId = executor.clientOrderIdForOperationKey(parentOperationKey);
  const emergencyClientOrderId = executor.clientOrderIdForOperationKey(childOperationKey);
  const now = Date.now();
  const signal = {
    symbol,
    side: 'BUY',
    price: 100,
    sl: 90,
    tp: 120,
    confidence: 0.8,
    timestamp: now - 2000,
    source: 'phase2-emergency-test',
  };
  const parentRequest = { timeframe: 'H1', signal, volume: 1 };
  const childRequest = {
    schemaVersion: 1,
    purpose: 'PROTECTION_FAILURE_EMERGENCY_CLOSE',
    protectionCleanupState: 'VERIFIED_NO_OPERATION_OWNED_ORDERS_ACTIVE',
    parentOperationKey,
    parentClientOrderId,
    symbol,
    entrySide: 'BUY',
    closeSide: 'SELL',
    requestedQuantity: 1,
    positionBeforeAmount: 1,
    positionBeforeSignedAmount: 1,
    signal,
    entryEvidence: { orderId: entryOrderId, entryPrice: 100, executedQty: 1 },
    failureReason: 'simulated protection failure',
    emergencyClientOrderId,
  };

  assert(db.createExecutionLedger({
    executionId: parentExecutionId,
    operationKey: parentOperationKey,
    action: 'OPEN',
    status: 'PENDING',
    symbol,
    side: 'BUY',
    volume: 1,
    request: parentRequest,
  }), 'parent OPEN ledger should be created');
  assert(db.createExecutionLedger({
    executionId: childExecutionId,
    operationKey: childOperationKey,
    action: 'PROTECTION_FAIL_CLOSE',
    status: 'PENDING',
    symbol,
    side: 'SELL',
    volume: 1,
    request: childRequest,
  }), 'emergency-close ledger should be created');
  db.updateExecutionLedger(parentExecutionId, { status: 'UNKNOWN', error: 'simulated process interruption' });
  db.updateExecutionLedger(childExecutionId, { status: 'UNKNOWN', error: 'simulated process interruption' });

  const entryFill: any = {
    orderId: entryOrderId,
    clientOrderId: parentClientOrderId,
    status: 'FILLED',
    executedQty: 1,
    avgPrice: 100,
    commission: 0.1,
    commissionCurrency: 'USDT',
    grossQuote: 100,
    feeQuote: 0.1,
    quoteCurrency: 'USDT',
    brokerTimestamp: now - 1000,
  };
  const closeFill: any = {
    orderId: closeOrderId,
    clientOrderId: emergencyClientOrderId,
    status: 'FILLED',
    executedQty: 1,
    avgPrice: 110,
    commission: 0.11,
    commissionCurrency: 'USDT',
    grossQuote: 110,
    feeQuote: 0.11,
    quoteCurrency: 'USDT',
    brokerTimestamp: now,
  };

  (executor as any).recoverOperationFillDetails = async (_symbol: string, operationKey: string) => {
    if (operationKey === parentOperationKey) return entryFill;
    if (operationKey === childOperationKey) return recoverClose ? closeFill : null;
    return null;
  };
  (executor as any).getPosition = async () => ({
    positionAmt: 0,
    entryPrice: 0,
    unrealizedProfit: 0,
  });
  (executor as any).recoverOrderByClientId = async (_symbol: string, clientOrderId: string) => {
    if (clientOrderId !== emergencyClientOrderId || !recoverClose) return null;
    return {
      orderId: closeOrderId,
      status: 'FILLED',
      executedQty: 1,
      avgPrice: 110,
      realizedProfit: 9.89,
      realizedProfitCurrency: 'USDT',
    };
  };

  const reconciler = new StartupReconciler(config, db, { sendMessage: async () => {} } as any);
  return {
    db,
    config,
    executor,
    reconciler,
    parentExecutionId,
    childExecutionId,
    parentOperationKey,
    childOperationKey,
    entryOrderId,
    closeOrderId,
  };
}

async function verifyExactFillRecovery() {
  const futuresConfig = makeConfig(true);
  const futuresExec = new BinanceExecutor(futuresConfig);
  const futuresKey = 'phase2-exact-futures-fill';
  const expectedFuturesClientId = futuresExec.clientOrderIdForOperationKey(futuresKey);
  let searchedFuturesClientId = '';
  (futuresExec as any).findOrderByClientId = async (_symbol: string, clientOrderId: string) => {
    searchedFuturesClientId = clientOrderId;
    return {
      orderId: 701,
      symbol: 'BTCUSDT',
      clientOrderId: expectedFuturesClientId,
      status: 'FILLED',
      executedQty: '1',
      avgPrice: '100',
      updateTime: Date.now(),
    };
  };
  (futuresExec as any).getFuturesOrderFillSummary = async () => ({
    currency: 'USDT',
    avgPrice: 100,
    commission: 0.1,
    totalQty: 1,
  });
  const futuresFill = await futuresExec.recoverOperationFillDetails('BTCUSDT', futuresKey, 1);
  assert(searchedFuturesClientId === expectedFuturesClientId, 'recovery must query the exact operation-derived clientOrderId');
  assert(futuresFill?.orderId === 701 && futuresFill.status === 'FILLED', 'Futures recovery must return exact filled order identity');
  assert(futuresFill?.commissionCurrency === 'USDT' && futuresFill.commission === 0.1, 'Futures recovery must include authoritative commission details');

  const spotConfig = makeConfig(false);
  const spotExec = new BinanceExecutor(spotConfig);
  const spotKey = 'phase2-exact-spot-fill';
  const expectedSpotClientId = spotExec.clientOrderIdForOperationKey(spotKey);
  let searchedSpotClientId = '';
  (spotExec as any).findOrderByClientId = async (_symbol: string, clientOrderId: string) => {
    searchedSpotClientId = clientOrderId;
    return {
      orderId: 702,
      symbol: 'BTCUSDT',
      clientOrderId: expectedSpotClientId,
      status: 'FILLED',
      executedQty: '1',
      updateTime: Date.now(),
    };
  };
  (spotExec as any).getSpotOrderFillSummary = async () => ({
    currency: 'USDT',
    avgPrice: 105,
    feeQuote: 0.12,
    totalQty: 1,
    grossQuote: 105,
  });
  const spotFill = await spotExec.recoverOperationFillDetails('BTCUSDT', spotKey, 1);
  assert(searchedSpotClientId === expectedSpotClientId, 'Spot recovery must query the exact operation-derived clientOrderId');
  assert(spotFill?.grossQuote === 105 && spotFill.feeQuote === 0.12, 'Spot recovery must preserve exact proceeds and quote-equivalent fees');

  (spotExec as any).findOrderByClientId = async () => ({
    orderId: 703,
    symbol: 'BTCUSDT',
    clientOrderId: expectedSpotClientId,
    status: 'PARTIALLY_FILLED',
    executedQty: '0.4',
  });
  const partial = await spotExec.recoverOperationFillDetails('BTCUSDT', spotKey, 1);
  assert(partial === null, 'partial emergency fills must not be treated as fully settled operations');
}

async function verifySettlement(futures: boolean) {
  const f = await makeFixture(futures);
  try {
    await (f.reconciler as any).resolveProtectionFailureEmergencyCloseLedgers(f.executor);
    const trades = f.db.getRecentTrades(10);
    assert(trades.length === 1, 'authoritative recovery should insert exactly one closed trade');
    assert(trades[0].status === 'closed', 'recovered emergency close must never be recorded as an open trade');
    assert(Number(trades[0].ticket) === f.entryOrderId, 'trade ticket must match the exact recovered entry order');
    assert(Math.abs(Number(trades[0].profit) - 9.79) < 1e-8, 'final PnL must include entry and exit costs exactly once');

    const parent = f.db.getExecutionByOperationKey(f.parentOperationKey);
    const child = f.db.getExecutionByOperationKey(f.childOperationKey);
    assert(parent.status === 'EXECUTED', 'parent OPEN ledger must be settled atomically');
    assert(child.status === 'EXECUTED', 'emergency-close child ledger must be settled atomically');
    assert(Number(parent.tradeId) === Number(trades[0].id), 'parent OPEN ledger must index the closed trade id');
    assert(Number(child.tradeId) === Number(trades[0].id), 'emergency-close child ledger must index the closed trade id');
    assert(JSON.parse(parent.resultJson).id === trades[0].id, 'parent OPEN result must carry the closed trade identity');
    assert(JSON.parse(child.resultJson).tradeId === trades[0].id, 'emergency-close result must carry the closed trade identity');

    const daily = f.db.raw().prepare('SELECT trades, pnl FROM daily_stats ORDER BY day DESC LIMIT 1').get() as any;
    assert(Number(daily.trades) === 1, 'daily statistics must count the recovered trade once');
    assert(Math.abs(Number(daily.pnl) - 9.79) < 1e-8, 'daily PnL must equal the net closed-trade result');

    await (f.reconciler as any).resolveProtectionFailureEmergencyCloseLedgers(f.executor);
    assert(f.db.getRecentTrades(10).length === 1, 'a second reconciliation pass must not duplicate the trade');
    const dailyAfter = f.db.raw().prepare('SELECT trades FROM daily_stats ORDER BY day DESC LIMIT 1').get() as any;
    assert(Number(dailyAfter.trades) === 1, 'a second reconciliation pass must not duplicate daily stats');
  } finally {
    f.db.raw().close();
  }
}

async function verifyPrecheckFailurePersistsIntent() {
  const db = new DatabaseManager(':memory:');
  await db.initialize();
  const config = makeConfig(true);
  const executor = new BinanceExecutor(config, db);
  const parentOperationKey = 'phase2-precheck-failure-open';
  const childOperationKey = 'PROTECTION_FAIL:' + parentOperationKey;
  const signal = {
    symbol: 'BTCUSDT',
    side: 'BUY',
    price: 100,
    sl: 90,
    tp: 120,
    confidence: 0.8,
    timestamp: Date.now(),
    source: 'phase2-precheck-failure',
  };
  let brokerPosts = 0;
  let cleanupCalls = 0;
  (executor as any).cancelProtectionForEmergencyClose = async () => {
    cleanupCalls += 1;
  };
  (executor as any).getPosition = async () => {
    throw new Error('simulated position endpoint failure');
  };
  (executor as any).signedPost = async () => {
    brokerPosts += 1;
    return { orderId: 801, status: 'FILLED', executedQty: '1' };
  };
  let thrown = false;
  try {
    await (executor as any).emergencyCloseAfterProtectionFailure(
      signal,
      1,
      parentOperationKey,
      executor.clientOrderIdForOperationKey(parentOperationKey),
      { orderId: 800, entryPrice: 100, executedQty: 1 },
      'simulated protection failure',
    );
  } catch {
    thrown = true;
  }
  try {
    const child = db.getExecutionByOperationKey(childOperationKey);
    assert(thrown, 'failed broker position precheck must stop the emergency order flow');
    assert(cleanupCalls === 1, 'operation-owned protection cleanup must run before the broker position precheck');
    assert(child !== null, 'emergency intent must be durable even if the precheck fails');
    assert(child.status === 'UNKNOWN', 'precheck failure must leave an unresolved emergency child');
    assert(brokerPosts === 0, 'no emergency market order may be sent without verified position state');
    const request = JSON.parse(child.requestJson);
    assert(request.submissionState === 'PRECHECK_NOT_STARTED', 'ledger must document that the broker close order was never armed');
    assert(request.positionBeforeAmount === null, 'failed precheck must not invent a position snapshot');
  } finally {
    db.raw().close();
  }
}

async function verifyMissingProtectionCleanupEvidenceBlocksSettlement() {
  const f = await makeFixture(true);
  try {
    const child = f.db.getExecutionByOperationKey(f.childOperationKey);
    const request = JSON.parse(child.requestJson);
    delete request.protectionCleanupState;
    assert(f.db.updateExecutionRequest(String(child.executionId), request), 'legacy emergency request should be made to simulate absent cleanup evidence');

    await (f.reconciler as any).resolveProtectionFailureEmergencyCloseLedgers(f.executor);
    assert(f.db.getRecentTrades(10).length === 0, 'recovery must not settle an emergency close without durable protection-cleanup proof');
    assert(f.db.getExecutionByOperationKey(f.parentOperationKey).status === 'UNKNOWN', 'parent OPEN remains unresolved without cleanup proof');
    assert(f.db.getExecutionByOperationKey(f.childOperationKey).status === 'UNKNOWN', 'emergency child remains unresolved without cleanup proof');
  } finally {
    f.db.raw().close();
  }
}

async function verifyUnresolvedCloseStaysBlocked() {
  const f = await makeFixture(true, false);
  try {
    await (f.reconciler as any).resolveProtectionFailureEmergencyCloseLedgers(f.executor);
    assert(f.db.getRecentTrades(10).length === 0, 'missing exact emergency fill must not create a trade');
    assert(f.db.getExecutionByOperationKey(f.parentOperationKey).status === 'UNKNOWN', 'parent OPEN must remain unresolved');
    assert(f.db.getExecutionByOperationKey(f.childOperationKey).status === 'UNKNOWN', 'emergency-close child must remain unresolved');
  } finally {
    f.db.raw().close();
  }
}

async function verifyAtomicRollback() {
  const f = await makeFixture(true);
  try {
    f.db.raw().exec(`
      CREATE TRIGGER reject_emergency_child_settlement
      BEFORE UPDATE OF status ON execution_ledger
      WHEN OLD.executionId = '${f.childExecutionId}' AND NEW.status = 'EXECUTED'
      BEGIN
        SELECT RAISE(ABORT, 'simulated child-ledger settlement failure');
      END;
    `);
    await (f.reconciler as any).resolveProtectionFailureEmergencyCloseLedgers(f.executor);
    assert(f.db.getRecentTrades(10).length === 0, 'trade insertion must roll back if child-ledger settlement fails');
    assert(f.db.getExecutionByOperationKey(f.parentOperationKey).status === 'UNKNOWN', 'parent ledger update must roll back atomically');
    assert(f.db.getExecutionByOperationKey(f.childOperationKey).status === 'UNKNOWN', 'child ledger remains UNKNOWN after rollback');
    const daily = f.db.raw().prepare('SELECT COUNT(*) count FROM daily_stats').get() as any;
    assert(Number(daily.count) === 0, 'daily statistics must roll back with the trade and ledgers');
  } finally {
    f.db.raw().close();
  }
}

async function verifyOrphanedOpenIncidentFailsClosed() {
  const db = new DatabaseManager(':memory:');
  await db.initialize();
  const config = makeConfig(true);
  const executor = new BinanceExecutor(config);
  const operationKey = 'phase2-orphaned-open-key';
  const symbol = 'BTCUSDT';
  const clientOrderId = executor.clientOrderIdForOperationKey(operationKey);
  const now = Date.now();
  const signal = {
    symbol,
    side: 'BUY',
    price: 100,
    sl: 90,
    tp: 120,
    confidence: 0.8,
    timestamp: now,
    source: 'phase2-orphaned-open',
  };
  assert(db.createExecutionLedger({
    executionId: 'phase2-orphaned-open-ledger',
    operationKey,
    action: 'OPEN',
    status: 'UNKNOWN',
    symbol,
    side: 'BUY',
    volume: 1,
    request: { timeframe: 'H1', signal, volume: 1 },
  }), 'orphaned OPEN ledger should be available for recovery');

  let queriedSymbol = '';
  let queriedOperationKey = '';
  let brokerPosts = 0;
  (executor as any).recoverOperationOrderForReconciliation = async (
    requestedSymbol: string,
    requestedOperationKey: string,
  ) => {
    queriedSymbol = requestedSymbol;
    queriedOperationKey = requestedOperationKey;
    return {
      symbol,
      clientOrderId,
      orderId: 990,
      status: 'FILLED',
      origQty: '1',
      executedQty: '1',
      updateTime: now,
    };
  };
  (executor as any).signedPost = async () => {
    brokerPosts += 1;
    throw new Error('no broker submission is allowed during orphaned OPEN reconciliation');
  };
  const reconciler = new StartupReconciler(
    config,
    db,
    { sendMessage: async () => {} } as any,
  );

  let blocked = false;
  try {
    await (reconciler as any).blockOrphanedBinanceOpenIntents(executor);
  } catch (error: any) {
    blocked = String(error?.message ?? error).includes('ORPHANED_BINANCE_OPEN');
  }

  try {
    assert(blocked, 'orphaned OPEN must block startup with a specific incident');
    assert(queriedSymbol === symbol && queriedOperationKey === operationKey, 'recovery must inspect the exact original OPEN identity');
    assert(brokerPosts === 0, 'orphan incident recovery must never submit or close any broker order automatically');
    assert(db.getExecutionByOperationKey(operationKey).status === 'UNKNOWN', 'orphaned OPEN must remain unresolved for operator reconciliation');
    assert(db.getExecutionByOperationKey('PROTECTION_FAIL:' + operationKey) === null, 'startup incident reporting must not fabricate an emergency-close child ledger');

    const incident = db.raw().prepare(`
      SELECT status, reason, brokerJson
      FROM reconciliation_events
      WHERE reason LIKE '%ORPHANED_BINANCE_OPEN%'
      ORDER BY timestamp DESC
      LIMIT 1
    `).get() as any;
    assert(incident != null, 'orphaned OPEN incident must be durably recorded');
    assert(String(incident.status) === 'BLOCKED', 'orphaned OPEN incident must be recorded as BLOCKED');
    assert(String(incident.reason).includes(operationKey), 'incident must retain the original operation identity');
    const evidence = JSON.parse(String(incident.brokerJson ?? 'null'));
    assert(Number(evidence.brokerEvidence?.orderId) === 990, 'incident must preserve exact broker order evidence');
    assert(String(evidence.brokerEvidence?.status) === 'FILLED', 'incident must record the broker fill status');
  } finally {
    db.raw().close();
  }
}

async function verifyModifyRecoveryCancelsPreviousProtection() {
  async function runCase(withPriorModification: boolean) {
    const db = new DatabaseManager(':memory:');
    await db.initialize();
    const config = makeConfig(true);
    const symbol = 'BTCUSDT';
    const now = Date.now();
    const signal = {
      symbol,
      side: 'BUY',
      price: 100,
      sl: 90,
      tp: 120,
      confidence: 0.8,
      timestamp: now - 5000,
      source: 'modify-recovery-test',
    };

    assert(db.createExecutionLedger({
      executionId: 'modify-recovery-open-execution',
      operationKey: 'modify-recovery-open-key',
      action: 'OPEN',
      status: 'PENDING',
      symbol,
      side: 'BUY',
      volume: 1,
      request: { timeframe: 'H1', signal, volume: 1 },
    }), 'OPEN identity ledger must be claimed');
    const tradeId = db.persistExecutedOpenTrade({
      ticket: 9301,
      symbol,
      timeframe: 'H1',
      side: 'BUY',
      volume: 1,
      entry: 100,
      sl: 90,
      tp: 120,
      status: 'open',
      openedAt: now - 5000,
      source: 'modify-recovery-test',
    } as any, 'modify-recovery-open-execution', 9301, {
      ticket: 9301,
      symbol,
      side: 'BUY',
      volume: 1,
      entry: 100,
      sl: 90,
      tp: 120,
      status: 'open',
    });
    assert(tradeId > 0, 'OPEN setup must persist the trade');

    let previousOperationKey = 'modify-recovery-open-key';
    if (withPriorModification) {
      previousOperationKey = 'modify-recovery-prior-move-key';
      assert(db.createExecutionLedger({
        executionId: 'modify-recovery-prior-move-execution',
        operationKey: previousOperationKey,
        action: 'MOVE_SL_TP',
        status: 'EXECUTED',
        symbol,
        side: 'BUY',
        volume: 1,
        request: { tradeId, newSl: 92, newTp: 122 },
      }), 'previous executed MOVE_SL_TP identity must be recorded');
      db.raw().prepare('UPDATE trades SET sl=?, tp=? WHERE id=?').run(92, 122, tradeId);
    }

    assert(db.createExecutionLedger({
      executionId: 'modify-recovery-current-execution',
      operationKey: 'modify-recovery-current-move-key',
      action: 'MOVE_SL_TP',
      status: 'UNKNOWN',
      symbol,
      side: 'BUY',
      volume: 1,
      request: { tradeId, newSl: 95, newTp: 125 },
    }), 'unresolved current MOVE_SL_TP ledger must be created');

    const executor = new BinanceExecutor(config);
    (executor as any).recoverProtectionByOperation = async (
      requestedSymbol: string,
      operationKey: string,
    ) => {
      assert(requestedSymbol === symbol, 'replacement Algo recovery must use the exact trade symbol');
      assert(operationKey === 'modify-recovery-current-move-key', 'replacement Algo recovery must query the unresolved modification key');
      return {
        sl: {
          symbol,
          orderId: 9302,
          clientOrderId: 'replacement-sl-client-algo-id',
          status: 'NEW',
          type: 'STOP_MARKET',
          side: 'SELL',
          closePosition: true,
          stopPrice: 95,
        },
        tp: {
          symbol,
          orderId: 9303,
          clientOrderId: 'replacement-tp-client-algo-id',
          status: 'NEW',
          type: 'TAKE_PROFIT_MARKET',
          side: 'SELL',
          closePosition: true,
          stopPrice: 125,
        },
      };
    };
    let cancellationCalls = 0;
    (executor as any).cancelProtectionByOperationKey = async (
      requestedSymbol: string,
      entrySide: string,
      operationKey: string,
    ) => {
      cancellationCalls += 1;
      assert(requestedSymbol === symbol, 'prior-protection cleanup must use the trade symbol');
      assert(entrySide === 'BUY', 'prior-protection cleanup must preserve entry side');
      assert(operationKey === previousOperationKey, 'recovery must cancel only the prior active protection operation');
      assert(
        db.getExecutionByOperationKey('modify-recovery-current-move-key').status === 'UNKNOWN',
        'current modification must not settle before exact prior-protection cleanup succeeds',
      );
    };

    const reconciler = new StartupReconciler(config, db, { sendMessage: async () => {} } as any);
    try {
      await (reconciler as any).resolveAuthoritativeBinanceModifyLedgers(
        executor,
        [{ symbol, positionAmt: 1, entryPrice: 100 }],
      );
      assert(cancellationCalls === 1, 'recovery must cancel one prior operation-owned protection pair');
      assert(
        db.getExecutionByOperationKey('modify-recovery-current-move-key').status === 'EXECUTED',
        'replacement modification may settle after prior protection cleanup is verified',
      );
      const trade = db.raw().prepare('SELECT sl, tp FROM trades WHERE id=?').get(tradeId) as any;
      assert(Number(trade.sl) === 95 && Number(trade.tp) === 125, 'recovered replacement targets must be persisted on the trade');
    } finally {
      db.raw().close();
    }
  }

  await runCase(false);
  await runCase(true);
}

async function main() {
  await verifyPrecheckFailurePersistsIntent();
  await verifyOrphanedOpenIncidentFailsClosed();
  await verifyExactFillRecovery();
  await verifySettlement(false);
  await verifySettlement(true);
  await verifyMissingProtectionCleanupEvidenceBlocksSettlement();
  await verifyUnresolvedCloseStaysBlocked();
  await verifyAtomicRollback();
  await verifyModifyRecoveryCancelsPreviousProtection();
  console.log(`Result: ${assertions} passed, 0 failed`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
