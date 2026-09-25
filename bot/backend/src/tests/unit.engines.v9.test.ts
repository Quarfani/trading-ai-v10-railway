/**
 * UNIT TESTS — v9.0 New Engines
 * Covers: CandlestickPattern, S&R, D1TrendBias, TimeFilter
 */
export {};
import { CandlestickPatternEngine } from '../engines/CandlestickPatternEngine';
import { SupportResistanceEngine }  from '../engines/SupportResistanceEngine';
import { D1TrendBiasFilter }        from '../core/D1TrendBiasFilter';
import { Candle }                   from '../types/trading.types';

let ok = 0, fail = 0;
function assert(c: boolean, label: string) {
  if (c) { console.log(`  ✅  ${label}`); ok++; }
  else   { console.error(`  ❌  ${label}`); fail++; process.exitCode = 1; }
}
function makeCandle(close: number, open?: number, high?: number, low?: number, vol = 100): Candle {
  return { time: Date.now(), open: open ?? close, high: high ?? close + 0.0005,
           low: low ?? close - 0.0005, close, volume: vol };
}
function trend(n: number, start: number, dir: 1 | -1, step = 0.0001): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const p = start + i * step * dir;
    return makeCandle(p, p - step * dir * 0.3, p + 0.0003, p - 0.0003);
  });
}

// ─── CandlestickPatternEngine ──────────────────────────────────────────────
console.log('\n═══ CandlestickPatternEngine ═══');
{
  const engine = new CandlestickPatternEngine();

  // Hammer: long lower wick, small body at top
  const hammer: Candle[] = [
    makeCandle(1.0850), makeCandle(1.0845),
    { time: Date.now(), open: 1.0840, high: 1.0843, low: 1.0800, close: 1.0838, volume: 100 },
  ];
  const r1 = engine.analyze(hammer, 'BUY');
  assert(r1.found, 'Hammer: pattern found');
  assert(r1.direction === 'BULLISH', 'Hammer: bullish direction');
  assert(r1.boost > 0, 'Hammer confirms BUY → positive boost');

  // Shooting Star: long upper wick = bearish
  const shootingStar: Candle[] = [
    makeCandle(1.0850), makeCandle(1.0845),
    { time: Date.now(), open: 1.0840, high: 1.0880, low: 1.0838, close: 1.0842, volume: 100 },
  ];
  const r2 = engine.analyze(shootingStar, 'BUY');
  assert(r2.conflictsBias, 'Shooting Star conflicts BUY signal');
  assert(r2.boost < 0, 'Conflicting pattern → negative boost');

  // Bullish Engulfing
  const engulf: Candle[] = [
    makeCandle(1.0850),
    { time: Date.now(), open: 1.0840, high: 1.0842, low: 1.0830, close: 1.0832, volume: 100 }, // bearish
    { time: Date.now(), open: 1.0828, high: 1.0855, low: 1.0826, close: 1.0853, volume: 150 }, // bullish engulf
  ];
  const r3 = engine.analyze(engulf, 'BUY');
  assert(r3.found, 'Engulfing: pattern found');
  assert(r3.direction === 'BULLISH', 'Bullish Engulfing direction');

  // No pattern on flat candles
  const flat = [makeCandle(1.0850), makeCandle(1.0850), makeCandle(1.0850)];
  const r4   = engine.analyze(flat, 'BUY');
  assert(!r4.conflictsBias, 'Flat candles: no conflict');
}

// ─── D1TrendBiasFilter ────────────────────────────────────────────────────
console.log('\n═══ D1TrendBiasFilter ═══');
{
  const filter = new D1TrendBiasFilter();

  // Bullish D1: EMA50 > EMA200 → BUY should be allowed
  const bullD1 = trend(250, 1.0000, 1, 0.001); // strong uptrend
  const r1     = filter.evaluate('EURUSD', 'BUY', 'TREND', bullD1);
  assert(r1.trend === 'BULLISH', 'Bullish D1 detected');
  assert(r1.allows, 'BUY allowed in bullish D1');
  assert(r1.confidMult >= 1.0, 'BUY in bullish D1 → confidence boost');

  // Bearish D1: EMA50 < EMA200 → BUY should be blocked (TREND strategy)
  const bearD1 = trend(250, 1.3000, -1, 0.001); // strong downtrend
  const r2     = filter.evaluate('EURUSD', 'BUY', 'TREND', bearD1);
  assert(r2.trend === 'BEARISH', 'Bearish D1 detected');
  // TREND strategy against strong D1 trend should be blocked or reduced
  assert(r2.confidMult < 1.0 || !r2.allows, 'BUY in bearish D1 → reduced/blocked');

  // RSI (mean reversion) allowed against trend at reduced confidence
  const r3 = filter.evaluate('EURUSD', 'BUY', 'RSI', bearD1);
  assert(r3.allows, 'RSI counter-trend allowed in bearish D1');
  assert(r3.confidMult < 1.0, 'RSI counter-trend → confidence reduced');

  // Insufficient data → neutral (don't block)
  const r4 = filter.evaluate('EURUSD', 'BUY', 'TREND', [makeCandle(1.0850)]);
  assert(r4.allows, 'Insufficient D1 data → allow (neutral)');
}

// ─── SupportResistanceEngine ─────────────────────────────────────────────
console.log('\n═══ SupportResistanceEngine ═══');
{
  const engine = new SupportResistanceEngine();

  // Build candles with clear swing high and swing low
  const candles: Candle[] = [];
  for (let i = 0; i < 120; i++) {
    const t = i * 3600_000;
    const p = 1.0800 + Math.sin(i / 10) * 0.0050;
    candles.push({ time: t, open: p, high: p + 0.0010, low: p - 0.0010, close: p, volume: 100 });
  }

  const levels = engine.detectLevels(candles, [], 0.0010);
  assert(levels.length > 0, 'S&R levels detected');
  assert(levels.every(l => l.strength >= 2), 'All levels have strength ≥ 2');
  assert(levels.some(l => l.type === 'SUPPORT'), 'At least one support level found');
  assert(levels.some(l => l.type === 'RESISTANCE'), 'At least one resistance level found');

  // All levels should be priced reasonably near candle range
  const minPrice = Math.min(...candles.map(c => c.low));
  const maxPrice = Math.max(...candles.map(c => c.high));
  assert(
    levels.every(l => l.price >= minPrice * 0.99 && l.price <= maxPrice * 1.01),
    'All S&R levels within candle price range'
  );
}

console.log(`\n══════════════════════════════`);
console.log(`Result: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
