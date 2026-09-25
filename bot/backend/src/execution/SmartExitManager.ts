/**
 * SMART EXIT MANAGER — v9.0
 * ══════════════════════════════════════════════════════════════════════════
 * يُعدّل الـ TP ديناميكياً بعد الدخول بناءً على:
 *
 *   1. Momentum Acceleration: إذا الزخم قوي → يُمدّد الـ TP
 *   2. Momentum Exhaustion: إذا الزخم يتباطأ → يُضيّق الـ TP
 *   3. RSI Extreme على M15: إذا وصل 80/20 → يُغلق 50% فوراً
 *   4. ADX Collapse: إذا ADX هبط من 30+ إلى < 20 → يُغلق الصفقة
 *   5. Opposite Consensus Signal: إذا جاءت إشارة معاكسة من 3+ استراتيجيات → يُغلق
 *
 * الفرق عن TrailingStop:
 *   TrailingStop يُحرّك الـ SL خلف السعر
 *   SmartExitManager يُعدّل الـ TP للأمام ويُقرر متى يُغلق فوراً
 * ══════════════════════════════════════════════════════════════════════════
 */
import { RSI, ADX, MACD }        from 'technicalindicators';
import { SystemConfig, Trade }   from '../types/trading.types';
import { DatabaseManager }       from '../database/DatabaseManager';
import { MarketScanner }         from '../core/MarketScanner';
import { calculateATR }          from '../utils/ATR';
import { Logger }                from '../utils/Logger';
import { ExecutionGateway }       from './ExecutionGateway';

export interface ExitDecision {
  action:  'HOLD' | 'CLOSE_FULL' | 'CLOSE_HALF' | 'EXTEND_TP';
  reason:  string;
  urgency: 'HIGH' | 'MEDIUM' | 'LOW';
}

export class SmartExitManager {
  private logger   = new Logger('SmartExit');
  private interval: NodeJS.Timeout | null = null;
  private checked  = new Map<number, number>(); // tradeId → lastCheckAt

  constructor(
    private config:  SystemConfig,
    private db:      DatabaseManager,
    private scanner: MarketScanner,
    private exec:    ExecutionGateway,
  ) {}

