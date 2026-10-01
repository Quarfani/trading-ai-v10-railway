/**
 * PURGED / EMBARGOED WALK-FORWARD VALIDATOR
 *
 * Research-only validation utility. It enforces temporal separation between
 * train and validation observations to reduce look-ahead and label-overlap
 * leakage.
 */
export interface ResearchObservation<T = unknown> {
  startTime: number;
  endTime: number;
  value: T;
}

export interface WfoFold<T = unknown, R = unknown> {
  index: number;
  train: ResearchObservation<T>[];
  validation: ResearchObservation<T>[];
  result?: R;
  purgedCount: number;
  embargoMs: number;
  validationStart: number;
  validationEnd: number;
}

export interface PurgedWalkForwardOptions {
  trainSize: number;
  validationSize: number;
  stepSize?: number;
  purgeMs?: number;
  embargoMs?: number;
  minTrainSize?: number;
}

export interface PurgedWalkForwardResult<T = unknown, R = unknown> {
  folds: WfoFold<T, R>[];
  totalObservations: number;
  purgedObservations: number;
  validationObservations: number;
  passed: boolean;
  reason: string;
}

function validObservation<T>(
  observation: ResearchObservation<T>,
): boolean {
  return (
    Number.isFinite(observation.startTime) &&
    Number.isFinite(observation.endTime) &&
    observation.endTime >= observation.startTime
  );
}

function sortObservations<T>(
  observations: ResearchObservation<T>[],
): ResearchObservation<T>[] {
  return [...observations].sort((a, b) => {
    if (a.startTime !== b.startTime) return a.startTime - b.startTime;
    return a.endTime - b.endTime;
  });
}

export function buildPurgedWalkForwardFolds<T>(
  observations: ResearchObservation<T>[],
  options: PurgedWalkForwardOptions,
): PurgedWalkForwardResult<T> {
  const trainSize = Math.floor(options.trainSize);
  const validationSize = Math.floor(options.validationSize);
  const stepSize = Math.floor(options.stepSize ?? validationSize);
  const purgeMs = Math.max(0, options.purgeMs ?? 0);
  const embargoMs = Math.max(0, options.embargoMs ?? 0);
  const minTrainSize = Math.floor(options.minTrainSize ?? trainSize);

  if (
    trainSize < 1 ||
    validationSize < 1 ||
    stepSize < 1 ||
    minTrainSize < 1
  ) {
    throw new Error('[WFO] window sizes must be positive');
  }

  const sorted = sortObservations(observations);
  const invalid = sorted.filter(item => !validObservation(item));
  if (invalid.length) {
    return {
      folds: [],
      totalObservations: sorted.length,
      purgedObservations: 0,
      validationObservations: 0,
      passed: false,
      reason: `Invalid observations: ${invalid.length}`,
    };
  }

  const folds: WfoFold<T>[] = [];
  let purgedObservations = 0;
  let validationObservations = 0;

  for (
    let validationStartIndex = trainSize;
    validationStartIndex + validationSize <= sorted.length;
    validationStartIndex += stepSize
  ) {
    const validation = sorted.slice(
      validationStartIndex,
      validationStartIndex + validationSize,
    );

    const validationStart = validation[0].startTime;
    const validationEnd =
      validation[validation.length - 1].endTime;

    // Training must end before both the purge boundary and embargo boundary.
    const temporalCutoff = Math.min(
      validationStart - purgeMs,
      validationStart - embargoMs,
    );

    const candidates = sorted.slice(0, validationStartIndex);
    const train = candidates.filter(
      observation => observation.endTime < temporalCutoff,
    );

    const purgedCount = candidates.length - train.length;

    if (train.length < minTrainSize) continue;

    folds.push({
      index: folds.length,
      train,
      validation,
      result: undefined,
      purgedCount,
      embargoMs,
      validationStart,
      validationEnd,
    });

    purgedObservations += purgedCount;
    validationObservations += validation.length;
  }

  const minimumFolds = 2;
  const passed = folds.length >= minimumFolds;

  return {
    folds,
    totalObservations: sorted.length,
    purgedObservations,
    validationObservations,
    passed,
    reason: passed
      ? `Built ${folds.length} purged/embargoed WFO folds`
      : `Insufficient folds: ${folds.length}/${minimumFolds}`,
  };
}

export function evaluatePurgedWalkForward<T, R>(
  observations: ResearchObservation<T>[],
  options: PurgedWalkForwardOptions,
  evaluate: (
    train: ResearchObservation<T>[],
    validation: ResearchObservation<T>[],
    foldIndex: number,
  ) => R,
): PurgedWalkForwardResult<T, R> {
  const result = buildPurgedWalkForwardFolds(
    observations,
    options,
  );

  if (!result.passed) return result;

  for (const fold of result.folds) {
    fold.result = evaluate(
      fold.train,
      fold.validation,
      fold.index,
    );
  }

  return result;
}

/**
 * Basic structural leakage check for a fold.
 * It fails when a training label reaches into the validation interval.
 */
export function hasTemporalLeakage<T>(
  fold: WfoFold<T>,
): boolean {
  const validationStart = fold.validationStart;
  const validationEnd = fold.validationEnd;

  return fold.train.some(
    item =>
      item.endTime >= validationStart ||
      item.startTime >= validationEnd,
  );
}
