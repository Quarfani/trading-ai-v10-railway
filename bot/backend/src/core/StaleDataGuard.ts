import { Candle, Timeframe } from '../types/trading.types';

const TF_SECONDS: Record<Timeframe, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400,
};

/**
 * Rejects trading if the latest candle is older than 3× the timeframe duration.
 * Protects against MT5 bridge feeding stale/cached data after a disconnect.
 */
export class StaleDataGuard {
  isFresh(candles: Candle[], tf: Timeframe): { ok: boolean; ageSec: number } {
    if (!candles.length) return { ok: false, ageSec: Infinity };
    const last = candles[candles.length - 1];
    if (
      !Number.isFinite(last.time) ||
      last.time <= 0 ||
      last.time > Date.now() + 5_000
    ) {
      return { ok: false, ageSec: Infinity };
    }
    const ageSec = (Date.now() - last.time) / 1000;
    const limit = TF_SECONDS[tf] * 3;
    if (!Number.isFinite(limit) || limit < 0) {
      return { ok: false, ageSec: Infinity };
    }
    return { ok: ageSec >= 0 && ageSec <= limit, ageSec };
  }
}
