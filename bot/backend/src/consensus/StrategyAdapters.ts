/**
 * STRATEGY ADAPTERS — v7.1 DIAGNOSTIC
 *
 * V6:
 *   TREND, RSI, BREAKOUT, STRUCTURE
 *
 * V7:
 *   MACD_DIV, ICHIMOKU, STOCH_RSI, VWAP
 *
 * V9:
 *   SUPPORT / RESISTANCE
 *
 * Diagnostic improvements:
 *   - Log regime-based skips
 *   - Log engine returning null
 *   - Log engine exceptions
 *   - Log generated BUY / SELL signals
 *   - Log candle counts
 *
 * IMPORTANT:
 *   Strategy logic and regime gates are intentionally preserved.
 *   This version diagnoses the problem before changing strategy behavior.
 */

import {
  IStrategy,
  StrategySignal,
  StrategyContext,
  EMPTY_METRICS_DEFAULT,
} from './types';

import { TrendEngine } from '../engines/TrendEngine';
import { RSIEngine } from '../engines/RSIEngine';
import {
  BreakoutEngine,
  setH4Cache,
} from '../engines/BreakoutEngine';

import { MarketStructureEngine } from '../engines/MarketStructureEngine';
import { MACDDivergenceEngine } from '../engines/MACDDivergenceEngine';
import { IchimokuEngine } from '../engines/IchimokuEngine';
import { StochasticRSIEngine } from '../engines/StochasticRSIEngine';
import { VWAPEngine } from '../engines/VWAPEngine';
import { SupportResistanceEngine } from '../engines/SupportResistanceEngine';

import { Signal } from '../types/trading.types';
import { Logger } from '../utils/Logger';

const logger = new Logger('StrategyAdapters');

// ─────────────────────────────────────────────────────────────────────────────
// Signal conversion
// ─────────────────────────────────────────────────────────────────────────────

