/**
 * MARKET REGIME DETECTOR — v7.0
 * ══════════════════════════════════════════════════════════════════════════
 * تحسينات الإصدار 7:
 *
 * [FIX-1] Choppiness Index:
 *   يُضاف كمرشح إضافي لتحديد ما إذا كان السوق "مشوش" أم في اتجاه واضح.
 *   Choppiness = 100 × log10(ATR_sum / (High_max - Low_min)) / log10(n)
 *   > 61.8  → CHOPPY (عشوائي)
 *   < 38.2  → TRENDING بوضوح
 *
 * [FIX-2] Volatility expansion detection:
 *   إذا ATR الحالي > 2× ATR المتوسط (20 شمعة) → VOLATILE
 *   هذا يُمسك بـ Volatility Spikes بدقة أكبر من ATR% فقط.
 *
 * [FIX-3] حدود ADX أكثر دقة:
 *   TRENDING  → ADX > 23 (كان 25)
 *   RANGING   → ADX < 18 (كان 20)
 * ══════════════════════════════════════════════════════════════════════════
 */
import { EMA, ADX, BollingerBands, ATR as ATRIndicator } from 'technicalindicators';
import { Candle } from '../types/trading.types';
import { calculateATR } from '../utils/ATR';
import { Logger } from '../utils/Logger';

export type MarketRegime = 'TRENDING' | 'RANGING' | 'VOLATILE' | 'UNKNOWN';

export interface RegimeResult {
  regime:     MarketRegime;
  adx:        number;
  atrPct:     number;
  bbWidth:    number;
  choppiness: number;
  trend:      'UP' | 'DOWN' | 'NONE';
  confidence: number;
  updatedAt:  number;
}

const CACHE_TTL: Record<string, number> = {
  M1: 60_000, M5: 300_000, M15: 900_000,
  M30: 1_800_000, H1: 55_000, H4: 14_400_000, D1: 86_400_000,
};

export class MarketRegimeDetector {
  private logger = new Logger('RegimeDetector');
  private cache  = new Map<string, RegimeResult>();

  detect(symbol: string, tf: string, candles: Candle[]): RegimeResult {
    const key = `${symbol}_${tf}`;
    const ttl = CACHE_TTL[tf] ?? 900_000;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.updatedAt < ttl) return cached;

