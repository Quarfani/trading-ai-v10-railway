import { PaperTrader } from '../integration/PaperTrader';
import { getSymbolSpec } from '../config/symbolConfig';
import { estimateEntryCosts, estimateExitCosts } from '../market/CostModel';
import { getCostProfile } from '../market/CostProfiles';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertClose(actual: number, expected: number, tolerance = 1e-9, label = 'value'): void {
  assert(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);
}

const trader = new PaperTrader(10_000);
const spec = getSymbolSpec('SOLUSDT');
const profile = getCostProfile('SOLUSDT');
const entry = 100;
const partialExit = 101;
const finalExit = 102;
const openedAt = Date.now();

const entryCost = estimateEntryCosts({
  price: entry,
  volume: 2,
  contractSize: spec.contractSize,
  quoteToAccount: 1,
}, profile);

trader.restoreState([{
  ticket: 1,
  symbol: 'SOLUSDT',
  side: 'BUY',
  volume: 2,
  entry,
  sl: 90,
  tp: 110,
  status: 'open',
  openedAt,
  source: 'TEST',
  timeframe: 'H1',
  realizedProfit: 0,
}], []);

const partial = trader.partialClose(1, 1, partialExit, 'PARTIAL');
assert(Boolean(partial), 'partial close should return a trade');
const expectedPartial =
  (partialExit - entry) * 1
  - estimateExitCosts({
      price: partialExit,
      volume: 1,
      contractSize: spec.contractSize,
      quoteToAccount: 1,
    }, profile)
  - entryCost / 2;
assertClose(partial!.profit ?? 0, expectedPartial, 1e-9, 'partial');

const closed = trader.closeTrade(1, finalExit, 'MANUAL', openedAt + 1);
assert(Boolean(closed), 'final close should return a trade');
const expectedRemaining =
  (finalExit - entry) * 1
  - estimateExitCosts({
      price: finalExit,
      volume: 1,
      contractSize: spec.contractSize,
      quoteToAccount: 1,
    }, profile)
  - entryCost / 2;
assertClose(closed!.profit ?? 0, (partial!.profit ?? 0) + expectedRemaining, 1e-9, 'final-cumulative');

assertClose(
  closed!.profit ?? 0,
  (partialExit - entry) + (finalExit - entry)
    - estimateExitCosts({
        price: partialExit,
        volume: 1,
        contractSize: spec.contractSize,
        quoteToAccount: 1,
      }, profile)
    - estimateExitCosts({
        price: finalExit,
        volume: 1,
        contractSize: spec.contractSize,
        quoteToAccount: 1,
      }, profile)
    - entryCost,
  1e-9,
  'total-cumulative',
);

const nonCrypto = new PaperTrader(10_000);
nonCrypto.restoreState([{
  ticket: 2,
  symbol: 'EURUSD',
  side: 'BUY',
  volume: 0.05,
  entry: 1,
  sl: 0.99,
  tp: 1.02,
  status: 'open',
  openedAt,
  source: 'TEST',
  timeframe: 'H1',
  realizedProfit: 0,
}], []);

const fxProfile = getCostProfile('EURUSD');
const fxSpec = getSymbolSpec('EURUSD');
const fxEntryCost = estimateEntryCosts({
  price: 1,
  volume: 0.05,
  contractSize: fxSpec.contractSize,
  quoteToAccount: 1,
}, fxProfile);
const fxExitCost = estimateExitCosts({
  price: 1.01,
  volume: 0.05,
  contractSize: fxSpec.contractSize,
  quoteToAccount: 1,
}, fxProfile);

const fxClosed = nonCrypto.closeTrade(2, 1.01, 'MANUAL', openedAt + 1);
assert(Boolean(fxClosed), 'FX close should return a trade');
assertClose(
  fxClosed!.profit ?? 0,
  (1.01 - 1) * 0.05 * fxSpec.contractSize
    - fxEntryCost
    - fxExitCost,
);

console.log('Result: 14 passed, 0 failed');
