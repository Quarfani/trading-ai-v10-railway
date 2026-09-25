import { Trade, Signal } from '../types/trading.types';

/**
 * Detects abnormal fill price deviation. If fill is > MAX_SLIPPAGE_PCT away
 * from intended signal price, the trade should be force-closed immediately.
 */
export class SlippageGuard {
  constructor(private maxPct = 0.005) {} // 0.5% default

  check(signal: Signal, trade: Trade): { ok: boolean; slippagePct: number } {
    const dev = Math.abs(trade.entry - signal.price) / signal.price;
    return { ok: dev <= this.maxPct, slippagePct: dev };
  }
}
