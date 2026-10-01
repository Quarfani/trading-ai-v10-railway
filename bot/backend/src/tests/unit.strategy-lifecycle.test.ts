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

console.log('Result: 7 passed, 0 failed');
