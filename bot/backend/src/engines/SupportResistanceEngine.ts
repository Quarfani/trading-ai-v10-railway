/**
 * SUPPORT & RESISTANCE ENGINE — v9.0 (Strategy #9)
 * ══════════════════════════════════════════════════════════════════════════
 * يحدد مستويات الدعم/المقاومة الحقيقية ويُصدر إشارات عند:
 *   1. Bounce: السعر يرتد من مستوى S/R قوي
 *   2. Retest: اختراق ثم إعادة اختبار المستوى (أقوى وأكثر موثوقية)
 *
 * تحديد المستويات:
 *   - Swing Highs/Lows على H4/D1 (أقوى مستويات)
 *   - Round Numbers (1.1000, 1.1500, 150.00...) — مستويات سيكولوجية
 *   - Previous Day High/Low/Open/Close
 *   - Volume Profile POC (Point of Control)
 *
 * جودة المستوى تُقيَّم بـ:
 *   - كم مرة تم اختباره (أكثر = أقوى)
 *   - هل هو H4/D1 أم H1 (أعلى timeframe = أقوى)
 *   - هل هناك Volume عالٍ عنده
 * ══════════════════════════════════════════════════════════════════════════
 */
import { Candle, Signal, Side } from '../types/trading.types';
import { calculateATR, dynamicTakeProfit } from '../utils/ATR';
import { getSymbolSpec } from '../config/symbolConfig';

export interface SRLevel {
  price:       number;
  type:        'SUPPORT' | 'RESISTANCE';
  strength:    number;    // 1–5 (touches × timeframe weight)
  source:      'SWING' | 'ROUND' | 'PREV_DAY' | 'POC';
  timeframe:   string;
  lastTested:  number;    // bar index
}

export class SupportResistanceEngine {
  readonly name = 'SR';

  analyze(symbol: string, candles: Candle[], h4Candles: Candle[] = []): Signal | null {
    if (candles.length < 100) return null;

    const last    = candles[candles.length - 1];
    const atr     = calculateATR(candles.slice(-50), 14) || last.close * 0.005;
    const levels  = this.detectLevels(candles, h4Candles, atr);

    if (!levels.length) return null;

    // Find if price is near any level
    const nearby = levels.filter(l => Math.abs(last.close - l.price) < atr * 1.2);
    if (!nearby.length) return null;

    // Find strongest nearby level
    const strongest = nearby.sort((a, b) => b.strength - a.strength)[0];

    // Determine signal direction based on level type
    let side: Side;
    let scenario: string;

    if (strongest.type === 'SUPPORT') {
      // Price near support → BUY (bounce expected)
      // But only if price came FROM above (approaching support)
      const prev5closes  = candles.slice(-6, -1).map(c => c.close);
      const wasAbove     = prev5closes.some(c => c > strongest.price + atr * 0.3);
      const nowNear      = Math.abs(last.close - strongest.price) < atr * 0.8;
      if (!wasAbove || !nowNear) return null;
    // The support must remain BELOW the entry price.
    if (strongest.price >= last.close) return null;

      // Confirm: bullish candle pattern at support
      if (last.close < last.open) return null; // bearish candle at support → wait

      side     = 'BUY';
      scenario = `Bounce from Support ${strongest.price.toFixed(5)} (str=${strongest.strength} src=${strongest.source})`;

    } else {
      // Price near resistance → SELL (rejection expected)
      const prev5closes  = candles.slice(-6, -1).map(c => c.close);
      const wasBelow     = prev5closes.some(c => c < strongest.price - atr * 0.3);
      const nowNear      = Math.abs(last.close - strongest.price) < atr * 0.8;
      if (!wasBelow || !nowNear) return null;
    // The resistance must remain ABOVE the entry price.
    if (strongest.price <= last.close) return null;

      if (last.close > last.open) return null; // bullish candle at resistance → wait

      side     = 'SELL';
      scenario = `Rejection from Resistance ${strongest.price.toFixed(5)} (str=${strongest.strength} src=${strongest.source})`;
    }

    // Confidence based on level strength + proximity
    const proximity  = 1 - Math.abs(last.close - strongest.price) / (atr * 1.2);
    let confidence   = 0.55 + (strongest.strength - 1) * 0.05 + proximity * 0.08;
    confidence       = Math.min(0.85, confidence);

    const spec = getSymbolSpec(symbol);
    const sl = side === 'BUY'
      ? strongest.price - atr * 0.5  // SL below support
      : strongest.price + atr * 0.5; // SL above resistance

    const tp = dynamicTakeProfit(
      side,
      last.close,
      atr,
      spec.atrMult * spec.tpRatio,
      candles,
      sl,
    );

    // Final signal geometry guard.
    // BUY:  SL < Entry < TP
    // SELL: SL > Entry > TP
    const geometryValid =
      side === 'BUY'
        ? sl < last.close && tp > last.close
        : sl > last.close && tp < last.close;

    if (!geometryValid) return null;

    return {
      symbol, side, price: last.close, confidence, sl, tp,
      source:    this.name,
      reason:    scenario,
      timestamp: Date.now(),
    };
  }