    const result = this.compute(candles, tf);
    this.cache.set(key, result);
    this.logger.debug(
      `[${symbol} ${tf}] Regime=${result.regime} ADX=${result.adx.toFixed(1)} ` +
      `ATR%=${(result.atrPct * 100).toFixed(2)} Chop=${result.choppiness.toFixed(1)}`
    );
    return result;
  }

  invalidate(symbol: string) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(symbol + '_')) this.cache.delete(key);
    }
  }

  private compute(candles: Candle[], tf: string): RegimeResult {
    const unknown: RegimeResult = {
      regime: 'UNKNOWN', adx: 0, atrPct: 0, bbWidth: 0,
      choppiness: 50, trend: 'NONE', confidence: 0, updatedAt: Date.now(),
    };
    if (candles.length < 50) return unknown;

    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const last   = closes[closes.length - 1];

    // ── 1. ADX ──────────────────────────────────────────────────────
    let adx = 20;
    try {
      const adxRes = ADX.calculate({ period: 14, close: closes, high: highs, low: lows });
      adx = adxRes[adxRes.length - 1]?.adx ?? 20;
    } catch { /* pass */ }

    // ── 2. ATR% ─────────────────────────────────────────────────────
    const atr    = calculateATR(candles.slice(-50), 14);
    const atrPct = last > 0 ? atr / last : 0;

    // [FIX-2] ATR expansion detection
    const atr20avg = this.avgATR(candles.slice(-30), 14, 20);
    const atrExpanded = atr20avg > 0 && atr > atr20avg * 2.0;

    // ── 3. Bollinger Band width ──────────────────────────────────────
    let bbWidth = 0;
    try {
      const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
      const lastBB = bb[bb.length - 1];
      if (lastBB && lastBB.middle > 0) {
        bbWidth = (lastBB.upper - lastBB.lower) / lastBB.middle;
      }
    } catch { /* pass */ }

    // ── 4. EMA trend ─────────────────────────────────────────────────
    let trend: 'UP' | 'DOWN' | 'NONE' = 'NONE';
    try {
      const e50  = EMA.calculate({ period: 50,  values: closes });
      const e200 = EMA.calculate({ period: 200, values: closes });
      if (e50.length > 0 && e200.length > 0) {
        trend = e50[e50.length - 1] > e200[e200.length - 1] ? 'UP' : 'DOWN';
      }
    } catch { /* pass */ }

    // ── 5. [FIX-1] Choppiness Index ──────────────────────────────────
    const choppiness = this.calcChoppiness(candles.slice(-14), 14);

    // ── 6. Regime classification ──────────────────────────────────────
    const volatileThreshold = this.volatileThreshold(tf);
    // [FIX-3] Refined ADX thresholds
    const trendingADX  = 23;
    const rangingADX   = 18;
    const tightBBWidth = 0.015;
    const CHOP_TRENDING = 38.2;
    const CHOP_RANGING  = 61.8;

    let regime: MarketRegime;
    let confidence = 0;

    // VOLATILE: ATR spike or expansion
    if (atrPct > volatileThreshold || atrExpanded) {
      regime     = 'VOLATILE';
      confidence = Math.min(1, atrPct / (volatileThreshold * 2));
    }
    // TRENDING: ADX strong + choppiness low
    else if (adx >= trendingADX && choppiness < CHOP_RANGING) {
      regime     = 'TRENDING';
      confidence = Math.min(1, (adx - trendingADX) / 20 + (CHOP_RANGING - choppiness) / 50);
      confidence = Math.min(1, confidence);
    }
    // RANGING: ADX weak + choppiness high + tight BB
    else if (adx < rangingADX || (bbWidth < tightBBWidth && choppiness > CHOP_TRENDING)) {
      regime     = 'RANGING';
      confidence = Math.min(1, (rangingADX - Math.min(adx, rangingADX)) / rangingADX +
                                (choppiness - CHOP_TRENDING) / 50 * 0.5);
      confidence = Math.min(1, confidence);
    }
    else {
      // Transitional zone
      regime     = adx > 21 ? 'TRENDING' : 'RANGING';
      confidence = 0.35;
    }

    return { regime, adx, atrPct, bbWidth, choppiness, trend, confidence, updatedAt: Date.now() };
  }

  /** Calculate Choppiness Index (14-period) */
  private calcChoppiness(candles: Candle[], period: number): number {
    if (candles.length < period) return 50;

    const slice  = candles.slice(-period);
    const highs  = slice.map(c => c.high);
    const lows   = slice.map(c => c.low);
    const closes = slice.map(c => c.close);

    // Sum of individual ATRs
    let atrSum = 0;
    for (let i = 1; i < slice.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i]  - closes[i - 1])
      );
      atrSum += tr;
    }

    const highestHigh = Math.max(...highs);
    const lowestLow   = Math.min(...lows);
    const range       = highestHigh - lowestLow;

    if (range === 0 || atrSum === 0) return 50;

    const chop = 100 * Math.log10(atrSum / range) / Math.log10(period);
    return Math.max(0, Math.min(100, chop));
  }

  /** Average ATR over last N periods */
  private avgATR(candles: Candle[], period: number, n: number): number {
    if (candles.length < period + n) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const slice = candles.slice(0, candles.length - i);
      sum += calculateATR(slice, period);
    }
    return sum / n;
  }

  private volatileThreshold(tf: string): number {
    const thresholds: Record<string, number> = {
      M1: 0.003, M5: 0.005, M15: 0.008, M30: 0.010,
      H1: 0.015, H4: 0.025, D1: 0.040,
    };
    return thresholds[tf] ?? 0.010;
  }

  static volumeMultiplier(regime: MarketRegime): number {
    const map: Record<MarketRegime, number> = {
      TRENDING: 1.0, RANGING: 0.8, VOLATILE: 0.5, UNKNOWN: 0.7,
    };
    return map[regime];
  }
}

export const marketRegimeDetector = new MarketRegimeDetector();
