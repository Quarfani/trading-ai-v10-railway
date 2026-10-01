import { BrokerContractRegistry, toMarketDefinition } from '../market/BrokerContractRegistry';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const registry = new BrokerContractRegistry();

const unverified = {
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
  source: 'test',
  observedAt: Date.now(),
  verified: false,
};

let rejected = false;
try {
  toMarketDefinition(unverified);
} catch {
  rejected = true;
}
assert(rejected, 'unverified energy contract must be rejected');

const verified = {
  ...unverified,
  verified: true,
  source: 'broker-contract-fixture',
};
registry.register(verified);
assert(registry.hasVerified('USOIL'), 'verified contract should register');
assert(
  registry.getMarketDefinition('USOIL')?.assetClass === 'ENERGY',
  'registered energy contract should preserve asset class',
);

registry.clear();
assert(!registry.hasVerified('USOIL'), 'cleared registry must not retain contract');

registry.register({ ...verified, symbol:'EXPIREDOIL', expiresAt:Date.now() - 1 });
assert(
  registry.get('EXPIREDOIL') === null,
  'expired broker contract must fail closed on read',
);

registry.register({ ...verified, symbol:'TEMP_OIL', expiresAt:Date.now() + 1 });
while (registry.get('TEMP_OIL')?.expiresAt != null) {}
assert(registry.get('TEMP_OIL') === null, 'expired contract must be removed on read');

console.log('Result: 6 passed, 0 failed');
