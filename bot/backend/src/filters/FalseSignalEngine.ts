/**
 * FALSE SIGNAL FILTER
 *
 * Detects common structural failure modes before execution. It is deliberately
 * deterministic and explainable; it does not replace strategy evidence.
 */
import { Candle, Side } from '../types/trading.types';

export type FalseSignalReason =
  | 'FAKE_BREAKOUT'
  | 'LATE_ENTRY'
  | 'WEAK_MOMENTUM'
  | 'EXHAUSTION'
  | 'ABNORMAL_SPREAD'
  | 'INSUFFICIENT_DATA';

export interface FalseSignalInput {
  candles: Candle[];
  side: Side;
  entryPrice: number;
  spreadPips?: number;
  maxSpreadPips?: number;
}

export interface FalseSignalResult {
  passed: boolean;
  reasons: FalseSignalReason[];
  details: string[];
}

function finite(v: number): boolean {
  return Number.isFinite(v);
}

function body(c: Candle): number {
  return Math.abs(c.close - c.open);
}

export function detectFalseSignal(
  input: FalseSignalInput,
): FalseSignalResult {
  const { candles, side, entryPrice } = input;
  const reasons: FalseSignalReason[] = [];
  const details: string[] = [];

  if (
    candles.length < 30 ||
    !finite(entryPrice) ||
    entryPrice <= 0
  ) {
    return {
      passed: false,
      reasons: ['INSUFFICIENT_DATA'],
      details: ['At least 30 valid candles are required'],
    };
  }

  const recent = candles.slice(-20);
  const last = recent.at(-1)!;
  const previous = recent.slice(0, -1);

  const range = Math.max(
    ...previous.map(c => c.high),
  ) - Math.min(
    ...previous.map(c => c.low),
  );

  if (!(range > 0)) {
    reasons.push('INSUFFICIENT_DATA');
    details.push('Historical range is invalid');
  }

  // Breakout quality: a candle that barely closes beyond the recent high/low
  // and immediately rejects is treated as suspicious.
  const priorHigh = Math.max(...previous.map(c => c.high));
  const priorLow = Math.min(...previous.map(c => c.low));
  const lastBody = body(last);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  if (side === 'BUY') {
    if (last.high > priorHigh && last.close < priorHigh && upperWick > lastBody * 1.5) {
      reasons.push('FAKE_BREAKOUT');
      details.push('Breakout above recent high was rejected by a large upper wick');
    }
  } else {
    if (last.low < priorLow && last.close > priorLow && lowerWick > lastBody * 1.5) {
      reasons.push('FAKE_BREAKOUT');
      details.push('Breakdown below recent low was rejected by a large lower wick');
    }
  }

  // Late entry: price has already traveled >70% of the recent range in the
  // proposed direction before the entry.
  const travel =
    side === 'BUY'
      ? entryPrice - priorLow
      : priorHigh - entryPrice;

  if (range > 0 && travel / range > 0.70) {
    reasons.push('LATE_ENTRY');
    details.push('Entry is already beyond 70% of the recent structural range');
  }

  // Weak momentum: median recent body is tiny relative to the average range.
  const ranges = recent.map(c => c.high - c.low).filter(v => finite(v) && v > 0);
  const avgRange =
    ranges.length
      ? ranges.reduce((sum, v) => sum + v, 0) / ranges.length
      : 0;
  const avgBody =
    recent.length
      ? recent.reduce((sum, c) => sum + body(c), 0) / recent.length
      : 0;

  if (avgRange <= 0 || avgBody / avgRange < 0.20) {
    reasons.push('WEAK_MOMENTUM');
    details.push('Recent candle bodies are small relative to total range');
  }

  // Exhaustion: unusually large final candle (>2.5x average range).
  if (avgRange > 0 && last.high - last.low > avgRange * 2.5) {
    reasons.push('EXHAUSTION');
    details.push('Final candle range is >2.5x recent average');
  }

  if (
    input.spreadPips != null &&
    input.maxSpreadPips != null &&
    finite(input.spreadPips) &&
    finite(input.maxSpreadPips) &&
    input.maxSpreadPips > 0 &&
    input.spreadPips > input.maxSpreadPips * 0.90
  ) {
    reasons.push('ABNORMAL_SPREAD');
    details.push('Spread is within 10% of the configured maximum');
  }

  return {
    passed: reasons.length === 0,
    reasons,
    details: reasons.length
      ? details
      : ['No false-signal pattern detected'],
  };
}
