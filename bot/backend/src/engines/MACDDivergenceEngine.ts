/**
 * MACD DIVERGENCE ENGINE
 * ══════════════════════════════════════════════════════════════════════════
 * يكتشف انحرافات MACD الحقيقية (Regular + Hidden Divergence):
 *
 *  Regular Bullish:  السعر يصنع قاعاً أدنى + MACD يصنع قاعاً أعلى
 *                    → احتمال انعكاس صعودي
 *  Regular Bearish:  السعر يصنع قمة أعلى + MACD يصنع قمة أدنى
 *                    → احتمال انعكاس هبوطي
 *  Hidden Bullish:   السعر يصنع قاعاً أعلى + MACD يصنع قاعاً أدنى
 *                    → استمرار الاتجاه الصعودي
 *  Hidden Bearish:   السعر يصنع قمة أدنى + MACD يصنع قمة أعلى
 *                    → استمرار الاتجاه الهبوطي
 *
 * إضافات الجودة:
 *   - يتحقق من Histogram Momentum (تسارع أو تباطؤ)
 *   - يشترط اختلافاً حداً أدنى في MACD (يمنع إشارات الضوضاء)
 *   - SL خلف آخر Swing
 * ══════════════════════════════════════════════════════════════════════════
 */
import { MACD, EMA, ADX } from 'technicalindicators';
import { Candle, Signal }  from '../types/trading.types';
import { calculateATR, atrStopLoss, atrTakeProfit, dynamicTakeProfit } from '../utils/ATR';
import { getSymbolSpec }   from '../config/symbolConfig';

interface MACDPoint {
  index: number;
  macd:  number;
  hist:  number;
  price: number; // close at this bar
  high:  number;
  low:   number;
}

export class MACDDivergenceEngine {
  readonly name = 'MACD_DIV';

  analyze(symbol: string, candles: Candle[]): Signal | null {
    if (candles.length < 100) return null;

    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);

    // ── MACD values ────────────────────────────────────────────────────
    const macdResult = MACD.calculate({
      values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      SimpleMAOscillator: false, SimpleMASignal: false,
    });
    if (macdResult.length < 30) return null;

    // ── ADX — Divergence works best in moderate ADX (15–30) ──────────
    let adxVal = 22;
    try {
      const adxR = ADX.calculate({ period: 14, close: closes, high: highs, low: lows });
      adxVal = adxR[adxR.length - 1]?.adx ?? 22;
    } catch { /* pass */ }
    // Skip strong trends (ADX > 35) for regular divergence (use hidden div there)
    // Skip very weak markets (ADX < 12)
    if (adxVal < 12) return null;

    // Build MACD pivots for last 60 bars
    const LOOK = Math.min(60, macdResult.length);
    const pivots: MACDPoint[] = [];

    for (let i = 2; i < LOOK - 1; i++) {
      const idx    = macdResult.length - LOOK + i;
      const candleIdx = candles.length - LOOK + i;
      const cur  = macdResult[idx];
      const prev = macdResult[idx - 1];
      const next = macdResult[idx + 1];
      if (!cur?.histogram || !prev?.histogram || !next?.histogram) continue;

      const isHistHigh = cur.histogram > prev.histogram && cur.histogram > next.histogram;
      const isHistLow  = cur.histogram < prev.histogram && cur.histogram < next.histogram;

      if (isHistHigh || isHistLow) {
        pivots.push({
          index: candleIdx,
          macd:  cur.MACD   ?? 0,
          hist:  cur.histogram,
          price: closes[candleIdx],
          high:  highs[candleIdx],
          low:   lows[candleIdx],
        });
      }
    }

    if (pivots.length < 2) return null;

    const last     = candles[candles.length - 1];
    const atr      = calculateATR(candles.slice(-50), 14) || last.close * 0.005;
    const lastMACD = macdResult[macdResult.length - 1];
    if (!lastMACD) return null;

    // ── Find divergence type ──────────────────────────────────────────
    const lowPivots  = pivots.filter(p => p.hist < 0).slice(-3);
    const highPivots = pivots.filter(p => p.hist > 0).slice(-3);

    let signal: Signal | null = null;

