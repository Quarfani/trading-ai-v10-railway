import axios from 'axios';
import { DatabaseManager } from '../database/DatabaseManager';
import { MLEnhancer } from '../ml/MLEnhancer';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function seed(db: DatabaseManager, id: string) {
  db.raw().prepare(
    'INSERT INTO model_decisions(' +
    'predictionId,modelName,modelVersion,promptVersion,inputHash,output,latencyMs,decision,symbol,timestamp,timeframe,predictedLabel,outcomeLabel,outcomeProfit,outcomeRecordedAt' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id, 'xgboost', 'v1', '', 'hash', '{}', 1, 'BUY',
    'BTCUSDT', Date.now(), '1h', 1, 1, 12.5, Date.now(),
  );
}

async function main() {
  const originalPost = (axios as any).post;

  try {
    const db = new DatabaseManager(':memory:');
    await db.initialize();
    await seed(db, 'outbox-success');

    const enhancer = new MLEnhancer(
      { mode: 'paper', mlRequired: false } as any,
      db,
    );
    (enhancer as any).available = true;

    let sentPayload: any = null;
    (axios as any).post = async (url: string, payload: any) => {
      sentPayload = { url, payload };
      return { data: { ok: true } };
    };

    await (enhancer as any).flushPendingOutcomes();

    assert(
      sentPayload?.payload?.prediction_id === 'outbox-success' &&
      sentPayload?.payload?.predicted_signal === 1 &&
      sentPayload?.payload?.actual_label === 1 &&
      sentPayload?.payload?.profit === 12.5,
      'ML outbox must send the authoritative prediction and outcome identity',
    );
    assert(
      db.getPendingModelOutcomes().length === 0,
      'successful ML outcome delivery must mark the outbox row sent',
    );

    if ((enhancer as any).outcomeFlushTimer) {
      clearInterval((enhancer as any).outcomeFlushTimer);
      (enhancer as any).outcomeFlushTimer = null;
    }
    db.raw().close();

    const retryDb = new DatabaseManager(':memory:');
    await retryDb.initialize();
    await seed(retryDb, 'outbox-retry');

    const retryEnhancer = new MLEnhancer(
      { mode: 'paper', mlRequired: false } as any,
      retryDb,
    );
    (retryEnhancer as any).available = true;
    (axios as any).post = async () => {
      throw new Error('ML server unavailable');
    };

    await (retryEnhancer as any).flushPendingOutcomes();
    assert(
      retryDb.getPendingModelOutcomes().length === 1,
      'failed ML outcome delivery must remain pending for retry',
    );

    if ((retryEnhancer as any).outcomeFlushTimer) {
      clearInterval((retryEnhancer as any).outcomeFlushTimer);
      (retryEnhancer as any).outcomeFlushTimer = null;
    }
    retryDb.raw().close();

    console.log('Result: 6 passed, 0 failed');
  } finally {
    (axios as any).post = originalPost;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
