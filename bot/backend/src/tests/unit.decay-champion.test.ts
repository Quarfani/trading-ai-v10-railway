import { detectStrategyDecay } from '../research/StrategyDecay';
import { evaluateChampionChallenger } from '../research/ChampionChallenger';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const active = detectStrategyDecay({
  totalTrades: 100,
  rollingTrades: 30,
  expectancy: 100,
  rollingExpectancy: 95,
  profitFactor: 1.7,
  rollingProfitFactor: 1.7,
  maxDrawdown: 0.10,
  recentMaxDrawdown: 0.08,
});
assert(active.state === 'ACTIVE', 'stable strategy should remain active');

const paused = detectStrategyDecay({
  totalTrades: 100,
  rollingTrades: 30,
  expectancy: 100,
  rollingExpectancy: -50,
  profitFactor: 1.7,
  rollingProfitFactor: 0.8,
  maxDrawdown: 0.10,
  recentMaxDrawdown: 0.20,
});
assert(paused.state === 'PAUSED', 'severe decay should pause');

const evidence = {
  sampleSize: 500,
  outOfSampleTrades: 300,
  walkForwardStability: 0.9,
  regimeCoverage: 0.9,
  parameterSensitivity: 0.9,
  costAdjustedProfitFactor: 1.9,
  datasetQuality: 0.95,
  leakageChecksPassed: true,
};

const result = evaluateChampionChallenger(
  { strategyId: 'champion', version: '1', evidence },
  {
    strategyId: 'challenger',
    version: '1',
    evidence: { ...evidence, costAdjustedProfitFactor: 1.2 },
  },
);
assert(!result.replace, 'small challenger improvement should not replace');

console.log('Result: 7 passed, 0 failed');
