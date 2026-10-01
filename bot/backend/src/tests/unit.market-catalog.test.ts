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

process.env.SPEC_EURUSD_H1_MIN_VOLUME = '0.01';
process.env.SPEC_EURUSD_M5_MIN_VOLUME = '0.07';
assert(
  getMarketDefinition('EURUSD', 'H1')?.economics.minVolume === 0.01,
  'H1 market economics must use H1 static volume override',
);
assert(
  getMarketDefinition('EURUSD', 'M5')?.economics.minVolume === 0.07,
  'M5 market economics must use M5 static volume override',
);
delete process.env.SPEC_EURUSD_H1_MIN_VOLUME;
delete process.env.SPEC_EURUSD_M5_MIN_VOLUME;

console.log('Result: 8 passed, 0 failed');
