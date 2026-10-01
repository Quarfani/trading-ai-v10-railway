/**
 * WALK-FORWARD OPTIMIZER — v8.0
 * ══════════════════════════════════════════════════════════════════════════
 * يُقسّم البيانات التاريخية إلى نوافذ متداخلة ويُحسّن معاملات الاستراتيجيات
 * على كل نافذة تدريب، ثم يختبرها على نافذة اختبار أمامية (out-of-sample).
 *
 * الهدف:
 *   - منع Over-fitting (معاملات تعمل على الماضي فقط)
 *   - ضمان أن المعاملات المُختارة تعمل على بيانات لم تُدرَّب عليها
 *   - تحديث المعاملات تلقائياً كل شهر
 *
 * البنية:
 *   ┌─────────────────────────────────────────────┐
 *   │ Window 1: Train [0..200] → Test [200..250]  │
 *   │ Window 2: Train [50..250] → Test [250..300] │
 *   │ Window 3: Train [100..300] → Test [300..350]│
 *   └─────────────────────────────────────────────┘
 *
 * المعاملات المُحسَّنة:
 *   - atrMult (0.8 → 3.0)     : ضرب ATR للـ SL
 *   - tpRatio (1.0 → 4.0)     : نسبة TP إلى SL
 *   - minConfidence (0.50→0.80): حد أدنى للثقة
 *   - rollingWindow (10 → 50) : نافذة الـ Rolling metrics
 * ══════════════════════════════════════════════════════════════════════════
 */
import { Candle, Timeframe } from '../types/trading.types';
import { Backtester }      from '../backtest/Backtester';
import { DatabaseManager } from '../database/DatabaseManager';
import { Logger } from '../utils/Logger';
import { HistoricalRateSeries } from '../market/HistoricalCurrencySeries';
import { TIMEFRAME_MS } from '../market/market.types';
import { buildPurgedWalkForwardFolds } from '../research/PurgedWalkForward';
import { summarizeWfoEvidence, BacktestWfoMetrics } from '../research/WfoEvidenceAdapter';

export interface OptimParams {
  atrMult:       number;
  tpRatio:       number;
  minConfidence: number;
  rollingWindow: number;
}

export interface WalkForwardWindow {
  trainStart:  number;
  trainEnd:    number;
  testStart:   number;
  testEnd:     number;
  bestParams:  OptimParams;
  trainMetrics:{ winRate: number; sharpe: number; profitFactor: number; totalReturn: number; maxDD: number; totalTrades: number; totalCost: number; valid: boolean };
  testMetrics: { winRate: number; sharpe: number; profitFactor: number; totalReturn: number; maxDD: number; totalTrades: number; totalCost: number; valid: boolean };
  oos_valid:   boolean; // out-of-sample passed minimum threshold
  leakagePassed: boolean;
  purgedCount: number;
  embargoMs: number;
}

export function selectDeploymentParams(
  windows: Array<{ bestParams: OptimParams }>,
): OptimParams | null {
  if (!windows.length) return null;
  return { ...windows[windows.length - 1].bestParams };
}

export interface WalkForwardResult {
  symbol:         string;
  windows:        WalkForwardWindow[];
  finalParams:    OptimParams;  // recommended params for live trading
  oos_winRate:    number;       // average out-of-sample win rate
  oos_sharpe:     number;
  oos_profit:     number;
  recommendation: 'TRADE' | 'CAUTION' | 'DO_NOT_TRADE';
  reason:         string;
  runAt:          number;
  valid:           boolean;
  validationReasons: string[];
  evidence: ReturnType<typeof summarizeWfoEvidence>;
}

// Parameter search grid
const ATR_MULTS       = [0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5];
const TP_RATIOS       = [1.5, 2.0, 2.5, 3.0, 3.5, 4.0];
const MIN_CONFIDENCES = [0.55, 0.60, 0.65, 0.70];

const TRAIN_BARS = 500;  // bars for training
const TEST_BARS  = 125;  // bars for testing (25% of train)
const STEP_BARS  = 125;  // slide step

export class WalkForwardOptimizer {
  private logger = new Logger('WalkForward');

  constructor(private dbPath: string) {}

