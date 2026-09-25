/**
 * ML ENHANCER v2 — uses pre-trained model from historical data
 * يستخدم النموذج المدرَّب على البيانات التاريخية لتحسين الإشارات
 */
import { Signal, Candle }        from '../types/trading.types';
import { MLTrainingPipeline }    from './MLTrainingPipeline';
import { DatabaseManager }       from '../database/DatabaseManager';
import { Logger }                from '../utils/Logger';

export class MLEnhancerV2 {
  private logger   = new Logger('MLEnhancerV2');
  private pipeline: MLTrainingPipeline;
  private trained  = false;

  constructor(private db: DatabaseManager) {
    this.pipeline = new MLTrainingPipeline(db);
  }

  async initialize(): Promise<void> {
    if (this.pipeline.needsTraining()) {
      this.logger.info('Training ML model on available trade history...');
      const r = await this.pipeline.train();
      this.trained = r.ok;
      if (r.ok) {
        this.logger.info(`ML trained: ${r.samples} samples, ${(r.accuracy*100).toFixed(1)}% accuracy`);
      } else {
        this.logger.warn(`ML training: ${r.samples} samples (need 30+) — using neutral multiplier`);
      }
    } else {
      this.trained = true;
    }
  }

  async enhance(
    signal:    Signal,
    candles:   Candle[],
    h4Candles: Candle[],
    tf:        string,
  ): Promise<Signal> {
    if (!this.trained) return signal;

    try {
      const features = this.pipeline.extractFeatures(
        signal.symbol, signal.side, signal.price,
        signal.sl, signal.tp, signal.confidence,
        signal.source, candles, signal.regime ?? 'UNKNOWN', 0.02,
      );

      const { winProbability, confidence: mlConf } = this.pipeline.predict(features);

      // Only adjust if ML is confident
      if (mlConf < 0.3) return signal; // ML not confident enough → don't adjust

      // Blend ML probability with signal confidence
      const blend = 0.30; // 30% ML weight, 70% signal weight
      const newConf = signal.confidence * (1 - blend) + winProbability * blend;

      // Add ML info to reason
      const mlTag = `[ML:wp=${(winProbability*100).toFixed(0)}%,conf=${(mlConf*100).toFixed(0)}%]`;

      return {
        ...signal,
        confidence: Math.max(0.30, Math.min(0.95, newConf)),
        reason: `${signal.reason} ${mlTag}`,
      };
    } catch (e: any) {
      this.logger.warn(`ML enhance error: ${e.message}`);
      return signal;
    }
  }
}
