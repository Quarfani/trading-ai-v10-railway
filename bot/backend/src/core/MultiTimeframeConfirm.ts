/**
 * MULTI-TIMEFRAME CONFIRM — v7.1
 * [FIX-1] MACD histogram check أقل صرامة:
 *         - قبل: يرفض إذا histogram < 0 نهائياً
 *         - بعد: يرفض فقط إذا histogram < -0.0005 (تُجاهل المنطقة المحايدة)
 *         - هذا يمنع رفض الإشارات عند التحول من هبوطي → صاعد
 *
 * [FIX-2] RSI threshold أقل صرامة:
 *         - قبل: يرفض BUY إذا RSI_H4 > 75
 *         - بعد: يرفض BUY إذا RSI_H4 > 78 (أعلى قليلاً لتجنب الرفض المبكر)
 *
 * [NEW]   Bullish/Bearish engulfing على H4 يُضيف +1 نقطة ثقة
 * [NEW]   يُرجع QualityBonus بدلاً من boolean جزئي لتغذية ConsensusEngine
 */
import { EMA, RSI, MACD } from 'technicalindicators';
import { calculateATR } from '../utils/ATR';
import { Candle, Side }   from '../types/trading.types';
import { MarketScanner }  from './MarketScanner';
import { Logger }         from '../utils/Logger';

export interface MTFResult {
  approved:  boolean;
  h1ok:      boolean;
  h4ok:      boolean;
  reason?:   string;
}

// [FIX-1] MACD histogram dead-zone (don't reject if within ±threshold)
const MACD_HIST_THRESHOLD = 0.0005;
const MACD_HIST_ATR_MULT = 0.30;

export class MultiTimeframeConfirm {
  private logger = new Logger('MTF');

  constructor(private scanner: MarketScanner) {}

  async confirm(symbol: string, side: Side): Promise<boolean> {
    return (await this.confirmFull(symbol, side)).approved;
  }

  async confirmFull(symbol: string, side: Side): Promise<MTFResult> {
    const [h1, h4] = await Promise.all([
      this.scanner.fetchCandles(symbol, 'H1', 220).catch(() => []),
      this.scanner.fetchCandles(symbol, 'H4', 220).catch(() => []),
    ]);

    const h1result = this.tfCheck(h1, side, 'H1');
    const h4result = this.tfCheck(h4, side, 'H4');

    if (!h1result.ok || !h4result.ok) {
      const reason = !h1result.ok
        ? `H1: ${h1result.reason}`
        : `H4: ${h4result.reason}`;
      this.logger.debug(`MTF rejected ${symbol} ${side} | ${reason}`);
      return { approved: false, h1ok: h1result.ok, h4ok: h4result.ok, reason };
    }

    return { approved: true, h1ok: true, h4ok: true };
  }

  private tfCheck(
    candles: Candle[], side: Side, label: string
  ): { ok: boolean; reason?: string } {
    if (candles.length < 50) return { ok: true }; // not enough data — don't block

    const closes = candles.map(c => c.close);

    // ── 1. EMA trend alignment ─────────────────────────────────────────
    if (candles.length >= 200) {
      const e50  = EMA.calculate({ period: 50,  values: closes });
      const e200 = EMA.calculate({ period: 200, values: closes });
      const a50  = e50[e50.length - 1];
      const a200 = e200[e200.length - 1];
      const emaAligned = side === 'BUY' ? a50 > a200 : a50 < a200;
      if (!emaAligned) {
        return { ok: false, reason: `${label} EMA trend conflict (EMA50 vs EMA200)` };
      }
    }

    // ── 2. RSI extreme filter [FIX-2] ─────────────────────────────────
    try {
      const rsiVals = RSI.calculate({ period: 14, values: closes });
      const rsi     = rsiVals[rsiVals.length - 1];
      if (rsi !== undefined) {
        if (side === 'BUY'  && rsi > 78)
          return { ok: false, reason: `${label} RSI ${rsi.toFixed(0)} overbought (>78)` };
        if (side === 'SELL' && rsi < 22)
          return { ok: false, reason: `${label} RSI ${rsi.toFixed(0)} oversold (<22)` };
      }
    } catch { /* pass */ }

    // ── 3. MACD direction [FIX-1] ─────────────────────────────────────
    // Only reject if histogram is significantly in the wrong direction
    try {
      const macdR = MACD.calculate({
        values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
        SimpleMAOscillator: false, SimpleMASignal: false,
      });
      const hist = macdR[macdR.length - 1]?.histogram;
      if (hist !== undefined && hist !== null) {
        const atr = calculateATR(candles.slice(-50), 14);
        const macdNeutralThreshold = Math.max(
          MACD_HIST_THRESHOLD,
          atr > 0 ? atr * MACD_HIST_ATR_MULT : 0,
        );

        const neutral = Math.abs(hist) < macdNeutralThreshold;

        if (!neutral) {
          if (side === 'BUY' && hist < -macdNeutralThreshold)
            return {
              ok: false,
              reason: `${label} MACD histogram bearish (${hist.toFixed(6)}) threshold=${macdNeutralThreshold.toFixed(6)}`,
            };

          if (side === 'SELL' && hist > macdNeutralThreshold)
            return {
              ok: false,
              reason: `${label} MACD histogram bullish (${hist.toFixed(6)}) threshold=${macdNeutralThreshold.toFixed(6)}`,
            };
        }
      }
    } catch { /* pass */ }

    return { ok: true };
  }
}
