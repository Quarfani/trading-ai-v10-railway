/**
 * STRATEGY DECAY DETECTOR
 *
 * Classifies observed performance deterioration without mutating parameters.
 * The result feeds the strategy control plane / lifecycle layer.
 */
export type DecayState = 'ACTIVE' | 'REDUCED' | 'WARNING' | 'PAUSED';

export interface DecayInput {
  totalTrades: number;
  rollingTrades: number;
  expectancy: number;
  rollingExpectancy: number;
  profitFactor: number;
  rollingProfitFactor: number;
  maxDrawdown: number;
  recentMaxDrawdown: number;
}

export interface DecayResult {
  state: DecayState;
  score: number;
  reasons: string[];
}

export function detectStrategyDecay(
  input: DecayInput,
  minimumRollingTrades = 20,
): DecayResult {
  const reasons: string[] = [];

  if (!Number.isFinite(input.rollingTrades) || input.rollingTrades < minimumRollingTrades) {
    return {
      state: 'ACTIVE',
      score: 0,
      reasons: [
        `Insufficient rolling sample: ${input.rollingTrades}/${minimumRollingTrades}`,
      ],
    };
  }

  let score = 0;

  if (input.rollingExpectancy < 0) {
    score += 0.35;
    reasons.push('Rolling expectancy is negative');
  } else if (
    input.expectancy > 0 &&
    input.rollingExpectancy < input.expectancy * 0.5
  ) {
    score += 0.20;
    reasons.push('Rolling expectancy fell below 50% of baseline');
  }

  if (
    input.profitFactor > 1 &&
    Number.isFinite(input.rollingProfitFactor) &&
    input.rollingProfitFactor < input.profitFactor * 0.75
  ) {
    score += 0.20;
    reasons.push('Rolling Profit Factor deteriorated materially');
  }

  if (
    Number.isFinite(input.recentMaxDrawdown) &&
    input.recentMaxDrawdown > Math.max(input.maxDrawdown * 1.25, 0.05)
  ) {
    score += 0.25;
    reasons.push('Recent drawdown materially exceeds baseline drawdown');
  }

  if (
    Number.isFinite(input.rollingProfitFactor) &&
    input.rollingProfitFactor < 1
  ) {
    score += 0.20;
    reasons.push('Rolling Profit Factor is below 1');
  }

  score = Math.min(1, score);

  const state: DecayState =
    score >= 0.75 ? 'PAUSED' :
    score >= 0.50 ? 'WARNING' :
    score >= 0.25 ? 'REDUCED' :
    'ACTIVE';

  if (state === 'ACTIVE') reasons.push('No material decay detected');

  return {
    state,
    score: Number(score.toFixed(6)),
    reasons,
  };
}
