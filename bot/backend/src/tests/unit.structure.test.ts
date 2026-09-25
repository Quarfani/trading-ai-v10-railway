import { MarketStructureEngine } from '../engines/MarketStructureEngine';
import { Candle } from '../types/trading.types';

function makeCandles(pattern: 'bullish'|'bearish'|'flat', n=80): Candle[] {
  const candles: Candle[] = [];
  let price = 1.2000;
  const step = pattern === 'bullish' ? 0.0015 : pattern === 'bearish' ? -0.0015 : 0;
  for (let i = 0; i < n; i++) {
    const noise = (Math.random()-0.5)*0.0005;
    const wave  = Math.sin(i * 0.4) * 0.0010;
    price += step + wave * 0.3;
    candles.push({ time: Date.now() - (n-i)*60000, open: price, high: price+0.0008, low: price-0.0008, close: price+noise, volume: 1000 });
  }
  return candles;
}

describe('MarketStructureEngine', () => {
  const eng = new MarketStructureEngine();

  test('returns null for insufficient data', () => {
    expect(eng.analyze('EURUSD', makeCandles('flat', 30))).toBeNull();
  });

  test('signal has valid SL and TP', () => {
    const sig = eng.analyze('EURUSD', makeCandles('bullish', 80));
    if (sig) {
      expect(sig.sl).toBeGreaterThan(0);
      expect(sig.tp).toBeGreaterThan(0);
      expect(sig.confidence).toBeGreaterThan(0);
      expect(sig.confidence).toBeLessThanOrEqual(1);
    }
  });

  test('source is STRUCTURE', () => {
    const sig = eng.analyze('EURUSD', makeCandles('bullish', 80));
    if (sig) expect(sig.source).toBe('STRUCTURE');
  });
});
