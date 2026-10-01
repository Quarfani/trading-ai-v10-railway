import { isConfiguredSymbol } from '../config/symbolConfig';
import { getMarketDefinition } from '../market/MarketCatalog';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(isConfiguredSymbol('BTCUSDT'), 'configured BTC should be known');
assert(isConfiguredSymbol('EURGBP'), 'configured EURGBP should be known');
assert(!isConfiguredSymbol('NOTREAL'), 'unknown symbol must not be considered configured');

assert(getMarketDefinition('BTCUSDT')?.assetClass === 'CRYPTO', 'BTC must classify as crypto');
assert(getMarketDefinition('EURGBP')?.assetClass === 'FOREX', 'EURGBP must classify as forex');
assert(getMarketDefinition('NOTREAL') === null, 'unknown symbol must fail closed');

console.log('Result: 6 passed, 0 failed');
