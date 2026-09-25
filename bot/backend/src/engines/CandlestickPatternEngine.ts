/**
 * CANDLESTICK PATTERN ENGINE — v9.0
 * ══════════════════════════════════════════════════════════════════════════
 * يكتشف أنماط الشمعات اليابانية ويُضيف تأكيداً قبل كل دخول.
 *
 * الأنماط المدعومة:
 *   ✦ Pin Bar (Hammer / Shooting Star) — أقوى نمط انعكاسي
 *   ✦ Bullish / Bearish Engulfing      — ابتلاع
 *   ✦ Morning Star / Evening Star      — نجمة الصباح/المساء
 *   ✦ Doji + Dragonfly / Gravestone    — تردد + انعكاس
 *   ✦ Three White Soldiers / Crows     — ثلاثة جنود/غربان
 *   ✦ Inside Bar Breakout              — اختراق داخل الشمعة
 *
 * الاستخدام:
 *   - يُستدعى من RiskManager قبل التنفيذ
 *   - يُعطي confidence boost (+0.05 → +0.12) إذا النمط يؤكد الاتجاه
 *   - يُرفض الدخول إذا النمط يعاكس الاتجاه (Reversal signal)
 * ══════════════════════════════════════════════════════════════════════════
 */
import { Candle, Side } from '../types/trading.types';

export interface PatternResult {
  found:         boolean;
  name:          string;
  direction:     'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength:      'STRONG' | 'MODERATE' | 'WEAK';
  confirmsBias:  boolean;   // does it confirm the signal direction?
  conflictsBias: boolean;   // does it contradict the signal direction?
  boost:         number;    // confidence boost (+ve) or penalty (-ve)
}

const NO_PATTERN: PatternResult = {
  found: false, name: 'NONE', direction: 'NEUTRAL',
  strength: 'WEAK', confirmsBias: false, conflictsBias: false, boost: 0,
};

export class CandlestickPatternEngine {

  analyze(candles: Candle[], signalSide: Side): PatternResult {
    if (candles.length < 3) return NO_PATTERN;

    const c0 = candles[candles.length - 1]; // current
    const c1 = candles[candles.length - 2]; // previous
    const c2 = candles[candles.length - 3]; // two bars ago

    const results: PatternResult[] = [
      this.checkPinBar(c0, c1),
      this.checkEngulfing(c0, c1),
      this.checkMorningStar(c0, c1, c2),
      this.checkEveningStar(c0, c1, c2),
      this.checkThreeSoldiers(c0, c1, c2),
      this.checkThreeCrows(c0, c1, c2),
      this.checkInsideBar(c0, c1, c2),
      this.checkDoji(c0),
    ].filter(r => r.found);

    if (!results.length) return NO_PATTERN;

    // Pick strongest pattern
    const best = results.sort((a, b) => {
      const str = { STRONG: 3, MODERATE: 2, WEAK: 1 };
      return str[b.strength] - str[a.strength];
    })[0];

    // Check if it confirms or conflicts with signal direction
    const confirms  = best.direction !== 'NEUTRAL' &&
      ((signalSide === 'BUY'  && best.direction === 'BULLISH') ||
       (signalSide === 'SELL' && best.direction === 'BEARISH'));
    const conflicts = best.direction !== 'NEUTRAL' &&
      ((signalSide === 'BUY'  && best.direction === 'BEARISH') ||
       (signalSide === 'SELL' && best.direction === 'BULLISH'));

    const boost = confirms  ? (best.strength === 'STRONG' ? 0.10 : best.strength === 'MODERATE' ? 0.06 : 0.03)
                : conflicts ? (best.strength === 'STRONG' ? -0.12 : best.strength === 'MODERATE' ? -0.07 : -0.03)
                : 0;

    return { ...best, confirmsBias: confirms, conflictsBias: conflicts, boost };
  }

