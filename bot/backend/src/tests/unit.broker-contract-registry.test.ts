import { BrokerContractRegistry, toMarketDefinition } from '../market/BrokerContractRegistry';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
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

let expiryRejected = false;
try {
  registry.register({ ...verified, symbol:'EXPIREDOIL', expiresAt:Date.now() - 1 });
} catch {
  expiryRejected = true;
}
assert(expiryRejected, 'expired broker contract must be rejected at registration');

registry.register({ ...verified, symbol:'TEMP_OIL', expiresAt:Date.now() + 10 });
await new Promise(resolve => setTimeout(resolve, 25));
assert(registry.get('TEMP_OIL') === null, 'expired contract must be removed on read');

const now = Date.now();
registry.clear();

registry.register({
  ...verified,
  symbol: 'EURUSD.a',
  source: 'mt5',
  contractSize: 100000,
  observedAt: now,
});
registry.register({
  ...verified,
  symbol: 'EURUSD.a',
  source: 'mt5',
  contractSize: 1,
  observedAt: now - 1000,
});
assert(
  registry.getMarketDefinition('EURUSD.a')?.economics.contractSize === 100000,
  'older same-source broker metadata must not overwrite newer economics',
);
assert(
  registry.getMarketDefinition('EURUSD.a')?.brokerSymbol === 'EURUSD.a',
  'broker symbol casing must be preserved exactly for MT5 lookup',
);

let chronologyRejected = false;
try {
  registry.register({
    ...verified,
    symbol: 'BADCHRONO',
    observedAt: now + 200,
    expiresAt: now + 100,
  });
} catch {
  chronologyRejected = true;
}
assert(
  chronologyRejected,
  'broker contract expiry must be later than observedAt',
);

console.log('Result: 9 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
