/**
 * ML CLIENT — v2.0
 * FIX BUG-C1: Auth header was wrong on two counts:
 *   1. Header name was 'X-Api-Key' — server expects 'Authorization: Bearer ...'
 *   2. Env var was MT5_BRIDGE_API_KEY — should be ML_SERVER_API_KEY
 * Result of original bug: every /predict call returned 401 and the bot
 * silently degraded to NO_TRADE for ALL ML signals.
 */
import axios, { AxiosInstance } from 'axios';
import { Candle }               from '../types/trading.types';
import { Logger }               from '../utils/Logger';

export interface MLPrediction {
  prob_buy:    number;
  prob_sell:   number;
  signal:      'BUY' | 'SELL' | 'NO_TRADE';
  confidence:  number;
  has_model:   boolean;
}

export interface OptimizedParams {
  ema_fast:   number;
  ema_slow:   number;
  rsi_period: number;
  rsi_low:    number;
  rsi_high:   number;
  atr_mult:   number;
  tp_ratio:   number;
  adx_min:    number;
}

export class MLClient {
  private logger      = new Logger('MLClient');
  private http:       AxiosInstance;
  private alive       = false;
  private lastCheck   = 0;
  private paramsCache = new Map<string, { params: OptimizedParams; ts: number }>();

  constructor() {
    const base   = process.env.ML_SERVER_URL   ?? 'http://127.0.0.1:5001';
    // FIX BUG-C1: use ML_SERVER_API_KEY (not MT5_BRIDGE_API_KEY)
    //             and send as 'Authorization: Bearer ...' (not 'X-Api-Key')
    const apiKey = process.env.ML_SERVER_API_KEY ?? '';

    this.http = axios.create({
      baseURL: base,
      timeout: 3_000,
      headers: apiKey
        ? { Authorization: `Bearer ${apiKey}` }
        : {},   // no header when key not configured (dev/local)
    });
  }

  async isAvailable(): Promise<boolean> {
    // /health is public — does not require auth token
    if (Date.now() - this.lastCheck < 60_000) return this.alive;
    try {
      await this.http.get('/health');
      this.alive = true;
    } catch {
      this.alive = false;
    }
    this.lastCheck = Date.now();
    return this.alive;
  }

  async predict(
    symbol:    string,
    timeframe: string,
    candles:   Candle[],
    candlesH4?: Candle[],
  ): Promise<MLPrediction | null> {
    if (!(await this.isAvailable())) return null;
    try {
      const body: Record<string, unknown> = {
        symbol, timeframe,
        candles: candles.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]),
      };
      if (candlesH4?.length) {
        body.candles_h4 = candlesH4.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]);
      }
      const r = await this.http.post('/predict', body);
      return r.data as MLPrediction;
    } catch {
      this.alive = false;
      this.lastCheck = Date.now();
      return null;
    }
  }

  async getOptimizedParams(symbol: string, tf: string): Promise<OptimizedParams | null> {
    const key    = `${symbol}_${tf}`;
    const cached = this.paramsCache.get(key);
    if (cached && Date.now() - cached.ts < 6 * 3_600_000) return cached.params;

    if (!(await this.isAvailable())) return null;
    try {
      const r = await this.http.get(`/params/${symbol}/${tf}`);
      const params = r.data?.params as OptimizedParams | undefined;
      if (!params || !Object.keys(params).length) return null;
      this.paramsCache.set(key, { params, ts: Date.now() });
      return params;
    } catch { return null; }
  }

  async recordTradeClosed(
    symbol:       string,
    timeframe:    string,
    profit:       number,
    signal:       number,
    entryCandles: Candle[],
  ): Promise<void> {
    if (!(await this.isAvailable())) return;
    try {
      await this.http.post('/record_trade', {
        symbol, timeframe, profit, signal,
        entry_candles: entryCandles.map(c =>
          [c.time, c.open, c.high, c.low, c.close, c.volume]),
      });
    } catch { /* non-critical — ignore */ }
  }
}
