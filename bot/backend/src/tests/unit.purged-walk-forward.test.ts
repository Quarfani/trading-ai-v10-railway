import {
  buildPurgedWalkForwardFolds,
  evaluatePurgedWalkForward,
  hasTemporalLeakage,
  ResearchObservation,
} from '../research/PurgedWalkForward';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const observations: ResearchObservation<number>[] =
  Array.from({ length: 30 }, (_, i) => ({
    startTime: i * 100,
    endTime: i * 100 + 90,
    value: i,
  }));

const built = buildPurgedWalkForwardFolds(observations, {
  trainSize: 10,
  validationSize: 5,
  stepSize: 5,
  purgeMs: 120,
  embargoMs: 80,
  minTrainSize: 8,
});

assert(built.passed, 'enough observations should create WFO folds');
assert(built.folds.length >= 2, 'should create at least two folds');
assert(built.purgedObservations > 0, 'purging should remove observations');
assert(built.validationObservations > 0, 'validation observations should exist');

for (const fold of built.folds) {
  assert(!hasTemporalLeakage(fold), 'training labels must not overlap validation');
  assert(fold.train.at(-1)!.endTime < fold.validationStart, 'train must end before validation');
}

const evaluated = evaluatePurgedWalkForward(
  observations,
  { trainSize: 10, validationSize: 5, stepSize: 5, purgeMs: 100, embargoMs: 50, minTrainSize: 8 },
  (train, validation, foldIndex) => ({
    foldIndex,
    trainMean: train.reduce((s, x) => s + x.value, 0) / train.length,
    validationMean: validation.reduce((s, x) => s + x.value, 0) / validation.length,
  }),
);
assert(evaluated.folds.every(f => f.result != null), 'each fold should be evaluated');

const invalid = buildPurgedWalkForwardFolds(
  [
    { startTime: 100, endTime: 90, value: 1 },
  ],
  { trainSize: 1, validationSize: 1 },
);
assert(!invalid.passed, 'invalid time intervals must fail validation');

console.log('Result: 9 passed, 0 failed');
