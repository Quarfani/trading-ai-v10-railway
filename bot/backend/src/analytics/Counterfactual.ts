/**
 * COUNTERFACTUAL DECISION ENGINE
 *
 * Compares a realized trade with explicitly supplied alternative scenarios.
 * It measures decision quality without inventing prices or outcomes.
 */
export type CounterfactualAction =
  | 'NO_TRADE'
  | 'HALF_SIZE'
  | 'DELAY_ENTRY'
  | 'ALT_STRATEGY'
  | 'ALT_EXIT';

export interface CounterfactualScenario {
  action: CounterfactualAction;
  realizedPnl: number;
  hypotheticalPnl: number;
}

export interface CounterfactualResult {
  baselinePnl: number;
  bestAlternative?: CounterfactualScenario;
  avoidedLoss: number;
  missedProfit: number;
  decisionQuality: 'GOOD' | 'MIXED' | 'POOR' | 'UNKNOWN';
}

export function analyzeCounterfactuals(
  baselinePnl: number,
  scenarios: CounterfactualScenario[],
): CounterfactualResult {
  if (!Number.isFinite(baselinePnl)) {
    throw new Error('[Counterfactual] baselinePnl must be finite');
  }

  const valid = scenarios.filter(
    scenario =>
      Number.isFinite(scenario.hypotheticalPnl) &&
      Number.isFinite(scenario.realizedPnl),
  );

  if (!valid.length) {
    return {
      baselinePnl,
      avoidedLoss: 0,
      missedProfit: 0,
      decisionQuality: 'UNKNOWN',
    };
  }

  const best = [...valid].sort(
    (a, b) => b.hypotheticalPnl - a.hypotheticalPnl,
  )[0];

  const improvement = best.hypotheticalPnl - baselinePnl;
  const avoidedLoss = Math.max(0, improvement);
  const missedProfit =
    baselinePnl > 0
      ? Math.max(0, improvement)
      : 0;

  let decisionQuality: CounterfactualResult['decisionQuality'];
  if (baselinePnl >= 0 && improvement <= 0) {
    decisionQuality = 'GOOD';
  } else if (baselinePnl < 0 && best.hypotheticalPnl >= 0) {
    decisionQuality = 'POOR';
  } else if (Math.abs(improvement) > Math.abs(baselinePnl) * 0.5) {
    decisionQuality = 'POOR';
  } else {
    decisionQuality = 'MIXED';
  }

  return {
    baselinePnl,
    bestAlternative: best,
    avoidedLoss,
    missedProfit,
    decisionQuality,
  };
}
