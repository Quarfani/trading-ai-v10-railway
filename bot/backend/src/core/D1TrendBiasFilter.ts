/**
 * D1 TREND BIAS FILTER — v9.0
 * ══════════════════════════════════════════════════════════════════════════
 * يفحص الاتجاه الأسبوعي على D1 قبل قبول أي إشارة على H1/H4.
 *
 * المنطق:
 *   إذا D1 EMA50 > EMA200 (صاعد) → يقبل BUY، يرفض SELL
 *   إذا D1 EMA50 < EMA200 (هابط) → يقبل SELL، يرفض BUY
 *   إذا D1 غير واضح → يقبل كلاهما بـ confidence أقل
 *
 * استثناء: إذا كانت الاستراتيجية RSI/StochRSI/VWAP (mean reversion)
 *          يُسمح بالاتجاه المعاكس بـ confidence منخفض (countert-trend only)
 *
 * [IMPORTANT] يُقلل الخسائر بشكل ملموس لأن معظم الصفقات الخاسرة
 *             هي ضد الاتجاه الرئيسي
 * ══════════════════════════════════════════════════════════════════════════
 */
import { EMA, ADX } from 'technicalindicators';
import { Candle, Side } from '../types/trading.types';
import { Logger }       from '../utils/Logger';

export type D1Trend = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface D1BiasResult {
  trend:       D1Trend;
  strength:    'STRONG' | 'MODERATE' | 'WEAK' | 'NEUTRAL';
  allows:      boolean;     // does D1 trend allow this signal?
  confidMult:  number;      // multiply signal confidence by this
  reason:      string;
  ema50:       number;
  ema200:      number;
  adx:         number;
}

// Mean-reversion strategies that may trade against D1 trend (at reduced size)
const MEAN_REVERSION = ['RSI', 'STOCH_RSI', 'VWAP', 'MACD_DIV'];

export class D1TrendBiasFilter {
  private logger = new Logger('D1Bias');
  private cache  = new Map<string, { result: D1BiasResult; updatedAt: number }>();

  evaluate(
    symbol:  string,
    side:    Side,
    source:  string,
    d1Candles: Candle[],
  ): D1BiasResult {
    if (d1Candles.length < 210) {
      return this.neutral('Insufficient D1 data');
    }

    // Cache per symbol (D1 changes slowly)
    const latest = d1Candles[d1Candles.length - 1];
    const cacheKey = `${symbol}:${d1Candles.length}:${latest?.time ?? 0}:${latest?.close ?? 0}`;
    const cached   = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.updatedAt < 4 * 3_600_000) {
      return this.applyToSignal(cached.result, side, source);
    }

    const closes = d1Candles.map(c => c.close);
    const highs  = d1Candles.map(c => c.high);
    const lows   = d1Candles.map(c => c.low);

    const e50  = EMA.calculate({ period: 50,  values: closes });
    const e200 = EMA.calculate({ period: 200, values: closes });

    if (!e50.length || !e200.length) return this.neutral('EMA calc failed');

    const ema50  = e50[e50.length - 1];
    const ema200 = e200[e200.length - 1];
    const spread = Math.abs(ema50 - ema200) / ema200; // relative distance

    let adx = 20;
    try {
      const adxR = ADX.calculate({ period: 14, close: closes, high: highs, low: lows });
      adx = adxR[adxR.length - 1]?.adx ?? 20;
    } catch {}

    const trend: D1Trend = ema50 > ema200 ? 'BULLISH' : ema50 < ema200 ? 'BEARISH' : 'NEUTRAL';
    const strength: D1BiasResult['strength'] =
      (adx > 30 && spread > 0.005) ? 'STRONG' :
      (adx > 20 && spread > 0.002) ? 'MODERATE' : 'WEAK';

    const base: D1BiasResult = {
      trend, strength, allows: true, confidMult: 1.0,
      reason: `D1: EMA50=${ema50.toFixed(4)} ${trend} EMA200=${ema200.toFixed(4)} ADX=${adx.toFixed(1)}`,
      ema50, ema200, adx,
    };

    this.cache.set(cacheKey, { result: base, updatedAt: Date.now() });
    return this.applyToSignal(base, side, source);
  }

  private applyToSignal(base: D1BiasResult, side: Side, source: string): D1BiasResult {
    const isMeanReversion = MEAN_REVERSION.some(s => source.toUpperCase().includes(s));
    const aligned         =
      (base.trend === 'BULLISH' && side === 'BUY')  ||
      (base.trend === 'BEARISH' && side === 'SELL') ||
       base.trend === 'NEUTRAL';

    if (aligned) {
      // With trend → full or bonus confidence
      const mult = base.strength === 'STRONG' ? 1.08 : base.strength === 'MODERATE' ? 1.04 : 1.0;
      return {
        ...base,
        allows:     true,
        confidMult: mult,
        reason:     `✓ Aligned with D1 ${base.trend} trend ${base.reason.slice(3)}`,
      };
    }

    // Against D1 trend
    if (isMeanReversion) {
      // Mean reversion strategies may trade counter-trend at reduced confidence
      const mult = base.strength === 'STRONG' ? 0.75 : base.strength === 'MODERATE' ? 0.85 : 0.92;
      return {
        ...base,
        allows:     true,
        confidMult: mult,
        reason:     `⚠ Counter-trend (${source} mean-reversion allowed) ${base.reason.slice(3)}`,
      };
    }

    // Trend-following strategy against D1 → block if strong, reduce if weak
    if (base.strength === 'STRONG') {
      return {
        ...base,
        allows:     false,
        confidMult: 0,
        reason:     `✗ BLOCKED: ${side} against strong D1 ${base.trend} trend`,
      };
    }

    return {
      ...base,
      allows:     true,
      confidMult: 0.70,
      reason:     `⚠ Weak counter-trend — confidence reduced 30%`,
    };
  }

  private neutral(reason: string): D1BiasResult {
    return {
      trend: 'NEUTRAL', strength: 'NEUTRAL', allows: true,
      confidMult: 1.0, reason, ema50: 0, ema200: 0, adx: 0,
    };
  }

  invalidate(symbol: string): void {
    this.cache.delete(symbol);
  }
}
