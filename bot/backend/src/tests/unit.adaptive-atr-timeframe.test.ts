import { AdaptiveATRManager } from '../optimization/AdaptiveATRManager';
import { DatabaseManager } from '../database/DatabaseManager';

async function main() {
  function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }

  const db = new DatabaseManager(':memory:');
  await db.initialize();
  const manager = new AdaptiveATRManager(db);

  const candles = Array.from({length:120}, (_, i) => ({
    time: Date.now() - (120 - i) * 3_600_000,
    open:100,
    high:101,
    low:99,
    close:100.5,
    volume:100,
  }));

  manager.getParams('EURUSD', candles, 'H1');
  manager.getParams('EURUSD', candles, 'M5');

  assert(
    manager.getSummary()['EURUSD_H1'] != null,
    'H1 adaptive state must be isolated',
  );
  assert(
    manager.getSummary()['EURUSD_M5'] != null,
    'M5 adaptive state must be isolated',
  );
  assert(
    process.env.SPEC_EURUSD_H1_ATR_MULT != null,
    'H1 override should use timeframe-scoped key',
  );
  assert(
    process.env.SPEC_EURUSD_M5_ATR_MULT != null,
    'M5 override should use timeframe-scoped key',
  );

  delete process.env.SPEC_EURUSD_H1_ATR_MULT;
  delete process.env.SPEC_EURUSD_H1_TP_RATIO;
  delete process.env.SPEC_EURUSD_M5_ATR_MULT;
  delete process.env.SPEC_EURUSD_M5_TP_RATIO;

  console.log('Result: 6 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
