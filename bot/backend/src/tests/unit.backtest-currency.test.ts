import { getMarketDefinition } from '../market/MarketCatalog';
import { resolveHistoricalQuoteToAccount } from '../market/HistoricalCurrencySeries';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const eurGbp = getMarketDefinition('EURGBP');
assert(eurGbp?.quoteCurrency === 'GBP', 'EURGBP must expose GBP as quote currency');

const timestamp = 1_000_000;
const rates = {
  GBPUSD: [{ time: timestamp, rate: 1.25 }],
};

assert(
  resolveHistoricalQuoteToAccount('GBP', 'USD', timestamp, {}) === null,
  'Backtest conversion must block when historical FX is missing',
);

const converted = resolveHistoricalQuoteToAccount('GBP', 'USD', timestamp, rates);
assert(converted === 1.25, 'Backtest conversion must use the historical GBPUSD rate');

const usd = getMarketDefinition('EURUSD');
assert(usd?.quoteCurrency === 'USD', 'EURUSD quote must be USD');
assert(
  resolveHistoricalQuoteToAccount('USD', 'USD', timestamp, {}) === 1,
  'USD account/quote must remain identity conversion',
);

console.log('Result: 6 passed, 0 failed');
