import { StaleDataGuard } from '../core/StaleDataGuard';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const guard = new StaleDataGuard();
const now = Date.now();

const fresh = guard.isFresh([
  { time: now - 60_000 } as any,
], 'M1');
assert(fresh.ok, 'fresh candle must pass');

const future = guard.isFresh([
  { time: now + 60_000 } as any,
], 'M1');
assert(!future.ok, 'future candle must fail closed');

const invalid = guard.isFresh([
  { time: Number.NaN } as any,
], 'M1');
assert(!invalid.ok, 'invalid candle timestamp must fail closed');

const stale = guard.isFresh([
  { time: now - 10 * 60_000 } as any,
], 'M1');
assert(!stale.ok, 'overly stale candle must fail');

console.log('Result: 4 passed, 0 failed');
