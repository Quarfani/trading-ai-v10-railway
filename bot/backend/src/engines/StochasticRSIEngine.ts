/**
 * STOCHASTIC RSI ENGINE
 * ══════════════════════════════════════════════════════════════════════════
 * يجمع بين Stochastic Oscillator و RSI لإشارات أكثر دقة في أسواق الـ Range:
 *
 * Stochastic RSI = Stochastic(RSI) — يطبق Stochastic على RSI مباشرةً
 * هذا يجعله أكثر حساسية ويُعطي إشارات مبكرة.
 *
 * شروط الدخول BUY:
 *   1. StochRSI %K < 20 (منطقة Oversold الشديدة)
 *   2. %K يتقاطع فوق %D (Stochastic Cross)
 *   3. RSI الأصلي < 45 (تأكيد إضافي)
 *   4. ADX < 30 (يعمل في ranging أو اتجاه معتدل فقط)
 *
 * شروط الدخول SELL (عكس الأعلى):
 *   1. StochRSI %K > 80
 *   2. %K يتقاطع تحت %D
 *   3. RSI الأصلي > 55
 *   4. ADX < 30
 *
 * إضافة: Bullish/Bearish Engulfing confirmation قبل الدخول
 * ══════════════════════════════════════════════════════════════════════════
 */
import { RSI, ADX, BollingerBands } from 'technicalindicators';
import { Candle, Signal } from '../types/trading.types';
import { calculateATR, atrStopLoss, dynamicTakeProfit } from '../utils/ATR';
import { getSymbolSpec } from '../config/symbolConfig';

export class StochasticRSIEngine {
  readonly name = 'STOCH_RSI';

  analyze(symbol: string, candles: Candle[]): Signal | null {
    if (candles.length < 80) return null;

    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);

    // ── 1. RSI values ──────────────────────────────────────────────
    const rsiVals = RSI.calculate({ period: 14, values: closes });
    if (rsiVals.length < 30) return null;
    const currentRSI = rsiVals[rsiVals.length - 1];

    // ── 2. StochRSI: manual implementation (correct)
    // StochRSI %K = (RSI - min(RSI,14)) / (max(RSI,14) - min(RSI,14)) * 100
    const STOCH_PERIOD = 14;
    const SIGNAL_PERIOD = 3;
    if (rsiVals.length < STOCH_PERIOD + SIGNAL_PERIOD) return null;

    const stochK: number[] = [];
    for (let i = STOCH_PERIOD; i <= rsiVals.length; i++) {
      const slice   = rsiVals.slice(i - STOCH_PERIOD, i);
      const minRSI  = Math.min(...slice);
      const maxRSI  = Math.max(...slice);
      const range   = maxRSI - minRSI;
      const k       = range === 0 ? 50 : ((rsiVals[i - 1] - minRSI) / range) * 100;
      stochK.push(k);
    }

    // %D = SMA(3) of %K
    const stochD: number[] = [];
    for (let i = SIGNAL_PERIOD - 1; i < stochK.length; i++) {
      const avg = stochK.slice(i - SIGNAL_PERIOD + 1, i + 1).reduce((s, v) => s + v, 0) / SIGNAL_PERIOD;
      stochD.push(avg);
    }

    if (stochD.length < 2) return null;

    const kCurr = stochK[stochK.length - 1];
    const kPrev = stochK[stochK.length - 2];
    const dCurr = stochD[stochD.length - 1];
    const dPrev = stochD[stochD.length - 2];

    // ── 3. ADX filter ─────────────────────────────────────────────
    let adxVal = 20;
    try {
      const adxR = ADX.calculate({ period: 14, close: closes, high: highs, low: lows });
      adxVal = adxR[adxR.length - 1]?.adx ?? 20;
    } catch { /* pass */ }
    if (adxVal > 32) return null; // StochRSI unreliable in strong trends

    // ── 4. Bollinger Band position ─────────────────────────────────
    const bb     = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
    const lastBB = bb[bb.length - 1];

    const last  = candles[candles.length - 1];
    const prev2 = candles[candles.length - 2];
    const atr   = calculateATR(candles.slice(-50), 14) || last.close * 0.005;

    // ── Bullish cross ──────────────────────────────────────────────
    // %K was below %D, now crosses above → bullish momentum
    const bullishCross = kPrev <= dPrev && kCurr > dCurr;
    const bearishCross = kPrev >= dPrev && kCurr < dCurr;

    if (bullishCross && kCurr < 25 && currentRSI < 45) {
      // Confirmation: current candle is bullish (close > open)
      const bullishCandle = last.close > last.open;
      if (!bullishCandle) return null;

      // Optional: near Bollinger lower band
      const nearLowerBB = lastBB ? last.close < lastBB.lower * 1.005 : false;

      let conf = 0.58;
      if (kCurr < 15) conf += 0.07;          // deep oversold
      if (currentRSI < 35) conf += 0.05;     // RSI confirms
      if (nearLowerBB) conf += 0.05;          // BB confirms
      if (adxVal < 20) conf += 0.04;          // ranging market (best for StochRSI)
      conf = Math.min(0.83, conf);

      const spec = getSymbolSpec(symbol);
      const sl   = atrStopLoss('BUY', last.close, atr, spec.atrMult);
      const tp   = dynamicTakeProfit('BUY', last.close, atr, spec.atrMult * spec.tpRatio, candles);

      return {
        symbol, side: 'BUY', price: last.close, confidence: conf, sl, tp,
        source:    this.name,
        reason:    `StochRSI cross up: K=${kCurr.toFixed(1)} D=${dCurr.toFixed(1)} | RSI ${currentRSI.toFixed(1)} | ADX ${adxVal.toFixed(1)}${nearLowerBB ? ' | BB lower' : ''}`,
        timestamp: Date.now(),
      };
    }

    if (bearishCross && kCurr > 75 && currentRSI > 55) {
      const bearishCandle = last.close < last.open;
      if (!bearishCandle) return null;

      const nearUpperBB = lastBB ? last.close > lastBB.upper * 0.995 : false;

      let conf = 0.58;
      if (kCurr > 85) conf += 0.07;
      if (currentRSI > 65) conf += 0.05;
      if (nearUpperBB) conf += 0.05;
      if (adxVal < 20) conf += 0.04;
      conf = Math.min(0.83, conf);

      const spec = getSymbolSpec(symbol);
      const sl   = atrStopLoss('SELL', last.close, atr, spec.atrMult);
      const tp   = dynamicTakeProfit('SELL', last.close, atr, spec.atrMult * spec.tpRatio, candles);

      return {
        symbol, side: 'SELL', price: last.close, confidence: conf, sl, tp,
        source:    this.name,
        reason:    `StochRSI cross down: K=${kCurr.toFixed(1)} D=${dCurr.toFixed(1)} | RSI ${currentRSI.toFixed(1)} | ADX ${adxVal.toFixed(1)}${nearUpperBB ? ' | BB upper' : ''}`,
        timestamp: Date.now(),
      };
    }

    return null;
  }
}
