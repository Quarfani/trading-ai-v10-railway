import { DatabaseManager } from '../database/DatabaseManager';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = new DatabaseManager(':memory:');
  await db.initialize();

  const tradeId = db.insertTrade({
    ticket: 4501,
    symbol: 'EURUSD.a',
    timeframe: 'H1',
    side: 'BUY',
    volume: 0.01,
    entry: 1.1,
    sl: 1.09,
    tp: 1.12,
    status: 'open',
    openedAt: Date.now(),
    source: 'ML_OUTCOME_TEST',
    realizedProfit: 5.0,
    mlPredictionId: 'prediction-4501',
  } as any);

  db.raw().prepare(
    'INSERT INTO model_decisions(' +
    'predictionId,modelName,modelVersion,promptVersion,inputHash,output,latencyMs,decision,symbol,timestamp,timeframe,predictedLabel' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    'prediction-4501',
    'xgboost',
    'v-test',
    '',
    'hash',
    '{}',
    1,
    'BUY',
    'EURUSD.a',
    Date.now(),
    'H1',
    1,
  );

  db.createExecutionLedger({
    executionId: 'ml-close-4501',
    operationKey: 'ml-close-4501-op',
    action: 'CLOSE_AT_MARKET',
    status: 'UNKNOWN',
    symbol: 'EURUSD.a',
    side: 'BUY',
    volume: 0.01,
    request: { tradeId: tradeId },
  });

  const closedAt = Date.now();
  const ok = db.resolveReconciledFullClose(
    tradeId,
    'ml-close-4501',
    2.5,
    closedAt,
    'MANUAL',
    { realizedProfit: 2.5 },
    9901,
  );

  assert(ok, 'full close transaction must succeed');
  const trade = db.raw().prepare(
    'SELECT status, profit, realizedProfit FROM trades WHERE id=?',
  ).get(tradeId) as any;
  assert(trade.status === 'closed', 'trade must close atomically');
  assert(
    Number(trade.profit) === 7.5,
    'final trade profit must include prior realized partial PnL exactly once',
  );

  const outcome = db.raw().prepare(
    'SELECT predictedLabel,outcomeLabel,outcomeProfit,outcomeRecordedAt,outcomeSentAt ' +
    'FROM model_decisions WHERE predictionId=?',
  ).get('prediction-4501') as any;
  assert(Number(outcome.predictedLabel) === 1, 'predicted BUY label must persist');
  assert(Number(outcome.outcomeLabel) === 1, 'profitable BUY must map to actual BUY label');
  assert(Number(outcome.outcomeProfit) === 7.5, 'ML outcome must use cumulative final PnL');
  assert(Number(outcome.outcomeRecordedAt) > 0, 'ML outcome must be recorded atomically');
  assert(outcome.outcomeSentAt == null, 'new ML outcome must remain pending in the outbox');

  const pending = db.getPendingModelOutcomes();
  assert(
    pending.length === 1 && pending[0].predictionId === 'prediction-4501',
    'closed prediction must be available through the ML outbox',
  );

  assert(
    db.markModelOutcomeSent('prediction-4501'),
    'outbox row must be markable as sent',
  );
  assert(
    db.getPendingModelOutcomes().length === 0,
    'sent ML outcome must leave the pending outbox',
  );

  const replay = db.resolveReconciledFullClose(
    tradeId,
    'ml-close-4501',
    2.5,
    closedAt + 1,
    'MANUAL',
    { realizedProfit: 2.5 },
    9901,
  );
  assert(!replay, 'already-closed trade must not resolve full-close twice');

  db.raw().close();
  console.log('Result: 7 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