  async run(symbol: string, allCandles: Candle[], timeframe: Timeframe = 'H1', historicalCurrencyRates: HistoricalRateSeries = {}): Promise<WalkForwardResult> {
    this.logger.info(`Walk-Forward: ${symbol} | ${allCandles.length} candles`);

    if (allCandles.length < TRAIN_BARS + TEST_BARS) {
      return this.insufficient(symbol);
    }

    const observations = allCandles.map((candle) => ({
      startTime: candle.time,
      endTime: candle.time + (TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS.H1),
      value: candle,
    }));

    const planned = buildPurgedWalkForwardFolds(observations, {
      trainSize: TRAIN_BARS,
      validationSize: TEST_BARS,
      stepSize: STEP_BARS,
      purgeMs: TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS.H1,
      embargoMs: TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS.H1,
      minTrainSize: Math.max(1, TRAIN_BARS - 2),
    });

    if (!planned.passed) {
      return this.insufficient(
        symbol,
        'Purged/embargoed WFO planning failed: ' + planned.reason,
      );
    }

    const windows: WalkForwardWindow[] = [];

    for (const fold of planned.folds) {
      const trainCandles = fold.train.map(item => item.value);
      const testCandles = fold.validation.map(item => item.value);
      this.logger.info(
        `  Window ${windows.length + 1}: train=${trainCandles.length} test=${testCandles.length} purge=${fold.purgedCount} embargoMs=${fold.embargoMs}`,
      );

      const { bestParams, bestMetrics } = await this.optimizeOnTrain(
        symbol,
        trainCandles,
        timeframe,
        historicalCurrencyRates,
      );
      const testMetrics = await this.evaluateOnTest(
        symbol,
        trainCandles.slice(-250),
        testCandles,
        bestParams,
        timeframe,
        historicalCurrencyRates,
      );

      const leakagePassed = !fold.train.some(
        observation => observation.endTime >= fold.validationStart,
      );

      const oos_valid =
        testMetrics.valid &&
        leakagePassed &&
        testMetrics.winRate >= 0.45 &&
        testMetrics.sharpe >= 0.3;

      windows.push({
        trainStart: fold.train[0].startTime,
        trainEnd: fold.train[fold.train.length - 1].endTime,
        testStart: fold.validationStart,
        testEnd: fold.validationEnd,
        bestParams,
        trainMetrics: bestMetrics,
        testMetrics,
        oos_valid,
        leakagePassed,
        purgedCount: fold.purgedCount,
        embargoMs: fold.embargoMs,
      });
    }

    return this.buildResult(symbol, windows, planned.passed, planned.reason);
  }

  // ─── Grid search on training data ────────────────────────────────────────

  private async optimizeOnTrain(
    symbol: string,
    candles: Candle[],
    timeframe: Timeframe,
    historicalCurrencyRates: HistoricalRateSeries,
  ): Promise<{ bestParams: OptimParams; bestMetrics: any }> {
    let bestScore  = -Infinity;
    let bestParams: OptimParams = { atrMult: 1.5, tpRatio: 2.0, minConfidence: 0.60, rollingWindow: 30 };
    let bestMetrics: { winRate: number; sharpe: number; profitFactor: number; totalReturn: number; maxDD: number; valid: boolean } = {
      winRate: 0, sharpe: 0, profitFactor: 0, totalReturn: 0, maxDD: 1, valid: false,
    };

    // Grid search over parameter combinations
    for (const atrMult of ATR_MULTS) {
      for (const tpRatio of TP_RATIOS) {
        if (tpRatio < 1.5) continue; // skip low R:R
        for (const minConfidence of MIN_CONFIDENCES) {
          const params: OptimParams = { atrMult, tpRatio, minConfidence, rollingWindow: 30 };
          const metrics = await this.quickBacktest(
            symbol,
            candles,
            params,
            timeframe,
            historicalCurrencyRates,
          );

          // Objective function: Sharpe × WinRate × (1 - MaxDD)
          const score = metrics.sharpe * metrics.winRate * (1 - Math.min(0.5, metrics.maxDD));

          if (!metrics.valid) continue;

          if (score > bestScore) {
            bestScore   = score;
            bestParams  = params;
            bestMetrics = metrics;
          }
        }
      }
    }

    return { bestParams, bestMetrics };
  }

