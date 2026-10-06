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
  add(100, 'TREND+RSI_FAST', 100);

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
    Math.abs(entries.get('TREND').metrics.expectancy - (200 / 11)) < 1e-12,
    `AdaptiveTuner expectancy must be weighted by composite trade counts; got ${entries.get('TREND').metrics.expectancy}`,
  );
  assert(
    Math.abs(entries.get('RSI').metrics.expectancy - 10) < 1e-12,
    'RSI attribution must not include RSI_FAST trades',
  );
  assert(
    entries.get('RSI_FAST').metrics.expectancy === undefined,
    'RSI_FAST metrics must remain unchanged until the minimum trade sample is reached',
  );

  db.raw().close();
  console.log('Result: 3 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
