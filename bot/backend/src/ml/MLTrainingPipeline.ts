/**
 * ML TRAINING PIPELINE — v8.0
 * ══════════════════════════════════════════════════════════════════════════
 * يُدرّب نموذج Random Forest على كل صفقة مُغلقة لتحسين الـ Confidence
 * scoring في المستقبل.
 *
 * Features المُستخدَمة (18 feature):
 *   السوق: ADX, ATR%, BB_Width, Choppiness, EMA_dist_50, EMA_dist_200
 *   التوقيت: Hour_UTC, DayOfWeek, Session_Score
 *   الإشارة: Confidence_raw, Source_encoded, RR_ratio
 *   الأداء: Symbol_WR_30d, Source_WR_30d, Session_WR_30d
 *   المخاطر: SL_distance_pct, TP_distance_pct, Portfolio_heat
 *
 * النموذج:
 *   Random Forest بسيط مُنفَّذ بـ pure TypeScript (بدون Python dependency)
 *   يُحدَّث كل يوم بصفقات جديدة
 *   يُعيد احتمالية BUY_WIN, SELL_WIN للتأثير على ML Enhancer
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DatabaseManager } from '../database/DatabaseManager';
import { Candle }          from '../types/trading.types';
import { calculateATR, atrPercent } from '../utils/ATR';
import { ADX, BollingerBands, EMA } from 'technicalindicators';
import { Logger }          from '../utils/Logger';

export interface MLFeatures {
  adx:               number;
  atrPct:            number;
  bbWidth:           number;
  choppiness:        number;
  emaDist50:         number;  // (price - EMA50) / ATR
  emaDist200:        number;
  hourUTC:           number;
  dayOfWeek:         number;
  sessionScore:      number;
  confidenceRaw:     number;
  sourceEncoded:     number;  // hash of source name → 0..1
  rrRatio:           number;
  symbolWR30d:       number;
  sourceWR30d:       number;
  slDistPct:         number;
  tpDistPct:         number;
  portfolioHeat:     number;
  regime:            number;  // 0=RANGING, 0.5=UNKNOWN, 1=TRENDING
}

interface TrainingRow {
  openedAt: number;
  features: MLFeatures;
  label:    0 | 1;  // 1 = win, 0 = loss
}

// Simple Decision Tree node
interface DTNode {
  featureIdx?: number;
  threshold?:  number;
  left?:       DTNode;
  right?:      DTNode;
  prediction?: number;  // leaf: win probability
  samples?:    number;
}

export class MLTrainingPipeline {
  private logger   = new Logger('MLTraining');
  private forest:  DTNode[] = [];
  private trained  = false;
  private lastTrain = 0;
  private featureImportance: Record<keyof MLFeatures, number> = {} as any;

  constructor(private db: DatabaseManager) {}

  /** Check if model needs retraining (daily) */
  needsTraining(): boolean {
    return !this.trained || Date.now() - this.lastTrain > 24 * 3_600_000;
  }

  /** Train or retrain the model from DB trades */
  async train(): Promise<{ ok: boolean; samples: number; accuracy: number }> {
    try {
      const rows = this.collectTrainingData();
      if (rows.length < 30) {
        this.logger.warn(`ML Training: only ${rows.length} samples — need 30+`);
        return { ok: false, samples: rows.length, accuracy: 0 };
      }

      this.logger.info(`ML Training: ${rows.length} samples...`);

      // Chronological 80/20 split. Randomly mixing future trades into
      // the training set would make the reported accuracy optimistic and
      // is inappropriate for a forward-looking trading model.
      const ordered = [...rows].sort((a, b) => a.openedAt - b.openedAt);
      const splitAt  = Math.floor(ordered.length * 0.8);
      const trainSet = ordered.slice(0, splitAt);
      const testSet  = ordered.slice(splitAt);

      // Train 50-tree Random Forest
      this.forest = [];
      for (let i = 0; i < 50; i++) {
        const bootstrap = this.bootstrapSample(trainSet);
        const tree = this.buildTree(bootstrap, 0, 6, 5);
        this.forest.push(tree);
      }

      // Compute feature importance
      this.computeFeatureImportance(trainSet);

      // Evaluate
      const accuracy = this.evaluate(testSet);
      this.trained   = true;
      this.lastTrain = Date.now();

      // Persist model to DB
      this.db.setSetting('ml_model', JSON.stringify({
        forest: this.forest,
        trainedAt: Date.now(),
        samples: rows.length,
        accuracy,
        importance: this.featureImportance,
      }));

      this.logger.info(`ML Training complete: accuracy=${(accuracy*100).toFixed(1)}% trees=50`);
      return { ok: true, samples: rows.length, accuracy };

    } catch (e: any) {
      this.logger.error(`ML Training failed: ${e.message}`);
      return { ok: false, samples: 0, accuracy: 0 };
    }
  }

  /** Predict win probability for a set of features */
  predict(features: MLFeatures): { winProbability: number; confidence: number } {
    if (!this.trained || this.forest.length === 0) {
      // Try loading from DB
      this.loadFromDB();
    }
    if (this.forest.length === 0) {
      return { winProbability: 0.5, confidence: 0 };
    }

    const fArr = this.featuresToArray(features);
    const predictions = this.forest.map(tree => this.predictTree(tree, fArr));
    const avgPred     = predictions.reduce((s, v) => s + v, 0) / predictions.length;
    // Confidence = how spread out the predictions are (low spread = high confidence)
    const variance    = predictions.reduce((s, v) => s + Math.pow(v - avgPred, 2), 0) / predictions.length;
    const confidence  = Math.max(0, 1 - Math.sqrt(variance) * 4);

    return { winProbability: avgPred, confidence };
  }

  /** Extract features from candles and trade context */
  extractFeatures(
    symbol:     string,
    side:       string,
    price:      number,
    sl:         number,
    tp:         number,
    confidence: number,
    source:     string,
    candles:    Candle[],
    regime:     string,
    portfolioHeat = 0,
  ): MLFeatures {
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);

    let adx = 20, bbWidth = 0.02, emaDist50 = 0, emaDist200 = 0;

    try {
      const adxR = ADX.calculate({ period: 14, close: closes, high: highs, low: lows });
      adx = adxR[adxR.length - 1]?.adx ?? 20;
    } catch {}

    try {
      const bb   = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
      const lastBB = bb[bb.length - 1];
      if (lastBB?.middle > 0) bbWidth = (lastBB.upper - lastBB.lower) / lastBB.middle;
    } catch {}

    const atrPct = atrPercent(candles, 14);
    const atr    = calculateATR(candles, 14);

    try {
      const e50  = EMA.calculate({ period: 50,  values: closes });
      const e200 = EMA.calculate({ period: 200, values: closes });
      if (e50.length  && atr > 0) emaDist50  = (price - e50[e50.length - 1])   / atr;
      if (e200.length && atr > 0) emaDist200 = (price - e200[e200.length - 1]) / atr;
    } catch {}

    const now   = new Date();
    const hour  = now.getUTCHours();
    const dow   = now.getUTCDay();
    const sessionScore = this.getSessionScore(hour);

    const slDist = Math.abs(price - sl);
    const tpDist = Math.abs(tp - price);
    const rr     = slDist > 0 ? tpDist / slDist : 0;

    const symbolWR = this.getSymbolWR(symbol);
    const sourceWR = this.getSourceWR(source);

    const regimeNum = regime === 'TRENDING' ? 1 : regime === 'RANGING' ? 0 : 0.5;

    // Choppiness approximation
    const chop = Math.min(100, Math.max(0, 100 - adx * 1.5));

    return {
      adx, atrPct, bbWidth, choppiness: chop,
      emaDist50, emaDist200,
      hourUTC: hour / 23, dayOfWeek: dow / 6,
      sessionScore: sessionScore / 100,
      confidenceRaw: confidence,
      sourceEncoded: this.encodeSource(source),
      rrRatio: Math.min(rr / 5, 1),
      symbolWR30d: symbolWR, sourceWR30d: sourceWR,
      slDistPct: Math.min(slDist / price, 0.05) / 0.05,
      tpDistPct: Math.min(tpDist / price, 0.10) / 0.10,
      portfolioHeat: Math.min(portfolioHeat, 0.10) / 0.10,
      regime: regimeNum,
    };
  }

  getFeatureImportance(): Record<string, number> {
    return this.featureImportance as any;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private collectTrainingData(): TrainingRow[] {
    const cutoff = Date.now() - 90 * 24 * 3_600_000; // last 90 days
    const rows = this.db.raw().prepare(`
      SELECT profit, source, confidence, entry, sl, tp, openedAt,
             symbol, timeframe
      FROM trades WHERE status='closed' AND openedAt > ? AND profit IS NOT NULL
      LIMIT 2000
    `).all(cutoff) as any[];

    return rows
      .filter(r => Number.isFinite(Number(r.openedAt)) && Number(r.openedAt) > 0)
      .map(r => ({
      openedAt: Number(r.openedAt),
      features: {
        adx: 20, atrPct: 0.01, bbWidth: 0.02, choppiness: 50,
        emaDist50: 0, emaDist200: 0,
        hourUTC: (new Date(r.openedAt).getUTCHours()) / 23,
        dayOfWeek: (new Date(r.openedAt).getUTCDay()) / 6,
        sessionScore: this.getSessionScore(new Date(r.openedAt).getUTCHours()) / 100,
        confidenceRaw: r.confidence ?? 0.6,
        sourceEncoded: this.encodeSource(r.source ?? ''),
        rrRatio: Math.min(Math.abs(r.tp - r.entry) / Math.max(Math.abs(r.entry - r.sl), 0.0001) / 5, 1),
        symbolWR30d: this.getSymbolWRAsOf(r.symbol, Number(r.openedAt)),
        sourceWR30d: this.getSourceWRAsOf(r.source, Number(r.openedAt)),
        slDistPct: Math.min(Math.abs(r.entry - r.sl) / r.entry / 0.05, 1),
        tpDistPct: Math.min(Math.abs(r.tp - r.entry) / r.entry / 0.10, 1),
        portfolioHeat: 0.02,
        regime: 0.5,
      } as MLFeatures,
      label: r.profit > 0 ? 1 : 0,
      }));
  }

  private buildTree(
    data: TrainingRow[], depth: number, maxDepth: number, minSamples: number
  ): DTNode {
    if (depth >= maxDepth || data.length <= minSamples) {
      return { prediction: this.leafPrediction(data), samples: data.length };
    }

    const best = this.bestSplit(data);
    if (!best) {
      return { prediction: this.leafPrediction(data), samples: data.length };
    }

    const { featureIdx, threshold, leftData, rightData } = best;

    return {
      featureIdx, threshold,
      left:  this.buildTree(leftData,  depth + 1, maxDepth, minSamples),
      right: this.buildTree(rightData, depth + 1, maxDepth, minSamples),
      samples: data.length,
    };
  }

  private bestSplit(data: TrainingRow[]) {
    const nFeatures = 18;
    const fCount    = Math.floor(Math.sqrt(nFeatures));
    const features  = this.shuffle(Array.from({ length: nFeatures }, (_, i) => i)).slice(0, fCount);

    let bestGini = Infinity, best: any = null;

    for (const fi of features) {
      const values = [...new Set(data.map(r => this.featuresToArray(r.features)[fi]))].sort((a, b) => a - b);
      for (let i = 0; i < values.length - 1; i++) {
        const threshold = (values[i] + values[i + 1]) / 2;
        const left  = data.filter(r => this.featuresToArray(r.features)[fi] <= threshold);
        const right = data.filter(r => this.featuresToArray(r.features)[fi] >  threshold);
        if (!left.length || !right.length) continue;
        const gini = (left.length * this.gini(left) + right.length * this.gini(right)) / data.length;
        if (gini < bestGini) {
          bestGini = gini;
          best = { featureIdx: fi, threshold, leftData: left, rightData: right };
        }
      }
    }
    return best;
  }

  private gini(data: TrainingRow[]): number {
    const wins = data.filter(r => r.label === 1).length / data.length;
    return 1 - wins * wins - (1 - wins) * (1 - wins);
  }

  private leafPrediction(data: TrainingRow[]): number {
    if (!data.length) return 0.5;
    return data.filter(r => r.label === 1).length / data.length;
  }

  private predictTree(node: DTNode, features: number[]): number {
    if (node.prediction !== undefined) return node.prediction;
    const val = features[node.featureIdx!];
    return val <= node.threshold!
      ? this.predictTree(node.left!, features)
      : this.predictTree(node.right!, features);
  }

  private featuresToArray(f: MLFeatures): number[] {
    return [
      f.adx / 100, f.atrPct * 100, f.bbWidth, f.choppiness / 100,
      Math.tanh(f.emaDist50 / 3), Math.tanh(f.emaDist200 / 3),
      f.hourUTC, f.dayOfWeek, f.sessionScore,
      f.confidenceRaw, f.sourceEncoded, f.rrRatio,
      f.symbolWR30d, f.sourceWR30d,
      f.slDistPct, f.tpDistPct, f.portfolioHeat, f.regime,
    ];
  }

  private evaluate(testSet: TrainingRow[]): number {
    if (!testSet.length) return 0;
    const correct = testSet.filter(r => {
      const fArr = this.featuresToArray(r.features);
      const preds = this.forest.map(t => this.predictTree(t, fArr));
      const avg = preds.reduce((s, v) => s + v, 0) / preds.length;
      return (avg >= 0.5 ? 1 : 0) === r.label;
    }).length;
    return correct / testSet.length;
  }

  private computeFeatureImportance(data: TrainingRow[]) {
    const names: (keyof MLFeatures)[] = [
      'adx','atrPct','bbWidth','choppiness','emaDist50','emaDist200',
      'hourUTC','dayOfWeek','sessionScore','confidenceRaw','sourceEncoded',
      'rrRatio','symbolWR30d','sourceWR30d','slDistPct','tpDistPct',
      'portfolioHeat','regime'
    ];
    const importance: Record<string, number> = {};
    const baseline = this.evaluate(data);
    for (let fi = 0; fi < names.length; fi++) {
      // Permute feature fi
      const permuted = data.map(r => {
        const fArr = this.featuresToArray(r.features);
        fArr[fi] = Math.random(); // destroy information
        return fArr;
      });
      const permAcc = data.filter((r, i) => {
        const preds = this.forest.map(t => this.predictTree(t, permuted[i]));
        const avg = preds.reduce((s, v) => s + v, 0) / preds.length;
        return (avg >= 0.5 ? 1 : 0) === r.label;
      }).length / data.length;
      importance[names[fi]] = Math.max(0, baseline - permAcc);
    }
    this.featureImportance = importance as any;
  }

  private loadFromDB() {
    try {
      const saved = this.db.getSetting('ml_model');
      if (!saved) return;
      const m = JSON.parse(saved);
      const trainedAt = Number(m?.trainedAt);
      if (
        Array.isArray(m?.forest) &&
        Number.isFinite(trainedAt) &&
        trainedAt > 0 &&
        Date.now() - trainedAt < 48 * 3_600_000
      ) {
        this.forest = m.forest.filter((tree: any) => this.isValidTree(tree));
        this.trained = this.forest.length > 0;
        this.lastTrain = trainedAt;
      }
    } catch {}
  }

  private isValidTree(node: any, depth = 0): boolean {
    if (!node || depth > 12) return false;
    if (node.prediction !== undefined) {
      return Number.isFinite(Number(node.prediction)) &&
        Number(node.prediction) >= 0 &&
        Number(node.prediction) <= 1 &&
        Number.isFinite(Number(node.samples));
    }
    if (
      !Number.isInteger(Number(node.featureIdx)) ||
      Number(node.featureIdx) < 0 ||
      Number(node.featureIdx) >= 18 ||
      !Number.isFinite(Number(node.threshold))
    ) {
      return false;
    }
    return this.isValidTree(node.left, depth + 1) &&
      this.isValidTree(node.right, depth + 1);
  }

  private bootstrapSample(data: TrainingRow[]): TrainingRow[] {
    return Array.from({ length: data.length }, () => data[Math.floor(Math.random() * data.length)]);
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  private encodeSource(source: string): number {
    const engines = ['TREND','RSI','BREAKOUT','STRUCTURE','MACD_DIV','ICHIMOKU','STOCH_RSI','VWAP'];
    const idx = engines.findIndex(e => source.includes(e));
    return idx >= 0 ? idx / (engines.length - 1) : 0.5;
  }

  private getSessionScore(hour: number): number {
    if (hour >= 22 || hour < 1) return 0;
    if (hour >= 13 && hour < 17) return 100;
    if (hour >= 8  && hour < 13) return 80;
    if (hour >= 17 && hour < 22) return 85;
    return 50;
  }

  private getSymbolWRAsOf(symbol: string, asOfMs: number): number {
    try {
      const cutoff = asOfMs - 30 * 24 * 3_600_000;
      const r = this.db.raw().prepare(`
        SELECT
          SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS wr
        FROM trades
        WHERE status='closed'
          AND symbol=?
          AND openedAt > ?
          AND openedAt < ?
      `).get(symbol, cutoff, asOfMs) as any;
      const value = Number(r?.wr);
      return Number.isFinite(value) ? value : 0.5;
    } catch {
      return 0.5;
    }
  }

  private getSourceWRAsOf(source: string, asOfMs: number): number {
    try {
      const primary = String(source ?? '').split('+')[0];
      const cutoff = asOfMs - 30 * 24 * 3_600_000;
      const r = this.db.raw().prepare(`
        SELECT
          SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS wr
        FROM trades
        WHERE status='closed'
          AND source LIKE ?
          AND openedAt > ?
          AND openedAt < ?
      `).get(`%${primary}%`, cutoff, asOfMs) as any;
      const value = Number(r?.wr);
      return Number.isFinite(value) ? value : 0.5;
    } catch {
      return 0.5;
    }
  }

  private getSymbolWR(symbol: string): number {
    try {
      const r = this.db.raw().prepare(`
        SELECT SUM(CASE WHEN profit>0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
        FROM trades WHERE status='closed' AND symbol=? AND openedAt > ?
      `).get(symbol, Date.now() - 30 * 24 * 3_600_000) as any;
      return r?.wr ?? 0.5;
    } catch { return 0.5; }
  }

  private getSourceWR(source: string): number {
    try {
      const primary = source.split('+')[0];
      const r = this.db.raw().prepare(`
        SELECT SUM(CASE WHEN profit>0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
        FROM trades WHERE status='closed' AND source LIKE ? AND openedAt > ?
      `).get(`%${primary}%`, Date.now() - 30 * 24 * 3_600_000) as any;
      return r?.wr ?? 0.5;
    } catch { return 0.5; }
  }
}
