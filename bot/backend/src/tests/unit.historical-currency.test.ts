import { resolveHistoricalQuoteToAccount } from '../market/HistoricalCurrencySeries';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function approx(actual: number | null, expected: number, tolerance = 1e-12) {
  assert(actual != null, 'expected a conversion rate');
  assert(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);
}

const series = {
  GBPUSD: [
    { time: 1_000, rate: 1.25 },
    { time: 2_000, rate: 1.20 },
  ],
  USDJPY: [
    { time: 1_000, rate: 150 },
    { time: 2_000, rate: 152 },
  ],
};

approx(resolveHistoricalQuoteToAccount('GBP', 'USD', 1_500, series), 1.25);
approx(resolveHistoricalQuoteToAccount('GBP', 'USD', 2_000, series), 1.20);
approx(resolveHistoricalQuoteToAccount('JPY', 'USD', 1_500, series), 1 / 150);
assert(
  resolveHistoricalQuoteToAccount('EUR', 'USD', 1_500, series) === null,
  'missing conversion must fail closed',
);
assert(
  resolveHistoricalQuoteToAccount('GBP', 'USD', 100_000, series, 10_000) === null,
  'stale conversion must fail closed',
);
approx(resolveHistoricalQuoteToAccount('USD', 'USD', 1_500, {}), 1);

console.log('Result: 6 passed, 0 failed');