function toStrategySignal(
  name: string,
  signal: Signal | null,
): Omit<StrategySignal, 'metrics'> {
  if (!signal) {
    return {
      signal: 'NONE',
      confidence: 0,
      risk_score: 0,
      strategy_name: name,
      raw_signal: null,
    };
  }

  const slDist = Math.abs(
    signal.price - signal.sl,
  );

  const tpDist = Math.abs(
    signal.tp - signal.price,
  );

  const rrRatio =
    slDist > 0
      ? tpDist / slDist
      : 0;

  const risk_score = Math.max(
    0,
    Math.min(
      1,
      (1 / (rrRatio + 0.1)) *
        (1 - signal.confidence),
    ),
  );

  return {
    signal: signal.side as 'BUY' | 'SELL',
    confidence: signal.confidence,
    risk_score,
    strategy_name: name,
    raw_signal: signal,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NONE helper
// ─────────────────────────────────────────────────────────────────────────────

const NONE = (
  name: string,
): StrategySignal => ({
  signal: 'NONE',
  confidence: 0,
  risk_score: 0,
  strategy_name: name,
  raw_signal: null,
  metrics: EMPTY_METRICS_DEFAULT,
});

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic helpers
// ─────────────────────────────────────────────────────────────────────────────

function logSkip(
  ctx: StrategyContext,
  strategy: string,
  reason: string,
): StrategySignal {
  logger.info(
    `[STRATEGY_SKIP] ` +
    `symbol=${ctx.symbol} ` +
    `strategy=${strategy} ` +
    `regime=${ctx.regime} ` +
    `candles=${ctx.candles.length} ` +
    `h4Candles=${ctx.h4Candles.length} ` +
    `reason=${reason}`,
  );

  return NONE(strategy);
}

function analyzeSafely(
  ctx: StrategyContext,
  strategy: string,
  analyze: () => Signal | null,
): Signal | null {
  try {
    const raw = analyze();

    if (!raw) {
      logger.info(
        `[STRATEGY_NULL] ` +
        `symbol=${ctx.symbol} ` +
        `strategy=${strategy} ` +
        `regime=${ctx.regime} ` +
        `candles=${ctx.candles.length} ` +
        `h4Candles=${ctx.h4Candles.length} ` +
        `reason=engine_returned_null`,
      );

      return null;
    }

    logger.info(
      `[STRATEGY_SIGNAL] ` +
      `symbol=${ctx.symbol} ` +
      `strategy=${strategy} ` +
      `side=${raw.side} ` +
      `confidence=${Number(raw.confidence).toFixed(4)} ` +
      `price=${raw.price} ` +
      `sl=${raw.sl} ` +
      `tp=${raw.tp}`,
    );

    return raw;
  } catch (error: any) {
    logger.error(
      `[STRATEGY_EXCEPTION] ` +
      `symbol=${ctx.symbol} ` +
      `strategy=${strategy} ` +
      `regime=${ctx.regime} ` +
      `candles=${ctx.candles.length} ` +
      `h4Candles=${ctx.h4Candles.length} ` +
      `error=${error?.message ?? String(error)}`,
    );

    return null;
  }
}

function buildSignal(
  ctx: StrategyContext,
  strategy: string,
  raw: Signal | null,
): StrategySignal {
  const result = {
    ...toStrategySignal(strategy, raw),
    metrics: EMPTY_METRICS_DEFAULT,
  };

  if (result.signal === 'NONE') {
    logger.info(
      `[STRATEGY_NONE] ` +
      `symbol=${ctx.symbol} ` +
      `strategy=${strategy} ` +
      `reason=no_signal_after_conversion`,
    );
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// V6
// ─────────────────────────────────────────────────────────────────────────────

export class TrendStrategyAdapter
  implements IStrategy
{
  readonly name = 'TREND';

  private engine = new TrendEngine();

  generate_signal(
    ctx: StrategyContext,
  ): StrategySignal {
    if (
      ctx.regime === 'RANGING' ||
      ctx.regime === 'VOLATILE'
    ) {
      return logSkip(
        ctx,
        this.name,
        `regime_${ctx.regime.toLowerCase()}`,
      );
    }

    const raw = analyzeSafely(
      ctx,
      this.name,
      () =>
        this.engine.analyze(
          ctx.symbol,
          ctx.candles,
        ),
    );

    return buildSignal(
      ctx,
      this.name,
      raw,
    );
  }
}

export class RSIStrategyAdapter
  implements IStrategy
{
  readonly name = 'RSI';

  private engine = new RSIEngine();

  generate_signal(
    ctx: StrategyContext,
  ): StrategySignal {
    if (ctx.regime === 'VOLATILE') {
      return logSkip(
        ctx,
        this.name,
        'regime_volatile',
      );
    }

    const raw = analyzeSafely(
      ctx,
      this.name,
      () =>
        this.engine.analyze(
          ctx.symbol,
          ctx.candles,
        ),
    );

    return buildSignal(
      ctx,
      this.name,
      raw,
    );
  }
}

export class BreakoutStrategyAdapter
  implements IStrategy
{
  readonly name = 'BREAKOUT';

  private engine = new BreakoutEngine();

  generate_signal(
    ctx: StrategyContext,
  ): StrategySignal {
    if (ctx.regime === 'VOLATILE') {
      return logSkip(
        ctx,
        this.name,
        'regime_volatile',
      );
    }

    if (ctx.h4Candles.length) {
      setH4Cache(
        ctx.symbol,
        ctx.h4Candles,
      );
    }

    const raw = analyzeSafely(
      ctx,
      this.name,
      () =>
        this.engine.analyze(
          ctx.symbol,
          ctx.candles,
        ),
    );

    return buildSignal(
      ctx,
      this.name,
      raw,
    );
  }
}

export class StructureStrategyAdapter
  implements IStrategy
{
  readonly name = 'STRUCTURE';

  private engine =
    new MarketStructureEngine();

  generate_signal(
    ctx: StrategyContext,
  ): StrategySignal {
    if (ctx.regime === 'VOLATILE') {
      return logSkip(
        ctx,
        this.name,
        'regime_volatile',
      );
    }

    const raw = analyzeSafely(
      ctx,
      this.name,
      () =>
        this.engine.analyze(
          ctx.symbol,
          ctx.candles,
        ),
    );

    return buildSignal(
      ctx,
      this.name,
      raw,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// V7
// ─────────────────────────────────────────────────────────────────────────────

export class MACDDivergenceAdapter
  implements IStrategy
{
  readonly name = 'MACD_DIV';

  private engine =
    new MACDDivergenceEngine();

  generate_signal(
    ctx: StrategyContext,
  ): StrategySignal {
    if (ctx.regime === 'VOLATILE') {
      return logSkip(
        ctx,
        this.name,
        'regime_volatile',
      );
    }

    const raw = analyzeSafely(
      ctx,
      this.name,
      () =>
        this.engine.analyze(
          ctx.symbol,
          ctx.candles,
        ),
    );

    return buildSignal(
      ctx,
      this.name,
      raw,
    );
  }
}

export class IchimokuAdapter
  implements IStrategy
{
  readonly name = 'ICHIMOKU';

  private engine =
    new IchimokuEngine();

  generate_signal(
    ctx: StrategyContext,
  ): StrategySignal {
    if (ctx.regime === 'VOLATILE') {
      return logSkip(
        ctx,
        this.name,
        'regime_volatile',
      );
    }

    const raw = analyzeSafely(
      ctx,
      this.name,
      () =>
        this.engine.analyze(
          ctx.symbol,
          ctx.candles,
        ),
    );

    return buildSignal(
      ctx,
      this.name,
      raw,
    );
  }
}

export class StochasticRSIAdapter
  implements IStrategy
{
  readonly name = 'STOCH_RSI';

  private engine =
    new StochasticRSIEngine();

  generate_signal(
    ctx: StrategyContext,
  ): StrategySignal {
    // Only works in RANGING.
    if (
      ctx.regime === 'TRENDING' ||
      ctx.regime === 'VOLATILE'
    ) {
      return logSkip(
        ctx,
        this.name,
        `regime_${ctx.regime.toLowerCase()}`,
      );
    }

    const raw = analyzeSafely(
      ctx,
      this.name,
      () =>
        this.engine.analyze(
          ctx.symbol,
          ctx.candles,
        ),
    );

    return buildSignal(
      ctx,
      this.name,
      raw,
    );
  }
}

export class VWAPAdapter
  implements IStrategy
{
  readonly name = 'VWAP';

  private engine = new VWAPEngine();

  generate_signal(
    ctx: StrategyContext,
  ): StrategySignal {
    if (ctx.regime === 'VOLATILE') {
      return logSkip(
        ctx,
        this.name,
        'regime_volatile',
      );
    }

    const raw = analyzeSafely(
      ctx,
      this.name,
      () =>
        this.engine.analyze(
          ctx.symbol,
          ctx.candles,
        ),
    );

    return buildSignal(
      ctx,
      this.name,
      raw,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory: default V7 set
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Strategy #9: Support & Resistance
// ─────────────────────────────────────────────────────────────────────────────

export class SupportResistanceAdapter
  implements IStrategy
{
  readonly name = 'SR';

  private engine =
    new SupportResistanceEngine();

  generate_signal(
    ctx: StrategyContext,
  ): StrategySignal {
    if (ctx.regime === 'VOLATILE') {
      return logSkip(
        ctx,
        this.name,
        'regime_volatile',
      );
    }

    const raw = analyzeSafely(
      ctx,
      this.name,
      () =>
        this.engine.analyze(
          ctx.symbol,
          ctx.candles,
          ctx.h4Candles,
        ),
    );

    return buildSignal(
      ctx,
      this.name,
      raw,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory: all 9 strategies
// ─────────────────────────────────────────────────────────────────────────────

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
    new SupportResistanceAdapter(),
  ];
}