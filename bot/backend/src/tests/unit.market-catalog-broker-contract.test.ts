import {
  clearBrokerContracts,
  getMarketDefinition,
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


console.log('Result: 10 passed, 0 failed');
