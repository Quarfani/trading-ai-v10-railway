/**
 * ADAPTIVE ATR MANAGER — v8.0
 * ══════════════════════════════════════════════════════════════════════════
 * يُعدّل atrMult و tpRatio ديناميكياً بناءً على:
 *   1. Volatility Regime الحالي (مقارنة ATR الحالي بمتوسطه)
 *   2. نتائج الصفقات الأخيرة (هل SL يُضرب كثيراً؟)
 *   3. Walk-Forward params إن وُجدت
 *
 * المنطق:
 *   ATR_current > ATR_avg × 1.5  → volatility عالية → رفع المضاعف
 *   ATR_current < ATR_avg × 0.7  → volatility منخفضة → تخفيض المضاعف
 *   SL hitRate > 60%              → SL قريب جداً → رفع المضاعف
 *   SL hitRate < 20%              → SL بعيد جداً → تخفيض المضاعف
 * ══════════════════════════════════════════════════════════════════════════
 */
import { Candle, Timeframe } from '../types/trading.types';
import { calculateATR }    from '../utils/ATR';
import { getBaseSymbolSpec } from '../config/symbolConfig';
import { DatabaseManager } from '../database/DatabaseManager';
import { Logger }          from '../utils/Logger';

export interface AdaptiveParams {
  atrMult:   number;
  tpRatio:   number;
  reason:    string;
  volRatio:  number;  // current ATR / avg ATR
  slHitRate: number;  // % of trades that hit SL
}

const MIN_ATR_MULT = 0.8;
const MAX_ATR_MULT = 3.5;
const MIN_TP_RATIO = 1.5;
const MAX_TP_RATIO = 5.0;

export class AdaptiveATRManager {
  private logger = new Logger('AdaptiveATR');
  private cache  = new Map<string, { params: AdaptiveParams; updatedAt: number }>();

  constructor(private db: DatabaseManager) {}

  getParams(symbol: string, candles: Candle[], timeframe: Timeframe = 'H1'): AdaptiveParams {
    const symbolKey = symbol.toUpperCase();
    const key = `${symbolKey}_${timeframe}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.updatedAt < 3_600_000) return cached.params; // 1h cache

    const params = this.compute(symbol, candles);
    const previous = this.cache.get(key)?.params ?? null;
    if (previous && (Math.abs(params.atrMult - previous.atrMult) > 0.8 || Math.abs(params.tpRatio - previous.tpRatio) > 1.0)) {
      this.logger.warn(`[${symbol}] Adaptive change exceeded bounded delta; retaining prior params`);
      return previous;
    }
    this.cache.set(key, { params, updatedAt: Date.now() });
    try {
      this.db.raw().prepare(
  `INSERT INTO system_events(event,severity,payload,timestamp)
   VALUES (?,?,?,?)`,
).run(
  'ADAPTIVE_PARAMS_UPDATED',
  'INFO',
  JSON.stringify({ symbol: symbolKey, timeframe, previous, next: params }),
  Date.now(),
);
    } catch (e) {
      this.logger.error(`Adaptive audit write failed: ${String(e)}`);
    }

    // Apply to environment so symbolConfig picks them up
    process.env[`SPEC_${key}_ATR_MULT`] = String(params.atrMult);
    process.env[`SPEC_${key}_TP_RATIO`] = String(params.tpRatio);

    this.logger.debug(
      `[${symbol}] Adaptive: atrMult=${params.atrMult} tpRatio=${params.tpRatio} ` +
      `volRatio=${params.volRatio.toFixed(2)} slHitRate=${(params.slHitRate * 100).toFixed(0)}%`
    );

    return params;
  }

  private compute(symbol: string, candles: Candle[]): AdaptiveParams {
    const spec = getBaseSymbolSpec(symbol);

    // ── 1. Volatility ratio ───────────────────────────────────────────
    const currentATR = calculateATR(candles.slice(-20), 14);
    const longATR    = calculateATR(candles.slice(-100), 14);
    const volRatio   = longATR > 0 ? currentATR / longATR : 1.0;

    // ── 2. SL hit rate from recent trades ────────────────────────────
    const slHitRate = this.calcSlHitRate(symbol);

    // ── 3. Start from base params ─────────────────────────────────────
    let atrMult = spec.atrMult;
    let tpRatio = spec.tpRatio;
    const reasons: string[] = [];

    // Adjust for volatility
    if (volRatio > 1.5) {
      const bump = Math.min(0.8, (volRatio - 1.5) * 0.5);
      atrMult += bump;
      tpRatio += bump * 0.5;
      reasons.push(`High vol (${volRatio.toFixed(2)}× avg) → +${bump.toFixed(2)} atrMult`);
    } else if (volRatio < 0.7) {
      const cut = Math.min(0.4, (0.7 - volRatio) * 0.4);
      atrMult -= cut;
      reasons.push(`Low vol (${volRatio.toFixed(2)}× avg) → -${cut.toFixed(2)} atrMult`);
    }

    // Adjust for SL performance
    if (slHitRate > 0.60 && slHitRate > 0) {
      atrMult += 0.3;
      reasons.push(`SL hit rate ${(slHitRate * 100).toFixed(0)}% → +0.3 atrMult`);
    } else if (slHitRate < 0.20 && slHitRate > 0) {
      atrMult  = Math.max(spec.atrMult * 0.85, atrMult - 0.2);
      tpRatio += 0.3; // push TP further since SL is rarely hit
      reasons.push(`Low SL hits ${(slHitRate * 100).toFixed(0)}% → tighter mult, wider TP`);
    }

    // Clamp
    atrMult = +Math.max(MIN_ATR_MULT, Math.min(MAX_ATR_MULT, atrMult)).toFixed(2);
    tpRatio = +Math.max(MIN_TP_RATIO, Math.min(MAX_TP_RATIO, tpRatio)).toFixed(2);

    return {
      atrMult, tpRatio, volRatio, slHitRate,
      reason: reasons.join(' | ') || 'Base params (stable)',
    };
  }

  private calcSlHitRate(symbol: string): number {
    try {
      const cutoff = Date.now() - 30 * 24 * 3_600_000;
      const r = this.db.raw().prepare(`
        SELECT
          COUNT(*) total,
          SUM(CASE WHEN exitReason='SL' THEN 1 ELSE 0 END) slHits
        FROM trades
        WHERE status='closed' AND symbol=? AND openedAt > ?
      `).get(symbol, cutoff) as { total: number; slHits: number } | undefined;

      if (!r || r.total < 10) return -1; // insufficient data
      return r.slHits / r.total;
    } catch { return -1; }
  }

  invalidate(symbol: string) {
    this.cache.delete(symbol.toUpperCase());
  }

  getSummary(): Record<string, AdaptiveParams> {
    const out: Record<string, AdaptiveParams> = {};
    for (const [k, v] of this.cache) out[k] = v.params;
    return out;
  }
}
