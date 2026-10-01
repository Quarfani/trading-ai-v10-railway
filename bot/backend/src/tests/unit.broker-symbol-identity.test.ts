import { clearBrokerContracts, getMarketDefinition, registerBrokerContract } from '../market/MarketCatalog';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

clearBrokerContracts();
registerBrokerContract({
  symbol: 'EURUSD.a', baseAsset: 'EUR', quoteCurrency: 'USD', assetClass: 'FOREX',
  contractType: 'CFD', venue: 'MT5', contractSize: 100000, priceIncrement: 0.00001,
  minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, marginModel: 'BROKER_DEFINED',
  source: 'fixture-a', observedAt: Date.now(), verified: true,
});
registerBrokerContract({
  symbol: 'EURUSD.raw', baseAsset: 'EUR', quoteCurrency: 'USD', assetClass: 'FOREX',
  contractType: 'CFD', venue: 'MT5', contractSize: 1, priceIncrement: 0.00001,
  minVolume: 0.10, maxVolume: 10, volumeStep: 0.10, marginModel: 'BROKER_DEFINED',
  source: 'fixture-raw', observedAt: Date.now(), verified: true,
});

assert(getMarketDefinition('EURUSD.a')?.brokerSymbol === 'EURUSD.a', 'suffix .a must remain part of broker identity');
assert(getMarketDefinition('EURUSD.raw')?.brokerSymbol === 'EURUSD.raw', 'suffix .raw must remain part of broker identity');
assert(getMarketDefinition('EURUSD.a')?.economics.contractSize === 100000, 'suffix .a must retain its economics');
assert(getMarketDefinition('EURUSD.raw')?.economics.contractSize === 1, 'suffix .raw must retain distinct economics');

clearBrokerContracts();
assert(getMarketDefinition('EURUSD.a') === null, 'unknown suffixed MT5 symbol must not inherit static economics');

console.log('Result: 5 passed, 0 failed');
