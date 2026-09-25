/**
 * NVIDIA AI — CONNECTED TO PIPELINE
 * يُستخدم الآن فعلياً في SignalAggregator لتعديل الـ confidence
 * بدلاً من أن يكون disconnected
 *
 * FIX: cache key previously used only symbol+side+price, so two signals
 * with the same price but different SL/TP (completely different risk
 * profiles) returned the same cached score.  Key now includes sl and tp.
 */
import axios from 'axios';
import { Signal, SystemConfig } from '../types/trading.types';
import { Logger } from '../utils/Logger';

export class NvidiaAI {
  private logger    = new Logger('NvidiaAI');
  private cache     = new Map<string, { mul: number; ts: number }>();
  private readonly CACHE_TTL = 300_000; // 5 min cache

  constructor(private config: SystemConfig) {}

  /**
   * Returns confidence multiplier 0.7..1.3
   * Called from TradingEngine before executing a signal.
   *
   * Cache key: symbol + side + price + sl + tp
   * Each unique risk profile gets its own cached score.
   */
  async scoreSignal(s: Signal): Promise<number> {
    if (!this.config.nvidia?.apiKey) return 1.0;

    // FIX: include sl and tp in key — different risk profiles must not share scores
    const cacheKey = [
      s.symbol,
      s.side,
      s.price.toFixed(4),
      s.sl.toFixed(4),
      s.tp.toFixed(4),
    ].join('_');

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) return cached.mul;

    const rr = s.sl > 0
      ? Math.abs(s.tp - s.price) / Math.abs(s.price - s.sl)
      : 0;

    const prompt =
      `You are a strict trading risk reviewer. Rate this signal 0..10 (10 = strongest conviction).\n` +
      `Symbol: ${s.symbol}\nSide: ${s.side}\nPrice: ${s.price}\n` +
      `SL: ${s.sl}  (${(Math.abs(s.price - s.sl) / s.price * 100).toFixed(3)}% risk)\n` +
      `TP: ${s.tp}  (${(Math.abs(s.tp - s.price) / s.price * 100).toFixed(3)}% reward)\n` +
      `R:R ratio: ${rr.toFixed(2)}\n` +
      `Source: ${s.source}\nReason: ${s.reason}\n` +
      `Confidence: ${(s.confidence * 100).toFixed(0)}%\n\n` +
      `Consider: trend alignment, risk/reward ratio, signal clarity.\n` +
      `Reply with ONLY a single integer 0-10. No explanation.`;

    try {
      const r = await axios.post(
        `${this.config.nvidia?.baseUrl ?? ''}/chat/completions`,
        {
          model:       this.config.nvidia?.model ?? '',
          messages:    [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens:  5,
        },
        {
          headers: { Authorization: `Bearer ${this.config.nvidia?.apiKey ?? ''}` },
          timeout: 10_000,
        },
      );

      const txt   = (r.data.choices?.[0]?.message?.content ?? '5').trim();
      const score = Math.max(0, Math.min(10, Number((txt.match(/\d+/) ?? ['5'])[0])));
      // Map 0-10 → 0.70-1.30
      const mul   = 0.70 + (score / 10) * 0.60;

      this.cache.set(cacheKey, { mul, ts: Date.now() });
      this.logger.debug(
        `NvidiaAI ${s.symbol} ${s.side} RR=${rr.toFixed(2)}: ` +
        `score=${score}/10 → mul=${mul.toFixed(2)}`
      );
      return mul;

    } catch (e: any) {
      this.logger.warn(`NvidiaAI fallback (${e.message})`);
      return 1.0;
    }
  }
}