  // ─── Pin Bar ──────────────────────────────────────────────────────────────
  private checkPinBar(c: Candle, prev: Candle): PatternResult {
    const range    = c.high - c.low;
    if (range === 0) return NO_PATTERN;

    const body     = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const bodyRatio = body / range;

    // Hammer (Bullish Pin Bar): small body at top, long lower wick
    if (lowerWick >= range * 0.60 && bodyRatio <= 0.30 && upperWick <= range * 0.15) {
      const strength: PatternResult['strength'] = lowerWick >= range * 0.75 ? 'STRONG' : 'MODERATE';
      return { found: true, name: 'Hammer (Bullish Pin Bar)', direction: 'BULLISH',
               strength, confirmsBias: false, conflictsBias: false, boost: 0 };
    }

    // Shooting Star (Bearish Pin Bar): small body at bottom, long upper wick
    if (upperWick >= range * 0.60 && bodyRatio <= 0.30 && lowerWick <= range * 0.15) {
      const strength: PatternResult['strength'] = upperWick >= range * 0.75 ? 'STRONG' : 'MODERATE';
      return { found: true, name: 'Shooting Star (Bearish Pin Bar)', direction: 'BEARISH',
               strength, confirmsBias: false, conflictsBias: false, boost: 0 };
    }

    return NO_PATTERN;
  }

  // ─── Engulfing ────────────────────────────────────────────────────────────
  private checkEngulfing(c: Candle, prev: Candle): PatternResult {
    const currBody = Math.abs(c.close - c.open);
    const prevBody = Math.abs(prev.close - prev.open);
    if (currBody === 0 || prevBody === 0) return NO_PATTERN;

    // Bullish Engulfing: prev bearish, current bullish and larger
    if (prev.close < prev.open && c.close > c.open &&
        c.open < prev.close && c.close > prev.open &&
        currBody > prevBody * 1.1) {
      const strength: PatternResult['strength'] = currBody > prevBody * 1.5 ? 'STRONG' : 'MODERATE';
      return { found: true, name: 'Bullish Engulfing', direction: 'BULLISH',
               strength, confirmsBias: false, conflictsBias: false, boost: 0 };
    }

    // Bearish Engulfing: prev bullish, current bearish and larger
    if (prev.close > prev.open && c.close < c.open &&
        c.open > prev.close && c.close < prev.open &&
        currBody > prevBody * 1.1) {
      const strength: PatternResult['strength'] = currBody > prevBody * 1.5 ? 'STRONG' : 'MODERATE';
      return { found: true, name: 'Bearish Engulfing', direction: 'BEARISH',
               strength, confirmsBias: false, conflictsBias: false, boost: 0 };
    }

    return NO_PATTERN;
  }

  // ─── Morning Star ─────────────────────────────────────────────────────────
  private checkMorningStar(c: Candle, c1: Candle, c2: Candle): PatternResult {
    const body0 = Math.abs(c.close - c.open);
    const body1 = Math.abs(c1.close - c1.open);
    const body2 = Math.abs(c2.close - c2.open);

    // c2 bearish large, c1 small (doji-like), c0 bullish large
    if (c2.close < c2.open && body2 > 0 &&
        body1 < body2 * 0.3 &&
        c.close > c.open && body0 > 0 &&
        c.close > (c2.open + c2.close) / 2) {
      return { found: true, name: 'Morning Star', direction: 'BULLISH',
               strength: 'STRONG', confirmsBias: false, conflictsBias: false, boost: 0 };
    }
    return NO_PATTERN;
  }

  // ─── Evening Star ─────────────────────────────────────────────────────────
  private checkEveningStar(c: Candle, c1: Candle, c2: Candle): PatternResult {
    const body0 = Math.abs(c.close - c.open);
    const body1 = Math.abs(c1.close - c1.open);
    const body2 = Math.abs(c2.close - c2.open);

    if (c2.close > c2.open && body2 > 0 &&
        body1 < body2 * 0.3 &&
        c.close < c.open && body0 > 0 &&
        c.close < (c2.open + c2.close) / 2) {
      return { found: true, name: 'Evening Star', direction: 'BEARISH',
               strength: 'STRONG', confirmsBias: false, conflictsBias: false, boost: 0 };
    }
    return NO_PATTERN;
  }

