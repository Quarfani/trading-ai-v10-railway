/**
 * STRATEGY ELIGIBILITY
 *
 * Applies first-class scope metadata when a strategy has a persisted definition.
 * Legacy strategies remain compatible until they are formally classified.
 */
import { getMarketDefinition } from '../market/MarketCatalog';
import { StrategyDefinition } from './strategyDefinition';
import { StrategyContext } from './types';

export interface EligibilityResult {
  allowed: boolean;
  reason: string;
}

export function evaluateStrategyEligibility(
  definition: StrategyDefinition | undefined,
  ctx: StrategyContext,
): EligibilityResult {
  if (!definition) return { allowed: true, reason: 'legacy strategy without definition' };
  if (!definition.enabled) return { allowed: false, reason: 'strategy definition disabled' };

  const market = getMarketDefinition(ctx.symbol);
  if (!market) return { allowed: false, reason: 'unknown market definition' };

  if (definition.scope.assetClasses.length > 0 &&
      !definition.scope.assetClasses.includes(market.assetClass)) {
    return { allowed: false, reason: 'asset class outside strategy scope' };
  }
  if (definition.scope.symbols.length > 0 &&
      !definition.scope.symbols.includes(ctx.symbol)) {
    return { allowed: false, reason: 'symbol outside strategy scope' };
  }
  if (definition.scope.timeframes.length > 0 &&
      !definition.scope.timeframes.includes(ctx.timeframe)) {
    return { allowed: false, reason: 'timeframe outside strategy scope' };
  }
  if (definition.scope.regimes.length > 0 &&
      !definition.scope.regimes.includes(ctx.regime)) {
    return { allowed: false, reason: 'regime outside strategy scope' };
  }

  return { allowed: true, reason: 'strategy scope matched' };
}
