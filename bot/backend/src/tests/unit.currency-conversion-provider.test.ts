import { CurrencyConversionProvider } from '../market/CurrencyConversionProvider';
import { clearBrokerContracts, registerBrokerContract } from '../market/MarketCatalog';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  clearBrokerContracts();
  registerBrokerContract({
    symbol: 'EURUSD.a',
    baseAsset: 'EUR', quoteCurrency: 'USD', assetClass: 'FOREX',
    contractType: 'CFD', venue: 'MT5', contractSize: 100000,
    priceIncrement: 0.00001, minVolume: 0.01, maxVolume: 100,
    volumeStep: 0.01, marginModel: 'BROKER_DEFINED', source: 'provider-fixture',
    observedAt: Date.now(), verified: true,
  });

  const requested: string[] = [];
  const scanner = {
    fetchCandles: async (symbol: string) => {
      requested.push(symbol);
      if (symbol === 'EURUSD.a') return [{ close: 1.10 }];
      return [];
    },
  };

  const provider = new CurrencyConversionProvider(scanner as any, 'EUR');
  const rate = await provider.getRate('USD');
  assert(Math.abs((rate ?? 0) - (1 / 1.10)) < 1e-12, 'provider must resolve USD->EUR through broker-suffixed EURUSD');
  assert(requested[0] === 'EURUSD.A' || requested[0] === 'EURUSD.a', 'provider must try the broker-registered symbol before canonical fallback');

  clearBrokerContracts();
  console.log('Result: 2 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
