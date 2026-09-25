/**
 * CORRELATION FILTER — ENHANCED
 * [NEW] Pearson Rolling Correlation — يحسب الارتباط الحقيقي بين الأزواج
 * يُعاد الحساب كل ساعة تلقائياً
 */
import { Side, Trade, Candle } from '../types/trading.types';
import { Logger }              from '../utils/Logger';

// Static correlation map (fallback when no live data)
const STATIC_PAIRS: Record<string, string[]> = {
  EURUSD:  ['GBPUSD', 'AUDUSD', 'NZDUSD'],
  GBPUSD:  ['EURUSD', 'AUDUSD'],
  AUDUSD:  ['NZDUSD', 'EURUSD'],
  NZDUSD:  ['AUDUSD', 'EURUSD'],
  USDCHF:  ['USDJPY'],
  USDJPY:  ['USDCHF'],
  XAUUSD:  ['XAGUSD'],
  BTCUSDT: ['ETHUSDT'],
  ETHUSDT: ['BTCUSDT'],
};

interface CorrelationEntry {
  value:     number;  // Pearson -1..1
  updatedAt: number;
}

export class CorrelationFilter {
  private logger = new Logger('CorrelationFilter');
  // key: "EURUSD_GBPUSD" → correlation value
  private matrix  = new Map<string, CorrelationEntry>();
  private readonly MAX_CORR = 0.80;  // block if correlation > 0.80
  private readonly TTL      = 3_600_000; // 1 hour

  /**
   * Check if new trade is correlated with any open trade.
   * Uses live Pearson correlation when candle data is available,
   * falls back to static pairs map.
   */
  isCorrelated(
    symbol:     string,
    side:       Side,
    openTrades: Trade[],
    candleMap?: Record<string, Candle[]>, // live candles for Pearson
  ): { blocked: boolean; with?: string; correlation?: number } {
    for (const t of openTrades) {
      if (t.symbol === symbol) continue;
      if (t.side !== side)     continue; // only block SAME direction

      // Try live Pearson first
      if (candleMap?.[symbol] && candleMap?.[t.symbol]) {
        const corr = this.getPearson(symbol, t.symbol, candleMap[symbol], candleMap[t.symbol]);
        if (Math.abs(corr) > this.MAX_CORR) {
          return { blocked: true, with: t.symbol, correlation: corr };
        }
        continue; // Pearson computed — skip static check
      }

      // Fall back to static pairs
      const peers = STATIC_PAIRS[symbol] ?? [];
      if (peers.includes(t.symbol)) {
        return { blocked: true, with: t.symbol };
      }
    }
    return { blocked: false };
  }

  /** Update live candle data for correlation calculation */
  updateCandles(symbolA: string, symbolB: string, candlesA: Candle[], candlesB: Candle[]) {
    const key  = this.pairKey(symbolA, symbolB);
    const corr = this.computePearson(candlesA, candlesB);
    this.matrix.set(key, { value: corr, updatedAt: Date.now() });
  }

  // ─── Pearson correlation ────────────────────────────────────────────────

  private getPearson(symA: string, symB: string, candlesA: Candle[], candlesB: Candle[]): number {
    const key    = this.pairKey(symA, symB);
    const cached = this.matrix.get(key);
    if (cached && Date.now() - cached.updatedAt < this.TTL) return cached.value;

    const corr = this.computePearson(candlesA, candlesB);
    this.matrix.set(key, { value: corr, updatedAt: Date.now() });
    return corr;
  }

  private computePearson(candlesA: Candle[], candlesB: Candle[], bars = 50): number {
    const n   = Math.min(candlesA.length, candlesB.length, bars);
    if (n < 10) return 0;

    const rA  = this.returns(candlesA.slice(-n).map(c => c.close));
    const rB  = this.returns(candlesB.slice(-n).map(c => c.close));
    const len = Math.min(rA.length, rB.length);
    if (len < 5) return 0;

    const mA  = rA.slice(0, len).reduce((s, v) => s + v, 0) / len;
    const mB  = rB.slice(0, len).reduce((s, v) => s + v, 0) / len;

    let cov = 0, varA = 0, varB = 0;
    for (let i = 0; i < len; i++) {
      const dA = rA[i] - mA, dB = rB[i] - mB;
      cov  += dA * dB;
      varA += dA * dA;
      varB += dB * dB;
    }

    const denom = Math.sqrt(varA * varB);
    return denom > 0 ? Math.max(-1, Math.min(1, cov / denom)) : 0;
  }

  private returns(prices: number[]): number[] {
    const r: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      r.push(prices[i - 1] > 0 ? (prices[i] - prices[i - 1]) / prices[i - 1] : 0);
    }
    return r;
  }

  private pairKey(a: string, b: string): string {
    return [a, b].sort().join('_');
  }
}
