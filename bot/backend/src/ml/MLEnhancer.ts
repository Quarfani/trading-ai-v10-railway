import axios from 'axios';
import crypto from 'crypto';
import { Signal, Candle, SystemConfig } from '../types/trading.types';
import { DatabaseManager } from '../database/DatabaseManager';
import { Logger } from '../utils/Logger';

interface MLResponse {
  signal: string;
  prob_buy: number;
  prob_sell: number;
  prob_hold: number;
  confidence: number;
  has_model: boolean;
  latency_ms: number;
  model: string;
  model_version?: string;
  prompt_version?: string;
  prediction_id?: string;
}

export class MLEnhancer {
  private logger = new Logger('MLEnhancer');
  private available = false;
  private cache = new Map<string, { result: Signal; ts: number }>();
  private readonly url: string;
  private readonly apiKey: string;
  private readonly enabled: boolean;
  private readonly required: boolean;

  constructor(private config: SystemConfig, private db: DatabaseManager) {
    this.url = process.env.ML_SERVER_URL ?? 'http://localhost:5001';
    this.apiKey = process.env.ML_SERVER_API_KEY ?? '';
    this.enabled = process.env.ML_ENABLED !== 'false';
    this.required = config.mlRequired || config.mode !== 'paper';
    if (this.enabled) {
      void this.checkHealth();
      setInterval(() => void this.checkHealth(), 60_000).unref?.();
    }
    if (this.required && !this.apiKey && process.env.ML_SERVER_ALLOW_ANONYMOUS !== 'true') {
      this.logger.warn('ML_REQUIRED=true without ML_SERVER_API_KEY and anonymous access disabled; trading will remain blocked');
    }
  }

  async enhance(signal: Signal, candles: Candle[], h4Candles: Candle[], tf: string): Promise<Signal> {
    if (!this.enabled) {
      if (this.required) throw new Error('ML is required in live/testnet modes or ML_REQUIRED=true, but ML_ENABLED=false');
      return signal;
    }
    if (!this.available) {
      if (this.required) throw new Error(`ML unavailable in fail-closed mode: ${this.url}`);
      return signal;
    }

    const cacheKey = `${signal.symbol}_${signal.side}_${tf}_${signal.timestamp}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 60_000) return cached.result;

    const started = Date.now();
    try {
      const payload = {
        symbol: signal.symbol,
        timeframe: tf,
        candles: candles.slice(-100).map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]),
        h4_candles: h4Candles.slice(-100).map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]),
      };
      const inputHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const res = await axios.post<MLResponse>(`${this.url}/predict`, payload, {
        timeout: 3_000,
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      });
      const ml = res.data;
      const predictionId =
        String(ml.prediction_id ?? '').trim() ||
        crypto.randomUUID();

      const predictedLabel: -1 | 0 | 1 =
        ml.signal === 'BUY' ? 1 :
        ml.signal === 'SELL' ? -1 : 0;

      this.recordDecision({
        predictionId,
        timeframe: tf,
        predictedLabel,
        symbol: signal.symbol, modelName: ml.model, modelVersion: ml.model_version ?? '',
        promptVersion: ml.prompt_version ?? '', inputHash, output: ml, latencyMs: Date.now() - started,
        decision: ml.signal,
      });

      if (!ml.has_model) {
        if (this.required) throw new Error(`ML model unavailable for ${signal.symbol}/${tf}`);
        return signal;
      }
      const probabilities = [
        Number(ml.prob_buy),
        Number(ml.prob_sell),
        Number(ml.prob_hold),
      ];
      if (
        !['BUY','SELL','HOLD'].includes(ml.signal) ||
        ![ml.confidence, ...probabilities].every(
          value => Number.isFinite(value),
        ) ||
        ml.confidence < 0 ||
        ml.confidence > 1 ||
        probabilities.some(value => value < 0 || value > 1) ||
        Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) > 0.02 ||
        ml.has_model !== true
      ) {
        throw new Error('ML response failed schema/range validation');
      }

      const mlSignal = ml.signal as 'BUY' | 'SELL' | 'HOLD';
      let newConf = signal.confidence;
      if (mlSignal === signal.side) newConf = Math.min(0.95, signal.confidence + ml.confidence * 0.10);
      else if (mlSignal !== 'HOLD') newConf = Math.max(0.30, signal.confidence - ml.confidence * 0.15);

      const enhanced: Signal = {
        ...signal,
        mlPredictionId: predictionId,
        confidence: +newConf.toFixed(4),
        reason: `${signal.reason} [ML:${ml.model} p${signal.side}=${(signal.side === 'BUY' ? ml.prob_buy : ml.prob_sell).toFixed(2)}]`,
      };
      this.cache.set(cacheKey, { result: enhanced, ts: Date.now() });
      return enhanced;
    } catch (e: any) {
      const message = e?.message ?? String(e);
      if (this.required) throw new Error(`ML_REQUIRED blocked trade: ${message}`);
      this.available = false;
      this.logger.warn(`ML unavailable — advisory layer skipped: ${message}`);
      return signal;
    }
  }

  async recordOutcome(
    symbol: string,
    timeframe: string,
    profit: number,
    signal: number,
    candles: Candle[],
    predictionId?: string,
    predictedSignal?: number,
  ): Promise<void> {
    if (!this.enabled || !this.available || this.required === false && process.env.ML_ONLINE_LEARNING_ENABLED !== 'true') return;
    try {
      await axios.post(`${this.url}/record_trade`, {
        symbol,
        timeframe,
        profit,
        signal,
        ...(predictionId ? { prediction_id: predictionId } : {}),
        ...(predictedSignal !== undefined ? { predicted_signal: predictedSignal } : {}),
        entry_candles: candles.slice(-60).map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]),
      }, { timeout: 2_000, headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {} });
    } catch (e: any) {
      this.logger.warn(`ML outcome recording failed: ${e?.message ?? e}`);
    }
  }

  private async checkHealth(): Promise<void> {
    try {
      const r = await axios.get(`${this.url}/health`, {
        timeout: 2_000,
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      });
      this.available = r.data?.ok === true;
    } catch {
      this.available = false;
    }
  }

  private recordDecision(d: {
    predictionId: string;
    timeframe: string;
    predictedLabel: -1 | 0 | 1;
    symbol: string; modelName: string; modelVersion: string; promptVersion: string;
    inputHash: string; output: unknown; latencyMs: number; decision: string;
  }) {
    try {
      this.db.raw().prepare(`
        INSERT INTO model_decisions(
          predictionId,modelName,modelVersion,promptVersion,inputHash,output,
          latencyMs,decision,symbol,timestamp,timeframe,predictedLabel
        )
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        d.predictionId,
        d.modelName,
        d.modelVersion,
        d.promptVersion,
        d.inputHash,
        JSON.stringify(d.output),
        d.latencyMs,
        d.decision,
        d.symbol,
        Date.now(),
        d.timeframe,
        d.predictedLabel,
      );
    } catch (e) {
      // A model audit write is important, but a transient DB issue must still not
      // silently permit a required-ML trade.
      this.logger.error(`ML audit write failed: ${String(e)}`);
      if (this.required) throw e;
    }
  }

  isAvailable(): boolean { return this.available; }
  getServerUrl(): string { return this.url; }
}
