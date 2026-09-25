/**
 * SPREAD ADJUSTMENT UTILITY — v9.0
 * ══════════════════════════════════════════════════════════════════════════
 * [مشكلة حقيقية] الـ SL/TP الحالية لا تأخذ بعين الاعتبار الـ Spread.
 *
 * مثال على المشكلة:
 *   BUY EURUSD @ 1.10000 | Spread = 1 pip = 0.00010
 *   SL = 1.09850 (15 pips)
 *   الفعلي: الوسيط يُنفّذ عند BID = 1.10010
 *           SL يُضرب عند BID = 1.09850 → خسارة = 16 pips (ليس 15)
 *
 * الإصلاح:
 *   - SL يُبعد بمقدار spread إضافي من نقطة الدخول
 *   - TP يُقرّب بمقدار spread لضمان الوصول
 *
 * ══════════════════════════════════════════════════════════════════════════
 *
 * GAP PROTECTION — v9.0
 * ══════════════════════════════════════════════════════════════════════════
 * [مشكلة حقيقية] Gaps الأسبوع (الأحد فجراً) يمكن أن تتجاوز الـ SL.
 *
 * الحل:
 *   - قبل اغلاق السوق (الجمعة 21:00 UTC) → تضييق SL تلقائياً
 *   - بعد فتح السوق (الأحد 22:00 UTC) → إعادة فحص الصفقات المفتوحة
 *   - إذا السعر تجاوز SL بسبب Gap → إغلاق فوري بسعر السوق
 * ══════════════════════════════════════════════════════════════════════════
 */
import { Signal, Trade, SystemConfig } from '../types/trading.types';
import { getSymbolSpec }               from '../config/symbolConfig';
import { Logger }                      from '../utils/Logger';

export class SpreadAdjustment {
  private logger = new Logger('SpreadAdj');

  /**
   * Adjust SL/TP of a signal to account for spread.
   * Call this AFTER signal generation, BEFORE execution.
   */
  adjust(signal: Signal, bidAskSpread: number): Signal {
    const spec   = getSymbolSpec(signal.symbol);
    const spread = bidAskSpread; // in price units (e.g. 0.00010 for EURUSD)

    let { sl, tp } = signal;

    if (signal.side === 'BUY') {
      // We enter at ASK (higher) → SL at BID → SL needs to be lower by spread
      sl = sl - spread;
      // TP triggers at ASK → TP needs to be higher by spread for broker to fill
      tp = tp + spread * 0.5; // add half spread (conservative)
    } else {
      // We enter at BID (lower) → SL at ASK → SL needs to be higher by spread
      sl = sl + spread;
      // TP triggers at BID → needs to be lower by spread
      tp = tp - spread * 0.5;
    }

    // Sanity check: SL still on correct side
    const slOk = signal.side === 'BUY' ? sl < signal.price : sl > signal.price;
    const tpOk = signal.side === 'BUY' ? tp > signal.price : tp < signal.price;

    if (!slOk || !tpOk) {
      this.logger.warn(`Spread adj invalid for ${signal.symbol} — using original`);
      return signal;
    }

    return { ...signal, sl, tp };
  }
}

export class GapProtection {
  private logger = new Logger('GapProtect');

  /**
   * Check if current time is near market close (Friday) → tighten SL
   * Returns new SL (tighter) or original SL if not near weekend
   */
  adjustForWeekendRisk(trade: Trade, currentPrice: number): number {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();

    // Friday 18:00–21:00 UTC → approaching weekend
    const nearWeekendClose = day === 5 && hour >= 18 && hour < 21;
    if (!nearWeekendClose) return trade.sl;

    const risk    = Math.abs(trade.entry - trade.sl);
    const profit  = trade.side === 'BUY'
      ? currentPrice - trade.entry
      : trade.entry - currentPrice;
    const profit_R = risk > 0 ? profit / risk : 0;

    // If in profit → tighten SL to lock in at least 30% of current profit
    if (profit_R >= 0.5) {
      const lockProfit = profit * 0.30;
      const newSl      = trade.side === 'BUY'
        ? currentPrice - Math.abs(trade.entry - trade.sl) + lockProfit
        : currentPrice + Math.abs(trade.entry - trade.sl) - lockProfit;

      const better = trade.side === 'BUY' ? newSl > trade.sl : newSl < trade.sl;
      if (better) {
        this.logger.info(
          `[${trade.symbol}] Weekend gap protection: SL tightened ` +
          `${trade.sl.toFixed(5)} → ${newSl.toFixed(5)} (locked ${(profit_R * 30).toFixed(0)}% profit)`
        );
        return newSl;
      }
    }

    return trade.sl;
  }

  /**
   * After market open on Sunday → check if gap jumped over SL
   * Returns true if trade should be closed immediately
   */
  gapJumpedSL(trade: Trade, openPrice: number): boolean {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();

    // Sunday 22:00–23:59 or Monday 00:00–01:00 (market open window)
    const isMarketOpen = (day === 0 && hour >= 22) || (day === 1 && hour < 1);
    if (!isMarketOpen) return false;

    // BUY: if current price is below SL → gap down
    if (trade.side === 'BUY' && openPrice < trade.sl) {
      this.logger.warn(`[${trade.symbol}] GAP: price gapped below SL (${openPrice} < ${trade.sl}) — close immediately`);
      return true;
    }

    // SELL: if current price is above SL → gap up
    if (trade.side === 'SELL' && openPrice > trade.sl) {
      this.logger.warn(`[${trade.symbol}] GAP: price gapped above SL (${openPrice} > ${trade.sl}) — close immediately`);
      return true;
    }

    return false;
  }
}
