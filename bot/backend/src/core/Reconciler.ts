/**
 * RECONCILER — v9.1
 * ════════════════════════════════════════════════════════════════════
 * [FIX] يتعامل مع Partial Closes بشكل صحيح
 * [FIX] MT5: يُقارن فعلياً بـ open positions (لا closed orders)
 * [FIX] Binance: يتحقق من position size
 * [FIX] يُطلق onClose callback مع exitPrice الفعلي
 * [FIX v9.1] Paper/Binance reconcile كانت تُجبر 'M1' على جميع الصفقات.
 *            الآن تستخدم الـ timeframe الفعلي للصفقة (مخزون في t.timeframe).
 *            هذا يمنع اصطياد SL/TP وهمي بسبب ضوضاء دقيقة في صفقات H4.
 * ════════════════════════════════════════════════════════════════════
 */
import axios                           from 'axios';
import { SystemConfig, Trade }         from '../types/trading.types';
import { DatabaseManager }             from '../database/DatabaseManager';
import { ExecutionGateway }            from '../execution/ExecutionGateway';
import { TelegramBot }                 from '../notifications/TelegramBot';
import { PerformanceTracker }          from '../analytics/PerformanceTracker';
import { MarketScanner }               from './MarketScanner';
import { Logger }                      from '../utils/Logger';
import { EmergencyStop }               from '../integration/EmergencyStop';

type ClosedCallback = (trade: Trade & { exitPrice?: number }) => void;

/**
 * Map the trade's timeframe string to the scanner's Timeframe type.
 * Falls back to 'M5' which is a safe minimum — fine-grained enough
 * to detect SL/TP hits without the noise of M1.
 */
function tradeTimeframe(t: Trade): string {
  // t.timeframe is the TF the signal came from (e.g. 'H4', 'H1', 'M15')
  return (t as any).timeframe ?? 'M5';
}

/** How many candles to fetch when checking for SL/TP hits. */
const CHECK_CANDLES = 3;

