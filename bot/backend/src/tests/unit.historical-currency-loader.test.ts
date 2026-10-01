import { loadHistoricalCurrencySeries } from '../market/HistoricalCurrencySeriesLoader';
import { resolveHistoricalQuoteToAccount } from '../market/HistoricalCurrencySeries';

async function main() {
  function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }

  const direct = await loadHistoricalCurrencySeries(
    'GBP',
    'USD',
    async (symbol) =>
      symbol === 'GBPUSD'
        ? [
            { time: 2000, close: 1.25 },
            { time: 1000, close: 1.20 },
          ]
        : [],
  );

  assert(
    Object.keys(direct)[0] === 'GBPUSD',
    'direct pair should be preferred',
  );
  assert(
    resolveHistoricalQuoteToAccount('GBP', 'USD', 86_402_000, direct) === 1.25,
    'loaded direct series must resolve historically',
  );

  const inverse = await loadHistoricalCurrencySeries(
    'JPY',
    'USD',
    async (symbol) =>
      symbol === 'USDJPY'
        ? [{ time: 1000, close: 150 }]
        : [],
  );

  assert(
    resolveHistoricalQuoteToAccount('JPY', 'USD', 86_401_000, inverse) === 1 / 150,
    'inverse pair should be inverted',
  );

  const missing = await loadHistoricalCurrencySeries(
    'EUR',
    'USD',
    async () => [],
  );
  assert(
    Object.keys(missing).length === 0,
    'missing pair must fail closed',
  );

  const identity = await loadHistoricalCurrencySeries(
    'USD',
    'USD',
    async () => {
      throw new Error('must not fetch identity conversion');
    },
  );
  assert(
    Object.keys(identity).length === 0,
    'identity conversion requires no market fetch',
  );

  console.log('Result: 8 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
