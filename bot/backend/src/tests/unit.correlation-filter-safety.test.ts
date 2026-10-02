import { CorrelationFilter } from '../risk/CorrelationFilter';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function candles(offset: number, corrupt = false): any[] {
  return Array.from({ length: 20 }, (_, i) => ({
    time: Date.now() - (20 - i) * 60_000,
    open: 100 + i + offset,
    high: 101 + i + offset,
    low: 99 + i + offset,
    close: corrupt && i === 19 ? Number.NaN : 100 + i + offset,
    volume: 1,
  }));
}

const filter = new CorrelationFilter();
const clean = filter.isCorrelated(
  'EURUSD',
  'BUY',
  [{
    symbol: 'GBPUSD',
    side: 'BUY',
    volume: 0.1,
    entry: 1,
    sl: 0.99,
    tp: 1.02,
    status: 'open',
    openedAt: Date.now(),
  } as any],
  {
    EURUSD: candles(0),
    GBPUSD: candles(10),
  },
);
assert(typeof clean.blocked === 'boolean', 'clean correlation check must return a boolean');

const corrupt = filter.isCorrelated(
  'EURUSD',
  'BUY',
  [{
    symbol: 'GBPUSD',
    side: 'BUY',
    volume: 0.1,
    entry: 1,
    sl: 0.99,
    tp: 1.02,
    status: 'open',
    openedAt: Date.now(),
  } as any],
  {
    EURUSD: candles(0, true),
    GBPUSD: candles(10),
  },
);
assert(corrupt.blocked, 'corrupt correlation price data must fail closed');

console.log('Result: 2 passed, 0 failed');
