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
  totalCost: number;
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
  totalCost: number;
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
      totalCost: 0,
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

  const totalWeightedTrades = folds.reduce(
    (sum, fold) => sum + Math.max(0, fold.trades),
    0,
  );

  const weightedProfitFactor =
    totalWeightedTrades > 0
      ? folds.reduce(
          (sum, fold) =>
            sum +
            (Number.isFinite(fold.profitFactor) ? fold.profitFactor : 0) *
              Math.max(0, fold.trades),
          0,
        ) / totalWeightedTrades
      : 0;

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
    weightedProfitFactor: Number(weightedProfitFactor.toFixed(6)),
    totalCost,
    leakageChecksPassed: passed && leakageChecksPassed,
    passed,
    reasons,
  };
}

export function evidenceInputFromWfo(
  folds: BacktestWfoMetrics[],
  metadata: EvidenceMetadata,
): EvidenceInput {
  const summary = summarizeWfoEvidence(folds);

  return {
    sampleSize: metadata.sampleSize,
    outOfSampleTrades: summary.oosTrades,
    walkForwardStability: summary.walkForwardStability,
    regimeCoverage: metadata.regimeCoverage,
    parameterSensitivity: metadata.parameterSensitivity,
    costAdjustedProfitFactor: summary.weightedProfitFactor,
    datasetQuality: metadata.datasetQuality,
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
    totalCost: metrics.totalCost,
    leakagePassed:
      fold.train.every(
        observation =>
          observation.endTime < fold.validationStart,
      ),
  };
}
