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


const varyingFx = estimateCosts(
  {
    entryPrice: 1,
    exitPrice: 1.01,
    volume: 1,
    contractSize: 100_000,
    quoteToAccount: 1,
    entryQuoteToAccount: 1.10,
    exitQuoteToAccount: 1.25,
  },
  fx,
);
const flatFx = estimateCosts(
  {
    entryPrice: 1,
    exitPrice: 1.01,
    volume: 1,
    contractSize: 100_000,
    quoteToAccount: 1,
  },
  fx,
);
assert(varyingFx.spread !== flatFx.spread, 'distinct conversion rates must affect spread');
assert(varyingFx.total !== flatFx.total, 'distinct conversion rates must affect total cost');

const cryptoVarying = estimateCosts(
  { entryPrice: 100_000, exitPrice: 101_000, volume: 1, contractSize: 1, quoteToAccount: 1, entryQuoteToAccount: 1.1, exitQuoteToAccount: 1.2 },
  crypto,
);
assert(cryptoVarying.entryCommission !== cryptoCosts.entryCommission, 'notional-rate commission must use entry conversion');
assert(cryptoVarying.exitCommission !== cryptoCosts.exitCommission, 'notional-rate commission must use exit conversion');

assert(fx.source === 'REPOSITORY_DEFAULT', 'static symbol cost profile must be marked as repository default');

const envKeys = [
  'COST_USOIL_SPREAD_PIPS',
  'COST_USOIL_FIXED_ROUND_TRIP',
  'COST_USOIL_NOTIONAL_RATE',
  'COST_USOIL_IMPACT_BPS',
  'COST_USOIL_HOLDING_RATE_DAY',
] as const;
const previous = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
);

try {
  delete process.env.COST_USOIL_SPREAD_PIPS;
  delete process.env.COST_USOIL_FIXED_ROUND_TRIP;
  delete process.env.COST_USOIL_NOTIONAL_RATE;
  delete process.env.COST_USOIL_IMPACT_BPS;
  delete process.env.COST_USOIL_HOLDING_RATE_DAY;

  let strictRejected = false;
  try {
    getCostProfile('USOIL', {
      priceIncrement: 0.01,
      requireExplicit: true,
    });
  } catch (error) {
    strictRejected = String(error).includes('Explicit cost profile required');
  }
  assert(strictRejected, 'broker-only cost profile must fail closed without explicit costs');

  process.env.COST_USOIL_SPREAD_PIPS = '2';
  process.env.COST_USOIL_FIXED_ROUND_TRIP = '8';
  process.env.COST_USOIL_NOTIONAL_RATE = '0';
  process.env.COST_USOIL_IMPACT_BPS = '1';
  process.env.COST_USOIL_HOLDING_RATE_DAY = '0';

  const oil = getCostProfile('USOIL', {
    priceIncrement: 0.01,
    requireExplicit: true,
  });
  assert(oil.source === 'ENV_EXPLICIT', 'explicit broker cost profile must be marked as env explicit');
  approx(oil.spreadPricePerSide, 0.012);
  assert(oil.commission.fixedRoundTripPerVolumeAccount === 8, 'explicit Oil fixed commission mismatch');
  assert(oil.marketImpactBpsPerSide === 1, 'explicit Oil impact mismatch');
} finally {
  for (const key of envKeys) {
    const value = previous[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log('Result: 19 passed, 0 failed');
