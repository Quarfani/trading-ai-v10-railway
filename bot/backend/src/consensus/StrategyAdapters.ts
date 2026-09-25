/**
 * STRATEGY ADAPTERS — v7.0
 * V6: TREND, RSI, BREAKOUT, STRUCTURE (unchanged)
 * V7: MACD_DIV, ICHIMOKU, STOCH_RSI, VWAP (new)
 */
import { IStrategy, StrategySignal, StrategyContext, EMPTY_METRICS_DEFAULT } from './types';
import { TrendEngine }            from '../engines/TrendEngine';
import { RSIEngine }              from '../engines/RSIEngine';
import { BreakoutEngine, setH4Cache } from '../engines/BreakoutEngine';
import { MarketStructureEngine }  from '../engines/MarketStructureEngine';
import { MACDDivergenceEngine }   from '../engines/MACDDivergenceEngine';
import { IchimokuEngine }         from '../engines/IchimokuEngine';
import { StochasticRSIEngine }    from '../engines/StochasticRSIEngine';
import { VWAPEngine }             from '../engines/VWAPEngine';
import { Signal }                 from '../types/trading.types';

function toStrategySignal(name: string, signal: Signal | null): Omit<StrategySignal, 'metrics'> {
  if (!signal) return { signal: 'NONE', confidence: 0, risk_score: 0, strategy_name: name, raw_signal: null };
  const slDist  = Math.abs(signal.price - signal.sl);
  const tpDist  = Math.abs(signal.tp - signal.price);
  const rrRatio = slDist > 0 ? tpDist / slDist : 0;
  const risk_score = Math.max(0, Math.min(1, (1 / (rrRatio + 0.1)) * (1 - signal.confidence)));
  return { signal: signal.side as 'BUY' | 'SELL', confidence: signal.confidence, risk_score, strategy_name: name, raw_signal: signal };
}

const NONE = (name: string): StrategySignal =>
  ({ signal: 'NONE', confidence: 0, risk_score: 0, strategy_name: name, raw_signal: null, metrics: EMPTY_METRICS_DEFAULT });

// ── V6 ────────────────────────────────────────────────────────────────────────

export class TrendStrategyAdapter implements IStrategy {
  readonly name = 'TREND'; private engine = new TrendEngine();
  generate_signal(ctx: StrategyContext): StrategySignal {
    if (ctx.regime === 'RANGING' || ctx.regime === 'VOLATILE') return NONE(this.name);
    const raw = (() => { try { return this.engine.analyze(ctx.symbol, ctx.candles); } catch { return null; } })();
    return { ...toStrategySignal(this.name, raw), metrics: EMPTY_METRICS_DEFAULT };
  }
}

export class RSIStrategyAdapter implements IStrategy {
  readonly name = 'RSI'; private engine = new RSIEngine();
  generate_signal(ctx: StrategyContext): StrategySignal {
    if (ctx.regime === 'VOLATILE') return NONE(this.name);
    const raw = (() => { try { return this.engine.analyze(ctx.symbol, ctx.candles); } catch { return null; } })();
    return { ...toStrategySignal(this.name, raw), metrics: EMPTY_METRICS_DEFAULT };
  }
}

export class BreakoutStrategyAdapter implements IStrategy {
  readonly name = 'BREAKOUT'; private engine = new BreakoutEngine();
  generate_signal(ctx: StrategyContext): StrategySignal {
    if (ctx.regime === 'VOLATILE') return NONE(this.name);
    if (ctx.h4Candles.length) setH4Cache(ctx.symbol, ctx.h4Candles);
    const raw = (() => { try { return this.engine.analyze(ctx.symbol, ctx.candles); } catch { return null; } })();
    return { ...toStrategySignal(this.name, raw), metrics: EMPTY_METRICS_DEFAULT };
  }
}

export class StructureStrategyAdapter implements IStrategy {
  readonly name = 'STRUCTURE'; private engine = new MarketStructureEngine();
  generate_signal(ctx: StrategyContext): StrategySignal {
    if (ctx.regime === 'VOLATILE') return NONE(this.name);
    const raw = (() => { try { return this.engine.analyze(ctx.symbol, ctx.candles); } catch { return null; } })();
    return { ...toStrategySignal(this.name, raw), metrics: EMPTY_METRICS_DEFAULT };
  }
}

