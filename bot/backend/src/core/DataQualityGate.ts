import { Candle, Timeframe } from '../types/trading.types';

const TF_MS: Record<Timeframe, number> = {
  M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000,
  H1: 3_600_000, H4: 14_400_000, D1: 86_400_000,
};

export interface DataQualityResult { ok: boolean; reasons: string[]; }

/** Fail-closed market-data gate placed before strategy evaluation. */
export class DataQualityGate {
  validate(candles: Candle[], tf: Timeframe): DataQualityResult {
    const reasons: string[] = [];
    if (candles.length < 20) return { ok: false, reasons: ['insufficient_candles'] };
    const step = TF_MS[tf];
    let previous = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (![c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)) reasons.push(`non_finite_${i}`);
      if (!(c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 && c.high >= Math.max(c.open,c.close,c.low) && c.low <= Math.min(c.open,c.close,c.high))) reasons.push(`invalid_ohlc_${i}`);
      if (!(c.volume >= 0)) reasons.push(`invalid_volume_${i}`);
      if (c.is_imputed || c.is_synthetic || c.quality === 'imputed' || c.quality === 'synthetic' || c.quality === 'invalid') reasons.push(`unacceptable_quality_${i}`);
      if (c.sequence_valid === false) reasons.push(`invalid_sequence_${i}`);
      if (i > 0 && c.time <= previous) reasons.push(`non_monotonic_${i}`);
      previous = c.time;
    }
    const last = candles[candles.length - 1];
    if (last.time > Date.now() + 5_000) reasons.push('future_timestamp');
    const age = Date.now() - last.time;
    if (age > step * 3) reasons.push(`stale_${Math.round(age / 1000)}s`);
    for (let i = Math.max(1, candles.length - 50); i < candles.length; i++) {
      const delta = candles[i].time - candles[i-1].time;
      if (delta > step * 2) reasons.push(`recent_gap_${i}`);
    }
    return { ok: reasons.length === 0, reasons };
  }
}
