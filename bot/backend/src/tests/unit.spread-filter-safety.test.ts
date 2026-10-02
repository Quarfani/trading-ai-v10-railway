import { SpreadFilter } from '../risk/SpreadFilter';
import { clearBrokerContracts, registerBrokerContract } from '../market/MarketCatalog';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

clearBrokerContracts();
registerBrokerContract({
  symbol: 'EURUSD',
  baseAsset: 'EUR',
  quoteCurrency: 'USD',
  assetClass: 'FOREX',
  contractType: 'CFD',
  venue: 'MT5',
  contractSize: 100000,
  priceIncrement: 0.00001,
  pipSize: 0.0001,
  minVolume: 0.01,
  maxVolume: 100,
  volumeStep: 0.01,
  marginModel: 'BROKER_DEFINED',
  source: 'spread-test',
  observedAt: Date.now(),
  verified: true,
});

const filter = new SpreadFilter();
const valid = filter.check('EURUSD', 1.1, 1.1001, 'H1', true);
assert(valid.ok, 'valid broker spread should pass');

const nanBid = filter.check('EURUSD', Number.NaN, 1.1001, 'H1', true);
assert(!nanBid.ok, 'NaN bid must fail closed');

const nanAsk = filter.check('EURUSD', 1.1, Number.NaN, 'H1', true);
assert(!nanAsk.ok, 'NaN ask must fail closed');

const crossed = filter.check('EURUSD', 1.1002, 1.1, 'H1', true);
assert(!crossed.ok, 'crossed bid-ask market must fail closed');

clearBrokerContracts();
console.log('Result: 4 passed, 0 failed');