// ── V7 NEW ────────────────────────────────────────────────────────────────────

export class MACDDivergenceAdapter implements IStrategy {
  readonly name = 'MACD_DIV'; private engine = new MACDDivergenceEngine();
  generate_signal(ctx: StrategyContext): StrategySignal {
    if (ctx.regime === 'VOLATILE') return NONE(this.name);
    const raw = (() => { try { return this.engine.analyze(ctx.symbol, ctx.candles); } catch { return null; } })();
    return { ...toStrategySignal(this.name, raw), metrics: EMPTY_METRICS_DEFAULT };
  }
}

export class IchimokuAdapter implements IStrategy {
  readonly name = 'ICHIMOKU'; private engine = new IchimokuEngine();
  generate_signal(ctx: StrategyContext): StrategySignal {
    if (ctx.regime === 'VOLATILE') return NONE(this.name);
    const raw = (() => { try { return this.engine.analyze(ctx.symbol, ctx.candles); } catch { return null; } })();
    return { ...toStrategySignal(this.name, raw), metrics: EMPTY_METRICS_DEFAULT };
  }
}

export class StochasticRSIAdapter implements IStrategy {
  readonly name = 'STOCH_RSI'; private engine = new StochasticRSIEngine();
  generate_signal(ctx: StrategyContext): StrategySignal {
    // Only works in RANGING — skip TRENDING and VOLATILE
    if (ctx.regime === 'TRENDING' || ctx.regime === 'VOLATILE') return NONE(this.name);
    const raw = (() => { try { return this.engine.analyze(ctx.symbol, ctx.candles); } catch { return null; } })();
    return { ...toStrategySignal(this.name, raw), metrics: EMPTY_METRICS_DEFAULT };
  }
}

export class VWAPAdapter implements IStrategy {
  readonly name = 'VWAP'; private engine = new VWAPEngine();
  generate_signal(ctx: StrategyContext): StrategySignal {
    if (ctx.regime === 'VOLATILE') return NONE(this.name);
    const raw = (() => { try { return this.engine.analyze(ctx.symbol, ctx.candles); } catch { return null; } })();
    return { ...toStrategySignal(this.name, raw), metrics: EMPTY_METRICS_DEFAULT };
  }
}

// ── Factory: returns all 8 adapters ──────────────────────────────────────────
export function createDefaultAdapters(): IStrategy[] {
  return [
    new TrendStrategyAdapter(),
    new RSIStrategyAdapter(),
    new BreakoutStrategyAdapter(),
    new StructureStrategyAdapter(),
    new MACDDivergenceAdapter(),
    new IchimokuAdapter(),
    new StochasticRSIAdapter(),
    new VWAPAdapter(),
  ];
}

// ── Strategy #9: Support & Resistance ────────────────────────────────────────

import { SupportResistanceEngine } from '../engines/SupportResistanceEngine';

export class SupportResistanceAdapter implements IStrategy {
  readonly name = 'SR'; private engine = new SupportResistanceEngine();
  generate_signal(ctx: StrategyContext): StrategySignal {
    if (ctx.regime === 'VOLATILE') return NONE(this.name);
    const raw = (() => {
      try { return this.engine.analyze(ctx.symbol, ctx.candles, ctx.h4Candles); } catch { return null; }
    })();
    return { ...toStrategySignal(this.name, raw), metrics: EMPTY_METRICS_DEFAULT };
  }
}

/** Updated factory — now returns 9 strategies */
export function createAllAdapters(): IStrategy[] {
  return [
    new TrendStrategyAdapter(),
    new RSIStrategyAdapter(),
    new BreakoutStrategyAdapter(),
    new StructureStrategyAdapter(),
    new MACDDivergenceAdapter(),
    new IchimokuAdapter(),
    new StochasticRSIAdapter(),
    new VWAPAdapter(),
    new SupportResistanceAdapter(),   // [NEW v9] Strategy #9
  ];
}
