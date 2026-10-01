import { resolveQuoteToAccount } from '../market/CurrencyConverter';
import { checkExposureAndLeverage } from '../risk/ExposureGuard';
import { Trade } from '../types/trading.types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function approx(actual: number, expected: number, tolerance = 1e-9) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected}, got ${actual}`,
  );
}

assert(resolveQuoteToAccount('USD', 'USD', {}) === 1, 'USD->USD must be 1');
assert(resolveQuoteToAccount('USDT', 'USD', {}) === 1, 'USDT->USD paper proxy must be 1');

approx(
  resolveQuoteToAccount('GBP', 'USD', { GBPUSD: 1.25 }) ?? 0,
  1.25,
);
approx(
  resolveQuoteToAccount('JPY', 'USD', { USDJPY: 150 }) ?? 0,
  1 / 150,
);

const openTrades: Trade[] = [{
  symbol: 'EURUSD',
  volume: 1,
  entry: 1,
  sl: 0.99,
  tp: 1.02,
  side: 'BUY',
  status: 'open',
  openedAt: Date.now(),
  source: 'TREND',
}];

const result = checkExposureAndLeverage(
  openTrades,
  { symbol: 'EURUSD', volume: 0.5, entry: 1 },
  100_000,
  'USD',
  2,
  3,
  {},
);

assert(result.allowed, '1.5x gross exposure should be allowed under 2x/3x caps');
approx(result.snapshot?.totalExposure ?? 0, 150_000);

const blocked = checkExposureAndLeverage(
  openTrades,
  { symbol: 'EURUSD', volume: 2, entry: 1 },
  100_000,
  'USD',
  2,
  3,
  {},
);
assert(!blocked.allowed, '3x gross exposure must fail a 2x exposure cap');

const cross = checkExposureAndLeverage(
  [],
  { symbol: 'EURGBP', volume: 1, entry: 1.1 },
  100_000,
  'USD',
  2,
  3,
  {},
);
assert(!cross.allowed, 'EURGBP must fail closed without GBP->USD conversion');

console.log('Result: 10 passed, 0 failed');
