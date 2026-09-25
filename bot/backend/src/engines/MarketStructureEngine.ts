/**
 * MARKET STRUCTURE ENGINE
 * يكتشف Higher Highs / Higher Lows (اتجاه صاعد)
 * و Lower Highs / Lower Lows (اتجاه هابط)
 * للدخول مبكراً قبل EMA cross
 */
import { Candle, Signal } from '../types/trading.types';
import { calculateATR, dynamicTakeProfit } from '../utils/ATR';
import { getSymbolSpec } from '../config/symbolConfig';

interface SwingPoint { price: number; index: number; type: 'high' | 'low' }

export class MarketStructureEngine {
  name = 'STRUCTURE';

  analyze(symbol: string, candles: Candle[]): Signal | null {
    if (candles.length < 60) return null;

    const slice = candles.slice(-60);
    const swingHighs = this.findSwings(slice, 'high');
    const swingLows  = this.findSwings(slice, 'low');

    if (swingHighs.length < 3 || swingLows.length < 3) return null;

    const last = candles[candles.length - 1];
    const atr  = calculateATR(candles.slice(-50), 14) || last.close * 0.005;

    // ── Bullish structure: HH + HL ────────────────────────────────────────
    const recentHighs = swingHighs.slice(-3);
    const recentLows  = swingLows.slice(-3);

    const isHH = recentHighs[2].price > recentHighs[1].price &&
                 recentHighs[1].price > recentHighs[0].price;
    const isHL = recentLows[2].price  > recentLows[1].price  &&
                 recentLows[1].price  > recentLows[0].price;

    // ── Bearish structure: LH + LL ────────────────────────────────────────
    const isLH = recentHighs[2].price < recentHighs[1].price &&
                 recentHighs[1].price < recentHighs[0].price;
    const isLL = recentLows[2].price  < recentLows[1].price  &&
                 recentLows[1].price  < recentLows[0].price;

    if (!isHH && !isHL && !isLH && !isLL) return null;

    // Needs BOTH HH+HL for bullish or LH+LL for bearish
    const bullish = isHH && isHL;
    const bearish = isLH && isLL;
    if (!bullish && !bearish) return null;

    const side: 'BUY' | 'SELL' = bullish ? 'BUY' : 'SELL';

    // ── Entry must be near a HL (bullish) or LH (bearish) ─────────────────
    const lastLow  = recentLows[recentLows.length - 1];
    const lastHigh = recentHighs[recentHighs.length - 1];

    if (bullish) {
      // Price should be near or just above last HL — pullback entry
      const nearHL = Math.abs(last.close - lastLow.price) < atr * 2;
      if (!nearHL) return null;
    } else {
      // Price should be near or just below last LH
      const nearLH = Math.abs(last.close - lastHigh.price) < atr * 2;
      if (!nearLH) return null;
    }

    // ── Structure Break confirmation ──────────────────────────────────────
    // Price should be breaking the previous swing high (for BUY) to confirm
    const prevSwingHigh = recentHighs[recentHighs.length - 2];
    const prevSwingLow  = recentLows[recentLows.length - 2];

    const structureBreak =
      bullish ? last.close > prevSwingHigh.price :
                last.close < prevSwingLow.price;

    let confidence = bullish ? 0.62 : 0.62;
    if (structureBreak) confidence += 0.10;
    confidence = Math.min(0.85, confidence);

    const reason = `${side === 'BUY' ? 'HH+HL' : 'LH+LL'} structure` +
                   (structureBreak ? ' + structure break' : '');

    // Structure-based SL: behind the last swing low (bull) or high (bear)
    const structSL = side === 'BUY'
      ? lastLow.price  - atr * 0.5
      : lastHigh.price + atr * 0.5;

    const spec = getSymbolSpec(symbol);
    return {
      symbol, side,
      price:      last.close,
      confidence,
      sl:         structSL,
      tp:         dynamicTakeProfit(side, last.close, atr, spec.atrMult * spec.tpRatio, candles),
      source:     this.name,
      reason,
      timestamp:  Date.now(),
    };
  }

  private findSwings(candles: Candle[], type: 'high' | 'low'): SwingPoint[] {
    const points: SwingPoint[] = [];
    const n = candles.length;
    for (let i = 2; i < n - 2; i++) {
      if (type === 'high') {
        if (candles[i].high > candles[i-1].high &&
            candles[i].high > candles[i-2].high &&
            candles[i].high > candles[i+1].high &&
            candles[i].high > candles[i+2].high) {
          points.push({ price: candles[i].high, index: i, type: 'high' });
        }
      } else {
        if (candles[i].low < candles[i-1].low &&
            candles[i].low < candles[i-2].low &&
            candles[i].low < candles[i+1].low &&
            candles[i].low < candles[i+2].low) {
          points.push({ price: candles[i].low, index: i, type: 'low' });
        }
      }
    }
    return points;
  }
}