  start() {
    if (!this.interval)
      this.interval = setInterval(() => this.tick().catch(() => {}), 2 * 60_000); // every 2 min
    this.logger.info('SmartExitManager started');
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private async tick() {
    const open = this.db.getOpenTrades();
    for (const t of open) {
      if (!t.id) continue;
      // Throttle: check each trade max once per 5 minutes
      if (Date.now() - (this.checked.get(t.id) ?? 0) < 5 * 60_000) continue;
      this.checked.set(t.id, Date.now());

      try {
        const decision = await this.evaluate(t);
        if (decision.action !== 'HOLD') {
          await this.executeDecision(t, decision);
        }
      } catch (e: any) {
        this.logger.warn(`SmartExit ${t.symbol}: ${e.message}`);
      }
    }
    // Cleanup closed trades
    const openIds = new Set(open.map(t => t.id!));
    for (const id of this.checked.keys()) {
      if (!openIds.has(id)) this.checked.delete(id);
    }
  }

  private async evaluate(t: Trade): Promise<ExitDecision> {
    const [m15, h1] = await Promise.all([
      this.scanner.fetchCandles(t.symbol, 'M15', 100).catch(() => [] as any[]),
      this.scanner.fetchCandles(t.symbol, 'H1',  60).catch(() => [] as any[]),
    ]);

    if (!m15.length && !h1.length) return { action: 'HOLD', reason: 'No data', urgency: 'LOW' };

    const candles = h1.length >= 20 ? h1 : m15;
    const closes  = candles.map((c: any) => c.close);
    const highs   = candles.map((c: any) => c.high);
    const lows    = candles.map((c: any) => c.low);
    const price   = closes[closes.length - 1];

    const risk    = Math.abs(t.entry - t.sl);
    const profit  = t.side === 'BUY' ? price - t.entry : t.entry - price;
    const profit_R = risk > 0 ? profit / risk : 0;

    // ── 1. RSI Extreme Exit ───────────────────────────────────────────────
    if (m15.length >= 20) {
      const m15closes = m15.map((c: any) => c.close);
      const rsiVals   = RSI.calculate({ period: 14, values: m15closes });
      const rsi       = rsiVals[rsiVals.length - 1];

      if (rsi !== undefined && profit_R > 0.5) {
        if (t.side === 'BUY' && rsi > 80) {
          return { action: 'CLOSE_HALF', reason: `RSI overbought M15 (${rsi.toFixed(0)}) at ${profit_R.toFixed(1)}R profit`, urgency: 'MEDIUM' };
        }
        if (t.side === 'SELL' && rsi < 20) {
          return { action: 'CLOSE_HALF', reason: `RSI oversold M15 (${rsi.toFixed(0)}) at ${profit_R.toFixed(1)}R profit`, urgency: 'MEDIUM' };
        }
      }
    }

    // ── 2. ADX Collapse ───────────────────────────────────────────────────
    if (closes.length >= 30 && profit_R > 0.3) {
      try {
        const adxR   = ADX.calculate({ period: 14, close: closes, high: highs, low: lows });
        const curADX = adxR[adxR.length - 1]?.adx ?? 20;
        const prevADX = adxR[Math.max(0, adxR.length - 5)]?.adx ?? curADX;

        if (prevADX >= 28 && curADX < 18) {
          return {
            action: profit_R > 1.0 ? 'CLOSE_HALF' : 'HOLD',
            reason: `ADX collapsed ${prevADX.toFixed(0)} → ${curADX.toFixed(0)} — trend weakening`,
            urgency: 'MEDIUM',
          };
        }
      } catch {}
    }

    // ── 3. MACD Reversal ──────────────────────────────────────────────────
    if (closes.length >= 35 && profit_R > 1.0) {
      try {
        const macdR = MACD.calculate({
          values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
          SimpleMAOscillator: false, SimpleMASignal: false,
        });
        const prev = macdR[macdR.length - 3]?.histogram ?? 0;
        const curr = macdR[macdR.length - 1]?.histogram ?? 0;

        // MACD histogram flipping against trade direction at profit
        if (t.side === 'BUY' && prev > 0 && curr < 0) {
          return { action: 'CLOSE_HALF', reason: `MACD crossed bearish at ${profit_R.toFixed(1)}R`, urgency: 'MEDIUM' };
        }
        if (t.side === 'SELL' && prev < 0 && curr > 0) {
          return { action: 'CLOSE_HALF', reason: `MACD crossed bullish at ${profit_R.toFixed(1)}R`, urgency: 'MEDIUM' };
        }
      } catch {}
    }

    // ── 4. TP Extension: strong momentum ──────────────────────────────────
    if (profit_R >= 2.0) {
      const atr    = calculateATR(candles, 14);
      const roc3   = closes.length >= 4
        ? Math.abs(closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]
        : 0;

      if (roc3 > atr / closes[closes.length - 1] * 2) {
        // Price moving fast → extend TP
        const currentTP = t.tp;
        const newTP     = t.side === 'BUY'
          ? currentTP + atr * 0.5
          : currentTP - atr * 0.5;
        return { action: 'EXTEND_TP', reason: `Strong momentum at ${profit_R.toFixed(1)}R — extending TP`, urgency: 'LOW' };
      }
    }

    // ── 5. Time-based exit: trade too old without progress ────────────────
    const ageHours = (Date.now() - t.openedAt) / 3_600_000;
    if (ageHours > 48 && profit_R < 0.3 && profit_R > -0.5) {
      return { action: 'CLOSE_FULL', reason: `Trade ${ageHours.toFixed(0)}h old with minimal progress — time exit`, urgency: 'LOW' };
    }

    return { action: 'HOLD', reason: 'All checks passed', urgency: 'LOW' };
  }

  private async executeDecision(t: Trade, decision: ExitDecision) {
    this.logger.info(`[${t.symbol}] SmartExit: ${decision.action} — ${decision.reason}`);

    const candles = await this.scanner.fetchCandles(t.symbol, 'M1', 2).catch(() => []);
    const exitPrice = candles.length ? candles[candles.length - 1].close : t.entry;

    switch (decision.action) {
      case 'CLOSE_FULL': {
        const result=await this.exec.closeAtMarket(t,exitPrice,'MANUAL');
        if(!result.ok) throw new Error(`Full exit failed for ${t.symbol}`);
        this.logger.info(`[${t.symbol}] Smart exit full close executed`);
        break;
      }

      case 'CLOSE_HALF': {
        const volume=+(t.volume*0.5).toFixed(8);
        const result=await this.exec.closePartial(t,volume,exitPrice,'SMART_EXIT_HALF');
        if(!result.ok) throw new Error(`Partial exit failed for ${t.symbol}`);
        this.logger.info(`[${t.symbol}] Smart exit half close executed; remaining=${result.remainingVolume}`);
        break;
      }

      case 'EXTEND_TP': {
        const h1=await this.scanner.fetchCandles(t.symbol,'H1',50).catch(() => []);
        if(!h1.length) return;
        const atr=calculateATR(h1,14);
        if(!(atr>0)) return;
        const newTP=t.side==='BUY' ? t.tp+atr*0.5 : t.tp-atr*0.5;
        const better=t.side==='BUY' ? newTP>t.tp : newTP<t.tp;
        if(!better) return;
        const ok=await this.exec.modifySLTP(t,t.sl,newTP);
        if(!ok) throw new Error(`TP modification failed for ${t.symbol}`);
        break;
      }
    }
  }

}