  // ─── Quick backtest for a single param set ───────────────────────────────

  private async quickBacktest(
    symbol: string,
    candles: Candle[],
    params: OptimParams,
    timeframe: Timeframe,
    historicalCurrencyRates: HistoricalRateSeries,
    evaluationStartTime?: number,
  ): Promise<{
    winRate: number;
    sharpe: number;
    profitFactor: number;
    totalReturn: number;
    maxDD: number;
    totalTrades: number;
    totalCost: number;
    valid: boolean;
  }> {
    const envAtrKey = `SPEC_${symbol}_${timeframe}_ATR_MULT`;
    const envTpKey = `SPEC_${symbol}_${timeframe}_TP_RATIO`;
    const originalEnv = {
      atrMult: process.env[envAtrKey],
      tpRatio: process.env[envTpKey],
    };

    try {
      process.env[envAtrKey] = String(params.atrMult);
      process.env[envTpKey] = String(params.tpRatio);

      const bt = new Backtester({
        mode: 'paper',
        accountCurrency: 'USD',
        accountBalance: 10_000,
        minConfidence: params.minConfidence,
      } as any);

      const res = await bt.run(
        symbol,
        candles,
        10_000,
        timeframe,
        historicalCurrencyRates,
        evaluationStartTime,
      );

      if (!res.valid) {
        return {
          winRate: 0,
          sharpe: 0,
          profitFactor: 0,
          totalReturn: 0,
          maxDD: 1,
          totalTrades: 0,
          totalCost: 0,
          valid: false,
        };
      }

      return {
        winRate: res.winRate,
        sharpe: res.sharpeRatio,
        profitFactor: res.profitFactor,
        totalReturn: res.totalReturn,
        maxDD: res.maxDrawdownPct / 100,
        totalTrades: res.totalTrades,
        totalCost: res.totalCost,
        valid: true,
      };
    } catch {
      return {
        winRate: 0,
        sharpe: 0,
        profitFactor: 0,
        totalReturn: 0,
        maxDD: 1,
        totalTrades: 0,
        totalCost: 0,
        valid: false,
      };
    } finally {
      if (originalEnv.atrMult !== undefined) {
        process.env[envAtrKey] = originalEnv.atrMult;
      } else {
        delete process.env[envAtrKey];
      }

      if (originalEnv.tpRatio !== undefined) {
        process.env[envTpKey] = originalEnv.tpRatio;
      } else {
        delete process.env[envTpKey];
      }
    }
  }

  private async evaluateOnTest(
    symbol: string,
    warmupCandles: Candle[],
    validationCandles: Candle[],
    params: OptimParams,
    timeframe: Timeframe,
    historicalCurrencyRates: HistoricalRateSeries,
  ): Promise<any> {
    const combined = [...warmupCandles, ...validationCandles];
    const evaluationStartTime = validationCandles[0]?.time;

    if (evaluationStartTime == null || validationCandles.length === 0) {
      return {
        winRate: 0,
        sharpe: 0,
        profitFactor: 0,
        totalReturn: 0,
        maxDD: 1,
        valid: false,
      };
    }

    return this.quickBacktest(
      symbol,
      combined,
      params,
      timeframe,
      historicalCurrencyRates,
      evaluationStartTime,
    );
  }

  // ─── Build final result ───────────────────────────────────────────────────

