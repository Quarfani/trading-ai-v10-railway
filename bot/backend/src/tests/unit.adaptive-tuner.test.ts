import { DatabaseManager } from '../database/DatabaseManager';
import { AdaptiveTuner } from '../ai/AdaptiveTuner';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = new DatabaseManager(':memory:');
  await db.initialize();

  const now = Date.now();
  const add = (id: number, source: string, profit: number) => {
    db.raw().prepare(
      "INSERT INTO trades(ticket,symbol,timeframe,side,volume,entry,sl,tp,status,openedAt,closedAt,profit,source) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      'EURUSD',
      'H1',
      'BUY',
      0.1,
      1.1,
      1.09,
      1.12,
      'closed',
      now - id * 1000,
      now - id * 500,
      profit,
      source,
    );
  };

  for (let i = 1; i <= 10; i++) add(i, 'TREND+RSI', 10);
  for (let i = 101; i <= 110; i++) add(i, 'TREND+RSI_FAST', 100);

  const entries = new Map<string, any>([
    ['TREND', { metrics: {} }],
    ['RSI', { metrics: {} }],
    ['RSI_FAST', { metrics: {} }],
  ]);
  const registry = { getAll: () => entries };
  const tuner = new AdaptiveTuner(
    db,
    registry,
    { mode: 'paper' } as any,
  );

  (tuner as any).tune();

  assert(
    Math.abs(entries.get('TREND').metrics.expectancy - 55) < 1e-12,
    'AdaptiveTuner expectancy must be weighted by composite trade counts',
  );
  assert(
    Math.abs(entries.get('RSI').metrics.expectancy - 10) < 1e-12,
    'RSI attribution must not include RSI_FAST trades',
  );
  assert(
    Math.abs(entries.get('RSI_FAST').metrics.expectancy - 100) < 1e-12,
    'RSI_FAST attribution must remain separate from RSI',
  );

  db.raw().close();
  console.log('Result: 3 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
