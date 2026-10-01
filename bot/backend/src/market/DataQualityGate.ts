/**
 * MARKET DATA QUALITY GATE
 *
 * Validates historical/live candles before they are allowed into research or
 * decision layers. It never repairs data; it only classifies and gates it.
 */
import { Candle, Timeframe } from '../types/trading.types';
import { TIMEFRAME_MS } from './market.types';

export interface DataQualityResult {
  passed: boolean;
  score: number;
  totalCandles: number;
  duplicateCount: number;
  outOfOrderCount: number;
  gapBars: number;
  invalidOhlcCount: number;
  syntheticCount: number;
  imputedCount: number;
  staleCount: number;
  futureTimestampCount: number;
  invalidSequenceCount: number;
  hardFailures: string[];
  warnings: string[];
}

export interface DataQualityOptions {
  maxGapBars?: number;
  maxMissingRatio?: number;
  allowSynthetic?: boolean;
  allowImputed?: boolean;
  maxLatencyMs?: number;
  allowScheduledSessionGaps?: boolean;
  scheduledGapMinMs?: number;
}

function validNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function evaluateMarketDataQuality(
  candles: Candle[],
  timeframe: Timeframe,
  options: DataQualityOptions = {},
): DataQualityResult {
  const total = candles.length;
  const interval = TIMEFRAME_MS[timeframe];

  const maxGapBars = Math.max(0, options.maxGapBars ?? 1);
  const maxMissingRatio = Math.max(
    0,
    Math.min(1, options.maxMissingRatio ?? 0.01),
  );
  const allowSynthetic = options.allowSynthetic ?? false;
  const allowImputed = options.allowImputed ?? false;
  const maxLatencyMs =
    options.maxLatencyMs == null
      ? Infinity
      : Math.max(0, options.maxLatencyMs);
  const allowScheduledSessionGaps = options.allowScheduledSessionGaps ?? false;
  const scheduledGapMinMs = Math.max(
    interval * 2,
    options.scheduledGapMinMs ?? 36 * 60 * 60_000,
  );

  const hardFailures: string[] = [];
  const warnings: string[] = [];

  let duplicateCount = 0;
  let outOfOrderCount = 0;
  let gapBars = 0;
  let invalidOhlcCount = 0;
  let syntheticCount = 0;
  let imputedCount = 0;
  let staleCount = 0;
  let futureTimestampCount = 0;
  let invalidSequenceCount = 0;

  let previousTime = -Infinity;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    if (candle.time < previousTime) {
      outOfOrderCount++;
    }
    if (candle.time === previousTime) {
      duplicateCount++;
    }

    if (Number.isFinite(previousTime) && candle.time > previousTime) {
      const delta = candle.time - previousTime;
      if (delta % interval !== 0) {
        warnings.push(
          `Irregular candle interval at index ${i}: delta=${delta}ms`,
        );
      }

      if (delta > interval) {
        const missing = Math.max(0, Math.floor(delta / interval) - 1);
        if (
          allowScheduledSessionGaps &&
          delta >= scheduledGapMinMs
        ) {
          warnings.push(
            `Scheduled/session gap ignored for completeness ratio: ${delta}ms`,
          );
        } else {
          gapBars += missing;
        }
      }
    }

    const validOhlc =
      validNumber(candle.open) &&
      validNumber(candle.high) &&
      validNumber(candle.low) &&
      validNumber(candle.close) &&
      candle.open > 0 &&
      candle.high > 0 &&
      candle.low > 0 &&
      candle.close > 0 &&
      candle.high >= Math.max(candle.open, candle.close) &&
      candle.low <= Math.min(candle.open, candle.close);

    if (!validOhlc) invalidOhlcCount++;

    if (
      candle.quality === 'synthetic' ||
      candle.is_synthetic === true
    ) {
      syntheticCount++;
    }

    if (
      candle.quality === 'imputed' ||
      candle.is_imputed === true
    ) {
      imputedCount++;
    }

    if (candle.time > Date.now() + 5_000) {
      futureTimestampCount++;
    }

    if (candle.sequence_valid === false) {
      invalidSequenceCount++;
    }

    if (
      candle.latency != null &&
      Number.isFinite(candle.latency) &&
      candle.latency > maxLatencyMs
    ) {
      staleCount++;
    }

    previousTime = candle.time;
  }

  const missingRatio =
    total > 1
      ? gapBars / Math.max(1, total + gapBars)
      : 0;

  if (!total) hardFailures.push('No candles supplied');
  if (!interval) hardFailures.push('Unknown timeframe interval');
  if (duplicateCount > 0) {
    hardFailures.push(`Duplicate candle timestamps: ${duplicateCount}`);
  }
  if (outOfOrderCount > 0) {
    hardFailures.push(`Out-of-order candle timestamps: ${outOfOrderCount}`);
  }
  if (invalidOhlcCount > 0) {
    hardFailures.push(`Invalid OHLC candles: ${invalidOhlcCount}`);
  }
  if (futureTimestampCount > 0) {
    hardFailures.push(`Future candle timestamps: ${futureTimestampCount}`);
  }
  if (invalidSequenceCount > 0) {
    hardFailures.push(`Invalid candle sequence markers: ${invalidSequenceCount}`);
  }
  if (gapBars > maxGapBars && missingRatio > maxMissingRatio) {
    hardFailures.push(
      `Data gaps exceed threshold: ${gapBars} missing bars (${(missingRatio * 100).toFixed(2)}%)`,
    );
  }
  if (!allowSynthetic && syntheticCount > 0) {
    hardFailures.push(
      `Synthetic candles are not allowed: ${syntheticCount}`,
    );
  }
  if (!allowImputed && imputedCount > 0) {
    hardFailures.push(
      `Imputed candles are not allowed: ${imputedCount}`,
    );
  }

  if (gapBars > 0 && hardFailures.length === 0) {
    warnings.push(`Detected ${gapBars} missing bars`);
  }
  if (staleCount > 0 && hardFailures.length === 0) {
    warnings.push(`Detected ${staleCount} candles above latency threshold`);
  }

  const penalties =
    duplicateCount +
    outOfOrderCount +
    invalidOhlcCount * 2 +
    syntheticCount +
    imputedCount +
    staleCount +
    gapBars;

  const score =
    total > 0
      ? Math.max(0, Math.min(1, 1 - penalties / (total * 2)))
      : 0;

  return {
    passed: hardFailures.length === 0,
    score: Number(score.toFixed(6)),
    totalCandles: total,
    duplicateCount,
    outOfOrderCount,
    gapBars,
    invalidOhlcCount,
    syntheticCount,
    imputedCount,
    staleCount,
    futureTimestampCount,
    invalidSequenceCount,
    hardFailures,
    warnings,
  };
}
