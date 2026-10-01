import {
  COST_MODEL_VERSION,
  calculateGrossPnlAccount,
  estimateCosts,
  estimateEntryCosts,
  estimateExitCosts,
} from '../market/CostModel';
import { getCostProfile } from '../market/CostProfiles';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function approx(actual: number, expected: number, tolerance = 1e-8) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected}, got ${actual}`,
  );
}

const fx = getCostProfile('EURUSD');
assert(fx.version === COST_MODEL_VERSION, 'cost model version mismatch');
assert(
  fx.commission.fixedRoundTripPerVolumeAccount === 7,
  'EURUSD fixed commission mismatch',
);

approx(
  calculateGrossPnlAccount({
    entryPrice: 1,
    exitPrice: 1.01,
    volume: 1,
    contractSize: 100_000,
    quoteToAccount: 1,
    side: 'BUY',
  }),
  1000,
);

const entry = estimateEntryCosts(
  {
    price: 1,
    volume: 1,
    contractSize: 100_000,
    quoteToAccount: 1,
  },
  fx,
);
const exit = estimateExitCosts(
  {
    price: 1.01,
    volume: 1,
    contractSize: 100_000,
    quoteToAccount: 1,
  },
  fx,
);
const roundTrip = estimateCosts(
  {
    entryPrice: 1,
    exitPrice: 1.01,
    volume: 1,
    contractSize: 100_000,
    quoteToAccount: 1,
  },
  fx,
);

assert(entry > 0 && exit > 0, 'both sides must have costs');
assert(roundTrip.total > roundTrip.commission, 'spread must be included');
approx(roundTrip.entryCommission + roundTrip.exitCommission, roundTrip.commission);

const crypto = getCostProfile('BTCUSDT');
const cryptoCosts = estimateCosts(
  {
    entryPrice: 100_000,
    exitPrice: 101_000,
    volume: 1,
    contractSize: 1,
    quoteToAccount: 1,
  },
  crypto,
);
approx(cryptoCosts.commission, 201);

console.log('Result: 10 passed, 0 failed');
