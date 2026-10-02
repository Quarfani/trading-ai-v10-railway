import { SessionFilter } from '../risk/SessionFilter';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const filter = new SessionFilter();
const now = Date.now();

assert(
  filter.check('TREND', 'EURUSD', now).score >= 0,
  'normal timestamp must return a valid session result',
);

const future = filter.check('TREND', 'EURUSD', now + 60_000);
assert(!future.allowed, 'future session timestamp must block');

const invalid = filter.check('TREND', 'EURUSD', Number.NaN);
assert(!invalid.allowed, 'invalid session timestamp must block');

const emptySymbol = filter.check('TREND', '', now);
assert(!emptySymbol.allowed, 'empty symbol must block');

const saturday = Date.parse('2026-10-03T12:00:00.000Z');
const sundayMorning = Date.parse('2026-10-04T12:00:00.000Z');
assert(
  filter.check('TREND', 'EURUSD', saturday).session === 'DEAD_ZONE',
  'Saturday FX session must be closed',
);
assert(
  !filter.check('TREND', 'EURUSD', sundayMorning).allowed,
  'Sunday morning FX session must be closed',
);

console.log('Result: 6 passed, 0 failed');
