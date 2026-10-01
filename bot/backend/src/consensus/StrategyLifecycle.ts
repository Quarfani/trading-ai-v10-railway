/**
 * EXECUTABLE STRATEGY PROMOTION RULES
 *
 * Only the documented sequence is allowed. Promotion beyond Monte Carlo also
 * requires an explicit evidence snapshot with a versioned dataset and cost model.
 */
import {
  StrategyDefinition,
  StrategyLifecycleState,
  validateStrategyDefinition,
} from './strategyDefinition';
import {
  DEFAULT_EVIDENCE_PROMOTION_POLICY,
  EvidencePromotionPolicy,
  evaluateEvidenceForPromotion,
} from './EvidencePromotionPolicy';

const TRANSITIONS: Record<StrategyLifecycleState, readonly StrategyLifecycleState[]> = {
  RESEARCH: ['BACKTEST', 'REJECTED', 'PAUSED'],
  BACKTEST: ['VALIDATION', 'REJECTED', 'PAUSED'],
  VALIDATION: ['WALK_FORWARD', 'REJECTED', 'PAUSED'],
  WALK_FORWARD: ['MONTE_CARLO', 'REJECTED', 'PAUSED'],
  MONTE_CARLO: ['PAPER', 'REJECTED', 'PAUSED'],
  PAPER: ['TESTNET', 'REJECTED', 'PAUSED'],
  TESTNET: ['SHADOW', 'REJECTED', 'PAUSED'],
  SHADOW: ['SMALL_CAPITAL', 'REJECTED', 'PAUSED'],
  SMALL_CAPITAL: ['PRODUCTION', 'REJECTED', 'PAUSED'],
  PRODUCTION: ['PAUSED'],
  PAUSED: ['RESEARCH', 'BACKTEST', 'VALIDATION', 'WALK_FORWARD', 'MONTE_CARLO', 'PAPER', 'TESTNET', 'SHADOW', 'SMALL_CAPITAL'],
  REJECTED: [],
};

export interface LifecycleTransition {
  from: StrategyLifecycleState;
  to: StrategyLifecycleState;
  at: number;
  reason: string;
}

export function canTransition(from: StrategyLifecycleState, to: StrategyLifecycleState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function hasPromotionEvidence(
  definition: StrategyDefinition,
  policy: EvidencePromotionPolicy = DEFAULT_EVIDENCE_PROMOTION_POLICY,
): boolean {
  return evaluateEvidenceForPromotion(definition.evidence, policy).passed;
}

function promotionPolicyForTarget(
  to: StrategyLifecycleState,
  base: EvidencePromotionPolicy,
): EvidencePromotionPolicy {
  if (to === 'SMALL_CAPITAL') {
    return {
      ...base,
      minSampleSize: Math.max(base.minSampleSize, 300),
      minOutOfSampleTrades: Math.max(base.minOutOfSampleTrades, 200),
      minOutOfSampleProfitFactor: Math.max(base.minOutOfSampleProfitFactor, 1.5),
      minWalkForwardStability: Math.max(base.minWalkForwardStability, 0.60),
      minParameterSensitivity: Math.max(base.minParameterSensitivity, 0.60),
      minRegimeCoverage: Math.max(base.minRegimeCoverage, 0.60),
      requireMonteCarlo: true,
    };
  }

  if (to === 'PRODUCTION') {
    return {
      ...base,
      minSampleSize: Math.max(base.minSampleSize, 300),
      minOutOfSampleTrades: Math.max(base.minOutOfSampleTrades, 300),
      minOutOfSampleProfitFactor: Math.max(base.minOutOfSampleProfitFactor, 1.5),
      minWalkForwardStability: Math.max(base.minWalkForwardStability, 0.65),
      minParameterSensitivity: Math.max(base.minParameterSensitivity, 0.65),
      minRegimeCoverage: Math.max(base.minRegimeCoverage, 0.65),
      requireMonteCarlo: true,
    };
  }

  return base;
}

export function promoteStrategy(
  definition: StrategyDefinition,
  to: StrategyLifecycleState,
  reason: string,
  at = Date.now(),
  policy: EvidencePromotionPolicy = DEFAULT_EVIDENCE_PROMOTION_POLICY,
): { definition: StrategyDefinition; transition: LifecycleTransition } {
  const current = validateStrategyDefinition(definition);

  if (!canTransition(current.lifecycle, to)) {
    throw new Error(
      `[StrategyLifecycle] invalid transition ${current.lifecycle} -> ${to}`,
    );
  }

  const targetPolicy = promotionPolicyForTarget(to, policy);

  if (
    ['PAPER', 'TESTNET', 'SHADOW', 'SMALL_CAPITAL', 'PRODUCTION'].includes(to) &&
    !hasPromotionEvidence(current, targetPolicy)
  ) {
    throw new Error(
      `[StrategyLifecycle] incomplete evidence for promotion to ${to}`,
    );
  }

  return {
    definition: { ...current, lifecycle: to, updatedAt: at },
    transition: { from: current.lifecycle, to, at, reason },
  };
}
