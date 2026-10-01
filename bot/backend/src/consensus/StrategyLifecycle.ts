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

  if (
    ['PAPER', 'TESTNET', 'SHADOW', 'SMALL_CAPITAL', 'PRODUCTION'].includes(to) &&
    !hasPromotionEvidence(current, policy)
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
