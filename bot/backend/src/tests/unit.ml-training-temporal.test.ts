import { DatabaseManager } from '../database/DatabaseManager';
import { MLTrainingPipeline } from '../ml/MLTrainingPipeline';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = new DatabaseManager(':memory:');
  await db.initialize();

  const openedBefore = Date.parse('2026-09-20T10:00:00.000Z');
  const knownClosed = Date.parse('2026-09-20T11:00:00.000Z');
  const unknownAtSignal = Date.parse('2026-09-21T11:00:00.000Z');
  const asOf = Date.parse('2026-09-21T10:00:00.000Z');
  const cutoff = asOf - 30 * 24 * 3_600_000;

  db.raw().prepare(
    "INSERT INTO trades(ticket,symbol,timeframe,side,volume,entry,sl,tp,status,openedAt,closedAt,profit,source) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    1, 'EURUSD', 'H1', 'BUY', 0.1, 1.1, 1.09, 1.12, 'closed',
    openedBefore, knownClosed, 10, 'TREND',
  );
  db.raw().prepare(
    "INSERT INTO trades(ticket,symbol,timeframe,side,volume,entry,sl,tp,status,openedAt,closedAt,profit,source) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    2, 'EURUSD', 'H1', 'BUY', 0.1, 1.1, 1.09, 1.12, 'closed',
    openedBefore, unknownAtSignal, -10, 'TREND',
  );

  const pipeline = new MLTrainingPipeline(db) as any;
  const symbolWR = pipeline.getSymbolWRAsOf('EURUSD', asOf);
  const sourceWR = pipeline.getSourceWRAsOf('TREND', asOf);

  assert(
    Math.abs(symbolWR - 1) < 1e-12,
    'WR as-of must exclude outcomes that close after the signal time',
  );
  assert(
    Math.abs(sourceWR - 1) < 1e-12,
    'source WR as-of must exclude outcomes that close after the signal time',
  );
  assert(
    cutoff < knownClosed && knownClosed < asOf,
    'test data must include one known outcome in the lookback window',
  );

  db.raw().close();
  console.log('Result: 2 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
