/**
 * EVIDENCE SCORE
 *
 * Converts validation evidence into a bounded [0,1] score. It is intentionally
 * descriptive rather than a direct trading weight: promotion gates can require
 * minimum component coverage and an overall threshold.
 */
export interface EvidenceInput {
  sampleSize: number;
  outOfSampleTrades: number;
  walkForwardStability: number;   // expected [0,1]
  regimeCoverage: number;          // expected [0,1]
  parameterSensitivity: number;   // expected [0,1], higher = more robust
  costAdjustedProfitFactor: number;
  datasetQuality: number;         // expected [0,1]
  leakageChecksPassed: boolean;
}

export interface EvidenceScore {
  score: number;
  components: {
    sample: number;
    oos: number;
    walkForward: number;
    regimeCoverage: number;
    parameterSensitivity: number;
    costAdjustedPF: number;
    datasetQuality: number;
    leakageSafety: number;
  };
  sufficientSample: boolean;
  passed: boolean;
  reasons: string[];
}

function bounded(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sampleScore(trades: number): number {
  if (!Number.isFinite(trades) || trades <= 0) return 0;
  // Saturates at 300 OOS observations; does not imply statistical significance.
  return Math.sqrt(Math.min(trades, 300) / 300);
}

function pfScore(pf: number): number {
  if (!Number.isFinite(pf) || pf <= 1) return 0;
  // PF 1.5 -> 0.8; PF 2.0+ -> 1.0.
  if (pf >= 2) return 1;
  return bounded((pf - 1) * 1.6);
}

export function calculateEvidenceScore(
  input: EvidenceInput,
  minimumOosTrades = 200,
): EvidenceScore {
  const reasons: string[] = [];
  const components = {
    sample: sampleScore(input.sampleSize),
    oos: sampleScore(input.outOfSampleTrades),
    walkForward: bounded(input.walkForwardStability),
    regimeCoverage: bounded(input.regimeCoverage),
    parameterSensitivity: bounded(input.parameterSensitivity),
    costAdjustedPF: pfScore(input.costAdjustedProfitFactor),
    datasetQuality: bounded(input.datasetQuality),
    leakageSafety: input.leakageChecksPassed ? 1 : 0,
  };

  const weights = {
    sample: 0.10,
    oos: 0.20,
    walkForward: 0.15,
    regimeCoverage: 0.10,
    parameterSensitivity: 0.10,
    costAdjustedPF: 0.15,
    datasetQuality: 0.10,
    leakageSafety: 0.10,
  };

  const score =
    components.sample * weights.sample +
    components.oos * weights.oos +
    components.walkForward * weights.walkForward +
    components.regimeCoverage * weights.regimeCoverage +
    components.parameterSensitivity * weights.parameterSensitivity +
    components.costAdjustedPF * weights.costAdjustedPF +
    components.datasetQuality * weights.datasetQuality +
    components.leakageSafety * weights.leakageSafety;

  const sufficientSample =
    Number.isFinite(input.outOfSampleTrades) &&
    input.outOfSampleTrades >= minimumOosTrades;

  if (!sufficientSample) {
    reasons.push(
      `OOS sample ${input.outOfSampleTrades} < minimum ${minimumOosTrades}`,
    );
  }
  if (!input.leakageChecksPassed) {
    reasons.push('Leakage/look-ahead checks did not pass');
  }
  if (input.costAdjustedProfitFactor <= 1) {
    reasons.push('Cost-adjusted Profit Factor must be > 1');
  }
  if (input.walkForwardStability < 0.5) {
    reasons.push('Walk-forward stability below 0.5');
  }
  if (input.datasetQuality < 0.8) {
    reasons.push('Dataset quality below 0.8');
  }

  const passed =
    sufficientSample &&
    input.leakageChecksPassed &&
    input.costAdjustedProfitFactor > 1 &&
    input.walkForwardStability >= 0.5 &&
    input.datasetQuality >= 0.8 &&
    score >= 0.65;

  if (passed) {
    reasons.push('Evidence gate passed');
  }

  return {
    score: Number(score.toFixed(6)),
    components,
    sufficientSample,
    passed,
    reasons,
  };
}
