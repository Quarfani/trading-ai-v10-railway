/**
 * VWAP ENGINE — Volume-Weighted Average Price Mean Reversion
 * ══════════════════════════════════════════════════════════════════════════
 * يستخدم VWAP + Standard Deviation bands لدخولات Mean Reversion عالية الدقة.
 *
 * VWAP = Σ(Typical_Price × Volume) / Σ(Volume)
 *
 * الاستراتيجية:
 *   - السعر ينحرف بعيداً عن VWAP (± 2 SD) → فرصة الرجوع
 *   - يُدخل عند اقتراب السعر من VWAP مجدداً أو عند لمس Band
 *
 * شروط الدخول BUY:
 *   1. السعر تحت VWAP بمقدار > 1.5 SD
 *   2. ADX < 28 (ليس في اتجاه قوي جداً)
 *   3. حجم التداول > متوسط (مشاركة حقيقية)
 *   4. الشمعة الأخيرة صاعدة (انعكاس مبكر)
 *
 * يحسب VWAP على آخر 100 شمعة (نافذة متحركة):
 *   هذا يجعله مناسباً لجميع الأطر الزمنية
 * ══════════════════════════════════════════════════════════════════════════
 */
import { ADX } from 'technicalindicators';
import { Candle, Signal } from '../types/trading.types';
import { calculateATR, atrStopLoss, dynamicTakeProfit } from '../utils/ATR';
import { getSymbolSpec } from '../config/symbolConfig';

interface VWAPResult {
  vwap:   number;
  stdDev: number;
  upper1: number;
  lower1: number;
  upper2: number;
  lower2: number;
  upper3: number;
  lower3: number;
}

export class VWAPEngine {
  readonly name = 'VWAP';

  analyze(symbol: string, candles: Candle[]): Signal | null {
    if (candles.length < 60) return null;

    // Use last 100 candles for VWAP window
    const window = candles.slice(-100);
    const vwapData = this.calculateVWAP(window);
    if (!vwapData) return null;

    const last    = candles[candles.length - 1];
    const prev    = candles[candles.length - 2];
    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);

    const atr = calculateATR(candles.slice(-50), 14) || last.close * 0.005;

    // ── ADX filter ─────────────────────────────────────────────────
    let adxVal = 18;
    try {
      const adxR = ADX.calculate({ period: 14, close: closes, high: highs, low: lows });
      adxVal = adxR[adxR.length - 1]?.adx ?? 18;
    } catch { /* pass */ }
    if (adxVal > 30) return null;

    // ── Volume confirmation ────────────────────────────────────────
    const vol20avg = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
    const volRatio = vol20avg > 0 ? last.volume / vol20avg : 1;
    if (volRatio < 0.9) return null; // low volume — no conviction

    const price = last.close;
    const { vwap, stdDev, lower2, upper2, lower1, upper1 } = vwapData;

    // ── Price deviation from VWAP ─────────────────────────────────
    const deviationSD = stdDev > 0 ? (price - vwap) / stdDev : 0;

    // ── BUY: price below VWAP by 1.5+ SD, turning up ─────────────
    if (deviationSD < -1.5 && price < lower1) {
      const bullishBar = last.close > last.open;
      const recovering = last.close > prev.close; // price starting to recover
      if (!bullishBar && !recovering) return null;

      let conf = 0.57;
      if (deviationSD < -2.0) conf += 0.07; // strong deviation = stronger reversion
      if (volRatio > 1.5)     conf += 0.05;
      if (bullishBar)         conf += 0.04;
      if (adxVal < 20)        conf += 0.04;
      conf = Math.min(0.82, conf);

      const spec = getSymbolSpec(symbol);
      const sl   = atrStopLoss('BUY', price, atr, spec.atrMult);
      const tp   = Math.min(vwap + stdDev * 0.5, dynamicTakeProfit('BUY', price, atr, spec.atrMult * spec.tpRatio, candles));

      return {
        symbol, side: 'BUY', price, confidence: conf, sl, tp,
        source:    this.name,
        reason:    `VWAP reversion BUY: price ${deviationSD.toFixed(2)} SD below VWAP | vol ${volRatio.toFixed(1)}× | ADX ${adxVal.toFixed(1)}`,
        timestamp: Date.now(),
      };
    }

    // ── SELL: price above VWAP by 1.5+ SD, turning down ──────────
    if (deviationSD > 1.5 && price > upper1) {
      const bearishBar = last.close < last.open;
      const declining  = last.close < prev.close;
      if (!bearishBar && !declining) return null;

      let conf = 0.57;
      if (deviationSD > 2.0) conf += 0.07;
      if (volRatio > 1.5)    conf += 0.05;
      if (bearishBar)        conf += 0.04;
      if (adxVal < 20)       conf += 0.04;
      conf = Math.min(0.82, conf);

      const spec = getSymbolSpec(symbol);
      const sl   = atrStopLoss('SELL', price, atr, spec.atrMult);
      const tp   = Math.max(vwap - stdDev * 0.5, dynamicTakeProfit('SELL', price, atr, spec.atrMult * spec.tpRatio, candles));

      return {
        symbol, side: 'SELL', price, confidence: conf, sl, tp,
        source:    this.name,
        reason:    `VWAP reversion SELL: price ${deviationSD.toFixed(2)} SD above VWAP | vol ${volRatio.toFixed(1)}× | ADX ${adxVal.toFixed(1)}`,
        timestamp: Date.now(),
      };
    }

    return null;
  }

  private calculateVWAP(candles: Candle[]): VWAPResult | null {
    if (candles.length < 10) return null;

    let cumTPV = 0; // Typical Price × Volume
    let cumVol = 0;
    const typicals: number[] = [];

    for (const c of candles) {
      const tp = (c.high + c.low + c.close) / 3;
      cumTPV += tp * c.volume;
      cumVol += c.volume;
      typicals.push(tp);
    }

    if (cumVol === 0) return null;
    const vwap = cumTPV / cumVol;

    // Standard deviation of typical prices from VWAP
    const variance = typicals.reduce((sum, tp) => sum + Math.pow(tp - vwap, 2), 0) / typicals.length;
    const stdDev   = Math.sqrt(variance);

    if (stdDev === 0) return null;

    return {
      vwap,
      stdDev,
      upper1: vwap + stdDev,
      lower1: vwap - stdDev,
      upper2: vwap + stdDev * 2,
      lower2: vwap - stdDev * 2,
      upper3: vwap + stdDev * 3,
      lower3: vwap - stdDev * 3,
    };
  }
}
