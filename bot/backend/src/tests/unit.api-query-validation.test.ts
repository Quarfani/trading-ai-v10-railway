import { boundedQueryNumber, parseTimeframeQuery } from '../api/queryValidation';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main(): void {
  let passed = 0;
  const check = (condition: unknown, message: string) => {
    assert(condition, message);
    passed += 1;
  };

  check(boundedQueryNumber('NaN', 50, 1, 500) === 50, 'NaN must use the safe default');
  check(boundedQueryNumber('Infinity', 50, 1, 500) === 50, 'Infinity must use the safe default');
  check(boundedQueryNumber(['250', '999'], 50, 1, 500) === 250, 'array query values must use the first item');
  check(boundedQueryNumber('-4', 50, 1, 500) === 1, 'numeric query values must be clamped to the minimum');
  check(boundedQueryNumber('9999', 50, 1, 500) === 500, 'numeric query values must be clamped to the maximum');
  check(boundedQueryNumber('15.9', 50, 1, 500) === 15, 'integer query values must be truncated');
  check(boundedQueryNumber('', 50, 1, 500) === 50, 'empty query values must use the safe default');
  check(boundedQueryNumber({}, 50, 1, 500) === 50, 'nested query objects must use the safe default');
  check(boundedQueryNumber('0', 1, 0.1, 48, false) === 0.1, 'hours must obey the non-integer lower bound');
  check(boundedQueryNumber('48.5', 1, 0.1, 48, false) === 48, 'hours must obey the upper bound');
  check(parseTimeframeQuery(undefined) === 'H1', 'omitted timeframe must use the default');
  check(parseTimeframeQuery('H4') === 'H4', 'valid timeframe must be accepted');
  check(parseTimeframeQuery('m15') === 'M15', 'timeframe parsing must normalize case');
  check(parseTimeframeQuery('D2') === null, 'invalid timeframe must be rejected');
  check(parseTimeframeQuery(['H1', 'D1']) === 'H1', 'array timeframe must use the first value');
  check(parseTimeframeQuery(4) === null, 'non-string timeframe values must be rejected');

  console.log(`Result: ${passed} passed, 0 failed`);
}

main();
