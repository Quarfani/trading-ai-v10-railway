/**
 * Tests: MarketRegimeDetector
 */
import { MarketRegimeDetector } from '../core/MarketRegimeDetector';
import { Candle } from '../types/trading.types';

function makeCandles(n: number, trend: 'up'|'down'|'flat' = 'flat'): Candle[] {
  const candles: Candle[] = [];
  let price = 1.2000;
  for (let i = 0; i < n; i++) {
    if (trend === 'up')   price += 0.0002;
    if (trend === 'down') price -= 0.0002;
    // Slight noise
    const noise = (Math.random() - 0.5) * 0.0001;
    const open  = price + noise;
    const close = price + noise * 1.1;
    candles.push({
      time: Date.now() - (n - i) * 60_000,
      open, high: close + 0.0003,
      low: open - 0.0003, close,
      volume: 1000 + Math.random() * 500,
    });
  }
  return candles;
}

describe('MarketRegimeDetector', () => {
  const detector = new MarketRegimeDetector();

  test('returns UNKNOWN for insufficient data', () => {
    const r = detector.detect('EURUSD', 'H1', makeCandles(10));
    expect(r.regime).toBe('UNKNOWN');
  });

  test('detects regime from sufficient candles', () => {
    const r = detector.detect('EURUSD', 'H1', makeCandles(200, 'up'));
    expect(['TRENDING','RANGING','VOLATILE','UNKNOWN']).toContain(r.regime);
    expect(r.adx).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  test('caches result within TTL', () => {
    const candles = makeCandles(200);
    const r1 = detector.detect('GBPUSD', 'H1', candles);
    const r2 = detector.detect('GBPUSD', 'H1', makeCandles(200, 'down')); // different candles
    // Second call should return cached result
    expect(r2.updatedAt).toBe(r1.updatedAt);
  });

  test('invalidate clears cache', () => {
    const candles = makeCandles(200);
    detector.detect('USDJPY', 'H1', candles);
    detector.invalidate('USDJPY');
    const r2 = detector.detect('USDJPY', 'H1', makeCandles(200, 'up'));
    expect(r2.updatedAt).toBeGreaterThan(0);
  });

  test('supports uncached historical inference', () => {
    const r1 = detector.detect('XAUUSD', 'H1', makeCandles(200, 'flat'));
    const r2 = detector.detect(
      'XAUUSD',
      'H1',
      makeCandles(200, 'down'),
      { useCache: false },
    );
    expect(r2).not.toBe(r1);
  });

  test('volumeMultiplier is within expected range', () => {
    expect(MarketRegimeDetector.volumeMultiplier('TRENDING')).toBe(1.0);
    expect(MarketRegimeDetector.volumeMultiplier('VOLATILE')).toBe(0.5);
    expect(MarketRegimeDetector.volumeMultiplier('RANGING')).toBe(0.8);
    expect(MarketRegimeDetector.volumeMultiplier('UNKNOWN')).toBe(0.7);
  });
});
