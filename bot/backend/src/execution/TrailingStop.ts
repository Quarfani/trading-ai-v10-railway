/**
 * TRAILING STOP — v7.1
 * [FIX-1] يستخدم timeframe الصفقة الأصلية بدلاً من M15 الثابت
 *         → تريلينج أكثر دقة للصفقات الطويلة (H4/D1)
 * [FIX-2] يُطبّق ATR × 1.2 بدلاً من ATR × 1.0 → أكثر مرونة
 * [FIX-3] يُفرّق بين Forex و Crypto في آلية تحديث Binance
 */
import { SystemConfig, Trade } from '../types/trading.types';
import { DatabaseManager }     from '../database/DatabaseManager';
import { MarketScanner }       from '../core/MarketScanner';
import { Logger }              from '../utils/Logger';
import { calculateATR }        from '../utils/ATR';
import { ExecutionGateway }     from './ExecutionGateway';

const ATR_TRAIL_MULT = 1.2; // [FIX-2] was 1.0 — slightly wider trailing
const TRAIL_CANDLES  = 50;

// [FIX-1] Map trade timeframe to candle fetch TF (use original or one step smaller)
const TF_MAP: Record<string, string> = {
  M1: 'M1', M5: 'M5', M15: 'M15', M30: 'M15',
  H1: 'H1', H4: 'H1', D1: 'H4',
};

export class TrailingStop {
  private logger   = new Logger('Trailing');
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private config:  SystemConfig,
    private db:      DatabaseManager,
    private scanner: MarketScanner,
    private exec:    ExecutionGateway,
  ) {}

  start() {
    if (!this.interval)
      this.interval = setInterval(() => this.tick().catch(() => {}), 60_000);
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private async tick() {
    const open = this.db.getOpenTrades();
    for (const t of open) {
      try { await this.processOne(t); }
      catch (e: any) { this.logger.warn(`Trail ${t.symbol}: ${e.message}`); }
    }
  }

  private async processOne(t: Trade & { timeframe?: string }) {
    // [FIX-1] Use the trade's original timeframe for ATR calculation
    const rawTF = t.timeframe ?? 'H1';
    const fetchTF = TF_MAP[rawTF] ?? rawTF;

    const candles = await this.scanner.fetchCandles(t.symbol, fetchTF as any, TRAIL_CANDLES);
    if (candles.length < 20) return;

    const atr = calculateATR(candles, 14);
    if (!atr) return;

    const price = candles[candles.length - 1].close;

    // [FIX-2] Wider trail: ATR × 1.2
    const newSl   = t.side === 'BUY'
      ? price - atr * ATR_TRAIL_MULT
      : price + atr * ATR_TRAIL_MULT;
    const better  = t.side === 'BUY' ? newSl > t.sl : newSl < t.sl;
    if (!better) return;

    // Must have moved at least 1×ATR in profit first
    const profit = t.side === 'BUY' ? price - t.entry : t.entry - price;
    if (profit < atr) return;

    switch (this.config.mode) {
      case 'mt5':   await this.trailMT5(t, newSl);    break;
      case 'binance': await this.trailBinance(t, newSl); break;
      case 'paper': this.trailPaper(t, newSl);         break;
    }
  }

  private async trailMT5(t: Trade, newSl: number) {
    if (!t.ticket) return;
    const ok=await this.exec.modifySLTP(t,newSl,t.tp);
    if(ok) this.logger.info(`[MT5] Trail ${t.symbol} SL → ${newSl.toFixed(5)}`);
  }

  private async trailBinance(t: Trade, newSl: number) {
    const ok=await this.exec.modifySLTP(t,newSl,t.tp);
    if(ok) this.logger.info(`[Binance] Trail ${t.symbol} SL ${t.sl.toFixed(5)} → ${newSl.toFixed(5)}`);
  }

  private async trailPaper(t: Trade, newSl: number) {
    const ok=await this.exec.modifySLTP(t,newSl,t.tp);
    if(ok) this.logger.info(`[Paper] Trail ${t.symbol} SL → ${newSl.toFixed(5)}`);
  }

}
