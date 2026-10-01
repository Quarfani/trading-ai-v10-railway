/**
 * EXPECTED VALUE ENGINE
 *
 * EV is calculated after explicit execution costs. The engine does not
 * forecast prices; it evaluates whether a proposed trade has positive
 * expected value under supplied probabilities and payoffs.
 */
export interface EVInput {
  winProbability: number;
  lossProbability?: number;
  winAmount: number;
  lossAmount: number;
  costs: number;
  safetyMargin?: number;
}

export interface EVResult {
  expectedGross: number;
  expectedNet: number;
  winProbability: number;
  lossProbability: number;
  edgeAfterCosts: number;
  passed: boolean;
  reason: string;
}

function probability(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`[ExpectedValue] ${name} must be within [0,1]`);
  }
  return value;
}

function nonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`[ExpectedValue] ${name} must be finite and >= 0`);
  }
  return value;
}

export function calculateExpectedValue(input: EVInput): EVResult {
  const winP = probability('winProbability', input.winProbability);
  const lossP =
    input.lossProbability == null
      ? 1 - winP
      : probability('lossProbability', input.lossProbability);

  if (Math.abs(winP + lossP - 1) > 1e-9) {
    throw new Error(
      '[ExpectedValue] winProbability + lossProbability must equal 1',
    );
  }

  const winAmount = nonNegative('winAmount', input.winAmount);
  const lossAmount = nonNegative('lossAmount', input.lossAmount);
  const costs = nonNegative('costs', input.costs);
  const safetyMargin = nonNegative(
    'safetyMargin',
    input.safetyMargin ?? 0,
  );

  const expectedGross =
    winP * winAmount - lossP * lossAmount;
  const expectedNet = expectedGross - costs;
  const edgeAfterCosts =
    expectedGross > 0
      ? expectedNet / expectedGross
      : expectedNet;

  const passed = expectedNet > safetyMargin;

  return {
    expectedGross,
    expectedNet,
    winProbability: winP,
    lossProbability: lossP,
    edgeAfterCosts,
    passed,
    reason: passed
      ? `Positive EV after costs: ${expectedNet.toFixed(2)}`
      : `EV ${expectedNet.toFixed(2)} <= safety margin ${safetyMargin.toFixed(2)}`,
  };
}

export function calculateTradeEVFromRR(
  winProbability: number,
  riskAmount: number,
  rewardRiskRatio: number,
  costs: number,
  safetyMargin = 0,
): EVResult {
  if (!Number.isFinite(riskAmount) || riskAmount <= 0) {
    throw new Error('[ExpectedValue] riskAmount must be > 0');
  }
  if (!Number.isFinite(rewardRiskRatio) || rewardRiskRatio <= 0) {
    throw new Error('[ExpectedValue] rewardRiskRatio must be > 0');
  }

  return calculateExpectedValue({
    winProbability,
    winAmount: riskAmount * rewardRiskRatio,
    lossAmount: riskAmount,
    costs,
    safetyMargin,
  });
}
