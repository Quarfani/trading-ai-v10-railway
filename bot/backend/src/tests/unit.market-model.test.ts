/**
 * Unit tests for the cross-asset market domain foundation.
 */
import {
  calculateExposureInAccount,
  calculateNotionalInQuote,
  calculateRequiredMargin,
  calculateStopRiskInAccount,
} from '../market/MarketEconomics';
import { getMarketDefinition, requireMarketDefinition } from '../market/MarketCatalog';
import { TIMEFRAME_MS, isTimeframe } from '../market/market.types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function approx(actual: number, expected: number, tolerance = 1e-9): void {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected}, got ${actual}`,
  );
}

console.log('Market model tests');

assert(isTimeframe('H1'), 'H1 must be a valid timeframe');
assert(!isTimeframe('H2'), 'unsupported timeframe must be rejected');
assert(TIMEFRAME_MS.H4 === 14_400_000, 'H4 duration must be 4 hours');

approx(
  calculateNotionalInQuote({
    price: 1.1,
    volume: 1,
    contractSize: 100_000,
  }),
  110_000,
);

approx(
  calculateStopRiskInAccount({
    stopDistance: 0.001,
    volume: 1,
    contractSize: 100_000,
    quoteToAccount: 1.25,
  }),
  125,
);

approx(
  calculateExposureInAccount({
    price: 2_000,
    volume: 1,
    contractSize: 100,
    quoteToAccount: 1,
  }),
  200_000,
);

approx(
  calculateRequiredMargin({
    exposureInAccountCurrency: 30_000,
    leverage: 3,
  }),
  10_000,
);

const eurusd = requireMarketDefinition('EURUSD');
assert(eurusd.assetClass === 'FOREX', 'EURUSD must be classified as FOREX');
assert(eurusd.baseAsset === 'EUR', 'EURUSD base asset mismatch');
assert(eurusd.quoteCurrency === 'USD', 'EURUSD quote mismatch');
assert(eurusd.economics.contractSize === 100_000, 'EURUSD contract size mismatch');

const xau = requireMarketDefinition('XAUUSD');
assert(xau.assetClass === 'METAL', 'XAUUSD must be classified as METAL');
assert(xau.economics.contractSize === 100, 'XAUUSD contract size mismatch');

assert(getMarketDefinition('USOIL') === null, 'Oil must not inherit an unsafe generic contract definition');
assert(getMarketDefinition('NOTAREALSYMBOL') === null, 'unknown symbols must fail closed');

console.log('Result: 12 passed, 0 failed');
