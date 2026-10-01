/**
 * WFO -> EVIDENCE ADAPTER
 *
 * Converts explicitly out-of-sample fold results into EvidenceInput fields.
 * Stability is derived from profitable-fold consistency, not hand-entered.
 */
import { EvidenceInput } from './EvidenceScore';
import { WfoFold } from './PurgedWalkForward';

export interface BacktestWfoMetrics {
  foldIndex: number;
  oos: true;
  startTime: number;
  endTime: number;
  trades: number;
  pnl: number;
  profitFactor: number;
  /** Exact net OOS positive/negative PnL components when available. */
  positivePnl?: number;
  negativePnl?: number;
  totalCost: number;
  parameterSensitivity: number;
  regimeCoverage: number;
  datasetQuality: number;
  sampleSize: number;
  leakagePassed: boolean;
}

export interface WfoEvidenceSummary {
  folds: number;
  oosTrades: number;
  aggregatePnl: number;
  averageFoldPnl: number;
  profitableFoldRate: number;
  walkForwardStability: number;
  weightedProfitFactor: number;
  aggregatePositivePnl: number;
  aggregateNegativePnl: number;
  totalCost: number;
  averageParameterSensitivity: number;
  averageRegimeCoverage: number;
  averageDatasetQuality: number;
  sampleSize: number;
  leakageChecksPassed: boolean;
  passed: boolean;
  reasons: string[];
}

export interface EvidenceMetadata {
  sampleSize: number;
  regimeCoverage: number;
  parameterSensitivity: number;
  datasetQuality: number;
}

export function summarizeWfoEvidence(
  folds: BacktestWfoMetrics[],
  minimumFolds = 2,
): WfoEvidenceSummary {
  const reasons: string[] = [];

  if (!folds.length) {
    return {
      folds: 0,
      oosTrades: 0,
      aggregatePnl: 0,
      averageFoldPnl: 0,
      profitableFoldRate: 0,
      walkForwardStability: 0,
      weightedProfitFactor: 0,
      aggregatePositivePnl: 0,
      aggregateNegativePnl: 0,
      totalCost: 0,
      averageParameterSensitivity: 0,
      averageRegimeCoverage: 0,
      averageDatasetQuality: 0,
      sampleSize: 0,
      leakageChecksPassed: false,
      passed: false,
      reasons: ['No WFO folds supplied'],
    };
  }

  const explicitOos = folds.every(f => f.oos === true);
  if (!explicitOos) reasons.push('Every fold must be explicitly marked OOS');

  const temporalOrder = folds.every(
    (fold, index) =>
      index === 0 ||
      fold.startTime >= folds[index - 1].endTime,
  );
  if (!temporalOrder) reasons.push('OOS validation periods must be time ordered');

  const leakageChecksPassed =
    folds.every(fold => fold.leakagePassed);

  if (!leakageChecksPassed) {
    reasons.push('At least one WFO fold failed leakage checks');
  }

  const profitable = folds.filter(fold => fold.pnl > 0).length;
  const profitableFoldRate = profitable / folds.length;

  const oosTrades = folds.reduce((sum, fold) => sum + Math.max(0, fold.trades), 0);
  const aggregatePnl = folds.reduce((sum, fold) => sum + fold.pnl, 0);
  const averageFoldPnl = aggregatePnl / folds.length;

  const aggregatePositivePnl = folds.reduce(
    (sum, fold) => sum + Math.max(0, Number(fold.positivePnl ?? 0)),
    0,
  );
  const aggregateNegativePnl = folds.reduce(
    (sum, fold) => sum + Math.max(0, Number(fold.negativePnl ?? 0)),
    0,
  );

  const weightedProfitFactor =
    aggregateNegativePnl > 0
      ? aggregatePositivePnl / aggregateNegativePnl
      : aggregatePositivePnl > 0
        ? Infinity
        : 0;

  const averageParameterSensitivity =
    folds.reduce((sum, fold) => sum + Math.max(0, Math.min(1, fold.parameterSensitivity)), 0) /
    folds.length;

  const averageRegimeCoverage =
    folds.reduce((sum, fold) => sum + Math.max(0, Math.min(1, fold.regimeCoverage)), 0) /
    folds.length;

  const averageDatasetQuality =
    folds.reduce((sum, fold) => sum + Math.max(0, Math.min(1, fold.datasetQuality)), 0) /
    folds.length;

  const sampleSize = folds.reduce(
    (sum, fold) => sum + Math.max(0, fold.sampleSize),
    0,
  );

  const totalCost = folds.reduce(
    (sum, fold) => sum + Math.max(0, fold.totalCost),
    0,
  );

  // v1 stability definition: fraction of OOS folds with positive net P&L.
  const walkForwardStability = profitableFoldRate;

  if (folds.length < minimumFolds) {
    reasons.push('WFO folds ' + folds.length + ' < minimum ' + minimumFolds);
  }
  if (oosTrades <= 0) reasons.push('WFO produced no OOS trades');

  const passed =
    folds.length >= minimumFolds &&
    oosTrades > 0 &&
    explicitOos &&
    temporalOrder &&
    leakageChecksPassed;

  if (passed) reasons.push('Purged/embargoed OOS evidence is structurally valid');

  return {
    folds: folds.length,
    oosTrades,
    aggregatePnl,
    averageFoldPnl,
    profitableFoldRate: Number(profitableFoldRate.toFixed(6)),
    walkForwardStability: Number(walkForwardStability.toFixed(6)),
    weightedProfitFactor: Number.isFinite(weightedProfitFactor)
      ? Number(weightedProfitFactor.toFixed(6))
      : weightedProfitFactor,
    aggregatePositivePnl,
    aggregateNegativePnl,
    totalCost,
    averageParameterSensitivity: Number(averageParameterSensitivity.toFixed(6)),
    averageRegimeCoverage: Number(averageRegimeCoverage.toFixed(6)),
    averageDatasetQuality: Number(averageDatasetQuality.toFixed(6)),
    sampleSize,
    leakageChecksPassed: passed && leakageChecksPassed,
    passed,
    reasons,
  };
}

