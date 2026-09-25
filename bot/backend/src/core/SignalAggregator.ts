/**
 * SIGNAL AGGREGATOR — COMPLETE v5.0
 * يدمج 4 محركات: Trend + RSI + Breakout + MarketStructure
 * Regime-aware: كل محرك يعمل فقط في الـ Regime المناسب له
 */
import { Candle, Signal, SystemConfig } from '../types/trading.types';
import { TrendEngine }           from '../engines/TrendEngine';
import { RSIEngine }             from '../engines/RSIEngine';
import { BreakoutEngine, setH4Cache } from '../engines/BreakoutEngine';
import { MarketStructureEngine } from '../engines/MarketStructureEngine';
import { MarketRegime }          from './MarketRegimeDetector';
import { Logger }                from '../utils/Logger';

export class SignalAggregator {
  private logger    = new Logger('SignalAggregator');
  private trend     = new TrendEngine();
  private rsi       = new RSIEngine();
  private breakout  = new BreakoutEngine();
  private structure = new MarketStructureEngine();

  constructor(private config: SystemConfig) {}

  aggregate(symbol: string, candles: Candle[], regime: MarketRegime = 'UNKNOWN', h4Candles?: Candle[]): Signal | null {
    // Pass H4 candles to BreakoutEngine for key level validation
    if (h4Candles?.length) setH4Cache(symbol, h4Candles);

    const engines = this.selectEngines(regime);
    const all     = engines
      .map(e => { try { return e.analyze(symbol, candles); } catch { return null; } })
      .filter((s): s is Signal => s !== null);

    if (!all.length) return null;

    const buys  = all.filter(s => s.side === 'BUY');
    const sells = all.filter(s => s.side === 'SELL');
    const winners = buys.length >= sells.length ? buys : sells;

    if (!winners.length) return null;

    // Single engine needs minimum confidence
    if (winners.length === 1 && winners[0].confidence < 0.70) {
      this.logger.debug(`${symbol}: single conf=${winners[0].confidence.toFixed(2)} < 0.70`);
      return null;
    }

    const sorted = [...winners].sort((a, b) => b.confidence - a.confidence);
    const top    = sorted[0];
    const avg    = winners.reduce((s, x) => s + x.confidence, 0) / winners.length;
    const bonus  = (winners.length - 1) * 0.05;
    const conf   = Math.min(0.95, avg + bonus);

    const merged: Signal = {
      symbol,
      side:       top.side,
      price:      top.price,
      confidence: conf,
      sl:         top.sl,
      tp:         top.tp,
      source:     winners.map(s => s.source).join('+'),
      reason:     `[${regime}] ` + winners.map(s => s.reason).join(' | '),
      timestamp:  Date.now(),
      regime,
    };

    this.logger.debug(
      `${symbol} [${regime}]: ${merged.side} conf=${(conf*100).toFixed(0)}% src=${merged.source}`
    );
    return merged;
  }

  private selectEngines(regime: MarketRegime): Array<{ analyze(s: string, c: Candle[]): Signal | null }> {
    switch (regime) {
      case 'TRENDING':
        return [this.trend, this.breakout, this.structure];
      case 'RANGING':
        return [this.rsi];
      case 'VOLATILE':
        return [];
      default:
        return [this.trend, this.rsi, this.breakout, this.structure];
    }
  }
}
