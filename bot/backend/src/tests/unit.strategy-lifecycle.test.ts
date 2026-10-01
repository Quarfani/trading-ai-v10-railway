import { canTransition, hasPromotionEvidence, promoteStrategy } from '../consensus/StrategyLifecycle';
import { StrategyDefinition } from '../consensus/strategyDefinition';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const definition: StrategyDefinition = {
  strategyId: 'test.trend',
  name: 'Test Trend',
  version: '1.0.0',
  enabled: true,
  lifecycle: 'RESEARCH',
  scope: {
    assetClasses: ['FOREX'],
    symbols: ['EURUSD'],
    timeframes: ['H1'],
    regimes: ['TRENDING'],
    sessions: ['LONDON'],
  },
  requiredData: ['OHLCV'],
  parametersVersion: 'params-1',
  riskProfile: {
    baseRiskFraction: 0.01,
    minimumRiskReward: 1.5,
    maximumDrawdown: 0.20,
  },
  evidence: {
    datasetVersion: 'dataset-1',
    costModelVersion: 'cost-v1',
    sampleSize: 300,
    outOfSampleTrades: 220,
    outOfSampleProfitFactor: 1.7,
    walkForwardStability: 0.81,
    parameterSensitivity: 0.74,
    regimeCoverage: 0.80,
    passed: true,
    evaluatedAt: Date.now(),
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

assert(canTransition('RESEARCH', 'BACKTEST'), 'RESEARCH -> BACKTEST should be allowed');
assert(!canTransition('RESEARCH', 'PRODUCTION'), 'RESEARCH -> PRODUCTION must be blocked');
assert(hasPromotionEvidence(definition), 'complete evidence should pass');
assert(
  !hasPromotionEvidence(definition, {
    minSampleSize: 500,
    minOutOfSampleTrades: 300,
    minOutOfSampleProfitFactor: 2.0,
    minWalkForwardStability: 0.9,
    minParameterSensitivity: 0.9,
    minRegimeCoverage: 0.9,
    maxAgeMs: 30 * 24 * 3_600_000,
  }),
  'stricter evidence policy must block insufficient evidence',
);

const backtested = promoteStrategy(definition, 'BACKTEST', 'backtest contract created').definition;
const paperspec = { ...backtested, lifecycle: 'MONTE_CARLO' as const };
const paper = promoteStrategy(paperspec, 'PAPER', 'evidence gate passed').definition;
assert(paper.lifecycle === 'PAPER', 'MONTE_CARLO -> PAPER should be allowed');

let blocked = false;
try {
  promoteStrategy({ ...definition, lifecycle: 'VALIDATION', evidence: undefined }, 'PAPER', 'should fail');
} catch {
  blocked = true;
}
assert(blocked, 'promotion without evidence must fail');

const noMonteCarlo = {
  ...definition,
  lifecycle: 'SMALL_CAPITAL' as const,
  evidence: {
    ...definition.evidence!,
    outOfSampleTrades: 220,
    outOfSampleProfitFactor: 1.6,
    walkForwardStability: 0.70,
    parameterSensitivity: 0.70,
    regimeCoverage: 0.70,
  },
};
let productionBlocked = false;
try {
  promoteStrategy(
    noMonteCarlo,
    'PRODUCTION',
    'production must require hardened evidence',
  );
} catch {
  productionBlocked = true;
}
assert(
  productionBlocked,
  'PRODUCTION must require both the larger OOS sample and Monte Carlo stress evidence',
);

const productionReady = {
  ...definition,
  lifecycle: 'SMALL_CAPITAL' as const,
  evidence: {
    ...definition.evidence!,
    sampleSize: 400,
    outOfSampleTrades: 320,
    outOfSampleProfitFactor: 1.7,
    walkForwardStability: 0.75,
    parameterSensitivity: 0.72,
    regimeCoverage: 0.76,
    monteCarloStress: {
      simulations: 2000,
      futureTrades: 200,
      p5FinalBalance: 8500,
      p50FinalBalance: 11200,
      maxDDP95: 0.24,
      probabilityLoss: 0.25,
      probabilityDD20: 0.40,
      probabilityRuin: 0.01,
      unrecoveredRate: 0.10,
      recoveryTradesP95: 35,
    },
  },
};
const production = promoteStrategy(
  productionReady,
  'PRODUCTION',
  'production evidence gate passed',
).definition;
assert(production.lifecycle === 'PRODUCTION', 'hardened production evidence should allow promotion');

console.log('Result: 10 passed, 0 failed');