export function evidenceInputFromWfo(
  folds: BacktestWfoMetrics[],
  metadata: Partial<EvidenceMetadata> = {},
): EvidenceInput {
  const summary = summarizeWfoEvidence(folds);

  return {
    sampleSize: metadata.sampleSize ?? summary.sampleSize,
    outOfSampleTrades: summary.oosTrades,
    walkForwardStability: summary.walkForwardStability,
    regimeCoverage: metadata.regimeCoverage ?? summary.averageRegimeCoverage,
    parameterSensitivity: metadata.parameterSensitivity ?? summary.averageParameterSensitivity,
    costAdjustedProfitFactor: summary.weightedProfitFactor,
    datasetQuality: metadata.datasetQuality ?? summary.averageDatasetQuality,
    leakageChecksPassed:
      summary.leakageChecksPassed && summary.passed,
  };
}

export function metricsFromPurgedWfoFold<T>(
  fold: WfoFold<T>,
  metrics: {
    pnl: number;
    trades: number;
    profitFactor: number;
    totalCost: number;
    parameterSensitivity?: number;
    regimeCoverage?: number;
    datasetQuality?: number;
    sampleSize?: number;
  },
): BacktestWfoMetrics {
  return {
    foldIndex: fold.index,
    oos: true,
    startTime: fold.validationStart,
    endTime: fold.validationEnd,
    trades: metrics.trades,
    pnl: metrics.pnl,
    profitFactor: metrics.profitFactor,
    positivePnl: metrics.pnl > 0 ? metrics.pnl : 0,
    negativePnl: metrics.pnl < 0 ? Math.abs(metrics.pnl) : 0,
    totalCost: metrics.totalCost,
    parameterSensitivity: metrics.parameterSensitivity ?? 0,
    regimeCoverage: metrics.regimeCoverage ?? 0,
    datasetQuality: metrics.datasetQuality ?? 0,
    sampleSize: metrics.sampleSize ?? 0,
    leakagePassed:
      fold.train.every(
        observation =>
          observation.endTime < fold.validationStart,
      ),
  };
}
