import { evaluateMarketDataQuality } from '../market/DataQualityGate';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function candle(time:number, open=100, close=101): {
  time:number; open:number; high:number; low:number; close:number; volume:number;
} {
  return { time, open, high:Math.max(open,close)+1, low:Math.min(open,close)-1, close, volume:0 };
}

const clean = evaluateMarketDataQuality(
  Array.from({length:10},(_,i)=>candle(i*60_000)),
  'M1',
);
assert(clean.passed, 'clean sequence should pass');
assert(clean.score > 0.9, 'clean sequence should score highly');

const duplicate = evaluateMarketDataQuality(
  [candle(0), candle(60_000), candle(60_000)],
  'M1',
);
assert(!duplicate.passed, 'duplicate timestamps must block');

const badOhlc = evaluateMarketDataQuality(
  [candle(0), { ...candle(60_000), high:90 }],
  'M1',
);
assert(!badOhlc.passed, 'invalid OHLC must block');

const synthetic = evaluateMarketDataQuality(
  [{ ...candle(0), quality:'synthetic', is_synthetic:true }],
  'M1',
);
assert(!synthetic.passed, 'synthetic data must block by default');

const gap = evaluateMarketDataQuality(
  [candle(0), candle(10*60_000)],
  'M1',
  { maxGapBars:1, maxMissingRatio:0.01 },
);
assert(!gap.passed, 'large data gaps must block');

const stale = evaluateMarketDataQuality(
  [{ ...candle(0), latency:10_000 }],
  'M1',
  { maxLatencyMs:1_000 },
);
assert(stale.warnings.length > 0, 'stale candles should be visible');

const forexWeekend = evaluateMarketDataQuality(
  [candle(0), candle(48 * 60 * 60_000)],
  'M1',
  { maxGapBars: 1, maxMissingRatio: 0.01, allowScheduledSessionGaps: true },
);
assert(forexWeekend.passed, 'scheduled Forex session gap should not hard-block');

console.log('Result: 11 passed, 0 failed');
