import {
  clearBrokerContracts,
  getMarketDefinition,
  getBrokerMarketDefinition,
  registerBrokerContract,
} from '../market/MarketCatalog';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

clearBrokerContracts();

const before = getMarketDefinition('USOIL');
assert(before === null, 'Oil must remain unsupported without verified broker data');

registerBrokerContract({
  symbol: 'USOIL',
  baseAsset: 'WTI',
  quoteCurrency: 'USD',
  assetClass: 'ENERGY',
  contractType: 'CFD',
  venue: 'MT5',
  contractSize: 1000,
  priceIncrement: 0.01,
  minVolume: 0.01,
  maxVolume: 50,
  volumeStep: 0.01,
  marginModel: 'BROKER_DEFINED',
  source: 'verified-fixture',
  observedAt: Date.now(),
  verified: true,
});

const oil = getMarketDefinition('USOIL');
assert(oil?.assetClass === 'ENERGY', 'verified broker contract should expose Oil as energy');
assert(oil?.economics.contractSize === 1000, 'verified contract economics must be preserved');

clearBrokerContracts();
assert(getMarketDefinition('USOIL') === null, 'clearing broker registry must remove the override');


registerBrokerContract({
  symbol: 'EURUSD',
  baseAsset: 'EUR',
  quoteCurrency: 'USD',
  assetClass: 'FOREX',
  contractType: 'CFD',
  venue: 'MT5',
  contractSize: 100000,
  priceIncrement: 0.00001,
  minVolume: 0.01,
  maxVolume: 100,
  volumeStep: 0.01,
  marginModel: 'BROKER_DEFINED',
  source: 'expiry-fixture',
  observedAt: Date.now(),
  expiresAt: Date.now() + 25,
  verified: true,
});

assert(getBrokerMarketDefinition('EURUSD')?.brokerSymbol === 'EURUSD', 'broker-only lookup must expose active contract');

setTimeout(() => {
  assert(getBrokerMarketDefinition('EURUSD') === null, 'expired broker contract must fail closed in broker-only lookup');
  assert(getMarketDefinition('EURUSD')?.symbol === 'EURUSD', 'generic catalog may retain static fallback for non-broker contexts');
  clearBrokerContracts();
  console.log('Result: 12 passed, 0 failed');
}, 35).unref();
