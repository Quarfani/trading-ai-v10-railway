import { getSymbolSpec } from '../config/symbolConfig';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

process.env.SPEC_EURUSD_H1_ATR_MULT = '2.5';
process.env.SPEC_EURUSD_M5_ATR_MULT = '0.8';

assert(getSymbolSpec('EURUSD', 'H1').atrMult === 2.5, 'H1 override must be applied');
assert(getSymbolSpec('EURUSD', 'M5').atrMult === 0.8, 'M5 override must be isolated');
assert(getSymbolSpec('EURUSD', 'M15').atrMult === 1.5, 'unconfigured timeframe must use base');
delete process.env.SPEC_EURUSD_H1_ATR_MULT;
delete process.env.SPEC_EURUSD_M5_ATR_MULT;

console.log('Result: 3 passed, 0 failed');
