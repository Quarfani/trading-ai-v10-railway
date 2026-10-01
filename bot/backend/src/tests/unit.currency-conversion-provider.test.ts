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

  const bridgeRequested: string[] = [];
  const bridgeScanner = {
    fetchCandles: async (symbol: string) => {
      bridgeRequested.push(symbol);
      if (symbol === 'GBPUSD') return [{ close: 1.25 }];
      if (symbol === 'USDJPY') return [{ close: 150 }];
      return [];
    },
  };

  const bridgeProvider = new CurrencyConversionProvider(bridgeScanner as any, 'JPY');
  const bridgeRate = await bridgeProvider.getRate('GBP');
  assert(
    Math.abs((bridgeRate ?? 0) - (1.25 * 150)) < 1e-9,
    'provider must resolve GBP->JPY through GBPUSD × USDJPY when direct GBPJPY is unavailable',
  );
  assert(
    bridgeRequested.includes('GBPUSD') && bridgeRequested.includes('USDJPY'),
    'provider must collect both USD bridge legs before resolving a cross-currency conversion',
  );

  clearBrokerContracts();
  console.log('Result: 4 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
