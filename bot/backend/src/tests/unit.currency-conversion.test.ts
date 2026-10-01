import { resolveQuoteToAccount } from '../market/CurrencyConverter';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function approx(actual: number, expected: number) {
  assert(Math.abs(actual - expected) < 1e-12, 'expected ' + expected + ', got ' + actual);
}

approx(resolveQuoteToAccount('GBP', 'USD', { GBPUSD: 1.25 }) ?? 0, 1.25);
approx(resolveQuoteToAccount('JPY', 'USD', { USDJPY: 150 }) ?? 0, 1 / 150);
assert(resolveQuoteToAccount('GBP', 'USD', {}) === null, 'missing conversion must fail closed');

console.log('Result: 6 passed, 0 failed');