  private buildResult(symbol: string, windows: WalkForwardWindow[], valid = true, validationReason = ''): WalkForwardResult {
    if (!windows.length) return this.insufficient(symbol);

    const validWindows = windows.filter(w => w.oos_valid);
    const evaluatedWindows = windows.filter(w => w.testMetrics.valid && w.leakagePassed);
    const evidenceMetrics: BacktestWfoMetrics[] = windows.map(w => ({
      foldIndex: windows.indexOf(w),
      oos: true,
      startTime: w.testStart,
      endTime: w.testEnd,
      trades: w.testMetrics.totalTrades,
      pnl: w.testMetrics.totalReturn,
      profitFactor: w.testMetrics.profitFactor,
      totalCost: w.testMetrics.totalCost,
      leakagePassed: w.leakagePassed,
    }));
    const evidence = summarizeWfoEvidence(evidenceMetrics);
    const oos_winRate  = avg(evaluatedWindows.map(w => w.testMetrics.winRate));
    const oos_sharpe   = avg(evaluatedWindows.map(w => w.testMetrics.sharpe));
    const oos_profit   = evaluatedWindows.reduce((s, w) => s + w.testMetrics.totalReturn, 0);
    const allFoldsValid = evaluatedWindows.length === windows.length && windows.every(w => w.trainMetrics.valid) && evidence.passed;

    // Deployment parameters come from the latest training window only.
    // OOS results decide promotion eligibility but never select the values.
    const finalParams = selectDeploymentParams(windows)!;

    const validPct = windows.length > 0 ? validWindows.length / windows.length : 0;

    let recommendation: WalkForwardResult['recommendation'];
    let reason: string;

    if (valid && allFoldsValid && oos_winRate >= 0.52 && oos_sharpe >= 0.5 && validPct >= 0.6) {
      recommendation = 'TRADE';
      reason = `OOS Win Rate ${(oos_winRate*100).toFixed(1)}%, Sharpe ${oos_sharpe.toFixed(2)}, ${(validPct*100).toFixed(0)}% valid windows`;
    } else if (valid && allFoldsValid && oos_winRate >= 0.47 && validPct >= 0.4) {
      recommendation = 'CAUTION';
      reason = `Marginal OOS results — start with minimum lot size`;
    } else {
      recommendation = 'DO_NOT_TRADE';
      reason = !valid || !allFoldsValid
        ? 'WFO invalid: one or more folds failed economic, OOS, or leakage validation'
        : `OOS Win Rate ${(oos_winRate*100).toFixed(1)}% too low or ${(validPct*100).toFixed(0)}% valid windows insufficient`;
    }

    this.logger.info(`WFO ${symbol}: ${recommendation} | OOS WR=${(oos_winRate*100).toFixed(1)}% Sharpe=${oos_sharpe.toFixed(2)}`);

    return { symbol, windows, finalParams, oos_winRate, oos_sharpe, oos_profit, recommendation, reason, runAt: Date.now(), valid: valid && evidence.passed, validationReasons: [...(validationReason ? [validationReason] : []), ...evidence.reasons], evidence };
  }

  private insufficient(symbol: string, reason = 'Insufficient candle data for walk-forward optimization'): WalkForwardResult {
    return {
      symbol, windows: [],
      finalParams: { atrMult: 1.5, tpRatio: 2.0, minConfidence: 0.60, rollingWindow: 30 },
      oos_winRate: 0, oos_sharpe: 0, oos_profit: 0,
      recommendation: 'DO_NOT_TRADE',
      reason,
      runAt: Date.now(),
      valid: false,
      validationReasons: [reason],
      evidence: summarizeWfoEvidence([]),
    };
  }

  /** Save optimized params to DB so they're loaded on next startup */
  saveParams(db: DatabaseManager, symbol: string, params: OptimParams, timeframe: Timeframe = 'H1'): void {
    db.setSetting(`wfo_params_${symbol}_${timeframe}`, JSON.stringify({ ...params, savedAt: Date.now(), timeframe }));
    // Also set env vars so symbolConfig picks them up
    process.env[`SPEC_${symbol}_${timeframe}_ATR_MULT`] = String(params.atrMult);
    process.env[`SPEC_${symbol}_${timeframe}_TP_RATIO`] = String(params.tpRatio);
    this.logger.info(`Saved WFO params for ${symbol}: atrMult=${params.atrMult} tpRatio=${params.tpRatio}`);
  }

  loadParams(db: DatabaseManager, symbol: string, timeframe: Timeframe = 'H1'): OptimParams | null {
    try {
      const s = db.getSetting(`wfo_params_${symbol}_${timeframe}`);
      if (!s) return null;
      const p = JSON.parse(s) as OptimParams & { savedAt: number };
      // Expire after 30 days
      if (Date.now() - p.savedAt > 30 * 24 * 3_600_000) return null;
      return p;
    } catch { return null; }
  }
}

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}