export class Reconciler {
  private logger   = new Logger('Reconciler');
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private config:    SystemConfig,
    private db:        DatabaseManager,
    private exec:      ExecutionGateway,
    private telegram:  TelegramBot,
    private tracker:   PerformanceTracker,
    private scanner:   MarketScanner,
    private emergency: EmergencyStop,
    private onClose:   ClosedCallback,
  ) {}

  start(): void {
    if (!this.interval)
      this.interval = setInterval(() => this.tick().catch(() => {}), 10_000);
    this.logger.info('Reconciler started (10s interval)');
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private async tick(): Promise<void> {
    const open = this.db.getOpenTrades();
    if (!open.length) return;

    for (const t of open) {
      try {
        await this.reconcileOne(t);
      } catch (e: any) {
        const message = `Reconciliation failure for ${t.symbol}: ${e?.message ?? e}`;
        this.logger.error(message);
        if (this.config.mode !== 'paper') await this.emergency.activate(message);
      }
    }
  }

  private async reconcileOne(t: Trade): Promise<void> {
    const mode = this.config.mode;

    if      (mode === 'paper')   await this.reconcilePaper(t);
    else if (mode === 'mt5')     await this.reconcileMT5(t);
    else if (mode === 'binance') await this.reconcileBinance(t);
  }

  // ─── Paper ──────────────────────────────────────────────────────────

  private async reconcilePaper(t: Trade): Promise<void> {
    // FIX: was 'M1' as any for every trade regardless of its timeframe.
    // An H4 trade should be checked on its own timeframe; M1 noise can
    // trigger false SL/TP hits on wide-stop trades like XAUUSD or BTC.
    const tf = tradeTimeframe(t);
    const candles = await this.scanner
      .fetchCandles(t.symbol, tf as any, CHECK_CANDLES)
      .catch(() => []);
    if (!candles.length) return;

    // Use the last complete candle's OHLC for a realistic hit-check
    const last = candles[candles.length - 1];

    const hitSL = t.side === 'BUY' ? last.low  <= t.sl : last.high >= t.sl;
    const hitTP = t.side === 'BUY' ? last.high >= t.tp : last.low  <= t.tp;

    if (hitSL || hitTP) {
      // Use the actual SL/TP price as exit, not the candle close
      const exitPrice  = hitSL ? t.sl : t.tp;
      const exitReason = hitSL ? 'SL' : 'TP';
      await this.closeAndRecord(t, exitPrice, exitReason);
    }
  }

  // ─── MT5 ────────────────────────────────────────────────────────────

  private async reconcileMT5(t: Trade): Promise<void> {
    if (!t.ticket) return;
      const r = await axios.get(
        `${this.config.mt5.bridgeUrl}/positions`,
        { timeout: 5_000 },
      );
      const positions: any[] = r.data?.positions ?? [];
      const live = positions.find((p: any) => p.ticket === t.ticket);

      if (!live) {
        // Position closed on broker side
        const hist = await this.getMT5History(t.ticket);
        if (!hist) throw new Error(`MT5 position ${t.ticket} is absent but authoritative close history is unavailable`);
        await this.closeAndRecord(t, hist.price, hist.reason, hist.profit);
      } else {
        // Handle partial close: volume reduced on broker side
        if (live.volume < t.volume - 0.001) {
          const closedVol = t.volume - live.volume;
          this.logger.info(
            `[${t.symbol}] Partial close detected: ${closedVol.toFixed(2)} lots closed`,
          );
          this.db.raw()
            .prepare('UPDATE trades SET volume=? WHERE id=?')
            .run(live.volume, t.id!);
        }
      }
  }

  private async getMT5History(
    ticket: number,
  ): Promise<{ price: number; profit: number; reason: string } | null> {
    try {
      const r = await axios.get(
        `${this.config.mt5.bridgeUrl}/history`,
        { timeout: 5_000 },
      );
      const deals: any[] = r.data?.deals ?? [];
      const deal = deals.find((d: any) => d.order === ticket);
      if (!deal) return null;
      return {
        price:  deal.price,
        profit: deal.profit,
        reason: deal.comment?.includes('sl') ? 'SL'
              : deal.comment?.includes('tp') ? 'TP'
              : 'manual',
      };
    } catch (e) {
      throw new Error(`MT5 history lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── Binance ────────────────────────────────────────────────────────

  private async reconcileBinance(t: Trade): Promise<void> {
    if (!t.ticket) return;
      const pos  = await this.exec.getBinancePosition(t.symbol);

      if (!pos || Math.abs(pos.positionAmt) < 0.0001) {
        // Binance has disappeared from the live position set, but this reconciler
        // does not yet fetch authoritative account-trade fills/PnL. Never infer a
        // profitable/losing close from market candles; stop and require reconciliation.
        throw new Error(`Binance position ${t.symbol} is absent but authoritative fill/PnL history is unavailable`);

      } else if (Math.abs(pos.positionAmt) < t.volume - 0.001) {
        // Partial close
        const remaining = Math.abs(pos.positionAmt);
        this.logger.info(`[${t.symbol}] Binance partial: ${remaining} remaining`);
        this.db.raw()
          .prepare('UPDATE trades SET volume=? WHERE id=?')
          .run(remaining, t.id!);
      }
  }

  // ─── Common close + record ─────────────────────────────────────────

  private async closeAndRecord(
    t:          Trade,
    exitPrice:  number,
    exitReason: string,
    profit?:    number,
  ): Promise<void> {
    let rawProfit = profit;
    if (rawProfit === undefined && this.config.mode === 'paper') {
      const settled = this.exec.settlePaperTrade(t, exitPrice, exitReason as any);
      if (settled.ok) rawProfit = settled.profit;
    }
    if (rawProfit === undefined) rawProfit = (exitPrice - t.entry) * (t.side === 'BUY' ? 1 : -1) * t.volume;
    const finalProfit = +Number(rawProfit).toFixed(2);

    this.db.updateTradeClose(t.id!, finalProfit, Date.now(), exitReason);
    this.tracker.recordClose(finalProfit);

    const emoji  = finalProfit > 0 ? '💰' : '❌';
    const pnlStr = `${finalProfit > 0 ? '+' : ''}$${finalProfit.toFixed(2)}`;

    await this.telegram.sendMessage(
      `${emoji} <b>Trade Closed</b>: ${t.symbol} ${t.side}\n` +
      `P/L: <b>${pnlStr}</b> | Reason: ${exitReason}\n` +
      `Entry: ${t.entry.toFixed(5)} → Exit: ${exitPrice.toFixed(5)}`,
    ).catch(() => {});

    this.logger.info(`Closed ${t.symbol} ${t.side} | ${pnlStr} | ${exitReason}`);
    this.onClose({ ...t, profit: finalProfit, exitPrice });
  }
}
