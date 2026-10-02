import { PortfolioHeat } from '../risk/PortfolioHeat';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function cfg(maxPortfolioHeat?: number) {
  return {
    mode: 'paper',
    accountCurrency: 'USD',
    accountBalance: 100_000,
    maxPortfolioHeat,
  } as any;
}

const trade = {
  symbol: 'EURUSD',
  volume: 1,
  entry: 1,
  sl: 0.99,
  tp: 1.02,
  side: 'BUY',
  status: 'open',
  openedAt: Date.now(),
  timeframe: 'H1',
};

const allowed = new PortfolioHeat(cfg(0.06)).check(
  [],
  1,
  1,
  0.99,
  'EURUSD',
  100_000,
  { EURUSD: 1 },
  'H1',
);
assert(allowed.allowed, 'valid portfolio heat inputs should be accepted');
assert(Math.abs(allowed.addedRisk - 0.0001) < 1e-12, 'EURUSD stop risk should use contract economics');

const blocked = new PortfolioHeat(cfg(0.00005)).check(
  [],
  1,
  1,
  0.99,
  'EURUSD',
  100_000,
  { EURUSD: 1 },
  'H1',
);
assert(!blocked.allowed, 'heat above configured cap must block');

const invalidMax = new PortfolioHeat(cfg(Number.NaN)).check(
  [],
  1,
  1,
  0.99,
  'EURUSD',
  100_000,
  { EURUSD: 1 },
  'H1',
);
assert(!invalidMax.allowed, 'NaN MAX_PORTFOLIO_HEAT must fail closed');

const invalidInput = new PortfolioHeat(cfg(0.06)).check(
  [],
  0,
  1,
  0.99,
  'EURUSD',
  100_000,
  { EURUSD: 1 },
  'H1',
);
assert(!invalidInput.allowed, 'non-positive proposed volume must fail closed');

const missingFx = new PortfolioHeat(cfg(0.06)).check(
  [trade as any],
  1,
  1,
  0.99,
  'EURGBP',
  100_000,
  {},
  'H1',
);
assert(!missingFx.allowed, 'missing FX conversion must fail closed');

console.log('Result: 9 passed, 0 failed');
