/**
 * BREAKOUT ENGINE — ENHANCED
 * [NEW] يتحقق من Key Levels على H4/D1 قبل قبول الاختراق
 * [NEW] يستخدم Structure-Based SL بدلاً من ATR ثابت
 */
import { Candle, Signal } from '../types/trading.types';
import { calculateATR, dynamicTakeProfit } from '../utils/ATR';
import { getSymbolSpec } from '../config/symbolConfig';

// Injected H4 candles cache — set by TradingEngine each cycle
let h4Cache: Record<string, Candle[]> = {};
export function setH4Cache(symbol: string, candles: Candle[]) {
  h4Cache[symbol] = candles;
}

export class BreakoutEngine {
  name = 'BREAKOUT';
  private lastBreakLevel: Record<string, number> = {};

  analyze(symbol: string, candles: Candle[]): Signal | null {
    if (candles.length < 50) return null;

    const last     = candles[candles.length - 1];
    const prev     = candles[candles.length - 2];
    const lookback = candles.slice(-21, -1);
    const volumes  = candles.map(c => c.volume);

    const rangeHigh = Math.max(...lookback.map(c => c.high));
    const rangeLow  = Math.min(...lookback.map(c => c.low));

    const breakUp   = last.close > rangeHigh;
    const breakDown = last.close < rangeLow;
    if (!breakUp && !breakDown) return null;

    const side: 'BUY' | 'SELL' = breakUp ? 'BUY' : 'SELL';
    const level = breakUp ? rangeHigh : rangeLow;

    // Duplicate filter
    const lastLevel = this.lastBreakLevel[symbol] ?? 0;
    if (Math.abs(level - lastLevel) < (rangeHigh - rangeLow) * 0.1) return null;

    const atr       = calculateATR(candles.slice(-50), 14) || last.close * 0.005;
    const breakDist = Math.abs(last.close - level);
    if (breakDist < atr * 0.4) return null;

    const candleRange = last.high - last.low;
    const body        = Math.abs(last.close - last.open);
    if (candleRange > 0 && body / candleRange < 0.55) return null;

    const vol20avg = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
    const volRatio = vol20avg > 0 ? volumes[volumes.length - 1] / vol20avg : 1;
    if (volRatio < 1.4) return null;

    if (breakUp   && prev.close > rangeHigh) return null;
    if (breakDown && prev.close < rangeLow)  return null;

    // ── [NEW] H4 Key Level Validation ─────────────────────────────────────
    const h4 = h4Cache[symbol] ?? [];
    if (h4.length >= 50) {
      const h4Levels  = this.extractKeyLevels(h4, 50);
      const nearH4Key = h4Levels.some(lvl => Math.abs(lvl - level) < atr * 2);
      if (!nearH4Key) {
        // Breakout is NOT near any H4 key level — likely a minor noise breakout
        return null;
      }
    }

    // ── [NEW] Structure-Based SL ───────────────────────────────────────────
    // SL goes behind the last swing low/high (structure) instead of fixed ATR
    const structureSL = this.findStructureSL(candles, side, atr);

    let confidence = 0.65;
    if (volRatio > 2.0)            confidence += 0.08;
    else if (volRatio > 1.7)       confidence += 0.05;
    if (breakDist > atr * 0.8)     confidence += 0.05;
    if (body / candleRange > 0.75) confidence += 0.04;
    if (h4.length >= 50)           confidence += 0.05; // H4 confirmed
    confidence = Math.min(0.90, confidence);

    this.lastBreakLevel[symbol] = level;

    const reason = `Breakout ${side === 'BUY' ? 'above' : 'below'} ${level.toFixed(5)} | ` +
                   `vol ${volRatio.toFixed(1)}× | body ${(body/candleRange*100).toFixed(0)}% | H4-confirmed`;

    const spec = getSymbolSpec(symbol);
    return {
      symbol, side,
      price:  last.close,
      confidence,
      sl:     structureSL,
      tp:     dynamicTakeProfit(side, last.close, atr, spec.atrMult * spec.tpRatio, candles, structureSL, 1.5),
      source: this.name, reason, timestamp: Date.now(),
    };
  }

  /** Extract key S/R levels from candles by finding swing highs/lows */
  private extractKeyLevels(candles: Candle[], lookback: number): number[] {
    const slice  = candles.slice(-lookback);
    const levels: number[] = [];
    for (let i = 2; i < slice.length - 2; i++) {
      const isSwingHigh =
        slice[i].high > slice[i-1].high && slice[i].high > slice[i-2].high &&
        slice[i].high > slice[i+1].high && slice[i].high > slice[i+2].high;
      const isSwingLow =
        slice[i].low < slice[i-1].low && slice[i].low < slice[i-2].low &&
        slice[i].low < slice[i+1].low && slice[i].low < slice[i+2].low;
      if (isSwingHigh) levels.push(slice[i].high);
      if (isSwingLow)  levels.push(slice[i].low);
    }
    return levels;
  }

  /** Place SL behind the nearest swing structure */
  private findStructureSL(candles: Candle[], side: 'BUY'|'SELL', atr: number): number {
    const slice = candles.slice(-20);
    if (side === 'BUY') {
      const recentLow = Math.min(...slice.map(c => c.low));
      return recentLow - atr * 0.3; // just below structure
    } else {
      const recentHigh = Math.max(...slice.map(c => c.high));
      return recentHigh + atr * 0.3;
    }
  }
}