    // ── REGULAR BULLISH ───────────────────────────────────────────────
    if (lowPivots.length >= 2 && adxVal < 35) {
      const p1 = lowPivots[lowPivots.length - 2];
      const p2 = lowPivots[lowPivots.length - 1];
      const priceLowerLow = p2.low < p1.low;
      const macdHigherLow = p2.hist > p1.hist;
      const histDiff      = Math.abs(p2.hist - p1.hist) > 0.0001;

      if (priceLowerLow && macdHigherLow && histDiff) {
        // Current MACD must be starting to turn positive
        const hist = lastMACD.histogram ?? 0;
        if (hist > p2.hist) { // histogram improving
          let conf = 0.60;
          if (adxVal < 25) conf += 0.06; // better in ranging
          if (Math.abs(p2.hist - p1.hist) > 0.0005) conf += 0.05; // strong divergence
          conf = Math.min(0.84, conf);

          signal = this.mk(symbol, 'BUY', last.close, conf,
            `Regular Bullish Divergence: price LL, MACD HL | ADX ${adxVal.toFixed(1)}`,
            candles, atr);
        }
      }
    }

    // ── REGULAR BEARISH ───────────────────────────────────────────────
    if (!signal && highPivots.length >= 2 && adxVal < 35) {
      const p1 = highPivots[highPivots.length - 2];
      const p2 = highPivots[highPivots.length - 1];
      const priceHigherHigh = p2.high > p1.high;
      const macdLowerHigh   = p2.hist < p1.hist;
      const histDiff        = Math.abs(p2.hist - p1.hist) > 0.0001;

      if (priceHigherHigh && macdLowerHigh && histDiff) {
        const hist = lastMACD.histogram ?? 0;
        if (hist < p2.hist) {
          let conf = 0.60;
          if (adxVal < 25) conf += 0.06;
          if (Math.abs(p2.hist - p1.hist) > 0.0005) conf += 0.05;
          conf = Math.min(0.84, conf);

          signal = this.mk(symbol, 'SELL', last.close, conf,
            `Regular Bearish Divergence: price HH, MACD LH | ADX ${adxVal.toFixed(1)}`,
            candles, atr);
        }
      }
    }

    // ── HIDDEN BULLISH (trend continuation in uptrend) ────────────────
    if (!signal && lowPivots.length >= 2 && adxVal >= 20) {
      const e50 = EMA.calculate({ period: 50, values: closes });
      const ema = e50[e50.length - 1];
      if (last.close > ema) { // Must be in uptrend
        const p1 = lowPivots[lowPivots.length - 2];
        const p2 = lowPivots[lowPivots.length - 1];
        const priceHigherLow = p2.low > p1.low;
        const macdLowerLow   = p2.hist < p1.hist;

        if (priceHigherLow && macdLowerLow) {
          let conf = 0.58;
          if (adxVal > 25) conf += 0.07;
          conf = Math.min(0.80, conf);

          signal = this.mk(symbol, 'BUY', last.close, conf,
            `Hidden Bullish Divergence: trend continuation | ADX ${adxVal.toFixed(1)}`,
            candles, atr);
        }
      }
    }

    // ── HIDDEN BEARISH (trend continuation in downtrend) ─────────────
    if (!signal && highPivots.length >= 2 && adxVal >= 20) {
      const e50 = EMA.calculate({ period: 50, values: closes });
      const ema = e50[e50.length - 1];
      if (last.close < ema) { // Must be in downtrend
        const p1 = highPivots[highPivots.length - 2];
        const p2 = highPivots[highPivots.length - 1];
        const priceLowerHigh = p2.high < p1.high;
        const macdHigherHigh = p2.hist > p1.hist;

        if (priceLowerHigh && macdHigherHigh) {
          let conf = 0.58;
          if (adxVal > 25) conf += 0.07;
          conf = Math.min(0.80, conf);

          signal = this.mk(symbol, 'SELL', last.close, conf,
            `Hidden Bearish Divergence: trend continuation | ADX ${adxVal.toFixed(1)}`,
            candles, atr);
        }
      }
    }

    return signal;
  }

  private mk(
    symbol: string, side: 'BUY' | 'SELL', price: number,
    confidence: number, reason: string, candles: Candle[], atr: number,
  ): Signal {
    const spec = getSymbolSpec(symbol);
    const tp   = dynamicTakeProfit(side, price, atr, spec.atrMult * spec.tpRatio, candles);
    return {
      symbol, side, price, confidence,
      sl:        atrStopLoss(side, price, atr, spec.atrMult),
      tp,
      source:    this.name,
      reason,
      timestamp: Date.now(),
    };
  }
}