  // ─── Three White Soldiers ─────────────────────────────────────────────────
  private checkThreeSoldiers(c: Candle, c1: Candle, c2: Candle): PatternResult {
    const allBullish = c.close > c.open && c1.close > c1.open && c2.close > c2.open;
    const ascending  = c.close > c1.close && c1.close > c2.close;
    const each3rd    = c.open > c1.open && c1.open > c2.open;
    if (allBullish && ascending && each3rd) {
      return { found: true, name: 'Three White Soldiers', direction: 'BULLISH',
               strength: 'STRONG', confirmsBias: false, conflictsBias: false, boost: 0 };
    }
    return NO_PATTERN;
  }

  // ─── Three Black Crows ────────────────────────────────────────────────────
  private checkThreeCrows(c: Candle, c1: Candle, c2: Candle): PatternResult {
    const allBearish  = c.close < c.open && c1.close < c1.open && c2.close < c2.open;
    const descending  = c.close < c1.close && c1.close < c2.close;
    const each3rd     = c.open < c1.open && c1.open < c2.open;
    if (allBearish && descending && each3rd) {
      return { found: true, name: 'Three Black Crows', direction: 'BEARISH',
               strength: 'STRONG', confirmsBias: false, conflictsBias: false, boost: 0 };
    }
    return NO_PATTERN;
  }

  // ─── Inside Bar Breakout ──────────────────────────────────────────────────
  private checkInsideBar(c: Candle, c1: Candle, c2: Candle): PatternResult {
    // c1 is inside c2 (mother bar)
    const isInside = c1.high <= c2.high && c1.low >= c2.low;
    if (!isInside) return NO_PATTERN;

    // c0 breaks out of c2
    if (c.close > c2.high && c.close > c.open) {
      return { found: true, name: 'Inside Bar Bullish Breakout', direction: 'BULLISH',
               strength: 'MODERATE', confirmsBias: false, conflictsBias: false, boost: 0 };
    }
    if (c.close < c2.low && c.close < c.open) {
      return { found: true, name: 'Inside Bar Bearish Breakout', direction: 'BEARISH',
               strength: 'MODERATE', confirmsBias: false, conflictsBias: false, boost: 0 };
    }
    return NO_PATTERN;
  }

  // ─── Doji ─────────────────────────────────────────────────────────────────
  private checkDoji(c: Candle): PatternResult {
    const range = c.high - c.low;
    const body  = Math.abs(c.close - c.open);
    if (range === 0) return NO_PATTERN;

    if (body / range < 0.08) {  // very small body
      const lowerWick = Math.min(c.open, c.close) - c.low;
      const upperWick = c.high - Math.max(c.open, c.close);

      // Dragonfly Doji: long lower wick → bullish
      if (lowerWick > range * 0.65 && upperWick < range * 0.1) {
        return { found: true, name: 'Dragonfly Doji', direction: 'BULLISH',
                 strength: 'MODERATE', confirmsBias: false, conflictsBias: false, boost: 0 };
      }
      // Gravestone Doji: long upper wick → bearish
      if (upperWick > range * 0.65 && lowerWick < range * 0.1) {
        return { found: true, name: 'Gravestone Doji', direction: 'BEARISH',
                 strength: 'MODERATE', confirmsBias: false, conflictsBias: false, boost: 0 };
      }
      // Standard Doji → indecision
      return { found: true, name: 'Doji', direction: 'NEUTRAL',
               strength: 'WEAK', confirmsBias: false, conflictsBias: false, boost: 0 };
    }
    return NO_PATTERN;
  }

  /** Quick check: does current candle confirm direction? */
  quickConfirm(candles: Candle[], side: Side): boolean {
    const result = this.analyze(candles, side);
    return !result.conflictsBias;
  }
}
