/**
 * HISTORICAL ANALOG ENGINE
 *
 * Nearest-neighbour retrieval over previously observed market states.
 * It does not predict a future price. It reports what happened after similar
 * historical states under explicit horizons and similarity thresholds.
 */
export interface AnalogFeatures {
  trend: number;
  atrPct: number;
  volatility: number;
  momentum: number;
  volumeZ: number;
  structure: number;
  session: number;
}

export interface HistoricalObservation {
  timestamp: number;
  features: AnalogFeatures;
  forwardReturns: Record<number, number>;
  tpHit: Record<number, boolean>;
  slHit: Record<number, boolean>;
  mfe: Record<number, number>;
  mae: Record<number, number>;
}

export interface AnalogMatch {
  timestamp: number;
  distance: number;
  similarity: number;
  observation: HistoricalObservation;
}

export interface AnalogHorizonStats {
  horizon: number;
  samples: number;
  tpProbability: number;
  slProbability: number;
  meanForwardReturn: number;
  medianForwardReturn: number;
  meanMfe: number;
  meanMae: number;
}

export interface HistoricalAnalogResult {
  matches: AnalogMatch[];
  effectiveSampleSize: number;
  confidence: number;
  horizons: AnalogHorizonStats[];
  passed: boolean;
  reason: string;
}

const FEATURE_KEYS: Array<keyof AnalogFeatures> = [
  'trend',
  'atrPct',
  'volatility',
  'momentum',
  'volumeZ',
  'structure',
  'session',
];

function finiteFeature(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function calculateAnalogDistance(
  current: AnalogFeatures,
  historical: AnalogFeatures,
): number {
  let sum = 0;

  for (const key of FEATURE_KEYS) {
    const a = finiteFeature(current[key]);
    const b = finiteFeature(historical[key]);
    const delta = a - b;

    sum += delta * delta;
  }

  return Math.sqrt(sum / FEATURE_KEYS.length);
}

export function searchHistoricalAnalogs(
  current: AnalogFeatures,
  history: HistoricalObservation[],
  options: {
    k?: number;
    maxDistance?: number;
    horizons?: number[];
  } = {},
): HistoricalAnalogResult {
  const k = Math.max(1, Math.floor(options.k ?? 50));
  const maxDistance =
    Number.isFinite(options.maxDistance ?? NaN)
      ? Math.max(0, options.maxDistance as number)
      : Infinity;
  const horizons = options.horizons ?? [1, 3, 5, 10, 20];

  const matches = history
    .map(observation => {
      const distance = calculateAnalogDistance(
        current,
        observation.features,
      );

      return {
        timestamp: observation.timestamp,
        distance,
        similarity: 1 / (1 + distance),
        observation,
      };
    })
    .filter(match => Number.isFinite(match.distance) && match.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);

  const effectiveSampleSize = matches.length;

  const resultHorizons: AnalogHorizonStats[] = horizons.map(horizon => {
    const rows = matches.filter(match =>
      Object.prototype.hasOwnProperty.call(
        match.observation.forwardReturns,
        horizon,
      ),
    );

    if (!rows.length) {
      return {
        horizon,
        samples: 0,
        tpProbability: 0,
        slProbability: 0,
        meanForwardReturn: 0,
        medianForwardReturn: 0,
        meanMfe: 0,
        meanMae: 0,
      };
    }

    const returns = rows.map(
      row => row.observation.forwardReturns[horizon],
    );

    const tpProbability =
      rows.filter(row => row.observation.tpHit[horizon] === true).length /
      rows.length;

    const slProbability =
      rows.filter(row => row.observation.slHit[horizon] === true).length /
      rows.length;

    const mfe = rows
      .map(row => row.observation.mfe[horizon])
      .filter(Number.isFinite);

    const mae = rows
      .map(row => row.observation.mae[horizon])
      .filter(Number.isFinite);

    return {
      horizon,
      samples: rows.length,
      tpProbability,
      slProbability,
      meanForwardReturn:
        returns.reduce((sum, value) => sum + value, 0) / returns.length,
      medianForwardReturn: median(returns),
      meanMfe: mfe.length
        ? mfe.reduce((sum, value) => sum + value, 0) / mfe.length
        : 0,
      meanMae: mae.length
        ? mae.reduce((sum, value) => sum + value, 0) / mae.length
        : 0,
    };
  });

  // Confidence is intentionally conservative: similarity + sample coverage,
  // never a probability of future success.
  const similarity =
    matches.length
      ? matches.reduce((sum, match) => sum + match.similarity, 0) /
        matches.length
      : 0;

  const sampleFactor = Math.min(1, effectiveSampleSize / 50);
  const confidence = Math.min(1, similarity * sampleFactor);

  const firstHorizon = resultHorizons[0];
  const passed =
    effectiveSampleSize >= Math.min(k, 20) &&
    Boolean(firstHorizon && firstHorizon.samples >= 20);

  return {
    matches,
    effectiveSampleSize,
    confidence: Number(confidence.toFixed(6)),
    horizons: resultHorizons,
    passed,
    reason: passed
      ? `Historical analog evidence available: ${effectiveSampleSize} matches`
      : `Insufficient analog evidence: ${effectiveSampleSize} matches`,
  };
}
