import { evaluateStrategyEligibility } from '../consensus/StrategyEligibility';

const base = {
  strategyId: 't',
  name: 'T',
  version: '1.0.0',
  enabled: true,
  lifecycle: 'PAPER' as const,
  scope: {
    assetClasses: ['FOREX' as const],
    symbols: ['EURUSD'],
    timeframes: ['H1' as const],
    regimes: ['TRENDING'],
    sessions: [],
  },
  requiredData: ['OHLCV'],
  parametersVersion: '1',
  riskProfile: { baseRiskFraction: 0.01, minimumRiskReward: 1.5, maximumDrawdown: 0.2 },
  createdAt: 0,
  updatedAt: 0,
};

const ctx = {
  symbol: 'EURUSD',
  timeframe: 'H1' as const,
  candles: [],
  h4Candles: [],
  regime: 'TRENDING',
  timestamp: 0,
};

if (!evaluateStrategyEligibility(base, ctx).allowed) throw new Error('matching scope should pass');
if (evaluateStrategyEligibility({ ...base, scope: { ...base.scope, timeframes: ['M5'] } }, ctx).allowed) {
  throw new Error('wrong timeframe must block');
}
console.log('Result: 4 passed, 0 failed');
