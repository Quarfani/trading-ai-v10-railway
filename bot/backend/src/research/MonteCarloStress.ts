/**
 * MONTE CARLO / STRESS TESTING
 *
 * Research-only utilities. They operate on already-realized trade returns and
 * deterministic stress multipliers; they never touch the live execution path.
 */
export interface MonteCarloResult {
  simulations: number;
  percentileDrawdown95: number;
  percentileLossStreak95: number;
  percentileRecoveryTime95: number;
  riskOfRuinEstimate: number;
}

export interface StressScenario {
  name: string;
  spreadMultiplier: number;
  slippageMultiplier: number;
  executionDelayBars: number;
  returnShockMultiplier: number;
}

export interface StressResult {
  scenario: string;
  stressedTrades: number[];
  endingReturn: number;
  maxDrawdown: number;
}

function shuffled<T>(input: T[], random: () => number): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function drawdown(returns: number[]): number {
  let equity = 0;
  let peak = 0;
  let max = 0;
  for (const value of returns) {
    equity += value;
    peak = Math.max(peak, equity);
    if (peak > 0) max = Math.max(max, (peak - equity) / peak);
  }
  return max;
}

function maxLossStreak(returns: number[]): number {
  let current = 0;
  let max = 0;
  for (const value of returns) {
    current = value < 0 ? current + 1 : 0;
    max = Math.max(max, current);
  }
  return max;
}

export function runMonteCarlo(
  returns: number[],
  options: {
    simulations?: number;
    random?: () => number;
    initialEquity?: number;
    ruinFraction?: number;
  } = {},
): MonteCarloResult {
  if (!returns.length) {
    throw new Error('[MonteCarlo] at least one return is required');
  }
  if (returns.some(value => !Number.isFinite(value))) {
    throw new Error('[MonteCarlo] returns must be finite');
  }

  const simulations = Math.max(
    100,
    Math.floor(options.simulations ?? 1000),
  );
  const random = options.random ?? Math.random;
  const initialEquity = options.initialEquity ?? 1;
  const ruinFraction = options.ruinFraction ?? 0.5;

  if (!(initialEquity > 0)) {
    throw new Error('[MonteCarlo] initialEquity must be > 0');
  }
  if (!(ruinFraction > 0 && ruinFraction < 1)) {
    throw new Error('[MonteCarlo] ruinFraction must be in (0,1)');
  }

  const drawdowns: number[] = [];
  const streaks: number[] = [];
  let ruined = 0;

  for (let i = 0; i < simulations; i++) {
    const sequence = shuffled(returns, random);
    const equityPath: number[] = [];
    let equity = initialEquity;

    for (const r of sequence) {
      equity += r * initialEquity;
      equityPath.push(equity);
    }

    const dd = drawdown(sequence);
    drawdowns.push(dd);
    streaks.push(maxLossStreak(sequence));

    const minimumEquity = Math.min(...equityPath);
    if (minimumEquity <= initialEquity * (1 - ruinFraction)) ruined++;
  }

  drawdowns.sort((a, b) => a - b);
  streaks.sort((a, b) => a - b);

  const idx95 = Math.min(
    drawdowns.length - 1,
    Math.floor(drawdowns.length * 0.95),
  );

  const streak95 = Math.min(
    streaks.length - 1,
    Math.floor(streaks.length * 0.95),
  );

  return {
    simulations,
    percentileDrawdown95: drawdowns[idx95],
    percentileLossStreak95: streaks[streak95],
    percentileRecoveryTime95: 0,
    riskOfRuinEstimate: ruined / simulations,
  };
}

export function applyStressScenario(
  returns: number[],
  scenario: StressScenario,
): StressResult {
  if (
    !Number.isFinite(scenario.spreadMultiplier) ||
    scenario.spreadMultiplier < 0 ||
    !Number.isFinite(scenario.slippageMultiplier) ||
    scenario.slippageMultiplier < 0 ||
    !Number.isInteger(scenario.executionDelayBars) ||
    scenario.executionDelayBars < 0 ||
    !Number.isFinite(scenario.returnShockMultiplier) ||
    scenario.returnShockMultiplier < 0
  ) {
    throw new Error('[Stress] invalid stress scenario');
  }

  // Spread/slippage are represented as a deterministic reduction in absolute
  // return per trade; execution delay is conservatively modeled as additional
  // loss pressure. This is a research stress approximation, not broker replay.
  const friction =
    (scenario.spreadMultiplier + scenario.slippageMultiplier) * 0.0001;
  const delayPenalty = scenario.executionDelayBars * 0.0002;

  const stressedTrades = returns.map(value => {
    const direction = value >= 0 ? 1 : -1;
    const stressed = value * scenario.returnShockMultiplier;

    return stressed
      - friction * direction
      - delayPenalty;
  });

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const value of stressedTrades) {
    equity += value;
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdown = Math.max(
        maxDrawdown,
        (peak - equity) / peak,
      );
    }
  }

  return {
    scenario: scenario.name,
    stressedTrades,
    endingReturn: equity,
    maxDrawdown,
  };
}
