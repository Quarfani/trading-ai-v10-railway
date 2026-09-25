/**
 * CORRELATION MATRIX — v8.0
 * يحسب Pearson correlation بين جميع الرموز المفتوحة
 * ويُرجع مصفوفة للعرض في API/Dashboard
 */
import { Candle } from '../types/trading.types';

export interface CorrelationMatrix {
  symbols:    string[];
  matrix:     number[][];  // [i][j] = correlation between symbols[i] and symbols[j]
  highPairs:  Array<{ a: string; b: string; correlation: number }>;  // |r| > 0.75
  updatedAt:  number;
}

export class CorrelationMatrixBuilder {
  build(candleMap: Record<string, Candle[]>, symbols: string[], lookback = 50): CorrelationMatrix {
    const syms    = symbols.filter(s => candleMap[s]?.length >= lookback);
    const returns = syms.map(s => this.getReturns(candleMap[s].slice(-lookback)));
    const n       = syms.length;
    const matrix  = Array.from({ length: n }, () => new Array(n).fill(0));
    const highPairs: CorrelationMatrix['highPairs'] = [];

    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1;
      for (let j = i + 1; j < n; j++) {
        const r = this.pearson(returns[i], returns[j]);
        matrix[i][j] = +r.toFixed(3);
        matrix[j][i] = +r.toFixed(3);
        if (Math.abs(r) > 0.75) {
          highPairs.push({ a: syms[i], b: syms[j], correlation: +r.toFixed(3) });
        }
      }
    }

    highPairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
    return { symbols: syms, matrix, highPairs, updatedAt: Date.now() };
  }

  private getReturns(candles: Candle[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      out.push(candles[i].close / candles[i-1].close - 1);
    }
    return out;
  }

  private pearson(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    if (n < 5) return 0;
    const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
    const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da  += (a[i] - ma) ** 2;
      db  += (b[i] - mb) ** 2;
    }
    const denom = Math.sqrt(da * db);
    return denom > 0 ? num / denom : 0;
  }
}
