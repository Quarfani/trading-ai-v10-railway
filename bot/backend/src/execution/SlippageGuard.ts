import { Trade, Signal } from '../types/trading.types';

/**
 * Detects abnormal fill price deviation. If fill is > MAX_SLIPPAGE_PCT away
 * from intended signal price, the trade should be force-closed immediately.
 */
export class SlippageGuard {
  constructor(private maxPct = 0.005) {} // 0.5% default

  check(
    signal: Signal,
    trade: Trade,
    maxPctOverride?: number,
  ): { ok: boolean; slippagePct: number } {
    if (
      !(signal.price > 0) ||
      !Number.isFinite(signal.price) ||
      !(trade.entry > 0) ||
      !Number.isFinite(trade.entry)
    ) {
      return { ok: false, slippagePct: Number.POSITIVE_INFINITY };
    }
    const limit = maxPctOverride ?? this.maxPct;
    if (!(limit >= 0) || !Number.isFinite(limit)) {
      return { ok: false, slippagePct: Number.POSITIVE_INFINITY };
    }
    const dev = Math.abs(trade.entry - signal.price) / signal.price;
    return { ok: dev <= limit, slippagePct: dev };
  }
}
