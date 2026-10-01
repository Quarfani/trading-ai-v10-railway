import { evaluateStrategyEligibility } from '../consensus/StrategyEligibility';
import { StrategyDefinition } from '../consensus/strategyDefinition';
import { StrategyContext } from '../consensus/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const definition: StrategyDefinition = {
  strategyId: 'scope.test',
  name: 'Scope Test',
  version: '1.0.0',
  enabled: true,
  lifecycle: 'PAPER',
  scope: {
    assetClasses: ['FOREX'],
    symbols: ['EURUSD'],
    timeframes: ['H1'],
    regimes: ['TRENDING'],
    sessions: [],
  },
  requiredData: ['OHLCV'],
  parametersVersion: 'p1',
  riskProfile: { baseRiskFraction: 0.01, minimumRiskReward: 1.5, maximumDrawdown: 0.20 },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
const ctx: StrategyContext = {
  symbol: 'EURUSD',
  timeframe: 'H1',
  candles: [],
  h4Candles: [],
  regime: 'TRENDING',
  timestamp: Date.now(),
};

assert(evaluateStrategyEligibility(definition, ctx).allowed, 'matching scope should pass');
assert(!evaluateStrategyEligibility(definition, { ...ctx, timeframe: 'M5' }).allowed, 'wrong timeframe must block');
assert(!evaluateStrategyEligibility(definition, { ...ctx, symbol: 'XAUUSD' }).allowed, 'wrong symbol must block');
assert(evaluateStrategyEligibility(undefined, ctx).allowed, 'legacy definition remains compatible');
assert(!evaluateStrategyEligibility({ ...definition, enabled: false }, ctx).allowed, 'disabled definition must block');

console.log('Result: 10 passed, 0 failed');
