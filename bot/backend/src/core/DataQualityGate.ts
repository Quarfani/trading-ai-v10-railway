/**
 * DATA QUALITY GATE — CORE ADAPTER
 *
 * Single source of truth lives in market/DataQualityGate.
 * This adapter preserves the legacy { ok, reasons } contract used by TradingEngine.
 */
import { Candle, Timeframe } from '../types/trading.types';
import { evaluateMarketDataQuality } from '../market/DataQualityGate';

export interface DataQualityResult {
  ok: boolean;
  reasons: string[];
  score?: number;
  warnings?: string[];
}

export class DataQualityGate {
  validate(candles: Candle[], tf: Timeframe): DataQualityResult {
    const result = evaluateMarketDataQuality(candles, tf, {
      maxGapBars: 1,
      maxMissingRatio: 0.01,
      allowScheduledSessionGaps: true,
      allowSynthetic: false,
      allowImputed: false,
      maxLatencyMs: (this.intervalMs(tf) * 3),
    });

    return {
      ok: result.passed,
      reasons: result.hardFailures,
      score: result.score,
      warnings: result.warnings,
    };
  }

  private intervalMs(tf: Timeframe): number {
    const map: Record<Timeframe, number> = {
      M1: 60_000,
      M5: 300_000,
      M15: 900_000,
      M30: 1_800_000,
      H1: 3_600_000,
      H4: 14_400_000,
      D1: 86_400_000,
    };
    return map[tf];
  }
}
