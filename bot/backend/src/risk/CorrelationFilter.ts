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
    const canonicalSymbol = canonicalCorrelationSymbol(symbol);

    for (const t of openTrades) {
      const canonicalExisting = canonicalCorrelationSymbol(t.symbol);
      if (canonicalExisting === canonicalSymbol) continue;

      // Try live Pearson first. Correlation becomes portfolio-PnL
      // correlation only after accounting for trade directions:
      // +corr + same side, or -corr + opposite side, are overlapping risk.
      if (candleMap?.[symbol] && candleMap?.[t.symbol]) {
        const corr = this.getPearson(
          symbol,
          t.symbol,
          candleMap[symbol],
          candleMap[t.symbol],
        );
        if (corr == null || !Number.isFinite(corr)) {
          return {
            blocked: true,
            with: t.symbol,
          };
        }
        const sideSign = side === 'BUY' ? 1 : -1;
        const existingSideSign = t.side === 'BUY' ? 1 : -1;
        const exposureCorrelation = corr * sideSign * existingSideSign;

        if (exposureCorrelation > this.MAX_CORR) {
          return { blocked: true, with: t.symbol, correlation: corr };
        }
        continue; // Pearson computed — skip static check
      }

      // Static map only represents known positive correlations, so it is
      // applicable when both trades point in the same direction.
      if (t.side !== side) continue;
      const peers = STATIC_PAIRS[canonicalSymbol] ?? [];
      if (peers.includes(canonicalExisting)) {
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

  private getPearson(
    symA: string,
    symB: string,
    candlesA: Candle[],
    candlesB: Candle[],
  ): number | null {
    const key = this.pairKey(symA, symB);
    const cached = this.matrix.get(key);
    if (
      cached &&
      Date.now() - cached.updatedAt < this.TTL &&
      Number.isFinite(cached.value)
    ) {
      return cached.value;
    }

    const corr = this.computePearson(candlesA, candlesB);
    if (!Number.isFinite(corr)) {
      this.matrix.delete(key);
      return null;
    }

    this.matrix.set(key, { value: corr, updatedAt: Date.now() });
    return corr;
  }

  private computePearson(candlesA: Candle[], candlesB: Candle[], bars = 50): number {
    const n   = Math.min(candlesA.length, candlesB.length, bars);
    if (n < 10) return 0;

    const closesA = candlesA.slice(-n).map(c => Number(c.close));
    const closesB = candlesB.slice(-n).map(c => Number(c.close));
    if (
      closesA.some(price => !(price > 0) || !Number.isFinite(price)) ||
      closesB.some(price => !(price > 0) || !Number.isFinite(price))
    ) {
      return Number.NaN;
    }

    const rA  = this.returns(closesA);
    const rB  = this.returns(closesB);
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
      if (
        !(prices[i - 1] > 0) ||
        !Number.isFinite(prices[i - 1]) ||
        !Number.isFinite(prices[i])
      ) {
        return [];
      }
      const value = (prices[i] - prices[i - 1]) / prices[i - 1];
      if (!Number.isFinite(value)) return [];
      r.push(value);
    }
    return r;
  }

  private pairKey(a: string, b: string): string {
    return [canonicalCorrelationSymbol(a), canonicalCorrelationSymbol(b)].sort().join('_');
  }
}

function canonicalCorrelationSymbol(symbol: string): string {
  const raw = symbol.trim().toUpperCase();
  return raw.split(/[._:-]/, 1)[0].replace(/[^A-Z0-9]/g, '');
}
