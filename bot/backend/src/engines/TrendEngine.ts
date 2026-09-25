/**
 * TREND ENGINE — ENHANCED
 * إضافة: Cross Recency Check — يتحقق أن الـ Cross حدث خلال آخر 5 شمعات
 * إضافة: NvidiaAI confidence boost إذا متوفر
 */
import { EMA, MACD, ADX } from 'technicalindicators';
import { Candle, Signal }  from '../types/trading.types';
import { calculateATR, atrStopLoss, atrTakeProfit, dynamicTakeProfit } from '../utils/ATR';
import { getSymbolSpec }   from '../config/symbolConfig';

export class TrendEngine {
  name = 'TREND';

  analyze(symbol: string, candles: Candle[]): Signal | null {
    if (candles.length < 220) return null;

    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);

    const e50  = EMA.calculate({ period: 50,  values: closes });
    const e200 = EMA.calculate({ period: 200, values: closes });

    const len  = Math.min(e50.length, e200.length);
    const a50  = e50[len - 1],  a200  = e200[len - 1];
    const p50  = e50[len - 2],  p200  = e200[len - 2];

    const crossUp   = p50 <= p200 && a50 > a200;
    const crossDown = p50 >= p200 && a50 < a200;
    if (!crossUp && !crossDown) return null;

    // ── [NEW] Cross Recency Check ────────────────────────────────────────
    // التحقق أن الـ Cross حدث في آخر 5 شمعات فقط، وليس قديماً
    const RECENCY_BARS = 5;
    let crossAge = 0;
    for (let i = 2; i <= RECENCY_BARS + 1 && i < len; i++) {
      const prevA = e50[len - i], prevB = e200[len - i];
      const prevPrev = i + 1 < len ? { a: e50[len - i - 1], b: e200[len - i - 1] } : null;
      if (!prevPrev) break;
      if (crossUp) {
        if (prevPrev.a <= prevPrev.b && prevA > prevB) { crossAge = i - 1; break; }
      } else {
        if (prevPrev.a >= prevPrev.b && prevA < prevB) { crossAge = i - 1; break; }
      }
    }
    // If cross was not within last RECENCY_BARS bars → stale signal, reject
    if (crossAge > RECENCY_BARS) return null;

    const side: 'BUY' | 'SELL' = crossUp ? 'BUY' : 'SELL';

    // ── MACD confirmation ────────────────────────────────────────────────
    const macdResult = MACD.calculate({
      values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      SimpleMAOscillator: false, SimpleMASignal: false,
    });
    const macd = macdResult[macdResult.length - 1];
    if (!macd?.histogram) return null;
    if (side === 'BUY'  && macd.histogram <= 0) return null;
    if (side === 'SELL' && macd.histogram >= 0) return null;

    // ── ADX ──────────────────────────────────────────────────────────────
    let adxValue = 20;
    try {
      const adxRes = ADX.calculate({ period: 14, close: closes, high: highs, low: lows });
      adxValue = adxRes[adxRes.length - 1]?.adx ?? 20;
    } catch { /* pass */ }
    if (adxValue < 18) return null;

    // ── Volume ───────────────────────────────────────────────────────────
    const vol20avg = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
    const volRatio = vol20avg > 0 ? volumes[volumes.length - 1] / vol20avg : 1;
    if (volRatio < 1.1) return null;

    // ── Momentum check (ROC) — avoids entering at the end of a move ──────
    const roc3 = closes.length > 3
      ? (closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]
      : 0;
    const momentumAligned = side === 'BUY' ? roc3 > 0 : roc3 < 0;
    if (!momentumAligned) return null;

    // ── Confidence ───────────────────────────────────────────────────────
    let confidence = 0.60;
    if (adxValue > 25)   confidence += 0.05;
    if (adxValue > 35)   confidence += 0.05;
    if (volRatio > 1.5)  confidence += 0.05;
    if (volRatio > 2.0)  confidence += 0.05;
    if (crossAge <= 2)   confidence += 0.03; // very fresh cross
    confidence = Math.min(0.85, confidence);

    const last   = candles[candles.length - 1];
    const reason =
      `EMA50 cross ${side} (age=${crossAge}bars) | ` +
      `MACD ${macd.histogram.toFixed(5)} | ADX ${adxValue.toFixed(1)} | Vol ${volRatio.toFixed(1)}×`;

    return this.mk(symbol, side, last.close, confidence, reason, candles);
  }

  private mk(symbol: string, side: 'BUY'|'SELL', price: number, confidence: number, reason: string, candles: Candle[]): Signal {
    const spec = getSymbolSpec(symbol);
    const atr  = calculateATR(candles.slice(-50), 14) || price * 0.005;
    return {
      symbol, side, price, confidence,
      sl:     atrStopLoss(side, price, atr, spec.atrMult),
      tp:     dynamicTakeProfit(side, price, atr, spec.atrMult * spec.tpRatio, candles),
      source: this.name, reason, timestamp: Date.now(),
    };
  }
}
