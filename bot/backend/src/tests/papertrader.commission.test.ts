import { PaperTrader } from '../integration/PaperTrader';
import { getSymbolSpec } from '../config/symbolConfig';

let passed = 0;
let failed = 0;

function assertClose(name: string, actual: number, expected: number, tolerance = 1e-9) {
  if (Math.abs(actual - expected) <= tolerance) {
    console.log(`PASS: ${name} -> actual=${actual} expected=${expected}`);
    passed++;
  } else {
    console.error(`FAIL: ${name} -> actual=${actual} expected=${expected}`);
    failed++;
  }
}

const openedAt = Date.now();

// Crypto regression: 0.10% per side on entry + exit notional.
{
  const trader = new PaperTrader(10_000);

  trader.restoreState([{
    ticket: 1,
    symbol: 'SOLUSDT',
    side: 'BUY',
    volume: 2,
    entry: 100,
    sl: 90,
    tp: 110,
    status: 'open',
    openedAt,
    source: 'TEST',
    timeframe: 'H1',
  }], []);

  const partial = trader.partialClose(1, 1, 101, 'PARTIAL');

  const expectedPartial =
    (101 - 100) * 1
    - (100 * 1 + 101 * 1) * 0.001;

  assertClose(
    'SOLUSDT partialClose crypto fee',
    partial.profit,
    expectedPartial,
  );

  const closed = trader.closeTrade(1, 102, 'MANUAL', openedAt + 1);

  const expectedRemaining =
    (102 - 100) * 1
    - (100 * 1 + 102 * 1) * 0.001;

  const expectedTotal = expectedPartial + expectedRemaining;

  assertClose(
    'SOLUSDT closeTrade cumulative profit',
    closed.profit,
    expectedTotal,
  );
}

// Non-crypto regression: preserve 7 USD/lot round-trip commission.
{
  const trader = new PaperTrader(10_000);
  const spec = getSymbolSpec('EURUSD');

  trader.restoreState([{
    ticket: 1,
    symbol: 'EURUSD',
    side: 'BUY',
    volume: 0.1,
    entry: 1.1000,
    sl: 1.0900,
    tp: 1.1200,
    status: 'open',
    openedAt,
    source: 'TEST',
    timeframe: 'H1',
  }], []);

  const partial = trader.partialClose(1, 0.05, 1.1010, 'PARTIAL');

  const raw = (1.1010 - 1.1000) * 0.05 * spec.contractSize;
  const expectedCommission = 7 * 0.05 * 2;
  const expectedPartial = raw - expectedCommission;

  assertClose(
    'EURUSD partialClose non-crypto commission',
    partial.profit,
    expectedPartial,
  );
}

console.log(`Result: ${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
