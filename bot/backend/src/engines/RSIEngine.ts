/**
 * RSI ENGINE — ENHANCED
 * Divergence الحقيقية على 20-30 شمعة بدلاً من 5
 */
import { RSI, BollingerBands, ADX } from 'technicalindicators';
import { Candle, Signal } from '../types/trading.types';
import { calculateATR, atrStopLoss, dynamicTakeProfit } from '../utils/ATR';
import { getSymbolSpec } from '../config/symbolConfig';

export class RSIEngine {
  name = 'RSI';

  analyze(symbol: string, candles: Candle[]): Signal | null {
    if (candles.length < 60) return null;

    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);

    const rsiValues = RSI.calculate({ period: 14, values: closes });
    const rsi = rsiValues[rsiValues.length - 1];
    if (rsi === undefined) return null;

    const oversold   = rsi < 32;
    const overbought = rsi > 68;
    if (!oversold && !overbought) return null;

    // Bollinger Bands
    const bb     = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
    const lastBB = bb[bb.length - 1];
    if (!lastBB) return null;

    const last = candles[candles.length - 1];
    if (oversold   && last.close > lastBB.lower * 1.001) return null;
    if (overbought && last.close < lastBB.upper * 0.999) return null;

    // ADX — no RSI in strong trends
    try {
      const adxR = ADX.calculate({ period: 14, close: closes, high: highs, low: lows });
      if ((adxR[adxR.length - 1]?.adx ?? 0) > 30) return null;
    } catch { /* pass */ }

    // ── PROPER Divergence: lookback 20-30 bars ────────────────────────────
    const LOOK = 25;
    const side: 'BUY' | 'SELL' = oversold ? 'BUY' : 'SELL';
    let hasDivergence = false;

    if (rsiValues.length >= LOOK + 1) {
      const rsiSlice    = rsiValues.slice(-LOOK);
      const closeSlice  = closes.slice(-LOOK);
      const highSlice   = highs.slice(-LOOK);
      const lowSlice    = lows.slice(-LOOK);

      if (oversold) {
        // Bullish divergence: price makes lower low, RSI makes higher low
        const prevLowIdx  = lowSlice.slice(0, -5).indexOf(Math.min(...lowSlice.slice(0, -5)));
        const currLow     = last.low;
        const prevLow     = lowSlice[prevLowIdx] ?? currLow;
        const prevRsiLow  = rsiSlice[prevLowIdx] ?? rsi;

        hasDivergence = currLow < prevLow && rsi > prevRsiLow && Math.abs(rsi - prevRsiLow) > 3;
      } else {
        // Bearish divergence: price makes higher high, RSI makes lower high
        const prevHighIdx = highSlice.slice(0, -5).indexOf(Math.max(...highSlice.slice(0, -5)));
        const currHigh    = last.high;
        const prevHigh    = highSlice[prevHighIdx] ?? currHigh;
        const prevRsiHigh = rsiSlice[prevHighIdx] ?? rsi;

        hasDivergence = currHigh > prevHigh && rsi < prevRsiHigh && Math.abs(prevRsiHigh - rsi) > 3;
      }
    }

    // Confidence
    let confidence = 0.55;
    if (oversold   && rsi < 25) confidence += 0.07;
    if (overbought && rsi > 75) confidence += 0.07;
    if (hasDivergence)          confidence += 0.12; // higher weight for proper divergence
    const bbRange = lastBB.upper - lastBB.lower;
    if (bbRange > 0) {
      const pctB = (last.close - lastBB.lower) / bbRange;
      if (oversold && pctB < 0)   confidence += 0.05;
      if (overbought && pctB > 1) confidence += 0.05;
    }
    confidence = Math.min(0.87, confidence);

    const reason = `RSI ${rsi.toFixed(1)} ${oversold ? 'oversold' : 'overbought'}` +
                   (hasDivergence ? ' + TRUE divergence (25-bar)' : '') + ` | BB touch`;

    return this.mk(symbol, side, last.close, confidence, reason, candles);
  }

  private mk(symbol: string, side: 'BUY'|'SELL', price: number, confidence: number, reason: string, candles: Candle[]): Signal {
    const spec = getSymbolSpec(symbol);
    const atr  = calculateATR(candles.slice(-50), 14) || price * 0.005;
    return {
      symbol, side, price, confidence,
      sl: atrStopLoss(side, price, atr, spec.atrMult),
      tp: dynamicTakeProfit(side, price, atr, spec.atrMult * spec.tpRatio, candles),
      source: this.name, reason, timestamp: Date.now(),
    };
  }
}