  detectLevels(candles: Candle[], h4Candles: Candle[], atr: number): SRLevel[] {
    const levels: SRLevel[] = [];

    // ── 1. Swing Highs/Lows (most important) ──────────────────────────────
    levels.push(...this.findSwingLevels(candles.slice(-100), atr, 'H1', 1.0));
    if (h4Candles.length >= 30)
      levels.push(...this.findSwingLevels(h4Candles.slice(-60), atr, 'H4', 2.0));

    // ── 2. Round Numbers ─────────────────────────────────────────────────
    levels.push(...this.findRoundNumbers(candles, atr));

    // ── 3. Previous Day Levels ────────────────────────────────────────────
    levels.push(...this.findPrevDayLevels(candles));

    // Merge nearby levels (within 0.5×ATR)
    return this.mergeLevels(levels, atr * 0.5);
  }

  private findSwingLevels(candles: Candle[], atr: number, tf: string, weight: number): SRLevel[] {
    const levels: SRLevel[] = [];
    const LOOKBACK = 3; // bars each side for pivot

    for (let i = LOOKBACK; i < candles.length - LOOKBACK; i++) {
      const c = candles[i];

      // Swing High
      const isHigh = candles.slice(i - LOOKBACK, i).every(b => b.high <= c.high) &&
                     candles.slice(i + 1, i + LOOKBACK + 1).every(b => b.high <= c.high);
      if (isHigh) {
        const touches = this.countTouches(candles, c.high, atr * 0.5);
        levels.push({
          price: c.high, type: 'RESISTANCE',
          strength: Math.min(5, Math.round(touches * weight)),
          source: 'SWING', timeframe: tf, lastTested: i,
        });
      }

      // Swing Low
      const isLow = candles.slice(i - LOOKBACK, i).every(b => b.low >= c.low) &&
                    candles.slice(i + 1, i + LOOKBACK + 1).every(b => b.low >= c.low);
      if (isLow) {
        const touches = this.countTouches(candles, c.low, atr * 0.5);
        levels.push({
          price: c.low, type: 'SUPPORT',
          strength: Math.min(5, Math.round(touches * weight)),
          source: 'SWING', timeframe: tf, lastTested: i,
        });
      }
    }

    return levels;
  }

  private findRoundNumbers(candles: Candle[], atr: number): SRLevel[] {
    const levels: SRLevel[] = [];
    const price = candles[candles.length - 1].close;

    // Find nearest round numbers (100, 50, 20, 10 pip multiples depending on price)
    const intervals = price > 100
      ? [100, 50, 25]      // Indices, Gold
      : price > 10
      ? [1, 0.5, 0.25]     // USDJPY, etc.
      : [0.01, 0.005];     // Forex

    for (const interval of intervals) {
      const base   = Math.round(price / interval) * interval;
      const nearby = [base - interval, base, base + interval];

      for (const level of nearby) {
        if (Math.abs(level - price) < atr * 3) {
          const type: SRLevel['type'] = level > price ? 'RESISTANCE' : 'SUPPORT';
          levels.push({
            price: +level.toFixed(5), type,
            strength: 2, // round numbers are moderate strength
            source: 'ROUND', timeframe: 'ANY', lastTested: candles.length - 1,
          });
        }
      }
    }

    return levels;
  }

  private findPrevDayLevels(candles: Candle[]): SRLevel[] {
    if (candles.length < 24) return [];

    // Previous day's high, low (approximate: last 24 H1 bars)
    const prevDay = candles.slice(-48, -24);
    if (!prevDay.length) return [];

    const pdHigh = Math.max(...prevDay.map(c => c.high));
    const pdLow  = Math.min(...prevDay.map(c => c.low));
    const price  = candles[candles.length - 1].close;

    const levels: SRLevel[] = [
      { price: pdHigh, type: 'RESISTANCE', strength: 3, source: 'PREV_DAY', timeframe: 'D1', lastTested: candles.length - 25 },
      { price: pdLow,  type: 'SUPPORT',    strength: 3, source: 'PREV_DAY', timeframe: 'D1', lastTested: candles.length - 25 },
    ];
    return levels.filter(l => Math.abs(l.price - price) / price < 0.03); // within 3%
  }

  private countTouches(candles: Candle[], level: number, tolerance: number): number {
    let touches = 0;
    for (const c of candles) {
      if (Math.abs(c.high - level) <= tolerance || Math.abs(c.low - level) <= tolerance) {
        touches++;
      }
    }
    return touches;
  }

  private mergeLevels(levels: SRLevel[], tolerance: number): SRLevel[] {
    const merged: SRLevel[] = [];

    for (const lvl of levels) {
      const existing = merged.find(m =>
        m.type === lvl.type && Math.abs(m.price - lvl.price) <= tolerance
      );
      if (existing) {
        existing.strength = Math.min(5, existing.strength + lvl.strength);
        existing.price    = (existing.price + lvl.price) / 2; // average
      } else {
        merged.push({ ...lvl });
      }
    }

    return merged.filter(l => l.strength >= 2); // only meaningful levels
  }
}
